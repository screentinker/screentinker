'use strict';

// Resolve the LG webOS Signage .ipk for the /webos install and self-update flow. The same shape
// as lib/wgt-cache.js (Tizen) and lib/apk-cache.js (Android): path/size/mtime resolved once at
// boot and refreshed on an interval, never a per-request statSync.
//
// Unlike the Tizen .wgt, an .ipk needs no vendor signature to install from USB or an SI server,
// so the CI-built artifact at the repo root is normally the one served. An operator can still
// mount their own at /data/ScreenTinker.ipk (say, one built with LG's ares-package and the SCAP
// library included), and that wins.
//
// Two builds of the same app are published. ScreenTinker.ipk (id com.screentinker.player) is the
// one installed from a USB stick through the panel's own menu or an SI server. com.lg.app.signage.ipk
// is the same app under the id LG's Local application launch mode requires; a panel in that mode
// installs only a file of that name from the stick's application/ folder. They are separate apps
// to the panel, so each updates itself from its own file and neither is served in place of the other.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = 'ScreenTinker.ipk';
const LOCAL_APP_ID = 'com.lg.app.signage';
const LOCAL_FILE = `${LOCAL_APP_ID}.ipk`;

// Spelled out per file rather than joined from a variable: test/dockerfile-runtime-files.test.js
// reads these joins to tell a build output (skipped) from a repo path the image must carry.
function candidates(file = FILE) {
  if (file === LOCAL_FILE) {
    return [
      path.join(config.dataDir, 'com.lg.app.signage.ipk'),
      path.join(__dirname, '..', '..', 'com.lg.app.signage.ipk'),
      path.join(__dirname, '..', '..', 'webos', 'com.lg.app.signage.ipk'),
    ];
  }
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

const EMPTY = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };
let cache = EMPTY;
let localCache = EMPTY;

function resolve(file) {
  for (const p of candidates(file)) {
    try {
      const st = fs.statSync(p);
      return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: VERSION };
    } catch (_) { /* next candidate */ }
  }
  return EMPTY;
}

function refresh() {
  cache = resolve(FILE);
  localCache = resolve(LOCAL_FILE);
  return cache;
}

function get() { return cache; }
/** The Local application mode build, com.lg.app.signage.ipk. */
function getLocal() { return localCache; }

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
// must not send a panel off to download nothing. The top-level fields describe ScreenTinker.ipk,
// which is all a shell from before the Local build reads; `files` says which builds are published,
// so a com.lg.app.signage build is not sent after a file this instance does not have.
function versionJson(ipk = cache, local = localCache) {
  return {
    version: ipk.version, available: !!ipk.exists, size: ipk.size, url: `/webos/${FILE}`,
    files: { [FILE]: !!ipk.exists, [LOCAL_FILE]: !!(local && local.exists) },
  };
}

module.exports = {
  start, refresh, get, getLocal, versionJson,
  APP_ID: 'com.screentinker.player', FILE, LOCAL_APP_ID, LOCAL_FILE,
};
