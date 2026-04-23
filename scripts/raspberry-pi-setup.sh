#!/bin/bash
# ScreenTinker - Raspberry Pi Setup Script
#
# All-in-One: runs the ScreenTinker server AND kiosk player on one Pi
# Player-Only: connects to an existing ScreenTinker server
#
# Usage:
#   All-in-One:   curl -sSL https://screentinker.com/scripts/raspberry-pi-setup.sh | sudo bash
#   Player-Only:  curl -sSL https://screentinker.com/scripts/raspberry-pi-setup.sh | sudo bash -s -- --player-only https://screentinker.com
#
# Or clone and run:
#   git clone https://github.com/screentinker/screentinker.git
#   cd screentinker/scripts && sudo ./raspberry-pi-setup.sh
#
# Works on Raspberry Pi OS Lite or Desktop (Bookworm / Bullseye)
# Tested on Pi 3B+, Pi 4, Pi 5

set -euo pipefail

# -- Configuration --
SCREENTINKER_DIR="/opt/screentinker"
SCREENTINKER_PORT=3001
NODE_MAJOR=20
LOG_FILE="/var/log/screentinker-setup.log"

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[ScreenTinker]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# -- Parse arguments --
PLAYER_ONLY=false
SERVER_URL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --player-only) PLAYER_ONLY=true; shift ;;
        --help|-h)
            echo "Usage: sudo ./raspberry-pi-setup.sh [OPTIONS] [SERVER_URL]"
            echo ""
            echo "Options:"
            echo "  --player-only URL    Player-only mode (no local server)"
            echo "  --help               Show this help"
            echo ""
            echo "Examples:"
            echo "  sudo ./raspberry-pi-setup.sh                                    # All-in-One (interactive)"
            echo "  sudo ./raspberry-pi-setup.sh --player-only https://screentinker.com"
            exit 0
            ;;
        http*) SERVER_URL="$1"; shift ;;
        *) shift ;;
    esac
done

# -- Root check --
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root. Try: sudo bash raspberry-pi-setup.sh"
fi

# -- Architecture check --
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" && "$ARCH" != "armv7l" ]]; then
    warn "Detected architecture: $ARCH (expected aarch64 or armv7l for Raspberry Pi)"
    read -p "Continue anyway? (y/N) " -n 1 -r; echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# -- Interactive mode selection (if no flags passed) --
if [ "$PLAYER_ONLY" = false ] && [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}   ScreenTinker Raspberry Pi Setup${NC}"
    echo -e "${BLUE}======================================${NC}"
    echo ""
    echo "  1) All-in-One  (recommended)"
    echo "     Runs the server AND player on this Pi."
    echo "     Manage everything from your phone."
    echo ""
    echo "  2) Player Only"
    echo "     Connects to an existing ScreenTinker server."
    echo "     This Pi just displays content."
    echo ""
    read -p "Choose [1/2]: " MODE_CHOICE
    case "$MODE_CHOICE" in
        2)
            PLAYER_ONLY=true
            read -p "Server URL (e.g., https://screentinker.com): " SERVER_URL
            ;;
        *) ;;
    esac
fi

# Strip trailing slash from server URL
SERVER_URL="${SERVER_URL%/}"

# Set kiosk URL
if [ "$PLAYER_ONLY" = true ]; then
    [ -z "$SERVER_URL" ] && err "Player-only mode requires a server URL"
    KIOSK_URL="${SERVER_URL}/player"
    log "Player-only mode: $SERVER_URL"
else
    KIOSK_URL="http://localhost:${SCREENTINKER_PORT}/player"
    log "All-in-One mode: server + player"
fi

echo ""
log "Setup log: $LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

# -- Detect Pi OS variant --
HAS_DESKTOP=false
if dpkg -l xserver-xorg 2>/dev/null | grep -q "^ii"; then
    HAS_DESKTOP=true
    log "Detected: Pi OS with Desktop"
else
    log "Detected: Pi OS Lite (headless)"
fi

# ============================================================
# 1. System packages
# ============================================================
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

log "Installing base dependencies..."
apt-get install -y -qq \
    git curl wget unzip htop \
    avahi-daemon \
    fonts-liberation fonts-noto-color-emoji \
    >> "$LOG_FILE" 2>&1

