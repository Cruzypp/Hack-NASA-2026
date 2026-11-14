"""Body composition & segmental lean mass (InBody-style BIA, DXA, MRI).

Each assessment is compared with the crew member's own preflight reference
(mean of PREFLIGHT assessments made with the SAME method). Different methods
are never compared directly. Findings are explainable, rule-based and go to
medical review — ASTRA does not diagnose and does not change exercise or
nutrition prescriptions.

Lean (fat-free) mass is NOT pure muscle: it includes water, organs and bone
mineral. BIA is not validated for microgravity, where fluid shifts headward.
"""
import json
import random
from datetime import datetime, timedelta

from . import clinical, db, protocols
from .db import SYSTEM, Actor, iso, parse

SEGMENTS = ("right_arm", "left_arm", "trunk", "right_leg", "left_leg")
SEGMENT_LABEL = {"right_arm": "Right arm", "left_arm": "Left arm", "trunk": "Trunk",
                 "right_leg": "Right leg", "left_leg": "Left leg"}

RULE = {
    "id": "body-composition-delta", "version": "1.0.0",
    "segment_pct": {"WATCH": 3.0, "REVIEW": 5.0, "ACTION": 8.0},   # segmental lean loss vs reference
    "lean_pct": {"WATCH": 2.0, "REVIEW": 3.0, "ACTION": 5.0},      # whole-body fat-free mass loss
    "muscle_pct": {"WATCH": 2.0, "REVIEW": 4.0, "ACTION": 6.0},    # skeletal muscle mass (estimated)
    "mass_pct": {"WATCH": 2.0, "REVIEW": 4.0, "ACTION": 6.0},      # body mass loss
    "leg_asymmetry_pct": {"WATCH": 4.0, "REVIEW": 6.0, "ACTION": 10.0},
    "ecw_ratio_max": 0.390,          # ECW/TBW above this: likely fluid shift, BIA lean values biased
    "phase_angle_drop_deg": 0.5,
    "provenance": "ASTRA experimental thresholds for demo — not NASA-specified; flight surgeon must review and set limits.",
}
RANK = {"WITHIN_REFERENCE": 0, "WATCH": 1, "REVIEW": 2, "ACTION": 3}

METHODS = {
    "BIA": {"label": "Segmental bioimpedance (InBody-type)",
            "uncertainty": {"lean_mass_kg": 2.0, "segment_pct": 4.0, "body_fat_pct": 3.5},
            "limitations": ["Not validated for microgravity: headward fluid shift biases segmental estimates.",
                            "Sensitive to hydration, recent exercise, food intake and electrode contact.",
                            "Estimates fat-free mass, not muscle directly; skeletal muscle mass is a model output."]},
    "DXA": {"label": "Dual-energy X-ray absorptiometry",
            "uncertainty": {"lean_mass_kg": 0.8, "segment_pct": 2.0, "body_fat_pct": 1.5},
            "limitations": ["Ground-only (pre/postflight).", "Lean soft tissue includes water and organs."]},
    "MRI": {"label": "Magnetic resonance imaging (muscle volume)",
            "uncertainty": {"lean_mass_kg": 0.5, "segment_pct": 1.5, "body_fat_pct": 1.0},
            "limitations": ["Ground-only; usually limited to selected muscle groups."]},
    "OTHER": {"label": "Other / unspecified", "uncertainty": {}, "limitations": ["Method not characterised."]},
}

