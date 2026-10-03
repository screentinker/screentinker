#!/bin/bash
# Build webos/ScreenTinker.ipk for LG webOS Signage.
#
# Uses LG's `ares-package` when it is on PATH (npm i -g @webos-tools/cli) and otherwise assembles
# the same Debian-style archive itself: an `ar` of debian-binary + control.tar.gz + data.tar.gz,
# with the app under usr/palm/applications/<id>/ and its packageinfo.json under
# usr/palm/packages/<id>/. CI has no LG CLI, so releases take the second path; the layout is what
# ares-package writes, but a build from a machine with the CLI is the one to trust for a fleet.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-ScreenTinker.ipk}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac      # absolute: the archive is written from a temp dir
APPID="$(grep -oE '"id": *"[^"]+"' appinfo.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
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
