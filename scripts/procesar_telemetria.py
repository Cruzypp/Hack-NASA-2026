"""Convert high-frequency physiological Parquet data into flight playback JSON."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Iterable

import pandas as pd


SIGNALS = ("ECG", "GSR", "EEG_FP1", "EEG_Cz")
REQUIRED_COLUMNS = ("TimeSecs", *SIGNALS, "Event")
SOURCE_HZ = 256
PLAYBACK_HZ = 8
WINDOW_SAMPLES = 512
BIN_SAMPLES = SOURCE_HZ // PLAYBACK_HZ
ALERT_Z = 3.0
ALERT_DURATION_SAMPLES = SOURCE_HZ
CLEAR_Z = 2.5


def _parquet_paths(input_path: Path) -> list[Path]:
    if input_path.is_file():
        if input_path.suffix.lower() != ".parquet":
            raise ValueError(f"Input file is not Parquet: {input_path}")
        return [input_path]
    if input_path.is_dir():
        paths = sorted(input_path.rglob("*.parquet"))
        if paths:
            return paths
    raise FileNotFoundError(f"No Parquet files found at {input_path}")


def _read_sources(paths: Iterable[Path]) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for path in paths:
        frame = pd.read_parquet(path, columns=list(REQUIRED_COLUMNS))
        missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
        if missing:
            raise ValueError(f"{path} is missing required columns: {', '.join(missing)}")
        frames.append(frame)

    data = pd.concat(frames, ignore_index=True)
    for column in REQUIRED_COLUMNS:
        data[column] = pd.to_numeric(data[column], errors="coerce")
    data = data.dropna(subset=list(REQUIRED_COLUMNS)).sort_values("TimeSecs", kind="stable")
    if data.empty:
        raise ValueError("The Parquet input contains no complete physiological rows")
    return data.reset_index(drop=True)


def _phase(time_seconds: float) -> str:
    if time_seconds < 60:
        return "prelaunch"
    if time_seconds < 180:
        return "launch"
    return "orbit"


def _alert_states(max_z: pd.Series) -> pd.Series:
    active = False
    above_count = 0
    states: list[bool] = []
    for value in max_z:
        if active:
            if value < CLEAR_Z:
                active = False
            states.append(active)
            continue
        above_count = above_count + 1 if value >= ALERT_Z else 0
        if above_count >= ALERT_DURATION_SAMPLES:
            active = True
        states.append(active)
    return pd.Series(states, index=max_z.index, dtype=bool)


def _baseline(data: pd.DataFrame) -> dict[str, dict[str, float]]:
    baseline_rows = data["Event"] == 0
    if not baseline_rows.any():
        raise ValueError("The input contains no baseline rows with Event == 0")

    result: dict[str, dict[str, float]] = {}
    for signal in SIGNALS:
        values = data.loc[baseline_rows, f"{signal}_smoothed"]
        result[signal] = {
            "median": float(values.median()),
            "iqr": float(values.quantile(0.75) - values.quantile(0.25)),
        }
    return result


def _sample_records(data: pd.DataFrame) -> list[dict]:
    records: list[dict] = []
    for bin_start in range(0, len(data), BIN_SAMPLES):
        window = data.iloc[bin_start : bin_start + BIN_SAMPLES]
        z_values = {
            signal: float(window[f"{signal}_z"].median())
            for signal in SIGNALS
        }
        load = min(100.0, math.sqrt(sum(value * value for value in z_values.values()) / len(z_values)) / ALERT_Z * 100)
        records.append({
            "t": round(float(window["TimeSecs"].median()), 3),
            "phase": _phase(float(window["TimeSecs"].median())),
            "cognitive_load": round(load, 2),
            "alerta_activa": bool(window["alert_active"].iloc[-1]),
            "z": {signal: round(value, 3) for signal, value in z_values.items()},
        })
    return records


def process(input_path: Path, output_path: Path, start_s: float = 0, duration_s: float | None = None) -> None:
    data = _read_sources(_parquet_paths(input_path))
    for signal in SIGNALS:
        data[f"{signal}_smoothed"] = data[signal].rolling(
            WINDOW_SAMPLES, min_periods=1
        ).median()

    baseline = _baseline(data)
    for signal in SIGNALS:
        spread = max(baseline[signal]["iqr"], 1e-6)
        data[f"{signal}_z"] = (
            (data[f"{signal}_smoothed"] - baseline[signal]["median"]).abs() / spread
        )
    data["alert_active"] = _alert_states(data[[f"{signal}_z" for signal in SIGNALS]].max(axis=1))
    output_data = data[data["TimeSecs"] >= start_s]
    if duration_s is not None:
        output_data = output_data[output_data["TimeSecs"] < start_s + duration_s]
    if output_data.empty:
        raise ValueError("The requested output window contains no physiological rows")

    payload = {
        "meta": {
            "hz": PLAYBACK_HZ,
            "window_s": WINDOW_SAMPLES / SOURCE_HZ,
            "baseline_event": 0,
            "rule": "iqr-robust-z@0.1",
            "source": "LOFT physiological 256Hz -> 8Hz",
        },
        "baseline": baseline,
        "samples": _sample_records(output_data),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=os.getenv("ASTRA_PHYSIOLOGICAL_DIR"),
        help="Parquet file or directory; defaults to ASTRA_PHYSIOLOGICAL_DIR",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/samples/muestra_vuelo.json"),
        help="Output playback JSON path",
    )
    parser.add_argument("--start-s", type=float, default=0, help="Mission-second offset for the playback window")
    parser.add_argument("--duration-s", type=float, help="Optional playback-window duration in seconds")
    args = parser.parse_args()
    if args.input is None:
        parser.error("--input is required when ASTRA_PHYSIOLOGICAL_DIR is not set")
    if args.start_s < 0 or (args.duration_s is not None and args.duration_s <= 0):
        parser.error("--start-s must be non-negative and --duration-s must be positive")
    process(args.input, args.output, args.start_s, args.duration_s)


if __name__ == "__main__":
    main()
