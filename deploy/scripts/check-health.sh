#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${APP_PORT:-3000}"
INTERNAL_URL="${INTERNAL_URL:-http://127.0.0.1:${APP_PORT}/healthz}"
PUBLIC_URL="${PUBLIC_URL:-}"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-1}"

check_with_retry() {
  local label="$1"
  local url="$2"

  for attempt in $(seq 1 "${HEALTH_RETRIES}"); do
    if curl --fail --silent --show-error "${url}"; then
      echo
      return 0
    fi
    if [[ "${attempt}" == "${HEALTH_RETRIES}" ]]; then
      return 1
    fi
    sleep "${HEALTH_SLEEP_SECONDS}"
  done
}

echo "[1/2] checking node health: ${INTERNAL_URL}"
check_with_retry "node health" "${INTERNAL_URL}"
if [[ -n "${PUBLIC_URL}" ]]; then
  echo "[2/2] checking nginx health: ${PUBLIC_URL}"
  check_with_retry "nginx health" "${PUBLIC_URL}"
else
  echo "[2/2] public url skipped (set PUBLIC_URL to enable nginx health check)"
fi
echo "health checks passed"
