from datetime import datetime, timedelta, timezone

from astra import db, devices, protocols, sync
from astra.protocols import evaluate

UTC = timezone.utc


def test_recurrent_and_mission_relative_occurrences():
    launch = datetime(2026, 1, 1, tzinfo=UTC)
    start, end = datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 15, tzinfo=UTC)
    weekly = protocols.occurrences("RECURRENT", {"every_days": 7, "at": ["08:00"]}, start, end, launch)
    assert [d.day for d in weekly] == [1, 8]
    md = protocols.occurrences("MISSION_RELATIVE", {"mission_days": [14, 30], "at": "10:00"}, start, end, launch)
    assert md == [datetime(2026, 1, 14, 10, tzinfo=UTC)]


def test_completion_rules_reject_poor_quality():
    rule = {"kind": "TELEMETRY_SESSION", "min_valid_minutes": 25, "min_valid_fraction": 0.8, "manual_fallback": True}
    ok, _ = evaluate(rule, {"kind": "TELEMETRY_SESSION", "status": "COMPLETED", "valid_minutes": 28.5, "valid_fraction": 0.95})
    assert ok
    ok, why = evaluate(rule, {"kind": "TELEMETRY_SESSION", "status": "FAULTED", "valid_minutes": 15, "valid_fraction": 0.6})
    assert not ok and len(why) == 3
    assert evaluate(rule, {"kind": "MANUAL_LOG", "duration_min": 30})[0]
    assert not evaluate({**rule, "manual_fallback": False}, {"kind": "MANUAL_LOG", "duration_min": 30})[0]
    m = {"kind": "MEASUREMENT", "metric": "resting_hr", "allow_manual": True}
    assert not evaluate(m, {"kind": "MEASUREMENT", "metric": "resting_hr", "source": "MANUAL", "quality": "INVALID"})[0]
    v = {"kind": "VERIFICATION", "roles": ["CREW_MEDICAL_OFFICER"]}
    assert not evaluate(v, {"kind": "VERIFICATION", "role": "ASTRONAUT", "note": "ok"})[0]


def test_simulated_session_has_artefact_but_passes():
    s = devices.summarize(devices.simulate_exercise(seed=1, minutes=30))
    assert s["valid_minutes"] == 28.5 and 0.9 < s["valid_fraction"] < 1
    faulted = devices.summarize(devices.simulate_exercise(seed=1, minutes=30, fault_at_min=17))
    assert faulted["valid_minutes"] < 25


def test_sync_is_ordered_retrying_and_idempotent(tmp_path):
    conn, ground = db.connect(str(tmp_path / "a.db")), sync.connect_ground(str(tmp_path / "g.db"))
    for i in range(5):
        db.record(conn, db.SYSTEM, "X", "thing", str(i), {"i": i})
    assert sync.push(conn, ground)["link"] == "LOS"  # default: no link, nothing leaves
    db.set_setting(conn, "ground_link", "AOS")

    calls = {"n": 0}

    def flaky(g, evt):
        calls["n"] += 1
        if calls["n"] == 3:
            raise ConnectionError("link dropped")
        sync.ground_ingest(g, evt)

    r = sync.push(conn, ground, transmit=flaky)
    assert r["sent"] == 2 and r["pending"] == 3 and "link dropped" in r["error"]
    # Simulate "ground stored it but ack was lost": resend everything.
    conn.execute("UPDATE outbox SET synced_at = NULL")
    assert sync.push(conn, ground)["pending"] == 0
    assert ground.execute("SELECT COUNT(*) FROM received").fetchone()[0] == 5


def test_critical_overdue_task_escalates_once(tmp_path):
    conn = db.connect(str(tmp_path / "a.db"))
    db.set_setting(conn, "mission_start", "2026-01-01T00:00:00Z")
    due = datetime(2026, 1, 2, 10, tzinfo=UTC)
    tid = protocols.order_task(conn, db.SYSTEM, "CM-01", "check", "VERIFICATION", due, "CRITICAL",
                               {"kind": "VERIFICATION", "roles": ["FLIGHT_SURGEON"]})
    assert protocols.tick(conn, due - timedelta(minutes=10))["due"] == 1
    assert protocols.tick(conn, due + timedelta(minutes=61))["overdue"] == 1
    assert protocols.tick(conn, due + timedelta(minutes=121))["escalated"] == 1
    assert protocols.tick(conn, due + timedelta(minutes=200))["escalated"] == 0
    alert = db.one(conn, "SELECT * FROM alerts")
    assert alert["category"] == "OPERATIONAL" and db.one(conn, "SELECT status FROM tasks WHERE id=?", tid)["status"] == "OVERDUE"
