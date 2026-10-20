'use strict';

// #674: the web player showed "ScreenTinker" on a white-labelled instance — on the tap-to-start
// overlay, the status overlay, the setup screen and the tab title — because /player never read
// branding. These pin both halves: the page served for a hostname carries that hostname's brand
// (escaped, never markup), and device:paired carries the paired workspace's own brand.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
const { playerBrand } = require('../lib/branding');

test('playerBrand: a custom name always shows; "hide" only ever hides the upstream name', () => {
  assert.deepEqual(playerBrand(null), { name: 'ScreenTinker', hidden: false });
  assert.deepEqual(playerBrand({ brand_name: 'Acme Signs', hide_branding: 0 }), { name: 'Acme Signs', hidden: false });
  assert.deepEqual(playerBrand({ brand_name: 'Acme Signs', hide_branding: 1 }), { name: 'Acme Signs', hidden: false });
  assert.deepEqual(playerBrand({ brand_name: 'ScreenTinker', hide_branding: 1 }), { name: '', hidden: true });
  assert.deepEqual(playerBrand({ brand_name: '  ', hide_branding: 1 }), { name: '', hidden: true });
  assert.deepEqual(playerBrand({ brand_name: '', hide_branding: 0 }), { name: 'ScreenTinker', hidden: false });
  assert.equal(playerBrand({ brand_name: 'x'.repeat(500) }).name.length, 80, 'bounded: it lands in a heading');
});

let PORT, BASE, proc, db, JWT, WS, ADMIN;
const DATA_DIR = path.join(os.tmpdir(), 'st-player-brand-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  const env = { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' };
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'test12345', name: 'Admin' }) });
  JWT = (await r.json()).token;
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  WS = db.prepare('SELECT id FROM workspaces LIMIT 1').get().id;
  ADMIN = db.prepare('SELECT id FROM users LIMIT 1').get().id;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { db.close(); } catch { /* */ } });

const platformDefault = (brand, hide) => {
  db.prepare('DELETE FROM white_labels WHERE id = ?').run('platform-default');
  if (brand !== null) {
    db.prepare("INSERT INTO white_labels (id, user_id, brand_name, hide_branding) VALUES ('platform-default', ?, ?, ?)").run(ADMIN, brand, hide ? 1 : 0);
  }
};
const page = async (url = '/player') => (await fetch(BASE + url)).text();
const served = (html) => JSON.parse(html.match(/window\.__playerConfig\.brand = (\{.*?\});/)[1]);

test('unbranded instance: unchanged', async () => {
  platformDefault(null);
  const html = await page();
  assert.match(html, /<title>ScreenTinker Player<\/title>/);
  assert.match(html, /<h1 data-brand>ScreenTinker<\/h1>/);
  assert.match(html, /<h2 data-brand>ScreenTinker<\/h2>/);
  assert.deepEqual(served(html), { name: 'ScreenTinker', hidden: false });
});

test('a platform brand reaches every heading, escaped as text, on both player builds', async () => {
  platformDefault('Acme <b>&</b> "Co"', false);
  for (const url of ['/player', '/player/legacy']) {
    const html = await page(url);
    assert.match(html, /<title>Acme &lt;b&gt;&amp;&lt;\/b&gt; &quot;Co&quot; Player<\/title>/, url);
    assert.match(html, /<h1 data-brand>Acme &lt;b&gt;&amp;&lt;\/b&gt; &quot;Co&quot;<\/h1>/, url);
    assert.match(html, /<h2 data-brand>Acme &lt;b&gt;/, url);
    assert.doesNotMatch(html, /<h[12][^>]*>ScreenTinker</, url + ': no upstream heading left');
    assert.doesNotMatch(html, /<b>&<\/b>/, url + ': never markup');
    assert.equal(served(html).name, 'Acme <b>&</b> "Co"', url);
  }
});

test('hide platform branding on an unrenamed instance: no product name at all', async () => {
  platformDefault('ScreenTinker', true);
  const html = await page();
  assert.match(html, /<title>Player<\/title>/);
  assert.match(html, /<h1 data-brand><\/h1>/);
  assert.deepEqual(served(html), { name: '', hidden: true });
});

test('device:paired carries the paired workspace\'s brand', async () => {
  platformDefault('Platform Brand', false);
  db.prepare("INSERT INTO white_labels (id, user_id, brand_name, workspace_id) VALUES ('wl-ws', ?, 'Workspace Brand', ?)").run(ADMIN, WS);
  const code = String(crypto.randomInt(100000, 1000000));
  const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  try {
    const registered = new Promise((resolve) => sock.on('device:registered', resolve));
    const paired = new Promise((resolve) => sock.on('device:paired', resolve));
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    const reg = await registered;
    const r = await fetch(BASE + '/api/provision/pair', {
      method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json', 'X-Workspace-Id': WS },
      body: JSON.stringify({ pairing_code: code, name: 'Lobby' }),
    });
    assert.equal(r.status, 200);
    const msg = await Promise.race([paired, sleep(5000).then(() => null)]);
    assert.ok(msg, 'device:paired arrived');
    assert.deepEqual(msg.brand, { name: 'Workspace Brand', hidden: false });

    // And on every reconnect of an already-paired screen (the path a rebooted panel takes).
    sock.close();
    const again = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    try {
      const repaired = new Promise((resolve) => again.on('device:paired', resolve));
      again.on('connect', () => again.emit('device:register', { device_id: reg.device_id, device_token: reg.device_token }));
      const msg2 = await Promise.race([repaired, sleep(5000).then(() => null)]);
      assert.ok(msg2, 'device:paired re-sent on reconnect');
      assert.deepEqual(msg2.brand, { name: 'Workspace Brand', hidden: false });
    } finally { again.close(); }
  } finally { sock.close(); }
});
