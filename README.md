# ASTRA Health

Sistema personal de gestión de salud preventiva para astronautas — **demo / prototipo**.
Todos los dispositivos están **simulados**; ninguna frecuencia de protocolo proviene de NASA (ver `docs/EVIDENCE.md`).

```
backend/   FastAPI + SQLite + WebSockets + scikit-learn  (nodo ASTRA a bordo)
app/       Next.js 16 + Tailwind 4 + shadcn/ui (Radix, Nova) + Recharts  (consola de tripulación)
docs/      ARCHITECTURE.md · EVIDENCE.md · DEMO.md
```

## Ejecutar

```bash
# 1. Nodo a bordo (puerto 8000). Crea astra.db y ground.db con datos demo.
cd backend && uv sync && uv run uvicorn astra.main:app --port 8000

# 2. Consola (puerto 3000)
bun install && bun dev
```

Abrir http://localhost:3000. Cuentas demo (PIN visible en el login): `vega` 1111 (astronauta),
`okafor` 2222 (CMO), `lindqvist` 3333 (flight surgeon), `ops` 4444 (operador).

Reiniciar datos demo: borrar `backend/astra.db*` y `backend/ground.db*`.

Variables: `NEXT_PUBLIC_ASTRA_API` (default `http://localhost:8000`), `ASTRA_DB`, `ASTRA_GROUND_DB`,
`ASTRA_CORS`, `ASTRA_PLAYBACK_S` (segundos por muestra simulada, default 0.05).

## Pruebas

```bash
cd backend && uv run pytest -q     # motor, reglas, sync, y el flujo MVP de 10 pasos vía HTTP
bun run lint && bun run build      # frontend
```

Guion de demo paso a paso: `docs/DEMO.md`.
