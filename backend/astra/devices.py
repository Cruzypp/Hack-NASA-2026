"""Device adapters. Every adapter here is a SIMULATOR. No real device protocol
is implemented; NOT_INTEGRATED devices are catalogued so the UI can show them
honestly, without claiming compatibility.
"""
import json
import random
from datetime import datetime, timedelta

from . import db, protocols
from .db import Actor, SYSTEM, iso, parse

CATALOG = [
    # id, name, kind, integration, note
    ("bio-monitor-sim", "Bio-Monitor (simulated)", "wearable_hr", "SIMULATED",
     "Synthetic heart-rate stream. Not the Bio-Monitor data interface."),
    ("sleep-sim", "Sleep simulator (simulated)", "actigraphy", "SIMULATED",
     "Synthetic sleep-duration readings. Not an Actiwatch data interface."),
    ("cad-sim", "Crew Active Dosimeter (simulated)", "personal_dosimeter", "SIMULATED",
     "Synthetic dose-rate readings. Not the CAD data interface."),
    ("rem-sim", "REM / HERA area monitor (simulated)", "area_radiation", "SIMULATED",
     "Synthetic environmental dose rate, independent of personal dosimetry."),
    ("actiwatch", "Actiwatch", "actigraphy", "NOT_INTEGRATED", "Sleep/activity import planned via file adapter; no spec reviewed."),
    ("t-mini", "T-Mini", "temperature", "NOT_INTEGRATED", "Requires technical documentation."),
    ("holter-ecg", "Holter ECG", "ecg", "NOT_INTEGRATED", "Requires technical documentation."),
    ("co2-monitor", "CO2 monitor", "environment", "NOT_INTEGRATED", "Requires technical documentation."),
    ("checs", "CHeCS medical equipment", "medical_kit", "NOT_INTEGRATED", "Requires technical documentation."),
]

EXERCISE_DEVICE = "bio-monitor-sim"


def simulate_exercise(seed: int, minutes: int, fault_at_min: float | None = None, step_s: int = 10,
                      invalid_window: tuple[float, float] = (12, 13.5), hr_offset: float = 0,
                      spikes: tuple[tuple[float, float, float], ...] = ()) -> list[dict]:
    """Synthetic HR samples for an exercise bout: warm-up, steady state, cool-down,
    plus a short motion-artefact dropout. `fault_at_min` stops the stream."""
    rng = random.Random(seed)
    out = []
    n = minutes * 60 // step_s
    for i in range(n):
        m = i * step_s / 60
        if fault_at_min is not None and m >= fault_at_min:
            break
        if m < 5:
            hr = 70 + m * 14 + hr_offset
        elif m > minutes - 5:
            hr = 140 - (m - (minutes - 5)) * 10 + hr_offset
        else:
            hr = 140 + hr_offset
        for start, end, amount in spikes:
            if start <= m < end:
                hr += amount
                break
        quality = "GOOD"
        if invalid_window[0] <= m < invalid_window[1]:  # artefact window
            quality, hr = "INVALID", None
        else:
            hr = round(hr + rng.gauss(0, 3), 1)
        out.append({"offset_s": i * step_s, "value": hr, "quality": quality})
    return out


def summarize(samples: list[dict], step_s: int = 10) -> dict:
    valid = [s for s in samples if s["quality"] != "INVALID"]
    vals = [s["value"] for s in valid]
    return {
        "sample_count": len(samples),
        "valid_minutes": round(len(valid) * step_s / 60, 2),
        "valid_fraction": round(len(valid) / len(samples), 3) if samples else 0.0,
        "duration_minutes": round(len(samples) * step_s / 60, 2),
        "hr_mean": round(sum(vals) / len(vals), 1) if vals else None,
        "hr_peak": max(vals) if vals else None,
    }


def start_session(conn, actor: Actor, task_id: str | None, kind: str = "EXERCISE") -> dict:
    dev = db.one(conn, "SELECT * FROM devices WHERE id = ?", EXERCISE_DEVICE)
    if dev["status"] != "ONLINE":
        raise ValueError(f"{dev['name']} is {dev['status']}")
    s = {"id": db.new_id("ses"), "crew_member_id": actor.crew_member_id, "device_id": EXERCISE_DEVICE,
         "task_id": task_id, "kind": kind, "started_at": iso(db.now()), "status": "RUNNING"}
    with db.tx(conn):
        db.insert(conn, "sensor_sessions", s)
        db.record(conn, actor, "SESSION_STARTED", "sensor_session", s["id"], s)
    return s


def add_samples(conn, session_id: str, started: datetime, samples: list[dict]) -> None:
    conn.executemany("INSERT INTO samples (session_id, t, metric, value, quality) VALUES (?, ?, 'heart_rate', ?, ?)",
                     [(session_id, iso(started + timedelta(seconds=s["offset_s"])), s["value"], s["quality"])
                      for s in samples])


