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
