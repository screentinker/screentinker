#!/bin/bash
# Build brightsign/autorun-boot.zip — ONLY the four files needed to start, no server payload.
#
#   scripts/build-server-boot-zip.sh [-o path]
#
# WHY THIS EXISTS. The full server package is ~73MB across 9,356 entries, and BrightSignOS cannot
# open it: the boot-time autorun scan reports
#
#     Failed to use zipped 'SSD:/autorun.zip': ZipArchive error at line 91
#
# and falls through to "Load or runtime error in autorun. Forcing recovery." Provisioning CAN unpack
# the same archive — the files land on disk — so the limit is specifically in the OS's own zip
# reader, not in the archive. Path lengths (max 182 chars) and depth (8) are well inside anything
# reasonable, which leaves size and entry count.
#
# So the OS gets an archive shaped exactly like the player package that already works on this
# hardware: a handful of small files, STORED, at the root. The ~71MB of server + node_modules is
# delivered separately and unpacked by Node, which has no such limit.
#
# This build is deliberately ALSO the isolation test: if the player boots this and shows
# "server payload not installed" on screen, the size hypothesis is confirmed and the two-stage
# design is right. If it still fails to open THIS, the problem is something else entirely and no
# amount of splitting would have helped.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="brightsign/autorun-boot.zip"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v zip >/dev/null || { echo "ERROR: 'zip' is not installed." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp brightsign/autozip.brs                "$STAGE/autozip.brs"
cp brightsign/server/autorun.brs         "$STAGE/autorun.brs"
cp brightsign/server/bs-server-boot.js   "$STAGE/bs-server-boot.js"
cp brightsign/server/bs-payload-install.js "$STAGE/bs-payload-install.js"
cp brightsign/server/node-server.html    "$STAGE/node-server.html"
cp brightsign/server/server.env.example  "$STAGE/server.env.example"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
# STORED, for the same reason as every other package here: roBrightPackage documents "no
# compression" as the universally safe option, and a deflated archive deploys perfectly then fails
# to open on the player.
( cd "$STAGE" && zip -q -r -X -0 "$ABS_OUT" . )

echo "  built $OUT ($(du -h "$ABS_OUT" | cut -f1))"
unzip -l "$OUT" | sed 's/^/    /'
LISTING="$(unzip -l "$OUT")"
for required in autorun.brs autozip.brs bs-server-boot.js bs-payload-install.js node-server.html; do
  case "$LISTING" in *" $required"*) ;; *) echo "ERROR: $required missing" >&2; exit 1 ;; esac
done
COMPRESSED="$(unzip -v "$OUT" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[A-Za-z]/ && $2 != "Stored" {print $2}' | head -1)"
[ -n "$COMPRESSED" ] && { echo "ERROR: compressed members present" >&2; exit 1; }
echo "  root-level layout verified, all members stored"
