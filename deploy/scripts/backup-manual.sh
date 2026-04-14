#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${BASE_DIR:-/root/cloud-store}"
SITE_SLUG="${SITE_SLUG:-$(basename "${BASE_DIR}")}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LABEL="${1:-manual}"
BACKUP_DIR="${BASE_DIR}/backups/manual/${STAMP}-${LABEL}"
DB_FILE="${DB_FILE:-${BASE_DIR}/cloud-store.sqlite}"
UPLOADS_DIR="${UPLOADS_DIR:-${BASE_DIR}/public/uploads}"
ENV_FILE="${ENV_FILE:-${BASE_DIR}/cloud-store.env}"
NGINX_CONF="${NGINX_CONF:-}"
SYSTEMD_FILE="${SYSTEMD_FILE:-/etc/systemd/system/${SITE_SLUG}.service}"
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
    echo "nginx config not found for ${SITE_SLUG}, skipping nginx backup"
  fi
fi

mkdir -p "${BACKUP_DIR}"

echo "creating manual backup in ${BACKUP_DIR}"
if [[ -f "${DB_FILE}" ]]; then
  cp "${DB_FILE}" "${BACKUP_DIR}/${DB_BASENAME}"
else
  echo "database file not found, skipping backup: ${DB_FILE}"
fi
if [[ -d "${UPLOADS_DIR}" ]]; then
  tar -czf "${BACKUP_DIR}/uploads.tar.gz" -C "$(dirname "${UPLOADS_DIR}")" "$(basename "${UPLOADS_DIR}")"
else
  echo "uploads directory not found, skipping backup: ${UPLOADS_DIR}"
fi
if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${BACKUP_DIR}/${ENV_BASENAME}"
else
  echo "env file not found, skipping backup: ${ENV_FILE}"
fi
if [[ -n "${NGINX_CONF}" && -f "${NGINX_CONF}" ]]; then
  cp "${NGINX_CONF}" "${BACKUP_DIR}/${NGINX_BASENAME}"
fi

if [[ -f "${SYSTEMD_FILE}" ]]; then
  cp "${SYSTEMD_FILE}" "${BACKUP_DIR}/${SYSTEMD_BASENAME}"
else
  echo "systemd service file not found, skipping backup: ${SYSTEMD_FILE}"
fi

echo "manual backup complete: ${BACKUP_DIR}"
