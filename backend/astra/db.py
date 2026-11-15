"""SQLite storage for the onboard ASTRA node.

Every mutation goes through `write()`, which records an audit entry and an
outbox event in the same transaction, so nothing changes without a trace and
nothing is lost while the ground link is down.
"""
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ASTRONAUT','CREW_MEDICAL_OFFICER','FLIGHT_SURGEON','MISSION_OPERATOR')),
  crew_member_id TEXT, pin_salt BLOB NOT NULL, pin_hash BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

-- Protocol engine. A template is the stable identity; versions carry the rules
-- and the provenance every frequency must have.
CREATE TABLE IF NOT EXISTS protocol_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, task_type TEXT NOT NULL, category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS protocol_versions (
  id TEXT PRIMARY KEY, protocol_id TEXT NOT NULL REFERENCES protocol_templates(id),
  version TEXT NOT NULL, schedule_type TEXT NOT NULL
    CHECK (schedule_type IN ('RECURRENT','MISSION_RELATIVE','EVENT_TRIGGERED','CLINICIAN_ORDERED')),
  schedule_json TEXT NOT NULL, completion_rule_json TEXT NOT NULL, reminder_json TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('ROUTINE','HIGH','CRITICAL')),
  source TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('NASA_REFERENCE','ASTRA_DEMO_PLACEHOLDER','CLINICAL_DECISION')),
  population TEXT NOT NULL, approved_by TEXT NOT NULL, effective_from TEXT NOT NULL,
  supersedes_id TEXT, change_reason TEXT,
  UNIQUE (protocol_id, version)
);
CREATE TABLE IF NOT EXISTS protocol_assignments (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id),
  assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  ended_at TEXT, ended_by TEXT, end_reason TEXT
);

