#!/bin/bash
# Build brightsign/autorun-server.zip — the ScreenTinker SERVER, packaged to run ON a player.
#
#   scripts/build-server-zip.sh [-o path/to/autorun-server.zip]
#
# Drop it on the storage root of a BrightSign running OS 10 (Node 24) and power-cycle. autozip.brs
# unpacks it in place and autorun.brs launches the server with roNodeJs, painting a diagnostic
# screen: URL, uptime, memory, disk, database size and a tail of the server's own console.
#
# ⚠️ THE BUNDLE MUST CONTAIN NO NATIVE CODE. That is the whole reason this is buildable on an
# x86_64 laptop for an aarch64 player. The server reaches SQLite through node:sqlite — built into
# the Node that BrightSignOS 10 already ships — via server/db/sqlite-compat.js. better-sqlite3 was
# the last native dependency; with it gone there is nothing to cross-compile, no ABI to match and
# no node-gyp to fail on a device with three slow cores. This script VERIFIES that rather than
# trusting it: any .node binary in the staged tree is a hard error, because the failure it would
# otherwise cause happens on the player, at boot, with no console.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=""
PAYLOAD_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    # Build the PAYLOAD half: everything except the boot files, for BrightSignOS 10 where a large
    # autorun.zip cannot be opened by the boot-time zip reader. scripts/build-server-boot-zip.sh
    # builds the other half, and bs-payload-install.js fetches this one onto the device.
    --payload) PAYLOAD_ONLY=1; shift ;;
    -o|--out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$OUT" ] || { [ "$PAYLOAD_ONLY" = 1 ] && OUT="brightsign/server-payload.zip" || OUT="brightsign/autorun-server.zip"; }

