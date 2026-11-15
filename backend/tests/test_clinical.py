"""Clinician workspace: care-plan changes, automation, reviews and the logbook."""
from datetime import timedelta

from conftest import login

from astra import clinical, db, protocols
from astra.db import parse

PULSE = {"name": "Morning pulse (auto)", "schedule_type": "RECURRENT", "schedule": {"every_days": 1, "at": ["08:00"]},
         "completion_rule": {"kind": "MEASUREMENT", "metric": "resting_hr", "auto_capture": True, "allow_manual": True},
         "priority": "ROUTINE", "reference": "Flight surgeon order", "reason": "Track resting HR trend after short sleep"}


def _tasks(client, h, protocol_id):
    return [t for t in client.get("/tasks", headers=h).json() if t["protocol_id"] == protocol_id]


def test_only_flight_surgeon_changes_the_care_plan(client):
    cmo = login(client, "okafor", "2222")
    assert client.post("/crew/CM-01/care-plan", headers=cmo, json=PULSE).status_code == 403
    fs = login(client, "lindqvist", "3333")
    bad = {**PULSE, "schedule": {"every_days": 1, "at": ["25:00"]}}
    assert client.post("/crew/CM-01/care-plan", headers=fs, json=bad).status_code == 422
    assert client.post("/crew/CM-01/care-plan", headers=fs,
                       json={**PULSE, "completion_rule": {"kind": "MEASUREMENT", "metric": "body_mass", "auto_capture": True}}
                       ).status_code == 422  # no sensor can capture body mass


def test_auto_captured_pulse_closes_task_with_sensor_evidence(client):
    fs = login(client, "lindqvist", "3333")
    v = client.post("/crew/CM-01/care-plan", headers=fs, json=PULSE).json()
    assert v["source_kind"] == "CLINICAL_DECISION" and v["population"].startswith("CM-01")
    h = login(client, "vega", "1111")
    tasks = _tasks(client, h, v["protocol_id"])
    assert tasks and all(parse(t["due_at"]) >= parse(v["effective_from"]) for t in tasks)  # nothing scheduled in the past
    conn = client.app_state.conn
    due = parse(tasks[0]["due_at"])
    assert clinical.run_due(conn, due)["captured"] == 1
    t = next(x for x in _tasks(client, h, v["protocol_id"]) if x["id"] == tasks[0]["id"])
    assert t["status"] == "COMPLETED"
    m = db.one(conn, "SELECT * FROM measurements WHERE id = ?", t["evidenceIds"] and t["evidence"][-1]["ref_id"])
    assert m["source"] == "STREAM" and m["device_id"] == "bio-monitor-sim"
    # CM-02 never got the protocol.
    assert not db.rows(conn, "SELECT 1 FROM tasks WHERE crew_member_id='CM-02' AND protocol_id=?", v["protocol_id"])


def test_auto_capture_with_faulty_sensor_raises_one_incident(client):
    fs = login(client, "lindqvist", "3333")
    v = client.post("/crew/CM-01/care-plan", headers=fs, json=PULSE).json()
    conn = client.app_state.conn
    db.update(conn, "devices", "bio-monitor-sim", {"status": "FAULT"})
    due = parse(db.one(conn, "SELECT due_at FROM tasks WHERE protocol_id = ? ORDER BY due_at", v["protocol_id"])["due_at"])
    clinical.run_due(conn, due)
    clinical.run_due(conn, due + timedelta(minutes=5))
    assert len(db.rows(conn, "SELECT 1 FROM alerts WHERE type = 'AUTO_CAPTURE_FAILED'")) == 1
    assert db.one(conn, "SELECT status FROM tasks WHERE protocol_id = ? ORDER BY due_at", v["protocol_id"])["status"] == "PENDING"


def test_weekly_review_finds_shift_and_creates_follow_up(client):
    conn = client.app_state.conn
    now = db.now()
    for i in range(1, 6):  # five elevated mornings this week
        db.insert(conn, "measurements", {"id": f"msr_w{i}", "crew_member_id": "CM-01", "metric": "resting_hr", "value": 68.0 + i * 0.1,
                                         "unit": "bpm", "measured_at": db.iso(now - timedelta(days=i, hours=1)), "source": "MANUAL",
                                         "quality": "GOOD", "entered_by": "test", "created_at": db.iso(now)})
    r = clinical.review(conn, "CM-01", "resting_hr", 7, now)
    res = r["result"]
    assert res["status"] == "FINDINGS" and res["shift"]["flagged"] and res["deviations"]
    alert = db.one(conn, "SELECT * FROM alerts WHERE id = ?", res["alert_id"])
    assert alert["category"] == "MEDICAL" and alert["follow_up_task_id"]
    assert any(e["category"] == "AUTOMATED" for e in clinical.logbook(conn, "CM-01", include_private=True))


