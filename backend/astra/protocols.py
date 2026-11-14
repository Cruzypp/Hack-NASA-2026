"""Protocol engine: turns approved protocol versions into scheduled tasks,
decides completion from evidence, and drives reminders / escalation.

ASTRA never invents a frequency: every task comes from a ProtocolVersion that
names its source, population, approver and effective date, or from an explicit
clinician order.
"""
import json
from datetime import datetime, timedelta, time

from . import db
from .db import Actor, SYSTEM, iso, parse

PLAN_HORIZON_DAYS = 8  # tasks are materialised this far ahead (enough for a week calendar)
DEFAULT_REMINDER = {"lead_min": 30, "overdue_after_min": 60, "escalate_after_min": 120}


# ---------------------------------------------------------------- scheduling

def mission_start(conn) -> datetime:
    return parse(db.get_setting(conn, "mission_start"))


def mission_day(conn, at: datetime) -> int:
    """Mission Day 1 is the launch day."""
    return (at.date() - mission_start(conn).date()).days + 1


def occurrences(schedule_type: str, schedule: dict, start: datetime, end: datetime, launch: datetime) -> list[datetime]:
    """Due times for a RECURRENT or MISSION_RELATIVE schedule within [start, end)."""
    out = []
    day = start.date()
    while day < end.date() + timedelta(days=1):
        md = (day - launch.date()).days + 1
        if schedule_type == "RECURRENT" and "weekdays" in schedule:
            hit = md >= 1 and day.isoweekday() in schedule["weekdays"]  # 1 = Monday … 7 = Sunday
            times = schedule["at"]
        elif schedule_type == "RECURRENT":
            hit = md >= 1 and (md - 1) % schedule["every_days"] == 0
            times = schedule["at"]
        elif schedule_type == "MISSION_RELATIVE":
            hit = md in schedule["mission_days"]
            times = [schedule["at"]]
        else:
            return []
        if hit:
            for hhmm in times:
                due = datetime.combine(day, time.fromisoformat(hhmm), tzinfo=start.tzinfo)
                if start <= due < end:
                    out.append(due)
        day += timedelta(days=1)
    return out


def _task_from_version(v: dict, crew_member_id: str, assigned_by: str, due: datetime, title: str | None = None) -> dict:
    return {
        "id": db.new_id("tsk"), "crew_member_id": crew_member_id, "protocol_id": v["protocol_id"],
        "protocol_version_id": v["id"], "title": title or v["name"], "task_type": v["task_type"],
        "category": v["category"], "schedule_type": v["schedule_type"], "due_at": iso(due),
        "priority": v["priority"], "assigned_by": assigned_by, "completion_criteria": v["completion_rule_json"],
        "reminder_json": v["reminder_json"], "status": "PENDING",
    }


def _versions_for(conn, crew_member_id: str, schedule_type: str) -> list[dict]:
    return db.rows(conn, """
        SELECT v.*, t.name, t.task_type, t.category, a.assigned_by FROM protocol_assignments a
        JOIN protocol_versions v ON v.id = a.protocol_version_id
        JOIN protocol_templates t ON t.id = v.protocol_id
        WHERE a.crew_member_id = ? AND a.active = 1 AND v.schedule_type = ?""", crew_member_id, schedule_type)


def _insert_task(conn, task: dict, actor: Actor) -> bool:
    cur = conn.execute(
        f"INSERT OR IGNORE INTO tasks ({', '.join(task)}) VALUES ({', '.join('?' for _ in task)})",
        tuple(task.values()))
    if cur.rowcount:
        db.record(conn, actor, "TASK_SCHEDULED", "task", task["id"], task)
    return bool(cur.rowcount)


def generate_tasks(conn, crew_member_id: str, start: datetime, end: datetime) -> int:
    """Materialise RECURRENT and MISSION_RELATIVE tasks. Idempotent."""
    launch = mission_start(conn)
    created = 0
    with db.tx(conn):
        for st in ("RECURRENT", "MISSION_RELATIVE"):
            for v in _versions_for(conn, crew_member_id, st):
                effective = parse(v["effective_from"])
                if effective > end:
                    continue
                # A version only schedules from its effective time onward (a midday revision creates no past tasks).
                for due in occurrences(st, json.loads(v["schedule_json"]), max(start, effective), end, launch):
                    created += _insert_task(conn, _task_from_version(v, crew_member_id, v["assigned_by"], due), SYSTEM)
    return created


