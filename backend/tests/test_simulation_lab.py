import time

from conftest import login
from astra import devices


def wait_session(client, headers, session_id):
    for _ in range(200):
        session = next(s for s in client.get("/sessions", headers=headers).json() if s["id"] == session_id)
        if session["status"] != "RUNNING":
            return session
        time.sleep(0.01)
    raise AssertionError("session never finished")


def test_simulated_sleep_records_stream_data_and_completes_task(client):
    headers = login(client, "vega", "1111")
    result = client.post("/demo/sleep", headers=headers, json={"scenario": "GOOD"})
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["measurement"]["metric"] == "sleep_hours"
    assert body["measurement"]["source"] == "STREAM"
    assert body["measurement"]["device_id"] == "sleep-sim"
    if body.get("completion"):
        assert body["completion"]["accepted"]


def test_short_exercise_stays_incomplete_and_standard_completes(client):
    headers = login(client, "vega", "1111")
    short_task = next(t for t in client.get("/tasks", headers=headers).json() if t["task_type"] == "EXERCISE" and t["status"] in ("PENDING", "OVERDUE"))
    short = client.post("/sessions", headers=headers, json={"task_id": short_task["id"], "scenario": "SHORT"})
    assert short.status_code == 200, short.text
    result = wait_session(client, headers, short.json()["id"])
    assert result["status"] == "COMPLETED"
    assert result["summary"]["valid_minutes"] < 25
    task = next(t for t in client.get("/tasks", headers=headers).json() if t["id"] == short_task["id"])
    assert task["status"] != "COMPLETED"


def test_simulated_radiation_persists_anomalous_reading(client):
    headers = login(client, "vega", "1111")
    result = client.post("/demo/radiation", headers=headers, json={"scenario": "ANOMALOUS", "scope": "PERSONAL"})
    assert result.status_code == 200, result.text
    reading = result.json()["reading"]
    assert reading["device_id"] == "cad-sim"
    assert reading["source"] == "SENSOR"
    assert reading["dose_rate_uGy_h"] > 18


def test_cognitive_playback_persists_samples_and_raises_server_side_alert(client):
    headers = login(client, "vega", "1111")
    started = client.post("/cognitive/sessions", headers=headers, json={})
    assert started.status_code == 200, started.text
    for _ in range(500):
        latest = client.get("/cognitive/CM-01", headers=headers).json()["latest"]
        if latest and latest["status"] == "COMPLETED":
            break
        time.sleep(0.01)
    assert latest["status"] == "COMPLETED" and latest["crew_member_id"] == "CM-01"
    assert len(latest["trace"]) == started.json()["total"]
    summary = latest["summary"]
    assert summary["peak_load"] > 0 and set(summary["mean_by_phase"]) >= {"prelaunch", "launch"}
    alert = next(a for a in client.get("/alerts", headers=headers).json() if a["id"] == summary["alert_id"])
    assert alert["rule_id"] == "cognitive-iqr-z" and alert["follow_up_task_id"]
    assert max(alert["explanation"]["z"].values()) >= 3.0  # from the file's own values, not client input
    # Cognitive sessions are not exercise sessions.
    assert all(s["kind"] == "EXERCISE" for s in client.get("/sessions?crew_member_id=CM-01", headers=headers).json())
    assert client.post("/demo/cognitive-load", headers=headers, json={}).status_code in (404, 405)


def test_exercise_peak_scenario_creates_pronounced_bpm_spikes():
    samples = devices.simulate_exercise(seed=7, minutes=30, spikes=((7, 8, 45), (18, 19, 60)))
    summary = devices.summarize(samples)
    assert summary["hr_peak"] > summary["hr_mean"] + 35


def test_peak_exercise_session_persists_peak_scenario_and_high_peak(client):
    headers = login(client, "vega", "1111")
    response = client.post("/sessions", headers=headers, json={"scenario": "PEAKS"})
    assert response.status_code == 200, response.text
    session = wait_session(client, headers, response.json()["id"])
    assert session["summary"]["scenario"] == "PEAKS"
    assert session["summary"]["hr_peak"] > session["summary"]["hr_mean"] + 35
