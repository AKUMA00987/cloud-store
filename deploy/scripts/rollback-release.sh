#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /root/cloud-store/backups/manual/20260409-120000-before-release"
  exit 1
fi

BACKUP_DIR="$1"
BASE_DIR="${BASE_DIR:-/root/cloud-store}"

bash "${BASE_DIR}/deploy/scripts/restore-from-backup.sh" "${BACKUP_DIR}"

echo "rollback complete from backup: ${BACKUP_DIR}"
echo "next step: run ${BASE_DIR}/deploy/scripts/check-health.sh"