def trigger_event(conn, actor: Actor, crew_member_id: str, event: str, anchors: dict[str, datetime], label: str) -> list[str]:
    """Create EVENT_TRIGGERED tasks, e.g. dosimeter checks around an EVA."""
    ids = []
    with db.tx(conn):
        for v in _versions_for(conn, crew_member_id, "EVENT_TRIGGERED"):
            s = json.loads(v["schedule_json"])
            if s["event"] != event:
                continue
            due = anchors[s["anchor"]] + timedelta(minutes=s["offset_min"])
            task = _task_from_version(v, crew_member_id, v["assigned_by"], due, f"{v['name']} — {label}")
            if _insert_task(conn, task, actor):
                ids.append(task["id"])
    return ids


ORDER_ROLES = {"FLIGHT_SURGEON", "CREW_MEDICAL_OFFICER", "SYSTEM"}


def order_task(conn, actor: Actor, crew_member_id: str, title: str, task_type: str, due: datetime,
               priority: str, completion_rule: dict, category: str = "MEDICAL", source_alert_id: str | None = None,
               note: str | None = None) -> str:
    """CLINICIAN_ORDERED task (also used for anomaly follow-ups, attributed to the system)."""
    if actor.role not in ORDER_ROLES:
        raise PermissionError("Only medical staff may order tasks")
    task = {
        "id": db.new_id("tsk"), "crew_member_id": crew_member_id, "protocol_id": None, "protocol_version_id": None,
        "title": title, "task_type": task_type, "category": category, "schedule_type": "CLINICIAN_ORDERED",
        "due_at": iso(due), "priority": priority, "assigned_by": actor.id,
        "completion_criteria": json.dumps(completion_rule), "reminder_json": json.dumps(DEFAULT_REMINDER),
        "status": "PENDING", "source_alert_id": source_alert_id, "note": note,
    }
    with db.tx(conn):
        _insert_task(conn, task, actor)
    return task["id"]


def reschedule(conn, actor: Actor, task_id: str, due: datetime, reason: str) -> None:
    with db.tx(conn):
        t = db.one(conn, "SELECT * FROM tasks WHERE id = ?", task_id)
        if not t or t["status"] in ("COMPLETED", "CANCELLED"):
            raise ValueError("Task cannot be rescheduled")
        db.update(conn, "tasks", task_id, {"due_at": iso(due), "status": "PENDING", "escalated": 0})
        conn.execute("DELETE FROM reminders WHERE task_id = ? AND acknowledged_at IS NULL", (task_id,))
        db.record(conn, actor, "TASK_RESCHEDULED", "task", task_id,
                  {"from": t["due_at"], "to": iso(due), "reason": reason})


# ---------------------------------------------------------------- completion

