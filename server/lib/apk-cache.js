'use strict';
// #146 hardening (Item C) — cache the OTA APK resolution so no /api/update/check or
// /download/apk does a per-request synchronous filesystem call. The path/size/mtime are
// resolved once at boot and refreshed on an interval (like the frontend-hash refresh),
// so a poll/download flood can't turn into an existsSync/statSync flood on the loop.
//
// Two channels. The STABLE slot is the APK every display gets. The BETA slot is optional and
// only reaches displays with devices.ota_beta = 1.
//
// EVERY slot advertises the version of the bytes it holds, read out of the APK itself
// (lib/apk-version.js). This used to say the server "cannot infer it" and that reading the APK
// would mean parsing binary AndroidManifest.xml "on the request path". The first half was wrong
// and the second was avoidable: the parse is 0-2 ms and happens here, on a timer, only when the
// file changes. #341 is what that assumption cost.
//
// A sidecar `<apk>.version` file beside the APK still works and is the fallback when the APK
// cannot be read (an unusual container, or a versionName given as a @string resource rather than
// a literal). It is explicit and greppable, but it can drift from the bytes; the APK cannot.
//
// The beta channel still does NOT activate without a version from one source or the other, and
// opted-in displays keep getting stable. Failing closed matters here: advertising a version that
// does not match the bytes actually served is precisely the OTA-loop condition this fleet has
// been bitten by before.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { readApkVersionName } = require('./apk-version');

// Parsing an APK is cheap (0-2 ms) but pointless to repeat while the file has not changed, and
// refresh() runs on a timer. Keyed by path, invalidated on mtime/size. Two entries, ever.
const parsed = new Map();
function apkVersionOf(slot) {
  if (!slot.exists) return null;
  const hit = parsed.get(slot.path);
  if (hit && hit.mtime === slot.mtime && hit.size === slot.size) return hit.version;
  const version = readApkVersionName(slot.path);
  parsed.set(slot.path, { mtime: slot.mtime, size: slot.size, version });
  if (version) console.log(`[ota] ${path.basename(slot.path)} declares versionName ${version}`);
  return version;
}

// A copy under DATA_DIR wins (container operators mount /data/ScreenTinker.apk),
// else the legacy in-repo root path — same order as the old resolveApkPath().
function candidates(name) {
  return [path.join(config.dataDir, name), path.join(__dirname, '..', '..', name)];
}

const EMPTY = { path: null, exists: false, size: 0, mtime: 0, version: null };

let stable = { ...EMPTY };
let beta = { ...EMPTY };

function statFirst(name) {
  for (const p of candidates(name)) {
    try {
      const st = fs.statSync(p);
      return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: null };
    } catch (_) { /* next */ }
  }
  return { ...EMPTY };
}

// Version declared alongside the APK. First non-empty line, trimmed; anything that is not a
// plausible semver is treated as absent rather than trusted.
function readDeclaredVersion(apkPath) {
  if (!apkPath) return null;
  try {
    const raw = fs.readFileSync(apkPath + '.version', 'utf8');
    const v = String(raw).split('\n')[0].trim();
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  } catch (_) { return null; }
}

function refresh() {
  stable = statFirst('ScreenTinker.apk');
  /*
   * #341: THE STABLE SLOT DECLARES ITS VERSION TOO, when it can.
   *
   * The header above assumed "server and APK ship together", so latest_version on stable was the
   * server's own VERSION. That assumption breaks the moment an operator mounts their own APK at
   * /data/ScreenTinker.apk, and it breaks silently and expensively: a server on 2.0.7 serving a
   * 2.0.0 APK offers 2.0.7 to a 2.0.0 device, Android accepts the download as a same-version
   * reinstall, the device returns on 2.0.0, and is offered again. Reported in the field as two
   * displays looping for five days and 493 downloads with nothing failing anywhere.
   *
   * Read from the APK, so a hand-mounted build needs no operator action at all. Unlike beta this
   * does NOT fail closed: if the version cannot be determined the caller falls back to the server
   * VERSION exactly as before, which is correct whenever server and APK really did ship together.
   */
  stable.version = stable.exists ? (apkVersionOf(stable) || readDeclaredVersion(stable.path)) : null;
  const b = statFirst('ScreenTinker-beta.apk');
  b.version = b.exists ? (apkVersionOf(b) || readDeclaredVersion(b.path)) : null;
  beta = b.exists && b.version ? b : { ...EMPTY };   // no declared version -> no beta channel
  return stable;
}

function get() { return stable; }
function getBeta() { return beta; }

/** The slot to serve for a channel, falling back to stable whenever beta is not usable. */
function forChannel(channel) {
  return channel === 'beta' && beta.exists ? beta : stable;
}

/** Whether a usable beta build is published right now. */
function betaAvailable() { return beta.exists && !!beta.version; }

let timer = null;
function start() {
  refresh();                                   // resolve once at boot
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);
    if (timer.unref) timer.unref();
  }
  return stable;
}

module.exports = { start, refresh, get, getBeta, forChannel, betaAvailable };
