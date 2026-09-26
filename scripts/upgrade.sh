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

# Back up the db first. This copy is the ONLY way back from a bad upgrade, so it is taken with a
# method that finishes, and it is verified before anything is changed.
#
# ⚠️ NOT `.backup`. The sqlite3 shell copies every page in ONE step while holding a read lock, so a
# single write from the running server aborts it with SQLITE_BUSY and it begins again at page one.
# On a busy database that never converges. Observed on production 2026-09-26: a 1.4 GB database with
# 33 displays heartbeating, sqlite3 at 94% CPU for over eight minutes with the destination frozen at
# 1227 MB. There is no error and no progress output, so the upgrade simply appears to hang — which
# is the worst way for a backup to fail, because the obvious response is to kill it and skip it.
#
# ⚠️ AND IT FAILS BY LOAD, NOT BY SIZE, so it passes every quiet-hour test. The nightly backup of
# that same database at 03:00 finishes in about 80 seconds. The upgrade you run at lunchtime does
# not finish at all.
#
# VACUUM INTO writes a fresh database from a single read transaction and completes on a busy WAL
# database. The same 1.4 GB production database took under a minute.
if [ -f "$DB" ]; then
  mkdir -p "$BACKUP_DIR"
  BK="$BACKUP_DIR/remote_display-pre-${TARGET}-$(date +%Y%m%d-%H%M%S).db"
  echo "==> Backing up db -> $BK"
  # VACUUM INTO refuses to write a destination that already exists.
  rm -f "$BK"

  # ⚠️ DECIDE ON THE VERSION, NOT ON THE FAILURE. Treating any VACUUM INTO error as "your sqlite is
  # too old" printed "VACUUM INTO unavailable (sqlite3 3.45.1)" when the real fault was an unreadable
  # source database — blaming the tool, naming a version that supports it perfectly well, and hiding
  # the actual error. A check that cannot tell "this is broken" from "I could not do it" sends you
  # to the wrong place with confidence.
  SQLITE_VER="$(sqlite3 --version 2>/dev/null | cut -d' ' -f1)"
  if [ -n "$SQLITE_VER" ] && [ "$(printf '%s\n3.27.0\n' "$SQLITE_VER" | sort -V | head -1)" = "3.27.0" ]; then
    sqlite3 "$DB" "VACUUM INTO '$BK'"   # any failure here is real: let it abort and show why
  else
    echo "    sqlite3 ${SQLITE_VER:-unknown} predates VACUUM INTO (3.27, 2019); using .backup,"
    echo "    which may stall on a busy database. Upgrading sqlite3 avoids that."
    sqlite3 "$DB" ".backup '$BK'"
  fi

  # ⚠️ THE COPY IS COMPACTED, so it is SMALLER than the source — 1405 MB -> 1004 MB on that run.
  # That is a complete database, not a truncated one. Judge it with integrity_check, never by size.
  INTEG="$(sqlite3 "$BK" 'PRAGMA integrity_check' 2>/dev/null | head -1)"
  if [ "$INTEG" != "ok" ]; then
    echo "ERROR: the backup failed its integrity check (${INTEG:-no answer})." >&2
    echo "       Refusing to upgrade: an unverified backup is not a way back." >&2
    exit 1
  fi
  echo "==> Backup verified ($(du -h "$BK" | cut -f1), integrity ok)"
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
