#!/bin/bash
# ScreenTinker - Debian 13 Setup Script
#
# Modes:
#   - Server + Player (both)
#   - Server only
#   - Player only
#
# Usage:
#   curl -sSL https://screentinker.com/scripts/debian-13-setup.sh | sudo bash
#   curl -sSL https://screentinker.com/scripts/debian-13-setup.sh | sudo bash -s -- --server-only
#   curl -sSL https://screentinker.com/scripts/debian-13-setup.sh | sudo bash -s -- --player-only https://screentinker.com

set -euo pipefail

# -- Configuration --
SCREENTINKER_DIR="/opt/screentinker"
SCREENTINKER_PORT=3001
NODE_MAJOR=20
LOG_FILE="/var/log/screentinker-debian-setup.log"

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[ScreenTinker]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# -- Clock: NTP on, and a real time zone --
#
# ⚠️ Pi OS's default zone IS Europe/London, so a Pi set up without the Imager's locale step played
# its schedules on UK time (seen on a Pi 4 in Chicago). --timezone wins; a zone somebody chose is
# kept; a default one is asked of OUR server (screentinker.com answers from where it sees the Pi —
# no third-party geo-IP service). A LAN server can't tell, so the dashboard fills it in at pairing.
# Never fatal: when unsure, keep the zone and say how to fix it.
st_setup_clock() {
    local server="$1" cur tz=""
    timedatectl set-ntp true 2>/dev/null || true
    cur="$(timedatectl show -p Timezone --value 2>/dev/null)"
    if [ -n "$TIMEZONE" ]; then
        tz="$TIMEZONE"
    else
        case "$cur" in
            ""|Europe/London|Etc/UTC|UTC|Etc/Universal|Universal|GMT|Etc/GMT) ;;
            *) log "Time zone: $cur (kept; change with --timezone Area/City)"; return 0 ;;
        esac
        [ -n "$server" ] && tz="$(curl -fsS --max-time 5 "$server/api/public/timezone" 2>/dev/null \
            | sed -n 's/.*"timezone"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || tz=""   # ⚠️ set -e + pipefail: an unreachable server must not end the install
        if [ -z "$tz" ]; then
            warn "Time zone: ${cur:-UTC}. Could not detect one; if that is wrong, pair the display from a browser"
            warn "  in its time zone, or re-run with --timezone Area/City (e.g. America/Chicago)."
            return 0
        fi
    fi
    if ! [[ "$tz" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$ ]] || [ ! -f "/usr/share/zoneinfo/$tz" ]; then
        warn "Unknown time zone '$tz' (expected Area/City, e.g. America/Chicago): kept ${cur:-UTC}"
        return 0
    fi
    if [ "$tz" != "$cur" ] && ! timedatectl set-timezone "$tz" 2>/dev/null; then
        warn "Could not set the time zone to $tz: kept ${cur:-UTC}"
        return 0
    fi
    log "Time zone: $tz"
}

MODE="both"
MODE_SET=false
SERVER_URL=""
# IANA zone (--timezone Area/City). "" = keep a chosen zone, detect a default one.
TIMEZONE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server-only)
            MODE="server"
            MODE_SET=true
            shift
            ;;
        --player-only)
            MODE="player"
            MODE_SET=true
            shift
            if [[ $# -gt 0 && "$1" == http* ]]; then
                SERVER_URL="$1"
                shift
            fi
            ;;
        --timezone)
            TIMEZONE="$2"
            shift 2
            ;;
        --both)
            MODE="both"
            MODE_SET=true
            shift
            ;;
        --help|-h)
            echo "Usage: sudo ./debian-13-setup.sh [OPTIONS] [SERVER_URL]"
            echo ""
            echo "Options:"
            echo "  --server-only         Install only the server"
            echo "  --player-only [URL]   Install only the player (URL required)"
            echo "  --both                Install both server and player (default)"
            echo "  --timezone ZONE       e.g. America/Chicago. Default: kept, or detected when it"
            echo "                        is still the image's default (Etc/UTC)"
            echo "  --help                Show this help"
            echo ""
            echo "Examples:"
            echo "  sudo ./debian-13-setup.sh"
            echo "  sudo ./debian-13-setup.sh --server-only"
            echo "  sudo ./debian-13-setup.sh --player-only https://screentinker.com"
            exit 0
            ;;
        http*)
            SERVER_URL="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root. Try: sudo bash debian-13-setup.sh"
