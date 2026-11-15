# Fuentes NASA vs. decisiones experimentales de ASTRA

ASTRA es un prototipo. **Nada aquí es una integración certificada ni una recomendación médica.**
Las referencias NASA se usan como contexto de diseño; los documentos deben consultarse en su versión vigente antes de
trasladar cualquier valor al sistema. Donde este documento resume una fuente, el resumen es de alto nivel y debe
verificarse contra el original.

## Telemetría y datos OSD

- Los datos fisiológicos de alta frecuencia proceden del conjunto Inspiration4/LOFT
  distribuido por NASA OSDR. El procesamiento de Parquet a 256 Hz es offline y
  se ejecuta con `scripts/procesar_telemetria.py`.
- La consola Next.js no lee Parquet ni calcula estadística pesada: reproduce
  únicamente `public/samples/muestra_vuelo.json` a 8 Hz según
  `docs/FLIGHT_DATA_CONTRACT.md`.
- Los paneles CBC (OSD-569) y CMP (OSD-575) se importan como medidas lentas
  desde los archivos `*_TRANSFORMED` y `*_SUBMITTED`. Se evalúan con
  `intelligence.assess()` y su baseline personal de mediana + MAD; no usan la
  ventana móvil de 512 muestras.

Todas las reglas, z robustos, ventanas, histéresis y umbrales descritos para
ASTRA son decisiones experimentales del prototipo. **No son umbrales oficiales
de NASA, límites de exposición, criterios diagnósticos ni recomendaciones
médicas.**

| Pipeline | Datos | Regla ASTRA experimental | Ejecución |
|---|---|---|---|
| Flight playback | Inspiration4/LOFT fisiológico, 256 Hz | IQR robust z, umbral 3, histéresis de 1 s, salida 8 Hz | Offline |
| Laboratorio | OSDR OSD-569 CBC y OSD-575 CMP | Mediana + MAD, robust z ≥ 3 con baseline personal | Offline/import |

## Basado en fuentes NASA (como principio de diseño, no como valores)

| Comportamiento | Fuente de contexto |
|---|---|
| Existen evaluaciones médicas de misión (pre, en y post vuelo) que se programan como tareas `MISSION_RELATIVE` / `CLINICIAN_ORDERED` | NASA OCHMO-STD-100.1A |
| Monitoreo de salud, radiación y operaciones médicas como requisitos de la misión; los límites de exposición los define el estándar, no ASTRA | NASA-STD-3001 (Vol. 1) |
| Dosimetría personal activa continua, separada del monitoreo ambiental; la exposición se asocia a EVA | NASA Space Radiation Analysis Group; uso de Crew Active Dosimeter / REM / HERA en vuelo |
| Medidas estandarizadas y longitudinales por tripulante (línea base individual en lugar de umbrales poblacionales) | NASA Spaceflight Standard Measures |
| El ejercicio en vuelo es una contramedida programada e individualizada por el equipo de ejercicio | NASA Astronaut Exercise |
| Catálogo de dispositivos (Bio-Monitor, Actiwatch, T-Mini, Holter, CAD, REM/HERA, CO2, CHeCS) | Equipos referidos en el brief; **sin documentación técnica revisada** |

## Decisiones experimentales de ASTRA (no NASA)

