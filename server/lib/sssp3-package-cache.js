'use strict';

// Resolves the SSSP3/Orsay native ZIP used by URL Launcher. Unlike Tizen's
// package, the SSSP3 manifest has to match the package's own integer <ver>.
// A ZIP cannot safely be introspected with Node built-ins, so an externally
// mounted archive must declare that integer explicitly. The in-tree build has
// release.json alongside its source and can therefore be served in development.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const WIDGET_NAME = 'ScreenTinkerSSSP3';
const sourceRoot = path.join(__dirname, '..', '..', 'samsung-sssp3');
const devZip = path.join(sourceRoot, 'dist', WIDGET_NAME + '.zip');

function positiveInteger(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function packageCandidates() {
  return [
    path.join(config.dataDir, WIDGET_NAME + '.zip'),
    path.join(__dirname, '..', '..', WIDGET_NAME + '.zip'),
    devZip,
  ];
}

function devVersion() {
  try { return positiveInteger(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'release.json'), 'utf8')).version); } catch (_) { return null; }
}

function packageVersion(candidate) {
  const override = positiveInteger(process.env.SSSP3_WGT_VER);
  if (override) return override;
  return candidate === devZip ? devVersion() : null;
}

let cache = { path: null, exists: false, size: 0, mtime: 0, version: null, reason: 'missing' };
function refresh() {
  for (const candidate of packageCandidates()) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size <= 0) continue;
      const version = packageVersion(candidate);
      if (!version) {
        cache = { path: candidate, exists: false, size: stat.size, mtime: stat.mtimeMs, version: null, reason: 'version-required' };
        return cache;
      }
      cache = { path: candidate, exists: true, size: stat.size, mtime: stat.mtimeMs, version, reason: null };
      return cache;
    } catch (_) { /* try next candidate */ }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0, version: null, reason: 'missing' };
  return cache;
}
function get() { return cache; }
let timer = null;
function start() {
  refresh();
  if (!timer) { timer = setInterval(refresh, config.otaApkRefreshMs); if (timer.unref) timer.unref(); }
  return cache;
}
function sssp3ConfigXml(pkg = cache) {
  if (!pkg.exists) throw new Error('SSSP3 package is not ready');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<widget><ver>' + pkg.version + '</ver><size>' + pkg.size + '</size><widgetname>' + WIDGET_NAME + '</widgetname></widget>\n';
}
module.exports = { WIDGET_NAME, positiveInteger, packageCandidates, packageVersion, devVersion, refresh, get, start, sssp3ConfigXml };