# Synthetic preflight profiles for the demo crew (fictional people, fictional numbers).
PROFILES = {
    "CM-01": {"body_mass_kg": 72.4, "lean_mass_kg": 58.6, "skeletal_muscle_kg": 33.4, "fat_mass_kg": 13.8,
              "tbw_l": 42.9, "ecw_ratio": 0.380, "phase_angle_deg": 6.8, "visceral_fat_level": 6, "bmr_kcal": 1636,
              "segments": {"right_arm": 3.45, "left_arm": 3.38, "trunk": 26.9, "right_leg": 9.62, "left_leg": 9.55}},
    "CM-02": {"body_mass_kg": 68.0, "lean_mass_kg": 50.2, "skeletal_muscle_kg": 28.1, "fat_mass_kg": 17.8,
              "tbw_l": 36.8, "ecw_ratio": 0.383, "phase_angle_deg": 6.1, "visceral_fat_level": 7, "bmr_kcal": 1454,
              "segments": {"right_arm": 2.70, "left_arm": 2.65, "trunk": 23.1, "right_leg": 8.40, "left_leg": 8.35}},
}

# Scenario → relative change of each segment's lean mass vs reference (fractions), plus fat & fluid.
SCENARIOS = {
    "STABLE": {"segments": {s: 0.0 for s in SEGMENTS}, "fat": 0.0, "ecw": 0.0,
               "label": "Stable — within reference"},
    "MILD_LOSS": {"segments": {"right_arm": -0.01, "left_arm": -0.01, "trunk": -0.01, "right_leg": -0.035, "left_leg": -0.04},
                  "fat": -0.02, "ecw": 0.002, "label": "Mild lower-limb loss"},
    "LEG_ATROPHY": {"segments": {"right_arm": -0.015, "left_arm": -0.02, "trunk": -0.025, "right_leg": -0.085, "left_leg": -0.095},
                    "fat": 0.03, "ecw": 0.003, "label": "Marked lower-limb lean loss"},
    "ASYMMETRIC": {"segments": {"right_arm": -0.01, "left_arm": -0.01, "trunk": -0.015, "right_leg": -0.025, "left_leg": -0.11},
                   "fat": 0.0, "ecw": 0.002, "label": "Left-leg asymmetric loss"},
    "GLOBAL_LOSS": {"segments": {"right_arm": -0.06, "left_arm": -0.065, "trunk": -0.05, "right_leg": -0.07, "left_leg": -0.07},
                    "fat": -0.12, "ecw": 0.004, "label": "Global lean & mass loss (energy deficit pattern)"},
    "FLUID_SHIFT": {"segments": {"right_arm": 0.02, "left_arm": 0.02, "trunk": 0.04, "right_leg": -0.06, "left_leg": -0.065},
                    "fat": 0.0, "ecw": 0.022, "label": "Fluid shift artefact (headward)"},
    "RECOVERY": {"segments": {"right_arm": 0.005, "left_arm": 0.0, "trunk": 0.0, "right_leg": -0.01, "left_leg": -0.012},
                 "fat": 0.01, "ecw": 0.0, "label": "Recovery towards reference"},
}


def _pct(new: float, ref: float) -> float:
    return round((new - ref) / ref * 100, 1)


def _row(r: dict) -> dict:
    r = dict(r)
    for k in ("values_json", "segments_json", "conditions_json", "evaluation_json"):
        r[k.removesuffix("_json")] = json.loads(r.pop(k))
    r["method_info"] = METHODS[r["method"]]
    return r


def history(conn, crew: str) -> list[dict]:
    return [_row(r) for r in db.rows(conn, "SELECT * FROM body_composition WHERE crew_member_id = ? ORDER BY measured_at",
                                     crew)]


def reference(conn, crew: str, method: str, exclude_id: str | None = None) -> dict | None:
    """Mean of the PREFLIGHT assessments made with the same method."""
    pre = [r for r in history(conn, crew) if r["phase"] == "PREFLIGHT" and r["method"] == method
           and r["id"] != exclude_id and r["quality"] != "INVALID"]
    if not pre:
        return None
    mean = lambda xs: round(sum(xs) / len(xs), 3)  # noqa: E731
    return {"method": method, "n": len(pre), "from": pre[0]["measured_at"], "to": pre[-1]["measured_at"],
            "ids": [r["id"] for r in pre],
            "values": {k: mean([r["values"][k] for r in pre]) for k in pre[0]["values"]},
            "segments": {s: mean([r["segments"][s] for r in pre]) for s in SEGMENTS}}


