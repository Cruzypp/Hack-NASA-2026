"""Real-time alert notifications.

Every alert, whichever detector raised it, is picked up once (alerts.notified_at) and
fanned out to (1) connected consoles over WebSocket and (2) outbound webhooks.
Webhook deliveries are stored, signed and retried, so a slow or failing receiver
never loses an alert and never blocks the onboard node.

Configuration (environment):
  ASTRA_WEBHOOKS          optional, comma-separated URLs for other systems (e.g. ground). Slack and
                          Discord URLs get their native format; anything else receives signed JSON.
                          The primary channel is in-app: consoles get every alert over WebSocket.
  ASTRA_WEBHOOK_SECRET    HMAC-SHA256 key for the X-ASTRA-Signature header (generic JSON).
  ASTRA_WEBHOOK_DETAILS   "1" to include alert title and summary. Default "0": crew member,
                          category and severity only — health details stay inside ASTRA.
  ASTRA_PUBLIC_URL        console URL used for links in notifications.
"""
import asyncio
import hashlib
import hmac
import json
import os
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import urlparse

from . import db
from .db import iso

MAX_ATTEMPTS = 5


def config() -> dict:
    return {"urls": [u.strip() for u in os.environ.get("ASTRA_WEBHOOKS", "").split(",") if u.strip()],
            "secret": os.environ.get("ASTRA_WEBHOOK_SECRET", ""),
            "details": os.environ.get("ASTRA_WEBHOOK_DETAILS", "0") == "1",
            "public_url": os.environ.get("ASTRA_PUBLIC_URL", "http://localhost:3000").rstrip("/")}


def collect(conn) -> list[dict]:
    """New alerts since the last pass; marks them notified and queues one delivery per webhook."""
    cfg = config()
    out = []
    with db.tx(conn):
        for a in db.rows(conn, "SELECT * FROM alerts WHERE notified_at IS NULL ORDER BY created_at"):
            db.update(conn, "alerts", a["id"], {"notified_at": iso(db.now())})
            for url in cfg["urls"]:
                db.insert(conn, "webhook_deliveries", {"id": db.new_id("whd"), "alert_id": a["id"], "url": url,
                                                       "status": "PENDING", "attempts": 0, "next_at": iso(db.now())})
            a["explanation"] = json.loads(a.pop("explanation_json"))
            out.append(a)
    return out


def event(alert: dict) -> dict:
    """WebSocket payload for consoles (RBAC filtering happens in the hub)."""
    return {"type": "alert.new", "id": alert["id"], "crew_member_id": alert["crew_member_id"], "category": alert["category"],
            "severity": alert["severity"], "title": alert["title"], "summary": alert["explanation"].get("summary"),
            "created_at": alert["created_at"]}


def render(url: str, alert: dict, cfg: dict) -> tuple[bytes, dict]:
    """Body and headers for one receiver."""
    who = alert["crew_member_id"] or "station"
    link = f"{cfg['public_url']}/alerts"
    if cfg["details"]:
        headline = f"{alert['title']} ({who})"
        detail = alert["explanation"].get("summary") or ""
    else:
        headline = f"{alert['category'].title()} alert for {who} · {alert['severity'].lower()}"
        detail = "Open ASTRA to review."
    host = urlparse(url).hostname or ""
    text = f"🚨 ASTRA · {headline}\n{detail}\n{link}".strip()
    if host.endswith("discord.com") or host.endswith("discordapp.com"):
        return json.dumps({"content": text}).encode(), {"Content-Type": "application/json"}
    if host == "hooks.slack.com":
        return json.dumps({"text": text}).encode(), {"Content-Type": "application/json"}
    payload = {"event": "alert.created", "link": link,
               "alert": {k: alert[k] for k in ("id", "crew_member_id", "category", "type", "severity", "created_at")}}
    if cfg["details"]:
        payload["alert"].update(title=alert["title"], summary=alert["explanation"].get("summary"))
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if cfg["secret"]:
        headers["X-ASTRA-Signature"] = "sha256=" + hmac.new(cfg["secret"].encode(), body, hashlib.sha256).hexdigest()
    return body, headers


def _post(url: str, body: bytes, headers: dict) -> int:
    req = urllib.request.Request(url, data=body, headers={"User-Agent": "astra-health/0.1", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status


def due_deliveries(conn, at: datetime) -> list[dict]:
    return db.rows(conn, "SELECT d.*, a.explanation_json, a.crew_member_id, a.category, a.type, a.severity, a.title, a.created_at "
                         "FROM webhook_deliveries d JOIN alerts a ON a.id = d.alert_id "
                         "WHERE d.status = 'PENDING' AND d.next_at <= ? ORDER BY d.next_at LIMIT 20", iso(at))


async def deliver(conn, transport=_post) -> dict:
    """Send due webhook deliveries; exponential backoff, gives up after MAX_ATTEMPTS.
    The HTTP call runs in a worker thread; the database is only touched from the event loop."""
    cfg = config()
    sent = failed = 0
    for d in due_deliveries(conn, db.now()):
        alert = {**d, "id": d["alert_id"], "explanation": json.loads(d["explanation_json"])}
        body, headers = render(d["url"], alert, cfg)
        try:
            status = await asyncio.to_thread(transport, d["url"], body, headers)
            ok, err = 200 <= status < 300, f"HTTP {status}"
        except Exception as e:  # network down, DNS, timeout, 4xx/5xx raised by urllib
            ok, err = False, str(e)[:200]
        attempts = d["attempts"] + 1
        if ok:
            db.update(conn, "webhook_deliveries", d["id"], {"status": "SENT", "attempts": attempts, "sent_at": iso(db.now()),
                                                            "last_error": None})
            sent += 1
        else:
            db.update(conn, "webhook_deliveries", d["id"], {
                "status": "FAILED" if attempts >= MAX_ATTEMPTS else "PENDING", "attempts": attempts, "last_error": err,
                "next_at": iso(db.now() + timedelta(seconds=10 * 2 ** attempts))})
            failed += 1
    return {"sent": sent, "failed": failed}


def status(conn) -> dict:
    cfg = config()
    return {"webhooks": [{"host": urlparse(u).hostname, "format": _fmt(u)} for u in cfg["urls"]], "details": cfg["details"],
            "deliveries": db.rows(conn, "SELECT status, COUNT(*) n FROM webhook_deliveries GROUP BY status"),
            # Webhook URLs embed credentials (Slack/Discord tokens): only hostnames leave this module.
            "recent": [{**{k: r[k] for k in ("alert_id", "status", "attempts", "last_error", "sent_at")}, "host": urlparse(r["url"]).hostname}
                       for r in db.rows(conn, "SELECT * FROM webhook_deliveries ORDER BY rowid DESC LIMIT 10")]}


def _fmt(url: str) -> str:
    host = urlparse(url).hostname or ""
    return "discord" if "discord" in host else "slack" if host == "hooks.slack.com" else "json"
