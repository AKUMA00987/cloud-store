#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /root/cloud-store/backups/manual/20260409-120000-before-release"
  exit 1
fi

BACKUP_DIR="$1"
BASE_DIR="${BASE_DIR:-/root/cloud-store}"
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

if systemctl list-unit-files | grep -q '^cloud-store\.service'; then
  systemctl stop cloud-store
else
  echo "cloud-store.service not found, skipping systemd stop"
fi

cp "${BACKUP_DIR}/cloud-store.sqlite" "${DB_FILE}"
rm -rf "${UPLOADS_DIR}"
mkdir -p "$(dirname "${UPLOADS_DIR}")"
tar -xzf "${BACKUP_DIR}/uploads.tar.gz" -C "$(dirname "${UPLOADS_DIR}")"
cp "${BACKUP_DIR}/cloud-store.env" "${ENV_FILE}"
cp "${BACKUP_DIR}/cloud-store.conf" "${NGINX_CONF}"

if [[ -f "${BACKUP_DIR}/cloud-store.service" ]]; then
  cp "${BACKUP_DIR}/cloud-store.service" "${SYSTEMD_FILE}"
else
  echo "backup does not contain cloud-store.service, skipping restore"
fi

systemctl daemon-reload
systemctl restart nginx

if systemctl list-unit-files | grep -q '^cloud-store\.service'; then
  systemctl start cloud-store
else
  echo "cloud-store.service not found, skipping systemd start"
fi

echo "restore complete, now run deploy/scripts/check-health.sh"