command -v zip >/dev/null || { echo "ERROR: 'zip' is not installed." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ⚠️ UNTRACKED FILES DO NOT SHIP, AND THE FAILURE LANDS ON THE PLAYER.
#
# Staging is `git ls-files`, which is the right call - it keeps databases, uploads and .env out by
# construction. The cost is that a NEW file that has not been `git add`ed is silently omitted while
# every file that requires it ships happily. That is not hypothetical twice over: it happened to
# db/sqlite-compat.js, and then to lib/fsutil.js, which reached a player as
#
#     Cannot find module '../lib/fsutil'
#     Require stack: /storage/ssd/server/db/database.js
#
# after a 73MB download and a two-minute extraction. The specific guard below for sqlite-compat.js
# was written after the first one; this is the general form, so there is no third.
UNTRACKED="$(git ls-files --others --exclude-standard -- server frontend scripts docs shared brightsign \
             | grep -E '\.(js|json|html|brs|css|sql)$' || true)"
if [ -n "$UNTRACKED" ]; then
  echo "ERROR: these source files are not tracked by git and would NOT be packaged:" >&2
  echo "$UNTRACKED" | sed 's/^/    /' >&2
  echo "  git add them (or remove them) before building." >&2
  exit 1
fi

echo "  staging server..."
mkdir -p "$STAGE/server"

# ⚠️ GIT DECIDES WHAT SHIPS. Not a hand-written exclude list.
#
# The first version of this used --exclude and it staged 291MB: server/db/remote_display.db (a real
# 33MB database), server/uploads (105MB of customer content), server/certs, and .env. Every one of
# those is already in .gitignore — the knowledge existed, the packager just was not using it. A
# manual list is also the wrong shape: it has to be updated every time someone adds a secret, and
# the failure mode is silent and shipped.
#
# `git ls-files` yields exactly the tracked source, so anything gitignored is excluded by
# construction and stays excluded as the repo grows. node_modules is installed fresh below rather
# than copied, so a developer's x86_64 better-sqlite3 cannot ride along either.
#
# THE SERVER IS NOT SELF-CONTAINED, so the package reproduces the repo layout rather than just
# server/. Discovered the hard way: it resolves ../frontend for the dashboard (config.js:34),
# ../scripts for the multi-tenancy migration, ../VERSION, ../brightsign to build the PLAYER package
# it serves at /api/brightsign/package, and ../docs. Ship server/ alone and it boots, migrates, and
# then dies on `Cannot find module '../../scripts/migrate-multitenancy'`.
#
# Deliberately NOT shipped: android/ (228MB of APK build), video/, Examples/, audit/, tizen/ —
# none of which the server reads at runtime.
for p in server frontend scripts docs shared brightsign VERSION package.json; do
  git ls-files -z -- "$p" \
    | grep -zZv -E '^server/(test|node_modules)/' \
    | while IFS= read -r -d '' f; do
        mkdir -p "$STAGE/$(dirname "$f")"
        cp "$f" "$STAGE/$f"
      done
done

if [ "$PAYLOAD_ONLY" = 0 ]; then
cp brightsign/server/autorun.brs        "$STAGE/autorun.brs"
cp brightsign/server/bs-server-boot.js  "$STAGE/bs-server-boot.js"
cp brightsign/server/server.env.example "$STAGE/server.env.example"
cp brightsign/server/node-server.html    "$STAGE/node-server.html"
cp brightsign/autozip.brs               "$STAGE/autozip.brs"
fi

# Point the server at the built-in driver. The shim is API-compatible, so no call site changes —
# this rewires the two places that construct a Database and drops the dependency entirely.
echo "  switching to node:sqlite..."
python3 - "$STAGE" <<'PY'
import json, os, sys
stage = sys.argv[1]
root = os.path.join(stage, 'server')

# The rewire is worthless without the shim itself. It is a TRACKED source file, so if it is missing
# the staging step never saw it — which happened once because it had been written but not `git
# add`ed, and the only symptom was the server refusing to start with "Cannot find module
# './sqlite-compat.js'".
shim = os.path.join(root, 'db', 'sqlite-compat.js')
if not os.path.exists(shim):
    sys.exit("ERROR: server/db/sqlite-compat.js is not in the staged tree — is it committed to git?")

# NOTHING IS REWRITTEN. The shim is installed UNDER THE NAME better-sqlite3 after npm runs (see
# below), so every require resolves to it by construction.
#
# Rewriting the requires textually was the obvious approach and it does not work: scripts/ reaches
# for the module three DYNAMIC ways —
#     require(resolveFromServer('better-sqlite3'))
#     require(require.resolve('better-sqlite3', { paths: [SERVER_DIR] }))
#     require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'))
# — none of which a string sweep can see. The first is in migrate-multitenancy.js, which runs during
# first boot, so the miss surfaced as "Migration FAILED" with a half-migrated database long after
# the server appeared to start cleanly.

pkg = os.path.join(root, 'package.json')
d = json.load(open(pkg))
if 'better-sqlite3' in d.get('dependencies', {}):
    del d['dependencies']['better-sqlite3']
    print("    dropped better-sqlite3 from dependencies")
# The player has Node 24; say so, so an accidental install on anything older fails loudly.
d['engines'] = {'node': '>=24.0.0'}
json.dump(d, open(pkg, 'w'), indent=2)
PY

echo "  installing production dependencies..."
( cd "$STAGE/server" && rm -f package-lock.json && npm install --omit=dev --no-audit --no-fund --silent )

# THE INVARIANT. A single .node file here means the package cannot run on the player, and the way
# you would find out is a boot loop on a box with no console.
# Install the façade under the real package's name. Done AFTER npm so nothing can overwrite it.
echo "  installing the node:sqlite shim as better-sqlite3..."
mkdir -p "$STAGE/server/node_modules/better-sqlite3"
printf '%s\n' \
  '{' \
  '  "name": "better-sqlite3",' \
  '  "version": "0.0.0-node-sqlite-shim",' \
  '  "description": "Not the real better-sqlite3 - a facade over node:sqlite so this bundle carries no native code.",' \
  '  "main": "index.js"' \
  '}' > "$STAGE/server/node_modules/better-sqlite3/package.json"
printf '%s\n' \
  '// Every require of better-sqlite3 in this bundle lands here, in whatever form it was written:' \
  "// plain, require.resolve with paths, or an absolute path into node_modules." \
  "module.exports = require('../../db/sqlite-compat.js');" \
  > "$STAGE/server/node_modules/better-sqlite3/index.js"
echo "    stub installed"

# ⚠️ ESM-ONLY PACKAGES DO NOT WORK INSIDE THE WIDGET.
#
# The player runs the server inside an Electron roHtmlWidget, and Electron's module loader does NOT
# implement require(ESM) - plain Node 24 does, which is why this only ever fails on hardware and
# never in a local test. An ESM-only dependency therefore gets compiled as CommonJS and dies on its
# first `export` keyword:
#
#     [boot] Migration FAILED: Failed to construct 'ContextifyScript': Invalid or unexpected token
#
# uuid 14 is the one that bites immediately (21 files import it, including the multi-tenancy
# migration that runs on first boot), and it is trivially replaceable: only `v4` is used anywhere,
# and crypto.randomUUID() produces exactly that. So it gets the same treatment as better-sqlite3 -
# a CommonJS package installed under the real name, after npm, so every require resolves to it.
# ⚠️ STRIP SHEBANGS. Electron's module loader does not remove them; Node's does.
#
# Node's CJS loader strips a leading #! before wrapping a file in the module function, precisely
# because a shebang is not valid JavaScript. Electron's loader does not, so the wrapper it compiles
# is "(function(){#!/usr/bin/env node ...})" and V8 refuses it:
#
#     [boot] Migration FAILED: Failed to construct 'ContextifyScript': Invalid or unexpected token
#
# Note the error names no token - "#" is not one. An ESM file compiled as CJS reports
# "Unexpected token 'export'" instead, which is how these two are told apart; chasing the ESM
# explanation for this error cost a full boot cycle.
#
# scripts/migrate-multitenancy.js is required during first boot, so it fails every time. Eight other
# shipped scripts carry the same line and would fail whenever something requires them.
#
# Done HERE and not in the source: those files are meant to be executable (./scripts/reset-admin.js),
# and the shebang is correct everywhere except inside this widget. The line is replaced by a comment
# of the same length rather than deleted, so line numbers in stack traces still match the source.
echo "  stripping shebangs (Electron does not strip them; Node does)..."
python3 - "$STAGE" <<'SHEBANG'
import io, os, sys
stage = sys.argv[1]
fixed = []
for root, dirs, files in os.walk(stage):
    if 'node_modules' in root.split(os.sep):
        continue
    for name in files:
        if not name.endswith('.js'):
            continue
        path = os.path.join(root, name)
        with io.open(path, 'rb') as fh:
            head = fh.read(2)
            if head != b'#!':
                continue
            rest = fh.read()
        data = b'#!' + rest
        nl = data.index(b'\n') if b'\n' in data else len(data)
        # '//' + the rest of the shebang keeps the byte count and the line count identical.
        with io.open(path, 'wb') as fh:
            fh.write(b'//' + data[2:nl] + data[nl:])
        fixed.append(os.path.relpath(path, stage))
for f in sorted(fixed):
    print("    " + f)
print("    %d file(s)" % len(fixed))
SHEBANG

echo "  installing a CommonJS uuid shim (Electron cannot require ESM)..."
mkdir -p "$STAGE/server/node_modules/uuid"
printf '%s\n' \
  '{' \
  '  "name": "uuid",' \
  '  "version": "0.0.0-cjs-shim",' \
  '  "description": "Not the real uuid - a CommonJS facade over crypto.randomUUID, because Electron cannot require the ESM-only uuid 14.",' \
  '  "main": "index.js"' \
  '}' > "$STAGE/server/node_modules/uuid/package.json"
printf '%s\n' \
  "const { randomUUID } = require('crypto');" \
  '// crypto.randomUUID() IS a v4 UUID (RFC 4122, random). Only v4 is used in this codebase; the' \
  '// others are present so an accidental import fails loudly rather than silently returning undefined.' \
  'const v4 = () => randomUUID();' \
  "const notImplemented = (name) => () => { throw new Error('uuid.' + name + ' is not available in the BrightSign build (CJS shim provides v4 only)'); };" \
  'module.exports = { v4, default: { v4 },' \
  "  v1: notImplemented('v1'), v3: notImplemented('v3'), v5: notImplemented('v5')," \
  "  v6: notImplemented('v6'), v7: notImplemented('v7')," \
  "  validate: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s)) };" \
  > "$STAGE/server/node_modules/uuid/index.js"
node -e "const u=require('$STAGE/server/node_modules/uuid'); const v=u.v4();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) { console.error('ERROR: uuid shim does not produce a v4 UUID: '+v); process.exit(1); }
  if(!u.validate(v)) { console.error('ERROR: uuid shim validate() rejects its own output'); process.exit(1); }
  console.log('    shim produces valid v4 UUIDs (' + v + ')');"

# What is still ESM-only, and therefore still a landmine on this platform? Report it rather than
# pretend it is handled - these fail only when their code path is first exercised on the player.
echo "  remaining ESM-only packages (fine under Node, FAIL inside the widget when first required):"
# Fed by heredoc, not `node -e '...'`: the scan needs both quote characters and nesting them
# inside a single-quoted shell argument mangles them.
node - "$STAGE" <<'ESMSCAN'
const fs = require("fs"), path = require("path");
const root = path.join(process.argv[2], "server", "node_modules");
const out = [];
const scan = (dir, depth) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith("@") && depth === 0) { scan(path.join(dir, d.name), 1); continue; }
    const pj = path.join(dir, d.name, "package.json");
    if (!fs.existsSync(pj)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(pj, "utf8")); } catch (e) { continue; }
    if (j.type !== "module") continue;
    // A CommonJS entry point, or a "require" condition in exports, means require() still works.
    if (j.main && !String(j.main).endsWith(".mjs")) continue;
    if (JSON.stringify(j.exports || "").includes(JSON.stringify("require"))) continue;
    out.push((j.name || d.name) + "@" + (j.version || "?"));
  }
};
scan(root, 0);
if (!out.length) console.log("    none");
else out.sort().forEach((n) => console.log("    " + n));
ESMSCAN

