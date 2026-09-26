#!/bin/bash
# Finalize a release with the artifacts that need the LOCAL signing keystore
# (which never goes into CI). After the release workflow has published the tag's
# GitHub Release (source tarball + unsigned .wgt + docker image), run this to:
#   1. build the SIGNED Android APK locally,
#   2. pull the CI-built unsigned .wgt back down from the release,
#   3. assemble a COMPLETE source tarball that bundles BOTH binaries
#      (extract it and ScreenTinker.apk sits at the root, ready for /download/apk),
#   4. upload the APK + the complete tarball to the release (replacing the
#      source-only tarball CI uploaded).
#
#   KEYSTORE_PASSWORD=... KEY_PASSWORD=... scripts/finalize-release.sh
#
# Requires: Android SDK + the release keystore (android/release-key.jks), the
# Tizen .wgt already on the release, and an authenticated gh CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat VERSION)"
TAG="v$VERSION"
: "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}"
: "${KEY_PASSWORD:?set KEY_PASSWORD}"

cleanup() { rm -f ScreenTinker.apk ScreenTinker.apk.version ScreenTinker.wgt "screentinker-$VERSION.tar.gz"; }
trap cleanup EXIT

echo "==> Building signed APK $VERSION"
( cd android && KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" KEY_PASSWORD="$KEY_PASSWORD" ./gradlew assembleRelease )
cp android/app/build/outputs/apk/release/app-release.apk ScreenTinker.apk
# #341: the APK declares its own version beside it, so a server never advertises a version it
# cannot actually serve. lib/apk-cache.js reads this; without it the server falls back to its own
# VERSION, which is only correct while server and APK ship together. An operator who mounts an
# older APK at /data/ScreenTinker.apk without a sidecar puts their displays in a reinstall loop.
printf '%s\n' "$VERSION" > ScreenTinker.apk.version

echo "==> Pulling the CI-built unsigned .wgt from release $TAG"
gh release download "$TAG" -p ScreenTinker.wgt --clobber

echo "==> Assembling complete tarball (source + apk + wgt)"
OUT="screentinker-$VERSION.tar.gz"
# NOTE: `tar` archives DOTFILES too, so anything secret sitting under server/ ships
# unless it is excluded by name. server/.env (Graph credentials) is gitignored, which
# is precisely why it never showed up in a diff - the exclude list is the only thing
# standing between it and a public release asset. Keep .env* and the local tooling
# configs here, and see the audit gate below, which is the real backstop.
# Exclude EVERY .env* / key-shaped file, then explicitly re-add the single legitimate
# one (.env.example, the config template self-hosters need). Doing it in that order
# means a new secret file is excluded by default rather than shipped by default - the
# exclusion is broad and the allowance is a named exception, not a glob that has to be
# gotten exactly right.
TMPTAR="${OUT%.gz}"
tar cf "$TMPTAR" \
  --exclude='node_modules' --exclude='.git' --exclude='.github' \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db.*' \
  --exclude='server/uploads' --exclude='server/certs' --exclude='server/test' \
  --exclude='.env*' --exclude='*/.env*' \
  --exclude='.mcp.json' --exclude='*/.mcp.json' \
  --exclude='*.jks' --exclude='*.keystore' --exclude='*.pem' --exclude='*.key' \
  --exclude='.jwt_secret' --exclude='*/.jwt_secret' \
  --exclude='.claude' --exclude='.cc-writes' \
  --exclude='brightsign/*.zip' --exclude='brightsign/server-payload.json' \
  server frontend scripts VERSION README.md LICENSE \
  ScreenTinker.apk ScreenTinker.apk.version ScreenTinker.wgt
tar rf "$TMPTAR" .env.example      # the one .env* that is meant to ship
gzip -f "$TMPTAR"                  # -> $OUT

# Secret gate. The exclude list above fails OPEN - a new secret file added under
# server/ ships unless someone remembers to add it. This gate fails CLOSED: it
# inspects what is actually IN the archive and refuses to upload if anything
# credential-shaped made it in. .env.example is deliberately shipped and allowed.
echo "==> Auditing $OUT for credential-shaped files"
# Match broadly, then subtract the single documented exception. Anything new that looks
# like a credential is caught by default; only .env.example is allowed through.
#
# ⚠️ `.claude/` JOINED THE LIST AFTER IT ACTUALLY SHIPPED. Every release tarball up to and
# including v2.0.0-alpha5 carried server/.claude/{settings.json,settings.local.json,hooks,skills,
# launch.json,loop.md,...} plus stray .cc-writes/ dirs. They were all ZERO BYTES - local tooling
# placeholders, nothing leaked - which is exactly why nobody noticed for months. The shape is the
# problem, not this instance of it: those are the filenames that hold real local configuration the
# moment the tooling writes any, and they sit inside a PUBLIC archive. Excluded above and caught
# here, because the exclude list fails open and this does not.
BAD="$(tar tzf "$OUT" \
  | grep -E '(^|/)(\.env|\.env\..*|\.mcp\.json|\.jwt_secret)$|\.(jks|keystore|pem|key|p12|pfx)$|(^|/)\.(claude|cc-writes)/' \
  | grep -vE '(^|/)\.env\.example$' || true)"
if [ -n "$BAD" ]; then
  echo "ERROR: refusing to upload - the archive contains credential-shaped files:" >&2
  printf '  %s\n' $BAD >&2
  echo "       Add an --exclude for each, then re-run." >&2
  exit 1
fi
# The template MUST be present - its absence is a silent regression for self-hosters.
if ! tar tzf "$OUT" | grep -qx '.env.example'; then
  echo "ERROR: .env.example is missing from the archive (over-broad exclude?)." >&2
  exit 1
fi
echo "    clean ($(tar tzf "$OUT" | wc -l) files, .env.example present)"

# ---------------------------------------------------------------------------
# The Vega .vpkg. bump-version.sh already built it as a pre-tag guard (it refuses to tag a
# package with no JS bundle), so on the machine that cut the tag it is sitting right here.
#
# ⚠️ IT LIVES IN A GITIGNORED DIRECTORY AND NOTHING EVER CLEARS IT. `vega/build/` survives a
# checkout, a branch switch and a failed bump, so the file present is not necessarily THIS
# release's - and a .vpkg for the previous version installs happily and then reports the wrong
# version to the dashboard forever. Trust vpkg-info.json, not the filename or the mtime.
VPKG_DIR=vega/build/armv7-release
VPKG="$VPKG_DIR/screentinker-vega_armv7.vpkg"
VPKG_INFO="$VPKG_DIR/vpkg-info.json"
if [ ! -f "$VPKG" ]; then
  echo "ERROR: $VPKG is missing, so $TAG would ship without the Vega package." >&2
  echo "       bump-version.sh builds it when the SDK is present; if the tag was cut on a" >&2
  echo "       machine without it, build it here and re-run:" >&2
  echo "           source ~/vega/env && cd vega && npm run build:release" >&2
  exit 1
fi
VPKG_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VPKG_INFO" 2>/dev/null | head -1)"
if [ "$VPKG_VERSION" != "$VERSION" ]; then
  echo "ERROR: $VPKG declares version '${VPKG_VERSION:-<none>}', not $VERSION - it is a STALE build." >&2
  echo "       Rebuild it, do not upload it:" >&2
  echo "           source ~/vega/env && cd vega && npm run build:release" >&2
  exit 1
fi
echo "==> Vega package OK: $(du -h "$VPKG" | cut -f1), declares $VPKG_VERSION"

echo "==> Uploading APK + complete tarball + Vega package to $TAG"
gh release upload "$TAG" "$OUT" ScreenTinker.apk ScreenTinker.apk.version "$VPKG" --clobber

echo "==> Done: $TAG now carries the standalone APK, the Vega .vpkg and a tarball bundling apk + wgt."

# ---------------------------------------------------------------------------
# COMPLETENESS GATE. This is the last step of a release, so it is the right and
# only place to answer "did we actually ship everything?".
#
# ⚠️ A MISSING ASSET IS SILENT. Nothing fails, no log says anything, the release page
# simply comes out short - and you find out when a customer's player downloads an
# artifact that is not there. v2.0.0-alpha4 and the first cut of alpha5 both shipped
# without autorun-server.zip and server-payload.zip because CI never built them; alpha5's
# had to be built and uploaded by hand after the fact. CI builds them now, and this
# refuses to call a release done if any expected asset is absent.
#
# ⚠️ THE LIST IS EXPLICIT, NOT DERIVED. Deriving it from what is present would make the
# check agree with whatever happened, which is precisely the failure being guarded.
# Adding an artifact means adding it here, deliberately.
EXPECTED="
autorun.zip
autorun-server.zip
server-payload.zip
server-payload.json
ScreenTinker.apk
ScreenTinker.wgt
ScreenTinker.ipk
screentinker-$VERSION.tar.gz
screentinker-sbom-$VERSION.cdx.json
screentinker-vega_armv7.vpkg
"
echo "==> Checking $TAG carries every expected asset"
PRESENT="$(gh release view "$TAG" --json assets -q '.assets[].name')"
MISSING=""
for a in $EXPECTED; do
  printf '%s\n' "$PRESENT" | grep -qxF "$a" || MISSING="$MISSING $a"
done
if [ -n "$MISSING" ]; then
  echo "ERROR: $TAG is missing expected release asset(s):" >&2
  for a in $MISSING; do echo "  $a" >&2; done
  echo "       The BrightSign server-mode artifacts come from .github/workflows/release.yml" >&2
  echo "       (build-server-boot-zip.sh + build-server-zip.sh --payload). Build and upload the" >&2
  echo "       missing ones with 'gh release upload $TAG <file> --clobber', then re-run." >&2
  exit 1
fi
echo "    all $(printf '%s' "$EXPECTED" | wc -w) expected assets present"

# ⚠️ AND THE PAYLOAD MANIFEST MUST DESCRIBE THE PAYLOAD IT SHIPS WITH. The launcher reads
# the .json to decide whether to install the .zip, so a mismatched pair tells every
# player a version is available that the archive does not contain - and the install
# then fails its own checksum verification, on the device, in the field.
echo "==> Verifying the payload manifest matches the payload"
TMPD="$(mktemp -d)"
gh release download "$TAG" -p server-payload.json -p server-payload.zip -D "$TMPD" --clobber
M_SHA="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['sha256'])" "$TMPD/server-payload.json")"
M_VER="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$TMPD/server-payload.json")"
Z_SHA="$(sha256sum "$TMPD/server-payload.zip" | awk '{print $1}')"
rm -rf "$TMPD"
if [ "$M_SHA" != "$Z_SHA" ]; then
  echo "ERROR: server-payload.json sha256 ($M_SHA)" >&2
  echo "       does not match server-payload.zip ($Z_SHA)." >&2
  exit 1
fi
if [ "$M_VER" != "$VERSION" ]; then
  echo "ERROR: server-payload.json says version $M_VER, this release is $VERSION." >&2
  exit 1
fi
echo "    manifest and payload agree ($M_VER, ${M_SHA%"${M_SHA#????????}"}...)"