def evaluate(rule: dict, evidence: dict) -> tuple[bool, list[str]]:
    """Pure check of one piece of evidence against a CompletionRule.
    Returns (accepted, human-readable reasons). Never accepts low-quality data."""
    kind = rule["kind"]
    reasons: list[str] = []
    if evidence.get("kind") != kind and not (kind == "TELEMETRY_SESSION" and evidence.get("kind") == "MANUAL_LOG"):
        return False, [f"Evidence type {evidence.get('kind')} does not satisfy rule {kind}"]

    if kind == "TELEMETRY_SESSION":
        if evidence["kind"] == "MANUAL_LOG":
            if not rule.get("manual_fallback"):
                return False, ["Manual log not allowed for this task"]
            ok = evidence["duration_min"] >= rule["min_valid_minutes"]
            return ok, [f"Manual log {evidence['duration_min']} min "
                        f"{'≥' if ok else '<'} required {rule['min_valid_minutes']} min (crew-reported, no telemetry)"]
        if evidence["status"] != "COMPLETED":
            reasons.append(f"Session status {evidence['status']}")
        if evidence["valid_minutes"] < rule["min_valid_minutes"]:
            reasons.append(f"Valid telemetry {evidence['valid_minutes']:.1f} min < required {rule['min_valid_minutes']} min")
        if evidence["valid_fraction"] < rule["min_valid_fraction"]:
            reasons.append(f"Signal quality {evidence['valid_fraction']:.0%} < required {rule['min_valid_fraction']:.0%}")
        if reasons:
            return False, reasons
        return True, [f"{evidence['valid_minutes']:.1f} min valid telemetry at {evidence['valid_fraction']:.0%} quality"]

    if kind == "MEASUREMENT":
        if evidence["metric"] != rule["metric"]:
            return False, [f"{_label(evidence['metric'])} does not match required {_label(rule['metric'])}"]
        if evidence["source"] == "MANUAL" and not rule.get("allow_manual"):
            return False, ["Manual entry not allowed for this metric"]
        if evidence["quality"] == "INVALID":
            return False, ["Measurement quality INVALID"]
        return True, [f"{_label(evidence['metric'])} recorded ({evidence['source'].lower()}, quality {evidence['quality'].lower()})"]

    if kind == "VERIFICATION":
        if evidence["role"] not in rule["roles"]:
            return False, [f"{_role(evidence['role'])} not authorised; requires {' or '.join(map(_role, rule['roles']))}"]
        if not evidence.get("note", "").strip():
            return False, ["Verification note required"]
        return True, [f"Verified by {_role(evidence['role'])}"]

    if kind == "RADIATION_READING":
        if evidence["scope"] != "PERSONAL":
            return False, ["A personal dosimeter reading is required"]
        if rule.get("manual_only") and evidence["source"] != "MANUAL":
            return False, ["This task requires a manual dosimeter readout"]
        return True, [f"Personal dose reading recorded ({evidence['source'].lower()}, {evidence['dose_rate_uGy_h']} µGy/h)"]

    if kind == "ACTIVITY":
        need = rule.get("min_minutes") or 0
        if evidence["duration_min"] < need:
            return False, [f"{evidence['duration_min']:g} min logged < {need} min planned"]
        return True, [f"Recreation logged by the crew member ({evidence['duration_min']:g} min)"]

    if kind == "AUTOMATED_REVIEW":
        return True, [f"Automated review ran over {evidence['points']} values: {evidence['deviations']} outside baseline"
                      + (f", {evidence['missing_days']} day(s) without data" if evidence["missing_days"] else "")]

    if kind == "DEVICE_CHECK":
        if evidence["device_status"] != "ONLINE":
            reasons.append(f"Device status {evidence['device_status']}")
        if evidence["reading_age_min"] is None or evidence["reading_age_min"] > rule["max_reading_age_min"]:
            reasons.append(f"No device reading within {rule['max_reading_age_min']} min")
        if reasons:
            return False, reasons
        return True, [f"Device online, last reading {evidence['reading_age_min']:.0f} min ago"]

    return False, [f"Unknown rule kind {kind}"]


def _label(metric: str) -> str:
    from .intelligence import METRICS  # local import: intelligence depends on this module
    return METRICS.get(metric, {}).get("label", metric.replace("_", " "))


def _role(role: str) -> str:
    return role.replace("_", " ").capitalize()


def submit_evidence(conn, actor: Actor, task_id: str, ref_id: str, evidence: dict) -> dict:
    """Attach evidence to a task; complete it only if the rule accepts it."""
    with db.tx(conn):
        t = db.one(conn, "SELECT * FROM tasks WHERE id = ?", task_id)
        if not t:
            raise KeyError(task_id)
        if t["status"] in ("COMPLETED", "CANCELLED"):
            raise ValueError(f"Task already {t['status']}")
        ok, reasons = evaluate(json.loads(t["completion_criteria"]), evidence)
        ev_id = db.new_id("evd")
        db.insert(conn, "task_evidence", {"id": ev_id, "task_id": task_id, "kind": evidence["kind"], "ref_id": ref_id,
                                          "accepted": int(ok), "reasons": json.dumps(reasons), "created_at": iso(db.now())})
        db.record(conn, actor, "EVIDENCE_SUBMITTED", "task", task_id,
                  {"evidence_id": ev_id, "ref_id": ref_id, "accepted": ok, "reasons": reasons})
        if ok:
            db.update(conn, "tasks", task_id, {"status": "COMPLETED", "completed_at": iso(db.now())})
            db.record(conn, actor, "TASK_COMPLETED", "task", task_id, {"evidence_id": ev_id})
    return {"task_id": task_id, "evidence_id": ev_id, "accepted": ok, "reasons": reasons,
            "manual_allowed": _manual_allowed(json.loads(t["completion_criteria"]))}


