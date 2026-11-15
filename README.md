# ASTRA Health

Personal preventive health management system for astronauts — **demo / prototype**.
All devices are **simulated**; no protocol frequency comes from NASA (see `docs/EVIDENCE.md`).
ASTRA thresholds are experimental and are not official NASA limits.

```
backend/   FastAPI + SQLite + WebSockets + scikit-learn  (nodo ASTRA a bordo)
app/       Next.js 16 + Tailwind 4 + shadcn/ui (Radix, Nova) + Recharts  (consola de tripulación)
docs/      ARCHITECTURE.md · EVIDENCE.md · DEMO.md
```

## Flight telemetry pipeline

The high-frequency physiological source is the Inspiration4/LOFT dataset
distributed through NASA's Open Science Data Repository (OSDR). Raw 256 Hz
Parquet files and OSD laboratory data stay local under the ignored `data/`
directory; they must never be committed.

Run the offline processors from the repository root:

```bash
python scripts/procesar_telemetria.py --input "path/to/physiological" --start-s 0 --duration-s 120 --output public/samples/muestra_vuelo.json
python scripts/procesar_osd.py --input "path/to/OSD" --db backend/astra.db
```

The 256 Hz rolling statistics, personal baselines and hysteresis are computed
offline in Python. The Next.js console only replays the compact JSON contract
(`docs/FLIGHT_DATA_CONTRACT.md`) at 8 Hz and never processes raw Parquet data.
The optional playback window keeps the browser artifact small; the baseline is
still calculated from the complete selected Parquet input.
OSD CMP/CBC values are slow measurements and use the existing personal
median/MAD intelligence rule, not the telemetry moving window.

## Run

```bash
# 1. Onboard node (port 8000). Creates astra.db and ground.db with demo data.
cd backend && uv sync && uv run uvicorn astra.main:app --port 8000

# 2. Console (port 3000)
bun install && bun dev
```

Open http://localhost:3000. Demo accounts (the PIN is visible on the login screen):
`vega` 1111 (astronaut), `okafor` 2222 (CMO), `lindqvist` 3333 (flight surgeon),
`ops` 4444 (operator).

To reset demo data, delete `backend/astra.db*` and `backend/ground.db*`.

Variables: `NEXT_PUBLIC_ASTRA_API` (default `http://localhost:8000`), `ASTRA_DB`, `ASTRA_GROUND_DB`,
`ASTRA_CORS`, `ASTRA_PLAYBACK_S` (seconds per simulated sample, default 0.05).

## Tests

```bash
cd backend && uv run pytest -q     # engine, rules, sync, and the 10-step HTTP MVP flow
bun run lint && bun run build      # frontend
```

Step-by-step demo guide: `docs/DEMO.md`.
