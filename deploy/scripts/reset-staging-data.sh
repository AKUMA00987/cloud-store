#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${BASE_DIR:-/root/cloud-store-staging}"
BACKUP_LABEL="${BACKUP_LABEL:-before-staging-data-reset}"
APP_NAME="${APP_NAME:-cloud-store-staging}"
CONFIRM_TEXT="${CONFIRM_TEXT:-RESET_STAGING_DATA}"
NODE_BIN="${NODE_BIN:-node}"
APP_PORT="${APP_PORT:-3001}"
SITE_SLUG="${SITE_SLUG:-$(basename "${BASE_DIR}")}"
INTERNAL_HEALTH_URL="${INTERNAL_HEALTH_URL:-http://127.0.0.1:${APP_PORT}/healthz}"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-1}"

echo "warning: this script resets the online staging environment only."
echo "it will clear staging users, products, coupons, carts, orders, refunds, sessions, sms codes, banners, and announcements."
echo "it will then rebuild a minimal staging baseline with admin, test buyers, categories, products, and coupons."
echo

if [[ "${FORCE_CONFIRM:-}" != "${CONFIRM_TEXT}" ]]; then
  read -r -p "type ${CONFIRM_TEXT} to continue: " USER_CONFIRM
  if [[ "${USER_CONFIRM}" != "${CONFIRM_TEXT}" ]]; then
    echo "confirmation mismatch, aborting."
    exit 1
  fi
fi

sudo BASE_DIR="${BASE_DIR}" SITE_SLUG="${SITE_SLUG}" bash "${BASE_DIR}/deploy/scripts/backup-manual.sh" "${BACKUP_LABEL}"

echo "stopping PM2 app: ${APP_NAME}"
pm2 stop "${APP_NAME}"

cleanup() {
  echo "starting PM2 app: ${APP_NAME}"
  pm2 start "${APP_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "running staging data reset"
BASE_DIR="${BASE_DIR}" "${NODE_BIN}" "${BASE_DIR}/deploy/scripts/reset-staging-data.js"

echo "restarting PM2 app: ${APP_NAME}"
pm2 restart "${APP_NAME}"

echo "waiting for node health: ${INTERNAL_HEALTH_URL}"
for attempt in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl --fail --silent --show-error "${INTERNAL_HEALTH_URL}" >/dev/null 2>&1; then
    echo "node health ready after ${attempt} attempt(s)"
    break
  fi
  if [[ "${attempt}" == "${HEALTH_RETRIES}" ]]; then
    echo "node health did not become ready in time: ${INTERNAL_HEALTH_URL}"
    exit 1
  fi
  sleep "${HEALTH_SLEEP_SECONDS}"
done

echo "running health check"
APP_PORT="${APP_PORT}" PUBLIC_URL="${PUBLIC_URL:-}" bash "${BASE_DIR}/deploy/scripts/check-health.sh"

trap - EXIT
echo "staging data reset finished successfully."
echo "next step: verify admin login, password buyer login, sms buyer login, and sample product checkout in staging."
