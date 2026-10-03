'use strict';

/*
 * REST / JSON API data source (built in; supersedes needing the json-api plugin).
 *
 * config:
 *   url, method ('GET' | 'POST'), body (POST, JSON text, ≤16 KB)
 *   auth_type: 'none' | 'bearer' | 'header' | 'basic'
 *     auth_token        bearer token, or the header value for 'header'   (secret)
 *     auth_header       header name for 'header' (e.g. X-API-Key)
 *     auth_username / auth_password  for 'basic'                           (password is secret)
 *   response_format: 'auto' | 'json' | 'csv'
 *   json_path: where the data lives in the response — data.items, results[0], feed.entry
 *   shape: 'auto' | 'object' | 'table'   (a list of records becomes a table, see tabular.js)
 *   key_column: lookup mode for table shapes
 *   interval_min
 *
 * Secrets never leave the server: the route redacts them on read, encrypts them at rest, and only
 * back-fills a stored secret into a test that targets the SAME origin it was saved for.
 */

const { fetchText, checkHttpUrl, UserFacingError } = require('./http');
const tab = require('./tabular');

const METHODS = new Set(['GET', 'POST']);
const AUTH = new Set(['none', 'bearer', 'header', 'basic']);
const FORMATS = new Set(['auto', 'json', 'csv']);
const SHAPES = new Set(['auto', 'object', 'table']);
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
// Headers an operator must not set: they would let a data source smuggle cookies, spoof hosts or
// break the connection handling the SSRF guard relies on.
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization', 'te', 'upgrade']);
const PATH_RE = /^[A-Za-z0-9_$\-\s.[\]'"*]{0,200}$/;

const SECRET_FIELDS = ['auth_token', 'auth_password'];

function validateRestConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  const bad = checkHttpUrl(c.url, 'The API URL');
  if (bad) return bad;
  const method = String(c.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return 'Method must be GET or POST';
  if (c.body != null && c.body !== '') {
    if (method !== 'POST') return 'A request body is only sent with POST';
    if (String(c.body).length > 16 * 1024) return 'The request body is limited to 16 KB';
    try { JSON.parse(String(c.body)); } catch { return 'The request body must be valid JSON'; }
  }
  const auth = c.auth_type || 'none';
  if (!AUTH.has(auth)) return 'Unknown authentication type';
  if (auth === 'header') {
    if (!HEADER_RE.test(String(c.auth_header || ''))) return 'Enter the header name, e.g. X-API-Key';
    if (FORBIDDEN_HEADERS.has(String(c.auth_header).toLowerCase())) return `The ${c.auth_header} header cannot be set by a data source`;
  }
  if (auth === 'basic' && !String(c.auth_username || '').trim()) return 'Enter the username for basic authentication';
  if (c.response_format && !FORMATS.has(c.response_format)) return 'Unknown response format';
  if (c.shape && !SHAPES.has(c.shape)) return 'Unknown data shape';
  if (c.json_path && !PATH_RE.test(String(c.json_path))) return 'The data path may contain letters, digits, dots and [index] only';
  if (c.key_column && String(c.key_column).length > 80) return 'The key column name is too long';
  return null;
}

/*
 * A data path: dots and brackets — data.items, results[0].rows, feed['entry'], items[*].
 * `*` on an array keeps the array (it reads naturally: "every item"). Never evaluates anything.
 */
function selectPath(value, path) {
  const p = String(path || '').trim();
  if (!p || p === '$' || p === '.') return value;
  const tokens = [];
  const re = /\[\s*(?:(\d+)|\*|'([^']*)'|"([^"]*)")\s*\]|([^.[\]]+)/g;
  let m;
  const src = p.replace(/^\$\.?/, '');
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) tokens.push(Number(m[1]));
    else if (m[2] !== undefined || m[3] !== undefined) tokens.push(m[2] !== undefined ? m[2] : m[3]);
    else if (m[4] !== undefined) { const t = m[4].trim(); if (t && t !== '*') tokens.push(t); }
  }
  let cur = value;
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (typeof t === 'number') cur = Array.isArray(cur) ? cur[t] : undefined;
    else cur = Object.prototype.hasOwnProperty.call(cur, t) ? cur[t] : undefined;
  }
  return cur;
}