fi

if [ -r /etc/os-release ]; then
    . /etc/os-release
    if [ "${ID:-}" != "debian" ] || [ "${VERSION_ID:-}" != "13" ]; then
        warn "Detected ${PRETTY_NAME:-unknown}. This script targets Debian 13."
        read -p "Continue anyway? (y/N) " -n 1 -r; echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    else
        log "Detected Debian 13"
    fi
fi

if [ "$MODE" = "player" ] && [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}   ScreenTinker Debian 13 Setup${NC}"
    echo -e "${BLUE}======================================${NC}"
    echo ""
    read -p "Server URL (e.g., https://screentinker.com): " SERVER_URL
elif [ "$MODE" = "both" ] && [ "$MODE_SET" = false ] && [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}   ScreenTinker Debian 13 Setup${NC}"
    echo -e "${BLUE}======================================${NC}"
    echo ""
    echo "  1) Server + Player (recommended for single-screen host)"
    echo "  2) Server Only"
    echo "  3) Player Only"
    echo ""
    read -p "Choose [1/2/3]: " MODE_CHOICE
    case "$MODE_CHOICE" in
        2)
            MODE="server"
            ;;
        3)
            MODE="player"
            read -p "Server URL (e.g., https://screentinker.com): " SERVER_URL
            ;;
        *)
            MODE="both"
            ;;
    esac
fi

SERVER_URL="${SERVER_URL%/}"

NEED_SERVER=false
NEED_PLAYER=false

case "$MODE" in
    server)
        NEED_SERVER=true
        ;;
    player)
        NEED_PLAYER=true
        ;;
    both)
        NEED_SERVER=true
        NEED_PLAYER=true
        ;;
    *)
        err "Unknown mode: $MODE"
        ;;
esac

if [ "$NEED_PLAYER" = true ] && [ "$MODE" = "player" ] && [ -z "$SERVER_URL" ]; then
    err "Player-only mode requires a server URL"
fi

if [ "$NEED_PLAYER" = true ]; then
    if [ "$MODE" = "player" ]; then
        KIOSK_URL="${SERVER_URL}/player"
    else
        KIOSK_URL="http://localhost:${SCREENTINKER_PORT}/player"
    fi
fi

echo ""
log "Setup log: $LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

log "Installing base dependencies..."
apt-get install -y -qq \
    git curl wget unzip htop \
    avahi-daemon \
    fonts-liberation fonts-noto-color-emoji \
    >> "$LOG_FILE" 2>&1

RUNTIME_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
if ! id "$RUNTIME_USER" &>/dev/null; then
    warn "Could not resolve invoking user; defaulting to root"
    RUNTIME_USER="root"
fi
RUNTIME_HOME=$(eval echo "~$RUNTIME_USER")

if [ "$NEED_SERVER" = true ]; then
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

    if [ -d "$SCREENTINKER_DIR/.git" ]; then
        log "Repo exists at $SCREENTINKER_DIR, pulling latest..."
        cd "$SCREENTINKER_DIR" && git pull origin main >> "$LOG_FILE" 2>&1
    else
        log "Cloning ScreenTinker..."
        git clone https://github.com/screentinker/screentinker.git "$SCREENTINKER_DIR" >> "$LOG_FILE" 2>&1
    fi

    log "Installing server dependencies..."
    cd "$SCREENTINKER_DIR/server"
    npm install --production >> "$LOG_FILE" 2>&1

    mkdir -p "$SCREENTINKER_DIR/server/db"
    mkdir -p "$SCREENTINKER_DIR/server/uploads"
    chown -R "$RUNTIME_USER":"$RUNTIME_USER" "$SCREENTINKER_DIR"

    log "Creating screentinker-server service..."
    cat > /etc/systemd/system/screentinker-server.service << SERVICEEOF
