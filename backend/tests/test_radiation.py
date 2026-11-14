from datetime import datetime, timedelta, timezone

from conftest import login

from astra import db, devices


def test_manual_radiation_entry_rules(client):
    h = login(client, "vega", "1111")
    summary = client.get("/radiation/CM-01", headers=h).json()
    latest = summary["personal"]["latest"]
    assert latest and latest["source"] == "SENSOR"  # seeded continuous dosimetry
    assert summary["personal"]["window_dose_uGy"] > 0

    # Cumulative dose cannot go backwards.
    r = client.post("/radiation/readings", headers=h, json={"scope": "PERSONAL", "dose_rate_uGy_h": 18,
                                                           "cumulative_uGy": latest["cumulative_uGy"] - 50})
    assert r.status_code == 422 and "below the previous reading" in r.json()["detail"]

    ok = client.post("/radiation/readings", headers=h, json={"scope": "PERSONAL", "dose_rate_uGy_h": 19.2,
                                                            "cumulative_uGy": latest["cumulative_uGy"] + 5,
                                                            "device_id": "passive-dosimeter", "note": "readout"}).json()
    assert ok["source"] == "MANUAL" and ok["crew_member_id"] == "CM-01"
    assert client.get("/radiation/CM-01", headers=h).json()["personal"]["latest"]["id"] == ok["id"]

    # Ops may log environmental (area) data but never personal dose.
    ops = login(client, "ops", "4444")
    assert client.post("/radiation/readings", headers=ops, json={"scope": "AREA", "dose_rate_uGy_h": 15}).status_code == 200
    assert client.post("/radiation/readings", headers=ops, json={"scope": "PERSONAL", "dose_rate_uGy_h": 15,
                                                                "crew_member_id": "CM-01"}).status_code == 403
    # Astronauts cannot write another crew member's dose.
    assert client.post("/radiation/readings", headers=h, json={"scope": "PERSONAL", "dose_rate_uGy_h": 15,
                                                              "crew_member_id": "CM-02"}).status_code == 403


def test_continuous_sampling_integrates_dose_and_tags_eva(tmp_path):
    conn = db.connect(str(tmp_path / "a.db"))
    db.set_setting(conn, "mission_start", "2026-01-01T00:00:00Z")
    db.insert(conn, "devices", {"id": "cad-sim", "name": "CAD", "kind": "personal_dosimeter", "integration": "SIMULATED",
                                "status": "ONLINE", "note": ""})
    db.insert(conn, "devices", {"id": "rem-sim", "name": "REM", "kind": "area_radiation", "integration": "SIMULATED",
                                "status": "ONLINE", "note": ""})
    t0 = datetime(2026, 1, 10, 12, tzinfo=timezone.utc)
    db.insert(conn, "eva_events", {"id": "eva_1", "crew_member_id": "CM-01",
                                   "planned_start": db.iso(t0 + timedelta(minutes=20)), "planned_end": db.iso(t0 + timedelta(hours=2))})
    assert devices.sample_dosimetry(conn, ["CM-01"], t0) == 2          # personal + area
    assert devices.sample_dosimetry(conn, ["CM-01"], t0 + timedelta(minutes=5)) == 0  # inside the interval
    devices.sample_dosimetry(conn, ["CM-01"], t0 + timedelta(minutes=30))
    a, b = db.rows(conn, "SELECT * FROM radiation_readings WHERE scope='PERSONAL' ORDER BY measured_at")
    assert b["cumulative_uGy"] > a["cumulative_uGy"]                  # integrated, never decreasing
    # A manual rate-only reading must not reset the integrated cumulative dose.
    devices.store_reading(conn, db.SYSTEM, "PERSONAL", "CM-01", "manual", 20, None, t0 + timedelta(minutes=40), source="MANUAL")
    devices.sample_dosimetry(conn, ["CM-01"], t0 + timedelta(minutes=60))
    c = db.rows(conn, "SELECT * FROM radiation_readings WHERE scope='PERSONAL' ORDER BY measured_at")[-1]
    assert c["cumulative_uGy"] > b["cumulative_uGy"]
    assert a["eva_id"] is None and b["eva_id"] == "eva_1"
    s = devices.radiation_summary(conn, "CM-01", t0 + timedelta(hours=1))
    assert s["eva"][0]["readings"] == 2 and s["eva"][0]["dose_uGy"] == round(c["cumulative_uGy"] - b["cumulative_uGy"], 1)
    assert s["area"]["latest"]["scope"] == "AREA"