def test_weekly_schedule_and_radiation_task_closed_by_manual_reading(client):
    fs = login(client, "lindqvist", "3333")
    today = db.now().isoweekday()
    spec = {"name": "Weekly passive dosimeter readout", "schedule_type": "RECURRENT",
            "schedule": {"weekdays": [today], "at": ["23:59"]}, "completion_rule": {"kind": "RADIATION_READING", "manual_only": True},
            "priority": "HIGH", "reference": "SRAG crew dosimetry practice (context)", "reason": "Cross-check active dosimeter"}
    v = client.post("/crew/CM-01/care-plan", headers=fs, json=spec).json()
    h = login(client, "vega", "1111")
    task = _tasks(client, h, v["protocol_id"])[0]
    assert parse(task["due_at"]).isoweekday() == today and task["task_type"] == "RADIATION_READING"
    r = client.post("/radiation/readings", headers=h, json={"scope": "PERSONAL", "dose_rate_uGy_h": 19,
                                                           "device_id": "passive-dosimeter"}).json()
    assert r["completion"]["accepted"]


def test_revision_replaces_future_tasks_for_one_crew_member(client):
    fs = login(client, "lindqvist", "3333")
    r = client.post("/crew/CM-01/care-plan/sleep-log/revise", headers=fs,
                    json={"schedule": {"every_days": 1, "at": ["07:15"]}, "reason": "Align log with new wake time"})
    assert r.status_code == 200 and r.json()["version"] == "1.1.0" and r.json()["supersedes_id"] == "sleep-log@1.0.0"
    conn = client.app_state.conn
    future_old = db.rows(conn, "SELECT status FROM tasks WHERE crew_member_id='CM-01' AND protocol_version_id='sleep-log@1.0.0' "
                               "AND due_at >= ?", r.json()["effective_from"])
    assert future_old and all(t["status"] in ("CANCELLED", "COMPLETED") for t in future_old)
    assert any(t["status"] == "CANCELLED" for t in future_old)
    assert db.rows(conn, "SELECT 1 FROM tasks WHERE crew_member_id='CM-01' AND protocol_version_id='sleep-log@1.1.0'")
    # CM-02 keeps the original version.
    plan2 = client.get("/crew/CM-02/care-plan", headers=fs).json()
    assert any(p["id"] == "sleep-log@1.0.0" for p in plan2["active"])
    # A revision cannot turn a measurement into something else.
    bad = client.post("/crew/CM-01/care-plan/sleep-log/revise", headers=fs,
                      json={"completion_rule": {"kind": "VERIFICATION"}, "reason": "nope"})
    assert bad.status_code == 422
    # Retire: assignment ends, plan change is logged.
    assert client.post("/crew/CM-01/care-plan/sleep-log/retire", headers=fs, json={"reason": "Actigraphy import replaces it"}).status_code == 200
    plan = client.get("/crew/CM-01/care-plan", headers=fs).json()
    assert not any(p["protocol_id"] == "sleep-log" for p in plan["active"])
    assert sum(e["category"] == "PLAN_CHANGE" for e in client.get("/crew/CM-01/logbook", headers=fs).json()) == 2


def test_logbook_is_append_only_and_private_by_default(client):
    cmo = login(client, "okafor", "2222")
    private = client.post("/crew/CM-01/logbook", headers=cmo, json={"category": "OBSERVATION", "body": "Reports mild headache"}).json()
    shared = client.post("/crew/CM-01/logbook", headers=cmo, json={"category": "COMMUNICATION", "body": "Hydration advice given",
                                                                  "shared_with_crew": True}).json()
    client.post(f"/logbook/{private['id']}/addendum", headers=cmo, json={"body": "Resolved after rest"})
    entries = client.get("/crew/CM-01/logbook", headers=cmo).json()
    assert next(e for e in entries if e["id"] == private["id"])["addenda"][0]["body"] == "Resolved after rest"
    h = login(client, "vega", "1111")
    mine = client.get("/crew/CM-01/logbook", headers=h).json()
    assert [e["id"] for e in mine] == [shared["id"]]
    assert client.post("/crew/CM-01/logbook", headers=h, json={"category": "OTHER", "body": "x" * 5}).status_code == 403
    ops = login(client, "ops", "4444")
    assert client.get("/crew/CM-01/logbook", headers=ops).status_code == 403


