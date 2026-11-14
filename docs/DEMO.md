# Guion de demo (MVP, 10 pasos)

Estado inicial: Mission Day 42, enlace con tierra en **LOS**, 28 días de línea base para CM-01, última noche de sueño corta (5.3 h).

| # | Paso | Dónde | Qué observar |
|---|------|-------|--------------|
| 1 | Iniciar sesión como `vega` / 1111 | `/` | Header: `GROUND LOS`, contador de outbox |
| 2 | Plan diario | Dashboard | Tareas del día con tipo de programación (RECURRENT, MISSION_RELATIVE…) |
| 3 | Recordatorio de ejercicio | Dashboard → *Reminders* | `DUE` u `OVERDUE` según la hora UTC |
| 4 | *Start session* en la tarea de ejercicio | `/exercise` | HR en vivo por WebSocket, ventana de artefacto (INVALID) a los 12 min; al terminar: *Task completed: 28.5 min valid telemetry at 95% quality* |
| 5 | Registrar FC en reposo = **84** | `/measurements` | Se acepta como evidencia de la tarea *Resting heart rate* |
| 6 | Historial | misma página / `/records` | Nueva fila MANUAL |
| 7 | Anomalía contextualizada | resultado del registro | `DEVIATION`, z≈+10, contexto `post_exercise` + `short_sleep`, puntuación IsolationForest (solo consultiva) |
| 8 | Seguimiento | `/alerts` | Alerta MEDICAL + tarea *CMO verification* (CLINICIAN_ORDERED, asignada por `system`) |
| 9 | Verificar | Cerrar sesión → `okafor` / 2222 → `/alerts` → *Record verification* | Alerta pasa a RESOLVED con nota y autor; queda en `/audit` |
| 10 | Sincronizar | Header *GROUND* o `/devices` → *Simulate AOS* | outbox → 0, `ground holds` aumenta |

Variantes:
- **Fallo de sensor**: marcar *Simulate sensor fault* → sesión FAULTED, alerta OPERATIONAL `SENSOR_FAULT`, la tarea **no** se cierra, se ofrece registro manual; *Reset sensor* lo restablece.
- **Operador** (`ops`): solo ve alertas operativas, dispositivos, cumplimiento agregado y sync; `GET /measurements` devuelve 403.
- **EVA**: como CMO u operador en `/devices` → *Plan EVA* → se crean dos tareas EVENT_TRIGGERED de verificación de dosímetro (−60 min / +30 min).
- **Escalamiento**: la tarea CRITICAL *Periodic in-flight medical check* (10:00Z) se escala con alerta operativa si sigue abierta 120 min después.
