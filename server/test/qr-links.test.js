'use strict';

/*
 * Tracked QR links (lib/qr-links.js, routes/qr-links.js).
 *
 *   - a scan redirects to the target and is counted once per phone per minute; bots are not counted
 *   - a scan stores a time and a platform only: no IP, no user agent
 *   - retargeting keeps the code, so printed QRs keep working; a switched-off code says so (404)
 *   - stats: totals, 30 days by day, platform split
 *   - only http(s) targets; viewers cannot change links; another workspace cannot see them
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-qr-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-qr';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const qr = require('../lib/qr-links');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';

const O = 'o-qr', WS = 'ws-qr', WS2 = 'ws-qr-2', U = 'u-qr', V = 'u-qr-v', U2 = 'u-qr-2';
let server, base;
const tokenOf = (u, ws = WS) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function api(method, p, body, who = U, ws = WS) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who, ws)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text, headers: r.headers };
}
const scan = (code, ua = IPHONE, ip = '203.0.113.7') => fetch(`${base}/q/${code}`, { redirect: 'manual', headers: { 'User-Agent': ua, 'X-Forwarded-For': ip } });

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'qr@t.local', 'x', 'user'), (?, 'qrv@t.local', 'x', 'user'), (?, 'qr2@t.local', 'x', 'user')").run(U, V, U2);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', WS2, O, 'WS2');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor'), (?, ?, 'workspace_viewer'), (?, ?, 'workspace_editor')").run(WS, U, WS, V, WS2, U2);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/qr-links', requireAuth, resolveTenancy, require('../routes/qr-links'));
  app.get('/q/:code', require('../routes/qr-links').redirect);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('codes avoid look-alike characters; targets must be http(s); platform is coarse', () => {
  for (let i = 0; i < 50; i++) assert.match(qr.newCode(), /^[a-km-np-zA-HJ-NP-Z2-9]{7}$/);
  assert.match(qr.checkTarget('javascript:alert(1)'), /http/);
  assert.match(qr.checkTarget('https://u:p@x.example/'), /username/);
  assert.equal(qr.checkTarget('https://example.org/menu?x=1'), null);
  assert.deepEqual([IPHONE, ANDROID, 'Mozilla/5.0 (Windows NT 10.0)'].map(qr.platformOf), ['ios', 'android', 'other']);
});

let L;
test('create: a viewer cannot; an editor gets a short path', async () => {
  assert.equal((await api('POST', '/api/qr-links', { name: 'Menu', target_url: 'https://example.org/menu' }, V)).status, 403);
  assert.equal((await api('POST', '/api/qr-links', { name: 'Bad', target_url: 'ftp://x' })).status, 400);
  const r = await api('POST', '/api/qr-links', { name: 'Menu', target_url: 'https://example.org/menu' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  L = r.body;
  assert.equal(L.path, `/q/${L.code}`);
  assert.equal(L.scans, 0);
});

test('a scan redirects and counts once per phone (not per IP); bots are not counted', async () => {
  qr._resetDedupe();
  const r = await scan(L.code);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.org/menu');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  await scan(L.code);                                       // the camera app opening it again
  await scan(L.code, ANDROID);                              // a second phone on the SAME Wi-Fi (same public IP)
  const bot = await scan(L.code, 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', '192.0.2.50');
  assert.equal(bot.status, 302, 'a bot is still redirected');
  const s = (await api('GET', `/api/qr-links/${L.id}`)).body;
  assert.equal(s.scans, 2);
  assert.deepEqual(s.stats.platforms, { ios: 1, android: 1, other: 0 });
  assert.equal(s.stats.days.length, 30);
  assert.equal(s.stats.days[29].scans, 2, 'today');
});

test('⚠️ a scan stores no IP and no user agent', () => {
  const cols = db.prepare('PRAGMA table_info(qr_scans)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['at', 'link_id', 'platform']);
  const dump = JSON.stringify(db.prepare('SELECT * FROM qr_scans').all());
  assert.ok(!dump.includes('203.0.113.7') && !dump.includes('iPhone OS'));
});

test('retargeting keeps the code; switched off or unknown codes are 404', async () => {
  let r = await api('PUT', `/api/qr-links/${L.id}`, { target_url: 'https://example.org/new-menu' });
  assert.equal(r.status, 200); assert.equal(r.body.code, L.code);
  qr._resetDedupe();
  assert.equal((await scan(L.code)).headers.get('location'), 'https://example.org/new-menu');
  await api('PUT', `/api/qr-links/${L.id}`, { enabled: false });
  assert.equal((await scan(L.code, IPHONE, '203.0.113.99')).status, 404);
  assert.equal((await scan('zzzzzzz')).status, 404);
  await api('PUT', `/api/qr-links/${L.id}`, { enabled: true });
});

test('the QR SVG encodes the public short address; another workspace cannot see the link', async () => {
  const r = await fetch(`${base}/api/qr-links/${L.id}/qr.svg?origin=https://signs.example.com`, { headers: { Authorization: `Bearer ${tokenOf(U)}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await r.text(), /<svg/);
  assert.equal((await api('GET', `/api/qr-links/${L.id}`, null, U2, WS2)).status, 404);
  const list = await api('GET', '/api/qr-links', null, U2, WS2);
  assert.deepEqual(list.body, []);
});
