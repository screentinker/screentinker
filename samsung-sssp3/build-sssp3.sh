#!/usr/bin/env bash
set -euo pipefail
# Build the ScreenTinkerSSSP3 native package (Samsung SSSP3 / Orsay signage panels).
#
# Inputs:  app/            player source (widget.info + config.xml + ES5-safe scripts)
# Outputs: dist/
#            ScreenTinkerSSSP3.zip   deterministic ZIP (1980 timestamps, 0644, deflate)
#            sssp_config.xml         URL-Launcher manifest: <ver> + <size in BYTES>
#
# Determinism is the point: the same source tree rebuilds byte-identical packages,
# which is what lets an installed panel's manifest <size> be matched against the served
# ZIP without version drift. The Orsay <size> field is bytes (NOT kilobytes as on Tizen).
# Node 22+ and ./node_modules (npm install) are expected; Chromium is only needed for the
# optional browser smokes below.
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(node -e "const r=require(process.argv[1]); if(!Number.isSafeInteger(r.version)||r.version<1) process.exit(1); process.stdout.write(String(r.version))" "$root/release.json")
node "$root/prepare.js"
node "$root/tests/build-config.cjs"
node "$root/tests/legacy-block-functions.cjs"
node --test "$root/tests/native-bridge.test.js" "$root/tests/schedule-legacy.test.js" "$root/tests/offline-plan.test.js"
# Browser smoke tests are optional: they need a local Chromium (set CHROME_PATH).
if [ -x "${CHROME_PATH:-/usr/bin/chromium}" ]; then
  node "$root/tests/renderer-smoke.cjs"
  node "$root/tests/launcher-ready.cjs"
else
  echo "CHROME_PATH not found; skipping browser smoke tests"
fi
python3 - "$root" "$version" <<'PY'
from pathlib import Path
import hashlib, re, sys, tempfile, zipfile
root = Path(sys.argv[1]); source = root / 'dist'; target = source / 'ScreenTinkerSSSP3.zip'
html = (source / 'index.html').read_text()
for ref in re.findall(r'''(?:src|href)=["']([^"']+)["']''', html):
    if ref.startswith(('$MANAGER_WIDGET/', 'javascript:', '#')): continue
    if not (source / ref).is_file(): raise SystemExit('Missing packaged reference: ' + ref)
version = sys.argv[2]
config = (source / 'config.xml').read_text()
config, count = re.subn(r'<ver>\d+</ver>', '<ver>' + version + '</ver>', config, count=1)
if count != 1: raise SystemExit('Missing package version in config.xml')
excluded = {'ScreenTinkerSSSP3.zip', 'sssp_config.xml'}
files = [f for f in sorted(source.iterdir()) if f.is_file() and f.name not in excluded]
def make_zip(destination):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in files:
            data = config.encode() if f.name == 'config.xml' else f.read_bytes()
            entry = zipfile.ZipInfo(f.name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            z.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
make_zip(target)
with tempfile.NamedTemporaryFile(prefix='screentinker-sssp3-', suffix='.zip', delete=False) as temp:
    repro = Path(temp.name)
try:
    make_zip(repro)
    if target.read_bytes() != repro.read_bytes():
        raise SystemExit('Non-reproducible ZIP: two same-input archives differ')
finally:
    repro.unlink(missing_ok=True)
with zipfile.ZipFile(target) as z:
    bad = z.testzip()
    if bad: raise SystemExit('Corrupt ZIP entry: ' + bad)
    names = [i.filename for i in z.infolist()]
    if len(names) != len(set(names)): raise SystemExit('ZIP has duplicate entries')
    if any(name in excluded for name in names): raise SystemExit('ZIP contains a generated release artifact')
    if any(i.date_time != (1980, 1, 1, 0, 0, 0) for i in z.infolist()): raise SystemExit('ZIP contains non-deterministic entry timestamps')
    if any(i.external_attr != (0o100644 << 16) for i in z.infolist()): raise SystemExit('ZIP contains entries with unexpected permissions')
size = target.stat().st_size
(source / 'sssp_config.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<widget><ver>%s</ver><size>%s</size><widgetname>ScreenTinkerSSSP3</widgetname></widget>\n' % (version, size))
print('Built:', target, 'bytes:', size, 'sha256:', hashlib.sha256(target.read_bytes()).hexdigest())
PY
node "$root/verify.js"
