# Simulation Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real demo controls and live telemetry so the user can exercise good, bad, incomplete, anomalous, and faulted health scenarios through the existing ASTRA task/evidence pipeline.

**Architecture:** Extend the backend simulators with explicit scenario inputs and demo endpoints. Simulated measurements use the existing measurement/task/assessment flow; exercise continues through sensor sessions; radiation uses the existing dosimetry store. Add a Dashboard Simulation Lab and a WebSocket-backed live telemetry panel.

**Tech Stack:** FastAPI, SQLite, React 19, Next.js 16 App Router, WebSocket, Recharts, shadcn/ui.

**Spec:** User request for sleep quality variants, exercise failure/anomaly cases, radiation simulations, and connected dashboard telemetry.

## Global Constraints

- Preserve existing real device boundaries: `actiwatch` remains `NOT_INTEGRATED`; use an explicitly simulated sleep adapter.
- Keep clinical evaluations clinician-approved; simulations may create or expose pending work but must not sign medical verification as an astronaut.
- Reuse the existing task evidence, audit, alert, and WebSocket infrastructure.
- Label all generated data as simulated in the UI and backend provenance.

## Review Focus

- A short or low-quality exercise must remain incomplete and expose the existing manual fallback instead of being falsely completed.
- A good/standard exercise must still complete its linked task with telemetry evidence.
- Bad/anomalous sleep must persist a measurement and produce a baseline assessment without bypassing validation.
- Radiation simulations must preserve cumulative-dose monotonicity for personal readings.
- Dashboard live charts must recover gracefully when no stream is active and must not expose another crew member's telemetry.

### Task 1: Backend scenario and demo APIs

**Files:**
- Modify: `backend/astra/devices.py`
- Modify: `backend/astra/main.py`
- Modify: `backend/astra/intelligence.py`
- Modify: `backend/tests/test_mvp_flow.py` or create `backend/tests/test_simulation_lab.py`

**Interfaces:**
- `POST /sessions` accepts `scenario: STANDARD | SHORT | LOW_QUALITY | ANOMALOUS | FAULT`.
- `POST /demo/sleep` accepts `scenario: BAD | REGULAR | GOOD | ANOMALOUS`.
- `POST /demo/radiation` accepts `scenario: NORMAL | ELEVATED | ANOMALOUS` and `scope: PERSONAL | AREA`.

- [ ] Add scenario generation and provenance.
- [ ] Link simulated measurements/radiation to open task evidence where applicable.
- [ ] Emit filtered realtime events and preserve existing permissions.
- [ ] Add backend tests for pass/fail/anomaly cases.

### Task 2: Dashboard Simulation Lab and live telemetry

**Files:**
- Create: `components/dashboard/simulation-lab.tsx`
- Create: `components/dashboard/live-telemetry.tsx`
- Modify: `app/(app)/dashboard/view.tsx`

- [ ] Add controls for sleep, exercise, and radiation scenarios.
- [ ] Subscribe to live heart-rate/radiation WebSocket events.
- [ ] Render realtime charts and concise scenario results.
- [ ] Keep the lab scoped to the signed-in crew member and preserve mission-operator privacy.

### Task 3: Verification

- [ ] Run backend tests.
- [ ] Run frontend lint, TypeScript, build, and diff checks.
