'use strict';

/*
 * A PANEL'S NAME MUST NEVER STOP ITS POLL.
 *
 * An embedded panel has no socket: its whole life is GET /api/embedded/render, and every answer
 * carries the screen's name in a response header. An HTTP header value may only hold bytes, so Node
 * refuses to set one that contains a character above U+00FF, or a line break. A screen called
 * "大堂屏幕", "ロビー" or "Lobby ☕" therefore made every poll throw: the panel got a 500, kept what
 * it was showing for ever, and the command queued for it was never delivered.
 *
 * The invariant: any name a workspace can type gives the panel the same answer a plain name would,
 * and a plain name is sent byte for byte as before.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-embhdr-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const express = require('express');
const { db } = require('../db/database');
const embeddedRouter = require('../routes/embedded');

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/embedded', embeddedRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

function panel(name) {
  const id = crypto.randomUUID(), token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, device_token, client_type, status, screen_profile, created_at)
              VALUES (?, ?, ?, 'embedded', 'online', '{"preset":"seeed-reterminal-sticky"}', strftime('%s','now'))`).run(id, name, token);
  return { id, token };
}
const poll = (p) => fetch(`${base}/api/embedded/render?device_id=${p.id}`, { headers: { Authorization: `Bearer ${p.token}` } });

// A panel with nothing assigned answers 404 "no playlist": the shortest path that sets the header.
test('a plain name is sent exactly as it is', async () => {
  const r = await poll(panel('Lobby TV 2'));
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('x-st-device-name'), 'Lobby TV 2');
});

test('a Latin-1 name is still sent as it is', async () => {
  const r = await poll(panel('Café Société'));
  assert.equal(r.status, 404);
  assert.ok(r.headers.get('x-st-device-name'), 'the header is present');
});

for (const name of ['大堂屏幕', 'ロビー', 'Lobby ☕', 'Приёмная', 'Line\r\nBreak', 'Tab\there', 'Emoji 🎉 wall']) {
  test(`a panel named ${JSON.stringify(name)} gets the same answer as any other`, async () => {
    const r = await poll(panel(name));
    assert.equal(r.status, 404, 'no playlist is a 404, not a server error');
    const h = r.headers.get('x-st-device-name');
    assert.ok(h !== null && /^[\x20-\x7E\xA0-\xFF]*$/.test(h), `header is a legal value: ${JSON.stringify(h)}`);
    const body = await r.json();
    assert.equal(body.device_name, name, 'the body still carries the real name');
  });
}
