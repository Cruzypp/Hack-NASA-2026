"""Demo data. Every frequency below is an ASTRA DEMO PLACEHOLDER, not a NASA
prescription; real values must come from the crew member's approved medical
plan and be entered by a flight surgeon as a new ProtocolVersion.
"""
import hashlib
import json
import os
import random
from datetime import datetime, time, timedelta

from . import db, devices, protocols, sync
from .db import SYSTEM, iso

DEMO_PINS = {"vega": "1111", "okafor": "2222", "lindqvist": "3333", "ops": "4444"}

USERS = [
    ("usr_vega", "vega", "M. Vega", "ASTRONAUT", "CM-01"),
    ("usr_okafor", "okafor", "Dr. K. Okafor", "CREW_MEDICAL_OFFICER", "CM-02"),
    ("usr_lindqvist", "lindqvist", "Dr. S. Lindqvist", "FLIGHT_SURGEON", None),
    ("usr_ops", "ops", "Mission Ops Console", "MISSION_OPERATOR", None),
]

PLACEHOLDER = "ASTRA demo placeholder — not a NASA-specified frequency; replace with flight-surgeon-approved plan."
CONTEXT_REFS = {
    "exercise": "Context: NASA Astronaut Exercise (in-flight countermeasures exist; prescription is individual).",
    "medical": "Context: NASA OCHMO-STD-100.1A (mission medical evaluations).",
    "radiation": "Context: NASA-STD-3001 Vol. 1 / Space Radiation Analysis Group (crew dosimetry).",
    "measures": "Context: NASA Spaceflight Standard Measures.",
}
R = protocols.DEFAULT_REMINDER

