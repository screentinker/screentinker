#!/bin/bash
# Build webos/ScreenTinker.ipk for LG webOS Signage.
#
#   ./build-ipk.sh [out.ipk]                                   # ScreenTinker.ipk, id from appinfo.json
#   ./build-ipk.sh --app-id com.lg.app.signage [out.ipk]       # com.lg.app.signage.ipk
#
# --app-id builds the same app under another id, without touching appinfo.json. The one that matters
# is com.lg.app.signage: a panel in Local application launch mode installs a package with that id,
# named com.lg.app.signage.ipk, from the application/ folder of a USB stick (Server Settings ->
# Application Launch Mode: Local, Type: IPK, Local Application Upgrade: USB). The file name is also
# stamped into the shell, so the build updates itself from the file it was installed as.
#
# Uses LG's `ares-package` when it is on PATH (npm i -g @webos-tools/cli) and otherwise assembles
# the same Debian-style archive itself: an `ar` of debian-binary + control.tar.gz + data.tar.gz,
# with the app under usr/palm/applications/<id>/ and its packageinfo.json under
# usr/palm/packages/<id>/. CI has no LG CLI, so releases take the second path; the layout is what
# ares-package writes, but a build from a machine with the CLI is the one to trust for a fleet.
set -euo pipefail
cd "$(dirname "$0")"

APPID_OVERRIDE=""
if [ "${1:-}" = "--app-id" ]; then
  APPID_OVERRIDE="${2:-}"
  printf '%s' "$APPID_OVERRIDE" | grep -qE '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$' \
    || { echo "--app-id needs a reverse-DNS id such as com.lg.app.signage" >&2; exit 1; }
  shift 2
fi
# The name the server publishes this build under, and so the file it updates itself from.
IPK_FILE="ScreenTinker.ipk"
[ -n "$APPID_OVERRIDE" ] && IPK_FILE="$APPID_OVERRIDE.ipk"
OUT="${1:-$IPK_FILE}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac      # absolute: the archive is written from a temp dir
APPID="$(grep -oE '"id": *"[^"]+"' appinfo.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$APPID_OVERRIDE" ] && APPID="$APPID_OVERRIDE"
VER="$(grep -oE '"version": *"[^"]+"' appinfo.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
TITLE="$(grep -oE '"title": *"[^"]+"' appinfo.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
VENDOR="$(grep -oE '"vendor": *"[^"]+"' appinfo.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$APPID" ] && [ -n "$VER" ] || { echo "appinfo.json: id/version not found" >&2; exit 1; }

# Stamp the app version into the shell from the single source (appinfo.json), the same way the
# Tizen build stamps from config.xml.
sed -i.bak "s/var APP_VERSION_FALLBACK = '[^']*';/var APP_VERSION_FALLBACK = '$VER';/" js/app.js && rm -f js/app.js.bak

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/app"
mkdir -p "$APP/css" "$APP/js" "$APP/vendor"
cp appinfo.json index.html icon.png largeIcon.png "$APP/"
cp css/*.css "$APP/css/"
cp js/*.js "$APP/js/"
if [ -n "$APPID_OVERRIDE" ]; then
  sed -i.bak -E "s/(\"id\": *\")[^\"]+\"/\1$APPID\"/" "$APP/appinfo.json" && rm -f "$APP/appinfo.json.bak"
fi
sed -i.bak "s/var IPK_FILE = '[^']*';/var IPK_FILE = '$IPK_FILE';/" "$APP/js/app.js" && rm -f "$APP/js/app.js.bak"
[ -f config.json ] && cp config.json "$APP/"
if ls vendor/*.js >/dev/null 2>&1; then
  cp vendor/*.js "$APP/vendor/"
else
  echo "note: no SCAP files in vendor/ - the app will report no power/update capabilities (see vendor/README.md)" >&2
  # Empty stand-ins so index.html's <script src> tags resolve rather than 404 in the app log.
  for f in cordova.webos.js storage.js configuration.js deviceInfo.js power.js; do : > "$APP/vendor/$f"; done
fi

if command -v ares-package >/dev/null 2>&1; then
  ares-package -o "$STAGE/out" "$APP"
  BUILT="$(ls "$STAGE"/out/*.ipk | head -1)"
  cp "$BUILT" "$OUT"
  echo "Built $OUT with ares-package ($(wc -c < "$OUT") bytes, $APPID $VER)"
  exit 0
fi

DATA="$STAGE/data"
mkdir -p "$DATA/usr/palm/applications/$APPID" "$DATA/usr/palm/packages/$APPID" "$STAGE/control"
cp -R "$APP"/. "$DATA/usr/palm/applications/$APPID/"
cat > "$DATA/usr/palm/packages/$APPID/packageinfo.json" <<PKG
{
  "app": "$APPID",
  "id": "$APPID",
  "loc_name": "$TITLE",
  "package_format_version": 2,
  "vendor": "$VENDOR",
  "version": "$VER"
}
PKG
SIZE_KB="$(du -sk "$DATA" | cut -f1)"
cat > "$STAGE/control/control" <<CTL
Package: $APPID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $SIZE_KB
Maintainer: $VENDOR <hello@screentinker.com>
Description: $TITLE - digital signage player
webOS_package_format_version: 2
webOS_manifest_version: 1
CTL
( cd "$STAGE/control" && tar czf ../control.tar.gz --owner=0 --group=0 . )
( cd "$DATA" && tar czf ../data.tar.gz --owner=0 --group=0 . )
printf '2.0\n' > "$STAGE/debian-binary"
rm -f "$OUT"
( cd "$STAGE" && ar -rc "$OUT" debian-binary control.tar.gz data.tar.gz )
echo "Built $OUT without ares-package ($(wc -c < "$OUT") bytes, $APPID $VER)"
