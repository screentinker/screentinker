#!/bin/sh
# ScreenTinker instance updater — the host-side half of Platform → System → "Update Now".
# See docs/instance-updater.md.
#
# The server never upgrades itself. It drops a request file into a spool it can write, and THIS
# script — root-owned, installed outside the app's reach — validates it and does the work: back
# up the database, fetch/pull the release, restart, verify, and roll back if the new version does
# not come up. Nothing here runs unless an admin pressed the button: there is no schedule and no
# "latest" lookup of its own.
#
#   UPDATER_MODE=git    systemd install (prod / studiolab shape). Run once per request by
#                       screentinker-updater.path -> screentinker-updater.service.
#   UPDATER_MODE=docker the updater sidecar in docker-compose. `st-updater.sh watch` polls.
#
# ⚠️ THE REQUEST FILE IS UNTRUSTED. It is written by the (less privileged) app, so a compromised
# app controls its contents. The only thing taken from it is a version number, and that must match
# a strict X.Y.Z pattern and be NEWER than what is running. Image repository, paths, service names
# and the git remote all come from this script's own environment, never from the request.
#
# ⚠️ OUTPUT GOES TO A DIRECTORY THE APP CANNOT WRITE ($UPDATER_STATUS_DIR). The request spool is
# app-writable, so a root process appending a log there would follow any symlink the app planted.
#
# POSIX sh on purpose: the docker sidecar is busybox (docker:cli), the systemd host is dash/bash.

set -u

MODE="${UPDATER_MODE:-}"
REQ_DIR="${UPDATER_REQUEST_DIR:-}"
OUT_DIR="${UPDATER_STATUS_DIR:-}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-240}"
POLL_SEC="${POLL_SEC:-5}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

die() { echo "st-updater: $*" >&2; exit 2; }
[ "$MODE" = git ] || [ "$MODE" = docker ] || die "UPDATER_MODE must be git or docker"
[ -n "$REQ_DIR" ] || die "UPDATER_REQUEST_DIR is required"
[ -n "$OUT_DIR" ] || die "UPDATER_STATUS_DIR is required"
mkdir -p "$OUT_DIR" || die "cannot create $OUT_DIR"

if [ "$MODE" = docker ]; then
  COMPOSE_FILE="${COMPOSE_FILE:?COMPOSE_FILE is required in docker mode}"
  APP_SERVICE="${APP_SERVICE:-screentinker}"
  IMAGE_REPO="${IMAGE_REPO:-ghcr.io/screentinker/screentinker}"
  DB_IN_CONTAINER="${DB_IN_CONTAINER:-/data/db/remote_display.db}"
  BACKUP_DIR_IN_CONTAINER="${BACKUP_DIR_IN_CONTAINER:-/data/db}"
  STATUS_URL="${STATUS_URL:-http://$APP_SERVICE:3001/api/status}"
else
  APP_DIR="${APP_DIR:?APP_DIR is required in git mode}"
  SERVICE_NAME="${SERVICE_NAME:-screentinker}"
  DB="${DB:?DB is required in git mode}"
  BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
  APP_USER="${APP_USER:-$(stat -c %U "$APP_DIR" 2>/dev/null)}"
  STATUS_URL="${STATUS_URL:-http://localhost:3001/api/status}"
  [ -n "${NODE_BIN_DIR:-}" ] && PATH="$NODE_BIN_DIR:$PATH" && export PATH
fi

# ---------- output ----------

LOG="$OUT_DIR/log.txt"
JOB_ID=""; JOB_TARGET=""; JOB_FROM=""; JOB_STARTED=0; JOB_BACKUP=""

