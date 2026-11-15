"""Cognitive-load playback from the LOFT / Inspiration4 physiological dataset.

The 256 Hz statistics, robust z-scores and alert hysteresis are computed
offline (scripts/procesar_telemetria.py, docs/FLIGHT_DATA_CONTRACT.md). The
onboard node only replays that compact JSON as a sensor session: samples are
stored, streamed to the console and the alert is raised here from the file's
own values — never from numbers sent by a browser.

The recording belongs to the dataset subject, not to the crew member it is
replayed for; every session and alert says so.
"""
import json
import os
from datetime import timedelta
from pathlib import Path

from . import db, protocols
from .db import SYSTEM, Actor, iso

DEVICE = "loft-playback"
SIGNALS = ("ECG", "GSR", "EEG_FP1", "EEG_Cz")
DEFAULT_PATH = Path(__file__).resolve().parents[2] / "public" / "samples" / "muestra_vuelo.json"
RULE = {"id": "cognitive-iqr-z", "version": "0.1", "threshold_z": 3.0, "clear_z": 2.5,
        "provenance": "ASTRA experimental rule computed offline (robust z vs IQR baseline, hysteresis); not NASA-specified."}
SOURCE_NOTE = "Replayed LOFT/Inspiration4 recording (NASA OSDR) — dataset subject's signals, not this crew member's own."


def load(path: str | None = None) -> dict:
    p = Path(path or os.environ.get("ASTRA_FLIGHT_JSON", DEFAULT_PATH))
    data = json.loads(p.read_text())
    if not (data.get("meta") and data.get("baseline") and data.get("samples")):
        raise ValueError(f"{p} does not follow the flight playback contract")
    ts = [s["t"] for s in data["samples"]]
    if ts != sorted(ts):
        raise ValueError("Flight playback samples must be ordered by t")
    return data


def start(conn, actor: Actor, crew: str) -> dict:
    if db.one(conn, "SELECT 1 FROM sensor_sessions WHERE crew_member_id = ? AND kind = 'COGNITIVE_LOAD' AND status = 'RUNNING'", crew):
        raise ValueError("A cognitive-load playback is already running for this crew member")
    s = {"id": db.new_id("ses"), "crew_member_id": crew, "device_id": DEVICE, "task_id": None, "kind": "COGNITIVE_LOAD",
         "started_at": iso(db.now()), "status": "RUNNING"}
    with db.tx(conn):
        db.insert(conn, "sensor_sessions", s)
        db.record(conn, actor, "SESSION_STARTED", "sensor_session", s["id"], s)
    return s


def store_sample(conn, session: dict, sample: dict) -> None:
    at = iso(db.parse(session["started_at"]) + timedelta(seconds=sample["t"]))
    rows = [(session["id"], at, "cognitive_load", sample["cognitive_load"], "GOOD")]
    rows += [(session["id"], at, f"z_{k}", v, "GOOD") for k, v in sample["z"].items()]
    conn.executemany("INSERT INTO samples (session_id, t, metric, value, quality) VALUES (?, ?, ?, ?, ?)", rows)


def raise_alert(conn, session: dict, sample: dict, data: dict) -> str:
    crew = session["crew_member_id"]
    hot = [k for k, v in sample["z"].items() if v >= RULE["threshold_z"]]
    explanation = {
        "summary": (f"Cognitive load {sample['cognitive_load']:.0f}% during {sample['phase']} at t={sample['t']:.1f} s; "
                    f"robust z ≥ {RULE['threshold_z']} sustained on {', '.join(hot) or 'combined signals'}."),
        "phase": sample["phase"], "cognitive_load": sample["cognitive_load"], "t": sample["t"], "z": sample["z"],
        "baseline": data["baseline"], "session_id": session["id"], "rule": RULE, "source": {**data["meta"], "note": SOURCE_NOTE},
        "recommendation": "Crew Medical Officer review of workload and stressors. ASTRA does not diagnose.",
    }
    with db.tx(conn):
        alert_id = protocols.raise_alert(conn, crew, "MEDICAL", "COGNITIVE_LOAD", "REVIEW",
                                         "Cognitive load outside experimental baseline", explanation,
                                         rule_id=RULE["id"], rule_version=RULE["version"])
        protocols.request_cmo_review(conn, SYSTEM, crew, alert_id, explanation["summary"], "HIGH")
    return alert_id


def summarize(samples: list[dict], data: dict, alert_id: str | None) -> dict:
    hz = data["meta"].get("hz", 8)
    peak = max(samples, key=lambda s: s["cognitive_load"]) if samples else None
    phases: dict[str, list[float]] = {}
    for s in samples:
        phases.setdefault(s["phase"], []).append(s["cognitive_load"])
    return {
        "samples": len(samples), "duration_s": round(samples[-1]["t"] - samples[0]["t"], 1) if samples else 0,
        "peak_load": peak and peak["cognitive_load"], "peak_t": peak and peak["t"], "peak_phase": peak and peak["phase"],
        "peak_z": peak and peak["z"],
        "mean_by_phase": {p: round(sum(v) / len(v), 1) for p, v in phases.items()},
        "alert_s": round(sum(s["alerta_activa"] for s in samples) / hz, 1), "alert_id": alert_id,
        "rule": RULE, "source": {**data["meta"], "note": SOURCE_NOTE},
    }


def finish(conn, actor: Actor, session: dict, summary: dict) -> dict:
    with db.tx(conn):
        db.update(conn, "sensor_sessions", session["id"], {"status": "COMPLETED", "ended_at": iso(db.now()),
                                                           "summary_json": json.dumps(summary)})
        db.record(conn, actor, "SESSION_COMPLETED", "sensor_session", session["id"], summary)
    return detail(conn, session["id"])


def detail(conn, session_id: str) -> dict | None:
    s = db.one(conn, "SELECT * FROM sensor_sessions WHERE id = ? AND kind = 'COGNITIVE_LOAD'", session_id)
    if not s:
        return None
    s["summary"] = json.loads(s.pop("summary_json") or "null")
    rows = db.rows(conn, "SELECT t, metric, value FROM samples WHERE session_id = ? ORDER BY t", session_id)
    trace: dict[str, dict] = {}
    for r in rows:
        point = trace.setdefault(r["t"], {"at": r["t"], "z": {}})
        if r["metric"] == "cognitive_load":
            point["cognitive_load"] = r["value"]
        else:
            point["z"][r["metric"][2:]] = r["value"]
    s["trace"] = list(trace.values())
    return s


def sessions(conn, crew: str, limit: int = 20) -> list[dict]:
    out = db.rows(conn, "SELECT * FROM sensor_sessions WHERE crew_member_id = ? AND kind = 'COGNITIVE_LOAD' "
                        "ORDER BY started_at DESC LIMIT ?", crew, limit)
    for s in out:
        s["summary"] = json.loads(s.pop("summary_json") or "null")
    return out
