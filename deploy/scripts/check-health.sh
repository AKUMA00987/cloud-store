#!/usr/bin/env bash
set -euo pipefail

INTERNAL_URL="${INTERNAL_URL:-http://127.0.0.1:3000/healthz}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1/healthz}"

echo "[1/2] checking node health: ${INTERNAL_URL}"
curl --fail --silent --show-error "${INTERNAL_URL}"
echo
echo "[2/2] checking nginx health: ${PUBLIC_URL}"
curl --fail --silent --show-error "${PUBLIC_URL}"
echo
echo "health checks passed"
