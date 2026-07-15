'use strict';

// directory-search widget: references a directory-board by id and renders an
// interactive walk-up search page. Verifies the source board's entries are
// safely inlined for client-side filtering, that a missing/wrong source shows a
// friendly fallback (not a 500), and that entry/category text can't break out
// of the inlined <script> (it's set via textContent at runtime).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-dirsearch';

const db = new Database(':memory:');
db.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT);`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const widgetsRouter = require('../routes/widgets');
const app = express();
app.use('/api/widgets', widgetsRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const seed = (id, type, config) => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, type, JSON.stringify(config), 'ws1');
const fetchRender = async (id) => { const r = await fetch(`${base}/api/widgets/${id}/render`); return { status: r.status, html: await r.text() }; };

const BOARD = {
  title: 'Lincoln Warehouse',
  categories: [
    { name: 'First Floor', entries: [
      { identifier: '101', name: 'Acme Co', subtitle: 'Suite A', available: false },
      { identifier: '102', name: 'Available Unit', subtitle: '', available: true },
    ] },
    { name: 'Second Floor', entries: [
      { identifier: '201', name: 'Globex', subtitle: 'Logistics', available: false },
    ] },
  ],
};

test('directory-search renders a search page and inlines the source board entries', async () => {
  seed('board1', 'directory-board', BOARD);
  seed('search1', 'directory-search', { source_widget_id: 'board1', title: 'Find a Tenant', show_onscreen_keyboard: true });
  const { status, html } = await fetchRender('search1');
  assert.equal(status, 200);
  assert.ok(html.includes('id="q"'), 'has a search input');
  assert.ok(html.includes('id="results"'), 'has a results container');
  assert.ok(html.includes('Acme Co') && html.includes('Globex') && html.includes('101'), 'source entries embedded for client-side filtering');
  assert.ok(html.includes('Find a Tenant'), 'search title present');
});

test('show_onscreen_keyboard flag is carried into the page config', async () => {
  seed('search_kb_off', 'directory-search', { source_widget_id: 'board1', show_onscreen_keyboard: false });
  const { html } = await fetchRender('search_kb_off');
  assert.ok(html.includes('"show_onscreen_keyboard":false'), 'keyboard flag inlined (page hides the keyboard when false)');
});

test('missing source -> friendly fallback page, not a 500', async () => {
  seed('search_missing', 'directory-search', { source_widget_id: 'does-not-exist' });
  const { status, html } = await fetchRender('search_missing');
  assert.equal(status, 200);
  assert.ok(html.includes('Directory source not found'), 'friendly message shown instead of an error');
});

test('non-directory-board source -> friendly fallback page', async () => {
  seed('clockX', 'clock', {});
  seed('search_wrongtype', 'directory-search', { source_widget_id: 'clockX' });
  const { status, html } = await fetchRender('search_wrongtype');
  assert.equal(status, 200);
  assert.ok(html.includes('Directory source not found'), 'friendly message for a wrong source type');
});

test('XSS: entry/category text cannot break out of the inlined script', async () => {
  seed('board_xss', 'directory-board', {
    categories: [{
      name: '</script><script>window.__pwned=1</script>',
      entries: [{ identifier: '<img src=x onerror=alert(1)>', name: '"><b>bold</b>', subtitle: 'amp & lt < gt >', available: false }],
    }],
  });
  seed('search_xss', 'directory-search', { source_widget_id: 'board_xss' });
  const { status, html } = await fetchRender('search_xss');
  assert.equal(status, 200);
  assert.ok(!html.includes('</script><script>window.__pwned'), 'raw </script> breakout neutralized');
  assert.ok(html.includes('\\u003c/script>'), 'angle brackets escaped in the inlined JSON blob');
});

// ---- live sync: GET /:id/data.json feed the search page polls ----
const fetchData = async (id) => fetch(`${base}/api/widgets/${id}/data.json`);

test('data.json returns the source board categories, CORS-open for polling', async () => {
  const r = await fetchData('board1'); // seeded in the first test
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'readable from a null-origin sandboxed iframe');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.ok(Array.isArray(body.categories) && body.categories.length === 2, 'returns the categories array');
  assert.equal(body.categories[0].entries[0].name, 'Acme Co');
});

test('data.json 404s for a missing widget (poll keeps last-good data)', async () => {
  assert.equal((await fetchData('does-not-exist')).status, 404);
});

test('data.json 404s for a non-directory-board widget', async () => {
  assert.equal((await fetchData('clockX')).status, 404); // clockX seeded earlier
});

test('search page wires the live-sync poll to its source board', async () => {
  const { html } = await fetchRender('search1');
  assert.ok(html.includes('"source_widget_id":"board1"'), 'source board id inlined into the page');
  assert.ok(html.includes('/data.json'), 'page polls the data.json feed');
});
