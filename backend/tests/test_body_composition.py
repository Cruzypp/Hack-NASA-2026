from conftest import login


def test_seed_history_has_reference_and_no_alert(client):
    h = login(client, "vega", "1111")
    r = client.get("/body-composition/CM-01", headers=h).json()
    phases = {a["phase"] for a in r["assessments"]}
    assert {"PREFLIGHT", "INFLIGHT"} <= phases
    assert r["reference"]["n"] == 2 and r["reference"]["method"] == "BIA"
    dxa = next(a for a in r["assessments"] if a["method"] == "DXA")
    assert dxa["id"] not in r["reference"]["ids"]  # methods are never mixed
    assert dxa["evaluation"]["status"] == "REFERENCE"
    assert not any(a["alert_id"] for a in r["assessments"])


def test_leg_atrophy_raises_alert_and_follow_up(client):
    h = login(client, "vega", "1111")
    a = client.post("/demo/body-composition", headers=h, json={"scenario": "LEG_ATROPHY"}).json()
    ev = a["evaluation"]
    assert ev["status"] == "ACTION"
    assert ev["segments"]["left_leg"]["pct"] < -8
    codes = {f["code"] for f in ev["findings"]}
    assert "LOWER_LIMB_LEAN_LOSS" in codes
    alert = next(x for x in client.get("/alerts", headers=h).json() if x["id"] == a["alert_id"])
    assert alert["type"] == "BODY_COMPOSITION_FINDINGS" and alert["follow_up_task_id"]


def test_stable_and_fluid_shift(client):
    h = login(client, "okafor", "2222")
    stable = client.post("/demo/body-composition", headers=h, json={"scenario": "STABLE", "crew_member_id": "CM-01"}).json()
    assert stable["crew_member_id"] == "CM-01"
    assert stable["evaluation"]["status"] in ("WITHIN_REFERENCE", "WATCH") and not stable["alert_id"]
    fluid = client.post("/demo/body-composition", headers=h, json={"scenario": "FLUID_SHIFT", "crew_member_id": "CM-01"}).json()
    assert fluid["quality"] == "DEGRADED"
    assert any(f["code"] == "FLUID_SHIFT" for f in fluid["evaluation"]["findings"])


def test_ops_cannot_read_body_composition(client):
    h = login(client, "ops", "4444")
    assert client.get("/body-composition/CM-01", headers=h).status_code == 403
    assert client.post("/demo/body-composition", headers=h, json={"scenario": "STABLE"}).status_code == 403


def test_scan_feeds_body_mass_metric_and_context(client):
    h = login(client, "vega", "1111")
    a = client.post("/demo/body-composition", headers=h, json={"scenario": "LEG_ATROPHY"}).json()
    m = a["body_mass"]["measurement"]
    assert m["metric"] == "body_mass" and m["value"] == a["values"]["body_mass_kg"]
    assert m["id"] in {x["id"] for x in client.get("/measurements?metric=body_mass", headers=h).json()}
    ctx = a["evaluation"]["context"]
    assert ctx["exercise_scheduled"] > 0 and ctx["exercise_adherence"] is not None


def test_medical_sleep_simulation_targets_crew_in_view(client):
    h = login(client, "okafor", "2222")  # CMO is also crew member CM-02
    r = client.post("/demo/sleep", headers=h, json={"scenario": "BAD", "crew_member_id": "CM-01"}).json()
    assert r["measurement"]["crew_member_id"] == "CM-01"
