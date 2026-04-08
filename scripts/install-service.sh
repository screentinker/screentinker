#!/bin/bash
# Install ScreenTinker as a systemd service
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/remotedisplay.service"

echo "Installing ScreenTinker service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/remotedisplay.service
sudo systemctl daemon-reload
sudo systemctl enable remotedisplay
sudo systemctl start remotedisplay
echo "Done! Service status:"
sudo systemctl status remotedisplay --no-pager
echo ""
echo "Commands:"
echo "  sudo systemctl status remotedisplay"
echo "  sudo systemctl restart remotedisplay"
echo "  sudo journalctl -u remotedisplay -f"