# ============================================================
# 2. Node.js (all-in-one only)
# ============================================================
if [ "$PLAYER_ONLY" = false ]; then
    NEED_NODE=true
    if command -v node &>/dev/null; then
        CUR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$CUR" -ge "$NODE_MAJOR" ]; then
            log "Node.js $(node -v) already installed"
            NEED_NODE=false
        fi
    fi
    if [ "$NEED_NODE" = true ]; then
        log "Installing Node.js ${NODE_MAJOR}.x..."
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >> "$LOG_FILE" 2>&1
        apt-get install -y -qq nodejs >> "$LOG_FILE" 2>&1
        log "Node.js $(node -v) installed"
    fi
fi

# ============================================================
# 3. Clone / update ScreenTinker (all-in-one only)
# ============================================================
if [ "$PLAYER_ONLY" = false ]; then
    if [ -d "$SCREENTINKER_DIR/.git" ]; then
        log "Repo exists at $SCREENTINKER_DIR, pulling latest..."
        cd "$SCREENTINKER_DIR" && git pull origin main >> "$LOG_FILE" 2>&1
    else
        log "Cloning ScreenTinker..."
        git clone https://github.com/screentinker/screentinker.git "$SCREENTINKER_DIR" >> "$LOG_FILE" 2>&1
    fi

    log "Installing Node.js dependencies..."
    cd "$SCREENTINKER_DIR/server"
    npm install --production >> "$LOG_FILE" 2>&1

    # Data directories
    mkdir -p "$SCREENTINKER_DIR/server/db"
    mkdir -p "$SCREENTINKER_DIR/server/uploads"
fi

# Determine the runtime user
PI_USER="${SUDO_USER:-pi}"
PI_HOME=$(eval echo "~$PI_USER")

# Set ownership (all-in-one only)
if [ "$PLAYER_ONLY" = false ]; then
    chown -R "$PI_USER":"$PI_USER" "$SCREENTINKER_DIR"
fi

# ============================================================
# 4. Server systemd service (all-in-one only)
# ============================================================
if [ "$PLAYER_ONLY" = false ]; then
    log "Creating screentinker-server service..."
    cat > /etc/systemd/system/screentinker-server.service << EOF
[Unit]
Description=ScreenTinker Digital Signage Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PI_USER}
WorkingDirectory=${SCREENTINKER_DIR}/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

Environment=NODE_ENV=production
Environment=PORT=${SCREENTINKER_PORT}
Environment=SELF_HOSTED=true
Environment=HOST=0.0.0.0

StandardOutput=journal
StandardError=journal
SyslogIdentifier=screentinker-server

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable screentinker-server.service
    log "Server service enabled"
fi

# ============================================================
# 5. Kiosk display packages
# ============================================================
log "Installing kiosk packages..."
if [ "$HAS_DESKTOP" = false ]; then
    # Lite: install X11 + Chromium from scratch
    apt-get install -y -qq \
        xserver-xorg x11-xserver-utils xinit \
        chromium-browser \
        unclutter xdotool \
        >> "$LOG_FILE" 2>&1
else
    # Desktop: X already running, just ensure Chromium + helpers
    apt-get install -y -qq unclutter xdotool >> "$LOG_FILE" 2>&1
    if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
        apt-get install -y -qq chromium-browser >> "$LOG_FILE" 2>&1
    fi
fi

# Find Chromium binary
CHROMIUM_BIN=$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || echo "/usr/bin/chromium-browser")

# ============================================================
# 6. Kiosk launcher script
# ============================================================
log "Creating kiosk launcher..."
cat > "$PI_HOME/screentinker-kiosk.sh" << KIOSKEOF
#!/bin/bash
# ScreenTinker Kiosk - launches Chromium in fullscreen player mode
KIOSK_URL="${KIOSK_URL}"

# Wait for display
sleep 2

# Disable screen blanking and power management
xset s off
xset s noblank
xset -dpms
xset s 0 0

# Hide cursor after 3 seconds of inactivity
unclutter -idle 3 -root &