| Decisión | Valor | Dónde |
|---|---|---|
| **Todas las frecuencias de protocolo** (ejercicio diario 09:00, FC reposo diaria, masa semanal, chequeo cada 14 MD, dosímetro −60/+30 min EVA) | `source_kind = ASTRA_DEMO_PLACEHOLDER` | `seed.py` |
| Criterio de sesión válida | ≥25 min de telemetría válida y ≥80 % de calidad | `seed.py` |
| Política de recordatorios | aviso 30 min antes, vencida a +60 min, escalamiento CRITICAL a +120 min | `protocols.DEFAULT_REMINDER` |
| Detector de desviación | z robusto (mediana, 1.4826·MAD) ≥ 3.0, ventana 28 d, mínimo 7 puntos, piso de dispersión por métrica | `intelligence.RULE` v1.0.0 |
| Ventana post-ejercicio | 60 min | `intelligence.RULE` |
| Sueño corto como contexto | < mediana − 2·SD robusta | `intelligence._context` |
| Modelo multivariante | IsolationForest (FC reposo + sueño), **solo consultivo**, nunca crea alertas | `intelligence._advisory` |
| Rangos de plausibilidad de entrada | rechazan errores de tipeo; **no son límites clínicos** | `intelligence.METRICS` |
| Sin puntuación global de salud | no existe índice validado | Dashboard |
| Escala de esfuerzo | Borg 6–20 | API `/sessions/{id}/rpe` |
| Dosis simulada | ~18 µGy/h personal, ~16 µGy/h área (números sintéticos para la UI) | `devices.radiation_snapshot` |

## Simulaciones (no integraciones)

- `bio-monitor-sim`, `cad-sim`, `rem-sim`: generadores sintéticos. La reproducción de 30 min está comprimida en el tiempo.
- `actiwatch`, `t-mini`, `holter-ecg`, `co2-monitor`, `checs`: `NOT_INTEGRATED`, visibles solo para mostrar el hueco.
- El "enlace con tierra" es un interruptor AOS/LOS; tierra es un segundo archivo SQLite en el mismo proceso.

## Para pasar de demo a uso real
1. Un flight surgeon crea versiones de protocolo con la fuente real (documento, sección, versión) y `source_kind = NASA_REFERENCE` o el tipo institucional que corresponda.
2. Validar clínicamente la regla de desviación (umbral, ventana, contexto) y versionarla.
3. Implementar adaptadores con la documentación de interfaz de cada equipo.

## Radiación (añadido)

| Decisión | Valor | Dónde |
|---|---|---|
| Muestreo de dosimetría continua simulada | cada 15 min (personal + área) | `devices.SENSOR_INTERVAL` |
| Dosis acumulada personal | integral de la tasa entre lecturas; nunca disminuye (regla de integridad, no límite) | `devices._integrated`, `store_reading` |
| Ingreso manual | fuente `MANUAL`; asociado a EVA si cae dentro de su ventana | `POST /radiation/readings` |
| Rango de entrada | 0–100 000 µGy/h (plausibilidad, no límite de exposición) | `main.RadiationIn` |

## Espacio clínico (añadido)

| Decisión | Valor | Dónde |
|---|---|---|
| Quién cambia el plan de cuidado | solo `FLIGHT_SURGEON` (el brief: "aprobar y modificar protocolos clínicos"); CMO verifica y escribe bitácora | `clinical.PLAN_ROLES` |
| Cambios de protocolo | siempre versión nueva por astronauta, con motivo, referencia, aprobador y vigencia; `source_kind = CLINICAL_DECISION` | `clinical.create/revise/retire_protocol` |
| Captura automática | solo métricas con sensor (simulado): FC en reposo vía Bio-Monitor simulado; si el sensor falla → incidencia operativa, la tarea queda abierta | `clinical.AUTO_CAPTURE_METRICS` |
| Revisión periódica de desviaciones | z robusto ≥ 3 por valor contra los 28 días previos a la ventana + desplazamiento sostenido de la media ≥ 1 SD robusta; mínimo 3 valores | `clinical.REVIEW_RULE` v1.0.0 (experimental) |
| Hallazgos de revisión | alerta MEDICAL + tarea de revisión CMO; nunca modifica el protocolo | `clinical.review` |
| Huecos de datos | ≥ 2 días sin datos en la ventana → alerta OPERATIONAL `DATA_GAP` | `clinical.review` |
| Bitácora | inmutable (adendas), privada por defecto; el astronauta ve solo entradas compartidas; cambios de plan y revisiones se anotan solos | `clinical.log`, `clinical_log` |
