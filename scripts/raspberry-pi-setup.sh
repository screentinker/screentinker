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

# -- Prompting when we are being piped --
#
# The documented install is `curl -sL … | sudo bash`, which makes stdin the SCRIPT, not the
# operator. bash has already consumed it by the time any `read` runs, so every prompt got EOF
# instantly: the mode menu "chose" All-in-One without the operator touching anything, and the
# Player-Only branch could never be reached that way at all. It looked like the menu was being
# skipped, because it was.
#
# So prompts read from the controlling terminal instead. When there genuinely is no terminal
# (cloud-init, a provisioning pipeline), we say so and take the documented default rather than
# pretending a choice was made — the operator can pass --player-only / --server-url to decide
# without a prompt.
if [ -r /dev/tty ] && [ -t 1 ]; then
    exec 3</dev/tty
    HAVE_TTY=true
else
    HAVE_TTY=false
fi

# ask <varname> <prompt> [read-args…]
ask() {
    local __var="$1"; shift
    local __prompt="$1"; shift
    if [ "$HAVE_TTY" = true ]; then
        read "$@" -u 3 -r -p "$__prompt" "$__var"
    else
        eval "$__var=''"
    fi
}

# -- Root check --
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root. Try:  curl -sL https://screentinker.com/scripts/raspberry-pi-setup.sh | sudo bash"
fi

# -- Architecture check --
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" && "$ARCH" != "armv7l" ]]; then
    warn "Detected architecture: $ARCH (expected aarch64 or armv7l for Raspberry Pi)"
    if [ "$HAVE_TTY" = true ]; then
        ask REPLY "Continue anyway? (y/N) " -n 1; echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    else
        err "Refusing to continue on $ARCH without a terminal to confirm at. Re-run interactively, or on the intended hardware."
    fi
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
    if [ "$HAVE_TTY" = false ]; then
        # No terminal to ask at. Say which way we went, rather than letting an empty answer
        # look like a decision — this is the exact confusion the piped-stdin bug produced.
        warn "No terminal available for the menu — defaulting to All-in-One."
        warn "To choose Player-Only non-interactively:  ... | sudo bash -s -- --player-only https://your-server"
    else
        ask MODE_CHOICE "Choose [1/2]: "
        case "$MODE_CHOICE" in
            2)
                PLAYER_ONLY=true
                while [ -z "$SERVER_URL" ]; do
                    ask SERVER_URL "Server URL (e.g., https://screentinker.com): "
                    [ -z "$SERVER_URL" ] && warn "Player-Only needs a server URL."
                done
                ;;
            *) ;;
        esac
    fi
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
# Chromium's package name differs by distro: Raspberry Pi OS / Ubuntu ship
# 'chromium-browser', Debian ships 'chromium'. Try the Pi/Ubuntu name first, then
# fall back to Debian's, so a bundled apt-get can't hard-fail (set -e) on a
# Debian-based player. No-op if a chromium is already present.
install_chromium() {
    if command -v chromium-browser &>/dev/null || command -v chromium &>/dev/null; then
        return 0
    fi
    apt-get install -y -qq chromium-browser >> "$LOG_FILE" 2>&1 || \
        apt-get install -y -qq chromium >> "$LOG_FILE" 2>&1
}
if [ "$HAS_DESKTOP" = false ]; then
    # Lite: install X11 + helpers, then Chromium (portable package name)
    apt-get install -y -qq \
        xserver-xorg x11-xserver-utils xinit \
        unclutter xdotool \
        >> "$LOG_FILE" 2>&1
    install_chromium
else
    # Desktop: X already running, just ensure Chromium + helpers
    apt-get install -y -qq unclutter xdotool >> "$LOG_FILE" 2>&1
    install_chromium
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

# Under systemd (Lite) stdout is the journal and JOURNAL_STREAM is set. Under the desktop
# autostart entry there is no journal at all, so keep a log file — screentinker-logs reads it.
if [ -z "\${JOURNAL_STREAM:-}" ]; then
    KLOG="\$HOME/screentinker-kiosk.log"
    [ -f "\$KLOG" ] && [ "\$(stat -c %s "\$KLOG" 2>/dev/null || echo 0)" -gt 1048576 ] && : > "\$KLOG"
    exec >> "\$KLOG" 2>&1
    echo "=== \$(date '+%F %T') kiosk launcher start ==="
