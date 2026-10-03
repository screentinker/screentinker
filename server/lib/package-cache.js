'use strict';

/*
 * Resolve a native player's self-update package — the Raspberry Pi .deb (lib/deb-cache.js) and the
 * Windows installer (lib/win-cache.js) — for its /api/<x>/update/check and /download/<x> routes.
 *
 * One factory, two instances, because the two packages differ only in their filename and where an
 * operator may point the in-repo fallback. Everything below is the same rule for both:
 *
 * The same shape as lib/apk-cache.js and lib/ipk-cache.js: what is on disk is resolved once at boot
 * and refreshed on an interval, never with a per-request statSync — an update check is the one
 * endpoint a whole fleet hits on the same schedule.
 *
 * Two differences from those two, both forced by what these packages are:
 *
 *   1. THE VERSION COMES FROM THE FILENAME. The Pi build (native/packaging/linux, dpkg-deb) emits
 *      exactly `screentinker-pi_<ver>_all.deb`; the Windows build (Inno Setup) emits
 *      `ScreenTinker-Setup-<ver>.exe`. So the file describes itself. There is no single well-known
 *      name to stat: a directory can hold several builds (the previous release left beside the new
 *      one), and the NEWEST by version wins — not the newest mtime, because a `cp -p` or a restore
 *      from backup scrambles mtimes and would silently serve a downgrade that the version comparison
 *      then refuses to install.
 *
 *   2. THE SHA-256 IS PART OF THE OFFER. Neither dpkg nor an .exe fetched over HTTP is verified by
 *      anything else, so the player (Pi) / the privileged helper service (Windows) checks the hash we
 *      advertise before installing. It is computed ONCE per (path, size, mtime) and cached — never per
 *      request — and computed with a stream so a 30-100 MB package cannot stall the event loop at boot
 *      (see the loop-spike notes).
 *      ⚠️ Until the hash exists the check endpoint must NOT offer the update: an offer without a
 *      checksum is an offer the device will download and then reject, which is exactly the
 *      "download loop" the OTA breaker exists to stop. `ready()` is the promise tests await.
 *
 * Search order, first directory holding ANY matching file wins (an operator mount always beats a
 * build that happens to be in the checkout):
 *   DATA_DIR/                    operator mount — wins
 *   <repo>/native/dist/          in-repo build output (the env override — PI_DIST_DIR / WIN_DIST_DIR —
 *                                replaces it; tests point it at an empty dir so a developer's local
 *                                build cannot change their result)
 *
 * The version part of each filename regex accepts Debian's `~` prerelease marker (1.2.0~beta1 sorts
 * BELOW 1.2.0 in dpkg, exactly as semver's `-beta1` does) and normalises it to `-` so ota-breaker's
 * comparator — the one every other OTA path uses — can order it. A Debian revision (`1.2.0-1`) parses
 * as a prerelease under semver, which would sort it BELOW 1.2.0; neither build emits revisions, and
 * this is called out in docs/pi-native-player.md rather than half-supported here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { cmp } = require('./ota-breaker');

function normaliseVersion(v) { return String(v).replace(/~/g, '-'); }

const REPO_DIST = path.join(__dirname, '..', '..', 'native', 'dist');

/**
 * @param {object} opts
 * @param {string} opts.name          for logs only ('pi', 'win')
 * @param {RegExp} opts.filenameRe    group 1 = the version
 * @param {string} opts.envDirVar     env var that replaces the in-repo fallback directory
 * @param {string} [opts.repoDir]     the in-repo fallback (default <repo>/native/dist)
 */
function createPackageCache({ name, filenameRe, envDirVar, repoDir = REPO_DIST }) {
  if (!(filenameRe instanceof RegExp)) throw new TypeError('createPackageCache: filenameRe must be a RegExp');

  // Read at every refresh, not captured at creation: tests set the env after require().
  function candidateDirs() {
    return [config.dataDir, process.env[envDirVar] || repoDir];
  }

  const EMPTY = Object.freeze({ path: null, exists: false, size: 0, mtime: 0, version: null, sha256: null, filename: null });
  let cache = EMPTY;
  // sha256 by "<path>|<size>|<mtime>" — a changed file is a new key, so a replaced package can never
  // be advertised under the old file's hash.
  const hashes = new Map();
  let pending = Promise.resolve();

  /**
   * Pick the newest well-formed package in one directory. Pure over a listing so it is testable
   * without a filesystem; unparseable names are ignored rather than sorted.
   *
   * ⚠️ A RELEASE BEATS ANY PRERELEASE, whatever the versions say. Semver ranks 1.3.0-beta1 above
   * 1.2.0, so a test build dropped beside the release would otherwise be offered to the WHOLE fleet
   * on its next check — neither native player has a beta channel to confine it to (see
   * routes/native-update.js). A prerelease is served only from a directory that holds no release at
   * all, which is the one case where an operator can only have meant it.
   */
  function pickNewest(names) {
    let best = null, bestPre = null;
    for (const n of names || []) {
      const m = filenameRe.exec(n);
      if (!m) continue;
      const version = normaliseVersion(m[1]);
      const isPre = version.includes('-');
      if (isPre) { if (!bestPre || (cmp(version, bestPre.version) || 0) > 0) bestPre = { name: n, version }; }
      else if (!best || (cmp(version, best.version) || 0) > 0) best = { name: n, version };
    }
    return best || bestPre;
  }

  function hashFile(p) {
    return new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('data', (c) => h.update(c));
      s.on('error', () => resolve(null));
      s.on('end', () => resolve(h.digest('hex')));
    });
  }

  function refresh() {
    let found = null;
    for (const dir of candidateDirs()) {
      let names;
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      const best = pickNewest(names);
      if (!best) continue;
      const p = path.join(dir, best.name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        found = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: best.version, filename: best.name };
        break;
      } catch (_) { /* raced with a delete — next directory */ }
    }
    if (!found) { cache = EMPTY; return cache; }

    const key = `${found.path}|${found.size}|${found.mtime}`;
    if (hashes.has(key)) {
      cache = Object.assign({}, found, { sha256: hashes.get(key) });
      return cache;
    }
    // Publish WITHOUT a hash first: exists-but-unhashed is a real state and the check endpoint knows
    // to hold its offer until the hash lands.
    cache = Object.assign({}, found, { sha256: null });
    pending = hashFile(found.path).then((sha) => {
      if (!sha) return;
      // Bounded: only ever the current file matters. Old keys are dropped, not accumulated.
      hashes.clear();
      hashes.set(key, sha);
      if (cache.path === found.path && cache.size === found.size && cache.mtime === found.mtime) {
        cache = Object.assign({}, cache, { sha256: sha });
      }
    });
    return cache;
  }

  function get() { return cache; }
  function ready() { return pending.then(() => cache); }

  let timer = null;
  function start() {
    refresh();
    if (!timer) {
      timer = setInterval(refresh, config.otaApkRefreshMs);
      if (timer.unref) timer.unref();
    }
    return cache;
  }

  return { name, start, refresh, get, ready, pickNewest, normaliseVersion, candidateDirs, FILENAME_RE: filenameRe };
}

module.exports = { createPackageCache, normaliseVersion, REPO_DIST };