/* An object → flat keys (a_b_c), arrays as _count and _1.._n (1-based, like table rows). */
function flattenObject(value, prefix, out, depth) {
  if (Object.keys(out).length >= tab.MAX_KEYS || depth > 8) return out;
  const key = (k) => (prefix ? `${prefix}_${k}` : String(k));
  if (value === null || value === undefined) { if (prefix) out[prefix] = ''; return out; }
  if (typeof value !== 'object') { out[prefix || 'value'] = typeof value === 'string' ? value.slice(0, tab.MAX_CELL) : value; return out; }
  if (Array.isArray(value)) {
    out[key('count')] = value.length;
    value.slice(0, 50).forEach((v, i) => flattenObject(v, key(i + 1), out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value)) flattenObject(v, key(tab.slugKey(k, 'field')), out, depth + 1);
  return out;
}

function buildRequest(c) {
  const method = String(c.method || 'GET').toUpperCase();
  const headers = { Accept: c.response_format === 'csv' ? 'text/csv, text/plain;q=0.9, */*;q=0.5' : 'application/json, text/csv;q=0.8, */*;q=0.5' };
  switch (c.auth_type) {
    case 'bearer': if (c.auth_token) headers.Authorization = `Bearer ${String(c.auth_token).trim()}`; break;
    case 'header': if (c.auth_header && c.auth_token) headers[String(c.auth_header)] = String(c.auth_token); break;
    case 'basic': headers.Authorization = 'Basic ' + Buffer.from(`${c.auth_username || ''}:${c.auth_password || ''}`).toString('base64'); break;
    default: break;
  }
  let body;
  if (method === 'POST' && c.body) { body = String(c.body); headers['Content-Type'] = 'application/json'; }
  return { method, headers, body };
}

/**
 * Resolve: { data (flat variables), table? ({ columns, sample }), raw? (a trimmed copy of the
 * selected JSON, for the dashboard's "what did it return" view) }.
 */
async function resolveRest(config, ctx = {}) {
  const c = config || {};
  const err = validateRestConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  const req = buildRequest(c);
  // The SSRF guard strips Authorization and Cookie on a cross-origin redirect, but it cannot know
  // that "X-API-Key" is a credential too — so a request carrying a custom auth header does not
  // follow redirects at all.
  const maxRedirects = c.auth_type === 'header' ? 0 : 5;
  const { text, contentType } = await fetchText(String(c.url).trim(), { ...req, maxRedirects, fetcher: ctx.fetcher });
  const now = ctx.now || new Date();

  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(text);
  const format = c.response_format && c.response_format !== 'auto' ? c.response_format : (looksJson ? 'json' : 'csv');

  if (format === 'csv') {
    const { rows, delimiter } = tab.parseCsv(text);
    const table = tab.rowsToTable(rows, { headerRow: c.header_row !== false });
    if (!table.columns.length) throw new UserFacingError('The response was empty or not CSV.', 'parse');
    const data = tab.flattenTable(table, { keyColumn: c.key_column, decimalComma: delimiter === ';', now });
    return { data, table: { columns: table.columns, sample: table.records.slice(0, 5) } };
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new UserFacingError('The response was not valid JSON. If it is CSV, set the response format to CSV.', 'parse'); }
  const picked = selectPath(parsed, c.json_path);
  if (picked === undefined) throw new UserFacingError(`Nothing found at "${String(c.json_path)}" in the response.`, 'parse');

  const shape = c.shape || 'auto';
  const isList = Array.isArray(picked);
  if (shape === 'table' || (shape === 'auto' && isList)) {
    const list = isList ? picked : [picked];
    const table = tab.recordsToTable(list);
    const data = tab.flattenTable(table, { keyColumn: c.key_column, now });
    return { data, table: { columns: table.columns, sample: table.records.slice(0, 5) }, raw: trimForPreview(picked) };
  }
  const data = flattenObject(picked, '', {}, 0);
  data.updated = now.toISOString();
  return { data, raw: trimForPreview(picked) };
}

/* A small copy of the JSON for the preview: first items of arrays, bounded depth and string size. */
function trimForPreview(v, depth = 0) {
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => trimForPreview(x, depth + 1)).concat(v.length > 3 ? [`… ${v.length - 3} more`] : []);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) out[k] = trimForPreview(x, depth + 1);
    return out;
  }
  return typeof v === 'string' ? v.slice(0, 200) : v;
}

module.exports = { SECRET_FIELDS, validateRestConfig, selectPath, flattenObject, buildRequest, resolveRest, trimForPreview };
