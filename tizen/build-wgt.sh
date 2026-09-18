#!/bin/bash
# Build the ScreenTinker Tizen .wgt.
#  - If the Tizen CLI is available, sign with a security profile (arg 1, default
#    "ScreenTinker") and emit a signed, TV-installable .wgt.
#  - Otherwise, emit an UNSIGNED .wgt (plain zip) — fine for inspection / the
#    URL-Launcher path, but TVs need a signed package.
#  - `--store` builds ScreenTinker-store.wgt for the Samsung Apps TV Seller Office: the SAME app,
#    with the partner-only parts of config.xml stripped at package time (see store_manifest below).
# Only the app files are packaged (README/build script/.gitignore are excluded).
set -e
cd "$(dirname "$0")"
STORE=0
if [ "${1:-}" = "--store" ]; then STORE=1; shift; fi
OUT="ScreenTinker.wgt"; [ "$STORE" = 1 ] && OUT="ScreenTinker-store.wgt"
FILES="config.xml index.html icon.png css js"

# Samsung Apps TV Seller Office pre-test (2026-09-18) rejected the consumer submission on four
# counts, all one thing: config.xml is written for SSSP / B2B signage panels. On a consumer TV the
# B2B privileges are simply absent and device-control.js reports "unsupported" (README, #125), so
# the app runs identically without them — but the STORE refuses the manifest outright:
#   Background Support  background-support="enable" is partner-only
#   B2B API             developer.samsung.com/privilege/b2b*, serialport, ... not allowed
#   B2B API             systemcontrol, devicetimer, broadcast, ... are partner-level
#   B2B API             "wrong API version" — the same partner privileges vs required_version
# One manifest, two packages: the store build rewrites a COPY in the staging dir and never touches
# config.xml itself, so the SSSP build keeps its fleet-control surface.
store_manifest() {
  # $1 = config.xml to rewrite in place
  # Drop every developer.samsung.com privilege except network.public (public level), and turn
  # background support off. Also drop two tizen.org privileges nothing in the player calls
  # (audit 2026-09-18): application.launch (no launch()/launchAppControl() anywhere) and display
  # (a NATIVE-app key with no web API behind it). Samsung lists declared privileges to the user on
  # the store page, so the store copy declares only what the code exercises.
  sed -i -E \
    -e '/developer\.samsung\.com\/privilege\/(b2b|serialport|systemcontrol|documentplay|syncplay|devicetimer|streamingtvplayer|broadcast|remotepower)/d' \
    -e '/tizen\.org\/privilege\/(application\.launch|display)"/d' \
    -e 's/background-support="enable"/background-support="disable"/' "$1"
  if grep -q 'developer.samsung.com/privilege/' "$1"; then
    if grep 'developer.samsung.com/privilege/' "$1" | grep -qv 'network.public'; then
      echo "FATAL: a developer.samsung.com privilege other than network.public survived the store filter:" >&2
      grep 'developer.samsung.com/privilege/' "$1" | grep -v network.public >&2; exit 1
    fi
  fi
  grep -q 'background-support="enable"' "$1" && { echo "FATAL: background-support still enabled" >&2; exit 1; }
  echo "Store manifest: partner privileges + background-support stripped."
}

# Make the Tizen CLI discoverable if installed in the default location.
[ -d "$HOME/tizen-studio/tools/ide/bin" ] && export PATH="$HOME/tizen-studio/tools/ide/bin:$PATH"
rm -f "$OUT"

# #74/#75: refresh the bundled schedule evaluator from the single source so the
# .wgt always ships the canonical (byte-identical) copy, never a stale duplicate.
cp ../server/lib/schedule-eval.js js/schedule-eval.js
cp ../server/lib/play-order.js js/play-order.js

# #299: same single-source discipline for the offline proof-of-play queue — the .wgt must never
# carry a copy that has drifted from what the server and the web player agree on.
cp ../server/lib/offline-play-queue.js js/offline-play-queue.js

# transition-engine: rebuild the WebGL transition runtime (params + renderer + shaders) from
# shared/Transitions into the .wgt, same single-source discipline. No npm deps needed.
node -e "require('fs').writeFileSync('js/transitions.js', require('../server/lib/transition-bundle').bundle())" \
  && echo "Rebuilt js/transitions.js from shared/Transitions."

# #119: stamp the player version from the single source (config.xml) so the .wgt's
# reported app_version always matches what is installed — same idea as the copy above.
VER="$(grep -v '<?xml' config.xml | grep -oE 'version="[0-9][^"]*"' | head -1 | sed -E 's/version="([^"]+)"/\1/')"
if [ -n "$VER" ]; then
  sed -i.bak "s/var APP_VERSION_FALLBACK = '[^']*';/var APP_VERSION_FALLBACK = '$VER';/" js/app.js
  rm -f js/app.js.bak
  echo "Stamped APP_VERSION_FALLBACK = $VER from config.xml."
