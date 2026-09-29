'use strict';

/*
 * The native Raspberry Pi player's .deb (screentinker-pi_<ver>_all.deb) for /api/pi/update/check and
 * /download/pi. A thin instance of lib/package-cache.js — read that header for the rules (newest by
 * VERSION not mtime, a release beats any prerelease, sha256 hashed once per (path, size, mtime) and
 * never offered before it exists). Kept as its own module because server.js, routes/native-update.js
 * and test/pi-update.test.js all require it by this name.
 *
 * Search order: DATA_DIR, then <repo>/native/dist (PI_DIST_DIR overrides the latter).
 */

const { createPackageCache } = require('./package-cache');

const DEB_RE = /^screentinker-pi_(\d+\.\d+\.\d+(?:[~-][0-9A-Za-z.~-]+)?)_all\.deb$/;

const cache = createPackageCache({ name: 'pi', filenameRe: DEB_RE, envDirVar: 'PI_DIST_DIR' });

module.exports = Object.assign(cache, { DEB_RE });
