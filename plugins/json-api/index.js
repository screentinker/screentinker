'use strict';

/*
 * JSON API data-source plugin. Fetches through ctx.fetch (the SSRF-guarded
 * request — plugins do not get raw http.get). Flattens the JSON so slide/widget
 * fields can bind {{ds:slug.temperature}} without a JSONPath library.
 */

function pickPath(value, path) {
  if (!path || typeof path !== 'string') return value;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cur = value;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
  }
  return cur;
}

function flatten(value, prefix, out, depth) {
  const dest = out || {};
  if (depth > 8) return dest;
  if (value === null || value === undefined) {
    if (prefix) dest[prefix] = '';
    return dest;
  }
  if (typeof value !== 'object') {
    dest[prefix || 'value'] = value;
    return dest;
  }
  if (Array.isArray(value)) {
    dest[(prefix ? prefix + '_' : '') + 'count'] = value.length;
    const n = Math.min(value.length, 20);
    for (let i = 0; i < n; i++) {
      flatten(value[i], (prefix ? prefix + '_' : '') + i, dest, depth + 1);
    }
    return dest;
  }
  for (const [k, v] of Object.entries(value)) {
    const key = (prefix ? prefix + '_' : '') + String(k).replace(/[^a-zA-Z0-9_]/g, '_');
    flatten(v, key, dest, depth + 1);
  }
  return dest;
}

async function resolve(config, ctx) {
  const c = config || {};
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  if (!url) throw new Error('url is required');
  const headers = {};
  if (c.authorization) headers.Authorization = String(c.authorization);
  const fetch = ctx && typeof ctx.fetch === 'function' ? ctx.fetch : null;
  if (!fetch) throw new Error('json-api plugin requires ctx.fetch');
  const res = await fetch(url, {
    responseType: 'text',
    timeoutMs: 10000,
    maxBytes: 512 * 1024,
    headers,
  });
  if (res.notModified) return null;
  const text = res.text || (res.buffer && res.buffer.toString('utf8')) || '';
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error('response was not JSON'); }
  const picked = pickPath(parsed, c.json_path);
  if (picked === undefined) throw new Error('json_path matched nothing');
  return flatten(picked, '', {}, 0);
}

function activate(api) {
  api.registerDataSource({ type: 'json-api', resolve });
}

module.exports = { activate, resolve, flatten, pickPath };