echo "  verifying the bundle is architecture-independent..."
if find "$STAGE" -name '*.node' -print -quit | grep -q .; then
  echo "ERROR: native binaries in the bundle — this cannot run on the player:" >&2
  find "$STAGE" -name '*.node' | sed 's/^/    /' >&2
  exit 1
fi
if ! grep -q "node-sqlite-shim" "$STAGE/server/node_modules/better-sqlite3/package.json" 2>/dev/null; then
  echo "ERROR: better-sqlite3 is the REAL package, not the shim — npm must have reinstalled it." >&2
  exit 1
fi
echo "    no .node binaries, better-sqlite3 is the shim — portable"

# THE SECOND INVARIANT, and the one that matters more. This package gets copied onto hardware that
# leaves the building. The first build of it contained a real 33MB customer database, 105MB of
# uploads, the TLS certs and .env — because the staging step used an exclude list instead of git.
# Verified rather than trusted, because "we removed it" is not a property, it is a memory.
# Verified, not assumed: one surviving shebang is one boot failure with a misleading error.
LEFTOVER="$(find "$STAGE" -name '*.js' -not -path '*/node_modules/*' -exec sh -c 'head -c2 "$1" | grep -q "#!" && echo "$1"' _ {} \; )"
if [ -n "$LEFTOVER" ]; then
  echo "ERROR: shebangs remain; these will fail to compile inside the widget:" >&2
  echo "$LEFTOVER" | sed 's/^/    /' >&2
  exit 1