def context(conn, crew: str, at: datetime, days: int = 14) -> dict:
    """What else the record shows around the scan. Shown next to findings; never treated as a cause."""
    since = iso(at - timedelta(days=days))
    ex = db.one(conn, """SELECT SUM(status = 'COMPLETED') done, COUNT(*) total FROM tasks WHERE crew_member_id = ?
                         AND task_type = 'EXERCISE' AND status != 'CANCELLED' AND due_at >= ? AND due_at <= ?""",
                crew, since, iso(at))
    sessions = db.rows(conn, """SELECT summary_json FROM sensor_sessions WHERE crew_member_id = ? AND kind = 'EXERCISE'
                                AND status = 'COMPLETED' AND ended_at >= ? AND ended_at <= ?""", crew, since, iso(at))
    minutes = sum((json.loads(r["summary_json"] or "{}").get("valid_minutes") or 0) for r in sessions)
    avg = lambda metric: db.one(conn, """SELECT ROUND(AVG(value), 2) v, COUNT(*) n FROM measurements WHERE crew_member_id = ?
                                       AND metric = ? AND superseded = 0 AND measured_at >= ? AND measured_at <= ?""",
                                crew, metric, since, iso(at))  # noqa: E731
    sleep, rpe = avg("sleep_hours"), avg("rpe")
    total = ex["total"] or 0
    return {"window_days": days,
            "exercise_adherence": round(ex["done"] / total, 2) if total else None, "exercise_done": ex["done"] or 0,
            "exercise_scheduled": total, "telemetry_minutes": round(minutes, 1), "telemetry_sessions": len(sessions),
            "sleep_mean_h": sleep["v"], "sleep_n": sleep["n"], "rpe_mean": rpe["v"],
            "nutrition": "No nutrition records in ASTRA yet — energy sufficiency cannot be assessed."}


def _level(loss_pct: float, thresholds: dict) -> str:
    """loss_pct is positive for a loss."""
    for lvl in ("ACTION", "REVIEW", "WATCH"):
        if loss_pct >= thresholds[lvl]:
            return lvl
    return "WITHIN_REFERENCE"