def _manual_allowed(rule: dict) -> bool:
    return bool(rule.get("allow_manual") or rule.get("manual_fallback"))


def with_evidence(conn, task: dict) -> dict:
    task = dict(task)
    task["completionCriteria"] = json.loads(task.pop("completion_criteria"))
    task["reminder"] = json.loads(task.pop("reminder_json"))
    task["evidence"] = db.rows(conn, "SELECT * FROM task_evidence WHERE task_id = ? ORDER BY created_at", task["id"])
    for e in task["evidence"]:
        e["reasons"] = json.loads(e["reasons"])
    task["evidenceIds"] = [e["id"] for e in task["evidence"] if e["accepted"]]
    task["manualAllowed"] = _manual_allowed(task["completionCriteria"])
    return task


# ---------------------------------------------------------------- reminders

def tick(conn, at: datetime) -> dict:
    """Advance reminders, overdue status and escalation. Idempotent per task/kind."""
    counts = {"due": 0, "overdue": 0, "escalated": 0}
    with db.tx(conn):
        for t in db.rows(conn, "SELECT * FROM tasks WHERE status IN ('PENDING','OVERDUE')"):
            r = json.loads(t["reminder_json"])
            due = parse(t["due_at"])
            if t["status"] == "PENDING" and due - timedelta(minutes=r["lead_min"]) <= at:
                counts["due"] += _remind(conn, t["id"], "DUE")
            if t["status"] == "PENDING" and at >= due + timedelta(minutes=r["overdue_after_min"]):
                db.update(conn, "tasks", t["id"], {"status": "OVERDUE"})
                db.record(conn, SYSTEM, "TASK_OVERDUE", "task", t["id"], {"due_at": t["due_at"]})
                counts["overdue"] += _remind(conn, t["id"], "OVERDUE")
            if (t["priority"] == "CRITICAL" and not t["escalated"]
                    and at >= due + timedelta(minutes=r["escalate_after_min"])):
                db.update(conn, "tasks", t["id"], {"escalated": 1, "status": "OVERDUE"})
                _remind(conn, t["id"], "ESCALATION")
                # Compliance is operational information: the alert names the task, not any health values.
                raise_alert(conn, t["crew_member_id"], "OPERATIONAL", "TASK_ESCALATION", "HIGH",
                            f"Critical task overdue: {t['title']}",
                            {"task_id": t["id"], "due_at": t["due_at"],
                             "rule": f"CRITICAL task not completed {r['escalate_after_min']} min after due time"},
                            rule_id="task-escalation", rule_version="1.0.0")
                counts["escalated"] += 1
    return counts


def _remind(conn, task_id: str, kind: str) -> int:
    cur = conn.execute("INSERT OR IGNORE INTO reminders (id, task_id, kind, created_at) VALUES (?, ?, ?, ?)",
                       (db.new_id("rem"), task_id, kind, iso(db.now())))
    if cur.rowcount:
        db.record(conn, SYSTEM, f"REMINDER_{kind}", "task", task_id, {"kind": kind})
    return cur.rowcount


def raise_alert(conn, crew_member_id: str | None, category: str, type_: str, severity: str, title: str,
                explanation: dict, rule_id: str | None = None, rule_version: str | None = None) -> str:
    alert = {"id": db.new_id("alr"), "crew_member_id": crew_member_id, "category": category, "type": type_,
             "severity": severity, "title": title, "explanation_json": json.dumps(explanation, default=str),
             "rule_id": rule_id, "rule_version": rule_version, "status": "OPEN", "created_at": iso(db.now())}
    with db.tx(conn):
        db.insert(conn, "alerts", alert)
        db.record(conn, SYSTEM, "ALERT_RAISED", "alert", alert["id"], alert)
    return alert["id"]
