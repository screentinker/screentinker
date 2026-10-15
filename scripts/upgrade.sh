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
  type record >/dev/null 2>&1 && record failed "stopped while ${STEP} (exit ${rc})"
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

# ---------- the upgrade history: what every run came from, went to, and changed ----------
#
# One JSON line per run in $BACKUP_DIR/upgrade-history.jsonl, whatever the outcome (refused,
# rolled back, failed, done), so "it was fine yesterday" can be answered: which release and commit
# it came from, the Node before and after, anything this run installed on the host, and where the
# database backup is. Written before every exit; never allowed to fail the upgrade itself.
PREV_REF="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
PREV_NAME="$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo unknown)"
NODE_BEFORE="$(node -v 2>/dev/null || echo none)"
HOST_CHANGES=""   # what this run changed on the HOST (Node, packages), with where the old state was saved
HISTORY="$BACKUP_DIR/upgrade-history.jsonl"
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
record() { # result detail
  mkdir -p "$BACKUP_DIR" 2>/dev/null || return 0
  printf '{"at":"%s","by":"%s","result":"%s","from":"%s","from_commit":"%s","to":"%s","node_before":"%s","node_after":"%s","host_changes":"%s","backup":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "$(id -un 2>/dev/null)")" "$1" "$(json_str "$PREV_NAME")" "$PREV_REF" \
    "$(json_str "${TARGET:-}")" "$NODE_BEFORE" "$(node -v 2>/dev/null || echo none)" "$(json_str "$HOST_CHANGES")" \
    "$(json_str "${BK:-}")" "$(json_str "$2")" >> "$HISTORY" 2>/dev/null || true
}

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
  record refused "no such release tag"
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
  record refused "local changes to tracked files"
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
    record failed "backup failed its integrity check"
    exit 1
  fi
  echo "==> Backup verified ($(du -h "$BK" | cut -f1), integrity ok)"
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"; then
  # A RUNNING service has a database somewhere; "fresh install" would be a guess, and a wrong one
  # means upgrading with no backup.
  echo "ERROR: no database at $DB, but $SERVICE_NAME is running." >&2
  echo "       Set DB=/path/to/remote_display.db (or DATA_DIR) and run again." >&2
  record refused "no database found while the service is running"
  exit 1
else
  echo "==> No db at $DB yet (fresh install) - skipping backup"
fi

