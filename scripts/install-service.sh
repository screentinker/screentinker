#!/bin/bash
# Install ScreenTinker as a systemd service
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/remotedisplay.service"
WORKDIR="$(cd "$SCRIPT_DIR/../server" && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
# screentinker.service, the name the README, scripts/upgrade.sh and the instance updater expect.
# This script used to create remotedisplay.service: a machine that already has that unit keeps it
# (re-running updates it in place rather than starting a second server on the same port).
if [ -z "${SERVICE_NAME:-}" ]; then
  SERVICE_NAME=screentinker
  if ! systemctl cat screentinker >/dev/null 2>&1 && systemctl cat remotedisplay >/dev/null 2>&1; then
    SERVICE_NAME=remotedisplay
  fi
fi

# The unit runs the Node found here, by absolute path, so it must already meet the server's floor.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found on PATH. Install Node 22.14+ first (see docs/operations.md)." >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
FLOOR="$(sed -n 's/.*"node": *">= *v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' "$WORKDIR/package.json" | head -1)"
HAVE="$("$NODE_BIN" -p 'process.versions.node')"
if [ -n "$FLOOR" ] && [ "$(printf '%s\n%s\n' "$FLOOR" "$HAVE" | sort -V | head -1)" != "$FLOOR" ]; then
  echo "$NODE_BIN is Node $HAVE; ScreenTinker needs Node >= $FLOOR. Upgrade Node first (docs/operations.md)." >&2
  exit 1
fi

echo "Installing ScreenTinker service (user $RUN_USER, $WORKDIR, Node $HAVE at $NODE_BIN)..."
sed -e "s|@USER@|$RUN_USER|" -e "s|@WORKDIR@|$WORKDIR|" -e "s|@NODE@|$NODE_BIN|" -e "s|@NAME@|$SERVICE_NAME|" "$SERVICE_FILE" \
  | sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"
echo "Done! Service status:"
sudo systemctl status "$SERVICE_NAME" --no-pager
echo ""
echo "Commands:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  sudo systemctl restart $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"
