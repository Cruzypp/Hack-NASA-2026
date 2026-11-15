#!/usr/bin/env bash
# Simulates a wearable / device gateway posting one reading to ASTRA's inbound webhook.
#   ASTRA_API=https://astra-health-demo.fly.dev DEVICE_KEY=... ./scripts/send-reading.sh resting_hr 92 [CM-01]
set -euo pipefail
API="${ASTRA_API:-http://localhost:8000}"
METRIC="${1:?metric, e.g. resting_hr}"
VALUE="${2:?value, e.g. 92}"
CREW="${3:-CM-01}"
curl -sS -X POST "$API/webhooks/measurements" \
  -H "X-ASTRA-Device: ${DEVICE_ID:-bio-monitor-sim}" \
  -H "Authorization: Bearer ${DEVICE_KEY:?set DEVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"crew_member_id\":\"$CREW\",\"metric\":\"$METRIC\",\"value\":$VALUE}"
echo