def finish_session(conn, actor: Actor, session_id: str, samples: list[dict], faulted: bool, scenario: str = "STANDARD") -> dict:
    """Close a session, store summary + derived measurements, and submit it as
    task evidence. A device fault becomes an OPERATIONAL incident, not a medical alert."""
    with db.tx(conn):
        s = db.one(conn, "SELECT * FROM sensor_sessions WHERE id = ?", session_id)
        summary = {**summarize(samples), "scenario": scenario}
        status = "FAULTED" if faulted else "COMPLETED"
        # Demo playback compresses time: the session is stored as having ended now
        # and started `duration` earlier, so sample timestamps stay in the past.
        ended = db.now()
        started = ended - timedelta(minutes=summary["duration_minutes"])
        add_samples(conn, session_id, started, samples)
        db.update(conn, "sensor_sessions", session_id,
                  {"status": status, "started_at": iso(started), "ended_at": iso(ended), "summary_json": json.dumps(summary)})
        db.record(conn, actor, f"SESSION_{status}", "sensor_session", session_id, summary)
        if summary["hr_mean"] is not None:
            m = {"id": db.new_id("msr"), "crew_member_id": s["crew_member_id"], "metric": "heart_rate",
                 "value": summary["hr_mean"], "unit": "bpm", "measured_at": iso(ended), "source": "SENSOR_SESSION",
                 "device_id": s["device_id"], "session_id": session_id,
                 "quality": "GOOD" if summary["valid_fraction"] >= 0.9 else "DEGRADED",
                 "entered_by": SYSTEM.id, "context_json": json.dumps({"aggregate": "session_mean"}),
                 "created_at": iso(db.now())}
            db.insert(conn, "measurements", m)
            db.record(conn, SYSTEM, "MEASUREMENT_RECORDED", "measurement", m["id"], m)
        if faulted:
            db.update(conn, "devices", s["device_id"], {"status": "FAULT"})
            protocols.raise_alert(conn, s["crew_member_id"], "OPERATIONAL", "SENSOR_FAULT", "MEDIUM",
                                  "Heart-rate sensor stopped during session",
                                  {"device_id": s["device_id"], "session_id": session_id,
                                   "samples_received": summary["sample_count"],
                                   "next_step": "Manual exercise log allowed for this task; inspect device."},
                                  rule_id="acquisition-fault", rule_version="1.0.0")
        result = {"session": {**s, "status": status, "started_at": iso(started), "ended_at": iso(ended), "summary": summary}}
        if s["task_id"]:
            result["completion"] = protocols.submit_evidence(
                conn, actor, s["task_id"], session_id, {"kind": "TELEMETRY_SESSION", "status": status, **summary})
    return result


LIMITS_NOTE = "Not defined by ASTRA. Exposure limits come from NASA-STD-3001 / mission radiation authorities."
SENSOR_INTERVAL = timedelta(minutes=15)


