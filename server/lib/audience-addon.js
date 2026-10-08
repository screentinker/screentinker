'use strict';

/*
 * The optional audience-counting add-on for the native players (docs/audience-counting.md): OpenCV,
 * numpy and the YuNet face model, built per platform by native/packaging/audience/build-addon.py as
 *
 *   screentinker-audience_<version>_<platform>.zip
 *
 * It is NOT part of the player package and is never pushed to a screen. An operator asks for it at
 * install time (the Windows installer's "Audience counting" checkbox, `raspberry-pi-setup.sh
 * --audience`, `screentinker-pi audience-addon install`) — off by default, because it adds about
 * 50 MB to download (150-230 MB on disk) that a screen which never counts does not need.
 *
 * One lib/package-cache.js instance per platform, so the rules are the ones the player packages
 * already follow: newest by VERSION, a release beats a prerelease, the sha256 hashed once per
 * (path, size, mtime) and never offered before it exists. Search order DATA_DIR, then
 * <repo>/native/dist (AUDIENCE_ADDON_DIST_DIR overrides the latter; tests point it at an empty dir).
 *
 * ⚠️ THE PLATFORM NAMES THE PYTHON. The add-on holds compiled extension modules (numpy), which load
 * only into the Python minor version they were built for — the Windows player bundles CPython 3.12
 * (packaging/windows/build.ps1), Pi OS Trixie ships 3.13. A player that moves to another Python asks
 * for another platform name, and an old add-on is never loaded into a Python it was not built for
 * (the player also checks ADDON.json before importing).
 */

const { createPackageCache } = require('./package-cache');

const PLATFORMS = Object.freeze(['win-x64-cp312', 'linux-aarch64-cp313', 'linux-x86_64-cp313']);

const caches = new Map();
for (const p of PLATFORMS) {
  const re = new RegExp(`^screentinker-audience_(\\d+\\.\\d+\\.\\d+(?:[~-][0-9A-Za-z.~-]+)?)_${p.replace(/[.-]/g, '\\$&')}\\.zip$`);
  caches.set(p, createPackageCache({ name: `audience-${p}`, filenameRe: re, envDirVar: 'AUDIENCE_ADDON_DIST_DIR' }));
}

function forPlatform(p) { return caches.get(String(p || '')) || null; }

function start() { for (const c of caches.values()) c.start(); }
function refresh() { for (const c of caches.values()) c.refresh(); }
function ready() { return Promise.all([...caches.values()].map((c) => c.ready())); }

module.exports = { PLATFORMS, forPlatform, start, refresh, ready };
