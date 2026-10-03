'use strict';

// Built-in data sources: REST, Google Sheets, CSV, RSS/Atom, manual table, and the shared table
// engine. Network is replaced by a `fetcher` stub; the SSRF path is covered by ssrf-guard tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tab = require('../lib/data-sources/tabular');
const rest = require('../lib/data-sources/rest-resolver');
const sheets = require('../lib/data-sources/sheets-resolver');
const csv = require('../lib/data-sources/csv-resolver');
const rss = require('../lib/data-sources/rss-resolver');
const table = require('../lib/data-sources/table-resolver');
const { getBuiltinType, BUILTIN_TYPE_NAMES } = require('../lib/data-sources/builtin-types');
const { UserFacingError, fetchText } = require('../lib/data-sources/http');
const { fieldsForDataSource, secretNames } = require('../lib/plugins/secrets');
const { RESERVED_DATA_SOURCE_TYPES } = require('../lib/plugins/reserved');
const { keepUpdatedStamp, describeSyncError } = require('../lib/data-sources/service');

const NOW = new Date('2026-09-30T12:00:00Z');
const stub = (text, contentType = 'application/json') => {
  const calls = [];
  const fetcher = async (url, opts) => { calls.push({ url, opts }); return { text, contentType, status: 200 }; };
  return { fetcher, calls };
};

// ─── table engine ──────────────────────────────────────────────────────────────
test('parseCsv: quotes, doubled quotes, embedded newlines, BOM, CRLF', () => {
  const { rows } = tab.parseCsv('﻿Name,Note\r\n"Smith, J","said ""hi""\nthen left"\r\nB,x\r\n');
  assert.deepEqual(rows, [['Name', 'Note'], ['Smith, J', 'said "hi"\nthen left'], ['B', 'x']]);
});

