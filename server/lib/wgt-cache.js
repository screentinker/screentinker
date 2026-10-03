'use strict';

// Resolve the Tizen .wgt for the SSSP URL-Launcher install flow (mirrors lib/apk-cache.js).
// The path/size/mtime are resolved once at boot and refreshed on an interval, so a panel
// polling /tizen/sssp_config.xml can never turn into a per-request statSync flood.
//
// The SIGNED .wgt is provided out-of-band (like the APK): container operators mount it at
// /data/ScreenTinker.wgt. The in-repo tizen/ copy (usually unsigned, inspection-only) is a
// last-resort fallback so a dev box still serves *something*.
//
// size is the load-bearing field, and its UNIT is the thing that bites: sssp_config.xml reports
// KILOBYTES, not bytes (#329). We stored and emitted the byte length, so a 126929-byte .wgt
// advertised <size>126929</size> and an OM55B refused it with "Unable to install. Please try
// again later." — no clue that a unit was the problem. Correcting the value by hand to 124 made
// the same file install. cache.size stays in BYTES (the landing page renders MB from it); only
// ssspConfigXml() converts, so there is exactly one place that knows the manifest's unit.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function candidates() {
  return [
    path.join(config.dataDir, 'ScreenTinker.wgt'),          // operator mount (signed) — wins
    path.join(__dirname, '..', '..', 'ScreenTinker.wgt'),   // repo root (release artifact)
    path.join(__dirname, '..', '..', 'tizen', 'ScreenTinker.wgt'), // in-repo build (usually unsigned)
  ];
}

/*
 * Version reported in sssp_config.xml <ver>.
 *
 * ⚠️ IT IS AN INTEGER, NOT THE SEMVER (#342). An SSSP panel compares this numerically and installs
 * only a STRICTLY HIGHER value than the one it already has. Emitting "2.0.8" either fails the
 * comparison outright or parses as 2, which can be LOWER than an integer already installed, so the
 * package is refused and nothing in the failure names the version. Reported from the field on
 * OM55B / SSSP v6, where it had to be patched by hand for every build to keep panels updating.
 * The same silent shape as the <size> unit bug in #329, and it shipped in the same file.
 *
 * Derived from the app version rather than counted: no state to keep, identical in CI and on a
 * workstation, and it reads back (2.0.8 -> 20008, 1.9.40 -> 10940). Monotonic while minor and
 * patch stay under 100.
 *
 * TIZEN_WGT_VER stays as the escape hatch for an operator hosting a differently-versioned signed
 * build, but it must now BE the integer, and an unparseable one is refused rather than passed to a
 * panel: advertising a version the panel cannot compare is how this failed in the first place.
 */
function ssspVer(semver) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(semver || ''));
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
  if (minor > 99 || patch > 99) return null;
  return major * 10000 + minor * 100 + patch;
}

const VERSION = (() => {
  const override = process.env.TIZEN_WGT_VER;
  if (override !== undefined && override !== '') {
    if (/^\d+$/.test(override.trim())) return Number(override.trim());
    console.warn(`[tizen] ignoring TIZEN_WGT_VER="${override}": <ver> must be a positive integer`);
  }
  let v = null;
  try { v = ssspVer(require('../package.json').version); } catch (_) { v = null; }
  if (v === null) console.warn('[tizen] could not derive an integer <ver> from the app version');
  return v === null ? 1 : v;
})();

let cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };

function refresh() {
  for (const p of candidates()) {
    try {
      const st = fs.statSync(p);
      cache = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: VERSION };
      return cache;
    } catch (_) { /* next candidate */ }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };
  return cache;
}

function get() { return cache; }

let timer = null;
function start() {
  refresh();
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);  // reuse the APK refresh cadence
    if (timer.unref) timer.unref();
  }
  return cache;
}

// The SSSP manifest the panel fetches at <entered-url>/sssp_config.xml. widgetname (no extension)
// tells the panel to download <widgetname>.wgt from the same directory — we serve it at
// /tizen/ScreenTinker.wgt. webtype=tizen marks it a Tizen web app.
// Bytes -> kilobytes for the manifest, rounded UP. Rounding up rather than down on purpose: the
// value tells the panel how much to expect, and under-reporting a partial last KB is what a
// truncated download looks like. A file that exists always advertises at least 1.
function sizeKb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 1024);
}

function ssspConfigXml(wgt = cache) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget>
\t<ver>${wgt.version}</ver>
\t<size>${sizeKb(wgt.size)}</size>
\t<widgetname>ScreenTinker</widgetname>
\t<webtype>tizen</webtype>
</widget>
`;
}

module.exports = { ssspVer, start, refresh, get, ssspConfigXml, sizeKb, WIDGET_NAME: 'ScreenTinker' };
