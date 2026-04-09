#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${BASE_DIR:-/root/cloud-store}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LABEL="${1:-manual}"
BACKUP_DIR="${BASE_DIR}/backups/manual/${STAMP}-${LABEL}"
DB_FILE="${DB_FILE:-${BASE_DIR}/cloud-store.sqlite}"
UPLOADS_DIR="${UPLOADS_DIR:-${BASE_DIR}/public/uploads}"
ENV_FILE="${ENV_FILE:-${BASE_DIR}/cloud-store.env}"
NGINX_CONF="${NGINX_CONF:-}"
SYSTEMD_FILE="${SYSTEMD_FILE:-/etc/systemd/system/cloud-store.service}"

if [[ -z "${NGINX_CONF}" ]]; then
  if [[ -f /etc/nginx/sites-available/cloud-store.conf ]]; then
    NGINX_CONF=/etc/nginx/sites-available/cloud-store.conf
  elif [[ -f /etc/nginx/conf.d/cloud-store.conf ]]; then
    NGINX_CONF=/etc/nginx/conf.d/cloud-store.conf
  else
    echo "nginx config not found: expected /etc/nginx/sites-available/cloud-store.conf or /etc/nginx/conf.d/cloud-store.conf"
    exit 1
  fi
fi

mkdir -p "${BACKUP_DIR}"

echo "creating manual backup in ${BACKUP_DIR}"
cp "${DB_FILE}" "${BACKUP_DIR}/cloud-store.sqlite"
tar -czf "${BACKUP_DIR}/uploads.tar.gz" -C "$(dirname "${UPLOADS_DIR}")" "$(basename "${UPLOADS_DIR}")"
cp "${ENV_FILE}" "${BACKUP_DIR}/cloud-store.env"
cp "${NGINX_CONF}" "${BACKUP_DIR}/cloud-store.conf"

if [[ -f "${SYSTEMD_FILE}" ]]; then
  cp "${SYSTEMD_FILE}" "${BACKUP_DIR}/cloud-store.service"
else
  echo "systemd service file not found, skipping backup: ${SYSTEMD_FILE}"
fi

echo "manual backup complete: ${BACKUP_DIR}"