-- Output of automated reviews (e.g. weekly deviation search), kept as task evidence.
CREATE TABLE IF NOT EXISTS analysis_reports (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, metric TEXT NOT NULL,
  window_from TEXT NOT NULL, window_to TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Clinical logbook. Entries are never edited: corrections and follow-ups are addenda (amends_id).
CREATE TABLE IF NOT EXISTS clinical_log (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, author_id TEXT NOT NULL, author_role TEXT NOT NULL,
  author_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('OBSERVATION','CONSULTATION','PLAN_CHANGE','COMMUNICATION','AUTOMATED','OTHER')),
  body TEXT NOT NULL, linked_type TEXT, linked_id TEXT, shared_with_crew INTEGER NOT NULL DEFAULT 0,
  amends_id TEXT REFERENCES clinical_log(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clinical_log_crew ON clinical_log (crew_member_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, protocol_id TEXT, protocol_version_id TEXT,
  title TEXT NOT NULL, task_type TEXT NOT NULL, category TEXT NOT NULL, schedule_type TEXT NOT NULL,
  due_at TEXT NOT NULL, priority TEXT NOT NULL, assigned_by TEXT NOT NULL,
  completion_criteria TEXT NOT NULL, reminder_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','OVERDUE','COMPLETED','CANCELLED')),
  completed_at TEXT, escalated INTEGER NOT NULL DEFAULT 0, source_alert_id TEXT, note TEXT,
  UNIQUE (protocol_version_id, crew_member_id, due_at)
);
CREATE TABLE IF NOT EXISTS task_evidence (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
  ref_id TEXT NOT NULL, accepted INTEGER NOT NULL, reasons TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
  created_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE (task_id, kind)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  integration TEXT NOT NULL CHECK (integration IN ('SIMULATED','NOT_INTEGRATED')),
  status TEXT NOT NULL, last_seen TEXT, note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sensor_sessions (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, device_id TEXT NOT NULL, task_id TEXT,
  kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAULTED')),
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  session_id TEXT NOT NULL REFERENCES sensor_sessions(id), t TEXT NOT NULL,
  metric TEXT NOT NULL, value REAL, quality TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL,
  unit TEXT NOT NULL, measured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('MANUAL','SENSOR_SESSION','STREAM','IMPORT')),
  device_id TEXT, session_id TEXT,
  quality TEXT NOT NULL CHECK (quality IN ('GOOD','DEGRADED','INVALID')),
  entered_by TEXT NOT NULL, supersedes_id TEXT, correction_reason TEXT, superseded INTEGER NOT NULL DEFAULT 0,
  context_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS measurements_lookup ON measurements (crew_member_id, metric, measured_at);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, crew_member_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('MEDICAL','OPERATIONAL')),
  type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, explanation_json TEXT NOT NULL,
  rule_id TEXT, rule_version TEXT, status TEXT NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  created_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT, resolution_note TEXT, follow_up_task_id TEXT,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS eva_events (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, planned_start TEXT NOT NULL, planned_end TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS radiation_readings (
  id TEXT PRIMARY KEY, crew_member_id TEXT, device_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('PERSONAL','AREA')),
  dose_rate_uGy_h REAL NOT NULL, cumulative_uGy REAL, measured_at TEXT NOT NULL, eva_id TEXT,
  source TEXT NOT NULL DEFAULT 'SENSOR' CHECK (source IN ('SENSOR','MANUAL')), entered_by TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS radiation_lookup ON radiation_readings (scope, crew_member_id, measured_at);

-- Body composition assessments (BIA/DXA/MRI). Segmental lean mass in segments_json;
-- evaluation_json holds the rule-based comparison with the same-method preflight reference.
CREATE TABLE IF NOT EXISTS body_composition (
  id TEXT PRIMARY KEY, crew_member_id TEXT NOT NULL, measured_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PREFLIGHT','INFLIGHT','POSTFLIGHT')), mission_day INTEGER,
  method TEXT NOT NULL CHECK (method IN ('BIA','DXA','MRI','OTHER')), device TEXT NOT NULL,
  values_json TEXT NOT NULL, segments_json TEXT NOT NULL, conditions_json TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('GOOD','DEGRADED','INVALID')),
  source TEXT NOT NULL CHECK (source IN ('SEED','SIMULATED','MANUAL','IMPORT')), scenario TEXT,
  evaluation_json TEXT NOT NULL, alert_id TEXT, entered_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS body_composition_crew ON body_composition (crew_member_id, measured_at);

-- Outbound webhook deliveries for alerts (retried with backoff).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES alerts(id), url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED')), attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL, sent_at TEXT, last_error TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL,
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, payload_json TEXT NOT NULL, synced_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
"""


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def connect(path: str) -> sqlite3.Connection:
    fresh = path != ":memory:" and not os.path.exists(path)
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    if fresh:
        # Health data at rest: owner-only file. ponytail: no encryption at rest,
        # swap to SQLCipher when the node runs on shared hardware.
        os.chmod(path, 0o600)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _add_columns(conn, table: str, columns: tuple[tuple[str, str], ...]) -> None:
    have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    for col, ddl in columns:
        if col not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def _migrate(conn) -> None:
    """Migrations for databases created by earlier versions."""
    _add_columns(conn, "protocol_assignments", (("ended_at", "TEXT"), ("ended_by", "TEXT"), ("end_reason", "TEXT")))
    if "notified_at" not in {r["name"] for r in conn.execute("PRAGMA table_info(alerts)")}:
        conn.execute("ALTER TABLE alerts ADD COLUMN notified_at TEXT")
        conn.execute("UPDATE alerts SET notified_at = created_at")  # existing alerts are old news: don't re-notify them
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'protocol_versions'").fetchone()[0]
    if "CLINICAL_DECISION" not in sql:
        # SQLite cannot alter a CHECK constraint: rebuild the table (documented 12-step procedure).
        new_sql = SCHEMA[SCHEMA.index("CREATE TABLE IF NOT EXISTS protocol_versions"):]
        new_sql = new_sql[:new_sql.index(");") + 2].replace("IF NOT EXISTS protocol_versions", "protocol_versions_new")
        old_cols = [r["name"] for r in conn.execute("PRAGMA table_info(protocol_versions)")]
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.executescript(f"""BEGIN;
            {new_sql}
            INSERT INTO protocol_versions_new ({', '.join(old_cols)}) SELECT {', '.join(old_cols)} FROM protocol_versions;
            DROP TABLE protocol_versions;
            ALTER TABLE protocol_versions_new RENAME TO protocol_versions;
            COMMIT;""")
        conn.execute("PRAGMA foreign_keys = ON")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(radiation_readings)")}
    for col, ddl in (("source", "TEXT NOT NULL DEFAULT 'SENSOR'"), ("entered_by", "TEXT"), ("note", "TEXT")):
        if col not in cols:
            conn.execute(f"ALTER TABLE radiation_readings ADD COLUMN {col} {ddl}")


@contextmanager
def tx(conn):
    """One transaction; nested calls join the outer one. Endpoints are async and
    run on the single event-loop thread, so one shared connection is safe."""
    if conn.in_transaction:
        yield
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def rows(conn, sql, *args) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def one(conn, sql, *args) -> dict | None:
    r = conn.execute(sql, args).fetchone()
    return dict(r) if r else None


def insert(conn, table: str, record: dict) -> None:
    cols = ", ".join(record)
    marks = ", ".join("?" for _ in record)
    conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(record.values()))


def update(conn, table: str, id_: str, fields: dict) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*fields.values(), id_))


class Actor:
    """Who is doing something. System automation is an actor too."""

    def __init__(self, id: str, role: str, crew_member_id: str | None = None, name: str = ""):
        self.id, self.role, self.crew_member_id, self.name = id, role, crew_member_id, name


SYSTEM = Actor("system", "SYSTEM", name="ASTRA automation")


def record(conn, actor: Actor, action: str, entity: str, entity_id: str, payload: dict, sync: bool = True) -> None:
    """Audit + outbox for a change already applied inside the current transaction."""
    at = iso(now())
    body = json.dumps(payload, default=str)
    insert(conn, "audit_log", {"at": at, "actor_id": actor.id, "actor_role": actor.role, "action": action,
                               "entity": entity, "entity_id": entity_id, "detail_json": body})
    if sync:
        insert(conn, "outbox", {"id": new_id("evt"), "created_at": at, "entity": entity, "entity_id": entity_id,
                                "action": action, "payload_json": body})


def get_setting(conn, key: str, default: str | None = None) -> str | None:
    r = one(conn, "SELECT value FROM settings WHERE key = ?", key)
    return r["value"] if r else default


def set_setting(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, value))