fi

# Wait for display
sleep 2

# Which display server are we actually on? Pi 5 on Bookworm defaults to WAYLAND, where every
# X11 tool below is a no-op that prints an error into the journal and silently does nothing —
# so a Wayland Pi got no blanking suppression and no cursor hiding while appearing configured.
SESSION_TYPE="\${XDG_SESSION_TYPE:-}"
if [ -z "\$SESSION_TYPE" ]; then
    if [ -n "\${WAYLAND_DISPLAY:-}" ]; then SESSION_TYPE=wayland
    elif [ -n "\${DISPLAY:-}" ]; then SESSION_TYPE=x11
    fi
fi
echo "Display server: \${SESSION_TYPE:-unknown}"

if [ "\$SESSION_TYPE" = "wayland" ]; then
    # Blanking/DPMS belong to the compositor here, not to us. wlopm is present on Pi OS
    # (wlroots-based wayfire/labwc); if it is not, the compositor's own idle config is the
    # documented fallback and README says so.
    command -v wlopm >/dev/null 2>&1 && wlopm --on '*' 2>/dev/null || true
    # unclutter is X11-only — it exits immediately here, which is why a Wayland Pi kept its cursor
    # on screen while the install looked complete. Hiding it is the COMPOSITOR's job on Wayland;
    # the installer configures wayfire's hide-cursor plugin at install time (section 9b). If this
    # Pi runs labwc instead, there is no equivalent setting and the cursor stays — README says so
    # rather than this pretending otherwise.
else
    # Disable screen blanking and power management
    xset s off
    xset s noblank
    xset -dpms
    xset s 0 0

    # Hide cursor after 3 seconds of inactivity (X11 only — no Wayland equivalent)
    unclutter -idle 3 -root &
fi

# Clean Chromium crash flags (prevents restore session dialogs).
#
# The white page on every boot after the first is Chromium restoring a session it thinks
# crashed: a kiosk is killed by the shutdown, never exits cleanly, and comes back with a
# restore surface on top of the player — which is why ALT+F4 "fixed" it (it closed the
# surface, not the player). Rewriting the flags is not enough on its own because Chromium
# also replays the previous window set from Sessions/, so those go too.
CDIR="\$HOME/.config/chromium/Default"
clean_crash_flags() {
    mkdir -p "\$CDIR"
    if [ -f "\$CDIR/Preferences" ]; then
        sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "\$CDIR/Preferences" 2>/dev/null || true
        sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "\$CDIR/Preferences" 2>/dev/null || true
    fi
    rm -rf "\$CDIR/Sessions" "\$CDIR/Session Storage" 2>/dev/null || true
}
clean_crash_flags

# Wait for local server if running all-in-one
if echo "\$KIOSK_URL" | grep -q "localhost"; then
    echo "Waiting for ScreenTinker server..."
    for i in \$(seq 1 30); do
        if curl -sf "http://localhost:${SCREENTINKER_PORT}/api/status" >/dev/null 2>&1; then
            echo "Server ready"
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

# Wayland needs the ozone backend named explicitly on some Bookworm builds; on X11 the flag
# is absent so nothing changes there.
OZONE=""
[ "\$SESSION_TYPE" = "wayland" ] && OZONE="--ozone-platform=wayland"

# ONE kiosk per profile. Chromium holds SingletonLock (a symlink named host-pid) on the profile
# it is using; a second launch against the same profile does not open a second browser, it
# forwards its URL into the running one as a NEW TAB and exits. Under a supervisor that exit is
# a "crash", it is retried every ~10s, and each retry adds another tab and another renderer
# process to the browser that is actually on screen — a Pi OS Desktop install used to have two
# launchers (a systemd unit and the desktop autostart) racing for exactly this lock, and the
# loser leaked renderers until the Pi ran out of memory. The installer no longer writes the
# second launcher; this guard is what stops a future one from doing it again.
LOCK="\$HOME/.config/chromium/SingletonLock"
if [ -L "\$LOCK" ]; then
    LOCK_PID=\$(readlink "\$LOCK" 2>/dev/null | sed 's/.*-//')
    if [ -n "\$LOCK_PID" ] && kill -0 "\$LOCK_PID" 2>/dev/null; then
        echo "A kiosk browser is already running (pid \$LOCK_PID) — not starting a second one"
        exit 0
    fi
