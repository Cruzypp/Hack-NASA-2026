"""Import transformed OSD CMP/CBC data into ASTRA's slow-measurement pipeline."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from astra import db, labs  # noqa: E402


def _crew_map(value: str) -> dict[str, str]:
    pairs = [item.split("=", 1) for item in value.split(",") if "=" in item]
    if not pairs or any(not subject or not crew for subject, crew in pairs):
        raise ValueError("Crew map must use comma-separated SUBJECT=CREW pairs")
    return dict(pairs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=os.getenv("ASTRA_OSD_DIR"), required=False)
    parser.add_argument("--db", type=Path, default=Path("backend/astra.db"))
    parser.add_argument("--crew-map", default="C001=CM-01,C002=CM-02")
    args = parser.parse_args()
    if args.input is None:
        parser.error("--input is required when ASTRA_OSD_DIR is not set")
    if not args.input.is_dir():
        parser.error(f"OSD input directory does not exist: {args.input}")

    sources = labs.discover_sources(args.input)
    conn = db.connect(str(args.db))
    try:
        report = labs.process_osd(conn, sources, _crew_map(args.crew_map))
    finally:
        conn.close()
    print(json.dumps({"sources": {panel: str(path) for panel, path in sources.items()}, **report}, indent=2))


if __name__ == "__main__":
    main()