# ---------- what the TARGET needs from this host: checked, and fixed with the operator's yes ----------
#
# Painless where it can be: when the host is missing something the release needs, the operator at
# the terminal is asked, and a yes installs it and carries on. Nobody is asked when there is no
# terminal (cron, CI, a pipe): then it stops exactly as before, unless ST_AUTO_INSTALL_PREREQS=1
# says yes in advance. Only what apt manages is touched; anything else is described, not guessed at.
SUDO=""; [ "$(id -u)" != 0 ] && SUDO="sudo"
# ⚠️ apt NEVER READS THE TERMINAL. Left attached it swallowed the keystroke meant for the next
# prompt (which then waited for ever), and dpkg can stop on a config-file question mid-upgrade.
apt_get() { $SUDO env DEBIAN_FRONTEND=noninteractive apt-get "$@" < /dev/null; }
confirm() { # question
  [ "${ST_AUTO_INSTALL_PREREQS:-0}" = "1" ] && { echo "    $1 yes (ST_AUTO_INSTALL_PREREQS=1)"; return 0; }
  [ -t 0 ] && [ -r /dev/tty ] || return 1
  local ans=""
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r ans < /dev/tty || return 1
  case "$ans" in ""|y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

# Node <major>.x from NodeSource's apt repository: what setup_<major>.x sets up, without running a
# downloaded script. Refuses a node that apt does not own (nvm, a tarball, a custom path): upgrading
# a different node than the one the service runs would change nothing, or the wrong thing.
upgrade_node() { # major
  local major="$1" real
  command -v apt-get >/dev/null 2>&1 || { echo "    No apt-get on this host: install Node $major.x yourself (https://nodejs.org), then run this again." >&2; return 1; }
  real="$(readlink -f "$(command -v node 2>/dev/null || echo /nonexistent)" 2>/dev/null || true)"
  if [ -e "$real" ] && ! dpkg -S "$real" >/dev/null 2>&1; then
    echo "    Node here is $real, which apt does not manage (nvm, a tarball...). Upgrade that install" >&2
    echo "    to Node $major.x yourself, make sure the service runs it, then run this again." >&2
    return 1
  fi
  # Saved BEFORE anything changes, and named in the history, so Node can be put back exactly.
  local saved; saved="$BACKUP_DIR/node-apt-before-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$saved" || return 1
  for f in /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/preferences.d/nodejs; do
    [ -e "$f" ] && cp -p "$f" "$saved/"
  done
  printf '%s\n' "$NODE_BEFORE" > "$saved/node-version"
  HOST_CHANGES="${HOST_CHANGES}Node $NODE_BEFORE -> NodeSource node_${major}.x (previous apt files and version in $saved); "
  echo "==> Installing Node $major.x from NodeSource's apt repository (previous setup saved in $saved)"
  apt_get install -y -qq ca-certificates curl gnupg >/dev/null || return 1
  $SUDO install -d -m 0755 /etc/apt/keyrings || return 1
  [ -s /etc/apt/keyrings/nodesource.gpg ] || curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg || return 1
  # Replaces the list an older setup_<N>.x wrote (either format), pinned over the distribution's own.
  $SUDO rm -f /etc/apt/sources.list.d/nodesource.sources
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${major}.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null || return 1
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' | $SUDO tee /etc/apt/preferences.d/nodejs >/dev/null || return 1
  apt_get update -qq && apt_get install -y -qq nodejs
}

node_ok() { [ -z "$NODE_FLOOR" ] || [ "$(printf '%s\n%s\n' "$NODE_FLOOR" "$(node -p 'process.versions.node' 2>/dev/null || echo 0)" | sort -V | head -1)" = "$NODE_FLOOR" ]; }

# The Node the TARGET release declares. Read from the tag with git show, because the copy of this
# script that runs is the one from the release being LEFT: a check that only looked at the checkout
# would see the old floor.
#
# ⚠️ BELOW THE FLOOR THE NEW RELEASE DOES NOT START (better-sqlite3 13 needs Node-API 10; the server
# stops at boot with "upgrade Node"), so this never just warns and carries on. ST_ALLOW_OLD_NODE=1
# proceeds anyway (and skips the driver check after the install), for an operator who runs the
# built-in driver on purpose (ST_SQLITE_DRIVER=node on Node 22.13+).
#
# Upgrading Node first is safe for the release being left: 2.6.x runs on Node 22 too, so a rollback
# after this point still has a server that starts.
STEP="checking the Node version $TARGET needs"
TARGET_PKG="$(git show "$TARGET:server/package.json" 2>/dev/null || true)"
NODE_FLOOR="$(printf '%s' "$TARGET_PKG" | sed -n 's/.*"node": *">= *v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' | head -1)"
if ! node_ok; then
  NODE_HAVE="$(node -p 'process.versions.node' 2>/dev/null || echo none)"
  if [ "${ST_ALLOW_OLD_NODE:-0}" = "1" ]; then
    echo "WARNING: $TARGET needs Node >= $NODE_FLOOR; this host has Node $NODE_HAVE. Going ahead (ST_ALLOW_OLD_NODE=1)." >&2
  else
    echo "ERROR: $TARGET needs Node >= $NODE_FLOOR; this host has Node $NODE_HAVE, and the new release would not start on it." >&2
    STEP="upgrading Node"
    if confirm "Upgrade Node to ${NODE_FLOOR%%.*}.x now?" && upgrade_node "${NODE_FLOOR%%.*}" && node_ok; then
      echo "==> Node is now $(node -v)"
    else
      echo "       Upgrade Node to >= $NODE_FLOOR (see \"Upgrading Node.js\" in docs/operations.md), then run" >&2
      echo "       this script again. Your server and its release have not been changed." >&2
      record refused "needs Node >= $NODE_FLOOR, host has $NODE_HAVE"
      trap - ERR; exit 1
    fi
  fi
fi

# ⚠️ THE NODE ON PATH IS NOT NECESSARILY THE NODE THE SERVICE RUNS. A unit with an nvm path in
# ExecStart (the 2.x remotedisplay.service template shipped one for Node 20) passed every check
# above on a host whose PATH node was 22, then restarted onto Node 20 and stopped at boot. Ask the
# unit which binary it starts and hold THAT to the floor too. (Since 3.0 the server refuses to start
# below the floor with exit 78 rather than crash-looping, so this is the friendlier, earlier copy.)
service_node() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || return 0
  systemctl show -p ExecStart --value "$SERVICE_NAME" 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1
}
SVC_NODE="$(service_node)"
if [ -n "$SVC_NODE" ] && [ -n "$NODE_FLOOR" ] && [ "$(basename "$SVC_NODE")" = "node" ] && [ "${ST_ALLOW_OLD_NODE:-0}" != "1" ]; then
  STEP="checking the Node the $SERVICE_NAME service runs"
  SVC_HAVE="$("$SVC_NODE" -p 'process.versions.node' 2>/dev/null || echo none)"
  if [ "$(printf '%s\n%s\n' "$NODE_FLOOR" "$SVC_HAVE" | sort -V | head -1)" != "$NODE_FLOOR" ]; then
    echo "ERROR: the $SERVICE_NAME service starts $SVC_NODE (Node $SVC_HAVE), but $TARGET needs Node >= $NODE_FLOOR." >&2
    echo "       Point ExecStart at a Node >= $NODE_FLOOR (e.g. $(command -v node 2>/dev/null || echo /usr/bin/node), which is $(node -v 2>/dev/null || echo missing))" >&2
    echo "       with 'sudo systemctl edit --full $SERVICE_NAME', then run this script again." >&2
    record refused "service $SERVICE_NAME runs $SVC_NODE (Node $SVC_HAVE), needs >= $NODE_FLOOR"
    trap - ERR; exit 1
  fi
