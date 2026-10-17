#!/bin/bash
# Install ScreenTinker as a systemd service
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/remotedisplay.service"
WORKDIR="$(cd "$SCRIPT_DIR/../server" && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

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
sed -e "s|@USER@|$RUN_USER|" -e "s|@WORKDIR@|$WORKDIR|" -e "s|@NODE@|$NODE_BIN|" "$SERVICE_FILE" \
  | sudo tee /etc/systemd/system/remotedisplay.service >/dev/null
sudo install -d -m 0755 /etc/logrotate.d
sudo install -m 0644 "$SCRIPT_DIR/logging/screentinker.logrotate" /etc/logrotate.d/screentinker
if ! command -v logrotate >/dev/null; then
    echo "Install logrotate to activate the supplied log rotation policy."
fi
sudo systemctl daemon-reload
sudo systemctl enable remotedisplay
sudo systemctl start remotedisplay
echo "Done! Service status:"
sudo systemctl status remotedisplay --no-pager
echo ""
echo "Commands:"
echo "  sudo systemctl status remotedisplay"
echo "  sudo systemctl restart remotedisplay"
echo "  sudo tail -F /var/log/screentinker/server.log"