def evaluate(conn, a: dict) -> dict:
    """Compare one assessment (as returned by `_row`) with the same-method preflight reference."""
    ref = reference(conn, a["crew_member_id"], a["method"], exclude_id=a["id"])
    out = {"rule": RULE, "method": a["method"], "limitations": list(METHODS[a["method"]]["limitations"]),
           "uncertainty": METHODS[a["method"]]["uncertainty"], "findings": [], "deltas": {}, "segments": {}}
    if a["phase"] == "PREFLIGHT" and not ref:
        return {**out, "status": "REFERENCE", "summary": "Preflight assessment — forms part of the personal reference."}
    if not ref:
        other = {r["method"] for r in history(conn, a["crew_member_id"]) if r["phase"] == "PREFLIGHT"}
        note = f" Preflight exists only for {', '.join(sorted(other))}; methods are not compared directly." if other else ""
        return {**out, "status": "NO_REFERENCE", "summary": f"No {a['method']} preflight reference.{note}"}
    out["reference"] = {k: ref[k] for k in ("method", "n", "from", "to", "ids")}
    ctx = out["context"] = context(conn, a["crew_member_id"], parse(a["measured_at"]))
    adherence = ctx["exercise_adherence"]
    low_adherence = adherence is not None and adherence < 0.8
    v, rv = a["values"], ref["values"]
    ev = {"date": a["measured_at"], "reference": f"{ref['n']} preflight {a['method']} assessment(s), {ref['from'][:10]}–{ref['to'][:10]}"}
    out["deltas"] = {k: {"value": v[k], "reference": rv[k], "pct": _pct(v[k], rv[k])}
                     for k in ("body_mass_kg", "lean_mass_kg", "skeletal_muscle_kg", "fat_mass_kg", "tbw_l")}
    out["deltas"]["ecw_ratio"] = {"value": v["ecw_ratio"], "reference": rv["ecw_ratio"],
                                  "diff": round(v["ecw_ratio"] - rv["ecw_ratio"], 3)}
    out["deltas"]["phase_angle_deg"] = {"value": v["phase_angle_deg"], "reference": rv["phase_angle_deg"],
                                        "diff": round(v["phase_angle_deg"] - rv["phase_angle_deg"], 2)}
    fluid = v["ecw_ratio"] > RULE["ecw_ratio_max"]
    caveat = " Elevated ECW/TBW: fluid redistribution may bias this value." if fluid else ""

    def add(code, level, title, observation, interpretation, action, responsible="Crew Medical Officer"):
        out["findings"].append({"code": code, "level": level, "title": title, "observation": observation,
                                "evidence": ev, "interpretation": interpretation + caveat,
                                "limitations": out["limitations"][0], "action": action, "responsible": responsible,
                                "follow_up": "OPEN" if RANK[level] >= RANK["REVIEW"] else "MONITOR"})

    for s in SEGMENTS:
        pct = _pct(a["segments"][s], ref["segments"][s])
        lvl = _level(-pct, RULE["segment_pct"])
        out["segments"][s] = {"value": a["segments"][s], "reference": ref["segments"][s], "pct": pct, "level": lvl}
    legs = [s for s in ("right_leg", "left_leg") if RANK[out["segments"][s]["level"]] >= RANK["WATCH"]]
    if legs:
        worst = max(legs, key=lambda s: RANK[out["segments"][s]["level"]] * 100 - out["segments"][s]["pct"])
        lvl = out["segments"][worst]["level"]
        add("LOWER_LIMB_LEAN_LOSS", lvl, "Lower-limb lean mass below preflight reference",
            "; ".join(f"{SEGMENT_LABEL[s]} {out['segments'][s]['pct']:+.1f}% ({out['segments'][s]['value']:.2f} vs "
                      f"{out['segments'][s]['reference']:.2f} kg)" for s in ("right_leg", "left_leg")),
            "Pattern consistent with reduced loading of the lower limbs (antigravity muscles)."
            + (f" Exercise adherence was {adherence:.0%} ({ctx['exercise_done']}/{ctx['exercise_scheduled']}) in the last "
               f"{ctx['window_days']} d." if adherence is not None else " No exercise schedule in the window.")
            + " Co-occurrence, not causation.",
            "Review lower-body resistive exercise volume (ARED) and adherence with the conditioning specialist.",
            "Crew Medical Officer + exercise/conditioning specialist")
    for s in ("right_arm", "left_arm", "trunk"):
        lvl = out["segments"][s]["level"]
        if RANK[lvl] >= RANK["REVIEW"]:
            add(f"{s.upper()}_LEAN_LOSS", lvl, f"{SEGMENT_LABEL[s]} lean mass below reference",
                f"{SEGMENT_LABEL[s]} {out['segments'][s]['pct']:+.1f}%",
                "Upper-body / trunk loss is less typical in flight; check measurement conditions before interpreting.",
                "Repeat under standard conditions; review upper-body training log.")
    rl, ll = a["segments"]["right_leg"], a["segments"]["left_leg"]
    asym = round(abs(rl - ll) / ((rl + ll) / 2) * 100, 1)
    ref_asym = round(abs(ref["segments"]["right_leg"] - ref["segments"]["left_leg"])
                     / ((ref["segments"]["right_leg"] + ref["segments"]["left_leg"]) / 2) * 100, 1)
    out["leg_asymmetry_pct"] = {"value": asym, "reference": ref_asym}
    lvl = _level(asym - ref_asym, RULE["leg_asymmetry_pct"])
    if RANK[lvl] >= RANK["WATCH"]:
        add("LEG_ASYMMETRY", lvl, "Right/left leg lean asymmetry increased",
            f"Asymmetry {asym:.1f}% vs {ref_asym:.1f}% preflight ({'left' if ll < rl else 'right'} side lower)",
            "New asymmetry may reflect unilateral loading, technique on ARED/T2 or injury; electrode contact can also cause it.",
            "Clinical exam of the lower limbs; review exercise technique and symptoms.")
    for key, rule_key, code, title, interp, action in (
        ("lean_mass_kg", "lean_pct", "LEAN_MASS_LOSS", "Whole-body fat-free mass below reference",
         "Fat-free mass includes water and organs; not equivalent to muscle loss.",
         "Review training load and energy/protein intake with the nutrition specialist (no automatic change)."),
        ("skeletal_muscle_kg", "muscle_pct", "MUSCLE_MASS_LOSS", "Estimated skeletal muscle mass below reference",
         "Skeletal muscle mass is a device model estimate derived from impedance.",
         "Correlate with strength/functional tests before acting."),
        ("body_mass_kg", "mass_pct", "BODY_MASS_LOSS", "Body mass below reference",
         "Body mass loss in flight is commonly associated with energy intake below expenditure.",
         "Review energy sufficiency and meal logging completeness."),
    ):
        lvl = _level(-out["deltas"][key]["pct"], RULE[rule_key])
        if RANK[lvl] >= RANK["WATCH"]:
            d = out["deltas"][key]
            add(code, lvl, title, f"{d['value']:.1f} kg vs {d['reference']:.1f} kg ({d['pct']:+.1f}%)", interp, action,
                "Crew Medical Officer + nutrition specialist" if key == "body_mass_kg" else "Crew Medical Officer")
    if low_adherence and RANK[out["segments"].get("right_leg", {}).get("level", "WITHIN_REFERENCE")] + \
            RANK[out["segments"].get("left_leg", {}).get("level", "WITHIN_REFERENCE")] > 0:
        add("LOW_ADHERENCE_WITH_LOSS", "REVIEW", "Lean loss coincides with low exercise adherence",
            f"{ctx['exercise_done']}/{ctx['exercise_scheduled']} exercise sessions completed in {ctx['window_days']} d "
            f"({ctx['telemetry_minutes']} valid telemetry min)",
            "Missed sessions and lower-limb loss occur together; ASTRA cannot attribute cause from this.",
            "Review barriers to exercise completion with the crew member; conditioning specialist to review the plan.",
            "Crew Medical Officer + exercise/conditioning specialist")
    if fluid:
        add("FLUID_SHIFT", "WATCH", "ECW/TBW ratio elevated — measurement quality limited",
            f"ECW/TBW {v['ecw_ratio']:.3f} (reference {rv['ecw_ratio']:.3f}, threshold {RULE['ecw_ratio_max']})",
            "Microgravity fluid redistribution or oedema; segmental lean values from BIA are unreliable here.",
            "Interpret lean values with caution; repeat after standardised conditions or confirm postflight with DXA.")
    if rv["phase_angle_deg"] - v["phase_angle_deg"] >= RULE["phase_angle_drop_deg"]:
        add("PHASE_ANGLE_DROP", "WATCH", "Phase angle decreased",
            f"{v['phase_angle_deg']:.1f}° vs {rv['phase_angle_deg']:.1f}° preflight",
            "Lower phase angle is associated with reduced cell mass/integrity; non-specific marker.",
            "Monitor in next assessments.")
    cond = a["conditions"]
    if not cond.get("fasting", True) or cond.get("hours_since_exercise", 24) < 3:
        out["limitations"].append("Acquisition conditions not standard (fasting / ≥3 h after exercise).")
    status = max((f["level"] for f in out["findings"]), key=RANK.get, default="WITHIN_REFERENCE")
    out["status"] = status
    top = sorted(out["findings"], key=lambda f: -RANK[f["level"]])
    out["summary"] = (f"{len(out['findings'])} finding(s) vs {a['method']} preflight reference; "
                      f"highest: {top[0]['title'].lower()} ({top[0]['level']})." if top
                      else f"All values within reference thresholds vs {a['method']} preflight.")
    return out


