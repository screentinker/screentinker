'use strict';

const fs = require('fs');
const path = require('path');
const { getPlugin } = require('./registry');
const { isInside, realpathOrNull } = require('./paths');

/*
 * Serves plugins/<id>/public/* at /plugins/<id>/*. Only for enabled, loaded plugins.
 * Path-normalized; no directory listing; no-cache for JS.
 */
function pluginStatic(req, res) {
  const id = String(req.params.id || '');
  const plugin = getPlugin(id);
  if (!plugin || !plugin.enabled || !plugin.loaded || !plugin.dir) {
    return res.status(404).type('text/plain').send('Not found');
  }
  let rel;
  try {
    rel = decodeURIComponent(String(req.path || '/')).replace(/^\/+/, '');
  } catch {
    return res.status(404).type('text/plain').send('Not found');
  }
  if (!rel || rel.endsWith('/')) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const publicRoot = path.join(plugin.dir, 'public');
  const candidate = path.resolve(publicRoot, rel);
  const real = realpathOrNull(candidate);
  const rootReal = realpathOrNull(publicRoot);
  if (!real || !rootReal || !isInside(rootReal, real)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  let st;
  try { st = fs.statSync(real); } catch { return res.status(404).type('text/plain').send('Not found'); }
  if (!st.isFile()) return res.status(404).type('text/plain').send('Not found');
  if (real.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
  else res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(real);
}

module.exports = pluginStatic;
