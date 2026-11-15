"""OSD laboratory adapters for slow, personal-baseline assessments."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from . import db, intelligence
from .db import SYSTEM


@dataclass(frozen=True)
class LabMarker:
    metric: str
    value_column: str
    unit: str
    min_column: str
    max_column: str


MARKERS = {
    "CBC": (
        LabMarker("cbc_hemoglobin", "hemoglobin_value_percent", "g/dL",
                  "hemoglobin_range_min_percent", "hemoglobin_range_max_percent"),
        LabMarker("cbc_hematocrit", "hematocrit_value_percent", "%",
                  "hematocrit_range_min_percent", "hematocrit_range_max_percent"),
        LabMarker("cbc_wbc", "white_blood_cell_count_value_thousand_per_microliter", "10^3/µL",
                  "white_blood_cell_count_range_min_thousand_per_microliter",
                  "white_blood_cell_count_range_max_thousand_per_microliter"),
        LabMarker("cbc_platelets", "platelet_count_value_thousand_per_microliter", "10^3/µL",
                  "platelet_count_range_min_thousand_per_microliter",
                  "platelet_count_range_max_thousand_per_microliter"),
    ),
    "CMP": (
        LabMarker("cmp_albumin", "albumin_value_gram_per_deciliter", "g/dL",
                  "albumin_range_min_gram_per_deciliter", "albumin_range_max_gram_per_deciliter"),
        LabMarker("cmp_glucose", "glucose_value_milligram_per_deciliter", "mg/dL",
                  "glucose_range_min_milligram_per_deciliter", "glucose_range_max_milligram_per_deciliter"),
        LabMarker("cmp_creatinine", "creatinine_value_milligram_per_deciliter", "mg/dL",
                  "creatinine_range_min_milligram_per_deciliter", "creatinine_range_max_milligram_per_deciliter"),
        LabMarker("cmp_sodium", "sodium_value_millimol_per_liter", "mmol/L",
                  "sodium_range_min_millimol_per_liter", "sodium_range_max_millimol_per_liter"),
        LabMarker("cmp_potassium", "potassium_value_millimol_per_liter", "mmol/L",
                  "potassium_range_min_millimol_per_liter", "potassium_range_max_millimol_per_liter"),
    ),
}

SAMPLE_PATTERN = re.compile(r"^(?P<subject>C\d+)_.*_(?P<offset>L-?\d+|R[+-]\d+)(?:_|$)")


def discover_sources(root: Path) -> dict[str, Path]:
    sources: dict[str, Path] = {}
    for panel in MARKERS:
        matches = sorted(root.rglob(f"*{panel}_TRANSFORMED.parquet"))
        if not matches:
            raise FileNotFoundError(f"No transformed {panel} Parquet found under {root}")
        sources[panel] = matches[0]
    return sources


def parse_sample(name: str, mission_start: datetime) -> tuple[str, datetime]:
    match = SAMPLE_PATTERN.match(name)
    if not match:
        raise ValueError(f"Unsupported OSD sample name: {name}")
    offset = match.group("offset")
    days = int(offset[1:])
    if offset.startswith("L"):
        days = -abs(days)
    return match.group("subject"), mission_start + timedelta(days=days)


def _read_panel(panel: str, path: Path) -> pd.DataFrame:
    columns = ["Sample Name"] + [
        column
        for marker in MARKERS[panel]
        for column in (marker.value_column, marker.min_column, marker.max_column)
    ]
    frame = pd.read_parquet(path, columns=columns)
    return frame.rename(columns={"Sample Name": "sample_name"})


def process_osd(
    conn: sqlite3.Connection,
    sources: dict[str, Path],
    crew_map: dict[str, str],
) -> dict:
    mission_start = db.parse(db.get_setting(conn, "mission_start"))
    report = {"accepted": [], "skipped": [], "rejected": [], "alerts": []}
    for panel, path in sources.items():
        frame = _read_panel(panel, path)
        for row in frame.to_dict("records"):
            try:
                subject, measured_at = parse_sample(str(row["sample_name"]), mission_start)
                crew = crew_map.get(subject)
                if not crew:
                    report["skipped"].append({"sample": row["sample_name"], "reason": "No crew mapping"})
                    continue
                if not db.one(conn, "SELECT 1 FROM users WHERE crew_member_id = ?", crew):
                    raise ValueError(f"Unknown crew member mapping: {crew}")
                for marker in MARKERS[panel]:
                    value = row[marker.value_column]
                    if pd.isna(value):
                        continue
                    value = float(value)
                    if intelligence.validate(marker.metric, value):
                        raise ValueError(f"{marker.metric} value is outside its plausibility range")
                    context = {
                        "panel": panel,
                        "sample_name": row["sample_name"],
                        "reference_range": {
                            "min": float(row[marker.min_column]),
                            "max": float(row[marker.max_column]),
                        },
                    }
                    existing = db.one(
                        conn,
                        "SELECT id FROM measurements WHERE crew_member_id = ? AND metric = ? "
                        "AND measured_at = ? AND source = 'IMPORT'",
                        crew, marker.metric, db.iso(measured_at),
                    )
                    if existing:
                        report["skipped"].append({"measurement": existing["id"], "reason": "Already imported"})
                        continue
                    measurement = {
                        "id": db.new_id("msr"),
                        "crew_member_id": crew,
                        "metric": marker.metric,
                        "value": value,
                        "unit": marker.unit,
                        "measured_at": db.iso(measured_at),
                        "source": "IMPORT",
                        "device_id": f"osd-{panel.lower()}",
                        "quality": "GOOD",
                        "entered_by": SYSTEM.id,
                        "context_json": json.dumps(context),
                        "created_at": db.iso(db.now()),
                    }
                    db.insert(conn, "measurements", measurement)
                    db.record(conn, SYSTEM, "MEASUREMENT_RECORDED", "measurement", measurement["id"], measurement)
                    assessment = intelligence.assess(conn, measurement)
                    report["accepted"].append(measurement["id"])
                    if assessment.get("alert_id"):
                        report["alerts"].append(assessment["alert_id"])
            except (KeyError, TypeError, ValueError) as error:
                report["rejected"].append({"panel": panel, "sample": row.get("sample_name"), "error": str(error)})
    return report


def panel(conn: sqlite3.Connection, crew: str) -> dict:
    """Every CBC/CMP marker for one crew member: history with the lab's own reference
    range (from the OSD file) and the personal-baseline status of the latest value."""
    out = {}
    for panel_name, markers in MARKERS.items():
        for marker in markers:
            rows = db.rows(conn, "SELECT id, value, unit, measured_at, source, quality, context_json FROM measurements "
                                 "WHERE crew_member_id = ? AND metric = ? AND superseded = 0 ORDER BY measured_at",
                           crew, marker.metric)
            series = []
            for r in rows:
                ctx = json.loads(r.pop("context_json") or "{}")
                ref = ctx.get("reference_range")
                r["reference_range"] = ref
                r["sample_name"] = ctx.get("sample_name")
                r["in_range"] = None if not ref else ref["min"] <= r["value"] <= ref["max"]
                series.append(r)
            latest = series[-1] if series else None
            item = {"metric": marker.metric, "panel": panel_name, "label": intelligence.METRICS[marker.metric]["label"],
                    "unit": marker.unit, "series": series, "latest": latest, "status": "NO_DATA"}
            if latest:
                b = intelligence.baseline(conn, crew, marker.metric, db.parse(latest["measured_at"]), exclude_id=latest["id"])
                item["baseline"] = b
                if b["sufficient"]:
                    item["z"] = round((latest["value"] - b["median"]) / b["robust_sd"], 2)
                    item["status"] = ("OUTSIDE_BASELINE" if abs(item["z"]) >= intelligence.RULE["threshold_z"]
                                      else "WITHIN_BASELINE")
                else:
                    item["status"] = "NO_BASELINE"
            out[marker.metric] = item
    return {"markers": out, "rule": intelligence.RULE,
            "note": "Reference ranges come from the OSD laboratory file; the personal baseline needs "
                    f"{intelligence.RULE['min_points']} values within {intelligence.RULE['baseline_window_days']} days."}