# Clean Chromium crash flags (prevents restore session dialogs)
CDIR="\$HOME/.config/chromium/Default"
mkdir -p "\$CDIR"
if [ -f "\$CDIR/Preferences" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "\$CDIR/Preferences" 2>/dev/null || true
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "\$CDIR/Preferences" 2>/dev/null || true
fi

# Wait for local server if running all-in-one
if echo "\$KIOSK_URL" | grep -q "localhost"; then
    echo "Waiting for ScreenTinker server..."
    for i in \$(seq 1 30); do
        if curl -sf "http://localhost:${SCREENTINKER_PORT}/api/health" >/dev/null 2>&1; then
            echo "Server ready"
            break
        fi
        sleep 2
    done
fi

exec ${CHROMIUM_BIN} \\
    --kiosk \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-session-crashed-bubble \\
    --disable-features=TranslateUI \\
    --disable-component-update \\
    --check-for-update-interval=31536000 \\
    --autoplay-policy=no-user-gesture-required \\
    --no-first-run \\
    --start-fullscreen \\
    --disable-pinch \\
    --overscroll-history-navigation=0 \\
    --disable-translate \\
    --disable-sync \\
    --disable-background-networking \\
    --disable-default-apps \\
    --disable-extensions \\
    --disable-hang-monitor \\
    --disable-popup-blocking \\
    --disable-prompt-on-repost \\
    --metrics-recording-only \\
    --safebrowsing-disable-auto-update \\
    --ignore-certificate-errors \\
    "\$KIOSK_URL"
KIOSKEOF

chmod +x "$PI_HOME/screentinker-kiosk.sh"
chown "$PI_USER":"$PI_USER" "$PI_HOME/screentinker-kiosk.sh"

# ============================================================
# 7. Xinitrc (Pi OS Lite - starts kiosk from console)
# ============================================================
if [ "$HAS_DESKTOP" = false ]; then
    cat > "$PI_HOME/.xinitrc" << 'EOF'
#!/bin/bash
exec ~/screentinker-kiosk.sh
EOF
    chmod +x "$PI_HOME/.xinitrc"
    chown "$PI_USER":"$PI_USER" "$PI_HOME/.xinitrc"
fi

# ============================================================
# 8. Kiosk systemd service
# ============================================================
log "Creating kiosk service..."

if [ "$HAS_DESKTOP" = false ]; then
    # Lite: start X ourselves
    if [ "$PLAYER_ONLY" = false ]; then
        KIOSK_AFTER="After=screentinker-server.service"
        KIOSK_REQ="Requires=screentinker-server.service"
    else
        KIOSK_AFTER="After=network-online.target"
        KIOSK_REQ="Wants=network-online.target"
    fi

    cat > /etc/systemd/system/screentinker-kiosk.service << EOF
[Unit]
Description=ScreenTinker Kiosk Display
${KIOSK_AFTER}
${KIOSK_REQ}

[Service]
Type=simple
User=${PI_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${PI_HOME}/.Xauthority
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/startx ${PI_HOME}/.xinitrc -- :0 -nolisten tcp vt1
Restart=always
RestartSec=10

TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
SyslogIdentifier=screentinker-kiosk

[Install]
WantedBy=multi-user.target
EOF
else
    # Desktop: X already running, just launch Chromium
    if [ "$PLAYER_ONLY" = false ]; then
        KIOSK_AFTER="After=screentinker-server.service graphical.target"
        KIOSK_REQ="Requires=screentinker-server.service"
    else
        KIOSK_AFTER="After=graphical.target"
        KIOSK_REQ="Wants=graphical.target"
    fi

    cat > /etc/systemd/system/screentinker-kiosk.service << EOF
[Unit]
Description=ScreenTinker Kiosk Display
${KIOSK_AFTER}
${KIOSK_REQ}

[Service]
Type=simple
User=${PI_USER}
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStart=/bin/bash ${PI_HOME}/screentinker-kiosk.sh
Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=screentinker-kiosk

[Install]
WantedBy=graphical.target
EOF
fi

systemctl daemon-reload
systemctl enable screentinker-kiosk.service
log "Kiosk service enabled"

# Desktop: autostart entry as fallback
if [ "$HAS_DESKTOP" = true ]; then
    AUTOSTART_DIR="$PI_HOME/.config/autostart"
    mkdir -p "$AUTOSTART_DIR"
    cat > "$AUTOSTART_DIR/screentinker.desktop" << EOF
[Desktop Entry]
Type=Application
Name=ScreenTinker Player
Exec=${PI_HOME}/screentinker-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
    chown -R "$PI_USER":"$PI_USER" "$AUTOSTART_DIR"
fi

# ============================================================
# 9. Auto-login on tty1 (Lite only)
# ============================================================
if [ "$HAS_DESKTOP" = false ]; then
    log "Configuring auto-login on tty1..."
    mkdir -p /etc/systemd/system/getty@tty1.service.d
    cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${PI_USER} --noclear %I \$TERM
EOF
fi

# ============================================================
# 10. Pi display and boot optimizations
# ============================================================
log "Applying display optimizations..."

# Find config.txt (Pi 5 uses /boot/firmware/, older uses /boot/)
CONFIG_FILE=""
for p in /boot/firmware/config.txt /boot/config.txt; do
    [ -f "$p" ] && CONFIG_FILE="$p" && break
done

if [ -n "$CONFIG_FILE" ]; then
    # GPU memory for video playback
    if ! grep -q "^gpu_mem=" "$CONFIG_FILE"; then
        echo -e "\n# ScreenTinker: GPU memory for smooth video" >> "$CONFIG_FILE"
        echo "gpu_mem=128" >> "$CONFIG_FILE"
        log "GPU memory: 128MB"
    fi

    # Disable overscan (removes black borders on TVs)
    if ! grep -q "^disable_overscan=1" "$CONFIG_FILE"; then
        echo "disable_overscan=1" >> "$CONFIG_FILE"
        log "Overscan disabled"
    fi
fi

# Disable console blanking
for p in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    if [ -f "$p" ]; then
        if ! grep -q "consoleblank=0" "$p"; then
            sed -i 's/$/ consoleblank=0/' "$p"
            log "Console blanking disabled"
        fi
        break
    fi
done

# Lightdm screen blanking (Desktop only)
if [ "$HAS_DESKTOP" = true ] && [ -f /etc/lightdm/lightdm.conf ]; then
    sed -i 's/#xserver-command=X/xserver-command=X -s 0 -dpms/' /etc/lightdm/lightdm.conf
fi

# Hardware watchdog for auto-recovery from system hangs
if grep -q "#RuntimeWatchdogSec=0" /etc/systemd/system.conf 2>/dev/null; then
    sed -i 's/#RuntimeWatchdogSec=0/RuntimeWatchdogSec=10/' /etc/systemd/system.conf
    log "Hardware watchdog enabled (10s)"
fi

# ============================================================
# 11. Management scripts (all-in-one only)
# ============================================================
if [ "$PLAYER_ONLY" = false ]; then
    log "Creating management scripts..."

    cat > /usr/local/bin/screentinker-update << 'UPDATEEOF'
#!/bin/bash
echo "Stopping services..."
sudo systemctl stop screentinker-kiosk.service 2>/dev/null || true
sudo systemctl stop screentinker-server.service 2>/dev/null || true

echo "Pulling latest..."
cd /opt/screentinker && git pull origin main

echo "Installing dependencies..."
cd server && npm install --production

echo "Starting services..."
sudo systemctl start screentinker-server.service
sleep 3
sudo systemctl start screentinker-kiosk.service

echo ""
echo "Done! Server: $(systemctl is-active screentinker-server.service)"
echo "      Kiosk:  $(systemctl is-active screentinker-kiosk.service)"
UPDATEEOF
    chmod +x /usr/local/bin/screentinker-update

    cat > /usr/local/bin/screentinker-status << 'STATUSEOF'
#!/bin/bash
echo ""
echo "=== ScreenTinker Status ==="
echo ""
IP=$(hostname -I | awk '{print $1}')

if systemctl is-active screentinker-server.service &>/dev/null; then
    echo "Server:    RUNNING (PID $(systemctl show screentinker-server.service -p MainPID --value))"
else
    echo "Server:    STOPPED"
fi

if systemctl is-active screentinker-kiosk.service &>/dev/null; then
    echo "Kiosk:     RUNNING"
else
    echo "Kiosk:     STOPPED"
fi

echo ""
echo "Uptime:    $(uptime -p)"
echo "CPU Temp:  $(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 || echo 'n/a')"
echo "Disk:      $(df -h /opt/screentinker 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 " used)"}')"
echo "Memory:    $(free -h | awk '/Mem:/ {print $3 " / " $2}')"
echo ""
echo "Dashboard: http://${IP}:3001"
echo "Player:    http://${IP}:3001/player"
echo "mDNS:      http://$(hostname).local:3001"
echo ""
STATUSEOF
    chmod +x /usr/local/bin/screentinker-status

    cat > /usr/local/bin/screentinker-logs << 'LOGSEOF'
#!/bin/bash
case "${1:-server}" in
    server) journalctl -u screentinker-server.service -f --no-hostname ;;
    kiosk)  journalctl -u screentinker-kiosk.service -f --no-hostname ;;
    all)    journalctl -u screentinker-server.service -u screentinker-kiosk.service -f --no-hostname ;;
    *)      echo "Usage: screentinker-logs [server|kiosk|all]" ;;
