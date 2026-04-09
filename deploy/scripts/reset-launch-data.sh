#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${BASE_DIR:-/root/cloud-store}"
BACKUP_LABEL="${BACKUP_LABEL:-before-launch-data-reset}"
APP_NAME="${APP_NAME:-cloud-store}"
CONFIRM_TEXT="${CONFIRM_TEXT:-RESET_LAUNCH_DATA}"
NODE_BIN="${NODE_BIN:-node}"

echo "warning: this script is for formal launch initialization only."
echo "it will clear products, banners, announcements, coupon templates, orders, refunds, carts, sessions, and all users except admin."
echo "categories and uploaded image files will be kept."
echo

if [[ "${FORCE_CONFIRM:-}" != "${CONFIRM_TEXT}" ]]; then
  read -r -p "type ${CONFIRM_TEXT} to continue: " USER_CONFIRM
  if [[ "${USER_CONFIRM}" != "${CONFIRM_TEXT}" ]]; then
    echo "confirmation mismatch, aborting."
    exit 1
  fi
fi

sudo bash "${BASE_DIR}/deploy/scripts/backup-manual.sh" "${BACKUP_LABEL}"

echo "stopping PM2 app: ${APP_NAME}"
pm2 stop "${APP_NAME}"

cleanup() {
  echo "starting PM2 app: ${APP_NAME}"
  pm2 start "${APP_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "running launch data reset"
BASE_DIR="${BASE_DIR}" "${NODE_BIN}" "${BASE_DIR}/deploy/scripts/reset-launch-data.js"

echo "restarting PM2 app: ${APP_NAME}"
pm2 restart "${APP_NAME}"

echo "running health check"
bash "${BASE_DIR}/deploy/scripts/check-health.sh"

trap - EXIT
echo "launch data reset finished successfully."
echo "next step: login with admin and manually verify products, banners, announcements, coupons, and users are empty."
