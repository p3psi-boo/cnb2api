#!/bin/bash
# Workspace boot: install the MQTT client, copy src into a stable run dir,
# start the HTTP proxy, and let it advertise on the shared MQTT topic.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PROXY_RUN_DIR:-/workspace/proxy}"
PORT="${PROXY_PORT:-9001}"

mkdir -p "$RUN_DIR"
cp -f "$SRC_DIR"/package.json "$RUN_DIR/"
cp -f "$SRC_DIR"/src/*.mjs "$RUN_DIR/"
mkdir -p "$RUN_DIR/mqtt"
cp -f "$SRC_DIR"/src/mqtt/*.mjs "$RUN_DIR/mqtt/"

cd "$RUN_DIR"
if [ ! -d node_modules/mqtt ]; then
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi

pkill -f "node server.mjs" 2>/dev/null || true
sleep 0.5

nohup node server.mjs > proxy.log 2>&1 &

for i in $(seq 1 20); do
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "===== proxy self-check: health OK ====="
    curl -s --max-time 2 "http://127.0.0.1:${PORT}/health"; echo
    echo "===== models ====="
    curl -s --max-time 2 -H "Authorization: Bearer ${PROXY_KEY}" "http://127.0.0.1:${PORT}/v1/models"; echo
    echo "PROXY_URI=${CNB_VSCODE_PROXY_URI:-<env missing>}"
    if [ -n "${MQTT_BROKER:-}" ] && [ -n "${MQTT_TOPIC:-}" ] && [ -n "${MQTT_PSK:-}" ]; then
      echo "===== MQTT advertise enabled topic=${MQTT_TOPIC} ====="
    else
      echo "===== MQTT advertise skipped (MQTT_BROKER / MQTT_TOPIC / MQTT_PSK missing) ====="
    fi
    exit 0
  fi
  sleep 0.5
done

echo "===== proxy self-check FAILED after 10s ====="
tail -50 proxy.log || true
exit 1
