#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /root/cloud-store/backups/manual/20260409-120000-before-release"
  exit 1
fi

BACKUP_DIR="$1"
BASE_DIR="${BASE_DIR:-/root/cloud-store}"
SITE_SLUG="${SITE_SLUG:-$(basename "${BASE_DIR}")}"
DB_FILE="${DB_FILE:-${BASE_DIR}/cloud-store.sqlite}"
UPLOADS_DIR="${UPLOADS_DIR:-${BASE_DIR}/public/uploads}"
ENV_FILE="${ENV_FILE:-${BASE_DIR}/cloud-store.env}"
NGINX_CONF="${NGINX_CONF:-}"
SYSTEMD_FILE="${SYSTEMD_FILE:-/etc/systemd/system/${SITE_SLUG}.service}"
SERVICE_NAME="${SERVICE_NAME:-${SITE_SLUG}}"
DB_BASENAME="$(basename "${DB_FILE}")"
ENV_BASENAME="$(basename "${ENV_FILE}")"
NGINX_BASENAME="${SITE_SLUG}.conf"
SYSTEMD_BASENAME="${SITE_SLUG}.service"

if [[ -z "${NGINX_CONF}" ]]; then
  for candidate in \
    "/etc/nginx/sites-available/${SITE_SLUG}.conf" \
    "/etc/nginx/conf.d/${SITE_SLUG}.conf" \
    "/etc/nginx/sites-available/cloud-store.conf" \
    "/etc/nginx/conf.d/cloud-store.conf"
  do
    if [[ -f "${candidate}" ]]; then
      NGINX_CONF="${candidate}"
      break
    fi
  done
  if [[ -z "${NGINX_CONF}" ]]; then
    echo "nginx config not found for ${SITE_SLUG}, skipping nginx restore"
  fi
fi

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\\.service"; then
  systemctl stop "${SERVICE_NAME}"
else
  echo "${SERVICE_NAME}.service not found, skipping systemd stop"
fi

if [[ -f "${BACKUP_DIR}/${DB_BASENAME}" ]]; then
  cp "${BACKUP_DIR}/${DB_BASENAME}" "${DB_FILE}"
elif [[ -f "${BACKUP_DIR}/cloud-store.sqlite" ]]; then
  cp "${BACKUP_DIR}/cloud-store.sqlite" "${DB_FILE}"
else
  echo "backup database not found, skipping restore"
fi

if [[ -f "${BACKUP_DIR}/uploads.tar.gz" ]]; then
  rm -rf "${UPLOADS_DIR}"
  mkdir -p "$(dirname "${UPLOADS_DIR}")"
  tar -xzf "${BACKUP_DIR}/uploads.tar.gz" -C "$(dirname "${UPLOADS_DIR}")"
else
  echo "backup uploads archive not found, skipping restore"
fi

if [[ -f "${BACKUP_DIR}/${ENV_BASENAME}" ]]; then
  cp "${BACKUP_DIR}/${ENV_BASENAME}" "${ENV_FILE}"
elif [[ -f "${BACKUP_DIR}/cloud-store.env" ]]; then
  cp "${BACKUP_DIR}/cloud-store.env" "${ENV_FILE}"
else
  echo "backup env file not found, skipping restore"
fi

if [[ -n "${NGINX_CONF}" ]]; then
  if [[ -f "${BACKUP_DIR}/${NGINX_BASENAME}" ]]; then
    cp "${BACKUP_DIR}/${NGINX_BASENAME}" "${NGINX_CONF}"
  elif [[ -f "${BACKUP_DIR}/cloud-store.conf" ]]; then
    cp "${BACKUP_DIR}/cloud-store.conf" "${NGINX_CONF}"
  else
    echo "backup nginx config not found, skipping restore"
  fi
fi

if [[ -f "${BACKUP_DIR}/${SYSTEMD_BASENAME}" ]]; then
  cp "${BACKUP_DIR}/${SYSTEMD_BASENAME}" "${SYSTEMD_FILE}"
elif [[ -f "${BACKUP_DIR}/cloud-store.service" ]]; then
  cp "${BACKUP_DIR}/cloud-store.service" "${SYSTEMD_FILE}"
else
  echo "backup does not contain ${SYSTEMD_BASENAME}, skipping restore"
fi

systemctl daemon-reload
if [[ -n "${NGINX_CONF}" ]]; then
  systemctl restart nginx
fi

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\\.service"; then
  systemctl start "${SERVICE_NAME}"
else
  echo "${SERVICE_NAME}.service not found, skipping systemd start"
fi

echo "restore complete, now run deploy/scripts/check-health.sh"