test('sniffDelimiter picks ; and tab and ignores delimiters inside quotes', () => {
  assert.equal(tab.sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(tab.sniffDelimiter('a\tb\n'), '\t');
  assert.equal(tab.sniffDelimiter('"a,b,c";d'), ';');
});

test('rowsToTable: headers slugged and deduplicated, blank rows dropped, width capped', () => {
  const t = tab.rowsToTable([['Item Name', 'Price (€)', 'Price (€)', ''], ['', '', '', ''], ['Latte', '3,50', '4', 'x']]);
  assert.deepEqual(t.columns.map((c) => c.key), ['item_name', 'price', 'price_2', 'column_4']);
  assert.equal(t.records.length, 1);
  const wide = tab.rowsToTable([Array.from({ length: 50 }, (_, i) => `c${i}`)]);
  assert.equal(wide.columns.length, tab.MAX_COLUMNS);
});

test('toNumber: currency, thousands, percent, decimal comma, junk', () => {
  assert.equal(tab.toNumber('$1,234.50'), 1234.5);
  assert.equal(tab.toNumber('12%'), 12);
  assert.equal(tab.toNumber('1.234,5', true), 1234.5);
  assert.equal(tab.toNumber('n/a'), null);
  assert.equal(tab.toNumber(''), null);
});

test('flattenTable: positional, aggregates, rows_text and lookup mode', () => {
  const t = tab.rowsToTable([['Item', 'Price'], ['Latte', '3.50'], ['Flat White', '4.00'], ['Mocha', '4.50']]);
  const d = tab.flattenTable(t, { keyColumn: 'Item', now: NOW });
  assert.equal(d.row_count, 3);
  assert.equal(d.row2_item, 'Flat White');
  assert.equal(d.sum_price, 12);
  assert.equal(d.avg_price, 4);
  assert.equal(d.max_price, 4.5);
  assert.equal(d.latte_price, '3.50');
  assert.equal(d.flat_white, '4.00', 'two columns: <key> alone is the other cell');
  assert.match(d.rows_text, /^Latte · 3\.50\nFlat White/);
  assert.equal(d.updated, NOW.toISOString());
  assert.equal(d.sum_item, undefined, 'text columns get no aggregates');
});

test('flattenTable is bounded', () => {
  const rows = [Array.from({ length: 30 }, (_, i) => `c${i}`)];
  for (let r = 0; r < 500; r++) rows.push(Array.from({ length: 30 }, () => 'v'));
  const d = tab.flattenTable(tab.rowsToTable(rows), {});
  assert.ok(Object.keys(d).length <= tab.MAX_KEYS);
  assert.equal(d.row101_c0, undefined);
});

// ─── REST ──────────────────────────────────────────────────────────────────────
test('REST validation', () => {
  const ok = { url: 'https://api.example.com/x' };
  assert.equal(rest.validateRestConfig(ok), null);
  assert.match(rest.validateRestConfig({ url: 'ftp://x' }), /http/);
  assert.match(rest.validateRestConfig({ url: 'https://u:p@x.com' }), /username/);
  assert.match(rest.validateRestConfig({ ...ok, method: 'DELETE' }), /GET or POST/);
  assert.match(rest.validateRestConfig({ ...ok, body: '{}' }), /only sent with POST/);
  assert.match(rest.validateRestConfig({ ...ok, method: 'POST', body: '{bad' }), /valid JSON/);
  assert.match(rest.validateRestConfig({ ...ok, auth_type: 'header', auth_header: 'Cookie' }), /cannot be set/);
  assert.match(rest.validateRestConfig({ ...ok, auth_type: 'header', auth_header: 'X Bad' }), /header name/);
  assert.match(rest.validateRestConfig({ ...ok, auth_type: 'basic' }), /username/);
  assert.match(rest.validateRestConfig({ ...ok, json_path: 'a;process.exit()' }), /data path/);
});

test('selectPath: dots, indices, quoted keys, $ prefix, * and missing', () => {
  const v = { data: { items: [{ n: 1 }, { n: 2 }], 'odd key': 5 } };
  assert.equal(rest.selectPath(v, 'data.items[1].n'), 2);
  assert.equal(rest.selectPath(v, "$.data['odd key']"), 5);
  assert.equal(rest.selectPath(v, 'data.items[*]').length, 2);
  assert.equal(rest.selectPath(v, 'data.nope.deeper'), undefined);
  assert.equal(rest.selectPath(v, '__proto__'), undefined, 'own properties only');
  assert.equal(rest.selectPath(v, ''), v);
});

test('REST auth headers: bearer, custom header, basic; no auth leaves no header', () => {
  assert.equal(rest.buildRequest({ auth_type: 'bearer', auth_token: ' t0k ' }).headers.Authorization, 'Bearer t0k');
  assert.equal(rest.buildRequest({ auth_type: 'header', auth_header: 'X-API-Key', auth_token: 'k' }).headers['X-API-Key'], 'k');
  assert.equal(rest.buildRequest({ auth_type: 'basic', auth_username: 'u', auth_password: 'p' }).headers.Authorization, 'Basic dTpw');
  assert.equal(rest.buildRequest({}).headers.Authorization, undefined);
  const post = rest.buildRequest({ method: 'post', body: '{"q":1}' });
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Content-Type'], 'application/json');
});

test('REST: a list of records becomes a table with lookup keys', async () => {
  const { fetcher } = stub(JSON.stringify({ data: [{ region: 'North', sales: 120, meta: { rep: 'Ann' } }, { region: 'South', sales: 80, meta: { rep: 'Bo' } }] }));
  const out = await rest.resolveRest({ url: 'https://api.example.com/s', json_path: 'data', key_column: 'region' }, { fetcher, now: NOW });
  assert.equal(out.data.row_count, 2);
  assert.equal(out.data.row1_meta_rep, 'Ann');
  assert.equal(out.data.sum_sales, 200);
  assert.equal(out.data.south_sales, '80');
  assert.deepEqual(out.table.columns.map((c) => c.key), ['region', 'sales', 'meta_rep']);
  assert.ok(Array.isArray(out.raw));
});

test('REST: an object is flattened', async () => {
  const { fetcher } = stub(JSON.stringify({ status: { ok: true, uptime: 99.9 }, tags: ['a', 'b'] }));
  const out = await rest.resolveRest({ url: 'https://api.example.com/s' }, { fetcher, now: NOW });
  assert.equal(out.data.status_ok, true);
  assert.equal(out.data.status_uptime, 99.9);
  assert.equal(out.data.tags_count, 2);
  assert.equal(out.data.tags_2, 'b');
  assert.equal(out.table, undefined);
});

test('REST: CSV answers are read as a table; bad JSON and a missing path are explained', async () => {
  const c1 = stub('a,b\n1,2\n', 'text/csv');
  const out = await rest.resolveRest({ url: 'https://api.example.com/c' }, { fetcher: c1.fetcher });
  assert.equal(out.data.row1_b, '2');
  await assert.rejects(rest.resolveRest({ url: 'https://x.example/j', response_format: 'json' }, { fetcher: stub('nope', 'text/plain').fetcher }),
    (e) => e instanceof UserFacingError && /not valid JSON/.test(e.userMessage));
  await assert.rejects(rest.resolveRest({ url: 'https://x.example/j', json_path: 'a.b' }, { fetcher: stub('{"a":{}}').fetcher }),
    (e) => /Nothing found at "a.b"/.test(e.userMessage));
});

test('REST: a custom API-key header never follows redirects; bearer may', async () => {
  const h = stub('{}');
  await rest.resolveRest({ url: 'https://x.example/', auth_type: 'header', auth_header: 'X-Key', auth_token: 'k' }, { fetcher: h.fetcher });
  assert.equal(h.calls[0].opts.maxRedirects, 0);
  const b = stub('{}');
  await rest.resolveRest({ url: 'https://x.example/', auth_type: 'bearer', auth_token: 'k' }, { fetcher: b.fetcher });
  assert.equal(b.calls[0].opts.maxRedirects, 5);
});

test('fetchText maps upstream failures to operator messages and keeps network errors generic', async () => {
  const { GuardedRequestError } = require('../lib/ssrf-guard');
  const guard = require('../lib/ssrf-guard');
  const orig = guard.guardedRequest;
  // fetchText holds its own reference, so exercise the mapping through a fresh module instance.
  delete require.cache[require.resolve('../lib/data-sources/http')];
  const errs = [
    [new GuardedRequestError('Request failed with status 401', 'upstream-status', 401), /401 Unauthorized/],
    [new GuardedRequestError('Request failed with status 503', 'upstream-status', 503), /HTTP 503/],
    [new GuardedRequestError('Response exceeds size limit', 'size-limit'), /larger than 1 MB/],
    [new GuardedRequestError('Request timed out', 'timeout'), /in time/],
  ];
  try {
    for (const [err, re] of errs) {
      guard.guardedRequest = async () => { throw err; };
      delete require.cache[require.resolve('../lib/data-sources/http')];
      const http = require('../lib/data-sources/http');
      await assert.rejects(http.fetchText('https://x.example/'), (e) => e.name === 'UserFacingError' && re.test(e.userMessage));
    }
    guard.guardedRequest = async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:80'), { code: 'ECONNREFUSED' }); };
    delete require.cache[require.resolve('../lib/data-sources/http')];
    await assert.rejects(require('../lib/data-sources/http').fetchText('https://x.example/'), (e) => !e.userMessage);
  } finally {
    guard.guardedRequest = orig;
    delete require.cache[require.resolve('../lib/data-sources/http')];
  }
  assert.equal(typeof fetchText, 'function');
});

// ─── Google Sheets ─────────────────────────────────────────────────────────────
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';

test('parseSheetUrl: share links, gid in hash or query, /u/0/, published, bare id, lookalikes', () => {
  assert.deepEqual(sheets.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=42`), { kind: 'shared', id: SHEET_ID, gid: '42' });
  assert.deepEqual(sheets.parseSheetUrl(`https://docs.google.com/spreadsheets/u/0/d/${SHEET_ID}/edit?gid=7#gid=7`), { kind: 'shared', id: SHEET_ID, gid: '7' });
  assert.equal(sheets.parseSheetUrl(`https://docs.google.com/spreadsheets/d/e/2PACX-${SHEET_ID}/pubhtml`).kind, 'published');
  assert.equal(sheets.parseSheetUrl(SHEET_ID).id, SHEET_ID);
  assert.equal(sheets.parseSheetUrl(`https://docs.google.com.evil.example/spreadsheets/d/${SHEET_ID}/`), null);
  assert.equal(sheets.parseSheetUrl(`https://evil.example/spreadsheets/d/${SHEET_ID}/`), null);
  assert.equal(sheets.parseSheetUrl('https://docs.google.com/document/d/xyz/edit'), null);
});

test('csvUrlFor: export, gviz for tab name / range, pub for published', () => {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=42`;
  assert.equal(sheets.csvUrlFor({ url: base }), `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=42`);
  const g = new URL(sheets.csvUrlFor({ url: base, sheet: 'Menu & Prices', range: 'a1:c9' }));
  assert.equal(g.pathname, `/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  assert.equal(g.searchParams.get('sheet'), 'Menu & Prices');
  assert.equal(g.searchParams.get('range'), 'A1:C9');
  assert.equal(g.searchParams.get('tqx'), 'out:csv');
  assert.match(sheets.csvUrlFor({ url: `https://docs.google.com/spreadsheets/d/e/2PACX-${SHEET_ID}/pubhtml?gid=3` }), /\/pub\?output=csv&gid=3&single=true$/);
});

test('Sheets validation', () => {
  assert.match(sheets.validateSheetsConfig({ url: 'https://example.com/x' }), /Google Sheet/);
  assert.match(sheets.validateSheetsConfig({ url: SHEET_ID, range: 'A1;DROP' }), /A1:D20/);
  assert.match(sheets.validateSheetsConfig({ url: `https://docs.google.com/spreadsheets/d/e/2PACX-${SHEET_ID}/pubhtml`, sheet: 'x' }), /published/);
  assert.equal(sheets.validateSheetsConfig({ url: SHEET_ID, range: 'B2:F' }), null);
});

test('Sheets: a sign-in page (not shared) is an explained error, never cached as data', async () => {
  const { fetcher } = stub('<!DOCTYPE html><html><body>Sign in</body></html>', 'text/html; charset=utf-8');
  await assert.rejects(sheets.resolveSheets({ url: SHEET_ID }, { fetcher }), (e) => e.code === 'not-shared' && /Anyone with the link/.test(e.userMessage));
});

test('Sheets: CSV → table with lookup', async () => {
  const { fetcher, calls } = stub('Room,Meeting,Time\nAtlas,Board review,09:00\nZephyr,Standup,10:30\n', 'text/csv');
  const out = await sheets.resolveSheets({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`, key_column: 'Room' }, { fetcher, now: NOW });
  assert.match(calls[0].url, /export\?format=csv&gid=0$/);
  assert.equal(out.data.atlas_meeting, 'Board review');
  assert.equal(out.data.zephyr_time, '10:30');
  assert.equal(out.data.row_count, 2);
  assert.equal(out.table.sample[1].room, 'Zephyr');
});

test('Sheets: empty sheet explained', async () => {
  await assert.rejects(sheets.resolveSheets({ url: SHEET_ID }, { fetcher: stub('', 'text/csv').fetcher }), (e) => e.code === 'empty');
});

// ─── CSV ───────────────────────────────────────────────────────────────────────
test('CSV: semicolon files use decimal commas; web pages are refused', async () => {
  const out = await csv.resolveCsv({ url: 'https://x.example/f.csv' }, { fetcher: stub('Item;Price\nA;1,50\nB;2,50\n', 'text/csv').fetcher });
  assert.equal(out.data.sum_price, 4);
  await assert.rejects(csv.resolveCsv({ url: 'https://x.example/f' }, { fetcher: stub('<html></html>', 'text/html').fetcher }), (e) => e.code === 'not-csv');
  assert.match(csv.validateCsvConfig({ url: 'https://x.example', delimiter: 'x' }), /delimiter/);
});

// ─── RSS / Atom ────────────────────────────────────────────────────────────────
const RSS = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Ops &amp; Status</title><link>https://status.example</link>
<item><title><![CDATA[Database <b>degraded</b>]]></title><link>https://status.example/1</link><pubDate>Tue, 29 Sep 2026 14:05:00 GMT</pubDate>
<description>&lt;p&gt;Read replicas lagging &amp;xxe; &lt;img src="https://img.example/a.png"&gt;&lt;/p&gt;</description></item>
<item><title>All clear &#8212; resolved</title><link>javascript:alert(1)</link><media:thumbnail url="https://img.example/t.jpg"/></item>
</channel></rss>`;

test('RSS: items, CDATA, entities, images, dates; no DTD entities expanded; only http(s) links', async () => {
  const out = await rss.resolveRss({ url: 'https://status.example/feed', timezone: 'UTC', locale: 'en-US' }, { fetcher: stub(RSS, 'application/rss+xml').fetcher, now: NOW });
  const d = out.data;
  assert.equal(d.feed_title, 'Ops & Status');
  assert.equal(d.item_count, 2);
  assert.equal(d.item1_title, 'Database degraded');
  assert.equal(d.item1_image, 'https://img.example/a.png');
  assert.match(d.item1_summary, /^Read replicas lagging &xxe;$/);
  assert.doesNotMatch(JSON.stringify(d), /root:/);
  assert.equal(d.item1_date_iso, '2026-09-29T14:05:00.000Z');
  assert.match(d.item1_date, /Sep 29, 2026/);
  assert.equal(d.item2_title, 'All clear — resolved');
  assert.equal(d.item2_link, '');
  assert.equal(d.item2_image, 'https://img.example/t.jpg');
  assert.equal(d.headlines_text, 'Database degraded\nAll clear — resolved');
});

test('Atom feeds', () => {
  const f = rss.parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link rel="self" href="https://b.example/atom"/><link href="https://b.example/"/>
    <entry><title>Hello</title><link rel="alternate" href="https://b.example/hello"/><updated>2026-09-01T00:00:00Z</updated><summary>Hi there</summary><author><name>Dee</name></author></entry></feed>`);
  assert.equal(f.link, 'https://b.example/');
  assert.equal(f.items[0].link, 'https://b.example/hello');
  assert.equal(f.items[0].author, 'Dee');
});

test('RSS: a web page is explained; limits validated', async () => {
  await assert.rejects(rss.resolveRss({ url: 'https://x.example/' }, { fetcher: stub('<!doctype html><html></html>', 'text/html').fetcher }), (e) => /web page, not a feed/.test(e.userMessage));
  assert.match(rss.validateRssConfig({ url: 'https://x.example', max_items: 99 }), /between 1 and 50/);
  assert.match(rss.validateRssConfig({ url: 'https://x.example', timezone: 'Mars/Base' }), /time zone/);
});

// ─── manual table ──────────────────────────────────────────────────────────────
test('Manual table: resolves without a network and validates its bounds', async () => {
  const out = table.resolveTable({ columns: ['Name', 'Score'], rows: [['Ana', '12'], ['Ben', 9]], key_column: 'Name' }, { now: NOW });
  assert.equal(out.data.ana, '12');
  assert.equal(out.data.max_score, 12);
  assert.match(table.validateTableConfig({ columns: [], rows: [] }), /at least one column/);
  assert.match(table.validateTableConfig({ columns: ['a'], rows: Array.from({ length: 201 }, () => ['x']) }), /200 rows/);
  assert.match(table.validateTableConfig({ columns: ['a'], rows: [[{ x: 1 }]] }), /text or numbers/);
});

// ─── wiring ────────────────────────────────────────────────────────────────────
test('registry, reserved names and secret fields', () => {
  for (const t of BUILTIN_TYPE_NAMES) {
    assert.ok(RESERVED_DATA_SOURCE_TYPES.has(t), `${t} reserved from plugins`);
    assert.equal(typeof getBuiltinType(t).resolve, 'function');
  }
  assert.equal(getBuiltinType('constructor'), null);
  const names = secretNames(fieldsForDataSource('rest'));
  assert.ok(names.has('auth_token') && names.has('auth_password'));
  assert.ok(!names.has('auth_type') && !names.has('auth_header') && !names.has('auth_username'));
  assert.equal(getBuiltinType('rss').interval({ interval_min: 1 }), 5);
  assert.equal(getBuiltinType('sheets').interval({}), 15);
});

test('keepUpdatedStamp: unchanged data keeps its old stamp so widgets are not re-rendered', () => {
  const prev = JSON.stringify({ a: 1, updated: '2026-01-01T00:00:00.000Z' });
  assert.equal(keepUpdatedStamp({ a: 1, updated: 'new' }, prev).updated, '2026-01-01T00:00:00.000Z');
  assert.equal(keepUpdatedStamp({ a: 2, updated: 'new' }, prev).updated, 'new');
  assert.equal(keepUpdatedStamp({ a: 1, updated: 'new' }, null).updated, 'new');
});

test('describeSyncError shows operator messages and hides the rest', () => {
  assert.equal(describeSyncError(new UserFacingError('The sheet is empty.', 'empty')), 'The sheet is empty.');
  assert.doesNotMatch(describeSyncError(new Error('connect ECONNREFUSED 10.1.2.3:5432')), /10\.1\.2\.3/);
});
