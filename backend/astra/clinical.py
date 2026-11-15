"""Clinician tools for one crew member:

- Care plan: a flight surgeon creates, revises or retires protocol versions for an
  individual astronaut. Every change is a new version with reason, reference,
  approver and effective date; nothing is edited in place.
- Automation: auto-captured measurements and automated reviews run when due.
- Logbook: an append-only clinical narrative (addenda instead of edits).
"""
import json
import random
import re
import statistics
from datetime import datetime, time, timedelta

from . import db, devices, intelligence, protocols
from .db import Actor, SYSTEM, iso, parse

PLAN_ROLES = {"FLIGHT_SURGEON"}  # brief: only the flight surgeon approves and modifies clinical protocols
LOG_CATEGORIES = {"OBSERVATION", "CONSULTATION", "PLAN_CHANGE", "COMMUNICATION", "OTHER"}
AUTO_CAPTURE_METRICS = {"resting_hr": "bio-monitor-sim"}  # metrics a (simulated) sensor can capture on schedule

REVIEW_RULE = {
    "id": "periodic-deviation-review", "version": "1.0.0", "threshold_z": 3.0, "shift_sd": 1.0, "min_points": 3,
    "provenance": "ASTRA experimental rule — per-value robust z against the 28 days before the window, plus a "
                  "sustained-shift check on the window mean. Thresholds require flight surgeon validation.",
}


# ------------------------------------------------------------------ validation

def _hhmm(v) -> str:
    time.fromisoformat(v)  # raises ValueError on bad input
    return v[:5]


def validate_schedule(stype: str, s: dict) -> dict:
    if stype == "RECURRENT":
        at = [_hhmm(t) for t in s.get("at", [])]
        if not 1 <= len(at) <= 6:
            raise ValueError("Give between 1 and 6 times of day")
        if s.get("weekdays") is not None:
            days = sorted({int(d) for d in s["weekdays"]})
            if not days or not all(1 <= d <= 7 for d in days):
                raise ValueError("Weekdays must be 1 (Monday) to 7 (Sunday)")
            return {"weekdays": days, "at": at}
        n = int(s.get("every_days", 0))
        if not 1 <= n <= 365:
            raise ValueError("every_days must be between 1 and 365")
        return {"every_days": n, "at": at}
    if stype == "MISSION_RELATIVE":
        days = sorted({int(d) for d in s.get("mission_days", [])})
        if not days or len(days) > 400 or days[0] < 1:
            raise ValueError("mission_days must list 1–400 mission days ≥ 1")
        return {"mission_days": days, "at": _hhmm(s.get("at", ""))}
    raise ValueError("Care-plan protocols are RECURRENT or MISSION_RELATIVE")


