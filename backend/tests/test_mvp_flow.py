"""The 10-step MVP demo, end to end through the HTTP API."""
import time
from datetime import timedelta

from conftest import login

from astra import protocols
from astra.db import parse


def wait_session(client, h, sid):
    for _ in range(200):
        s = next(x for x in client.get("/sessions", headers=h).json() if x["id"] == sid)
        if s["status"] != "RUNNING":
            return s
        time.sleep(0.02)
    raise AssertionError("session never finished")


def test_mvp_flow(client):
    # 1. Astronaut signs in. Link starts in LOS.
    assert client.post("/auth/login", json={"username": "vega", "pin": "0000"}).status_code == 401
    h = login(client, "vega", "1111")
    assert client.get("/sync", headers=h).json()["link"] == "LOS"

    # 2. Daily plan.
    dash = client.get("/dashboard", headers=h).json()
    assert dash["missionDay"] == 42
    exercise = next(t for t in dash["tasks"] if t["task_type"] == "EXERCISE")
    assert exercise["status"] in ("PENDING", "OVERDUE")

    # 3. Exercise reminder. Tick at a fixed point inside the lead window so the
    #    test doesn't depend on wall-clock time.
    protocols.tick(client.app_state.conn, parse(exercise["due_at"]) - timedelta(minutes=10))
    reminders = client.get("/dashboard", headers=h).json()["reminders"]
    assert any(r["task_id"] == exercise["id"] for r in reminders)

    # 4. Exercise session with simulated telemetry completes the task with evidence.
    sid = client.post("/sessions", headers=h, json={"task_id": exercise["id"]}).json()["id"]
    s = wait_session(client, h, sid)
    assert s["status"] == "COMPLETED" and s["summary"]["valid_fraction"] < 1  # artefact recorded, still acceptable
    t = next(t for t in client.get("/tasks", headers=h).json() if t["id"] == exercise["id"])
    assert t["status"] == "COMPLETED" and t["evidenceIds"]

    # 5–8. Manual resting HR right after exercise: deviation with context + follow-up.
    bad = client.post("/measurements", headers=h, json={"metric": "resting_hr", "value": 400})
    assert bad.status_code == 422
    r = client.post("/measurements", headers=h, json={"metric": "resting_hr", "value": 84}).json()
    assert r["completion"]["accepted"]
    a = r["assessment"]
    assert a["status"] == "DEVIATION" and a["z"] > 3
    factors = {c["factor"] for c in a["context"]}
    assert {"post_exercise", "short_sleep"} <= factors
    assert a["advisory_model"]["status"] == "RAN"
    hist = client.get("/measurements?metric=resting_hr", headers=h).json()
    assert hist[0]["value"] == 84  # 6. history updated

    # Astronaut cannot verify or resolve; ops cannot see medical alerts.
    assert client.post(f"/tasks/{a['follow_up_task_id']}/verify", headers=h, json={"note": "fine"}).status_code == 403
    ops = login(client, "ops", "4444")
    assert all(x["category"] == "OPERATIONAL" for x in client.get("/alerts", headers=ops).json())
    assert client.get("/measurements?crew_member_id=CM-01", headers=ops).status_code == 403

    # 9. CMO verifies; the alert is resolved with an audit trail.
    cmo = login(client, "okafor", "2222")
    assert client.post(f"/alerts/{a['alert_id']}/resolve", headers=cmo, json={"note": "x" * 5}).status_code == 409
    v = client.post(f"/tasks/{a['follow_up_task_id']}/verify", headers=cmo,
                    json={"note": "Repeated at rest after 70 min: 63 bpm. No further action."}).json()
    assert v["accepted"]
    alert = next(x for x in client.get("/alerts", headers=cmo).json() if x["id"] == a["alert_id"])
    assert alert["status"] == "RESOLVED" and alert["resolved_by"] == "usr_okafor"
    assert any(e["action"] == "ALERT_RESOLVED" for e in client.get("/audit", headers=cmo).json())

    # 10. AOS: everything recorded during LOS reaches ground exactly once.
    before = client.get("/sync", headers=h).json()
    assert before["pending"] > 0
    client.post("/sync/link", headers=h, json={"state": "AOS"})
    after = client.get("/sync", headers=h).json()
    assert after["pending"] == 0 and after["ground_received"] > before["ground_received"]


def test_sensor_fault_opens_incident_and_allows_manual_log(client):
    h = login(client, "vega", "1111")
    ex = next(t for t in client.get("/dashboard", headers=h).json()["tasks"] if t["task_type"] == "EXERCISE")
    sid = client.post("/sessions", headers=h, json={"task_id": ex["id"], "simulate_fault": True}).json()["id"]
    assert wait_session(client, h, sid)["status"] == "FAULTED"
    t = next(t for t in client.get("/tasks", headers=h).json() if t["id"] == ex["id"])
    assert t["status"] != "COMPLETED" and t["manualAllowed"]
    alerts = client.get("/alerts", headers=h).json()
    assert any(x["type"] == "SENSOR_FAULT" and x["category"] == "OPERATIONAL" for x in alerts)
    assert client.post("/sessions", headers=h, json={"task_id": ex["id"]}).status_code == 409  # device in FAULT
    r = client.post(f"/tasks/{ex['id']}/manual-log", headers=h, json={"duration_min": 30, "rpe": 13}).json()
    assert r["accepted"]


def test_eva_triggers_dosimeter_checks(client):
    cmo = login(client, "okafor", "2222")
    r = client.post("/eva", headers=cmo, json={"crew_member_id": "CM-01", "planned_start": "2030-01-01T10:00:00Z",
                                               "planned_end": "2030-01-01T16:00:00Z"}).json()
    assert len(r["task_ids"]) == 2
    h = login(client, "vega", "1111")
    res = client.post(f"/tasks/{r['task_ids'][0]}/dosimeter-check", headers=h).json()
    assert res["accepted"] and res["reading"]["eva_id"] == r["eva"]["id"]
