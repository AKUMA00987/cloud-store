#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /root/cloud-store-release"
  exit 1
fi

RELEASE_DIR="$1"
BASE_DIR="${BASE_DIR:-/root/cloud-store}"
PM2_APP_NAME="${PM2_APP_NAME:-cloud-store}"

bash "${BASE_DIR}/deploy/scripts/backup-manual.sh" before-release

cp "${RELEASE_DIR}/server.js" "${BASE_DIR}/server.js"

if [[ -d "${RELEASE_DIR}/public" ]]; then
  mkdir -p "${BASE_DIR}/public"
  find "${RELEASE_DIR}/public" -mindepth 1 -maxdepth 1 ! -name uploads -exec cp -R {} "${BASE_DIR}/public/" \;
fi

for file in package.json package-lock.json; do
  if [[ -f "${RELEASE_DIR}/${file}" ]]; then
    cp "${RELEASE_DIR}/${file}" "${BASE_DIR}/${file}"
  fi
done

pm2 restart "${PM2_APP_NAME}"
nginx -t
systemctl restart nginx

echo "release copied from ${RELEASE_DIR} into ${BASE_DIR}"
echo "pm2 app restarted: ${PM2_APP_NAME}"
echo "next step: run ${BASE_DIR}/deploy/scripts/check-health.sh"
