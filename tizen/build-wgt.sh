#!/bin/bash
# Build the ScreenTinker Tizen .wgt.
#  - If the Tizen CLI is available, sign with a security profile (arg 1, default
#    "ScreenTinker") and emit a signed, TV-installable .wgt.
#  - Otherwise, emit an UNSIGNED .wgt (plain zip) — fine for inspection / the
#    URL-Launcher path, but TVs need a signed package.
# Only the app files are packaged (README/build script/.gitignore are excluded).
set -e
cd "$(dirname "$0")"
OUT="ScreenTinker.wgt"
FILES="config.xml index.html icon.png css js"

# Make the Tizen CLI discoverable if installed in the default location.
[ -d "$HOME/tizen-studio/tools/ide/bin" ] && export PATH="$HOME/tizen-studio/tools/ide/bin:$PATH"
rm -f "$OUT"

# #74/#75: refresh the bundled schedule evaluator from the single source so the
# .wgt always ships the canonical (byte-identical) copy, never a stale duplicate.
cp ../server/lib/schedule-eval.js js/schedule-eval.js

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
  tizen package -t wgt -s "$PROFILE" -- "$STAGE" -o "$PWD" >/dev/null
  rm -rf "$STAGE"
  echo "Signed $OUT ready ($(du -h "$OUT" | cut -f1))."
else
  echo "Tizen CLI not found — building UNSIGNED $OUT."
  zip -r -X "$OUT" $FILES -x '*.DS_Store' '_*' >/dev/null
  echo "Built $OUT ($(du -h "$OUT" | cut -f1), UNSIGNED — sign before installing on a TV)."
fi