fi

# Crash recovery lives HERE, not in a second launcher. Chromium is run in a loop rather than
# exec'd: when it dies the loop cleans the crash flags again (else the restart restores the
# "crashed" session on top of the player) and brings it back after a short pause. On Lite the
# systemd unit still restarts the X session if THIS script dies; on Desktop this loop is the
# only supervisor, by design.
while :; do
    ${CHROMIUM_BIN} \\
    --kiosk \\
    \$OZONE \\
    --password-store=basic \\
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
    RC=\$?
    echo "Chromium exited (code \$RC) — restarting in 5s"
    sleep 5
    clean_crash_flags
done
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
# 8. Kiosk launcher supervision
# ============================================================
#
# Lite has no session to autostart from, so a systemd unit starts X (and through .xinitrc the
# launcher) on tty1. Desktop already HAS a session: the desktop autostart entry launches the
# kiosk at login, inside the compositor's environment, and the launcher restarts Chromium itself.
#
# ⚠️ EXACTLY ONE LAUNCHER PER INSTALL. Desktop used to get both — the autostart entry AND a
# systemd unit, "as fallback". The unit ran outside the Wayland session (no WAYLAND_DISPLAY), so
# its Chromium could not reach the compositor and exited; systemd restarted it every ~10s; each
# retry found the autostart's browser holding the profile lock, handed it the URL as a new tab,
# and exited again. One more tab and one more renderer per cycle, forever. Reported from a
# six-Pi headless deployment as "a major memory leak in the renderers", which is exactly what
# it looked like. The fallback was the fault; it is gone, and re-running the installer removes
# it from Pis that already have it.
log "Configuring kiosk launch..."

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
    systemctl daemon-reload
    systemctl enable screentinker-kiosk.service
    log "Kiosk service enabled (Lite: starts X on tty1)"
else
    # Desktop: the autostart entry is THE launcher. Remove the unit an earlier install wrote.
    if [ -f /etc/systemd/system/screentinker-kiosk.service ]; then
        log "Removing the redundant kiosk systemd unit (the desktop autostart is the launcher)..."
        systemctl disable --now screentinker-kiosk.service 2>/dev/null || true
        rm -f /etc/systemd/system/screentinker-kiosk.service
        systemctl daemon-reload
    fi
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
    log "Kiosk autostart entry written (Desktop: launches at login, restarts itself on crash)"
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
# 9b. Wayland cursor hiding (wayfire)
# ============================================================
# On X11 the launcher runs `unclutter -idle 3`. On Wayland unclutter cannot work at all — there is
# no root window to track and no client may move or hide another client's cursor — so hiding it is
# the compositor's decision. Pi OS Bookworm on Pi 4/5 defaults to wayfire, which has a hide-cursor
# plugin; this configures it. A previous version of this script claimed in a comment to do exactly
# this and never did, so a Wayland Pi sat there with a mouse pointer on the sign (#245).
#
# Written at install time rather than from the launcher because wayfire reads this at session
# start. It is also idempotent and non-destructive: a Pi whose owner has already tuned wayfire.ini
# keeps their settings, and the file is backed up before the first edit either way.
if [ -f "$PI_HOME/.config/wayfire.ini" ]; then
    log "Configuring wayfire to hide the cursor..."
    WF="$PI_HOME/.config/wayfire.ini"
    [ -f "${WF}.screentinker-bak" ] || cp "$WF" "${WF}.screentinker-bak"

    if grep -q '^\[hide-cursor\]' "$WF"; then
        log "  wayfire.ini already has [hide-cursor] — leaving it alone"
    else
        printf '\n[hide-cursor]\nhide_delay = 3000\n' >> "$WF"
    fi

    # The plugin only loads if it is named in core's plugin list, and that list is space-separated
    # on one line. Appending to it is fiddly enough to be worth doing carefully rather than with a
    # blind sed: only touch the line when it exists and does not already mention us.
    if grep -qE '^\s*plugins\s*=' "$WF"; then
        if ! grep -E '^\s*plugins\s*=' "$WF" | grep -q 'hide-cursor'; then
            sed -i 's/^\(\s*plugins\s*=.*\)$/\1 hide-cursor/' "$WF"
        fi
    else
        warn "wayfire.ini has no [core] plugins line — add 'hide-cursor' to it to hide the pointer"
    fi
    chown "$PI_USER":"$PI_USER" "$WF" 2>/dev/null || true