def _sim_rate(at: datetime, base: float) -> float:
    """Synthetic dose rate, deterministic per minute so replays match."""
    return round(base + random.Random(int(at.timestamp()) // 60 + int(base)).gauss(0, 1.5), 2)


def eva_at(conn, crew_member_id: str, at: datetime) -> str | None:
    e = db.one(conn, "SELECT id FROM eva_events WHERE crew_member_id = ? AND planned_start <= ? AND planned_end >= ?",
               crew_member_id, iso(at), iso(at))
    return e and e["id"]


def last_reading(conn, scope: str, crew_member_id: str | None, before: datetime | None = None) -> dict | None:
    q = "SELECT * FROM radiation_readings WHERE scope = ? AND crew_member_id IS ?"
    args: list = [scope, crew_member_id]
    if before:
        q += " AND measured_at <= ?"
        args.append(iso(before))
    return db.one(conn, q + " ORDER BY measured_at DESC LIMIT 1", *args)


def store_reading(conn, actor: Actor, scope: str, crew_member_id: str | None, device_id: str, rate: float,
                  cumulative: float | None, at: datetime, source: str = "SENSOR", note: str | None = None,
                  audit: bool = True, eva_id: str | None = None) -> dict:
    """Persist one dose reading. Personal readings are tagged with the EVA they fall in.
    Cumulative dose never decreases; that is a data-integrity rule, not an exposure limit."""
    if scope == "PERSONAL" and cumulative is not None:
        prev = db.one(conn, "SELECT * FROM radiation_readings WHERE scope = 'PERSONAL' AND crew_member_id = ? "
                            "AND cumulative_uGy IS NOT NULL AND measured_at <= ? ORDER BY measured_at DESC LIMIT 1",
                      crew_member_id, iso(at))
        if prev and cumulative < prev["cumulative_uGy"]:
            raise ValueError(f"Cumulative dose {cumulative:g} µGy is below the previous reading "
                             f"({prev['cumulative_uGy']:g} µGy at {prev['measured_at']})")
    r = {"id": db.new_id("rad"), "crew_member_id": crew_member_id, "device_id": device_id, "scope": scope,
         "dose_rate_uGy_h": rate, "cumulative_uGy": cumulative, "measured_at": iso(at),
         "eva_id": eva_id or (eva_at(conn, crew_member_id, at) if scope == "PERSONAL" and crew_member_id else None),
         "source": source, "entered_by": actor.id, "note": note}
    with db.tx(conn):
        db.insert(conn, "radiation_readings", r)
        if source == "SENSOR":
            db.update(conn, "devices", device_id, {"last_seen": iso(at)})
        if audit:
            db.record(conn, actor, "RADIATION_READING", "radiation_reading", r["id"], r)
    return r


def _integrated(conn, crew_member_id: str, at: datetime, rate: float) -> float:
    """Cumulative personal dose = previous cumulative + rate × elapsed time."""
    prev = db.one(conn, "SELECT * FROM radiation_readings WHERE scope = 'PERSONAL' AND crew_member_id = ? "
                        "AND cumulative_uGy IS NOT NULL AND measured_at <= ? ORDER BY measured_at DESC LIMIT 1",
                  crew_member_id, iso(at))
    if not prev:
        days = (at - protocols.mission_start(conn)).total_seconds() / 86400
        return round(days * 24 * 18, 1)
    hours = (at - parse(prev["measured_at"])).total_seconds() / 3600
    return round(prev["cumulative_uGy"] + rate * hours, 1)


def sample_dosimetry(conn, crew_ids: list[str], at: datetime, audit: bool = True) -> int:
    """Continuous monitoring: one simulated CAD reading per crew member and one
    area-monitor reading every SENSOR_INTERVAL. Returns readings stored."""
    stored = 0
    for crew in crew_ids:
        last = last_reading(conn, "PERSONAL", crew)
        if db.one(conn, "SELECT status FROM devices WHERE id = 'cad-sim'")["status"] == "ONLINE" and (
                not last or at - parse(last["measured_at"]) >= SENSOR_INTERVAL):
            rate = _sim_rate(at, 18)
            store_reading(conn, SYSTEM, "PERSONAL", crew, "cad-sim", rate, _integrated(conn, crew, at, rate), at, audit=audit)
            stored += 1
    last = last_reading(conn, "AREA", None)
    if not last or at - parse(last["measured_at"]) >= SENSOR_INTERVAL:
        store_reading(conn, SYSTEM, "AREA", None, "rem-sim", _sim_rate(at, 16), None, at, audit=audit)
        stored += 1
    return stored


def radiation_summary(conn, crew_member_id: str, at: datetime, days: int = 7) -> dict:
    """Stored readings over a configurable window. Summaries complement continuous
    dosimetry; they never replace it."""
    since = iso(at - timedelta(days=days))
    personal = db.rows(conn, "SELECT * FROM radiation_readings WHERE scope = 'PERSONAL' AND crew_member_id = ? "
                             "AND measured_at >= ? ORDER BY measured_at", crew_member_id, since)
    area = db.rows(conn, "SELECT * FROM radiation_readings WHERE scope = 'AREA' AND measured_at >= ? ORDER BY measured_at", since)
    cum = [r for r in personal if r["cumulative_uGy"] is not None]
    evas = []
    for e in db.rows(conn, "SELECT * FROM eva_events WHERE crew_member_id = ? ORDER BY planned_start DESC", crew_member_id):
        during = [r for r in personal if r["eva_id"] == e["id"] and r["cumulative_uGy"] is not None]
        evas.append({**e, "readings": len(during),
                     "dose_uGy": round(during[-1]["cumulative_uGy"] - during[0]["cumulative_uGy"], 1) if len(during) > 1 else None})
    mean = lambda rows: round(sum(r["dose_rate_uGy_h"] for r in rows) / len(rows), 2) if rows else None  # noqa: E731
    return {
        "window_days": days,
        "personal": {"latest": personal[-1] if personal else None, "mean_rate_uGy_h": mean(personal),
                     "window_dose_uGy": round(cum[-1]["cumulative_uGy"] - cum[0]["cumulative_uGy"], 1) if len(cum) > 1 else None,
                     "series": [{"value": r["dose_rate_uGy_h"], "measured_at": r["measured_at"]} for r in personal]},
        "area": {"latest": area[-1] if area else None, "mean_rate_uGy_h": mean(area)},
        "readings": list(reversed(personal))[:200], "area_readings": list(reversed(area))[:50],
        "eva": evas, "limits": LIMITS_NOTE,
    }


def record_dosimeter_reading(conn, actor: Actor, crew_member_id: str, at: datetime, eva_id: str | None) -> dict:
    """On-demand CAD reading for a pre/post-EVA check, linked to that EVA."""
    rate = _sim_rate(at, 18)
    return store_reading(conn, actor, "PERSONAL", crew_member_id, "cad-sim", rate,
                         _integrated(conn, crew_member_id, at, rate), at, eva_id=eva_id)
