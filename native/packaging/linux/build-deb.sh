#!/bin/bash
# Build screentinker-pi_<VERSION>_all.deb — the native Raspberry Pi player.
#
#   native/packaging/linux/build-deb.sh [VERSION]      (default: the repo's VERSION file)
#
# Output: native/dist/screentinker-pi_<VERSION>_all.deb — the path the server's /download/pi and
# /api/pi/update/check look in (server/lib/deb-cache.js), so a release build here is what panels
# self-update to. Architecture "all": the player is Python + QML; everything native (Qt, WebEngine,
# GStreamer) comes from the distribution's own arm64/armhf packages via Depends.
#
# ⚠️ PySide6 (LGPL-3.0), never PyQt6 (GPL-3.0): ScreenTinker ships no GPL code (see the licence
# position). PySide6 is packaged from Debian 13 "trixie" on, which is why the floor is python3 >= 3.13 —
# on Bookworm apt refuses the install cleanly instead of producing a player that cannot import Qt.
# Bookworm Pis use the web-kiosk installer (raspberry-pi-setup.sh without --native) or upgrade.
#
# ⚠️ Version strings: X.Y.Z or X.Y.Z~rcN. Never a Debian revision suffix (X.Y.Z-1): the server's
# semver compare reads that as a PRERELEASE of X.Y.Z and would never offer it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PI=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$PI/.." && pwd)
VERSION=${1:-$(tr -d '[:space:]' < "$REPO/VERSION")}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(~[0-9A-Za-z.]+)?$ ]] || { echo "bad version '$VERSION' (X.Y.Z or X.Y.Z~rcN)" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/root"
LIB="$ROOT/usr/lib/screentinker-pi"
mkdir -p "$LIB" "$ROOT/usr/bin" "$ROOT/lib/systemd/system" "$ROOT/etc/sudoers.d" \
         "$ROOT/etc/screentinker-pi" "$ROOT/etc/xdg/autostart" "$ROOT/DEBIAN" "$PI/dist"

# The package itself, minus tests and caches. The transition shader library travels with it so a panel
# never needs the server to run a transition (shared/Transitions is the single source).
rsync -a --exclude '__pycache__' --exclude '*.pyc' "$PI/screentinker_native" "$LIB/"
mkdir -p "$LIB/screentinker_native/transitions"
cp "$REPO"/shared/Transitions/*.glsl "$LIB/screentinker_native/transitions/"
# Stamp the version (version.py falls back to the checkout's VERSION only for "-dev").
sed -i "s/^_STAMPED = .*/_STAMPED = \"$VERSION\"/" "$LIB/screentinker_native/version.py"

install -m 0755 "$HERE/st-helper" "$LIB/st-helper"
install -m 0755 "$HERE/screentinker-pi" "$ROOT/usr/bin/screentinker-pi"
install -m 0644 "$HERE/screentinker-pi.service" "$ROOT/lib/systemd/system/screentinker-pi.service"
install -m 0644 "$HERE/screentinker-pi-desktop.desktop" "$ROOT/etc/xdg/autostart/screentinker-pi.desktop"
install -m 0440 "$HERE/sudoers" "$ROOT/etc/sudoers.d/screentinker-pi"

cat > "$ROOT/DEBIAN/control" <<EOF
Package: screentinker-pi
Version: $VERSION
Architecture: all
Maintainer: ScreenTinker <support@screentinker.com>
Section: video
Priority: optional
Homepage: https://screentinker.com
Depends: python3 (>= 3.13), python3-pyside6.qtcore, python3-pyside6.qtgui, python3-pyside6.qtqml,
 python3-pyside6.qtquick, python3-pyside6.qtmultimedia, python3-pyside6.qtwebenginequick,
 qml6-module-qtquick, qml6-module-qtquick-window, qml6-module-qtqml-workerscript,
 qml6-module-qtmultimedia, qml6-module-qtwebengine, qt6-qpa-plugins, qt6-shader-baker,
 python3-socketio (>= 5), python3-aiohttp, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good,
 gstreamer1.0-plugins-bad, gstreamer1.0-libav, fonts-noto-color-emoji, sudo, util-linux, curl
Recommends: cec-utils, ddcutil, alsa-utils, wlopm, x11-xserver-utils
Description: ScreenTinker native digital signage player for Raspberry Pi
 A native (Qt/QML) ScreenTinker player with Android-app parity: offline playback,
 zones, transitions, video walls and group sync, LAN triggers, remote view and
 control, an interactive remote terminal, power schedules and self-update.
EOF

cat > "$ROOT/DEBIAN/conffiles" <<EOF
/etc/sudoers.d/screentinker-pi
/etc/xdg/autostart/screentinker-pi.desktop
EOF

cat > "$ROOT/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  # The Lite service runs as a dedicated user WITHOUT sudo: the dashboard's remote shell runs as
  # this user, and a login user with NOPASSWD sudo (Pi OS's default) would make it root.
  if ! getent passwd screentinker >/dev/null; then
    adduser --system --group --home /var/lib/screentinker-pi --shell /bin/bash screentinker >/dev/null
  fi
  for g in video render input audio i2c gpio; do
    getent group "$g" >/dev/null && adduser screentinker "$g" >/dev/null 2>&1 || true
  done
  install -d -o screentinker -g screentinker -m 0750 /var/lib/screentinker-pi
  chown root:root /usr/lib/screentinker-pi/st-helper
  chmod 0755 /usr/lib/screentinker-pi/st-helper
  visudo -cf /etc/sudoers.d/screentinker-pi >/dev/null || { echo "sudoers check failed" >&2; rm -f /etc/sudoers.d/screentinker-pi; }
  [ -e /etc/modules-load.d/screentinker-pi.conf ] || echo i2c-dev > /etc/modules-load.d/screentinker-pi.conf
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    # Restart only if it was running: an upgrade must come back up, a fresh install waits for `setup`.
    if systemctl is-active --quiet screentinker-pi; then systemctl restart screentinker-pi || true; fi
  fi
fi
exit 0
EOF
cat > "$ROOT/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] && [ -d /run/systemd/system ]; then
  systemctl stop screentinker-pi 2>/dev/null || true
  systemctl disable screentinker-pi 2>/dev/null || true
fi
exit 0
EOF
chmod 0755 "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/prerm"

OUT="$PI/dist/screentinker-pi_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$OUT" >/dev/null
echo "$OUT"
