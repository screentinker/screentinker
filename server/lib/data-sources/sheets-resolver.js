'use strict';

/*
 * Google Sheets data source.
 *
 * No Google account, OAuth app or API key: the operator pastes the sheet's link and we read the
 * CSV Google already serves for it. Two ways a sheet can be readable without credentials, and the
 * link says which one the operator used:
 *
 *   SHARED    docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>
 *             "Share → General access → Anyone with the link → Viewer".
 *             Read via /d/<id>/export?format=csv&gid=<gid>, or — when a tab NAME or a RANGE is
 *             given — the visualization endpoint /d/<id>/gviz/tq?tqx=out:csv&sheet=…&range=….
 *   PUBLISHED docs.google.com/spreadsheets/d/e/<pubid>/pubhtml
 *             "File → Share → Publish to web". Read via /d/e/<pubid>/pub?output=csv&gid=<gid>.
 *
 * ⚠️ A sheet that is NOT shared does not fail with 401/403. Google answers 200 with its HTML
 * sign-in page (after a redirect to accounts.google.com). Parsed as CSV that is one garbage
 * column of markup, and it would be cached as "the data". So an HTML answer is always an error,
 * and the message tells the operator exactly which menu to use.
 *
 * config: url, sheet (tab name, optional), range (A1:D20, optional), header_row (default true),
 *         key_column (lookup mode — see tabular.js), max_rows, interval_min
 */

const { fetchText, UserFacingError } = require('./http');
const tab = require('./tabular');

const ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const RANGE_RE = /^[A-Za-z]{1,3}\d{0,7}(?::[A-Za-z]{1,3}\d{0,7})?$/;
const NOT_SHARED = 'Google returned a sign-in page, so this sheet is not public. In Google Sheets choose Share → General access → "Anyone with the link" → Viewer (or File → Share → Publish to web), then test again.';

/** A pasted link (or a bare id) → { kind: 'shared'|'published', id, gid } or null. */
function parseSheetUrl(raw) {
  const s = String(raw || '').trim();
  if (ID_RE.test(s)) return { kind: 'shared', id: s, gid: null };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname !== 'docs.google.com') return null;
  const gidFrom = () => {
    const q = u.searchParams.get('gid');
    const h = /(?:^|[#&])gid=(\d+)/.exec(u.hash);
    const g = q || (h && h[1]);
    return g && /^\d{1,12}$/.test(g) ? g : null;
  };
  let m = /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]{20,200})(?:\/|$)/.exec(u.pathname);
  if (m) return { kind: 'published', id: m[1], gid: gidFrom() };
  m = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/.exec(u.pathname);
  if (m) return { kind: 'shared', id: m[1], gid: gidFrom() };
  return null;
}

function validateSheetsConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  if (!parseSheetUrl(c.url)) return 'Paste the link to a Google Sheet (docs.google.com/spreadsheets/…)';
  const ref = parseSheetUrl(c.url);
  if (c.sheet != null && String(c.sheet).length > 100) return 'The tab name is too long';
  if (c.range && !RANGE_RE.test(String(c.range).trim())) return 'The range must look like A1:D20';
  if (ref.kind === 'published' && (c.sheet || c.range)) return 'A published-to-web link reads a whole tab — clear the tab name and range, or use the sheet\'s normal share link';
  if (c.key_column && String(c.key_column).length > 80) return 'The key column name is too long';
  if (c.max_rows != null && c.max_rows !== '' && !(parseInt(c.max_rows, 10) >= 1)) return 'Rows to import must be a positive number';
  return null;
}

/** The CSV URL Google serves for this config. */
function csvUrlFor(c) {
  const ref = parseSheetUrl(c.url);
  const base = 'https://docs.google.com/spreadsheets/d/';
  if (ref.kind === 'published') {
    return `${base}e/${ref.id}/pub?output=csv${ref.gid ? `&gid=${ref.gid}` : ''}&single=true`;
  }
  const sheet = String(c.sheet || '').trim();
  const range = String(c.range || '').trim();
  if (sheet || range) {
    const q = new URLSearchParams({ tqx: 'out:csv' });
    if (sheet) q.set('sheet', sheet); else if (ref.gid) q.set('gid', ref.gid);
    if (range) q.set('range', range.toUpperCase());
    // gviz guesses how many header rows there are unless told; we decide that ourselves.
    q.set('headers', c.header_row === false ? '0' : '1');
    return `${base}${ref.id}/gviz/tq?${q}`;
  }
  return `${base}${ref.id}/export?format=csv${ref.gid ? `&gid=${ref.gid}` : ''}`;
}

function looksLikeHtml(text, contentType) {
  return /text\/html/i.test(contentType || '') || /^\s*<(?:!doctype|html|head)/i.test(String(text).slice(0, 512));
}

async function resolveSheets(config, ctx = {}) {
  const c = config || {};
  const err = validateSheetsConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  let res;
  try {
    res = await fetchText(csvUrlFor(c), { fetcher: ctx.fetcher, maxBytes: 2 * 1024 * 1024 });
  } catch (e) {
    // Private sheets on some accounts answer 401/403 instead of the sign-in page.
    if (e && e.code === 'upstream-status' && /401|403/.test(e.userMessage || '')) throw new UserFacingError(NOT_SHARED, 'not-shared');
    if (e && e.code === 'upstream-status' && /404/.test(e.userMessage || '')) throw new UserFacingError('Google could not find that sheet — check the link. A deleted sheet, or a tab name that does not exist, looks like this too.', 'not-found');
    if (e && e.code === 'upstream-status' && /400/.test(e.userMessage || '')) throw new UserFacingError('Google rejected the request — check the tab name and the range.', 'bad-request');
    throw e;
  }
  if (looksLikeHtml(res.text, res.contentType)) throw new UserFacingError(NOT_SHARED, 'not-shared');

  const { rows } = tab.parseCsv(res.text, ',');
  const table = tab.rowsToTable(rows, { headerRow: c.header_row !== false });
  if (!table.columns.length) throw new UserFacingError('The sheet is empty. Add a header row and some data, then test again.', 'empty');
  const data = tab.flattenTable(table, { keyColumn: c.key_column, maxRows: c.max_rows, now: ctx.now });
  return { data, table: { columns: table.columns, sample: table.records.slice(0, 5) } };
}

module.exports = { parseSheetUrl, validateSheetsConfig, csvUrlFor, looksLikeHtml, resolveSheets, NOT_SHARED };
