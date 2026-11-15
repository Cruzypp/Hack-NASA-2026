"""Health Intelligence: individual baselines, explainable deviation detection,
context, missing-data checks. Output is a recommendation for human review —
never a diagnosis, never an automatic protocol change.
"""
import json
import statistics
from datetime import datetime, timedelta

import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest

from . import db, protocols
from .db import SYSTEM, iso, parse

# Plausibility ranges reject typos and sensor garbage at the trust boundary.
# They are NOT clinical limits. `spread_floor` keeps a very stable baseline
# from turning tiny changes into huge z-scores (ASTRA experimental choice).
METRICS = {
    "resting_hr": {"unit": "bpm", "range": (25, 220), "spread_floor": 1.5, "label": "Resting heart rate"},
    "heart_rate": {"unit": "bpm", "range": (25, 230), "spread_floor": 3.0, "label": "Heart rate"},
    "systolic_bp": {"unit": "mmHg", "range": (60, 250), "spread_floor": 3.0, "label": "Systolic BP"},
    "diastolic_bp": {"unit": "mmHg", "range": (30, 150), "spread_floor": 2.0, "label": "Diastolic BP"},
    "body_temp": {"unit": "°C", "range": (32, 43), "spread_floor": 0.15, "label": "Body temperature"},
    "body_mass": {"unit": "kg", "range": (30, 200), "spread_floor": 0.3, "label": "Body mass"},
    "sleep_hours": {"unit": "h", "range": (0, 16), "spread_floor": 0.3, "label": "Sleep duration"},
    "rpe": {"unit": "Borg 6-20", "range": (6, 20), "spread_floor": 1.0, "label": "Perceived exertion"},
    "cbc_hemoglobin": {"unit": "g/dL", "range": (5, 25), "spread_floor": 0.1, "label": "CBC hemoglobin"},
    "cbc_hematocrit": {"unit": "%", "range": (10, 70), "spread_floor": 0.5, "label": "CBC hematocrit"},
    "cbc_wbc": {"unit": "10^3/µL", "range": (0, 100), "spread_floor": 0.2, "label": "CBC white blood cells"},
    "cbc_platelets": {"unit": "10^3/µL", "range": (10, 1_500), "spread_floor": 5.0, "label": "CBC platelets"},
    "cmp_glucose": {"unit": "mg/dL", "range": (20, 600), "spread_floor": 2.0, "label": "CMP glucose"},
    "cmp_creatinine": {"unit": "mg/dL", "range": (0, 20), "spread_floor": 0.05, "label": "CMP creatinine"},
    "cmp_sodium": {"unit": "mmol/L", "range": (80, 200), "spread_floor": 1.0, "label": "CMP sodium"},
    "cmp_potassium": {"unit": "mmol/L", "range": (1, 15), "spread_floor": 0.1, "label": "CMP potassium"},
    "cmp_albumin": {"unit": "g/dL", "range": (0, 10), "spread_floor": 0.1, "label": "CMP albumin"},
}

RULE = {
    "id": "baseline-robust-z", "version": "1.0.0", "threshold_z": 3.0,
    "baseline_window_days": 28, "min_points": 7, "post_exercise_window_min": 60,
    "monitored": ["resting_hr", "sleep_hours", "systolic_bp", "diastolic_bp", "body_temp", "body_mass",
                  "cbc_hemoglobin", "cbc_hematocrit", "cbc_wbc", "cbc_platelets",
                  "cmp_glucose", "cmp_creatinine", "cmp_sodium", "cmp_potassium", "cmp_albumin"],
    "provenance": "ASTRA experimental rule — thresholds are not NASA-specified and require flight surgeon review.",
}
ADVISORY_MODEL = {"name": "IsolationForest", "version": f"astra-iforest-0.1/sklearn-{sklearn.__version__}",
                  "min_days": 14}


def validate(metric: str, value: float) -> str | None:
    m = METRICS.get(metric)
    if not m:
        return f"Unknown metric {metric}"
    lo, hi = m["range"]
    if not lo <= value <= hi:
        return f"{value} {m['unit']} outside plausible range {lo}–{hi}"
    return None


