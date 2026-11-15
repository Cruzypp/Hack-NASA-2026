"""Real-time notifications, outbound webhooks and the inbound device webhook."""
import asyncio
import json

from conftest import login

from astra import db, notify

ALERT = {"id": "alr_x", "crew_member_id": "CM-01", "category": "MEDICAL", "type": "PHYSIO_DEVIATION", "severity": "HIGH",
         "title": "Resting heart rate outside personal baseline", "created_at": "2026-11-15T08:00:00Z",
         "explanation": {"summary": "Resting heart rate 84 bpm is 12.3 robust SD above baseline"}}


def test_render_per_receiver_and_privacy_by_default():
    cfg = {"secret": "s3cret", "details": False, "public_url": "https://astra.example"}
    body, _ = notify.render("https://discord.com/api/webhooks/1/x", ALERT, cfg)
    assert "content" in json.loads(body) and "heart" not in json.loads(body)["content"].lower()
    body, _ = notify.render("https://hooks.slack.com/services/x", {**ALERT}, {**cfg, "details": True})
    assert "84 bpm" in json.loads(body)["text"]
    body, h = notify.render("https://receiver.example/hook", ALERT, cfg)
    import hashlib, hmac
    assert h["X-ASTRA-Signature"] == "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert "summary" not in json.loads(body)["alert"]


def test_alerts_notified_once_and_webhooks_retried(client, monkeypatch):
    monkeypatch.setenv("ASTRA_WEBHOOKS", "https://hooks.slack.com/services/T/B/x,https://receiver.example/hook")
    conn = client.app_state.conn
    assert notify.collect(conn) == []  # seeded alerts are not news
    from astra import protocols
    protocols.raise_alert(conn, "CM-01", "MEDICAL", "PHYSIO_DEVIATION", "HIGH", "Test alert", {"summary": "x"})
    assert len(notify.collect(conn)) == 1 and notify.collect(conn) == []
    assert len(db.rows(conn, "SELECT 1 FROM webhook_deliveries WHERE status = 'PENDING'")) == 2

    calls = []

    def flaky(url, body, headers):
        calls.append(url)
        if "receiver" in url:
            raise ConnectionError("receiver down")
        return 200
    r = asyncio.run(notify.deliver(conn, flaky))
    assert r == {"sent": 1, "failed": 1}
    pending = db.one(conn, "SELECT * FROM webhook_deliveries WHERE status = 'PENDING'")
    assert pending["attempts"] == 1 and "receiver down" in pending["last_error"] and pending["next_at"] > db.iso(db.now())
    db.update(conn, "webhook_deliveries", pending["id"], {"attempts": notify.MAX_ATTEMPTS - 1, "next_at": "2000-01-01T00:00:00Z"})
    asyncio.run(notify.deliver(conn, flaky))
    assert db.one(conn, "SELECT status FROM webhook_deliveries WHERE id = ?", pending["id"])["status"] == "FAILED"
    st = notify.status(conn)
    assert all("url" not in d for d in st["recent"]) and {w["format"] for w in st["webhooks"]} == {"slack", "json"}


def test_device_webhook_to_alert_to_realtime_event(client, monkeypatch):
    monkeypatch.setenv("ASTRA_DEVICE_KEYS", "bio-monitor-sim:dev-key")
    body = {"crew_member_id": "CM-01", "metric": "resting_hr", "value": 92}
    assert client.post("/webhooks/measurements", json=body).status_code == 401
    assert client.post("/webhooks/measurements", json=body, headers={"X-ASTRA-Device": "bio-monitor-sim",
                                                                     "Authorization": "Bearer nope"}).status_code == 401
    cmo = login(client, "okafor", "2222")
    token = cmo["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/ws?token={token}") as ws:
        ws.receive_json()  # initial sync state
        r = client.post("/webhooks/measurements", json=body,
                        headers={"X-ASTRA-Device": "bio-monitor-sim", "Authorization": "Bearer dev-key"}).json()
        assert r["status"] == "DEVIATION" and r["alert_id"]
        conn = client.app_state.conn
        m = db.one(conn, "SELECT * FROM measurements WHERE id = ?", r["measurement_id"])
        assert m["source"] == "STREAM" and m["device_id"] == "bio-monitor-sim"
        assert db.one(conn, "SELECT severity FROM alerts WHERE id = ?", r["alert_id"])["severity"] == "HIGH"  # z ≥ 5
        client.portal.call(client.app_state.notify_once)
        events = []
        while not any(e.get("type") == "alert.new" for e in events):
            events.append(ws.receive_json())
        e = next(e for e in events if e["type"] == "alert.new")
        assert e["id"] == r["alert_id"] and e["category"] == "MEDICAL"
    # Mission ops never receives medical alert events.
    ops = login(client, "ops", "4444")
    assert client.get("/notifications", headers=ops).status_code == 200


def test_imported_values_are_checked_against_baseline(client):
    h = login(client, "vega", "1111")
    when = db.iso(db.now())
    r = client.post("/measurements/import", headers=h, json={"csv": f"metric,value,measured_at\nresting_hr,88,{when}\n"}).json()
    assert r["accepted"] and r["deviations"] == 1
