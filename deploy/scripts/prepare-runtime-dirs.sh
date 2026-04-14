#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${BASE_DIR:-/root/cloud-store}"
SITE_SLUG="${SITE_SLUG:-$(basename "${BASE_DIR}")}"

mkdir -p "${BASE_DIR}/public"
mkdir -p "${BASE_DIR}/public/uploads"
mkdir -p "${BASE_DIR}/backups/manual"
mkdir -p "${BASE_DIR}/backups/daily"
mkdir -p "${BASE_DIR}/logs"

echo "runtime directories prepared for ${SITE_SLUG} under ${BASE_DIR}"