def _history(conn, crew_member_id: str, metric: str, before: datetime, days: int, exclude_id: str | None = None):
    return db.rows(conn, """
        SELECT id, value, measured_at FROM measurements
        WHERE crew_member_id = ? AND metric = ? AND superseded = 0 AND quality != 'INVALID'
          AND measured_at < ? AND measured_at >= ? AND id IS NOT ?
        ORDER BY measured_at""",
        crew_member_id, metric, iso(before), iso(before - timedelta(days=days)), exclude_id)


def baseline(conn, crew_member_id: str, metric: str, before: datetime, exclude_id: str | None = None) -> dict:
    hist = _history(conn, crew_member_id, metric, before, RULE["baseline_window_days"], exclude_id)
    vals = [h["value"] for h in hist]
    if len(vals) < RULE["min_points"]:
        return {"n": len(vals), "sufficient": False}
    med = statistics.median(vals)
    mad = statistics.median(abs(v - med) for v in vals)
    spread = max(1.4826 * mad, METRICS[metric]["spread_floor"])
    return {"n": len(vals), "sufficient": True, "median": round(med, 2), "robust_sd": round(spread, 2),
            "from": hist[0]["measured_at"], "to": hist[-1]["measured_at"]}


def _context(conn, crew_member_id: str, at: datetime) -> list[dict]:
    ctx = []
    s = db.one(conn, """SELECT id, ended_at FROM sensor_sessions WHERE crew_member_id = ? AND kind = 'EXERCISE'
                        AND status = 'COMPLETED' AND ended_at <= ? ORDER BY ended_at DESC LIMIT 1""",
               crew_member_id, iso(at))
    if s:
        mins = (at - parse(s["ended_at"])).total_seconds() / 60
        if mins <= RULE["post_exercise_window_min"]:
            ctx.append({"factor": "post_exercise", "ref": s["id"],
                        "detail": f"Measured {mins:.0f} min after an exercise session ended",
                        "effect": "Heart rate and BP can remain elevated during recovery; repeat at rest."})
    sleep = db.one(conn, """SELECT value, measured_at FROM measurements WHERE crew_member_id = ? AND metric = 'sleep_hours'
                            AND superseded = 0 AND measured_at <= ? AND measured_at >= ? ORDER BY measured_at DESC LIMIT 1""",
                   crew_member_id, iso(at), iso(at - timedelta(hours=24)))
    if sleep:
        b = baseline(conn, crew_member_id, "sleep_hours", parse(sleep["measured_at"]))
        if b["sufficient"] and sleep["value"] < b["median"] - 2 * b["robust_sd"]:
            ctx.append({"factor": "short_sleep", "detail": f"Last sleep {sleep['value']:.1f} h vs baseline {b['median']:.1f} h",
                        "effect": "Reduced sleep is a recognised contributor to physiological variation."})
    eva = db.one(conn, "SELECT id, planned_end FROM eva_events WHERE crew_member_id = ? AND planned_end <= ? AND planned_end >= ?",
                 crew_member_id, iso(at), iso(at - timedelta(hours=24)))
    if eva:
        ctx.append({"factor": "recent_eva", "ref": eva["id"], "detail": "EVA ended within the last 24 h",
                    "effect": "Consider EVA workload when interpreting."})
    return ctx


def _advisory(conn, crew_member_id: str, value: float, at: datetime, exclude_id: str) -> dict | None:
    """Multivariate check (metric + sleep) with IsolationForest. Advisory only:
    it is reported inside the explanation and never raises an alert by itself."""
    hr = _history(conn, crew_member_id, "resting_hr", at, RULE["baseline_window_days"], exclude_id)
    sl = {h["measured_at"][:10]: h["value"] for h in _history(conn, crew_member_id, "sleep_hours", at, 29)}
    pairs = [(h["value"], sl[h["measured_at"][:10]]) for h in hr if h["measured_at"][:10] in sl]
    today_sleep = sl.get(iso(at)[:10])
    if len(pairs) < ADVISORY_MODEL["min_days"] or today_sleep is None:
        return {**ADVISORY_MODEL, "status": "SKIPPED", "note": "Not enough paired days (resting HR + sleep)"}
    model = IsolationForest(n_estimators=100, random_state=0).fit(np.array(pairs))
    score = float(model.decision_function([[value, today_sleep]])[0])
    return {**ADVISORY_MODEL, "status": "RAN", "features": ["resting_hr", "sleep_hours"], "n_train": len(pairs),
            "score": round(score, 3), "outlier": score < 0, "note": "Advisory only; does not create alerts."}