fi

if command -v tizen >/dev/null 2>&1; then
  PROFILE="${1:-ScreenTinker}"
  echo "Tizen CLI found — signing with profile '$PROFILE'…"
  STAGE="$(mktemp -d)"
  cp -r $FILES "$STAGE"/
  [ "$STORE" = 1 ] && store_manifest "$STAGE/config.xml"
  # `tizen package` names its output after <name> in config.xml (ScreenTinker.wgt). Package into a
  # private dir and move, so a --store build can never clobber the SSSP package beside it.
  mkdir -p "$STAGE/out"
  tizen package -t wgt -s "$PROFILE" -- "$STAGE" -o "$STAGE/out" >/dev/null
  mv "$STAGE/out/"*.wgt "$OUT"
  rm -rf "$STAGE"
  echo "Signed $OUT ready ($(du -h "$OUT" | cut -f1))."
else
  echo "Tizen CLI not found — building UNSIGNED $OUT."
  if [ "$STORE" = 1 ]; then
    STAGE="$(mktemp -d)"; cp -r $FILES "$STAGE"/; store_manifest "$STAGE/config.xml"
    (cd "$STAGE" && zip -r -X "$OLDPWD/$OUT" $FILES -x '*.DS_Store' '_*' >/dev/null); rm -rf "$STAGE"
  else
    zip -r -X "$OUT" $FILES -x '*.DS_Store' '_*' >/dev/null
  fi
  echo "Built $OUT ($(du -h "$OUT" | cut -f1), UNSIGNED — sign before installing on a TV)."
fi
# sssp_config.xml describes the SSSP / URL-Launcher package only; the store build has no use for it.
[ "$STORE" = 1 ] && { echo "Store build: sssp_config.xml left untouched."; exit 0; }

# SSSP URL-Launcher manifest. Host this + the .wgt in the SAME folder, then enter that folder's
# URL in a Samsung panel's URL Launcher / Custom App to natively install (the panel fetches
# <url>/sssp_config.xml, reads size+ver, downloads ScreenTinker.wgt). The ScreenTinker server
# also generates this dynamically at /tizen/sssp_config.xml — this static copy is for hosting the
# .wgt on a CDN/bucket instead.
#
# ⚠️ <size> IS IN KILOBYTES, NOT BYTES (#329). Writing the byte count here is what a panel reports
# as "Unable to install. Please try again later." — an OM55B on Tizen 5.0 refused a 126929-byte
# build advertised as <size>126929</size>, and installed the identical file once the value read
# 124. Nothing in the failure names the size, let alone the unit. Rounded UP, and regenerate this
# whenever the .wgt is (re-)signed, because the size changes.
WGT_BYTES=$(wc -c < "$OUT" | tr -d ' ')
WGT_SIZE=$(( (WGT_BYTES + 1023) / 1024 ))
# ⚠️ <ver> IS AN INTEGER, NOT THE SEMVER (#342). Same class of silent failure as the size above.
# An SSSP panel compares this numerically and installs only a STRICTLY HIGHER value than the one
# already on it. Writing "2.0.8" either fails the comparison or parses as 2, which can be LOWER
# than an integer the panel already has, so the package is refused with nothing naming the reason.
# Reported from the field on OM55B / SSSP v6 after #329, having been patched by hand to keep panels
# updating.
#
# Derived from the version rather than counted, so it needs no state, is identical in CI and on a
# workstation, and reads back: 2.0.8 -> 20008, 1.9.40 -> 10940. Monotonic as long as minor and
# patch stay below 100, which is asserted rather than assumed.
SSSP_MAJOR="${VER%%.*}"; SSSP_REST="${VER#*.}"
SSSP_MINOR="${SSSP_REST%%.*}"; SSSP_PATCH="${SSSP_REST#*.}"
case "$SSSP_MAJOR$SSSP_MINOR$SSSP_PATCH" in
  ''|*[!0-9]*) echo "FATAL: cannot derive an integer <ver> from '$VER'" >&2; exit 1 ;;
esac
if [ "$SSSP_MINOR" -gt 99 ] || [ "$SSSP_PATCH" -gt 99 ]; then
  echo "FATAL: version $VER breaks the <ver> encoding (minor/patch must stay under 100)" >&2
  exit 1
fi
SSSP_VER=$(( SSSP_MAJOR * 10000 + SSSP_MINOR * 100 + SSSP_PATCH ))

cat > sssp_config.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<widget>
	<ver>${SSSP_VER}</ver>
	<size>${WGT_SIZE}</size>
	<widgetname>ScreenTinker</widgetname>
	<webtype>tizen</webtype>
</widget>
EOF
echo "Wrote sssp_config.xml (ver ${SSSP_VER} from ${VER}, size ${WGT_SIZE} KB from ${WGT_BYTES} bytes)."
