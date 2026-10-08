'use strict';

/*
 * The native macOS player's disk image (ScreenTinker-<ver>.dmg, native/packaging/macos/build.sh) for
 * /download/mac. A thin instance of lib/package-cache.js — read that header for the rules (newest by
 * VERSION not mtime, a release beats any prerelease, sha256 hashed once per (path, size, mtime)).
 *
 * Download only: a Mac never updates itself (docs/macos-player.md), so there is no update check.
 *
 * Search order: DATA_DIR, then <repo>/native/dist (MAC_DIST_DIR overrides the latter).
 */

const { createPackageCache } = require('./package-cache');

const DMG_RE = /^ScreenTinker-(\d+\.\d+\.\d+(?:[~-][0-9A-Za-z.~-]+)?)\.dmg$/;

const cache = createPackageCache({ name: 'mac', filenameRe: DMG_RE, envDirVar: 'MAC_DIST_DIR' });

module.exports = Object.assign(cache, { DMG_RE });