esac
LOGSEOF
    chmod +x /usr/local/bin/screentinker-logs
fi

# ============================================================
# 12. MOTD
# ============================================================
cat > /etc/motd << 'MOTDEOF'

  ____                        _____          _
 / ___|  ___ _ __ ___  ___  |_   _|_ _ __ | | _____ _ __
 \___ \ / __| '__/ _ \/ _ \   | || | '_ \| |/ / _ \ '__|
  ___) | (__| | |  __/  __/   | || | | | |   <  __/ |
 |____/ \___|_|  \___|\___|   |_||_|_| |_|_|\_\___|_|

 Open-Source Digital Signage for Any Screen

 Commands:
   screentinker-status   Show system info and URLs
   screentinker-update   Pull latest and restart
   screentinker-logs     Follow logs (server|kiosk|all)

MOTDEOF

# ============================================================
# 13. Clean up legacy remotedisplay naming
# ============================================================
if [ -f /etc/systemd/system/remotedisplay.service ]; then
    log "Cleaning up legacy remotedisplay service..."
    systemctl stop remotedisplay.service 2>/dev/null || true
    systemctl disable remotedisplay.service 2>/dev/null || true
    rm -f /etc/systemd/system/remotedisplay.service
    rm -f "$PI_HOME/remotedisplay-kiosk.sh"
    rm -f "$PI_HOME/.config/autostart/remotedisplay.desktop"
    systemctl daemon-reload
fi

# ============================================================
# Done
# ============================================================
echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}   ScreenTinker Setup Complete!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""