[Unit]
Description=ScreenTinker Digital Signage Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNTIME_USER}
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
SERVICEEOF

    systemctl daemon-reload
    systemctl enable screentinker-server.service
    log "Server service enabled"
fi

if [ "$NEED_PLAYER" = true ]; then
    log "Installing player packages..."
    apt-get install -y -qq \
        xserver-xorg xserver-xorg-legacy x11-xserver-utils xinit \
        chromium unclutter xdotool \
        >> "$LOG_FILE" 2>&1 || {
            warn "Failed to install chromium package, trying chromium-browser..."
            apt-get install -y -qq xserver-xorg xserver-xorg-legacy x11-xserver-utils xinit chromium-browser unclutter xdotool >> "$LOG_FILE" 2>&1
        }

    CHROMIUM_BIN=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || echo "/usr/bin/chromium")

    log "Allowing non-root X server startup..."
    mkdir -p /etc/X11
    cat > /etc/X11/Xwrapper.config << 'XWRAPEOF'
allowed_users=anybody
needs_root_rights=yes
XWRAPEOF

    log "Creating kiosk launcher..."
    cat > "$RUNTIME_HOME/screentinker-kiosk.sh" << KIOSKEOF
#!/bin/bash
KIOSK_URL="${KIOSK_URL}"

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
    for i in \$(seq 1 60); do
        if curl -sf "http://localhost:${SCREENTINKER_PORT}/api/status" >/dev/null 2>&1; then
            echo "Server ready after \${i}x2s"
            break
        fi
        sleep 2
    done
fi

