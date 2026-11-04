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
const zlib = require('zlib');
const config = require('../config');

const FILE = 'ScreenTinker.ipk';
const APP_ID = 'com.screentinker.player';
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

// The version this server is, which is what version.json used to claim for whatever file it found.
// Kept only as the fallback for a file whose control record cannot be read: the version a panel is
// told MUST be the one inside the file it then downloads (see readIpk), or the panel installs
// something older than it runs and fails. Found on prod: a 2.5.1 ScreenTinker.ipk left in the data
// dir won the candidate search and was published as "3.1.2", so every com.screentinker.player panel
// that tried to self-update pulled a 2.5.1 package labelled 3.1.2.
const SERVER_VERSION = process.env.WEBOS_IPK_VER || (() => {
  try { return require('../package.json').version; } catch (_) { return '1.0.0'; }
})();

const EMPTY = { path: null, exists: false, size: 0, mtime: 0, version: SERVER_VERSION };
let cache = EMPTY;
let localCache = EMPTY;

/*
 * Read the control record of an .ipk without unpacking it to disk: the file is an `ar` archive of
 * debian-binary, control.tar.gz and data.tar.gz (the layout ares-package writes and build-ipk.sh
 * matches), and the control file inside the gzipped tar carries `Package:` (the app id) and
 * `Version:`. Returns { id, version } or null for anything that is not an .ipk.
 */
function readIpk(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }
  if (buf.length < 8 || buf.toString('latin1', 0, 8) !== '!<arch>\n') return null;
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.toString('latin1', off, off + 16).trim().replace(/\/$/, '');
    const size = parseInt(buf.toString('latin1', off + 48, off + 58).trim(), 10);
    if (!(size >= 0)) return null;
    const start = off + 60;
    if (name === 'control.tar.gz') {
      let tar;
      try { tar = zlib.gunzipSync(buf.subarray(start, start + size)); } catch (_) { return null; }
      return parseControlTar(tar);
    }
    off = start + size + (size % 2);   // ar pads every member to an even offset
  }
  return null;
}

function parseControlTar(tar) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;                                          // end-of-archive zero block
    const size = parseInt(tar.toString('latin1', off + 124, off + 136).replace(/\0.*$/s, '').trim(), 8) || 0;
    if (name === 'control' || name === './control') {
      const text = tar.toString('utf8', off + 512, off + 512 + size);
      const id = (/^Package:\s*(\S+)/m.exec(text) || [])[1] || '';
      const version = (/^Version:\s*(\S+)/m.exec(text) || [])[1] || '';
      return id && version ? { id, version } : null;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

// Numeric x.y.z compare, the same rule the shell's newer() applies; anything unparseable sorts low.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/*
 * The file to serve for [file]: of every candidate that exists AND is an .ipk of the right app id,
 * the newest by the version inside it, earlier candidates winning a tie (so an operator's copy in
 * the data dir still wins when it is current, and merely loses when it has gone stale). A file with
 * the other build's id (ScreenTinker.ipk copied over com.lg.app.signage.ipk, say) is skipped,
 * because a panel in Local mode refuses it. A file that is not readable as an .ipk is still served
 * when nothing better exists, under the server's version, which is all the old code ever did.
 */
function resolve(file) {
  return resolveAmong(candidates(file), file === LOCAL_FILE ? LOCAL_APP_ID : APP_ID, file);
}

function resolveAmong(paths, wantId, file = wantId) {
  let best = null;
  let fallback = null;
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    const meta = readIpk(p);
    const entry = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: meta ? meta.version : SERVER_VERSION, id: meta ? meta.id : null };
    if (!meta) { if (!fallback) fallback = entry; continue; }
    if (meta.id !== wantId) {
      console.warn(`[webos] ${p} is ${meta.id} ${meta.version}, not ${wantId}; ignored`);
      continue;
    }
    if (!best || compareVersions(meta.version, best.version) > 0) best = entry;
  }
  const chosen = best || fallback || EMPTY;
  if (chosen.exists && best && compareVersions(best.version, SERVER_VERSION) < 0) {
    console.warn(`[webos] serving ${file} ${best.version} from ${best.path}; this server is ${SERVER_VERSION} and has no newer build on disk`);
  }
  return chosen;
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
// `versions` carries each build's own version (read from the file itself), because the two files can
// legitimately differ on an instance; a shell reads its own entry and falls back to the top level.
function versionJson(ipk = cache, local = localCache) {
  const out = {
    version: ipk.version, available: !!ipk.exists, size: ipk.size, url: `/webos/${FILE}`,
    files: { [FILE]: !!ipk.exists, [LOCAL_FILE]: !!(local && local.exists) },
    versions: {},
  };
  if (ipk.exists) out.versions[FILE] = ipk.version;
  if (local && local.exists) out.versions[LOCAL_FILE] = local.version;
  return out;
}

module.exports = {
  start, refresh, get, getLocal, versionJson, readIpk, compareVersions, resolveAmong,
  APP_ID, FILE, LOCAL_APP_ID, LOCAL_FILE,
};
