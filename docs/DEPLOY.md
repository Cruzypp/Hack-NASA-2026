# Despliegue y demo en vivo

## Qué demuestra
Un wearable envía una medición → ASTRA la compara con la línea base del astronauta → si el diferencial es
considerable (≥ 3 SD robustas; ≥ 5 = HIGH) crea una alerta médica y la suma a la revisión CMO → el médico la ve
**dentro de la aplicación** en menos de un segundo: aviso emergente, campana con no leídas y el signo vital
marcado en *Crew Health*. Sin recargar y sin canales externos.

```
wearable ──POST /webhooks/measurements──▶ backend ASTRA ──WebSocket──▶ consola del médico
```

La campana carga las alertas abiertas al iniciar sesión, así que lo ocurrido mientras el médico no estaba
conectado también aparece como no leído.

## Dónde desplegar

| Opción | Costo | Sirve para la demo | Notas |
|---|---|---|---|
| **Render Free** + Vercel | USD 0 | Sí, con cuidados | Se duerme tras 15 min sin tráfico de clientes y tarda ~1 min en despertar. Disco efímero: al reiniciar vuelve a los datos demo (ASTRA se re-siembra solo). 750 h/mes. La consola envía un latido por WebSocket cada minuto, así que no se duerme mientras esté abierta. |
| **Render Starter** + disco + Vercel | ~USD 7.25/mes | Sí | Siempre encendido, datos persistentes (disco 1 GB a USD 0.25). |
| **Fly.io** + Vercel | ~USD 3/mes (no se cobra si < USD 5) | Sí | Siempre encendido + volumen. Requiere `flyctl`. |
| Local + Cloudflare Quick Tunnel | USD 0 | Plan B | Sin garantía de disponibilidad. |

Recomendación: **Render Free** para la demo (abre la consola 2 minutos antes para despertarlo) o **Render
Starter** si quieren que los datos de la demo sobrevivan reinicios.

### Backend en Render
1. Sube el repo a GitHub (ya está en `Cruzypp/Hack-NASA-2026`).
2. Render → *New* → *Blueprint* → selecciona el repo. Usa `render.yaml` (Docker, `/health`).
3. Rellena las variables: `ASTRA_CORS` y `ASTRA_PUBLIC_URL` = URL del frontend; `ASTRA_DEVICE_KEYS` =
   `bio-monitor-sim:<secreto>` (genera uno con `openssl rand -hex 16`).
4. Para persistencia: cambia `plan` a `starter` y descomenta el bloque `disk`.

### Frontend en Vercel
Importar el repo → variable `NEXT_PUBLIC_ASTRA_API=https://<servicio>.onrender.com` → Deploy.
Después vuelve a Render y pon esa URL de Vercel en `ASTRA_CORS`.

### Fly.io (alternativa)
`fly.toml` está listo: `fly launch --no-deploy && fly volumes create astra_data --size 1 && fly deploy`.

## Guion de demo (3 minutos)
1. Proyector: consola como **Dr. K. Okafor** (CMO) en *Crew Health → Status*.
2. Valor normal: `ASTRA_API=https://<servicio>.onrender.com DEVICE_KEY=<secreto> ./scripts/send-reading.sh resting_hr 61`
   → sin alerta.
3. Valor anómalo: `./scripts/send-reading.sh resting_hr 93` → en < 1 s aparece el aviso, la campana se marca
   y el signo vital pasa a *Outside baseline* (z ≈ +17).
4. Un segundo indicador (p. ej. sueño corto registrado por el astronauta) se **suma a la misma** revisión CMO.
5. El CMO abre la revisión, ve ambos valores con su línea base y la verifica → las alertas se resuelven y todo
   queda en la bitácora y la auditoría.
6. Antes de presentar: campana → **Send test notification** para comprobar la cadena.

## Webhooks de salida (opcional)
No son necesarios para la demo. `ASTRA_WEBHOOKS` permite avisar a otros sistemas (p. ej. tierra) con JSON
firmado (`ASTRA_WEBHOOK_SECRET`), o a Slack/Discord. Por defecto no incluyen valores de salud.
