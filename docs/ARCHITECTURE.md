# Arquitectura

## Topología

```
 ┌───────────── Estación ─────────────────────────────┐        ┌──── Tierra ────┐
 │  Consola Next.js ──HTTP/WS──▶ Nodo ASTRA (FastAPI) │  AOS   │  ground.db     │
 │                               SQLite astra.db      │ ─────▶ │  (received,    │
 │  Adaptadores simulados ─────▶ outbox (misma tx)    │  LOS ✗ │   idempotente) │
 └────────────────────────────────────────────────────┘        └────────────────┘
```

- **Offline-first = pérdida de señal con tierra (LOS).** El nodo a bordo es la fuente de verdad durante la misión; toda
  la lógica (protocolos, completitud, anomalías, alertas) corre localmente. Cada cambio escribe en `outbox` dentro de la
  misma transacción (`db.record`), y `sync.push` lo replica en orden al recuperar señal. Tierra inserta con
  `INSERT OR IGNORE` por id de evento ⇒ reenviar es seguro.
- **WebSocket** emite muestras de telemetría y eventos de invalidación (`tasks`, `alerts`, `sync`). La UI vuelve a pedir
  los datos vía HTTP, donde se aplica RBAC; el WS nunca envía eventos médicos a `MISSION_OPERATOR`.
- Endpoints `async def` en un único hilo de event loop ⇒ una sola conexión SQLite sin concurrencia.

## Módulos (backend/astra)

| Archivo | Responsabilidad |
|---|---|
| `db.py` | Esquema, transacciones, `record()` = auditoría + outbox |
| `protocols.py` | Motor de protocolos: generación de tareas, `evaluate()` de reglas de completitud, evidencias, recordatorios, vencimiento, escalamiento, alertas |
| `intelligence.py` | Línea base individual (mediana/MAD), z robusto, contexto, IsolationForest consultivo, datos faltantes, tendencias |
| `devices.py` | Catálogo de adaptadores (SIMULATED / NOT_INTEGRATED), simulación de sesión, dosimetría simulada |
| `sync.py` | Store-and-forward hacia tierra |
| `seed.py` | Usuarios, protocolos placeholder, 28 días de historia demo |
| `main.py` | API REST + WS, RBAC, orquestación |

## Modelo de dominio

| Entidad | Tabla | Notas |
|---|---|---|
| ProtocolTemplate | `protocol_templates` | Identidad estable (nombre, tipo, categoría) |
| ProtocolVersion | `protocol_versions` | `schedule_type`, `schedule_json`, `completion_rule_json`, `reminder_json`, **source, source_kind, population, approved_by, effective_from** |
| ProtocolAssignment | `protocol_assignments` | Versión ↔ tripulante, quién asignó |
| ScheduledTask | `tasks` | id, crewMemberId, protocolId, taskType, scheduleType, dueAt, priority, assignedBy, completionCriteria, status, completedAt; `evidenceIds` derivado de evidencias aceptadas |
| TaskEvidence | `task_evidence` | Cada intento, aceptado o no, con razones legibles |
| Reminder | `reminders` | DUE / OVERDUE / ESCALATION, único por (tarea, tipo) |
| CompletionRule | JSON en versión/tarea | `TELEMETRY_SESSION`, `MEASUREMENT`, `VERIFICATION`, `DEVICE_CHECK` |
| Measurement | `measurements` | fuente (MANUAL/SENSOR_SESSION/STREAM/IMPORT), calidad, correcciones por `supersedes_id` (nunca se sobrescribe) |
| SensorSession / samples | `sensor_sessions`, `samples` | Telemetría cruda + resumen de calidad |
| Alert | `alerts` | `category` MEDICAL vs OPERATIONAL siempre separada; `rule_id`/`rule_version`; explicación JSON |
| EVA, RadiationReading | `eva_events`, `radiation_readings` | PERSONAL vs AREA separados |
| AuditLog, Outbox | `audit_log`, `outbox` | Toda mutación |

### Tipos de programación
- `RECURRENT` — `{"every_days": n, "at": ["HH:MM"]}` contado desde Mission Day 1.
- `MISSION_RELATIVE` — `{"mission_days": [...], "at": "HH:MM"}`.
- `EVENT_TRIGGERED` — `{"event": "EVA", "anchor": "start|end", "offset_min": m}`; se materializa en `trigger_event`.
- `CLINICIAN_ORDERED` — creada por FLIGHT_SURGEON/CMO, o por el sistema como seguimiento de anomalía (atribuida a `system`, nunca modifica el protocolo).

### Reglas de automatización implementadas
- Telemetría válida suficiente ⇒ tarea COMPLETED con evidencia (`submit_evidence`).
- Sin evidencia / calidad insuficiente ⇒ la tarea sigue abierta; `manualAllowed` si la regla lo permite.
- Fallo de sensor ⇒ sesión FAULTED, dispositivo FAULT, alerta OPERATIONAL `SENSOR_FAULT`.
- Vencimiento ⇒ recordatorio OVERDUE; CRITICAL ⇒ escalamiento con alerta operativa (sin valores clínicos).
- Anomalía ⇒ alerta MEDICAL + tarea de verificación; la alerta no puede resolverse antes de verificar.

## Roles

| Rol | Puede |
|---|---|
| ASTRONAUT | Ver su plan y datos, registrar mediciones, sesiones, logs manuales, chequeos de dosímetro |
| CREW_MEDICAL_OFFICER | Ver datos de la tripulación, verificar, resolver alertas, ordenar tareas, planear EVA |
| FLIGHT_SURGEON | Lo anterior; aprobador de versiones de protocolo |
| MISSION_OPERATOR | Solo alertas operativas, dispositivos, sync, cumplimiento agregado; títulos de tareas médicas redactados |

## Seguridad — implementado vs. pendiente

Implementado: PIN con scrypt + `hmac.compare_digest`, tokens opacos aleatorios, RBAC por endpoint, auditoría de cada
mutación, archivos SQLite `0600`, validación Pydantic + rangos de plausibilidad, correcciones no destructivas, sin LLM.

Pendiente (límites conocidos del demo): cifrado en reposo (SQLCipher), expiración/rotación de tokens, token en
`localStorage` (mover a cookie httpOnly), TLS, mTLS hacia tierra, autorización de crew-scope en `/devices` y `/sync`,
aprobación de nuevas versiones de protocolo vía UI (hoy solo por seed).
