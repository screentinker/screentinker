#!/bin/bash
# ScreenTinker - Raspberry Pi Setup Script
# Run: curl -sSL https://screentinker.com/scripts/pi-setup.sh | bash
#
# This sets up a Raspberry Pi as a digital signage player:
# 1. Installs Chromium if needed
# 2. Creates a systemd service for kiosk mode
# 3. Auto-starts on boot

SERVER_URL="${1:-https://screentinker.com}"
PLAYER_URL="$SERVER_URL/player"

echo "=================================="
echo "  ScreenTinker Pi Player Setup"
echo "=================================="
echo "Server: $SERVER_URL"
echo ""

# Install chromium if not present
if ! command -v chromium-browser &> /dev/null && ! command -v chromium &> /dev/null; then
    echo "Installing Chromium..."
    sudo apt-get update && sudo apt-get install -y chromium-browser unclutter
fi

CHROMIUM=$(command -v chromium-browser || command -v chromium)

# Disable screen blanking
if [ -f /etc/lightdm/lightdm.conf ]; then
    sudo sed -i 's/#xserver-command=X/xserver-command=X -s 0 -dpms/' /etc/lightdm/lightdm.conf
fi

# Create autostart directory
mkdir -p ~/.config/autostart

# Create kiosk script
cat > ~/remotedisplay-kiosk.sh << EOF
#!/bin/bash
# Wait for network
sleep 5

# Disable screen saver and power management
xset s off
xset -dpms
xset s noblank

# Hide cursor
unclutter -idle 0.1 -root &

# Launch Chromium in kiosk mode
$CHROMIUM \\
  --noerrandprompts \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --kiosk \\
  --incognito \\
  --autoplay-policy=no-user-gesture-required \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --disable-component-update \\
  "$PLAYER_URL"
EOF
chmod +x ~/remotedisplay-kiosk.sh

# Create systemd service
sudo tee /etc/systemd/system/remotedisplay.service > /dev/null << EOF
[Unit]
Description=ScreenTinker Kiosk Player
After=graphical.target
Wants=graphical.target

[Service]
Type=simple
User=$USER
Environment=DISPLAY=:0
ExecStart=/bin/bash $HOME/remotedisplay-kiosk.sh
Restart=always
RestartSec=10

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable remotedisplay.service

# Create desktop autostart entry (fallback)
cat > ~/.config/autostart/remotedisplay.desktop << EOF
[Desktop Entry]
Type=Application
Name=ScreenTinker
Exec=$HOME/remotedisplay-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

echo ""
echo "=================================="
echo "  Setup Complete!"
echo "=================================="
echo ""
echo "The player will auto-start on next boot."
echo "To start now:  ~/remotedisplay-kiosk.sh"
echo "To stop:       sudo systemctl stop remotedisplay"
echo "Player URL:    $PLAYER_URL"
echo ""
echo "Press Escape in the player to reset/reconfigure."
echo "Press F for fullscreen toggle."
