#!/bin/bash
# Build the ScreenTinker SERVER, packaged to run ON a player.
#
#   scripts/build-server-zip.sh            -> brightsign/server-all-in-one.zip
#   scripts/build-server-zip.sh --payload  -> brightsign/server-payload.zip   (the one that ships)
#
# ⚠️ THE DEFAULT BUILD DOES NOT BOOT, and no longer carries a name that implies it does. At ~73MB
# across 9,600 entries BrightSignOS's boot-time zip reader cannot open it — "ZipArchive error at
# line 91", then "Forcing recovery" — while provisioning unpacks the identical archive happily. It
# was called autorun-server.zip, which is the name an operator reaches for first, on the artifact
# guaranteed to fail. That name now belongs to build-server-boot-zip.sh.
#
# Kept because it is still the whole server in one file for manual install over SFTP, and because
# it is the control in the size experiment the two-stage design rests on.
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

[ -n "$OUT" ] || { [ "$PAYLOAD_ONLY" = 1 ] && OUT="brightsign/server-payload.zip" || OUT="brightsign/server-all-in-one.zip"; }

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
             | grep -E '\.(js|json|html|brs|css|sql|glsl)$' || true)"
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
    | grep -zZv -E '^server/(test|node_modules)/|^brightsign/media-tools/' \
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

# ---------------------------------------------------------------------------------------------
# ⚠️ THE LAUNCHER TRAVELS AT THE TOP LEVEL, so the ordinary tree replace installs it.
#
# The payload used to carry these only under brightsign/server/, and the installer copied them up to
# the root itself with fs.copyFileSync — a bespoke path its own comment called the riskiest copy in
# the project, wrapped in a catch that reported failure to a status listener bound to localhost.
#
# On a real XT245 that copy silently did nothing, TWICE, and nobody could have known: the payload
# installed, the server ran, and the launcher stayed frozen at whatever the boot zip first dropped.
# Every launcher fix since — including the 24h update check written to solve this exact class of
# problem — could never have reached a single box in the field.
#
# At the top level they are placed by the same rmSync+renameSync loop that already lands the other
# 9,630 files, which is proven on that hardware. rename() is also the safer verb: it never opens the
# destination, so replacing a script the running process has already require()d is atomic.
#
# ⚠️ autorun.brs is DELIBERATELY NOT HERE. It is the BrightScript boot entry and the recovery path
# when a launcher is broken — "a broken launcher is not a brick" is only true while autorun.brs comes
# from the boot zip and nothing else can overwrite it.
if [ "$PAYLOAD_ONLY" = 1 ]; then
  cp brightsign/server/bs-server-boot.js    "$STAGE/bs-server-boot.js"
  cp brightsign/server/bs-payload-install.js "$STAGE/bs-payload-install.js"
fi

# ---------------------------------------------------------------------------------------------
# Media tools, at the top level as bin/ — where stageMediaTools() in bs-server-boot.js looks
# (path.join(__dirname, 'bin', ...), and the payload installs INTO __dirname).
#
# PAYLOAD ONLY, deliberately. The boot zip is read by the OS's own zip reader at boot and a 73MB one
# failed outright with "ZipArchive error"; it is ~64KB and stays that way. These ride with the
# payload instead, which also means an update refreshes them.
#
# Shipped gzipped and stored (-0) rather than compressed, because they are already compressed —
# 3.2MB here against 6.7MB unpacked, which is what /tmp pays at runtime.
#
# ⚠️ A hard error rather than a warning. Both files are tracked, so absence means someone removed
# them, and the failure it would otherwise produce is a player that silently stops making video
# thumbnails - exactly the silent degradation this whole path was built to end.
if [ "$PAYLOAD_ONLY" = 1 ]; then
  echo "  staging media tools..."
  mkdir -p "$STAGE/bin"
  for tool in ffprobe ffmpeg; do
    src="brightsign/media-tools/$tool.gz"
    if [ ! -f "$src" ]; then
      echo "ERROR: $src is missing — the payload would ship without video thumbnails." >&2
      exit 1
    fi
    cp "$src" "$STAGE/bin/$tool.gz"
    echo "    bin/$tool.gz ($(du -h "$src" | cut -f1))"
  done
  # ⚠️ THE LICENCE TRAVELS WITH THE BINARIES. These are LGPL 2.1 and statically linked, so the
  # package that carries them has to carry the licence text too — a link on a website is not the
  # same thing as the copy the licence asks to accompany the work.
  if [ ! -f brightsign/media-tools/COPYING.LGPLv2.1 ]; then
    echo "ERROR: brightsign/media-tools/COPYING.LGPLv2.1 is missing — LGPL binaries cannot ship without it." >&2
    exit 1
  fi
  cp brightsign/media-tools/COPYING.LGPLv2.1 "$STAGE/bin/COPYING.LGPLv2.1"
  cp brightsign/media-tools/README.md        "$STAGE/bin/README.md"
  echo "    bin/COPYING.LGPLv2.1 + bin/README.md"
fi

