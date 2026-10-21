'use strict';

/*
 * A screen's Default Content (Device Info -> Settings -> Default Content) never appeared on the
 * web player. Found filming the user-guide videos; the guide tells people to use it.
 *
 * Two defects, both needed for the picture to show:
 *
 *   1. renderDefaultContent() mounted the image into #playerContainer but never hid
 *      #statusOverlay, which sits above it (z-index 500). The "Waiting for content..." card put up
 *      by an earlier path — and by device:paired, which fires on EVERY reconnect — stayed on top,
 *      so the image was in the DOM and nobody could see it.
 *   2. Save Settings (PUT /api/devices/:id) stored default_content_id but pushed nothing; the
 *      payload that carries it was only sent on (re)connect, so a running screen never heard.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/*
 * The real renderDefaultContent, run against a fake DOM. Asserting on the overlay rather than on
 * the source text: the bug was an image that WAS mounted and still not visible.
 */
function harness(defaultContent) {
  const start = PLAYER.indexOf('function renderDefaultContent()');
  const end = PLAYER.indexOf('// Every item filtered out', start);
  assert.ok(start !== -1 && end !== -1, 'renderDefaultContent not found -- did it move?');
  const src = PLAYER.slice(start, end);
  const overlay = { style: { display: 'flex' } };
  const imgs = [];
  const container = {
    style: {},
    appendChild: (el) => imgs.push(el),
    querySelector: (sel) => (sel === 'img[data-st-default]' ? imgs[imgs.length - 1] || null : null),
  };
  const document = {
    getElementById: (id) => (id === 'playerContainer' ? container : id === 'statusOverlay' ? overlay : null),
    createElement: () => ({ style: {}, setAttribute() {} }),
  };
  const fn = new Function('document', 'defaultContent', 'teardownCurrentMedia', 'mediaUrl', `
    let _defaultShownRev = null;
    function hideStatus() { document.getElementById('statusOverlay').style.display = 'none'; }
    ${src}
    return renderDefaultContent;`)(document, defaultContent, () => {}, (dc) => '/uploads/' + dc.filepath);
  return { render: fn, overlay, imgs };
}

const IMAGE = { content_id: 'c1', content_rev: 'r1', mime_type: 'image/png', filepath: 'menu.png' };

test('the default image hides the "Waiting for content..." card that would cover it', () => {
  const h = harness(IMAGE);
  assert.equal(h.render(), true);
  assert.equal(h.imgs.length, 1, 'the image is mounted');
  assert.equal(h.overlay.style.display, 'none', 'and the status card above it is hidden, or it is never seen');
});

test('...also when it is already on screen and a later path put the card back up', () => {
  // device:paired on a reconnect, or the 30s nothing-scheduled re-check, re-enters with the same
  // image already mounted: the idempotent early return must still clear the card.
  const h = harness(IMAGE);
  h.render();
  h.overlay.style.display = 'flex';
  assert.equal(h.render(), true);
  assert.equal(h.imgs.length, 1, 'not re-mounted (no flicker)');
  assert.equal(h.overlay.style.display, 'none');
});

test('no default (or a non-image) leaves the card to the caller', () => {
  for (const dc of [null, { ...IMAGE, mime_type: 'video/mp4' }]) {
    const h = harness(dc);
    assert.equal(h.render(), false);
    assert.equal(h.overlay.style.display, 'flex');
  }
});

test('device:paired shows the default image as the idle screen, not the card over it', () => {
  const i = PLAYER.indexOf("socket.on('device:paired'");
  assert.ok(i !== -1);
  const handler = PLAYER.slice(i, PLAYER.indexOf('});', PLAYER.indexOf('shouldShowIdle', i)) + 3);
  assert.match(handler, /if \(showIdle && !renderDefaultContent\(\)\) showStatus\('Waiting for content\.\.\.'\)/);
});

// ---- Save Settings reaches a connected screen ----

let proc, BASE, DATA_DIR, jwt, workspaceId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
});

function png1x1() {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-default-content-'));
  const LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `dc${Date.now()}@example.com`, password: 'Passw0rd123', name: 'DC' }),
  })).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('provision timeout')), 15000);
  });
}
function openRegistered(dev) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => resolve(sock));
    sock.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 15000);
  });
}
// Registration itself emits an update; match on content so that one is never mistaken for the push.
function waitForUpdate(sock, predicate, ms = 6000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.off('device:playlist-update', h); resolve(null); }, ms);
    function h(p) { if (predicate(p)) { clearTimeout(t); sock.off('device:playlist-update', h); resolve(p); } }
    sock.on('device:playlist-update', h);
  });
}

test('Save Settings pushes the new Default Content to a screen that is already connected', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([png1x1()], { type: 'image/png' }), 'standby.png');
  const up = await (await fetch(BASE + '/api/content', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd })).json();
  const contentId = (Array.isArray(up) ? up[0] : (up.content || up.items || up.uploaded || [up])[0]).id;
  assert.ok(contentId, `upload failed: ${JSON.stringify(up)}`);

  const dev = await provision();
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  raw.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(workspaceId, dev.id);
  raw.close();
  const sock = await openRegistered(dev);
  try {
    const seen = waitForUpdate(sock, (p) => p && p.default_content && p.default_content.content_id === contentId);
    // The body the dashboard's Save Settings sends.
    const r = await fetch(BASE + '/api/devices/' + dev.id, J({ notes: '', orientation: 'landscape', background_color: '', default_content_id: contentId }, 'PUT'));
    assert.equal(r.status, 200, await r.text());
    const payload = await seen;
    assert.ok(payload, 'no playlist-update carrying the new default reached the connected screen');
    assert.equal(payload.default_content.mime_type, 'image/png');
  } finally { try { sock.close(); } catch { /* */ } }
});
