'use strict';
// GET /api/devices/:id/live and its signaling proxy. What must hold with NO go2rtc running:
//   - live is off unless the master gate + workspace flag + device flag are all set
//   - it always answers with a usable descriptor (mode: 'snapshot') rather than an error, so the
//     Devices page never breaks
//   - the WebRTC proxy refuses a stream that is not this device's, and refuses when disabled
//   - another workspace cannot read this device's live descriptor at all
// The webrtc:'webrtc' branch (a healthy sidecar with a live publisher) needs a real go2rtc and is a
// documented manual step; here go2rtc is absent, so the honest answer is always snapshot.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-live-'));
const LOG = path.join(DATA_DIR, 'srv.log');
let proc, BASE, db, A = {}, B = {};

const freePort = () => new Promise((r) => { const s = require('net').createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const jfetch = async (u, o = {}) => { const res = await fetch(BASE + u, o); let b = null; try { b = await res.json(); } catch {} return { status: res.status, body: b, res }; };
const auth = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const fd = fs.openSync(LOG, 'w');
  // LIVE_VIDEO_ENABLED on (server master gate), but GO2RTC_URL unset — so the honest answer is
  // always snapshot, and we are testing the gating and safety, not the media flow.
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', LIVE_VIDEO_ENABLED: 'true', GO2RTC_URL: '' }, stdio: ['ignore', fd, fd] });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const tenant = async (email, ip) => {
    const reg = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: 'Passw0rd123' }) });
    const me = await jfetch('/api/auth/me', { headers: auth(reg.body.token) });
    return { token: reg.body.token, wsId: me.body.accessible_workspaces[0].id };
  };
  await tenant('owner-live@x.io', '203.0.113.9');   // burn the platform-admin first account
  Object.assign(A, await tenant('a-live@x.io', '203.0.113.1'));
  Object.assign(B, await tenant('b-live@x.io', '203.0.113.2'));
  A.dev = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,status,workspace_id,created_at) VALUES (?,?,'online',?,strftime('%s','now'))").run(A.dev, 'Lobby', A.wsId);
});
after(() => { try { db && db.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} });

const live = (tok, id) => jfetch(`/api/devices/${id}/live`, { headers: auth(tok) });

test('live is OFF until all three gates are set, and the answer is always a usable descriptor', async () => {
  let r = await live(A.token, A.dev);
  assert.equal(r.status, 200); assert.equal(r.body.mode, 'snapshot'); assert.equal(r.body.reason, 'disabled');
  db.prepare('UPDATE workspaces SET live_video_enabled = 1 WHERE id = ?').run(A.wsId);
  r = await live(A.token, A.dev);
  assert.equal(r.body.mode, 'snapshot', 'workspace on but device still off'); assert.equal(r.body.reason, 'disabled');
  db.prepare('UPDATE devices SET live_video_enabled = 1 WHERE id = ?').run(A.dev);
  r = await live(A.token, A.dev);
  // All three on, but GO2RTC_URL is unset, so: no sidecar. Still snapshot, never an error.
  assert.equal(r.body.mode, 'snapshot'); assert.equal(r.body.reason, 'no_sidecar'); assert.equal(r.body.fallback, 'snapshot');
});

test('another workspace cannot read this device\'s live descriptor', async () => {
  const r = await live(B.token, A.dev);
  assert.equal(r.status, 403);
});

test('the signaling proxy refuses when live video is unavailable, without a sidecar to reach', async () => {
  const r = await jfetch(`/api/devices/${A.dev}/live/webrtc`, { method: 'POST', headers: { ...auth(A.token), 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  // All gates on but no GO2RTC_URL -> not available (409), never a proxy attempt.
  assert.equal(r.status, 409);
});

test('the signaling proxy is workspace-gated like the descriptor', async () => {
  const r = await jfetch(`/api/devices/${A.dev}/live/webrtc`, { method: 'POST', headers: { ...auth(B.token), 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  assert.equal(r.status, 403);
});

test('a missing device is 404, not a crash', async () => {
  const r = await live(A.token, 'does-not-exist');
  assert.equal(r.status, 404);
});

// ── Publish endpoint (web player -> go2rtc). Device-authenticated (device_token), app-level, and
// fail-soft: with no GO2RTC_URL it refuses with 409 rather than attempting anything.
const sdpBody = (tok, id, token) => jfetch(
  `/api/devices/${id}/live/publish${token ? '?token=' + encodeURIComponent(token) : ''}`,
  { method: 'POST', headers: { 'Content-Type': 'application/sdp', ...(tok ? { 'X-Device-Token': tok } : {}) }, body: 'v=0\r\n' }
);

test('publish rejects a bad or missing device token with 401', async () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,status,workspace_id,device_token,created_at) VALUES (?,?,'online',?,?,strftime('%s','now'))").run(id, 'Pub', A.wsId, 'realtoken123');
  let r = await sdpBody(null, id);                 // no token
  assert.equal(r.status, 401);
  r = await sdpBody('wrongtoken', id);             // wrong token
  assert.equal(r.status, 401);
});

test('publish with a valid token but no sidecar refuses with 409 (never a crash)', async () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,status,workspace_id,device_token,live_video_enabled,created_at) VALUES (?,?,'online',?,?,1,strftime('%s','now'))").run(id, 'Pub2', A.wsId, 'tok-abc');
  db.prepare('UPDATE workspaces SET live_video_enabled = 1 WHERE id = ?').run(A.wsId);
  // device flag on, workspace flag on, master gate on — but GO2RTC_URL is '' so go2rtc is disabled.
  const r = await sdpBody('tok-abc', id, 'tok-abc');
  assert.equal(r.status, 409);
});

test('publish token gate accepts the query-param form too', async () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,status,workspace_id,device_token,created_at) VALUES (?,?,'online',?,?,strftime('%s','now'))").run(id, 'Pub3', A.wsId, 'qtok');
  // Correct token via ?token= but live disabled for this device -> 409 (auth passed, gate failed).
  const r = await sdpBody(null, id, 'qtok');
  assert.equal(r.status, 409);
});

test('publish for a token that matches no device is 401, not 404 (no id oracle)', async () => {
  const r = await sdpBody('whatever', crypto.randomUUID(), 'whatever');
  assert.equal(r.status, 401);
});
