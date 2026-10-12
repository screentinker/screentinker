#!/bin/bash
# Upgrade a self-hosted ScreenTinker to a tagged release (default: the latest).
#
#   scripts/upgrade.sh           # upgrade to the highest vX.Y.Z tag
#   scripts/upgrade.sh v1.8.0    # upgrade to a specific tag
#
# Backs up the database first, checks out the tag (detached HEAD - you are now
# running a specific release, not a moving branch), installs production deps,
# restarts the server, and reports the running version. Schema migrations run
# automatically on the next boot.
#
# Restart: RESTART_CMD if set, else the systemd unit SERVICE_NAME if it exists, else the pm2
# process running this checkout's server/ (run the script as the user that owns it - pm2 is per
# user). If none of those applies, the script says so: the new code is installed but not running.
#
# Env overrides: SERVICE_NAME (systemd unit, default screentinker), RESTART_CMD, APP_DIR, DB,
# BACKUP_DIR, STATUS_URL.
set -Eeuo pipefail

# ⚠️ SAY WHICH STEP FAILED. Under `set -e` a failing command just ends the script, and its last
# visible line is whatever the PREVIOUS step printed. A self-hoster saw "==> Backup verified" and
# then nothing, reasonably concluded it had "crashed after the backup", and finished by hand with a
# `git pull` - which lands on main, not the release. Naming the step, and what has and has not
# changed, turns that into something they can act on.
STEP="starting"
on_error() {
  local rc=$?
  echo "" >&2
  echo "ERROR: the upgrade stopped while ${STEP} (exit ${rc}). The steps after it did not run." >&2
  [ -n "${BK:-}" ] && echo "       Your database backup is at $BK." >&2
  echo "       Fix the error above and run this script again; it is safe to re-run." >&2
  echo "       Do not finish with a plain 'git pull': that moves you to main, not a release." >&2
}
trap on_error ERR
# APP_DIR defaults to the checkout this script lives in, but is overridable like DB and BACKUP_DIR
# already were.
#
# ⚠️ WITHOUT THE OVERRIDE THIS SCRIPT CANNOT BE RUN FROM ANYWHERE ELSE, and there is a good reason to
# want to: upgrade.sh is itself tracked, so the copy that RUNS is the one from the release you are
# leaving, not the one you are going to. A fix to this file therefore does nothing for the very next
# upgrade — it takes effect one release later — unless an operator keeps a corrected copy outside the
# tree. Installed at /usr/local/bin, `dirname $0/..` resolved APP_DIR to /usr/local and it would have
# looked for the database there.
if [ -n "${APP_DIR:-}" ]; then
  cd "$APP_DIR"
else
  cd "$(dirname "$0")/.."
fi
APP_DIR="$(pwd)"
SERVICE_NAME="${SERVICE_NAME:-screentinker}"
# ⚠️ THE DATABASE IS NOT ALWAYS IN THE CHECKOUT. An install with DATA_DIR elsewhere (studiolab:
# /var/lib/screentinker, set in an EnvironmentFile) left this pointing at a file that does not
# exist, so the backup step said "fresh install" and the upgrade ran with no way back. Ask the
# running unit where its data is before falling back to the in-checkout default.
unit_env() {
  local key="$1" v="" f
  command -v systemctl >/dev/null 2>&1 || return 0
  v="$(systemctl show -p Environment --value "$SERVICE_NAME" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$key=//p" | tail -1)"
  for f in $(systemctl show -p EnvironmentFiles --value "$SERVICE_NAME" 2>/dev/null | sed 's/ (ignore_errors=[a-z]*)//g'); do
    if [ -r "$f" ]; then
      local fv
      fv="$(sed -n "s/^[[:space:]]*$key=//p" "$f" | tail -1 | tr -d "\"'")"
      [ -n "$fv" ] && v="$fv"
    fi
  done
  printf '%s' "$v"
}
if [ -z "${DB:-}" ]; then
  DB="$(unit_env DB_PATH)"
  if [ -z "$DB" ]; then
    _data="${DATA_DIR:-$(unit_env DATA_DIR)}"
    DB="${_data:-$APP_DIR/server}/db/remote_display.db"
  fi