def store(conn, actor: Actor, crew: str, at: datetime, phase: str, method: str, device: str, values: dict,
          segments: dict, conditions: dict, source: str, scenario: str | None = None, alert: bool = True) -> dict:
    a = {"id": db.new_id("bca"), "crew_member_id": crew, "measured_at": iso(at), "phase": phase,
         "mission_day": protocols.mission_day(conn, at) if phase == "INFLIGHT" else None, "method": method,
         "device": device, "values_json": json.dumps(values), "segments_json": json.dumps(segments),
         "conditions_json": json.dumps(conditions), "quality": "GOOD", "source": source, "scenario": scenario,
         "entered_by": actor.id, "created_at": iso(db.now())}
    with db.tx(conn):
        row = _row({**a, "evaluation_json": "{}"})
        ev = evaluate(conn, row)
        if any(f["code"] == "FLUID_SHIFT" for f in ev["findings"]) or len(ev["limitations"]) > len(METHODS[method]["limitations"]):
            a["quality"] = "DEGRADED"
        a["evaluation_json"] = json.dumps(ev)
        db.insert(conn, "body_composition", a)
        db.record(conn, actor, "BODY_COMPOSITION_RECORDED", "body_composition", a["id"],
                  {"phase": phase, "method": method, "source": source, "scenario": scenario, "status": ev["status"]})
        if alert and RANK.get(ev["status"], 0) >= RANK["REVIEW"]:
            a["alert_id"] = _raise(conn, crew, a, ev, at)
            db.update(conn, "body_composition", a["id"], {"alert_id": a["alert_id"]})
        if source != "SEED":
            clinical.log(conn, SYSTEM, crew, "AUTOMATED", f"Body composition ({method}, {phase.lower()}): {ev['summary']}",
                         "body_composition", a["id"])
    return _row(db.one(conn, "SELECT * FROM body_composition WHERE id = ?", a["id"]))


