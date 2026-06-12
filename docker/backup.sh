#!/usr/bin/env bash
# Back up the Teleport production state volume (cluster CA + all data).
# Run this ON THE PROD HOST. Schedule via cron (see docker/README.md, step 7).
#
# Usage:
#   VOLUME=docker_teleport-data OUT_DIR=/var/backups/teleport ./backup.sh
#
# Find the real volume name with:  docker volume ls   (usually <dir>_teleport-data)

set -euo pipefail

VOLUME="${VOLUME:-docker_teleport-data}"      # docker volume holding /var/lib/teleport
OUT_DIR="${OUT_DIR:-/var/backups/teleport}"   # where to drop the .tgz archives
KEEP="${KEEP:-14}"                            # how many archives to retain

# Timestamp without relying on locale; UTC for consistency.
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
ARCHIVE="teleport-data-${STAMP}.tgz"

mkdir -p "$OUT_DIR"

# Tar the volume from a throwaway container (read-only mount of the data).
docker run --rm \
  -v "${VOLUME}:/data:ro" \
  -v "${OUT_DIR}:/backup" \
  debian:12-slim \
  tar czf "/backup/${ARCHIVE}" -C /data .

# Retention: keep the newest $KEEP archives, delete the rest.
ls -1t "${OUT_DIR}"/teleport-data-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "backup written: ${OUT_DIR}/${ARCHIVE}"
echo "tip: copy ${OUT_DIR} off this machine (NAS/S3) so a disk failure can't take both."
