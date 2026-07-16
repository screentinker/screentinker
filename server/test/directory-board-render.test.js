'use strict';

// Guards the directory-board header behaviour: a logo REPLACES the title text
// (showing both stacked the wordmark over the name). Renders the public widget
// endpoint and inspects the emitted board script. Mirrors widget-render-xss.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-dir-board';

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

const seed = (id, config) => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, 'directory-board', JSON.stringify(config), 'ws1');
const render = async (id) => (await fetch(`${base}/api/widgets/${id}/render`)).text();

test('directory board: title text is gated behind !logoSrc (logo replaces title)', async () => {
  seed('b1', { title: 'LINNcinnati', logo_url: '/api/content/abc/file', categories: [] });
  const html = await render('b1');
  // The title h1 must only be appended when there is no logo.
  assert.match(html, /if \(cfg\.title && !logoSrc\)/, 'title render must be guarded by !logoSrc');
  assert.doesNotMatch(html, /if \(cfg\.title\) \{\s*\n\s*var h1/, 'title must not be rendered unconditionally');
});

test('directory board: still embeds title + logo config for the client', async () => {
  seed('b2', { title: 'Lincoln Warehouse', logo_url: '/api/content/xyz/file', categories: [] });
  const html = await render('b2');
  assert.match(html, /Lincoln Warehouse/, 'title present in embedded config');
  assert.match(html, /\/api\/content\/xyz\/file/, 'logo url present in embedded config');
});
