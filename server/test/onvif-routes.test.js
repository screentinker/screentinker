'use strict';

/*
 * ONVIF over HTTP (routes/onvif.js), both ways a camera is reached:
 *   - this server directly (OUTBOUND_ALLOW_PRIVATE on, the fake camera on 127.0.0.1);
 *   - a screen relaying for the server (a fake player registered with onvif.bridge that performs
 *     each relay op itself and answers device:onvif-result, as the real players do).
 * Plus the secret handling: the camera password never comes back, the stream URL is masked.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');
const { freePort } = require('./helpers/free-port');
const { startFakeCamera } = require('./helpers/fake-onvif-camera');

let BASE, proc, db, cam;
const DATA_DIR = path.join(os.tmpdir(), 'st-onvif-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const H = (tok = S.token) => ({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' });
const post = (p, b, tok) => jfetch(p, { method: 'POST', headers: H(tok), body: JSON.stringify(b || {}) });
const get = (p, tok) => jfetch(p, { headers: H(tok) });

before(async () => {
  cam = await startFakeCamera({ ptz: true });
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', OUTBOUND_ALLOW_PRIVATE: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const reg = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'onvif@test.local', password: 'Passw0rd123' }) });
  S.token = reg.body.token;
  S.wsId = (await get('/api/auth/me')).body.accessible_workspaces[0].id;
});
after(async () => {
  try { db && db.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  await cam.close();
});

// ─── A fake player that relays (what the Android and native players do) ──────

function fakeBridgeScreen({ capabilities = ['onvif.bridge'], discoveryPort } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, created_at)
              VALUES (?, 'Lobby screen', 'online', ?, ?, 'apk', strftime('%s','now'))`).run(id, S.wsId, token);
  const ops = [];
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: id, device_token: token, capabilities }));
    s.on('device:registered', () => resolve({ id, socket: s, ops }));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    s.on('device:command', async ({ type, payload }) => {
      if (type !== 'onvif_relay') return;
      ops.push(payload.op);
      const reply = { id: payload.id, device_id: id };
      try {
        if (payload.op === 'probe') {
          reply.replies = await new Promise((done) => {
            const sock = dgram.createSocket('udp4');
            const got = [];
            sock.on('message', (m, r) => got.push({ from: r.address, xml: m.toString() }));
            sock.bind(0, () => sock.send(Buffer.from('<Probe/>'), discoveryPort, payload.host || '127.0.0.1'));
            setTimeout(() => { sock.close(); done(got); }, 400);
          });
          reply.ok = true;
        } else {
          const r = await fetch(payload.url, { method: payload.op === 'soap' ? 'POST' : 'GET', headers: payload.headers || {}, body: payload.op === 'soap' ? payload.body : undefined });
          reply.status = r.status;
          reply.headers = { 'www-authenticate': r.headers.get('www-authenticate') || undefined, 'content-type': r.headers.get('content-type') || undefined };
          if (payload.op === 'soap') reply.body = await r.text();
          else reply.body_b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
          reply.ok = r.ok;
        }
      } catch (e) { reply.ok = false; reply.error = e.message; }
      s.emit('device:onvif-result', reply);
    });
  });
}

// ─── Via this server ──────────────────────────────────────────────────────────

test('bridges: the server is offered when private networks are open', async () => {
  const r = await get('/api/onvif/bridges');
  assert.equal(r.status, 200);
  assert.equal(r.body.server, 'all');
});

test('API tokens cannot reach the ONVIF routes (JWT-only)', async () => {
  const t = await post('/api/tokens', { name: 'x', scope: 'full' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal((await get('/api/content', t.body.token)).status, 200, 'the token itself works on a public router');
  const r = await get('/api/onvif/bridges', t.body.token);
  assert.equal(r.status, 401);
});

test('inspect: a wrong camera password is a 422 (never 401: that signs the person out) with code not-authorized; the right one lists profiles with PTZ', async () => {
  const bad = await post('/api/onvif/inspect', { via: 'server', xaddr: cam.xaddr, username: 'admin', password: 'nope' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'not-authorized');
  const ok = await post('/api/onvif/inspect', { via: 'server', host: `127.0.0.1:${cam.port}`, username: 'admin', password: 'secret' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.manufacturer, 'FakeCam');
  assert.equal(ok.body.ptz, true);
  assert.deepEqual(ok.body.profiles.map((p) => p.token), ['main', 'sub']);
});

test('add a camera: a video/rtsp item with a snapshot thumbnail; the password never comes back', async () => {
  const r = await post('/api/onvif/cameras', { via: 'server', xaddr: cam.xaddr, username: 'admin', password: 'secret', profile_token: 'main', name: 'Front door' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.camId = r.body.id;
  assert.equal(r.body.mime_type, 'video/rtsp');
  assert.equal(r.body.filename, 'Front door');
  assert.equal(r.body.onvif_secret, undefined, 'never sent');
  assert.match(r.body.remote_url, /^rtsp:\/\/admin:\*{8}@127\.0\.0\.1:554\/main$/, 'masked like any camera URL');
  const row = db.prepare('SELECT remote_url, onvif, onvif_secret, thumbnail_path FROM content WHERE id = ?').get(S.camId);
  assert.equal(row.remote_url, 'rtsp://admin:secret@127.0.0.1:554/main', 'the players get the real one');
  assert.ok(row.onvif_secret && !row.onvif_secret.includes('secret'), 'stored encrypted');
  assert.equal(JSON.parse(row.onvif).ptz, true);
  assert.ok(!/secret/.test(row.onvif), 'the password is not in the settings');
  assert.match(row.thumbnail_path, /^onvif-.+\.jpg$/);
  const thumb = await fetch(`${BASE}/api/content/${S.camId}/thumbnail`, { headers: H() });
  assert.equal(thumb.status, 200);
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), cam.jpeg);
  // The library listing and the item itself, too.
  const one = await get(`/api/content/${S.camId}`);
  assert.equal(one.body.onvif_secret, undefined);
  const info = await get(`/api/onvif/cameras/${S.camId}`);
  assert.deepEqual({ ...info.body }, { xaddr: cam.xaddr, username: 'admin', has_password: true, profile_token: 'main', profile_name: 'Main stream', ptz: true, via: 'server', manufacturer: 'FakeCam', model: 'FC-1' });
});

test('PTZ: presets, move, stop, preset, home reach the camera; bad actions are refused', async () => {
  const pre = await get(`/api/onvif/cameras/${S.camId}/presets`);
  assert.deepEqual(pre.body.presets.map((p) => p.name), ['Door', 'Car park']);
  cam.ptzLog.length = 0;
  for (const b of [{ action: 'move', pan: 0.5, tilt: 0, zoom: 0 }, { action: 'stop' }, { action: 'preset', preset: '1' }, { action: 'home' }]) {
    const r = await post(`/api/onvif/cameras/${S.camId}/ptz`, b);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.deepEqual(cam.ptzLog.map((x) => x.op), ['ContinuousMove', 'Stop', 'GotoPreset', 'GotoHomePosition']);
  assert.equal((await post(`/api/onvif/cameras/${S.camId}/ptz`, { action: 'spin' })).status, 400);
  assert.equal((await post(`/api/onvif/cameras/${S.camId}/ptz`, { action: 'preset' })).status, 400);
});

test('refresh: re-asks the stream address with the stored password, or a new one', async () => {
  const r = await post(`/api/onvif/cameras/${S.camId}/refresh`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bad = await post(`/api/onvif/cameras/${S.camId}/refresh`, { password: 'wrong' });
  assert.equal(bad.status, 422);
  assert.equal(db.prepare('SELECT remote_url FROM content WHERE id = ?').get(S.camId).remote_url, 'rtsp://admin:secret@127.0.0.1:554/main', 'a failed refresh changes nothing');
  const snap = await post(`/api/onvif/cameras/${S.camId}/snapshot`, {});
  assert.equal(snap.status, 200);
});

// ─── Via a screen ─────────────────────────────────────────────────────────────

test('a screen relays: discovery, add, PTZ all go through it', async (t) => {
  const screen = await fakeBridgeScreen({ discoveryPort: cam.discoveryPort });
  t.after(() => screen.socket.close());
  const bridges = await get('/api/onvif/bridges');
  assert.ok(bridges.body.screens.some((s) => s.id === screen.id && s.online), 'offered as a bridge');

  const found = await post('/api/onvif/discover', { via: screen.id, host: '127.0.0.1' });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.body.cameras[0].name, 'Lobby Cam');

  const added = await post('/api/onvif/cameras', { via: screen.id, xaddr: found.body.cameras[0].xaddr, username: 'admin', password: 'secret', profile_token: 'sub' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  cam.ptzLog.length = 0;
  assert.equal((await post(`/api/onvif/cameras/${added.body.id}/ptz`, { action: 'stop' })).status, 409, 'the sub stream has no PTZ');
  assert.ok(screen.ops.includes('probe') && screen.ops.includes('soap') && screen.ops.includes('get'), 'every op went through the screen');
});

test('a screen without onvif.bridge, an offline one, and another workspace\'s are refused', async (t) => {
  const old = await fakeBridgeScreen({ capabilities: ['playback.video'] });
  t.after(() => old.socket.close());
  const r = await post('/api/onvif/discover', { via: old.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'screen-unsupported');

  const offId = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, capabilities, created_at)
              VALUES (?, 'Off', 'offline', ?, 'x', 'apk', '["onvif.bridge"]', strftime('%s','now'))`).run(offId, S.wsId);
  const off = await post('/api/onvif/discover', { via: offId });
  assert.equal(off.status, 503);
  assert.equal(off.body.code, 'screen-offline');

  const reg2 = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'other@test.local', password: 'Passw0rd123' }) });
  const other = await post('/api/onvif/discover', { via: old.id }, reg2.body.token);
  assert.equal(other.status, 404, 'not visible from another workspace');
  const steal = await get(`/api/onvif/cameras/${S.camId}`, reg2.body.token);
  assert.equal(steal.status, 403);
});

test('onvif_relay is not a command anyone can send through the REST API', async (t) => {
  const screen = await fakeBridgeScreen({ discoveryPort: cam.discoveryPort });
  t.after(() => screen.socket.close());
  const r = await post(`/api/devices/${screen.id}/command`, { type: 'onvif_relay', payload: { op: 'soap', url: 'http://10.0.0.1/' } });
  assert.equal(r.status, 400);
  assert.equal(screen.ops.length, 0);
});