# Detect screen resolution so Chromium fills the display on minimal X11 (no WM)
SCREEN_RES=\$(xrandr 2>/dev/null | grep ' connected' | grep -oE '[0-9]+x[0-9]+' | head -1)
SCREEN_W=\${SCREEN_RES%%x*}
SCREEN_H=\${SCREEN_RES##*x}
if [ -z "\$SCREEN_W" ] || [ -z "\$SCREEN_H" ]; then
    SCREEN_W=1920
    SCREEN_H=1080
fi

exec ${CHROMIUM_BIN} \\
    --kiosk \\
    --window-position=0,0 \\
    --window-size=\${SCREEN_W},\${SCREEN_H} \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-session-crashed-bubble \\
    --disable-features=TranslateUI \\
    --disable-component-update \\
    --check-for-update-interval=31536000 \\
    --autoplay-policy=no-user-gesture-required \\
    --no-first-run \\
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

    chmod +x "$RUNTIME_HOME/screentinker-kiosk.sh"
    chown "$RUNTIME_USER":"$RUNTIME_USER" "$RUNTIME_HOME/screentinker-kiosk.sh"

    cat > "$RUNTIME_HOME/.xinitrc" << 'XINITEOF'
#!/bin/bash
exec ~/screentinker-kiosk.sh
XINITEOF
    chmod +x "$RUNTIME_HOME/.xinitrc"
    chown "$RUNTIME_USER":"$RUNTIME_USER" "$RUNTIME_HOME/.xinitrc"

    if [ "$NEED_SERVER" = true ]; then
        KIOSK_AFTER="After=screentinker-server.service"
        KIOSK_REQ="Requires=screentinker-server.service"
    else
        KIOSK_AFTER="After=network-online.target"
        KIOSK_REQ="Wants=network-online.target"
    fi

    log "Creating kiosk service..."
    cat > /etc/systemd/system/screentinker-kiosk.service << SERVICEEOF
[Unit]
Description=ScreenTinker Kiosk Display
${KIOSK_AFTER}
${KIOSK_REQ}
# Prevent conflicts with getty on tty1
Conflicts=getty@tty1.service
After=getty@tty1.service

[Service]
Type=simple
User=${RUNTIME_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${RUNTIME_HOME}/.Xauthority
# Remove stale X lock files from previous crashes before starting
ExecStartPre=/bin/bash -c 'rm -f /tmp/.X0-lock /tmp/.X11-unix/X0'
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/startx ${RUNTIME_HOME}/.xinitrc -- :0 -nolisten tcp vt1
Restart=on-failure
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=120

TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
SyslogIdentifier=screentinker-kiosk

[Install]
WantedBy=multi-user.target
SERVICEEOF

    systemctl daemon-reload
    systemctl enable screentinker-kiosk.service
    log "Kiosk service enabled"

    log "Configuring auto-login on tty1..."
    mkdir -p /etc/systemd/system/getty@tty1.service.d
    cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << AUTOLOGINEOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${RUNTIME_USER} --noclear %I \$TERM
AUTOLOGINEOF

    # Disable getty on tty1 so it doesn't conflict with the kiosk service
    systemctl disable getty@tty1.service 2>/dev/null || true
    systemctl mask getty@tty1.service 2>/dev/null || true
fi

if [ "$NEED_SERVER" = true ]; then
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
if systemctl list-unit-files | grep -q '^screentinker-kiosk.service'; then
  sleep 3
  sudo systemctl start screentinker-kiosk.service
fi

echo ""
echo "Done! Server: $(systemctl is-active screentinker-server.service)"
if systemctl list-unit-files | grep -q '^screentinker-kiosk.service'; then
  echo "      Kiosk:  $(systemctl is-active screentinker-kiosk.service)"
fi
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

if systemctl list-unit-files | grep -q '^screentinker-kiosk.service'; then
    if systemctl is-active screentinker-kiosk.service &>/dev/null; then
        echo "Kiosk:     RUNNING"
    else
        echo "Kiosk:     STOPPED"
    fi
fi

echo ""
echo "Uptime:    $(uptime -p)"
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

st_setup_clock "${SERVER_URL%/}"

if grep -q "#RuntimeWatchdogSec=0" /etc/systemd/system.conf 2>/dev/null; then
    sed -i 's/#RuntimeWatchdogSec=0/RuntimeWatchdogSec=10/' /etc/systemd/system.conf
    log "Hardware watchdog enabled (10s)"
fi

# Disable console blanking so the screen stays on during boot
if [ -f /etc/default/grub ]; then
    if ! grep -q "consoleblank=0" /etc/default/grub; then
        sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 consoleblank=0"/' /etc/default/grub
        update-grub >> "$LOG_FILE" 2>&1 && log "Console blanking disabled in GRUB" || warn "update-grub failed (non-fatal)"
    fi
fi

echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}   ScreenTinker Setup Complete!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""

IP=$(hostname -I | awk '{print $1}')

if [ "$MODE" = "both" ]; then
    echo "Mode: Server + Player"
    echo "Dashboard: http://${IP}:${SCREENTINKER_PORT}"
    echo "Player:    http://${IP}:${SCREENTINKER_PORT}/player"
elif [ "$MODE" = "server" ]; then
    echo "Mode: Server Only"
    echo "Dashboard: http://${IP}:${SCREENTINKER_PORT}"
else
    echo "Mode: Player Only"
    echo "Server: $SERVER_URL"
fi

echo ""
echo "Services:"
if [ "$NEED_SERVER" = true ]; then
    echo "  sudo systemctl [start|stop|restart] screentinker-server"
fi
if [ "$NEED_PLAYER" = true ]; then
    echo "  sudo systemctl [start|stop|restart] screentinker-kiosk"
fi
echo ""
echo -e "${YELLOW}Reboot to start:  sudo reboot${NC}"
echo ""