# The player has no compiler, so the package must not carry better-sqlite3.
#
# NOTHING IS REWRITTEN HERE ANY MORE. db/sqlite-driver.js chooses at RUNTIME - native if it loads,
# node:sqlite otherwise - so the payload is main's code, unmodified. It used to be manufactured: this
# script dropped the dependency and then installed db/sqlite-compat.js into node_modules UNDER THE
# NAME better-sqlite3, which worked and shipped a database layer no test had ever executed.
#
# All that is left is to not install the native module. It is an optionalDependency, so
# `npm install --omit=optional` leaves it out and the runtime fallback does the rest.
echo "  omitting the native sqlite driver (runtime fallback handles it)..."
python3 - "$STAGE" <<'PY'
import json, os, sys
stage = sys.argv[1]
root = os.path.join(stage, 'server')

# The fallback is worthless without the shim and the chooser. Both are TRACKED source files, so if
# either is missing the staging step never saw it - which happened once because sqlite-compat.js had
# been written but not `git add`ed, and the only symptom was the server refusing to start with
# "Cannot find module './sqlite-compat.js'".
for required in ('sqlite-compat.js', 'sqlite-driver.js'):
    if not os.path.exists(os.path.join(root, 'db', required)):
        sys.exit("ERROR: server/db/%s is not in the staged tree - is it committed to git?" % required)

pkg = os.path.join(root, 'package.json')
d = json.load(open(pkg))
if 'better-sqlite3' in d.get('optionalDependencies', {}):
    del d['optionalDependencies']['better-sqlite3']
    if not d['optionalDependencies']:
        del d['optionalDependencies']
    print("    dropped better-sqlite3 (the player falls back to node:sqlite)")
if 'better-sqlite3' in d.get('dependencies', {}):
    sys.exit("ERROR: better-sqlite3 is a hard dependency again - the player cannot build native code.")
# The player has Node 24, and node:sqlite is unflagged only from 23.4 - on 22.x it needs
# --experimental-sqlite and the fallback would not load. Say so, so an install on anything older
# fails loudly rather than at the first query.
d['engines'] = {'node': '>=24.0.0'}
json.dump(d, open(pkg, 'w'), indent=2)
PY

echo "  installing production dependencies..."
( cd "$STAGE/server" && rm -f package-lock.json && npm install --omit=dev --omit=optional --no-audit --no-fund --silent )

# THE INVARIANT. A single .node file here means the package cannot run on the player, and the way
# you would find out is a boot loop on a box with no console.
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
# The native module must be ABSENT, not shimmed. If npm reinstalled it (a stray `dependencies`
# entry, a transitive requirement) the .node check above would usually catch it - but a
# prebuild-less install can leave the JS half on disk with no binary, which loads fine here and
# fails on the player at the first query.
if [ -e "$STAGE/server/node_modules/better-sqlite3" ]; then
  echo "ERROR: better-sqlite3 is present in the bundle — the player has no compiler for it." >&2
  exit 1
fi
for f in db/sqlite-driver.js db/sqlite-compat.js; do
  if [ ! -f "$STAGE/server/$f" ]; then
    echo "ERROR: server/$f missing — the runtime fallback to node:sqlite cannot work." >&2
    exit 1
  fi
done
echo "    no .node binaries, no better-sqlite3, node:sqlite fallback present — portable"

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
# ⚠️ bs-server-boot.js and bs-payload-install.js are REQUIRED AT THE TOP LEVEL, not just under
# brightsign/server/. That placement is the only thing that updates the launcher on a device: it is
# installed by the ordinary tree replace. A payload that carries them only in the subdirectory
# installs fine, runs fine, and leaves every player's launcher frozen forever — which is exactly what
# shipped in 2.0.0-alpha0 through alpha2 and was invisible until someone diffed a box by hand.
[ "$PAYLOAD_ONLY" = 1 ] && REQUIRED="server/server.js bin/ffprobe.gz bin/ffmpeg.gz bin/COPYING.LGPLv2.1 bs-server-boot.js bs-payload-install.js"
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

# ⚠️ A MANIFEST BESIDE THE PAYLOAD, GENERATED FROM THE BYTES JUST BUILT.
#
# The launcher has to answer "is there a newer server than the one installed?" without downloading
# 80MB to find out, so it reads this instead. Emitted here rather than written by hand because a
# manifest that can drift from its archive is worse than none: it is the classic OTA-loop condition
# — advertise one version, serve another, and every boot re-installs the same payload forever.
#
# The checksum is what makes the update safe to apply. A truncated download is a perfectly valid zip
# far more often than people expect, and "it unpacked" is not the same as "it is what we published".
if [ "$PAYLOAD_ONLY" = 1 ]; then
  MANIFEST="${OUT%.zip}.json"
  printf '{\n  "version": "%s",\n  "sha256": "%s",\n  "size": %s,\n  "built": "%s"\n}\n' \
    "$(cat VERSION)" \
    "$(sha256sum "$OUT" | cut -d" " -f1)" \
    "$(stat -c%s "$OUT")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MANIFEST"
  echo "  wrote $MANIFEST"
  sed 's/^/    /' "$MANIFEST"
fi