fi

# ⚠️ A BUILD TOOLCHAIN, EVEN WHERE A PREBUILT BINARY EXISTS. npm runs better-sqlite3's `node-gyp
# rebuild` install step regardless, node-gyp cannot start without python3, make and g++, and npm
# then drops the module SILENTLY as a failed optional dependency: the install "succeeds" and the
# server comes up on the experimental built-in driver, or not at all.
NATIVE_DRIVER=0
missing_tools() { local m=""; for t in python3 make g++; do command -v "$t" >/dev/null 2>&1 || m="$m $t"; done; printf '%s' "$m"; }
if printf '%s' "$TARGET_PKG" | grep -q '"better-sqlite3"' && [ "${ST_SQLITE_DRIVER:-}" != "node" ] && [ "${ST_ALLOW_OLD_NODE:-0}" != "1" ]; then
  NATIVE_DRIVER=1
  STEP="checking the build toolchain"
  MISSING="$(missing_tools)"
  if [ -n "$MISSING" ] && [ "${ST_SKIP_TOOLCHAIN_CHECK:-0}" != "1" ]; then
    echo "ERROR: missing:$MISSING. npm needs them to install the database driver (even prebuilt)," >&2
    echo "       and without them it skips the driver without saying so." >&2
    STEP="installing the build toolchain"
    if command -v apt-get >/dev/null 2>&1 && confirm "Install python3, make and g++ now?" \
       && apt_get install -y -qq python3 make g++ && [ -z "$(missing_tools)" ]; then
      HOST_CHANGES="${HOST_CHANGES}apt-get installed python3 make g++ (was missing:$MISSING); "
      echo "==> Build toolchain installed"
    else
      echo "       Install them (e.g. sudo apt-get install -y python3 make g++), then run this script" >&2
      echo "       again. Your server and its release have not been changed." >&2
      record refused "missing build toolchain:$MISSING"
      trap - ERR; exit 1
    fi
  fi
fi

STEP="checking out $TARGET"
echo "==> Checking out $TARGET (from $PREV_NAME)"
git checkout -q "$TARGET"

STEP="installing server dependencies (npm ci)"
echo "==> Installing server deps (npm ci --omit=dev)"
( cd server && npm ci --omit=dev )

# ⚠️ PROVE THE DRIVER LOADS BEFORE RESTARTING. Opening a database, not just requiring it: the binary
# is loaded lazily. The old server is still the one running, so a failure here costs nothing: put
# the previous release back on disk and stop, instead of restarting into a server that cannot start.
if [ "$NATIVE_DRIVER" = 1 ]; then
  STEP="checking the database driver loads"
  if ! ( cd server && node -e "const D = require('better-sqlite3'); new D(':memory:').close()" ) >/dev/null 2>&1; then
    echo "ERROR: better-sqlite3 is missing or will not load after the install." >&2
    echo "       Putting $PREV_NAME back so the running server's code stays consistent..." >&2
    STEP="rolling back to $PREV_NAME"
    git checkout -q "$PREV_REF"
    ( cd server && npm ci --omit=dev ) >/dev/null 2>&1 || echo "       (npm ci for $PREV_NAME failed too: run it in server/ by hand)" >&2
    echo "       Rolled back to $PREV_NAME; the server was not restarted. Check the npm output above." >&2
    record rolled_back "better-sqlite3 missing or not loading after npm ci; $PREV_NAME checked back out, not restarted"
    trap - ERR; exit 1
  fi
  echo "==> Database driver loads"
fi

# #634: build the native Raspberry Pi player for the release just checked out, so /download/pi
# serves it. The .deb is not in git (native/dist/ is ignored), so a git install never had one and
# `raspberry-pi-setup.sh --native` got a 404. Best effort: the server runs fine without it.
STEP="building the Raspberry Pi player package"
if command -v dpkg-deb >/dev/null 2>&1 && command -v rsync >/dev/null 2>&1; then
  if PI_DEB="$(native/packaging/linux/build-deb.sh 2>&1 | tail -1)" && [ -s "$PI_DEB" ]; then
    echo "==> Raspberry Pi player package: ${PI_DEB#"$PWD"/}"
  else
    echo "WARNING: could not build the Raspberry Pi player package; /download/pi will not offer it." >&2
  fi
else
  echo "NOTE: dpkg-deb or rsync is missing, so the Raspberry Pi player package was not built (/download/pi)." >&2
fi

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
  record installed_not_restarted "no systemd unit or pm2 process found to restart"
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
record "$([ -n "$OUT" ] && echo done || echo restarted_no_answer)" "status: $(printf '%s' "${OUT:-no response}" | head -c 300)"
echo "==> Upgrade to $TARGET complete. (Back to bleeding edge anytime: git checkout main)"
echo "==> Recorded in $HISTORY (from $PREV_NAME, Node $NODE_BEFORE -> $(node -v 2>/dev/null))"
