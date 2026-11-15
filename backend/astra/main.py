"""ASTRA onboard node API (FastAPI).

Endpoints are `async def` on purpose: they all run on the event-loop thread,
so the single SQLite connection is never used concurrently.
"""
import asyncio
import contextlib
import csv
import hmac
import io
import json
import os
import secrets
from datetime import datetime, time, timedelta
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import body as bodycomp, clinical, db, devices, intelligence, protocols, seed, sync
from .db import Actor, SYSTEM, iso, parse

MEDICAL_ROLES = {"CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"}
REMINDER_RANK = {"DUE": 0, "OVERDUE": 1, "ESCALATION": 2}
PLAYBACK_S = float(os.environ.get("ASTRA_PLAYBACK_S", "0.05"))


# ------------------------------------------------------------------ models

class Login(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    pin: str = Field(min_length=4, max_length=12)


class MeasurementIn(BaseModel):
    metric: str
    value: float
    measured_at: datetime | None = None
    task_id: str | None = None
    note: str | None = Field(default=None, max_length=500)


class CorrectionIn(BaseModel):
    value: float
    reason: str = Field(min_length=3, max_length=500)


class ImportIn(BaseModel):
    csv: str = Field(max_length=200_000)


class SessionIn(BaseModel):
    task_id: str | None = None
    simulate_fault: bool = False
    scenario: Literal["STANDARD", "SHORT", "LOW_QUALITY", "ANOMALOUS", "PEAKS", "FAULT"] = "STANDARD"


class SleepDemoIn(BaseModel):
    scenario: Literal["BAD", "REGULAR", "GOOD", "ANOMALOUS"]
    crew_member_id: str | None = None


class RadiationDemoIn(BaseModel):
    scenario: Literal["NORMAL", "ELEVATED", "ANOMALOUS"]
    scope: Literal["PERSONAL", "AREA"] = "PERSONAL"
    crew_member_id: str | None = None


class BodyDemoIn(BaseModel):
    scenario: Literal["STABLE", "MILD_LOSS", "LEG_ATROPHY", "ASYMMETRIC", "GLOBAL_LOSS", "FLUID_SHIFT", "RECOVERY", "RANDOM"]
    phase: Literal["INFLIGHT", "POSTFLIGHT"] = "INFLIGHT"
    crew_member_id: str | None = None


class CognitiveLoadDemoIn(BaseModel):
    phase: str = Field(min_length=1, max_length=32)
    cognitive_load: float = Field(ge=0, le=100)
    z: dict[str, float]
    baseline: dict[str, dict[str, float]]
    crew_member_id: str | None = None


class ActivityIn(BaseModel):
    duration_min: float = Field(ge=0, le=600)
    note: str | None = Field(default=None, max_length=500)


class ManualLogIn(BaseModel):
    duration_min: float = Field(gt=0, le=300)
    rpe: int | None = Field(default=None, ge=6, le=20)
    load_note: str | None = Field(default=None, max_length=200)


class RpeIn(BaseModel):
    rpe: int = Field(ge=6, le=20)


class VerifyIn(BaseModel):
    note: str = Field(min_length=3, max_length=2000)
    resolve_alert: bool = True


class ResolveIn(BaseModel):
    note: str = Field(min_length=3, max_length=2000)


class OrderIn(BaseModel):
    crew_member_id: str
    title: str = Field(min_length=3, max_length=200)
    task_type: str | None = None  # derived from the completion rule; kept for older clients
    due_at: datetime
    priority: Literal["ROUTINE", "HIGH", "CRITICAL"]
    completion_rule: dict
    note: str | None = None


class RescheduleIn(BaseModel):
    due_at: datetime
    reason: str = Field(min_length=3, max_length=500)


class EvaIn(BaseModel):
    crew_member_id: str
    planned_start: datetime
    planned_end: datetime


class RadiationIn(BaseModel):
    scope: Literal["PERSONAL", "AREA"]
    dose_rate_uGy_h: float = Field(ge=0, le=100_000)  # plausibility only, not an exposure limit
    cumulative_uGy: float | None = Field(default=None, ge=0, le=10_000_000)
    device_id: Literal["cad-sim", "rem-sim", "passive-dosimeter", "manual"] = "manual"
    crew_member_id: str | None = None
    measured_at: datetime | None = None
    note: str | None = Field(default=None, max_length=500)


class LinkIn(BaseModel):
    state: Literal["AOS", "LOS"]


# ------------------------------------------------------------------ realtime

class Hub:
    """Fan-out of events over WebSockets, filtered per viewer."""

    def __init__(self):
        self.clients: list[tuple[WebSocket, Actor]] = []

    async def send(self, event: dict, crew_member_id: str | None = None, medical: bool = True):
        for ws, actor in list(self.clients):
            if medical and actor.role == "MISSION_OPERATOR":
                continue
            if crew_member_id and actor.role == "ASTRONAUT" and actor.crew_member_id != crew_member_id:
                continue
            try:
                await ws.send_json(event)
            except Exception:
                with contextlib.suppress(ValueError):
                    self.clients.remove((ws, actor))


class CarePlanSpec(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    schedule_type: Literal["RECURRENT", "MISSION_RELATIVE"]
    schedule: dict
    completion_rule: dict
    priority: Literal["ROUTINE", "HIGH", "CRITICAL"] = "ROUTINE"
    reference: str = Field(min_length=3, max_length=500)
    reason: str = Field(min_length=3, max_length=1000)


class CarePlanRevision(BaseModel):
    schedule_type: Literal["RECURRENT", "MISSION_RELATIVE"] | None = None
    schedule: dict | None = None
    completion_rule: dict | None = None
    priority: Literal["ROUTINE", "HIGH", "CRITICAL"] | None = None
    reason: str = Field(min_length=3, max_length=1000)


class RetireIn(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


class ReviewIn(BaseModel):
    metric: str
    window_days: int = Field(default=7, ge=1, le=31)


class LogIn(BaseModel):
    category: Literal["OBSERVATION", "CONSULTATION", "PLAN_CHANGE", "COMMUNICATION", "OTHER"]
    body: str = Field(min_length=3, max_length=5000)
    shared_with_crew: bool = False
    linked_type: Literal["alert", "task", "measurement", "analysis_report", "sensor_session"] | None = None
    linked_id: str | None = Field(default=None, max_length=64)


class AddendumIn(BaseModel):
    body: str = Field(min_length=3, max_length=5000)


# ------------------------------------------------------------------ app

def create_app(db_path: str = "astra.db", ground_path: str = "ground.db", background: bool = True) -> FastAPI:
    conn = db.connect(db_path)
    ground = sync.connect_ground(ground_path)
    seed.seed(conn, ground)
    bodycomp.seed(conn)
    hub = Hub()
    running: dict[str, asyncio.Task] = {}

    async def housekeeping():
        last = None
        while True:
            await step()
            state = sync.status(conn, ground)
            if state != last:
                await hub.send({"type": "sync", **state}, medical=False)
                last = state
            await asyncio.sleep(5)

    async def step():
        at = db.now()
        today = datetime.combine(at.date(), time(0), tzinfo=at.tzinfo)
        for c in crew_ids():
            protocols.generate_tasks(conn, c, today, today + timedelta(days=protocols.PLAN_HORIZON_DAYS))
        if devices.sample_dosimetry(conn, crew_ids(), at):
            for r in db.rows(conn, "SELECT * FROM radiation_readings WHERE measured_at = ? AND device_id IN ('cad-sim','rem-sim')", iso(at)):
                await hub.send({"type": "radiation", "reading": r}, r["crew_member_id"], medical=r["scope"] == "PERSONAL")
        auto = clinical.run_due(conn, at)  # before tick, so automated tasks never show as overdue
        if any(auto.values()):
            await hub.send({"type": "tasks", **auto})
        counts = protocols.tick(conn, at)
        if any(counts.values()):
            await hub.send({"type": "tasks", **counts})
        sync.push(conn, ground)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(housekeeping()) if background else None
        yield
        if task:
            task.cancel()

    app = FastAPI(title="ASTRA Health — onboard node", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("ASTRA_CORS", "http://localhost:3000").split(","),
                       allow_methods=["*"], allow_headers=["*"])
    app.state.conn, app.state.ground, app.state.hub, app.state.step = conn, ground, hub, step

    def crew_ids() -> list[str]:
        return [r["crew_member_id"] for r in db.rows(conn, "SELECT crew_member_id FROM users WHERE crew_member_id IS NOT NULL")]

    # -------------------------------------------------------------- auth

    def actor_for_token(token: str | None) -> Actor:
        u = token and db.one(conn, "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", token)
        if not u:
            raise HTTPException(401, "Not authenticated")
        return Actor(u["id"], u["role"], u["crew_member_id"], u["display_name"])

    async def current(authorization: str | None = Header(default=None)) -> Actor:
        return actor_for_token(authorization.removeprefix("Bearer ") if authorization else None)

    def need(actor: Actor, *roles: str):
        if actor.role not in roles:
            raise HTTPException(403, f"Role {actor.role} not permitted")

    def medical_access(actor: Actor, crew_member_id: str):
        """Health data: the astronaut's own, or medical staff. Never mission ops."""
        if actor.role in MEDICAL_ROLES:
            return
        if actor.role == "ASTRONAUT" and actor.crew_member_id == crew_member_id:
            return
        raise HTTPException(403, "No access to this crew member's health data")

    def task_or_404(task_id: str) -> dict:
        t = db.one(conn, "SELECT * FROM tasks WHERE id = ?", task_id)
        if not t:
            raise HTTPException(404, "Task not found")
        return t

    @app.post("/auth/login")
    async def login(body: Login):
        u = db.one(conn, "SELECT * FROM users WHERE username = ?", body.username)
        if not u or not hmac.compare_digest(seed.hash_pin(body.pin, u["pin_salt"]), u["pin_hash"]):
            raise HTTPException(401, "Invalid credentials")
        token = secrets.token_urlsafe(32)
        actor = Actor(u["id"], u["role"], u["crew_member_id"], u["display_name"])
        with db.tx(conn):
            db.insert(conn, "sessions", {"token": token, "user_id": u["id"], "created_at": iso(db.now())})
            db.record(conn, actor, "LOGIN", "user", u["id"], {}, sync=False)
        return {"token": token, "user": _user(actor)}

    @app.get("/me")
    async def me(actor: Actor = Depends(current)):
        return _user(actor)

    def _user(a: Actor) -> dict:
        return {"id": a.id, "role": a.role, "crewMemberId": a.crew_member_id, "name": a.name}

    # -------------------------------------------------------------- dashboard

    @app.get("/dashboard")
    async def dashboard(crew_member_id: str | None = None, actor: Actor = Depends(current)):
        at = db.now()
        base = {"now": iso(at), "missionDay": protocols.mission_day(conn, at),
                "mission": db.get_setting(conn, "mission_name"), "sync": sync.status(conn, ground),
                "devices": db.rows(conn, "SELECT id, name, kind, integration, status, last_seen FROM devices")}
        if actor.role == "MISSION_OPERATOR":
            return {**base, "view": "OPERATIONAL", "alerts": _alerts(actor, status="OPEN"),
                    "compliance": _compliance(None, at)}
        crew = crew_member_id or actor.crew_member_id
        if not crew:
            crew = crew_ids()[0]
        medical_access(actor, crew)
        day0 = datetime.combine(at.date(), time(0), tzinfo=at.tzinfo)
        tasks = [protocols.with_evidence(conn, t) for t in db.rows(
            conn, "SELECT * FROM tasks WHERE crew_member_id = ? AND ((due_at >= ? AND due_at < ?) OR status = 'OVERDUE') "
                  "ORDER BY due_at", crew, iso(day0), iso(day0 + timedelta(days=1)))]
        return {**base, "view": "HEALTH", "crewMemberId": crew, "tasks": tasks,
                "reminders": _reminders(crew),
                "recent": db.rows(conn, "SELECT * FROM measurements WHERE crew_member_id = ? AND superseded = 0 "
                                        "ORDER BY measured_at DESC LIMIT 8", crew),
                "alerts": [a for a in _alerts(actor, status="OPEN") if a["crew_member_id"] in (crew, None)],
                "trends": {m: intelligence.trends(conn, crew, m, at) for m in ("resting_hr", "sleep_hours", "body_mass")},
                "missingData": {m: intelligence.missing_days(conn, crew, m, 7, at) for m in ("resting_hr", "sleep_hours")},
                "radiation": _radiation_brief(crew, at),
                "compliance": _compliance(crew, at)}

    def _radiation_brief(crew: str, at: datetime) -> dict:
        r = devices.radiation_summary(conn, crew, at, days=7)
        return {k: r[k] for k in ("window_days", "personal", "area", "limits")}

    def _reminders(crew: str) -> list[dict]:
        """One active reminder per task: the most severe unacknowledged kind."""
        out = {}
        for r in db.rows(conn, """SELECT r.*, t.title, t.due_at, t.priority, t.status task_status FROM reminders r
                                  JOIN tasks t ON t.id = r.task_id WHERE t.crew_member_id = ? AND r.acknowledged_at IS NULL
                                  AND t.status IN ('PENDING','OVERDUE') ORDER BY t.due_at""", crew):
            if REMINDER_RANK[r["kind"]] >= REMINDER_RANK[out.get(r["task_id"], {"kind": "DUE"})["kind"]]:
                out[r["task_id"]] = r
        return list(out.values())

    def _compliance(crew: str | None, at: datetime) -> dict:
        since = iso(at - timedelta(days=7))
        q = "SELECT category, status, COUNT(*) n FROM tasks WHERE due_at >= ? AND due_at <= ?"
        args = [since, iso(at)]
        if crew:
            q += " AND crew_member_id = ?"
            args.append(crew)
        return {"window_days": 7, "by_category": db.rows(conn, q + " GROUP BY category, status", *args)}

    # -------------------------------------------------------------- schedule

    @app.get("/protocols")
    async def list_protocols(actor: Actor = Depends(current)):
        out = db.rows(conn, "SELECT v.*, t.name, t.task_type, t.category, u.display_name approved_by_name, "
                            "u.role approved_by_role FROM protocol_versions v "
                            "JOIN protocol_templates t ON t.id = v.protocol_id LEFT JOIN users u ON u.id = v.approved_by "
                            "ORDER BY t.category, t.name")
        for v in out:
            for k in ("schedule_json", "completion_rule_json", "reminder_json"):
                v[k.removesuffix("_json")] = json.loads(v.pop(k))
        return out

    @app.get("/tasks")
    async def list_tasks(crew_member_id: str | None = None, start: datetime | None = None, end: datetime | None = None,
                         actor: Actor = Depends(current)):
        at = db.now()
        start = start or at - timedelta(days=3)
        end = end or at + timedelta(days=2)
        if actor.role == "MISSION_OPERATOR":
            # Operational view: status and timing only, no clinical task details.
            return db.rows(conn, "SELECT id, crew_member_id, task_type, category, schedule_type, due_at, priority, status, "
                                 "escalated, CASE WHEN category IN ('MEDICAL','RADIATION','SLEEP') THEN task_type || ' task' "
                                 "ELSE title END title FROM tasks WHERE due_at >= ? AND due_at < ? ORDER BY due_at",
                           iso(start), iso(end))
        crew = crew_member_id or actor.crew_member_id
        medical_access(actor, crew)
        # Looking ahead in the calendar materialises those days (idempotent, capped at 60 days).
        horizon = at + timedelta(days=60)
        if end > at and crew in crew_ids():
            protocols.generate_tasks(conn, crew, max(start, at), min(end, horizon))
        return [protocols.with_evidence(conn, t) for t in db.rows(
            conn, "SELECT * FROM tasks WHERE crew_member_id = ? AND due_at >= ? AND due_at < ? ORDER BY due_at",
            crew, iso(start), iso(end))]

    @app.post("/tasks")
    async def order(body: OrderIn, actor: Actor = Depends(current)):
        """One-off clinician-ordered task. CMO and flight surgeon; recurring changes go through the care plan."""
        need(actor, *MEDICAL_ROLES)
        _crew_or_404(body.crew_member_id)
        if body.due_at < db.now() - timedelta(minutes=5):
            raise HTTPException(422, "Due time is in the past")
        try:
            rule, task_type, category = clinical.validate_rule(body.completion_rule)
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e))
        with db.tx(conn):
            tid = protocols.order_task(conn, actor, body.crew_member_id, body.title, task_type, body.due_at,
                                       body.priority, rule, category=category, note=body.note)
            clinical.log(conn, actor, body.crew_member_id, "PLAN_CHANGE",
                         f"Ordered one-off task “{body.title}” for {iso(body.due_at)}." + (f" {body.note}" if body.note else ""),
                         "task", tid)
        await hub.send({"type": "tasks"}, body.crew_member_id)
        return protocols.with_evidence(conn, task_or_404(tid))

    @app.post("/tasks/{task_id}/reschedule")
    async def reschedule(task_id: str, body: RescheduleIn, actor: Actor = Depends(current)):
        t = task_or_404(task_id)
        # Crew may move routine items; anything else needs medical staff.
        if not (actor.role in MEDICAL_ROLES or (actor.crew_member_id == t["crew_member_id"] and t["priority"] == "ROUTINE")):
            raise HTTPException(403, "Only medical staff may reschedule this task")
        try:
            protocols.reschedule(conn, actor, task_id, body.due_at, body.reason)
        except ValueError as e:
            raise HTTPException(409, str(e))
        return protocols.with_evidence(conn, task_or_404(task_id))

    @app.post("/tasks/{task_id}/activity")
    async def log_activity(task_id: str, body: ActivityIn, actor: Actor = Depends(current)):
        """The crew member marks a recreation/wellbeing task as done (self-reported)."""
        t = task_or_404(task_id)
        if actor.crew_member_id != t["crew_member_id"]:
            raise HTTPException(403, "Only the assigned crew member can complete this")
        ref = db.new_id("act")
        with db.tx(conn):
            db.record(conn, actor, "ACTIVITY_LOGGED", "task", task_id, {"ref": ref, **body.model_dump()})
            res = _evidence(actor, task_id, ref, {"kind": "ACTIVITY", "duration_min": body.duration_min})
        await hub.send({"type": "tasks"}, t["crew_member_id"])
        return res

    @app.post("/tasks/{task_id}/manual-log")
    async def manual_log(task_id: str, body: ManualLogIn, actor: Actor = Depends(current)):
        t = task_or_404(task_id)
        if actor.crew_member_id != t["crew_member_id"]:
            raise HTTPException(403, "Only the assigned crew member can log this")
        ref = db.new_id("log")
        with db.tx(conn):
            db.record(conn, actor, "EXERCISE_MANUAL_LOG", "task", task_id, {"ref": ref, **body.model_dump()})
            if body.rpe:
                _store_measurement(actor, t["crew_member_id"], "rpe", body.rpe, db.now(), "MANUAL", None)
            res = _evidence(actor, task_id, ref, {"kind": "MANUAL_LOG", "duration_min": body.duration_min})
        await hub.send({"type": "tasks"}, t["crew_member_id"])
        return res

    @app.post("/tasks/{task_id}/verify")
    async def verify(task_id: str, body: VerifyIn, actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        t = task_or_404(task_id)
        with db.tx(conn):
            ref = db.new_id("vrf")
            db.record(conn, actor, "VERIFICATION_RECORDED", "task", task_id, {"ref": ref, "note": body.note})
            res = _evidence(actor, task_id, ref, {"kind": "VERIFICATION", "role": actor.role, "note": body.note})
            if res["accepted"] and body.resolve_alert and t["source_alert_id"]:
                _resolve(actor, t["source_alert_id"], f"Verified via task {task_id}: {body.note}")
        await hub.send({"type": "alerts"}, t["crew_member_id"])
        return res

    @app.post("/tasks/{task_id}/dosimeter-check")
    async def dosimeter_check(task_id: str, actor: Actor = Depends(current)):
        t = task_or_404(task_id)
        if actor.crew_member_id != t["crew_member_id"] and actor.role not in MEDICAL_ROLES:
            raise HTTPException(403, "Not permitted")
        dev = db.one(conn, "SELECT * FROM devices WHERE id = 'cad-sim'")
        eva = db.one(conn, "SELECT id FROM eva_events WHERE crew_member_id = ? ORDER BY planned_start DESC LIMIT 1",
                     t["crew_member_id"])
        with db.tx(conn):
            reading = None
            if dev["status"] == "ONLINE":
                reading = devices.record_dosimeter_reading(conn, actor, t["crew_member_id"], db.now(), eva and eva["id"])
            res = _evidence(actor, task_id, reading["id"] if reading else "none",
                            {"kind": "DEVICE_CHECK", "device_status": dev["status"], "reading_age_min": 0 if reading else None})
        return {**res, "reading": reading}

    def _evidence(actor: Actor, task_id: str, ref: str, evidence: dict) -> dict:
        try:
            return protocols.submit_evidence(conn, actor, task_id, ref, evidence)
        except ValueError as e:
            raise HTTPException(409, str(e))

    @app.post("/reminders/{reminder_id}/ack")
    async def ack_reminder(reminder_id: str, actor: Actor = Depends(current)):
        r = db.one(conn, "SELECT r.*, t.crew_member_id FROM reminders r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
                   reminder_id)
        if not r:
            raise HTTPException(404, "Reminder not found")
        medical_access(actor, r["crew_member_id"])
        with db.tx(conn):
            # Dismissing acknowledges every pending reminder of that task.
            conn.execute("UPDATE reminders SET acknowledged_at = ? WHERE task_id = ? AND acknowledged_at IS NULL",
                         (iso(db.now()), r["task_id"]))
            db.record(conn, actor, "REMINDER_ACK", "reminder", reminder_id, {"task_id": r["task_id"]})
        return {"ok": True}

    # -------------------------------------------------------------- demo simulations

    @app.post("/demo/sleep")
    async def demo_sleep(body: SleepDemoIn, actor: Actor = Depends(current)):
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        crew = actor.crew_member_id if actor.role == "ASTRONAUT" else (body.crew_member_id or actor.crew_member_id)
        if not crew:
            raise HTTPException(400, "Sleep simulations require a crew member")
        _crew_or_404(crew)
        values = {"BAD": 5.0, "REGULAR": 7.0, "GOOD": 8.5, "ANOMALOUS": 3.0}
        at = db.now()
        m = _store_measurement(actor, crew, "sleep_hours", values[body.scenario], at, "STREAM",
                               f"Sleep simulator scenario: {body.scenario.lower()}", device_id="sleep-sim")
        result = await _after_measurement(actor, m, None)
        await hub.send({"type": "simulation", "kind": "sleep", "scenario": body.scenario, "measurement": m}, crew)
        return {"scenario": body.scenario, **result}

    @app.post("/demo/radiation")
    async def demo_radiation(body: RadiationDemoIn, actor: Actor = Depends(current)):
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        crew = actor.crew_member_id if actor.role == "ASTRONAUT" else (body.crew_member_id or actor.crew_member_id)
        if body.scope == "PERSONAL" and not crew:
            raise HTTPException(400, "Personal radiation simulations require a crew member")
        device_id = "cad-sim" if body.scope == "PERSONAL" else "rem-sim"
        device = db.one(conn, "SELECT status FROM devices WHERE id = ?", device_id)
        if not device or device["status"] != "ONLINE":
            raise HTTPException(409, f"{device_id} is not online")
        rates = {"NORMAL": 18.0, "ELEVATED": 45.0, "ANOMALOUS": 120.0}
        at = db.now()
        rate = rates[body.scenario]
        cumulative = devices._integrated(conn, crew, at, rate) if body.scope == "PERSONAL" else None
        reading = devices.store_reading(conn, actor, body.scope, crew, device_id, rate, cumulative, at,
                                        source="SENSOR", note=f"Demo radiation scenario: {body.scenario.lower()}")
        await hub.send({"type": "radiation", "scenario": body.scenario, "reading": reading}, crew)
        return {"scenario": body.scenario, "reading": reading}

    @app.post("/demo/cognitive-load")
    async def demo_cognitive_load(body: CognitiveLoadDemoIn, actor: Actor = Depends(current)):
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        crew = actor.crew_member_id if actor.role == "ASTRONAUT" else (body.crew_member_id or actor.crew_member_id)
        if not crew:
            raise HTTPException(400, "Cognitive-load simulations require a crew member")
        _crew_or_404(crew)
        rule = {"id": "cognitive-iqr-z", "version": "0.1", "threshold_z": 3.0,
                "provenance": "ASTRA experimental rule; not NASA-specified."}
        explanation = {
            "phase": body.phase,
            "cognitive_load": body.cognitive_load,
            "z": body.z,
            "baseline": body.baseline,
            "rule": rule,
            "summary": f"Cognitive load alert during {body.phase}: z-score threshold sustained",
            "recommendation": "Crew Medical Officer review. ASTRA does not diagnose.",
        }
        with db.tx(conn):
            alert_id = protocols.raise_alert(
                conn, crew, "MEDICAL", "COGNITIVE_LOAD", "REVIEW",
                "Cognitive load outside experimental baseline", explanation,
                rule_id=rule["id"], rule_version=rule["version"])
        await hub.send({"type": "alerts", "kind": "cognitive-load", "alert_id": alert_id}, crew)
        return {"alert_id": alert_id, "phase": body.phase, "cognitive_load": body.cognitive_load}

    @app.post("/demo/body-composition")
    async def demo_body(body: BodyDemoIn, actor: Actor = Depends(current)):
        """Synthetic InBody-type assessment for the crew member in view, evaluated like a real one."""
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        crew = actor.crew_member_id if actor.role == "ASTRONAUT" else (body.crew_member_id or actor.crew_member_id)
        _crew_or_404(crew)
        a = bodycomp.simulate(conn, actor, crew, body.scenario, body.phase, db.now())
        # The scan's scale reading is a body-mass measurement too: it closes today's body-mass task
        # and goes through the same personal-baseline check as any other value.
        m = _store_measurement(actor, crew, "body_mass", a["values"]["body_mass_kg"], parse(a["measured_at"]), "STREAM",
                               f"From body composition scan {a['id']}", device_id="bia-sim")
        a["body_mass"] = await _after_measurement(actor, m, None)
        await hub.send({"type": "body_composition", "id": a["id"]}, crew)
        if a["alert_id"]:
            await hub.send({"type": "alerts"}, crew)
        return a

    @app.get("/body-composition/{crew_member_id}")
    async def body_composition(crew_member_id: str, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        medical_access(actor, crew_member_id)
        items = bodycomp.history(conn, crew_member_id)
        return {"assessments": items, "latest": items[-1] if items else None,
                "reference": bodycomp.reference(conn, crew_member_id, "BIA"), "rule": bodycomp.RULE,
                "methods": bodycomp.METHODS, "segments": bodycomp.SEGMENT_LABEL,
                "scenarios": {k: v["label"] for k, v in bodycomp.SCENARIOS.items()}}

    # -------------------------------------------------------------- measurements

    def _store_measurement(actor: Actor, crew: str, metric: str, value: float, at: datetime, source: str,
                           note: str | None, supersedes: dict | None = None, reason: str | None = None,
                           device_id: str | None = None) -> dict:
        err = intelligence.validate(metric, value)
        if err:
            raise HTTPException(422, err)
        m = {"id": db.new_id("msr"), "crew_member_id": crew, "metric": metric, "value": value,
             "unit": intelligence.METRICS[metric]["unit"], "measured_at": iso(at), "source": source,
             "quality": "GOOD", "entered_by": actor.id, "device_id": device_id,
             "supersedes_id": supersedes and supersedes["id"],
             "correction_reason": reason, "context_json": json.dumps({"note": note} if note else {}),
             "created_at": iso(db.now())}
        with db.tx(conn):
            db.insert(conn, "measurements", m)
            if supersedes:
                db.update(conn, "measurements", supersedes["id"], {"superseded": 1})
            db.record(conn, actor, "MEASUREMENT_CORRECTED" if supersedes else "MEASUREMENT_RECORDED", "measurement",
                      m["id"], {**m, "supersedes": supersedes})
        return m

    def _matching_task(crew: str, metric: str, at: datetime) -> dict | None:
        day = at.date().isoformat()
        for t in db.rows(conn, "SELECT * FROM tasks WHERE crew_member_id = ? AND status IN ('PENDING','OVERDUE') "
                               "AND substr(due_at, 1, 10) <= ? ORDER BY due_at DESC", crew, day):
            rule = json.loads(t["completion_criteria"])
            if rule.get("kind") == "MEASUREMENT" and rule.get("metric") == metric and t["due_at"][:10] == day:
                return t
        return None

    async def _after_measurement(actor: Actor, m: dict, task_id: str | None) -> dict:
        out = {"measurement": m}
        task = task_or_404(task_id) if task_id else _matching_task(m["crew_member_id"], m["metric"], parse(m["measured_at"]))
        if task and task["status"] in ("PENDING", "OVERDUE"):
            out["completion"] = _evidence(actor, task["id"], m["id"], {"kind": "MEASUREMENT", **m})
        out["assessment"] = intelligence.assess(conn, m)
        await hub.send({"type": "measurement", "metric": m["metric"]}, m["crew_member_id"])
        if out["assessment"].get("alert_id"):
            await hub.send({"type": "alerts"}, m["crew_member_id"])
        return out

    @app.post("/measurements")
    async def add_measurement(body: MeasurementIn, actor: Actor = Depends(current)):
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        crew = actor.crew_member_id
        if not crew:
            raise HTTPException(400, "Measurements are entered for the signed-in crew member")
        at = body.measured_at or db.now()
        if at > db.now() + timedelta(minutes=5):
            raise HTTPException(422, "measured_at is in the future")
        m = _store_measurement(actor, crew, body.metric, body.value, at, "MANUAL", body.note)
        return await _after_measurement(actor, m, body.task_id)

    @app.post("/measurements/{measurement_id}/correct")
    async def correct(measurement_id: str, body: CorrectionIn, actor: Actor = Depends(current)):
        old = db.one(conn, "SELECT * FROM measurements WHERE id = ?", measurement_id)
        if not old or old["superseded"]:
            raise HTTPException(404, "Measurement not found or already corrected")
        if not (actor.role in MEDICAL_ROLES or actor.id == old["entered_by"]):
            raise HTTPException(403, "Only the author or medical staff may correct")
        m = _store_measurement(actor, old["crew_member_id"], old["metric"], body.value, parse(old["measured_at"]),
                               old["source"], None, supersedes=old, reason=body.reason)
        return {"measurement": m, "assessment": intelligence.assess(conn, m)}

    @app.post("/measurements/import")
    async def import_csv(body: ImportIn, actor: Actor = Depends(current)):
        """CSV columns: metric,value,measured_at — e.g. exported results from another system."""
        need(actor, "ASTRONAUT", *MEDICAL_ROLES)
        accepted, rejected = [], []
        for i, row in enumerate(csv.DictReader(io.StringIO(body.csv.strip())), start=2):
            try:
                m = _store_measurement(actor, actor.crew_member_id, row["metric"].strip(), float(row["value"]),
                                       parse(row["measured_at"].strip()), "IMPORT", f"import line {i}")
                accepted.append(m["id"])
            except (HTTPException, KeyError, ValueError, AttributeError) as e:
                rejected.append({"line": i, "error": getattr(e, "detail", str(e))})
        return {"accepted": accepted, "rejected": rejected}

    @app.get("/measurements")
    async def list_measurements(crew_member_id: str | None = None, metric: str | None = None, include_superseded: bool = False,
                                actor: Actor = Depends(current)):
        crew = crew_member_id or actor.crew_member_id
        medical_access(actor, crew)
        q = "SELECT * FROM measurements WHERE crew_member_id = ?"
        args: list = [crew]
        if metric:
            q += " AND metric = ?"
            args.append(metric)
        if not include_superseded:
            q += " AND superseded = 0"
        return db.rows(conn, q + " ORDER BY measured_at DESC LIMIT 500", *args)

    @app.get("/metrics")
    async def metrics(actor: Actor = Depends(current)):
        return intelligence.METRICS

    # -------------------------------------------------------------- exercise

    @app.post("/sessions")
    async def start_session(body: SessionIn, actor: Actor = Depends(current)):
        need(actor, "ASTRONAUT", "CREW_MEDICAL_OFFICER")
        if body.task_id:
            t = task_or_404(body.task_id)
            if t["crew_member_id"] != actor.crew_member_id:
                raise HTTPException(403, "Task belongs to another crew member")
        try:
            s = devices.start_session(conn, actor, body.task_id)
        except ValueError as e:
            raise HTTPException(409, str(e))
        fault = body.simulate_fault or body.scenario == "FAULT"
        running[s["id"]] = asyncio.create_task(_play(actor, s, fault, body.scenario))
        return {**s, "scenario": body.scenario}

    async def _play(actor: Actor, s: dict, fault: bool, scenario: str = "STANDARD"):
        minutes = 18 if scenario == "SHORT" else 30
        invalid_window = (4, 18) if scenario == "LOW_QUALITY" else (12, 13.5)
        hr_offset = 35 if scenario == "ANOMALOUS" else 0
        spikes = ((7, 8, 45), (18, 19, 60)) if scenario == "PEAKS" else ()
        samples = devices.simulate_exercise(seed=hash(s["id"]) & 0xFFFF, minutes=minutes,
                                             fault_at_min=17 if fault else None,
                                             invalid_window=invalid_window, hr_offset=hr_offset, spikes=spikes)
        for x in samples:
            await hub.send({"type": "sample", "session_id": s["id"], "crew_member_id": s["crew_member_id"], **x}, s["crew_member_id"])
            await asyncio.sleep(PLAYBACK_S)
        result = devices.finish_session(conn, actor, s["id"], samples, faulted=fault, scenario=scenario)
        running.pop(s["id"], None)
        await hub.send({"type": "session_finished", "scenario": scenario, **result}, s["crew_member_id"])
        if fault:
            await hub.send({"type": "alerts"}, medical=False)

    @app.get("/sessions")
    async def list_sessions(crew_member_id: str | None = None, actor: Actor = Depends(current)):
        crew = crew_member_id or actor.crew_member_id
        medical_access(actor, crew)
        out = db.rows(conn, "SELECT s.*, t.title task_title, t.task_type task_type FROM sensor_sessions s "
                           "LEFT JOIN tasks t ON t.id = s.task_id WHERE s.crew_member_id = ? "
                           "ORDER BY s.started_at DESC LIMIT 50", crew)
        for s in out:
            s["summary"] = json.loads(s.pop("summary_json") or "null")
        return out

    @app.post("/sessions/{session_id}/rpe")
    async def session_rpe(session_id: str, body: RpeIn, actor: Actor = Depends(current)):
        s = db.one(conn, "SELECT * FROM sensor_sessions WHERE id = ?", session_id)
        if not s or s["crew_member_id"] != actor.crew_member_id:
            raise HTTPException(404, "Session not found")
        return _store_measurement(actor, s["crew_member_id"], "rpe", body.rpe, parse(s["ended_at"] or iso(db.now())),
                                  "MANUAL", f"session {session_id}")

    @app.get("/exercise/summary")
    async def exercise_summary(crew_member_id: str | None = None, actor: Actor = Depends(current)):
        """Compliance and session stats vs the person's own history. Descriptive only:
        ASTRA never prescribes new training loads."""
        crew = crew_member_id or actor.crew_member_id
        medical_access(actor, crew)
        tasks = db.rows(conn, "SELECT status, COUNT(*) n FROM tasks WHERE crew_member_id = ? AND task_type = 'EXERCISE' "
                              "AND due_at <= ? GROUP BY status", crew, iso(db.now()))
        sessions = db.rows(conn, "SELECT summary_json, ended_at FROM sensor_sessions WHERE crew_member_id = ? "
                                 "AND status = 'COMPLETED' ORDER BY ended_at", crew)
        sums = [(json.loads(s["summary_json"]), s["ended_at"]) for s in sessions]
        return {"compliance": tasks, "sessions": len(sums),
                "hr_mean_history": [{"value": s["hr_mean"], "measured_at": at} for s, at in sums if s.get("hr_mean") is not None],
                "sleep": intelligence.trends(conn, crew, "sleep_hours", db.now(), 14),
                "rpe": db.rows(conn, "SELECT value, measured_at FROM measurements WHERE crew_member_id = ? AND metric='rpe' "
                                     "AND superseded = 0 ORDER BY measured_at DESC LIMIT 14", crew),
                "note": "Descriptive comparison only. Training loads are prescribed by the exercise team."}

    # -------------------------------------------------------------- alerts

    def _alerts(actor: Actor, status: str | None = None, category: str | None = None) -> list[dict]:
        q, args = "SELECT * FROM alerts WHERE 1=1", []
        if actor.role == "MISSION_OPERATOR":
            q += " AND category = 'OPERATIONAL'"
        if actor.role == "ASTRONAUT":
            q += " AND (crew_member_id = ? OR crew_member_id IS NULL)"
            args.append(actor.crew_member_id)
        if status:
            q += " AND status = ?"
            args.append(status)
        if category:
            q += " AND category = ?"
            args.append(category)
        return [intelligence.explain(a) for a in db.rows(conn, q + " ORDER BY created_at DESC LIMIT 200", *args)]

    @app.get("/alerts")
    async def list_alerts(status: str | None = None, category: str | None = None, actor: Actor = Depends(current)):
        return _alerts(actor, status, category)

    def _alert_or_404(actor: Actor, alert_id: str) -> dict:
        a = next((x for x in _alerts(actor) if x["id"] == alert_id), None)
        if not a:
            raise HTTPException(404, "Alert not found")
        return a

    @app.post("/alerts/{alert_id}/ack")
    async def ack_alert(alert_id: str, actor: Actor = Depends(current)):
        a = _alert_or_404(actor, alert_id)
        if a["status"] == "OPEN":
            with db.tx(conn):
                db.update(conn, "alerts", alert_id, {"status": "ACKNOWLEDGED"})
                db.record(conn, actor, "ALERT_ACK", "alert", alert_id, {})
        return {"ok": True}

    def _resolve(actor: Actor, alert_id: str, note: str):
        with db.tx(conn):
            db.update(conn, "alerts", alert_id, {"status": "RESOLVED", "resolved_by": actor.id,
                                                 "resolved_at": iso(db.now()), "resolution_note": note})
            db.record(conn, actor, "ALERT_RESOLVED", "alert", alert_id, {"note": note})

    @app.post("/alerts/{alert_id}/resolve")
    async def resolve_alert(alert_id: str, body: ResolveIn, actor: Actor = Depends(current)):
        a = _alert_or_404(actor, alert_id)
        if a["category"] == "MEDICAL":
            need(actor, *MEDICAL_ROLES)
        else:
            need(actor, "MISSION_OPERATOR", *MEDICAL_ROLES)
        if a["status"] == "RESOLVED":
            raise HTTPException(409, "Already resolved")
        if a["follow_up_task_id"]:
            ft = task_or_404(a["follow_up_task_id"])
            if ft["status"] != "COMPLETED":
                raise HTTPException(409, "Complete the follow-up verification before resolving")
        _resolve(actor, alert_id, body.note)
        await hub.send({"type": "alerts"}, a["crew_member_id"], medical=a["category"] == "MEDICAL")
        return {"ok": True}

    # -------------------------------------------------------------- records

    @app.get("/records/{crew_member_id}/timeline")
    async def timeline(crew_member_id: str, actor: Actor = Depends(current)):
        medical_access(actor, crew_member_id)
        items = []
        for m in db.rows(conn, "SELECT * FROM measurements WHERE crew_member_id = ? ORDER BY measured_at DESC LIMIT 300",
                         crew_member_id):
            items.append({"at": m["measured_at"], "kind": "measurement", "data": m})
        for s in db.rows(conn, "SELECT * FROM sensor_sessions WHERE crew_member_id = ?", crew_member_id):
            s["summary"] = json.loads(s.pop("summary_json") or "null")
            items.append({"at": s["ended_at"] or s["started_at"], "kind": "session", "data": s})
        for a in db.rows(conn, "SELECT * FROM alerts WHERE crew_member_id = ?", crew_member_id):
            items.append({"at": a["created_at"], "kind": "alert", "data": intelligence.explain(a)})
        for t in db.rows(conn, "SELECT * FROM tasks WHERE crew_member_id = ? AND status = 'COMPLETED'", crew_member_id):
            items.append({"at": t["completed_at"], "kind": "task", "data": protocols.with_evidence(conn, t)})
        for r in db.rows(conn, "SELECT * FROM radiation_readings WHERE crew_member_id = ?", crew_member_id):
            items.append({"at": r["measured_at"], "kind": "radiation", "data": r})
        for b in bodycomp.history(conn, crew_member_id):
            items.append({"at": b["measured_at"], "kind": "body", "data": b})
        for e in clinical.logbook(conn, crew_member_id, include_private=actor.role in MEDICAL_ROLES):
            items.append({"at": e["created_at"], "kind": "log", "data": e})
        return sorted(items, key=lambda i: i["at"], reverse=True)

    @app.get("/records/{crew_member_id}/export")
    async def export(crew_member_id: str, actor: Actor = Depends(current)):
        medical_access(actor, crew_member_id)
        with db.tx(conn):
            db.record(conn, actor, "RECORD_EXPORTED", "crew_member", crew_member_id, {})
        q = lambda sql: db.rows(conn, sql, crew_member_id)  # noqa: E731
        return {
            "format": "astra-health-record/0.1", "exported_at": iso(db.now()), "exported_by": actor.id,
            "crew_member_id": crew_member_id,
            "measurements": q("SELECT * FROM measurements WHERE crew_member_id = ? ORDER BY measured_at"),
            "sessions": q("SELECT * FROM sensor_sessions WHERE crew_member_id = ?"),
            "tasks": q("SELECT * FROM tasks WHERE crew_member_id = ? ORDER BY due_at"),
            "alerts": [intelligence.explain(a) for a in q("SELECT * FROM alerts WHERE crew_member_id = ?")],
            "radiation": q("SELECT * FROM radiation_readings WHERE crew_member_id = ?"),
            "eva": q("SELECT * FROM eva_events WHERE crew_member_id = ?"),
            "body_composition": bodycomp.history(conn, crew_member_id),
            "provenance": {"rule": intelligence.RULE, "advisory_model": intelligence.ADVISORY_MODEL,
                           "body_composition_rule": bodycomp.RULE,
                           "devices": "All device data in this export is SIMULATED."},
        }

    @app.get("/audit")
    async def audit(limit: int = 100, actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        return db.rows(conn, "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", min(limit, 1000))

    # -------------------------------------------------------------- devices, radiation, sync

    @app.get("/devices")
    async def list_devices(actor: Actor = Depends(current)):
        return db.rows(conn, "SELECT * FROM devices ORDER BY integration DESC, name")

    @app.post("/devices/{device_id}/reset")
    async def reset_device(device_id: str, actor: Actor = Depends(current)):
        need(actor, "MISSION_OPERATOR", "CREW_MEDICAL_OFFICER", "ASTRONAUT")
        d = db.one(conn, "SELECT * FROM devices WHERE id = ?", device_id)
        if not d or d["integration"] != "SIMULATED":
            raise HTTPException(404, "Simulated device not found")
        with db.tx(conn):
            db.update(conn, "devices", device_id, {"status": "ONLINE", "last_seen": iso(db.now())})
            db.record(conn, actor, "DEVICE_RESET", "device", device_id, {"from": d["status"]})
        return {"ok": True}

    @app.post("/eva")
    async def plan_eva(body: EvaIn, actor: Actor = Depends(current)):
        need(actor, "MISSION_OPERATOR", *MEDICAL_ROLES)
        if body.planned_end <= body.planned_start:
            raise HTTPException(422, "EVA end must be after start")
        eva = {"id": db.new_id("eva"), "crew_member_id": body.crew_member_id,
               "planned_start": iso(body.planned_start), "planned_end": iso(body.planned_end)}
        with db.tx(conn):
            db.insert(conn, "eva_events", eva)
            db.record(conn, actor, "EVA_PLANNED", "eva", eva["id"], eva)
            ids = protocols.trigger_event(conn, actor, body.crew_member_id, "EVA",
                                          {"start": body.planned_start, "end": body.planned_end}, f"EVA {eva['id'][-4:]}")
        await hub.send({"type": "tasks"}, body.crew_member_id)
        return {"eva": eva, "task_ids": ids}

    @app.get("/radiation/{crew_member_id}")
    async def radiation(crew_member_id: str, days: int = 7, actor: Actor = Depends(current)):
        medical_access(actor, crew_member_id)
        return {**devices.radiation_summary(conn, crew_member_id, db.now(), days=max(1, min(days, 365))),
                "note": "Continuous personal dosimetry is the source of truth; summaries never replace it."}

    @app.post("/radiation/readings")
    async def add_radiation(body: RadiationIn, actor: Actor = Depends(current)):
        """Manual dose entry, e.g. a passive dosimeter readout or a reading copied from a
        device display while its data link is down. Stored with source MANUAL."""
        at = body.measured_at or db.now()
        if at > db.now() + timedelta(minutes=5):
            raise HTTPException(422, "measured_at is in the future")
        if body.scope == "PERSONAL":
            crew = body.crew_member_id or actor.crew_member_id
            if not crew:
                raise HTTPException(400, "crew_member_id required for a personal reading")
            medical_access(actor, crew)
        else:
            need(actor, "ASTRONAUT", "MISSION_OPERATOR", *MEDICAL_ROLES)  # environmental data, not health data
            crew = None
        try:
            r = devices.store_reading(conn, actor, body.scope, crew, body.device_id, body.dose_rate_uGy_h,
                                      body.cumulative_uGy, at, source="MANUAL", note=body.note)
        except ValueError as e:
            raise HTTPException(422, str(e))
        completion = clinical.match_radiation_task(conn, actor, r)
        await hub.send({"type": "radiation"}, crew, medical=body.scope == "PERSONAL")
        return {**r, "completion": completion}

    @app.get("/sync")
    async def sync_status(actor: Actor = Depends(current)):
        return sync.status(conn, ground)

    @app.post("/sync/link")
    async def set_link(body: LinkIn, actor: Actor = Depends(current)):
        """Demo control: simulate Loss / Acquisition of Signal with ground."""
        with db.tx(conn):
            db.set_setting(conn, "ground_link", body.state)
            db.record(conn, actor, f"LINK_{body.state}", "link", "ground", {}, sync=False)
        result = sync.push(conn, ground)
        await hub.send({"type": "sync", **sync.status(conn, ground)}, medical=False)
        return result

    @app.post("/demo/tick")
    async def demo_tick(actor: Actor = Depends(current)):
        await step()
        return {"ok": True}

    # -------------------------------------------------------------- clinician workspace

    def _crew_or_404(crew: str):
        if crew not in crew_ids():
            raise HTTPException(404, "Unknown crew member")

    @app.get("/crew")
    async def crew_list(actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        return db.rows(conn, "SELECT crew_member_id, display_name, role FROM users WHERE crew_member_id IS NOT NULL "
                             "ORDER BY crew_member_id")

    @app.get("/crew/{crew_member_id}/overview")
    async def crew_overview(crew_member_id: str, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        medical_access(actor, crew_member_id)
        return clinical.overview(conn, crew_member_id, db.now())

    @app.get("/crew/{crew_member_id}/care-plan")
    async def crew_care_plan(crew_member_id: str, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        medical_access(actor, crew_member_id)
        return {**clinical.care_plan(conn, crew_member_id), "can_edit": actor.role in clinical.PLAN_ROLES}

    def _plan_call(fn, *args):
        try:
            return fn(*args)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'"))
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e))

    @app.post("/crew/{crew_member_id}/care-plan")
    async def crew_add_protocol(crew_member_id: str, body: CarePlanSpec, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        v = _plan_call(clinical.create_protocol, conn, actor, crew_member_id, body.model_dump())
        await hub.send({"type": "tasks"}, crew_member_id)
        return v

    @app.post("/crew/{crew_member_id}/care-plan/{protocol_id}/revise")
    async def crew_revise_protocol(crew_member_id: str, protocol_id: str, body: CarePlanRevision, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        changes = body.model_dump(exclude_none=True, exclude={"reason"})
        v = _plan_call(clinical.revise_protocol, conn, actor, crew_member_id, protocol_id, changes, body.reason)
        await hub.send({"type": "tasks"}, crew_member_id)
        return v

    @app.post("/crew/{crew_member_id}/care-plan/{protocol_id}/retire")
    async def crew_retire_protocol(crew_member_id: str, protocol_id: str, body: RetireIn, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        n = _plan_call(clinical.retire_protocol, conn, actor, crew_member_id, protocol_id, body.reason)
        await hub.send({"type": "tasks"}, crew_member_id)
        return {"tasks_cancelled": n}

    @app.get("/crew/{crew_member_id}/reports")
    async def crew_reports(crew_member_id: str, actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        return clinical.reports(conn, crew_member_id)

    @app.post("/crew/{crew_member_id}/reports")
    async def crew_run_review(crew_member_id: str, body: ReviewIn, actor: Actor = Depends(current)):
        """On-demand deviation review over a window, same rule as the scheduled one."""
        need(actor, *MEDICAL_ROLES)
        _crew_or_404(crew_member_id)
        if body.metric not in intelligence.METRICS:
            raise HTTPException(422, "Unknown metric")
        r = clinical.review(conn, crew_member_id, body.metric, body.window_days, db.now(), actor=actor)
        await hub.send({"type": "alerts"}, crew_member_id)
        return r

    @app.get("/crew/{crew_member_id}/logbook")
    async def crew_logbook(crew_member_id: str, actor: Actor = Depends(current)):
        _crew_or_404(crew_member_id)
        medical_access(actor, crew_member_id)
        # The crew member sees only entries explicitly shared with them.
        return clinical.logbook(conn, crew_member_id, include_private=actor.role in MEDICAL_ROLES)

    @app.post("/crew/{crew_member_id}/logbook")
    async def crew_log(crew_member_id: str, body: LogIn, actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        _crew_or_404(crew_member_id)
        e = clinical.log(conn, actor, crew_member_id, body.category, body.body, body.linked_type, body.linked_id,
                         body.shared_with_crew)
        await hub.send({"type": "logbook"}, crew_member_id)
        return e

    @app.post("/logbook/{entry_id}/addendum")
    async def log_addendum(entry_id: str, body: AddendumIn, actor: Actor = Depends(current)):
        need(actor, *MEDICAL_ROLES)
        parent = db.one(conn, "SELECT * FROM clinical_log WHERE id = ?", entry_id)
        if not parent or parent["amends_id"]:
            raise HTTPException(404, "Log entry not found")
        e = clinical.log(conn, actor, parent["crew_member_id"], parent["category"], body.body, shared=bool(parent["shared_with_crew"]),
                         amends_id=entry_id)
        await hub.send({"type": "logbook"}, parent["crew_member_id"])
        return e

    # -------------------------------------------------------------- websocket

    @app.websocket("/ws")
    async def ws(socket: WebSocket, token: str = ""):
        try:
            actor = actor_for_token(token)
        except HTTPException:
            await socket.close(code=4401)
            return
        await socket.accept()
        hub.clients.append((socket, actor))
        await socket.send_json({"type": "sync", **sync.status(conn, ground)})
        try:
            while True:
                await socket.receive_text()
        except WebSocketDisconnect:
            with contextlib.suppress(ValueError):
                hub.clients.remove((socket, actor))

    return app


app = None
if os.environ.get("ASTRA_AUTOSTART", "1") == "1":
    app = create_app(os.environ.get("ASTRA_DB", "astra.db"), os.environ.get("ASTRA_GROUND_DB", "ground.db"))
