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
# Packaging is done by LG's own `ares-package` (npm i -g @webos-tools/cli) whenever it is on PATH;
# CI installs it, so a release .ipk is exactly what LG's tool writes. Only when the tool is missing
# does the script assemble the archive itself, byte-for-byte in the same shape ares-package writes:
# an `ar` of debian-binary + control.tar.gz + data.tar.gz, plain member names, the control record
# with LG's field names, the app under usr/palm/applications/<id>/ and its packageinfo.json under
# usr/palm/packages/<id>/, no "./" prefixes. Either way the result is unpacked and checked before
# the script reports success, so a package that would not install is never published.
#
# ares-package is told not to minify. The shell is hand-written ES5 so that a webOS 4 panel's
# Chrome 53 can run it, and a minifier is one more thing that could change that under us.
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
printf '%s' "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "appinfo.json: version must be numeric x.y.z, got '$VER'" >&2; exit 1; }

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

# ---------------------------------------------------------------------------------------------
# Check the finished archive the way a panel reads it. Every assertion here is one a real install
# depends on; a failure is a build error, never a warning.
verify() {
  local f="$1" dir="$STAGE/verify" members
  rm -rf "$dir"; mkdir -p "$dir"
  ( cd "$dir" && ar x "$f" ) || { echo "verify: $f is not an ar archive" >&2; return 1; }
  members="$(ar t "$f" | tr '\n' ' ')"
  [ "$members" = "debian-binary control.tar.gz data.tar.gz " ] \
    || { echo "verify: members are '$members', expected debian-binary control.tar.gz data.tar.gz" >&2; return 1; }
  [ "$(cat "$dir/debian-binary")" = "2.0" ] || { echo "verify: debian-binary is not 2.0" >&2; return 1; }
  mkdir -p "$dir/c" "$dir/d"
  tar xzf "$dir/control.tar.gz" -C "$dir/c" || { echo "verify: control.tar.gz does not unpack" >&2; return 1; }
  tar xzf "$dir/data.tar.gz" -C "$dir/d" || { echo "verify: data.tar.gz does not unpack" >&2; return 1; }
  [ -f "$dir/c/control" ] || { echo "verify: no control file in control.tar.gz" >&2; return 1; }
  grep -qE "^Package: $APPID\$" "$dir/c/control" || { echo "verify: control Package is not $APPID" >&2; return 1; }
  grep -qE "^Version: $VER\$" "$dir/c/control" || { echo "verify: control Version is not $VER" >&2; return 1; }
  grep -qE "^Architecture: all\$" "$dir/c/control" || { echo "verify: control Architecture is not all" >&2; return 1; }
  local a="$dir/d/usr/palm/applications/$APPID" p="$dir/d/usr/palm/packages/$APPID/packageinfo.json"
  for need in appinfo.json index.html icon.png largeIcon.png js/app.js js/device-control.js css/style.css; do
    [ -s "$a/$need" ] || { echo "verify: $need missing or empty under usr/palm/applications/$APPID/" >&2; return 1; }
  done
  grep -qE "\"id\": *\"$APPID\"" "$a/appinfo.json" || { echo "verify: packaged appinfo.json id is not $APPID" >&2; return 1; }
  grep -qE "\"version\": *\"$VER\"" "$a/appinfo.json" || { echo "verify: packaged appinfo.json version is not $VER" >&2; return 1; }
  [ -s "$p" ] || { echo "verify: packageinfo.json missing" >&2; return 1; }
  grep -qE "\"id\": *\"$APPID\"" "$p" || { echo "verify: packageinfo.json id is not $APPID" >&2; return 1; }
  grep -qE "\"version\": *\"$VER\"" "$p" || { echo "verify: packageinfo.json version is not $VER" >&2; return 1; }
  grep -qE "var IPK_FILE = '$IPK_FILE';" "$a/js/app.js" || { echo "verify: app.js is not stamped with IPK_FILE=$IPK_FILE" >&2; return 1; }
  grep -qE "var APP_VERSION_FALLBACK = '$VER';" "$a/js/app.js" || { echo "verify: app.js is not stamped with version $VER" >&2; return 1; }
  # Anything other than plain paths (a "./" prefix, an absolute path) is not what ares-package writes.
  if tar tzf "$dir/data.tar.gz" | grep -qvE '^usr/'; then
    echo "verify: data.tar.gz has entries outside usr/ (a './' prefix?)" >&2; return 1
  fi
  if command -v ares-package >/dev/null 2>&1; then
    ares-package -i "$f" >/dev/null 2>&1 || { echo "verify: ares-package cannot read $f" >&2; return 1; }
  fi
}

if command -v ares-package >/dev/null 2>&1; then
  ares-package --no-minify -o "$STAGE/out" "$APP" >/dev/null
  BUILT="$(ls "$STAGE"/out/*.ipk | head -1)"
  cp "$BUILT" "$OUT"
  verify "$OUT" || { rm -f "$OUT"; exit 1; }
  echo "Built $OUT with ares-package $(ares-package --version 2>/dev/null | head -1) ($(wc -c < "$OUT") bytes, $APPID $VER, verified)"
  exit 0
fi

DATA="$STAGE/data"
CONTROL="$STAGE/control"
mkdir -p "$DATA/usr/palm/applications/$APPID" "$DATA/usr/palm/packages/$APPID" "$CONTROL"
cp -R "$APP"/. "$DATA/usr/palm/applications/$APPID/"
# The same packageinfo.json ares-package writes.
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
# LG's field names (webOS-Package-Format-Version, webOS-Packager-Version), exactly as ares-package
# spells them; earlier builds wrote webOS_package_format_version, which no LG tool writes.
cat > "$CONTROL/control" <<CTL
Package: $APPID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $SIZE_KB
Maintainer: $VENDOR <hello@screentinker.com>
Description: $TITLE - digital signage player
webOS-Package-Format-Version: 2
webOS-Packager-Version: build-ipk.sh
CTL
# ustar, plain relative paths (no "./"), root-owned: the layout ares-package writes.
TARFLAGS=(--format=ustar --owner=0 --group=0 --numeric-owner)
( cd "$CONTROL" && tar czf ../control.tar.gz "${TARFLAGS[@]}" control )
( cd "$DATA" && tar czf ../data.tar.gz "${TARFLAGS[@]}" usr )
printf '2.0\n' > "$STAGE/debian-binary"

# The ar archive, written here rather than by ar(1): GNU ar always writes its own "name/" member
# spelling, and this is the plain spelling ares-package (and dpkg) writes. Every header is 60 bytes:
# name(16) mtime(12) uid(6) gid(6) mode(8) size(10) and the "`\n" magic; members are padded to an
# even length.
NOW="$(date +%s)"
rm -f "$OUT"
printf '!<arch>\n' > "$OUT"
for m in debian-binary control.tar.gz data.tar.gz; do
  size="$(wc -c < "$STAGE/$m")"
  printf '%-16s%-12s%-6s%-6s%-8s%-10s`\n' "$m" "$NOW" 0 0 100644 "$size" >> "$OUT"
  cat "$STAGE/$m" >> "$OUT"
  [ $((size % 2)) -eq 1 ] && printf '\n' >> "$OUT"
done
verify "$OUT" || { rm -f "$OUT"; exit 1; }
echo "Built $OUT without ares-package ($(wc -c < "$OUT") bytes, $APPID $VER, verified)"
