'use strict';

// GHSA-rvxj 10.1: the device-owner QR tells a factory-fresh panel which server to enrol against and
// where to fetch its device-owner APK. With APP_URL unset it was built from the request's Host
// header, so a forged Host produced a QR for someone else's server. It now uses publicOrigin()
// (lib/public-origin.js) like the emailed links, and needs write access to the workspace (the
// dashboard offers it from Add Display, an editor action), so a viewer is refused.
// Boots a HOSTED server (no SELF_HOSTED, no APP_URL, no PUBLIC_HOSTS): the case the Host was trusted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc, db, OWNER, VIEWER, WS;
const DATA_DIR = path.join(os.tmpdir(), 'st-doqr-origin-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const register = async (email) => (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test12345', name: email.split('@')[0] }) })).json());

// fetch() won't let a caller set Host, so a raw request.
function getQr(token, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/provision/device-owner-qr', method: 'GET',
      headers: { Authorization: 'Bearer ' + token, ...headers } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); req.end();
  });
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  const env = { ...process.env, DATA_DIR, PORT: String(PORT), NODE_ENV: 'test' };
  delete env.SELF_HOSTED; delete env.APP_URL; delete env.PUBLIC_HOSTS;
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const owner = await register('owner@doqr.local');
  const viewer = await register('viewer@doqr.local');
  assert.ok(owner.token && viewer.token, 'registered');
  OWNER = owner.token; VIEWER = viewer.token;
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  // A plain user, not the platform owner, so the workspace role is what decides.
  db.prepare("UPDATE users SET role = 'user' WHERE id IN (?, ?)").run(owner.user.id, viewer.user.id);
  WS = db.prepare('SELECT w.id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE o.owner_user_id = ? LIMIT 1').get(owner.user.id).id;
  db.prepare("INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(WS, viewer.user.id);
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { db.close(); } catch { /* */ } try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('a forged Host header does not become the QR\'s server_url or APK location', async () => {
  const r = await getQr(OWNER, { Host: 'evil.example', 'x-workspace-id': WS });
  assert.equal(r.status, 200);
  const extras = r.json.payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
  assert.doesNotMatch(extras.server_url, /evil\.example/);
  assert.doesNotMatch(r.json.apk_url, /evil\.example/);
  assert.match(extras.server_url, /^http:\/\/localhost:\d+$/, 'falls back to this server, as emailed links do');
});

test('the address the server was reached on is still used when it is loopback', async () => {
  const r = await getQr(OWNER, { 'x-workspace-id': WS });
  assert.equal(r.status, 200);
  assert.equal(r.json.payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].server_url, `http://127.0.0.1:${PORT}`);
});

test('a workspace viewer cannot generate a provisioning QR', async () => {
  const r = await getQr(VIEWER, { 'x-workspace-id': WS });
  assert.equal(r.status, 403);
});