jstr() { printf '%s' "$1" | tr -d '[:cntrl:]' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

log() {
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG"
  echo "$*"
}

# Run a command with its output in the job log (the dashboard shows the tail).
run_logged() {
  "$@" >> "$LOG" 2>&1
}

write_json() { # file, json — atomic, world-readable
  printf '%s\n' "$2" > "$1.tmp.$$" && chmod 644 "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"
}

set_status() { # state, message
  write_json "$OUT_DIR/status.json" "{\"id\":\"$(jstr "$JOB_ID")\",\"mode\":\"$MODE\",\"state\":\"$1\",\"target\":\"$(jstr "$JOB_TARGET")\",\"from\":\"$(jstr "$JOB_FROM")\",\"message\":\"$(jstr "$2")\",\"backup\":\"$(jstr "$JOB_BACKUP")\",\"started_at\":$JOB_STARTED,\"updated_at\":$(date +%s)}"
  log "[$1] $2"
}

heartbeat() {
  write_json "$OUT_DIR/updater.json" "{\"kind\":\"$MODE\",\"version\":1,\"heartbeat_at\":$(date +%s)}"
}

# ---------- helpers ----------

valid_ver() { printf '%s' "$1" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'; }

# a > b, both X.Y.Z
ver_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]
}

http_get() {
  if command -v curl >/dev/null 2>&1; then curl -skf --max-time 5 "$1" 2>/dev/null
  else wget -qO- -T 5 "$1" 2>/dev/null; fi
}