fi
echo "    no shebangs remain in shipped scripts"

echo "  verifying no data or secrets are bundled..."
LEAKS="$(find "$STAGE" \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '.env' \
         -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.devbak' \) \
         -not -path '*/node_modules/*' -print)"
if [ -n "$LEAKS" ]; then
  echo "ERROR: the bundle contains data or secrets:" >&2
  echo "$LEAKS" | sed 's/^/    /' >&2
  exit 1
fi
for d in uploads certs data; do
  if [ -d "$STAGE/server/$d" ] && [ -n "$(ls -A "$STAGE/server/$d" 2>/dev/null)" ]; then
    echo "ERROR: server/$d is non-empty in the bundle — that is runtime state, not source." >&2
    exit 1
  fi
done
echo "    no databases, uploads, certs or .env"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

# -0 = STORED, for the same reason as the player package: BrightSign's deployment reported our
# first DEFLATED archive as invalid, and roBrightPackage documents "no compression" as the
# universally safe option. A compressed archive copies across perfectly and then fails to open.
( cd "$STAGE" && zip -q -r -X -0 "$ABS_OUT" . )

echo "  built $OUT ($(du -h "$ABS_OUT" | cut -f1))"

# Listed ONCE into a variable. `unzip -l | grep -q` looks obvious and is a trap here: grep -q exits
# at the first match, unzip dies of SIGPIPE, and under `set -o pipefail` the pipeline reports
# failure — so a file that IS present is reported missing. With 9000+ entries it fires every time.
LISTING="$(unzip -l "$OUT")"
echo "$LISTING" | tail -1 | sed 's/^/    /'
REQUIRED="autorun.brs autozip.brs bs-server-boot.js node-server.html"
# The payload is verified on the thing the installer actually looks for before it commits the
# extraction. An archive that unpacks perfectly and lacks this is the failure worth catching here.
[ "$PAYLOAD_ONLY" = 1 ] && REQUIRED="server/server.js"
for required in $REQUIRED; do
  case "$LISTING" in
    *" $required"*) ;;
    *) echo "ERROR: $required missing from the archive" >&2; exit 1 ;;
  esac
done
COMPRESSED="$(unzip -v "$OUT" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[A-Za-z]/ && $2 != "Stored" {print $2}' | head -1)"
if [ -n "$COMPRESSED" ]; then
  echo "ERROR: archive contains compressed members ($COMPRESSED); BrightSign needs it stored." >&2
  exit 1
fi
echo "  root-level layout verified, all members stored"
