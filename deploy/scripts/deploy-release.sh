#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_LEGACY_SYSTEMD_DEPLOY:-}" != "1" ]]; then
  echo "legacy script blocked: deploy-release.sh is no longer the default release entrypoint"
  echo "use instead: /root/cloud-store/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release"
  echo "if you really need the old systemd-for-app flow, rerun with:"
  echo "ALLOW_LEGACY_SYSTEMD_DEPLOY=1 bash /root/cloud-store/deploy/scripts/deploy-release.sh /root/cloud-store-release"
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /root/cloud-store-release"
  exit 1
fi

RELEASE_DIR="$1"
BASE_DIR="${BASE_DIR:-/root/cloud-store}"

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

echo "legacy mode: restarting app via systemd cloud-store service"
systemctl restart cloud-store
nginx -t
systemctl reload nginx

echo "release copied from ${RELEASE_DIR} into ${BASE_DIR}"
echo "legacy systemd app release completed"
echo "next step: run ${BASE_DIR}/deploy/scripts/check-health.sh"
