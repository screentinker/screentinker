#!/bin/bash
# Upgrade a self-hosted ScreenTinker to a tagged release (default: the latest).
#
#   scripts/upgrade.sh           # upgrade to the highest vX.Y.Z tag
#   scripts/upgrade.sh v1.8.0    # upgrade to a specific tag
#
# Backs up the database first, checks out the tag (detached HEAD - you are now
# running a specific release, not a moving branch), installs production deps,
# restarts the service, and reports the running version. Schema migrations run
# automatically on the next boot.
#
# Env overrides: SERVICE_NAME (systemd unit, default screentinker), DB,
# BACKUP_DIR, STATUS_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
SERVICE_NAME="${SERVICE_NAME:-screentinker}"
DB="${DB:-$APP_DIR/server/db/remote_display.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"

echo "==> Fetching tags"
git fetch --tags origin

# Target tag: explicit arg, or the highest semver v* tag. #80: exclude pre-release
# tags (-rc/-beta/-alpha) from the default - GNU `sort -V` ranks 1.9.0-rc1 ABOVE the
# final 1.9.0, so an unfiltered default would silently pick an RC. An explicit arg
# still lets you target a pre-release deliberately (scripts/upgrade.sh v1.9.0-rc1).
TARGET="${1:-$(git tag -l 'v*' | grep -vE -- '-(rc|beta|alpha|pre)' | sort -V | tail -1)}"
if [ -z "$TARGET" ] || ! git rev-parse -q --verify "refs/tags/$TARGET^{commit}" >/dev/null; then
  echo "ERROR: no such release tag: '${TARGET:-<none found>}'" >&2
  exit 1
fi
echo "==> Target release: $TARGET"

# Back up the db first (reuses backup.sh's .backup - a consistent online copy).
if [ -f "$DB" ]; then
  mkdir -p "$BACKUP_DIR"
  BK="$BACKUP_DIR/remote_display-pre-${TARGET}-$(date +%Y%m%d-%H%M%S).db"
  echo "==> Backing up db -> $BK"
  sqlite3 "$DB" ".backup '$BK'"
else
  echo "==> No db at $DB yet (fresh install) - skipping backup"
fi

echo "==> Checking out $TARGET"
git checkout -q "$TARGET"

echo "==> Installing server deps (npm ci --omit=dev)"
( cd server && npm ci --omit=dev )

echo "==> Restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# Best-effort: report the running version. Tries HTTP :3001 then HTTPS :3443.
echo "==> Waiting for the service to answer..."
OUT=""
for i in $(seq 1 30); do
  for URL in "${STATUS_URL:-}" http://localhost:3001/api/status https://localhost:3443/api/status; do
    [ -z "$URL" ] && continue
    OUT="$(curl -skf "$URL" 2>/dev/null || true)"
    [ -n "$OUT" ] && break
  done
  [ -n "$OUT" ] && break
  sleep 1
done
echo "==> /api/status: ${OUT:-<no response - check: journalctl -u $SERVICE_NAME>}"
echo "==> Upgrade to $TARGET complete. (Back to bleeding edge anytime: git checkout main)"
