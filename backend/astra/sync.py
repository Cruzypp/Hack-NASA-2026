"""Store-and-forward replication from the onboard node to ground.

The outbox is written in the same transaction as each change, so the onboard
node keeps working through Loss of Signal (LOS). On Acquisition of Signal (AOS)
events are pushed in order; ground ingest is idempotent by event id, so a
crash between "ground stored it" and "onboard marked it" just resends safely.
"""
import sqlite3

from . import db
from .db import iso

GROUND_SCHEMA = """
CREATE TABLE IF NOT EXISTS received (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL
);
"""


def connect_ground(path: str) -> sqlite3.Connection:
    g = db.connect(path)
    g.executescript(GROUND_SCHEMA)
    return g


def link_up(conn) -> bool:
    return db.get_setting(conn, "ground_link", "LOS") == "AOS"


def ground_ingest(ground: sqlite3.Connection, evt: dict) -> None:
    ground.execute("INSERT OR IGNORE INTO received VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (evt["id"], evt["created_at"], evt["entity"], evt["entity_id"], evt["action"],
                    evt["payload_json"], iso(db.now())))


def push(conn, ground, transmit=ground_ingest, batch: int = 500) -> dict:
    """Send pending events in creation order. Stops at the first failure so
    ground never sees event N+1 before N."""
    if not link_up(conn):
        return {"link": "LOS", "sent": 0, "pending": pending(conn)}
    sent = 0
    for evt in db.rows(conn, "SELECT * FROM outbox WHERE synced_at IS NULL ORDER BY created_at, rowid LIMIT ?", batch):
        try:
            transmit(ground, evt)
        except Exception as e:  # link dropped mid-pass, ground refused, ...
            conn.execute("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?", (str(e)[:200], evt["id"]))
            return {"link": "AOS", "sent": sent, "pending": pending(conn), "error": str(e)}
        conn.execute("UPDATE outbox SET synced_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
                     (iso(db.now()), evt["id"]))
        sent += 1
    return {"link": "AOS", "sent": sent, "pending": pending(conn)}


def pending(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM outbox WHERE synced_at IS NULL").fetchone()[0]


def status(conn, ground) -> dict:
    last = db.one(conn, "SELECT MAX(synced_at) t FROM outbox")["t"]
    return {"link": db.get_setting(conn, "ground_link", "LOS"), "pending": pending(conn), "last_synced_at": last,
            "ground_received": ground.execute("SELECT COUNT(*) FROM received").fetchone()[0]}
