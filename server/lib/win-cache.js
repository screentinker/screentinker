'use strict';

/*
 * The native Windows player's installer (ScreenTinker-Setup-<ver>.exe, Inno Setup) for
 * /api/win/update/check and /download/win. A thin instance of lib/package-cache.js — read that
 * header for the rules (newest by VERSION not mtime, a release beats any prerelease, sha256 hashed
 * once per (path, size, mtime) and never offered before it exists).
 *
 * The version may carry the same `~rcN` prerelease marker as the .deb (normalised to `-rcN` for the
 * comparison), so one build script can name both packages the same way.
 *
 * Search order: DATA_DIR, then <repo>/native/dist (WIN_DIST_DIR overrides the latter).
 */

const { createPackageCache } = require('./package-cache');

const EXE_RE = /^ScreenTinker-Setup-(\d+\.\d+\.\d+(?:[~-][0-9A-Za-z.~-]+)?)\.exe$/;

const cache = createPackageCache({ name: 'win', filenameRe: EXE_RE, envDirVar: 'WIN_DIST_DIR' });

module.exports = Object.assign(cache, { EXE_RE });