elif [ "$HAS_DESKTOP" = true ]; then
    # labwc (the newer Pi OS compositor) has no cursor-hiding option, and neither do we from the
    # outside. Say so plainly instead of leaving the operator to wonder whether it failed.
    if command -v labwc >/dev/null 2>&1; then
        warn "This Pi appears to run labwc, which has no cursor-hide setting — the pointer will stay visible."
        warn "Switch to wayfire (raspi-config > Advanced > Wayland) or to X11 if a hidden cursor matters."
    fi
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
KIOSK_UNIT=false
systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service' && KIOSK_UNIT=true

echo "Stopping services..."
[ "$KIOSK_UNIT" = true ] && sudo systemctl stop screentinker-kiosk.service 2>/dev/null || true
sudo systemctl stop screentinker-server.service 2>/dev/null || true

echo "Pulling latest..."
cd /opt/screentinker && git pull origin main

echo "Installing dependencies..."
cd server && npm install --production

echo "Starting services..."
sudo systemctl start screentinker-server.service
sleep 3
if [ "$KIOSK_UNIT" = true ]; then
    sudo systemctl start screentinker-kiosk.service
    KIOSK_STATE=$(systemctl is-active screentinker-kiosk.service)
else
    # Desktop: the kiosk is a session app. The player reconnects on its own once the server is up.
    KIOSK_STATE="desktop autostart (reconnects on its own)"
fi

echo ""
echo "Done! Server: $(systemctl is-active screentinker-server.service)"
echo "      Kiosk:  $KIOSK_STATE"
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

# Lite runs the kiosk as a unit; Desktop runs it from the session autostart, where the only
# evidence is the browser process itself.
if systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service'; then
    if systemctl is-active screentinker-kiosk.service &>/dev/null; then
        echo "Kiosk:     RUNNING"
    else
        echo "Kiosk:     STOPPED   (screentinker-logs kiosk to see why)"
    fi
elif pgrep -f -- '--kiosk' >/dev/null 2>&1; then
    echo "Kiosk:     RUNNING   (desktop autostart)"
else
    echo "Kiosk:     STOPPED   (desktop autostart: starts at login; screentinker-logs kiosk)"
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

    cat > /usr/local/bin/screentinker-logs << LOGSEOF
#!/bin/bash
# The kiosk logs to the journal under its unit on Lite, and to a file on Desktop (a session
# autostart has no journal of its own).
KIOSK_LOG="${PI_HOME}/screentinker-kiosk.log"
kiosk_logs() {
    if systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service'; then
        journalctl -u screentinker-kiosk.service -f --no-hostname
    else
        tail -n 200 -F "\$KIOSK_LOG"
    fi
}
case "\${1:-server}" in
    server) journalctl -u screentinker-server.service -f --no-hostname ;;
    kiosk)  kiosk_logs ;;
    all)    if systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service'; then
                journalctl -u screentinker-server.service -u screentinker-kiosk.service -f --no-hostname
            else
                echo "(kiosk log is a file on Desktop installs: \$KIOSK_LOG)"
                journalctl -u screentinker-server.service -f --no-hostname
            fi ;;
    *)      echo "Usage: screentinker-logs [server|kiosk|all]" ;;
esac
LOGSEOF
    chmod +x /usr/local/bin/screentinker-logs
else
    # Player-Only gets its own pair. It used to get NONE, while section 12 below wrote an MOTD
    # advertising all three to every install — so a player Pi greeted its operator at each SSH
    # login with three commands that were never on it (#245). There is no server here to update,
    # so screentinker-update is genuinely not applicable and is not offered; status and logs are,
    # and a player with no way to answer "is it running?" is the harder machine to support.
    log "Creating management scripts (player)..."

    cat > /usr/local/bin/screentinker-status << PSTATUSEOF
#!/bin/bash
echo ""
echo "=== ScreenTinker Player Status ==="
echo ""
if systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service'; then
    if systemctl is-active screentinker-kiosk.service &>/dev/null; then
        echo "Kiosk:     RUNNING"
    else
        echo "Kiosk:     STOPPED   (screentinker-logs to see why)"
    fi