def test_overview_reports_vitals_against_baseline(client):
    cmo = login(client, "okafor", "2222")
    o = client.get("/crew/CM-01/overview", headers=cmo).json()
    hr = next(v for v in o["vitals"] if v["metric"] == "resting_hr")
    assert hr["status"] == "WITHIN_BASELINE" and o["mission_day"] == 42
    assert o["radiation"]["personal"]["latest"]


def test_weekday_occurrences():
    from datetime import datetime, timezone
    launch = datetime(2026, 1, 1, tzinfo=timezone.utc)  # a Thursday
    got = protocols.occurrences("RECURRENT", {"weekdays": [1, 4], "at": ["09:00"]}, launch, launch + timedelta(days=14), launch)
    assert [d.isoweekday() for d in got] == [4, 1, 4, 1]


def test_one_off_task_by_cmo_any_kind_and_logged(client):
    cmo = login(client, "okafor", "2222")
    due = db.iso(db.now() + timedelta(days=3))
    r = client.post("/tasks", headers=cmo, json={"crew_member_id": "CM-01", "title": "Extra dosimeter readout", "due_at": due,
                                                 "priority": "HIGH", "completion_rule": {"kind": "RADIATION_READING", "manual_only": True}})
    assert r.status_code == 200 and r.json()["task_type"] == "RADIATION_READING" and r.json()["schedule_type"] == "CLINICIAN_ORDERED"
    assert any("Extra dosimeter readout" in e["body"] for e in client.get("/crew/CM-01/logbook", headers=cmo).json())
    past = client.post("/tasks", headers=cmo, json={"crew_member_id": "CM-01", "title": "Too late", "due_at": "2020-01-01T00:00:00Z",
                                                    "priority": "ROUTINE", "completion_rule": {"kind": "VERIFICATION"}})
    assert past.status_code == 422
    h = login(client, "vega", "1111")
    assert client.post("/tasks", headers=h, json={"crew_member_id": "CM-01", "title": "x" * 5, "due_at": due, "priority": "ROUTINE",
                                                  "completion_rule": {"kind": "VERIFICATION"}}).status_code == 403


def test_week_of_tasks_is_materialised(client):
    fs = login(client, "lindqvist", "3333")
    end = db.iso(db.now() + timedelta(days=7))
    tasks = client.get(f"/tasks?crew_member_id=CM-01&start={db.iso(db.now())}&end={end}", headers=fs).json()
    assert len({t["due_at"][:10] for t in tasks}) >= 7


def test_recreation_task_completed_by_crew_member(client):
    cmo = login(client, "okafor", "2222")
    due = db.iso(db.now() + timedelta(hours=2))
    t = client.post("/tasks", headers=cmo, json={"crew_member_id": "CM-01", "title": "Movie night", "due_at": due, "priority": "ROUTINE",
                                                 "completion_rule": {"kind": "ACTIVITY", "min_minutes": 30}}).json()
    assert t["task_type"] == "RECREATION" and t["category"] == "WELLBEING"
    assert client.post(f"/tasks/{t['id']}/activity", headers=cmo, json={"duration_min": 40}).status_code == 403
    h = login(client, "vega", "1111")
    short = client.post(f"/tasks/{t['id']}/activity", headers=h, json={"duration_min": 10}).json()
    assert not short["accepted"]
    assert client.post(f"/tasks/{t['id']}/activity", headers=h, json={"duration_min": 45, "note": "Watched a film"}).json()["accepted"]
    fs = login(client, "lindqvist", "3333")
    spec = {"name": "Recreation time", "schedule_type": "RECURRENT", "schedule": {"weekdays": [6, 7], "at": ["19:00"]},
            "completion_rule": {"kind": "ACTIVITY", "min_minutes": 60}, "reference": "Behavioral health plan", "reason": "Weekend downtime"}
    assert client.post("/crew/CM-01/care-plan", headers=fs, json=spec).status_code == 200


def test_future_weeks_are_generated_on_view(client):
    fs = login(client, "lindqvist", "3333")
    start = db.now() + timedelta(days=21)
    tasks = client.get(f"/tasks?crew_member_id=CM-01&start={db.iso(start)}&end={db.iso(start + timedelta(days=7))}", headers=fs).json()
    assert any(t["protocol_id"] == "sleep-log" for t in tasks)