def validate_rule(r: dict) -> tuple[dict, str, str]:
    """Returns (normalised rule, task_type, category)."""
    kind = r.get("kind")
    if kind == "MEASUREMENT":
        metric = r.get("metric")
        if metric not in intelligence.METRICS:
            raise ValueError(f"Unknown metric {metric}")
        auto = bool(r.get("auto_capture"))
        if auto and metric not in AUTO_CAPTURE_METRICS:
            raise ValueError(f"No sensor can capture {metric} automatically")
        rule = {"kind": kind, "metric": metric, "allow_manual": bool(r.get("allow_manual", True)), "auto_capture": auto}
        return rule, "MEASUREMENT", "SLEEP" if metric == "sleep_hours" else "MEDICAL"
    if kind == "RADIATION_READING":
        return {"kind": kind, "manual_only": bool(r.get("manual_only"))}, "RADIATION_READING", "RADIATION"
    if kind == "AUTOMATED_REVIEW":
        metric, window = r.get("metric"), int(r.get("window_days", 7))
        if metric not in intelligence.METRICS or not 1 <= window <= 31:
            raise ValueError("Review needs a known metric and a 1–31 day window")
        return {"kind": kind, "metric": metric, "window_days": window}, "ANALYSIS", "MEDICAL"
    if kind == "VERIFICATION":
        roles = [x for x in r.get("roles", ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"]) if x in ("CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON")]
        if not roles:
            raise ValueError("Verification needs at least one medical role")
        return {"kind": kind, "roles": roles}, "EVALUATION", "MEDICAL"
    if kind == "ACTIVITY":
        mins = int(r.get("min_minutes") or 0)
        if not 0 <= mins <= 600:
            raise ValueError("Minimum duration must be 0–600 min")
        return {"kind": kind, "activity": "RECREATION", "min_minutes": mins}, "RECREATION", "WELLBEING"
    if kind == "TELEMETRY_SESSION":
        mins, frac = float(r.get("min_valid_minutes", 25)), float(r.get("min_valid_fraction", 0.8))
        if not (5 <= mins <= 240 and 0.5 <= frac <= 1):
            raise ValueError("Session needs 5–240 valid minutes and 50–100% signal quality")
        return ({"kind": kind, "metric": "heart_rate", "min_valid_minutes": mins, "min_valid_fraction": frac,
                 "manual_fallback": bool(r.get("manual_fallback", True))}, "EXERCISE", "EXERCISE")
    raise ValueError(f"Unsupported completion rule {kind}")


# ------------------------------------------------------------------ logbook

def log(conn, actor: Actor, crew: str, category: str, body: str, linked_type: str | None = None,
        linked_id: str | None = None, shared: bool = False, amends_id: str | None = None) -> dict:
    e = {"id": db.new_id("log"), "crew_member_id": crew, "author_id": actor.id, "author_role": actor.role,
         "author_name": actor.name or actor.id, "category": category, "body": body, "linked_type": linked_type,
         "linked_id": linked_id, "shared_with_crew": int(shared), "amends_id": amends_id, "created_at": iso(db.now())}
    with db.tx(conn):
        db.insert(conn, "clinical_log", e)
        db.record(conn, actor, "LOG_ENTRY", "clinical_log", e["id"], e)
    return e


def logbook(conn, crew: str, include_private: bool) -> list[dict]:
    """Entries newest first, each with its addenda (oldest first)."""
    q = "SELECT * FROM clinical_log WHERE crew_member_id = ?" + ("" if include_private else " AND shared_with_crew = 1")
    rows = db.rows(conn, q + " ORDER BY created_at", crew)
    addenda: dict[str, list] = {}
    for r in rows:
        if r["amends_id"]:
            addenda.setdefault(r["amends_id"], []).append(r)
    return [{**r, "addenda": addenda.get(r["id"], [])} for r in reversed(rows) if not r["amends_id"]]


# ------------------------------------------------------------------ care plan

def _active(conn, crew: str, protocol_id: str) -> dict | None:
    return db.one(conn, """SELECT v.*, a.id assignment_id FROM protocol_assignments a
                           JOIN protocol_versions v ON v.id = a.protocol_version_id
                           WHERE a.crew_member_id = ? AND a.active = 1 AND v.protocol_id = ?""", crew, protocol_id)


def care_plan(conn, crew: str) -> dict:
    q = """SELECT v.*, t.name, t.task_type, t.category, a.id assignment_id, a.assigned_at, a.assigned_by, a.active,
                  a.ended_at, a.end_reason, u.display_name approved_by_name, u.role approved_by_role
           FROM protocol_assignments a JOIN protocol_versions v ON v.id = a.protocol_version_id
           JOIN protocol_templates t ON t.id = v.protocol_id LEFT JOIN users u ON u.id = v.approved_by
           WHERE a.crew_member_id = ? ORDER BY t.category, t.name, a.assigned_at DESC"""
    out = {"active": [], "history": []}
    for v in db.rows(conn, q, crew):
        for k in ("schedule_json", "completion_rule_json", "reminder_json"):
            v[k.removesuffix("_json")] = json.loads(v.pop(k))
        out["active" if v["active"] else "history"].append(v)
    return out


def _next_version(conn, protocol_id: str) -> str:
    vs = [tuple(int(x) for x in r["version"].split(".")) for r in
          db.rows(conn, "SELECT version FROM protocol_versions WHERE protocol_id = ?", protocol_id)]
    major, minor, _ = max(vs)
    return f"{major}.{minor + 1}.0"


def _end_assignment(conn, actor: Actor, crew: str, current: dict, reason: str, at: datetime) -> int:
    """Close the assignment and cancel this version's future open tasks for the crew member."""
    db.update(conn, "protocol_assignments", current["assignment_id"],
              {"active": 0, "ended_at": iso(at), "ended_by": actor.id, "end_reason": reason})
    cur = conn.execute("""UPDATE tasks SET status = 'CANCELLED', note = ? WHERE crew_member_id = ? AND protocol_version_id = ?
                          AND status IN ('PENDING','OVERDUE') AND due_at >= ?""",
                       (f"Cancelled: {reason}", crew, current["id"], iso(at)))
    db.record(conn, actor, "ASSIGNMENT_ENDED", "protocol_assignment", current["assignment_id"],
              {"version": current["id"], "reason": reason, "tasks_cancelled": cur.rowcount})
    return cur.rowcount


def _generate(conn, crew: str, at: datetime) -> None:
    day0 = datetime.combine(at.date(), time(0), tzinfo=at.tzinfo)
    protocols.generate_tasks(conn, crew, day0, day0 + timedelta(days=protocols.PLAN_HORIZON_DAYS))


def _require_planner(actor: Actor) -> None:
    if actor.role not in PLAN_ROLES:
        raise PermissionError("Only a flight surgeon may change a care plan")


def create_protocol(conn, actor: Actor, crew: str, spec: dict) -> dict:
    _require_planner(actor)
    schedule = validate_schedule(spec["schedule_type"], spec["schedule"])
    rule, task_type, category = validate_rule(spec["completion_rule"])
    at = db.now()
    slug = re.sub(r"[^a-z0-9]+", "-", spec["name"].lower()).strip("-")[:28] or "protocol"
    pid = f"{slug}-{crew.lower()}-{db.new_id('p')[-4:]}"
    version = {
        "id": f"{pid}@1.0.0", "protocol_id": pid, "version": "1.0.0", "schedule_type": spec["schedule_type"],
        "schedule_json": json.dumps(schedule), "completion_rule_json": json.dumps(rule),
        "reminder_json": json.dumps(spec.get("reminder") or protocols.DEFAULT_REMINDER), "priority": spec["priority"],
        "source": f"Clinical decision: {spec['reason']} Context: {spec['reference']}", "source_kind": "CLINICAL_DECISION",
        "population": f"{crew} (individual care plan)", "approved_by": actor.id, "effective_from": iso(at),
        "change_reason": spec["reason"],
    }
    with db.tx(conn):
        db.insert(conn, "protocol_templates", {"id": pid, "name": spec["name"], "task_type": task_type, "category": category})
        db.insert(conn, "protocol_versions", version)
        db.insert(conn, "protocol_assignments", {"id": db.new_id("asg"), "crew_member_id": crew,
                                                 "protocol_version_id": version["id"], "assigned_by": actor.id,
                                                 "assigned_at": iso(at)})
        db.record(conn, actor, "PROTOCOL_CREATED", "protocol_version", version["id"], version)
        log(conn, actor, crew, "PLAN_CHANGE", f"Added “{spec['name']}” (v1.0.0). Reason: {spec['reason']}",
            "protocol_version", version["id"])
        _generate(conn, crew, at)
    return version


def revise_protocol(conn, actor: Actor, crew: str, protocol_id: str, changes: dict, reason: str) -> dict:
    """New version for this crew member only; others keep the version they have."""
    _require_planner(actor)
    current = _active(conn, crew, protocol_id)
    if not current:
        raise KeyError(f"{protocol_id} is not active for {crew}")
    stype = changes.get("schedule_type") or current["schedule_type"]
    schedule = validate_schedule(stype, changes.get("schedule") or json.loads(current["schedule_json"]))
    rule, _, _ = validate_rule(changes.get("completion_rule") or json.loads(current["completion_rule_json"]))
    if rule["kind"] != json.loads(current["completion_rule_json"])["kind"]:
        raise ValueError("A revision cannot change what the task is; retire it and add a new protocol")
    at = db.now()
    number = _next_version(conn, protocol_id)
    version = {
        "id": f"{protocol_id}@{number}", "protocol_id": protocol_id, "version": number, "schedule_type": stype,
        "schedule_json": json.dumps(schedule), "completion_rule_json": json.dumps(rule),
        "reminder_json": json.dumps(changes.get("reminder") or json.loads(current["reminder_json"])),
        "priority": changes.get("priority") or current["priority"],
        "source": f"Clinical decision: {reason} Context: revision of {current['id']} ({current['source_kind']}).",
        "source_kind": "CLINICAL_DECISION", "population": f"{crew} (individual care plan)", "approved_by": actor.id,
        "effective_from": iso(at), "supersedes_id": current["id"], "change_reason": reason,
    }
    name = db.one(conn, "SELECT name FROM protocol_templates WHERE id = ?", protocol_id)["name"]
    with db.tx(conn):
        cancelled = _end_assignment(conn, actor, crew, current, f"superseded by v{number}: {reason}", at)
        db.insert(conn, "protocol_versions", version)
        db.insert(conn, "protocol_assignments", {"id": db.new_id("asg"), "crew_member_id": crew,
                                                 "protocol_version_id": version["id"], "assigned_by": actor.id,
                                                 "assigned_at": iso(at)})
        db.record(conn, actor, "PROTOCOL_REVISED", "protocol_version", version["id"], version)
        log(conn, actor, crew, "PLAN_CHANGE",
            f"Revised “{name}” v{current['version']} → v{number}. Reason: {reason}"
            + (f" ({cancelled} upcoming task(s) replaced)" if cancelled else ""), "protocol_version", version["id"])
        _generate(conn, crew, at)
    return version


def retire_protocol(conn, actor: Actor, crew: str, protocol_id: str, reason: str) -> int:
    _require_planner(actor)
    current = _active(conn, crew, protocol_id)
    if not current:
        raise KeyError(f"{protocol_id} is not active for {crew}")
    name = db.one(conn, "SELECT name FROM protocol_templates WHERE id = ?", protocol_id)["name"]
    with db.tx(conn):
        cancelled = _end_assignment(conn, actor, crew, current, reason, db.now())
        log(conn, actor, crew, "PLAN_CHANGE", f"Stopped “{name}” (v{current['version']}). Reason: {reason}",
            "protocol_version", current["id"])
    return cancelled


# ------------------------------------------------------------------ automation

def run_due(conn, at: datetime) -> dict:
    """Execute automated tasks whose time has come. Never closes a task without valid evidence."""
    counts = {"captured": 0, "reviews": 0, "failed": 0}
    for t in db.rows(conn, "SELECT * FROM tasks WHERE status IN ('PENDING','OVERDUE') AND due_at <= ?", iso(at)):
        rule = json.loads(t["completion_criteria"])
        if rule.get("kind") == "MEASUREMENT" and rule.get("auto_capture"):
            counts["captured" if _auto_capture(conn, t, rule, at) else "failed"] += 1
        elif rule.get("kind") == "AUTOMATED_REVIEW":
            review(conn, t["crew_member_id"], rule["metric"], rule["window_days"], at, task_id=t["id"])
            counts["reviews"] += 1
    return counts


def _auto_capture(conn, task: dict, rule: dict, at: datetime) -> bool:
    device_id = AUTO_CAPTURE_METRICS[rule["metric"]]
    dev = db.one(conn, "SELECT * FROM devices WHERE id = ?", device_id)
    if dev["status"] != "ONLINE":
        already = db.one(conn, "SELECT 1 FROM alerts WHERE type = 'AUTO_CAPTURE_FAILED' AND explanation_json LIKE ?",
                         f'%"{task["id"]}"%')
        if not already:
            protocols.raise_alert(conn, task["crew_member_id"], "OPERATIONAL", "AUTO_CAPTURE_FAILED", "MEDIUM",
                                  f"Automatic capture failed: {task['title']}",
                                  {"task_id": task["id"], "device_id": device_id, "device_status": dev["status"],
                                   "next_step": "Enter the value manually or restore the device."},
                                  rule_id="auto-capture", rule_version="1.0.0")
        return False
    # Simulated sensor value around the person's own baseline (synthetic, deterministic per task).
    b = intelligence.baseline(conn, task["crew_member_id"], rule["metric"], at)
    centre = b.get("median", 60.0)
    value = round(random.Random(task["id"]).gauss(centre, 1.8), 1)
    m = {"id": db.new_id("msr"), "crew_member_id": task["crew_member_id"], "metric": rule["metric"], "value": value,
         "unit": intelligence.METRICS[rule["metric"]]["unit"], "measured_at": iso(at), "source": "STREAM",
         "device_id": device_id, "quality": "GOOD", "entered_by": SYSTEM.id,
         "context_json": json.dumps({"auto_capture_task": task["id"], "simulated": True}), "created_at": iso(at)}
    with db.tx(conn):
        db.insert(conn, "measurements", m)
        db.record(conn, SYSTEM, "MEASUREMENT_RECORDED", "measurement", m["id"], m)
        protocols.submit_evidence(conn, SYSTEM, task["id"], m["id"],
                                  {"kind": "MEASUREMENT", "metric": m["metric"], "source": "STREAM", "quality": "GOOD"})
    intelligence.assess(conn, m)
    return True


def review(conn, crew: str, metric: str, window_days: int, at: datetime, task_id: str | None = None,
           actor: Actor = SYSTEM) -> dict:
    """Search a window for values outside the personal baseline and for a sustained shift.
    Raises a MEDICAL alert + CMO follow-up when something is found; never changes the protocol."""
    start = at - timedelta(days=window_days)
    pts = db.rows(conn, """SELECT id, value, measured_at FROM measurements WHERE crew_member_id = ? AND metric = ?
                           AND superseded = 0 AND quality != 'INVALID' AND measured_at >= ? AND measured_at <= ?
                           ORDER BY measured_at""", crew, metric, iso(start), iso(at))
    base = intelligence.baseline(conn, crew, metric, start)
    label, unit = intelligence.METRICS[metric]["label"], intelligence.METRICS[metric]["unit"]
    have = {p["measured_at"][:10] for p in pts}
    missing = [(start + timedelta(days=i + 1)).date().isoformat() for i in range(window_days)
               if (start + timedelta(days=i + 1)).date().isoformat() not in have]
    result = {"rule": REVIEW_RULE, "metric": metric, "label": label, "unit": unit, "window_days": window_days,
              "n": len(pts), "baseline": base, "missing_days": missing, "deviations": [], "shift": None}
    if not base["sufficient"]:
        result["status"] = "INSUFFICIENT_BASELINE"
    elif len(pts) < REVIEW_RULE["min_points"]:
        result["status"] = "INSUFFICIENT_DATA"
    else:
        sd = base["robust_sd"]
        result["deviations"] = [{**p, "z": round((p["value"] - base["median"]) / sd, 2)} for p in pts
                                if abs(p["value"] - base["median"]) / sd >= REVIEW_RULE["threshold_z"]]
        mean = statistics.fmean(p["value"] for p in pts)
        result["mean"] = round(mean, 2)
        shift = (mean - base["median"]) / sd
        result["shift"] = {"sd": round(shift, 2), "flagged": abs(shift) >= REVIEW_RULE["shift_sd"]}
        result["status"] = "FINDINGS" if result["deviations"] or result["shift"]["flagged"] else "WITHIN_BASELINE"
    report = {"id": db.new_id("rep"), "crew_member_id": crew, "task_id": task_id, "kind": "DEVIATION_REVIEW",
              "metric": metric, "window_from": iso(start), "window_to": iso(at), "result_json": json.dumps(result),
              "created_at": iso(db.now())}
    summary = (f"{label} review, last {window_days} d: {len(pts)} value(s)"
               + (f", mean {result['mean']} {unit} vs baseline {base['median']} {unit}" if "mean" in result else "")
               + f"; {len(result['deviations'])} outside baseline"
               + ("; sustained shift" if result["shift"] and result["shift"]["flagged"] else "")
               + (f"; {len(missing)} day(s) without data" if missing else "") + f". Status: {result['status'].lower().replace('_', ' ')}.")
    with db.tx(conn):
        db.insert(conn, "analysis_reports", report)
        db.record(conn, actor, "REVIEW_COMPLETED", "analysis_report", report["id"], {"status": result["status"]})
        title = f"{label}: findings in {window_days}-day review"
        existing = db.one(conn, "SELECT id, follow_up_task_id FROM alerts WHERE crew_member_id = ? AND type = 'PERIODIC_REVIEW_FINDINGS' "
                                "AND title = ? AND status != 'RESOLVED' ORDER BY created_at DESC LIMIT 1", crew, title)
        if result["status"] == "FINDINGS" and existing:
            # Same finding already open: attach this report to it instead of stacking another alert and CMO review.
            result["alert_id"], result["existing_alert"] = existing["id"], True
        elif result["status"] == "FINDINGS":
            alert_id = protocols.raise_alert(conn, crew, "MEDICAL", "PERIODIC_REVIEW_FINDINGS", "REVIEW",
                                             title,
                                             {"summary": summary, "metric": metric, "report_id": report["id"], "rule": REVIEW_RULE,
                                              "recommendation": "Crew Medical Officer review. ASTRA does not diagnose "
                                                                "and does not modify the clinical protocol."},
                                             rule_id=REVIEW_RULE["id"], rule_version=REVIEW_RULE["version"])
            protocols.request_cmo_review(conn, SYSTEM, crew, alert_id, summary, "HIGH", at)
            result["alert_id"] = alert_id
        if len(missing) >= 2:
            protocols.raise_alert(conn, crew, "OPERATIONAL", "DATA_GAP", "MEDIUM", f"{label}: {len(missing)} days without data",
                                  {"report_id": report["id"], "missing_days": missing}, rule_id=REVIEW_RULE["id"],
                                  rule_version=REVIEW_RULE["version"])
        log(conn, actor, crew, "AUTOMATED", summary, "analysis_report", report["id"])
        if task_id:
            protocols.submit_evidence(conn, actor, task_id, report["id"],
                                      {"kind": "AUTOMATED_REVIEW", "points": len(pts),
                                       "deviations": len(result["deviations"]), "missing_days": len(missing)})
    return {**report, "result": result}


def reports(conn, crew: str, limit: int = 20) -> list[dict]:
    out = db.rows(conn, "SELECT * FROM analysis_reports WHERE crew_member_id = ? ORDER BY created_at DESC LIMIT ?", crew, limit)
    for r in out:
        r["result"] = json.loads(r.pop("result_json"))
    return out


def match_radiation_task(conn, actor: Actor, reading: dict) -> dict | None:
    """A personal reading closes today's open RADIATION_READING task, if the rule accepts it."""
    if reading["scope"] != "PERSONAL":
        return None
    for t in db.rows(conn, "SELECT * FROM tasks WHERE crew_member_id = ? AND status IN ('PENDING','OVERDUE') "
                           "AND substr(due_at, 1, 10) = ? ORDER BY due_at", reading["crew_member_id"], reading["measured_at"][:10]):
        if json.loads(t["completion_criteria"]).get("kind") == "RADIATION_READING":
            return protocols.submit_evidence(conn, actor, t["id"], reading["id"], {"kind": "RADIATION_READING", **reading})
    return None


# ------------------------------------------------------------------ status

STATUS_METRICS = ("resting_hr", "sleep_hours", "body_mass", "systolic_bp", "diastolic_bp", "body_temp")


def overview(conn, crew: str, at: datetime) -> dict:
    vitals = []
    for metric in STATUS_METRICS:
        m = db.one(conn, "SELECT * FROM measurements WHERE crew_member_id = ? AND metric = ? AND superseded = 0 "
                         "ORDER BY measured_at DESC LIMIT 1", crew, metric)
        item = {"metric": metric, "label": intelligence.METRICS[metric]["label"], "unit": intelligence.METRICS[metric]["unit"],
                "latest": m, "status": "NO_DATA"}
        if m:
            b = intelligence.baseline(conn, crew, metric, parse(m["measured_at"]), exclude_id=m["id"])
            item["baseline"] = b
            if b["sufficient"]:
                z = (m["value"] - b["median"]) / b["robust_sd"]
                item["z"] = round(z, 2)
                item["status"] = "OUTSIDE_BASELINE" if abs(z) >= intelligence.RULE["threshold_z"] else "WITHIN_BASELINE"
            else:
                item["status"] = "NO_BASELINE"
        vitals.append(item)
    since = iso(at - timedelta(days=7))
    comp = db.rows(conn, """SELECT category, SUM(status = 'COMPLETED') done, COUNT(*) total FROM tasks
                            WHERE crew_member_id = ? AND due_at >= ? AND due_at <= ? AND status != 'CANCELLED'
                            GROUP BY category""", crew, since, iso(at))
    session = db.one(conn, "SELECT * FROM sensor_sessions WHERE crew_member_id = ? AND kind = 'EXERCISE' "
                           "ORDER BY started_at DESC LIMIT 1", crew)
    if session:
        session["summary"] = json.loads(session.pop("summary_json") or "null")
    rad = devices.radiation_summary(conn, crew, at, days=7)
    return {
        "crew_member_id": crew, "name": (db.one(conn, "SELECT display_name FROM users WHERE crew_member_id = ?", crew) or {}).get("display_name"),
        "mission_day": protocols.mission_day(conn, at), "vitals": vitals,
        "compliance": [{**c, "rate": round(c["done"] / c["total"], 2) if c["total"] else None} for c in comp],
        "open_alerts": db.rows(conn, "SELECT id, category, type, title, created_at FROM alerts WHERE crew_member_id = ? "
                                     "AND status != 'RESOLVED' ORDER BY created_at DESC", crew),
        "follow_ups": db.rows(conn, "SELECT id, title, due_at, status FROM tasks WHERE crew_member_id = ? "
                                    "AND source_alert_id IS NOT NULL AND status IN ('PENDING','OVERDUE') ORDER BY due_at", crew),
        "upcoming": db.rows(conn, "SELECT id, title, task_type, category, due_at, priority, status FROM tasks WHERE crew_member_id = ? "
                                  "AND status IN ('PENDING','OVERDUE') AND due_at <= ? ORDER BY due_at LIMIT 12",
                            crew, iso(at + timedelta(hours=24))),
        "last_session": session,
        "radiation": {k: rad[k] for k in ("window_days", "personal", "area", "limits")},
        "last_review": (reports(conn, crew, 1) or [None])[0],
        "recent_log": logbook(conn, crew, include_private=True)[:3],
    }
