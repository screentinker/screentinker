#!/bin/bash
# Build the ScreenTinker native player for macOS: ScreenTinker.app inside ScreenTinker-<VERSION>.dmg.
#
#   native/packaging/macos/build.sh [VERSION]          (default: the repo's VERSION file)
#
# Output: native/dist/ScreenTinker-<VERSION>.dmg — the path the server's /download/mac looks in
# (server/lib/mac-cache.js). Needs: macOS 12+, Python 3.12 (python.org or Homebrew), Xcode command line
# tools (codesign, hdiutil).
#
# Signing, by environment:
#   (nothing)                      ad-hoc signature ("-"). Runs on the Mac that built it; on another Mac
#                                  Gatekeeper blocks it until it is approved in System Settings, or the
#                                  quarantine flag is removed. Fine for testing, not for a fleet.
#   ST_CODESIGN_IDENTITY="Developer ID Application: …"
#                                  hardened runtime + entitlements.plist, ready to notarize.
#   ST_NOTARY_PROFILE=<keychain profile from `xcrun notarytool store-credentials`>
#                                  also submits the .dmg to Apple's notary service and staples the ticket.
#   ST_TARGET_ARCH=universal2      only with a universal2 Python and universal2 wheels for every pin.
#
# ⚠️ Version strings: X.Y.Z or X.Y.Z~rcN, the same rule as the Pi and Windows builds.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATIVE=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$NATIVE/.." && pwd)
VERSION=${1:-$(tr -d '[:space:]' < "$REPO/VERSION")}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(~[0-9A-Za-z.]+)?$ ]] || { echo "bad version '$VERSION' (X.Y.Z or X.Y.Z~rcN)" >&2; exit 1; }
PYTHON=${PYTHON:-python3}

BUILD="$NATIVE/build/mac"
VENV="$BUILD/venv"
mkdir -p "$BUILD" "$NATIVE/dist"
[ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
PY="$VENV/bin/python"
"$PY" -m pip install --disable-pip-version-check -q -r "$HERE/requirements.txt"

# Stamp the version into the bundled copy only, restored afterwards (version.py falls back to the
# checkout for -dev).
VERFILE="$NATIVE/screentinker_native/version.py"
cp "$VERFILE" "$BUILD/version.py.orig"
trap 'cp "$BUILD/version.py.orig" "$VERFILE"' EXIT
sed -i '' "s/^_STAMPED = .*/_STAMPED = \"$VERSION\"/" "$VERFILE"
ST_BUNDLE_VERSION="$VERSION" "$PY" -m PyInstaller --noconfirm --clean \
    --distpath "$BUILD/dist" --workpath "$BUILD/work" "$HERE/screentinker.spec"
cp "$BUILD/version.py.orig" "$VERFILE"
APP="$BUILD/dist/ScreenTinker.app"

# Third-party notices inside the bundle: our MIT licence, every bundled Python distribution with its
# declared licence, then the LGPL statement Qt/PySide6 require (satisfied by dynamic linking: Qt and
# PySide6 ship as separate libraries inside the .app that a user can replace).
NOTICES="$APP/Contents/Resources/THIRD-PARTY-NOTICES.txt"
{
  echo "ScreenTinker Player $VERSION"; echo; cat "$REPO/LICENSE"; echo
  printf '=%.0s' {1..78}; echo; echo "Bundled third-party components"; printf '=%.0s' {1..78}; echo; echo
  "$PY" - <<'PYEOF'
import importlib.metadata as m
skip = {'pip', 'setuptools', 'pyinstaller', 'pyinstaller-hooks-contrib', 'altgraph', 'macholib', 'packaging'}
for d in sorted(m.distributions(), key=lambda d: (d.metadata['Name'] or '').lower()):
    n = d.metadata['Name']
    if not n or n.lower() in skip:
        continue
    lic = d.metadata.get('License-Expression') or d.metadata.get('License') or ''
    if not lic or len(lic) > 80:
        cls = [c.split('::')[-1].strip() for c in (d.metadata.get_all('Classifier') or []) if c.startswith('License ::')]
        lic = ', '.join(cls) or (lic[:80] + '...' if lic else 'see package')
    print(f'{n} {d.version} - {lic}')
PYEOF
  echo
  echo "Qt 6 and Qt for Python (PySide6, shiboken6) are licensed under the GNU Lesser General"
  echo "Public License v3 (LGPL-3.0). They are dynamically linked and may be replaced with a"
  echo "compatible build. Source: https://code.qt.io - https://www.qt.io/licensing/"
  echo "FFmpeg (bundled by Qt Multimedia) is licensed under the LGPL-2.1-or-later."
  echo "The PyInstaller bootloader is GPL-2.0 with the PyInstaller exception, which permits"
  echo "distributing it with programs under any licence."
} > "$NOTICES"

if [ -n "${ST_CODESIGN_IDENTITY:-}" ]; then
  codesign --force --deep --timestamp --options runtime --entitlements "$HERE/entitlements.plist" \
           --sign "$ST_CODESIGN_IDENTITY" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

DMG="$NATIVE/dist/ScreenTinker-$VERSION.dmg"
rm -f "$DMG"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
# ⚠️ Retried: hdiutil fails now and then with "Resource busy" when something on the Mac (Spotlight,
# XProtect, a lingering mount) holds the new volume for a moment. Seen on GitHub's macOS runners; the
# same command succeeds seconds later.
for attempt in 1 2 3 4 5; do
  if hdiutil create -volname "ScreenTinker $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null; then
    break
  fi
  if [ "$attempt" = 5 ]; then echo "hdiutil create failed 5 times" >&2; exit 1; fi
  echo "hdiutil create failed (attempt $attempt); retrying in $((attempt * 5)) s" >&2
  sleep $((attempt * 5))
done
rm -rf "$STAGE"
if [ -n "${ST_CODESIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$ST_CODESIGN_IDENTITY" "$DMG"
  if [ -n "${ST_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$ST_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi
echo "$DMG"
