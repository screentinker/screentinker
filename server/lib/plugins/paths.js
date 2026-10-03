'use strict';

const fs = require('fs');
const path = require('path');

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function pluginRoots(cfg) {
  const bundled = cfg.bundledPluginsDir;
  const data = cfg.dataPluginsDir;
  const roots = [];
  if (bundled) roots.push({ origin: 'bundled', dir: bundled });
  if (data && data !== bundled) roots.push({ origin: 'data', dir: data });
  return roots;
}

module.exports = { isInside, realpathOrNull, pluginRoots };