IP=$(hostname -I | awk '{print $1}')

if [ "$PLAYER_ONLY" = false ]; then
    echo "Mode: All-in-One (server + player)"
    echo ""
    echo "After reboot this Pi will:"
    echo "  - Start the ScreenTinker server on port $SCREENTINKER_PORT"
    echo "  - Display the player fullscreen on the connected screen"
    echo ""
    echo "First steps:"
    echo "  1. Reboot:  sudo reboot"
    echo "  2. From your phone, go to http://${IP}:${SCREENTINKER_PORT}"
    echo "     (or http://$(hostname).local:${SCREENTINKER_PORT})"
    echo "  3. Register - first user gets full admin access"
    echo "  4. Add a display and enter the pairing code from the TV"
    echo "  5. Upload content and push it to the screen"
    echo ""
    echo "Management:"
    echo "  screentinker-status   Check everything is running"
    echo "  screentinker-update   Update to latest version"
    echo "  screentinker-logs     Watch server logs"
else
    echo "Mode: Player Only"
    echo "Server: $SERVER_URL"
    echo ""
    echo "After reboot this Pi will:"
    echo "  - Open the player in fullscreen kiosk mode"
    echo "  - Auto-reconnect if the server goes down"
    echo ""
    echo "To pair:"
    echo "  1. Reboot:  sudo reboot"
    echo "  2. The pairing screen will appear on the TV"
    echo "  3. Enter the code in your ScreenTinker dashboard"
fi

echo ""
echo "Services:"
if [ "$PLAYER_ONLY" = false ]; then
    echo "  sudo systemctl [start|stop|restart] screentinker-server"
fi
echo "  sudo systemctl [start|stop|restart] screentinker-kiosk"
echo ""
echo -e "${YELLOW}Reboot to start:  sudo reboot${NC}"
echo ""
