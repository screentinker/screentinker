'use strict';

// Kiosk button icons rendered as the literal text "&#128205;": the defaults were stored as numeric
// HTML entities and the render escapes every field. New defaults are real emoji; pages saved with the
// old entity strings are decoded (numeric entities only) before escaping, so nothing else gets through.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-kiosk-icons-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const kiosk = require('../routes/kiosk');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-k', 'kiosk@test', 'K', 'platform_admin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-k', 'K', 'u-k')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-k', 'org-k', 'K')").run();

let server;
async function call(method, url, body) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u-k', role: 'platform_admin' }; req.workspaceId = 'ws-k'; next(); });
    app.use('/api/kiosk', kiosk);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}
after(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const iconsOf = (html) => [...html.matchAll(/<div class="icon">([^<]*)<\/div>/g)].map((m) => m[1]);

test('a new page gets real emoji icons, and the render shows them as characters', async () => {
  const created = await call('POST', '/api/kiosk', { name: 'Lobby' });
  assert.equal(created.status, 201);
  const page = JSON.parse(created.text);
  const icons = JSON.parse(page.config).buttons.map((b) => b.icon);
  for (const i of icons) assert.doesNotMatch(i, /&#/, `default icon ${i} must not be an entity string`);
  const html = (await call('GET', `/api/kiosk/${page.id}/render`)).text;
  assert.deepEqual(iconsOf(html), icons);
  assert.ok(iconsOf(html).includes('\u{1F4CD}'));
});

test('a page saved with entity icons renders the characters; everything else stays escaped', async () => {
  const config = { buttons: [
    { label: 'A', icon: '&#128205;' },
    { label: 'B', icon: '&#x1F4C5;' },
    { label: 'C', icon: '<img src=x onerror=alert(1)>' },
    { label: 'D', icon: '&#60;script&#62;' },        // decodes to <script>, which is then escaped
    { label: 'E', icon: '&amp; &#99999999; &#xD800;' }, // named + out-of-range entities stay as text
  ] };
  db.prepare("INSERT INTO kiosk_pages (id, user_id, workspace_id, name, config) VALUES ('kp-old', 'u-k', 'ws-k', 'Old', ?)")
    .run(JSON.stringify(config));
  const { status, text } = await call('GET', '/api/kiosk/kp-old/render');
  assert.equal(status, 200);
  assert.deepEqual(iconsOf(text), [
    '\u{1F4CD}',
    '\u{1F4C5}',
    '&lt;img src=x onerror=alert(1)&gt;',
    '&lt;script&gt;',
    '&amp;amp; &amp;#99999999; &amp;#xD800;',
  ]);
  assert.doesNotMatch(text, /<img src=x/);
});

test('decodeNumericEntities decodes numeric entities only', () => {
  const { decodeNumericEntities } = kiosk;
  assert.equal(decodeNumericEntities('&#10068;'), '❔');
  assert.equal(decodeNumericEntities('&#x2b50;'), '⭐');
  assert.equal(decodeNumericEntities('&lt;'), '&lt;');
  assert.equal(decodeNumericEntities('&#0;'), '&#0;');
  assert.equal(decodeNumericEntities(undefined), undefined);
});