elif pgrep -f -- '--kiosk' >/dev/null 2>&1; then
    echo "Kiosk:     RUNNING   (desktop autostart)"
else
    echo "Kiosk:     STOPPED   (desktop autostart: starts at login; screentinker-logs to see why)"
fi
echo "Server:    ${SERVER_URL}"
# Whether this player can actually reach the server it was pointed at — the first question worth
# asking on a panel that is showing nothing.
if curl -sf --max-time 5 "${SERVER_URL}/api/status" >/dev/null 2>&1; then
    echo "Reachable: yes"
else
    echo "Reachable: NO  (network, DNS, or the server is down)"
fi
echo ""
echo "Uptime:    \$(uptime -p)"
echo "CPU Temp:  \$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 || echo 'n/a')"
echo "Disk:      \$(df -h / 2>/dev/null | tail -1 | awk '{print \$3 "/" \$2 " (" \$5 " used)"}')"
echo "Memory:    \$(free -h | awk '/Mem:/ {print \$3 " / " \$2}')"
echo ""
PSTATUSEOF
    chmod +x /usr/local/bin/screentinker-status

    cat > /usr/local/bin/screentinker-logs << PLOGSEOF
#!/bin/bash
# Only the kiosk exists on a player, so it is the default AND the only target. Accepting
# "server" here and following an empty unit would be a worse answer than saying so.
# Lite logs to the journal under the unit; Desktop logs to a file (no journal for a session app).
KIOSK_LOG="${PI_HOME}/screentinker-kiosk.log"
case "\${1:-kiosk}" in
    kiosk|all) if systemctl list-unit-files 2>/dev/null | grep -q '^screentinker-kiosk.service'; then
                   journalctl -u screentinker-kiosk.service -f --no-hostname
               else
                   tail -n 200 -F "\$KIOSK_LOG"
               fi ;;
    server)    echo "This is a player-only install — there is no local server. Point at your server's logs instead." ;;
    *)         echo "Usage: screentinker-logs [kiosk]" ;;
esac
PLOGSEOF
    chmod +x /usr/local/bin/screentinker-logs
fi

# ============================================================
# 12. MOTD
# ============================================================
cat > /etc/motd << 'MOTDEOF'

 ____                                  _____  _         _
/ ___|   ___  _ __   ___   ___  _ __  |_   _|(_) _ __  | | __  ___  _ __
\___ \  / __|| '__| / _ \ / _ \| '_ \   | |  | || '_ \ | |/ / / _ \| '__|
 ___) || (__ | |   |  __/|  __/| | | |  | |  | || | | ||   < |  __/| |
|____/  \___||_|    \___| \___||_| |_|  |_|  |_||_| |_||_|\_\ \___||_|

 Open-Source Digital Signage for Any Screen

MOTDEOF

# The command list is appended SEPARATELY and per-mode, because section 11 creates
# screentinker-update on an All-in-One install only. A single hard-coded list here is what made a
# Player-Only Pi advertise three commands it did not have, at every SSH login (#245). The MOTD is
# the first thing an operator reads on a machine that is misbehaving, which makes it the worst
# place in the system to be confidently wrong.
if [ "$PLAYER_ONLY" = false ]; then
    cat >> /etc/motd << 'MOTDCMDEOF'
 Commands:
   screentinker-status   Show system info and URLs
   screentinker-update   Pull latest and restart
   screentinker-logs     Follow logs (server|kiosk|all)

MOTDCMDEOF
else
    cat >> /etc/motd << 'MOTDCMDEOF'
 Commands:
   screentinker-status   Kiosk state, server URL, and whether it is reachable
   screentinker-logs     Follow the kiosk log

MOTDCMDEOF
fi

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
if [ "$HAS_DESKTOP" = false ]; then
    echo "  sudo systemctl [start|stop|restart] screentinker-kiosk"
else
    echo "  Kiosk: launched at desktop login from ~/.config/autostart/screentinker.desktop"
    echo "         (restarts itself if Chromium crashes; log in ~/screentinker-kiosk.log)"
fi
echo ""
echo -e "${YELLOW}Reboot to start:  sudo reboot${NC}"
echo ""
