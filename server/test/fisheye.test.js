'use strict';

// Fisheye cameras shown as a normal view ("digital PTZ", lib/fisheye.js): the shared maths (the
// vectors the Android and native players are held to), the item setting through the content API, the
// snapshot field (sent only when set, on a live item), and the live camera_view command.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');
const F = require('../lib/fisheye');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'fisheye-vectors.json'), 'utf8'));

// ------------------------------------------------------------------ maths (pure)

test('the projection matches the shared vectors the players are tested against', () => {
  for (const c of VEC.project) {
    const p = F.project(c.normalized, c.x, c.y, c.image_aspect);
    if (c.uv === null) { assert.equal(p, null, JSON.stringify(c)); continue; }
    assert.ok(Math.abs(p.u - c.uv[0]) < 1e-6 && Math.abs(p.v - c.uv[1]) < 1e-6, JSON.stringify(c));
  }
  for (const c of VEC.normalize) assert.deepEqual(F.normalize(c.input), c.output);
});

test('⚠️ the picture is always upright: a level horizon, never mirrored, never flipped over the top', () => {
  for (const mount of F.MOUNTS) {
    for (let pan = -180; pan <= 180; pan += 30) {
      for (const tilt of [-80, -30, 0, 30, 60, 89, 150]) {
        const f = F.normalize({ mount, pan, tilt });
        const [lo, hi] = F.tiltRange(mount, f.lens_fov);
        assert.ok(f.tilt >= lo && f.tilt <= hi, 'tilt is clamped');
        const { d, right, up } = F.basis(f);
        if (mount === 'wall') assert.ok(Math.abs(right[1]) < 1e-9, 'a wall view keeps image-up as up');
        else assert.ok(Math.abs(right[2]) < 1e-9, 'a ceiling/floor view keeps the horizon level');
        const down = up.map((v) => -v);
        const rxd = [right[1] * down[2] - right[2] * down[1], right[2] * down[0] - right[0] * down[2], right[0] * down[1] - right[1] * down[0]];
        rxd.forEach((v, i) => assert.ok(Math.abs(v - d[i]) < 1e-9, 'not mirrored'));
      }
    }
  }
});

test('settings are normalized: junk becomes defaults, touch is off unless asked for', () => {
  assert.equal(F.normalize(null), null);
  assert.equal(F.normalize('not json'), null);
  assert.equal(F.normalize({}).touch, false);
  assert.equal(F.normalize({ touch: true }).touch, true);
  assert.deepEqual(F.normalize(JSON.stringify({ pan: 10 })), F.normalize({ pan: 10 }));
});

// ------------------------------------------------------------------ the item and the command (server)

let PORT, BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-fisheye-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};
async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body, text };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await jfetch('/api/auth/register', post(null, { email: 'f' + crypto.randomBytes(4).toString('hex') + '@x.local', password: 'Passw0rd123' }));
  S.jwt = reg.body.token;
});

after(() => {
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('a camera stores normalized fisheye settings; null turns them off; finite media is refused', async () => {
  const cam = await jfetch('/api/content/hls', post(S.jwt, { url: 'rtsps://10.0.0.7:7441/cam', fisheye: { pan: 400, touch: true } }));
  assert.equal(cam.status, 201, cam.text);
  S.cam = cam.body.id;
  assert.deepEqual(JSON.parse(cam.body.fisheye), F.normalize({ pan: 400, touch: true }));
  const upd = await jfetch('/api/content/' + S.cam, put(S.jwt, { fisheye: { mount: 'wall', pan: 20, tilt: -10, zoom: 70 } }));
  assert.equal(upd.status, 200, upd.text);
  assert.equal(JSON.parse(upd.body.fisheye).mount, 'wall');
  const off = await jfetch('/api/content/' + S.cam, put(S.jwt, { fisheye: null }));
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.fisheye, null);
  const yt = await jfetch('/api/content/youtube', post(S.jwt, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
  if (yt.status < 300) {
    const bad = await jfetch('/api/content/' + yt.body.id, put(S.jwt, { fisheye: { pan: 1 } }));
    assert.equal(bad.status, 400, bad.text);
  }
});

test('the published snapshot carries fisheye only when it is set', async () => {
  await jfetch('/api/content/' + S.cam, put(S.jwt, { fisheye: { pan: 90, tilt: 40, zoom: 60 } }));
  const plain = await jfetch('/api/content/hls', post(S.jwt, { url: 'rtsp://10.0.0.8/plain' }));
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'fish' }));
  await jfetch(`/api/playlists/${pl.body.id}/items`, post(S.jwt, { content_id: S.cam, duration_sec: 0 }));
  await jfetch(`/api/playlists/${pl.body.id}/items`, post(S.jwt, { content_id: plain.body.id, duration_sec: 0 }));
  const pub = await jfetch(`/api/playlists/${pl.body.id}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200, pub.text);
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { readonly: true });
  try {
    const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl.body.id).published_snapshot);
    const items = Array.isArray(snap) ? snap : snap.items;
    const fish = items.find((i) => i.content_id === S.cam);
    const other = items.find((i) => i.content_id === plain.body.id);
    assert.deepEqual(fish.fisheye, F.normalize({ pan: 90, tilt: 40, zoom: 60 }), 'an object, ready for the player');
    assert.ok(!('fisheye' in other), 'absent on an item without it (byte-identical snapshots)');
  } finally { db.close(); }
});

test('camera_view is validated, gated on playback.fisheye, and never queued', () => {
  const dc = require('../lib/device-command');
  assert.ok(dc.ALLOWED_COMMANDS.includes('camera_view'));
  assert.equal(dc.validateCommand('camera_view', {}).ok, false);
  assert.equal(dc.validateCommand('camera_view', { content_id: 'c', pan: 'x' }).ok, false);
  assert.equal(dc.validateCommand('camera_view', { content_id: 'c', pan: 10, tilt: 40, zoom: 60 }).ok, true);
  assert.equal(dc.validateCommand('camera_view', { content_id: 'c', reset: true }).ok, true);
  const caps = require('../lib/player-capabilities');
  assert.equal(caps.COMMAND_CAPABILITY.camera_view, 'playback.fisheye');
  for (const [platform, list] of Object.entries(caps.BASELINE)) assert.ok(!list.includes('playback.fisheye'), platform);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'device-command.js'), 'utf8');
  assert.match(src, /if \(type === 'camera_view'\) return \{ status: 'offline' \};/, 'an offline screen is told offline, not sent a stale view later');
});

test('applying a layout to a screen pushes it to the screen (it used to wait for a reconnect)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'layouts.js'), 'utf8');
  const i = src.indexOf("router.put('/device/:deviceId'");
  const block = src.slice(i, src.indexOf('module.exports', i));
  assert.match(block, /queueOrEmitPlaylistUpdate\(io\.of\('\/device'\), req\.params\.deviceId, buildPlaylistPayload\)/);
});

test('a saved view reaches the screens without a republish: read at send time, pushed on save', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(ds, /width, height, video_prerotated, fisheye\n\s+FROM content WHERE id = \?/);
  assert.match(ds, /if \(fisheye\) a\.fisheye = fisheye; else delete a\.fisheye;/);
  const cr = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8');
  assert.match(cr, /if \(prerotatedChanged \|\| fisheye !== undefined\) \{/);
});
