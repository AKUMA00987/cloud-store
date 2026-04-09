#!/usr/bin/env bash
set -euo pipefail

TARGET="${TARGET:-/etc/cron.d/cloud-store-backup}"
SCRIPT_PATH="${SCRIPT_PATH:-/root/cloud-store/deploy/scripts/backup-daily.sh}"

cat > "${TARGET}" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 3 * * * root ${SCRIPT_PATH} >> /root/cloud-store/logs/backup.log 2>&1
EOF

chmod 644 "${TARGET}"
echo "installed cron file at ${TARGET}"