# id, name, task_type, category, schedule_type, schedule, completion_rule, priority, context
PROTOCOLS = [
    ("exercise-aerobic", "Aerobic exercise session", "EXERCISE", "EXERCISE", "RECURRENT",
     {"every_days": 1, "at": ["09:00"]},
     {"kind": "TELEMETRY_SESSION", "metric": "heart_rate", "min_valid_minutes": 25, "min_valid_fraction": 0.8,
      "manual_fallback": True}, "HIGH", "exercise"),
    ("resting-hr", "Resting heart rate", "MEASUREMENT", "MEDICAL", "RECURRENT",
     {"every_days": 1, "at": ["07:00"]},
     {"kind": "MEASUREMENT", "metric": "resting_hr", "allow_manual": True}, "ROUTINE", "measures"),
    ("sleep-log", "Sleep duration log", "MEASUREMENT", "SLEEP", "RECURRENT",
     {"every_days": 1, "at": ["06:30"]},
     {"kind": "MEASUREMENT", "metric": "sleep_hours", "allow_manual": True}, "ROUTINE", "measures"),
    ("body-mass", "Body mass", "MEASUREMENT", "MEDICAL", "RECURRENT",
     {"every_days": 7, "at": ["08:00"]},
     {"kind": "MEASUREMENT", "metric": "body_mass", "allow_manual": True}, "ROUTINE", "measures"),
    ("periodic-exam", "Periodic in-flight medical check", "EVALUATION", "MEDICAL", "MISSION_RELATIVE",
     {"mission_days": list(range(14, 400, 14)), "at": "10:00"},
     {"kind": "VERIFICATION", "roles": ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"]}, "CRITICAL", "medical"),
    ("eva-dosimeter-pre", "Pre-EVA dosimeter check", "DEVICE_CHECK", "RADIATION", "EVENT_TRIGGERED",
     {"event": "EVA", "anchor": "start", "offset_min": -60},
     {"kind": "DEVICE_CHECK", "device_kind": "personal_dosimeter", "max_reading_age_min": 30}, "CRITICAL", "radiation"),
    ("eva-dosimeter-post", "Post-EVA dosimeter check", "DEVICE_CHECK", "RADIATION", "EVENT_TRIGGERED",
     {"event": "EVA", "anchor": "end", "offset_min": 30},
     {"kind": "DEVICE_CHECK", "device_kind": "personal_dosimeter", "max_reading_age_min": 30}, "CRITICAL", "radiation"),
]


def hash_pin(pin: str, salt: bytes) -> bytes:
    return hashlib.scrypt(pin.encode(), salt=salt, n=2**14, r=8, p=1)


def seed(conn, ground, at: datetime | None = None) -> None:
    if db.one(conn, "SELECT 1 FROM users LIMIT 1"):
        return
    at = at or db.now()
    today = datetime.combine(at.date(), time(0), tzinfo=at.tzinfo)
    launch = today - timedelta(days=41)  # demo: today is Mission Day 42
    rng = random.Random(42)
    with db.tx(conn):
        db.set_setting(conn, "mission_start", iso(launch))
        db.set_setting(conn, "mission_name", "Increment 74")
        db.set_setting(conn, "ground_link", "AOS")
        for uid, uname, name, role, crew in USERS:
            salt = os.urandom(16)
            db.insert(conn, "users", {"id": uid, "username": uname, "display_name": name, "role": role,
                                      "crew_member_id": crew, "pin_salt": salt, "pin_hash": hash_pin(DEMO_PINS[uname], salt)})
        for dev_id, name, kind, integ, note in devices.CATALOG:
            db.insert(conn, "devices", {"id": dev_id, "name": name, "kind": kind, "integration": integ,
                                        "status": "ONLINE" if integ == "SIMULATED" else "NOT_CONNECTED",
                                        "last_seen": iso(at) if integ == "SIMULATED" else None, "note": note})
        for pid, name, ttype, cat, stype, sched, rule, prio, ctx in PROTOCOLS:
            db.insert(conn, "protocol_templates", {"id": pid, "name": name, "task_type": ttype, "category": cat})
            vid = f"{pid}@1.0.0"
            db.insert(conn, "protocol_versions", {
                "id": vid, "protocol_id": pid, "version": "1.0.0", "schedule_type": stype,
                "schedule_json": json.dumps(sched), "completion_rule_json": json.dumps(rule), "reminder_json": json.dumps(R),
                "priority": prio, "source": f"{PLACEHOLDER} {CONTEXT_REFS[ctx]}", "source_kind": "ASTRA_DEMO_PLACEHOLDER",
                "population": "All crew, Increment 74", "approved_by": "usr_lindqvist",
                "effective_from": iso(launch)})
            for crew in ("CM-01", "CM-02"):
                db.insert(conn, "protocol_assignments", {"id": db.new_id("asg"), "crew_member_id": crew,
                                                         "protocol_version_id": vid, "assigned_by": "usr_lindqvist",
                                                         "assigned_at": iso(launch)})
        # 28 days of history so CM-01 has an individual baseline.
        for d in range(28, 0, -1):
            day = today - timedelta(days=d)
            _m(conn, "CM-01", "resting_hr", round(rng.gauss(60, 2.2), 1), "bpm", day + timedelta(hours=7), "MANUAL")
            _m(conn, "CM-01", "sleep_hours", round(rng.gauss(7.1, 0.35), 2), "h", day + timedelta(hours=6, minutes=30), "MANUAL")
            if d % 7 == 0:
                _m(conn, "CM-01", "body_mass", round(rng.gauss(72.4, 0.25), 2), "kg", day + timedelta(hours=8), "MANUAL")
        # Last night's sleep was short — gives the demo anomaly real context.
        last_sleep = _m(conn, "CM-01", "sleep_hours", 5.3, "h", today + timedelta(hours=6, minutes=30), "MANUAL")

    for crew in ("CM-01", "CM-02"):
        protocols.generate_tasks(conn, crew, today - timedelta(days=3), today + timedelta(days=protocols.PLAN_HORIZON_DAYS))
    with db.tx(conn):
        # Past tasks: completed history, with one missed exercise to show compliance gaps.
        missed = iso(today - timedelta(days=2) + timedelta(hours=9))
        for t in db.rows(conn, "SELECT * FROM tasks WHERE due_at < ?", iso(today)):
            if t["task_type"] == "EXERCISE" and t["due_at"] == missed:
                continue
            db.update(conn, "tasks", t["id"], {"status": "COMPLETED", "completed_at": t["due_at"]})
            db.insert(conn, "task_evidence", {"id": db.new_id("evd"), "task_id": t["id"], "kind": "SEED", "ref_id": "seed",
                                              "accepted": 1, "reasons": json.dumps(["Historical demo seed"]),
                                              "created_at": t["due_at"]})
        sleep_task = db.one(conn, "SELECT id FROM tasks WHERE crew_member_id='CM-01' AND protocol_id='sleep-log' AND due_at = ?",
                            iso(today + timedelta(hours=6, minutes=30)))
        if sleep_task:
            protocols.submit_evidence(conn, SYSTEM, sleep_task["id"], last_sleep,
                                      {"kind": "MEASUREMENT", "metric": "sleep_hours", "source": "MANUAL", "quality": "GOOD"})
    # A week of continuous dosimetry history (hourly, simulated), not audited: it predates the demo.
    for h in range(7 * 24, 0, -1):
        devices.sample_dosimetry(conn, ["CM-01", "CM-02"], at - timedelta(hours=h), audit=False)
    protocols.tick(conn, at)
    # Seed history was already on the ground; the demo starts in LOS.
    conn.execute("UPDATE alerts SET notified_at = created_at WHERE notified_at IS NULL")  # seed history is not news
    sync.push(conn, ground)
    db.set_setting(conn, "ground_link", "LOS")


def _m(conn, crew, metric, value, unit, at, source) -> str:
    mid = db.new_id("msr")
    db.insert(conn, "measurements", {"id": mid, "crew_member_id": crew, "metric": metric, "value": value,
                                     "unit": unit, "measured_at": iso(at), "source": source, "quality": "GOOD",
                                     "entered_by": "seed", "created_at": iso(at)})
    db.record(conn, SYSTEM, "MEASUREMENT_RECORDED", "measurement", mid, {"metric": metric, "seed": True})
    return mid