running_version() {
  http_get "$STATUS_URL" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# Wait until the server answers with version $1. Docker additionally waits for the healthcheck.
wait_for_version() {
  _deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _v="$(running_version)"
    if [ "$_v" = "$1" ]; then
      [ "$MODE" = git ] && return 0
      _h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(app_cid)" 2>/dev/null)"
      [ "$_h" = healthy ] || [ "$_h" = none ] && return 0
    fi
    sleep 3
  done
  return 1
}

# ---------- git mode ----------

as_owner() {
  if [ "$(id -u)" = 0 ] && [ -n "$APP_USER" ] && [ "$APP_USER" != root ]; then
    _home="$(getent passwd "$APP_USER" | cut -d: -f6)"
    runuser -u "$APP_USER" -- env PATH="$PATH" HOME="${_home:-/tmp}" "$@"
  else
    "$@"
  fi
}

git_backup() {
  if [ ! -f "$DB" ]; then
    # The studiolab trap: a DATA_DIR outside the checkout made upgrade.sh look in the wrong place,
    # say "fresh install" and upgrade with no backup. A running service HAS a database somewhere.
    set_status failed "No database at $DB. Set DB in the updater env to the live database."
    return 1
  fi
  command -v sqlite3 >/dev/null 2>&1 || { set_status failed "sqlite3 is not installed on the host (needed for the backup)."; return 1; }
  mkdir -p "$BACKUP_DIR" || { set_status failed "Cannot create $BACKUP_DIR"; return 1; }
  JOB_BACKUP="$BACKUP_DIR/remote_display-pre-v$JOB_TARGET-$(date +%Y%m%d-%H%M%S).db"
  set_status backup "Backing up the database to $JOB_BACKUP"
  rm -f "$JOB_BACKUP"
  # VACUUM INTO, not .backup: it converges on a busy WAL database (see scripts/upgrade.sh).
  run_logged sqlite3 "$DB" "VACUUM INTO '$JOB_BACKUP'" || { set_status failed "Database backup failed - nothing was changed."; return 1; }
  _integ="$(sqlite3 "$JOB_BACKUP" 'PRAGMA integrity_check' 2>/dev/null | head -1)"
  [ "$_integ" = ok ] || { set_status failed "Backup failed its integrity check (${_integ:-no answer}) - nothing was changed."; return 1; }
}

git_install() { # ref
  as_owner git -C "$APP_DIR" checkout -q "$1" >> "$LOG" 2>&1 || return 1
  ( cd "$APP_DIR/server" && as_owner npm ci --omit=dev --no-audit --no-fund ) >> "$LOG" 2>&1
}

git_rollback() { # why
  set_status rollback "$1 Rolling back to $JOB_FROM."
  if git_install "$PREV" && run_logged "$SYSTEMCTL" restart "$SERVICE_NAME" && wait_for_version "$JOB_FROM"; then
    set_status rolled_back "$1 Rolled back: $JOB_FROM is running again. Backup: $JOB_BACKUP"
  else
    set_status failed "$1 The rollback did not come back either - check: journalctl -u $SERVICE_NAME. Backup: $JOB_BACKUP"
  fi
}

do_git() {
  git_backup || return 0
  set_status fetch "Fetching release v$JOB_TARGET"
  run_logged as_owner git -C "$APP_DIR" fetch --tags --quiet origin || { set_status failed "git fetch failed - nothing was changed."; return 0; }
  as_owner git -C "$APP_DIR" rev-parse -q --verify "refs/tags/v$JOB_TARGET^{commit}" >/dev/null 2>&1 \
    || { set_status failed "There is no release tag v$JOB_TARGET - nothing was changed."; return 0; }
  # A checkout with local edits (a hot-deployed file) would either refuse or carry them along.
  if [ -n "$(as_owner git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    set_status failed "The checkout at $APP_DIR has local changes. Commit or discard them, then try again - nothing was changed."
    return 0
  fi
  PREV="$(as_owner git -C "$APP_DIR" rev-parse HEAD)"
  set_status install "Installing v$JOB_TARGET (checkout + npm ci)"
  git_install "v$JOB_TARGET" || { git_rollback "Installing v$JOB_TARGET failed."; return 0; }
  set_status restart "Restarting $SERVICE_NAME"
  run_logged "$SYSTEMCTL" restart "$SERVICE_NAME" || { git_rollback "The service would not restart."; return 0; }
  set_status verify "Waiting for v$JOB_TARGET to answer"
  wait_for_version "$JOB_TARGET" || { git_rollback "v$JOB_TARGET did not come up within ${VERIFY_TIMEOUT}s."; return 0; }
  set_status done "Now running v$JOB_TARGET. Backup: $JOB_BACKUP"
}

# ---------- docker mode ----------

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
app_cid() { compose ps -q "$APP_SERVICE" 2>/dev/null | head -1; }

# Runs inside the app container, so the database is read with the app's own better-sqlite3 (the
# image has no sqlite3). Paths arrive through env, never spliced into the script.
BACKUP_JS='
const D = require("better-sqlite3");
const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\x27") + "\x27";
new D(process.env.SRC, { readonly: true }).exec("VACUUM INTO " + q(process.env.DST));
const r = new D(process.env.DST, { readonly: true }).pragma("integrity_check", { simple: true });
process.stdout.write(String(r));
'

docker_rollback() { # why
  set_status rollback "$1 Rolling back to $JOB_FROM."
  if cp "$COMPOSE_BAK" "$COMPOSE_FILE" && run_logged compose up -d --no-deps --force-recreate "$APP_SERVICE" && wait_for_version "$JOB_FROM"; then
    set_status rolled_back "$1 Rolled back: $JOB_FROM is running again. Backup: $JOB_BACKUP"
  else
    set_status failed "$1 The rollback did not come back either - check: docker compose logs $APP_SERVICE. Backup: $JOB_BACKUP"
  fi
}

do_docker() {
  _cid="$(app_cid)"
  [ -n "$_cid" ] || { set_status failed "No running '$APP_SERVICE' container in $COMPOSE_FILE - nothing was changed."; return 0; }

  # The compose file must run the published image, exactly once, or there is nothing safe to edit.
  _re="$(printf '%s' "$IMAGE_REPO" | sed 's/[].[*^$\/]/\\&/g')"
  _n="$(grep -cE "^[[:space:]]*image:[[:space:]]*[\"']?$_re:" "$COMPOSE_FILE")"
  if [ "$_n" != 1 ]; then
    set_status failed "$COMPOSE_FILE does not run $IMAGE_REPO:<version> exactly once (found $_n) - update it by hand. Nothing was changed."
    return 0
  fi

  JOB_BACKUP="$BACKUP_DIR_IN_CONTAINER/pre-v$JOB_TARGET-$(date +%Y%m%d-%H%M%S).db"
  set_status backup "Backing up the database to $JOB_BACKUP (inside the container)"
  _integ="$(docker exec -e SRC="$DB_IN_CONTAINER" -e DST="$JOB_BACKUP" "$_cid" node -e "$BACKUP_JS" 2>>"$LOG")"
  [ "$_integ" = ok ] || { set_status failed "Database backup failed (${_integ:-no answer}) - nothing was changed."; return 0; }

  set_status pull "Pulling $IMAGE_REPO:$JOB_TARGET"
  run_logged docker pull "$IMAGE_REPO:$JOB_TARGET" || { set_status failed "Could not pull $IMAGE_REPO:$JOB_TARGET - nothing was changed."; return 0; }

  COMPOSE_BAK="$COMPOSE_FILE.bak-pre-v$JOB_TARGET"
  cp -p "$COMPOSE_FILE" "$COMPOSE_BAK" || { set_status failed "Could not back up $COMPOSE_FILE - nothing was changed."; return 0; }
  # Rewrite in place (cp, not sed -i/mv) so the file keeps its inode and owner.
  sed -E "s|^([[:space:]]*image:[[:space:]]*[\"']?)$_re:[^\"'[:space:]]+|\\1$IMAGE_REPO:$JOB_TARGET|" "$COMPOSE_BAK" > "$OUT_DIR/compose.new" \
    && cp "$OUT_DIR/compose.new" "$COMPOSE_FILE" && rm -f "$OUT_DIR/compose.new" \
    || { set_status failed "Could not rewrite $COMPOSE_FILE - nothing was changed."; cp "$COMPOSE_BAK" "$COMPOSE_FILE"; return 0; }

  set_status restart "Recreating $APP_SERVICE on $IMAGE_REPO:$JOB_TARGET"
  run_logged compose up -d --no-deps --force-recreate "$APP_SERVICE" || { docker_rollback "docker compose up failed."; return 0; }
  set_status verify "Waiting for v$JOB_TARGET to answer and pass its healthcheck"
  wait_for_version "$JOB_TARGET" || { docker_rollback "v$JOB_TARGET did not become healthy within ${VERIFY_TIMEOUT}s."; return 0; }
  set_status done "Now running v$JOB_TARGET. Backup: $JOB_BACKUP. Previous compose file: $COMPOSE_BAK"
}

# ---------- requests ----------

process_one() { # request file
  _f="$1"; _base="$(basename "$_f")"
  JOB_ID="${_base%.json}"; JOB_TARGET=""; JOB_FROM=""; JOB_BACKUP=""; JOB_STARTED="$(date +%s)"
  # Read it, then remove it, before anything else: a request is consumed exactly once even if
  # this job dies, so the path unit cannot loop on it.
  _raw=""
  if [ -f "$_f" ] && [ ! -L "$_f" ]; then _raw="$(head -c 4096 "$_f" 2>/dev/null)"; fi
  rm -f "$_f"
  : > "$LOG"; chmod 644 "$LOG"

  _t="$(printf '%s' "$_raw" | sed -n 's/.*"target"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9.]*\)".*/\1/p' | head -1)"
  if ! valid_ver "$_t"; then set_status failed "The request did not name a valid X.Y.Z version."; return; fi
  JOB_TARGET="$_t"

  JOB_FROM="$(running_version)"
  if ! valid_ver "$JOB_FROM"; then set_status failed "Could not read the running version from $STATUS_URL - nothing was changed."; return; fi
  if ! ver_gt "$JOB_TARGET" "$JOB_FROM"; then set_status failed "v$JOB_TARGET is not newer than the running v$JOB_FROM - nothing was changed."; return; fi

  set_status starting "Upgrade v$JOB_FROM -> v$JOB_TARGET requested"
  if [ "$MODE" = git ]; then do_git; else do_docker; fi
}

process_all() {
  [ -d "$REQ_DIR" ] || return 0
  # One at a time, oldest first; anything that is not a well-named request is discarded.
  for _f in "$REQ_DIR"/*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    case "$(basename "$_f")" in
      *.tmp) continue ;;  # the app is still writing it
    esac
    basename "$_f" | grep -Eq '^[A-Za-z0-9-]{8,64}\.json$' || { rm -f "$_f"; continue; }
    process_one "$_f"
    heartbeat
  done
}

# One updater at a time, whichever way it was started.
exec 9>"$OUT_DIR/.lock"
flock -n 9 || { echo "st-updater: another run holds the lock"; exit 0; }

case "${1:-once}" in
  once)  heartbeat; process_all ;;
  watch) while :; do heartbeat; process_all; sleep "$POLL_SEC"; done ;;
  *)     die "usage: st-updater.sh [once|watch]" ;;
esac