def assess(conn, measurement: dict) -> dict:
    """Evaluate one measurement against the person's own baseline. If it deviates,
    raise a MEDICAL alert and a CMO verification follow-up. Returns the assessment."""
    metric, crew = measurement["metric"], measurement["crew_member_id"]
    at = parse(measurement["measured_at"])
    result = {"rule": {k: v for k, v in RULE.items() if k != "monitored"}, "metric": metric}
    if metric not in RULE["monitored"]:
        return {**result, "status": "NOT_MONITORED"}
    if measurement["quality"] == "INVALID":
        return {**result, "status": "SKIPPED_INVALID_QUALITY"}
    b = baseline(conn, crew, metric, at, exclude_id=measurement["id"])
    result["baseline"] = b
    if not b["sufficient"]:
        return {**result, "status": "INSUFFICIENT_BASELINE",
                "detail": f"{b['n']} points < {RULE['min_points']} required; no deviation decision made"}
    z = (measurement["value"] - b["median"]) / b["robust_sd"]
    result["z"] = round(z, 2)
    if abs(z) < RULE["threshold_z"]:
        return {**result, "status": "WITHIN_BASELINE"}

    m = METRICS[metric]
    ctx = _context(conn, crew, at)
    explanation = {
        **result, "status": "DEVIATION",
        "observation": {k: measurement[k] for k in ("id", "value", "unit", "measured_at", "source", "quality")},
        "summary": (f"{m['label']} {measurement['value']:g} {m['unit']} is {abs(z):.1f} robust SD "
                    f"{'above' if z > 0 else 'below'} personal baseline {b['median']:g} {m['unit']} (n={b['n']})"),
        "context": ctx,
        "advisory_model": _advisory(conn, crew, measurement["value"], at, measurement["id"]) if metric == "resting_hr" else None,
        "recommendation": ("Crew Medical Officer review"
                           + (" and repeat measurement at rest" if any(c["factor"] == "post_exercise" for c in ctx) else "")
                           + ". ASTRA does not diagnose and does not modify the clinical protocol."),
    }
    with db.tx(conn):
        alert_id = protocols.raise_alert(conn, crew, "MEDICAL", "PHYSIO_DEVIATION", "REVIEW",
                                         f"{m['label']} outside personal baseline", explanation,
                                         rule_id=RULE["id"], rule_version=RULE["version"])
        task_id = protocols.order_task(
            conn, SYSTEM, crew, f"CMO verification: {m['label'].lower()} deviation", "VERIFICATION",
            at + timedelta(hours=4), "HIGH",
            {"kind": "VERIFICATION", "roles": ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"]},
            source_alert_id=alert_id, note=explanation["recommendation"])
        db.update(conn, "alerts", alert_id, {"follow_up_task_id": task_id})
    return {**explanation, "alert_id": alert_id, "follow_up_task_id": task_id}


def missing_days(conn, crew_member_id: str, metric: str, days: int, at: datetime) -> list[str]:
    have = {r["d"] for r in db.rows(conn, """SELECT DISTINCT substr(measured_at, 1, 10) d FROM measurements
                                             WHERE crew_member_id = ? AND metric = ? AND superseded = 0""", crew_member_id, metric)}
    wanted = [(at - timedelta(days=i)).date().isoformat() for i in range(1, days + 1)]
    return [d for d in wanted if d not in have]


def trends(conn, crew_member_id: str, metric: str, at: datetime, days: int = 28) -> dict:
    pts = _history(conn, crew_member_id, metric, at + timedelta(seconds=1), days)
    return {"metric": metric, "unit": METRICS[metric]["unit"], "points": pts,
            "baseline": baseline(conn, crew_member_id, metric, at + timedelta(seconds=1))}


def explain(alert: dict) -> dict:
    alert = dict(alert)
    alert["explanation"] = json.loads(alert.pop("explanation_json"))
    return alert