fi
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"

STEP="fetching release tags"
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

# ⚠️ LOCAL EDITS STOP THE CHECKOUT, so find them before the backup rather than after it. `git
# checkout` refuses to overwrite a modified tracked file, and with the check here the operator is
# told which files and nothing has been touched yet.
STEP="checking for local changes"
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  echo "ERROR: these tracked files have local changes, and checking out $TARGET would overwrite them:" >&2
  printf '%s\n' "$DIRTY" | sed 's/^/         /' >&2
  echo "       Keep them with 'git stash' (and 'git stash pop' afterwards), or discard them with" >&2
  echo "       'git checkout -- <file>'. Then run this script again. Nothing has been changed." >&2
  trap - ERR
  exit 1
fi

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
STEP="backing up the database"
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
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"; then
  # A RUNNING service has a database somewhere; "fresh install" would be a guess, and a wrong one
  # means upgrading with no backup.
  echo "ERROR: no database at $DB, but $SERVICE_NAME is running." >&2
  echo "       Set DB=/path/to/remote_display.db (or DATA_DIR) and run again." >&2
  exit 1
else
  echo "==> No db at $DB yet (fresh install) - skipping backup"
fi

STEP="checking out $TARGET"
echo "==> Checking out $TARGET"
git checkout -q "$TARGET"

STEP="installing server dependencies (npm ci)"
echo "==> Installing server deps (npm ci --omit=dev)"
( cd server && npm ci --omit=dev )

# ⚠️ NOT EVERY INSTALL IS A SYSTEMD UNIT CALLED screentinker. The README's quick start is
# `npm start`, and people put that under pm2; a hard-coded `systemctl restart` then failed at the
# very end, leaving the new code on disk and the old process serving it. Find how this server is
# actually run, and when that cannot be found, say plainly that it is not restarted.
pm2_id_for_checkout() {
  command -v pm2 >/dev/null 2>&1 || return 0
  command -v node >/dev/null 2>&1 || return 0
  pm2 jlist 2>/dev/null | APP_SERVER="$APP_DIR/server" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s); } catch { return; }
      const dir = process.env.APP_SERVER;
      const p = list.find((x) => x.pm2_env && (x.pm2_env.pm_cwd === dir || x.pm2_env.pm_exec_path === dir + "/server.js"));
      if (p) process.stdout.write(String(p.pm_id));
    });' || true
}

STEP="restarting the server"
RESTARTED="" LOGS_HINT="the server's log"
if [ -n "${RESTART_CMD:-}" ]; then
  echo "==> Restarting: $RESTART_CMD"
  sh -c "$RESTART_CMD"
  RESTARTED=1
elif command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "==> Restarting $SERVICE_NAME (systemd)"
  sudo systemctl restart "$SERVICE_NAME"
  RESTARTED=1 LOGS_HINT="journalctl -u $SERVICE_NAME"
else
  PM2_ID="$(pm2_id_for_checkout)"
  if [ -n "$PM2_ID" ]; then
    # Plain restart, not --update-env: the process keeps the environment pm2 saved for it.
    echo "==> Restarting pm2 process $PM2_ID"
    pm2 restart "$PM2_ID"
    RESTARTED=1 LOGS_HINT="pm2 logs $PM2_ID"
  fi
fi
if [ -z "$RESTARTED" ]; then
  trap - ERR
  echo "" >&2
  echo "WARNING: $TARGET is installed, but the server was NOT restarted, so the old version is still" >&2
  echo "         running. No systemd unit '$SERVICE_NAME' and no pm2 process for $APP_DIR/server was" >&2
  echo "         found (pm2 is per user: run this script as the user that owns the process)." >&2
  echo "         Restart the server yourself now; migrations run when it starts. Next time, set" >&2
  echo "         SERVICE_NAME, or RESTART_CMD='<your restart command>', to do this automatically." >&2
  exit 2
fi

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
trap - ERR
echo "==> /api/status: ${OUT:-<no response - check: $LOGS_HINT>}"
echo "==> Upgrade to $TARGET complete. (Back to bleeding edge anytime: git checkout main)"
