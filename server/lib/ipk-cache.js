'use strict';

// Resolve the LG webOS Signage .ipk for the /webos install and self-update flow. The same shape
// as lib/wgt-cache.js (Tizen) and lib/apk-cache.js (Android): path/size/mtime resolved once at
// boot and refreshed on an interval, never a per-request statSync.
//
// Unlike the Tizen .wgt, an .ipk needs no vendor signature to install from USB or an SI server,
// so the CI-built artifact at the repo root is normally the one served. An operator can still
// mount their own at /data/ScreenTinker.ipk (say, one built with LG's ares-package and the SCAP
// library included), and that wins.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function candidates() {
  return [
    path.join(config.dataDir, 'ScreenTinker.ipk'),          // operator mount — wins
    path.join(__dirname, '..', '..', 'ScreenTinker.ipk'),   // repo root (release artifact)
    path.join(__dirname, '..', '..', 'webos', 'ScreenTinker.ipk'), // in-repo build
  ];
}

// Version the app compares itself against at /webos/version.json. Single source: package.json,
// overridable when an operator hosts a differently-versioned build.
const VERSION = process.env.WEBOS_IPK_VER || (() => {
  try { return require('../package.json').version; } catch (_) { return '1.0.0'; }
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
    timer = setInterval(refresh, config.otaApkRefreshMs);
    if (timer.unref) timer.unref();
  }
  return cache;
}

// What the shell polls. `available` is the load-bearing field: a version with no file behind it
// must not send a panel off to download nothing.
function versionJson(ipk = cache) {
  return { version: ipk.version, available: !!ipk.exists, size: ipk.size, url: '/webos/ScreenTinker.ipk' };
}

module.exports = { start, refresh, get, versionJson, APP_ID: 'com.screentinker.player' };
