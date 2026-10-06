#!/bin/bash
# Install the instance updater on a git + systemd ScreenTinker (the prod / studiolab shape), so
# Platform → System → "Update Now" can upgrade this server. Run as root from the checkout:
#
#   sudo scripts/updater/install-systemd.sh                 # service "screentinker"
#   sudo SERVICE_NAME=remotedisplay scripts/updater/install-systemd.sh
#
# Everything is read from the RUNNING service's unit (User, WorkingDirectory, ExecStart's node,
# Environment / EnvironmentFile for DATA_DIR, DB_PATH and PORT) rather than assumed, because the
# installs we run differ: prod keeps the DB inside the checkout, studiolab has DATA_DIR in
# /var/lib/screentinker. Review /etc/screentinker-updater.env after it runs.
#
# It installs, and the app CANNOT modify:
#   /usr/local/lib/screentinker-updater/st-updater.sh   (root 755, a COPY — not the repo file the
#                                                       app user can edit, which root would run)
#   /etc/screentinker-updater.env                       (root 600)
#   /etc/systemd/system/screentinker-updater.{path,service}
#   /var/lib/screentinker-updater/                      (root 755: status + log the app reads)
# and one directory the app CAN write: $DATA_DIR/updater/requests (owned by the service user).
#
# Nothing upgrades on its own: the path unit fires only when the app writes a request, and the
# app writes one only when a platform admin presses the button.
#
# Uninstall: systemctl disable --now screentinker-updater.path; rm the files above.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
SERVICE_NAME="${SERVICE_NAME:-screentinker}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || { echo "No systemd unit '$SERVICE_NAME'. Set SERVICE_NAME=." >&2; exit 1; }
prop() { systemctl show -p "$1" --value "$SERVICE_NAME"; }

SVC_USER="$(prop User)"; SVC_USER="${SVC_USER:-root}"
WORKDIR="$(prop WorkingDirectory)"
[ -n "$WORKDIR" ] || { echo "The unit has no WorkingDirectory; cannot locate the checkout." >&2; exit 1; }
APP_DIR="$(cd "$WORKDIR" && git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$APP_DIR" ] && [ -f "$APP_DIR/scripts/upgrade.sh" ] || { echo "$WORKDIR is not inside a ScreenTinker git checkout." >&2; exit 1; }

# The node the service runs, so npm ci builds native modules against the same one.
NODE_BIN="$(prop ExecStart | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
case "$NODE_BIN" in */node) NODE_BIN_DIR="$(dirname "$NODE_BIN")" ;; *) NODE_BIN_DIR="$(dirname "$(command -v node || echo /usr/bin/node)")" ;; esac

# Environment= first, then EnvironmentFile= (later wins, as in systemd).
envval() {
  local key="$1" v=""
  v="$(prop Environment | tr ' ' '\n' | sed -n "s/^$key=//p" | tail -1)"
  for f in $(prop EnvironmentFiles | sed 's/ (ignore_errors=[a-z]*)//g'); do
    if [ -r "$f" ]; then
      local fv
      fv="$(sed -n "s/^[[:space:]]*$key=//p" "$f" | tail -1 | tr -d "\"'")"
      [ -n "$fv" ] && v="$fv"
    fi
  done
  printf '%s' "$v"
}
DATA_DIR="$(envval DATA_DIR)"; DATA_DIR="${DATA_DIR:-$APP_DIR/server}"
DB="$(envval DB_PATH)"; DB="${DB:-$DATA_DIR/db/remote_display.db}"
PORT="$(envval PORT)"; PORT="${PORT:-3001}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
[ -d "$(dirname "$BACKUP_DIR")" ] && [ -w "$(dirname "$BACKUP_DIR")" ] || BACKUP_DIR="/var/backups/screentinker"
APP_USER="$(stat -c %U "$APP_DIR")"   # the checkout's owner runs git + npm, never root
REQ_DIR="$DATA_DIR/updater/requests"
OUT_DIR=/var/lib/screentinker-updater
LIB=/usr/local/lib/screentinker-updater

[ -f "$DB" ] || { echo "WARNING: no database at $DB - fix DB in /etc/screentinker-updater.env before using the button." >&2; }
command -v sqlite3 >/dev/null || echo "WARNING: sqlite3 is not installed; the updater refuses to upgrade without a backup (apt install sqlite3)." >&2
command -v runuser >/dev/null || { echo "runuser (util-linux) is required." >&2; exit 1; }

install -d -m 755 "$LIB" "$OUT_DIR"
install -m 755 "$SRC_DIR/st-updater.sh" "$LIB/st-updater.sh"
install -d -m 755 -o "$SVC_USER" "$DATA_DIR/updater"
install -d -m 770 -o "$SVC_USER" "$REQ_DIR"

umask 077
cat > /etc/screentinker-updater.env <<EOF
# Written by scripts/updater/install-systemd.sh on $(date -u +%F). Read by screentinker-updater.service.
UPDATER_MODE=git
UPDATER_REQUEST_DIR=$REQ_DIR
UPDATER_STATUS_DIR=$OUT_DIR
APP_DIR=$APP_DIR
APP_USER=$APP_USER
SERVICE_NAME=$SERVICE_NAME
DB=$DB
BACKUP_DIR=$BACKUP_DIR
NODE_BIN_DIR=$NODE_BIN_DIR
STATUS_URL=http://localhost:$PORT/api/status
EOF
umask 022

cat > /etc/systemd/system/screentinker-updater.service <<EOF
[Unit]
Description=ScreenTinker instance updater (runs one admin-requested upgrade)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/screentinker-updater.env
ExecStart=$LIB/st-updater.sh once
TimeoutStartSec=30min
EOF

cat > /etc/systemd/system/screentinker-updater.path <<EOF
[Unit]
Description=Watch for ScreenTinker upgrade requests from the dashboard

[Path]
DirectoryNotEmpty=$REQ_DIR
Unit=screentinker-updater.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now screentinker-updater.path
# One empty run writes the marker the dashboard looks for.
systemctl start screentinker-updater.service

echo "Installed. Checkout $APP_DIR (git as $APP_USER), service $SERVICE_NAME, DB $DB, backups $BACKUP_DIR."
echo "Review /etc/screentinker-updater.env. The button appears under Platform -> System once a newer release exists."