def _raise(conn, crew: str, a: dict, ev: dict, at: datetime) -> str:
    top = max(ev["findings"], key=lambda f: RANK[f["level"]])
    rec = (f"{top['action']} Responsible: {top['responsible']}. "
           "ASTRA does not diagnose and does not modify exercise or nutrition prescriptions.")
    alert_id = protocols.raise_alert(
        conn, crew, "MEDICAL", "BODY_COMPOSITION_FINDINGS", "HIGH" if ev["status"] == "ACTION" else "REVIEW",
        f"Body composition: {top['title'].lower()}",
        {"summary": ev["summary"], "assessment_id": a["id"], "findings": ev["findings"], "rule": RULE,
         "recommendation": rec}, rule_id=RULE["id"], rule_version=RULE["version"])
    task = protocols.order_task(conn, SYSTEM, crew, "CMO review: body composition findings", "VERIFICATION",
                                at + timedelta(hours=24 if ev["status"] == "REVIEW" else 8),
                                "CRITICAL" if ev["status"] == "ACTION" else "HIGH",
                                {"kind": "VERIFICATION", "roles": ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"]},
                                source_alert_id=alert_id, note=rec)
    db.update(conn, "alerts", alert_id, {"follow_up_task_id": task})
    return alert_id


def synthesize(base: dict, scenario: str, rng: random.Random) -> tuple[dict, dict]:
    """Synthetic BIA result: scenario deltas applied to the reference, plus device-level noise."""
    sc = SCENARIOS[scenario]
    segs = {s: round(base["segments"][s] * (1 + sc["segments"][s] + rng.gauss(0, 0.004)), 2) for s in SEGMENTS}
    lean_delta = sum(segs[s] - base["segments"][s] for s in SEGMENTS) * 1.08  # segments ≈ 92 % of FFM
    lean = round(base["lean_mass_kg"] + lean_delta, 1)
    limb_ref = sum(base["segments"][s] for s in SEGMENTS if s != "trunk")
    limb_now = sum(segs[s] for s in SEGMENTS if s != "trunk")
    smm = round(base["skeletal_muscle_kg"] * (0.75 * limb_now / limb_ref + 0.25 * lean / base["lean_mass_kg"]), 1)
    fat = round(base["fat_mass_kg"] * (1 + sc["fat"] + rng.gauss(0, 0.01)), 1)
    mass = round(lean + fat, 1)
    ecw = round(base["ecw_ratio"] + sc["ecw"] + rng.gauss(0, 0.001), 3)
    pa = round(base["phase_angle_deg"] + (lean / base["lean_mass_kg"] - 1) * 8 - sc["ecw"] * 15 + rng.gauss(0, 0.05), 1)
    values = {"body_mass_kg": mass, "lean_mass_kg": lean, "skeletal_muscle_kg": smm, "fat_mass_kg": fat,
              "body_fat_pct": round(fat / mass * 100, 1), "tbw_l": round(lean * 0.732 * (1 + sc["ecw"]), 1),
              "ecw_ratio": ecw, "phase_angle_deg": pa,
              "visceral_fat_level": max(1, round(base["visceral_fat_level"] * (1 + sc["fat"]))),
              "bmr_kcal": round(370 + 21.6 * lean)}  # Katch–McArdle
    return values, segs


def _base(conn, crew: str) -> dict:
    ref = reference(conn, crew, "BIA")
    if ref:
        return {**ref["values"], "segments": ref["segments"]}
    return PROFILES.get(crew) or PROFILES["CM-01"]


def simulate(conn, actor: Actor, crew: str, scenario: str, phase: str, at: datetime) -> dict:
    rng = random.Random()
    if scenario == "RANDOM":
        scenario = rng.choice([s for s in SCENARIOS if s != "STABLE"])
    values, segs = synthesize(_base(conn, crew), scenario, rng)
    cond = {"fasting": True, "hours_since_exercise": 12, "posture": "Restrained, standing-equivalent",
            "hydration": "Elevated ECW/TBW" if values["ecw_ratio"] > RULE["ecw_ratio_max"] else "Within usual range",
            "note": f"Synthetic demo record — scenario {SCENARIOS[scenario]['label']}"}
    return store(conn, actor, crew, at, phase, "BIA", "bia-sim", values, segs, cond, "SIMULATED", scenario)


def seed(conn) -> None:
    """Synthetic history (idempotent): two preflight BIA + one preflight DXA, then in-flight BIA every 14 days."""
    if db.one(conn, "SELECT 1 FROM body_composition LIMIT 1") or not db.get_setting(conn, "mission_start"):
        return
    launch = parse(db.get_setting(conn, "mission_start"))
    rng = random.Random(7)
    today_md = protocols.mission_day(conn, db.now())
    for crew, prof in PROFILES.items():
        plan = [(-60, "PREFLIGHT", "BIA", "STABLE"), (-45, "PREFLIGHT", "DXA", "STABLE"), (-20, "PREFLIGHT", "BIA", "STABLE")]
        plan += [(d, "INFLIGHT", "BIA", "STABLE" if d < 20 or crew == "CM-02" else "MILD_LOSS")
                 for d in range(13, today_md, 14)]
        for day, phase, method, scenario in plan:
            values, segs = synthesize(prof, scenario, rng)
            if method == "DXA":  # DXA reads systematically different from BIA — never compared directly
                values = {**values, "lean_mass_kg": round(values["lean_mass_kg"] - 1.4, 1),
                          "fat_mass_kg": round(values["fat_mass_kg"] + 1.2, 1)}
            store(conn, SYSTEM, crew, launch + timedelta(days=day, hours=7), phase, method,
                  "bia-sim" if method == "BIA" else "ground-dxa",
                  values, segs, {"fasting": True, "hours_since_exercise": 12, "note": "Synthetic seed history"},
                  "SEED", scenario, alert=False)
