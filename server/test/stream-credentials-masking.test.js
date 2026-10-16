'use strict';

// Camera passwords are write-only. An rtsp(s) item's password is stored (the screen needs it) but
// every JSON response replaces it with the mask: the add reply, the library list, the item, the
// playlist editor. An edit that sends the mask back keeps the stored password for the SAME camera
// only, a new camera address with the mask is refused (or an editor could point the stream at their
// own host and receive the password from the screen), and a name derived from the URL never carries
// the userinfo. A request authenticated by a device token is the screen itself and is not masked.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');
const { CREDENTIAL_MASK } = require('../lib/remote-url');

let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-credmask-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};
const SECRET = 'S3cr3t-camera-pw';

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });
const stored = (id) => db.prepare('SELECT remote_url, filename, tls_self_signed FROM content WHERE id = ?').get(id);

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
  const reg = await jfetch('/api/auth/register', post(null, { email: 'm' + crypto.randomBytes(4).toString('hex') + '@x.local', password: 'Passw0rd123' }));
  S.jwt = reg.body.token;
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
});

after(() => {
  try { db?.close(); } catch { /* */ }
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('adding an rtsps camera stores the password but answers with it masked', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: `rtsps://viewer:${SECRET}@10.0.0.5:7441/AbCdEf`, tls_self_signed: true }));
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.mime_type, 'video/rtsp');
  assert.equal(r.body.remote_url, `rtsps://viewer:${CREDENTIAL_MASK}@10.0.0.5:7441/AbCdEf`);
  assert.ok(!r.text.includes(SECRET), 'the password is nowhere in the reply');
  assert.equal(r.body.filename, 'AbCdEf');
  S.cam = r.body.id;
  const row = stored(S.cam);
  assert.equal(row.remote_url, `rtsps://viewer:${SECRET}@10.0.0.5:7441/AbCdEf`, 'the screen still needs the real one');
  assert.equal(row.tls_self_signed, 1);
});

test('a camera added without a name is named from the host, never the userinfo', async () => {
  const r = await jfetch('/api/content/hls', post(S.jwt, { url: `rtsp://admin:${SECRET}@192.168.1.20` }));
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.filename, '192.168.1.20');
  assert.ok(!r.text.includes(SECRET));
  S.cam2 = r.body.id;
});

test('the library list and the item itself never show the password', async () => {
  const list = await jfetch('/api/content', auth(S.jwt));
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(SECRET), 'list leaks the camera password');
  assert.ok(list.text.includes(CREDENTIAL_MASK));
  const one = await jfetch('/api/content/' + S.cam, auth(S.jwt));
  assert.equal(one.status, 200);
  assert.ok(!one.text.includes(SECRET));
});

test('the playlist editor shows the item masked too', async () => {
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'cams' }));
  const add = await jfetch(`/api/playlists/${pl.body.id}/items`, post(S.jwt, { content_id: S.cam, duration_sec: 30 }));
  assert.ok(add.status < 300, add.text);
  await jfetch(`/api/playlists/${pl.body.id}/publish`, post(S.jwt, {}));
  const got = await jfetch('/api/playlists/' + pl.body.id, auth(S.jwt));
  assert.equal(got.status, 200);
  assert.ok(got.text.includes('10.0.0.5'), 'the item is there');
  assert.ok(!got.text.includes(SECRET), 'playlist response leaks the camera password');
  const snap = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl.body.id).published_snapshot;
  assert.ok(snap.includes(SECRET), 'the published snapshot keeps the real URL for the screens');
  assert.match(snap, /"tls_self_signed":1/, 'and the flag');
});

test('an edit that keeps the mask on the same camera keeps the stored password', async () => {
  const r = await jfetch('/api/content/' + S.cam, put(S.jwt, { remote_url: `rtsps://viewer:${CREDENTIAL_MASK}@10.0.0.5:7441/NewPath` }));
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes(SECRET));
  assert.equal(stored(S.cam).remote_url, `rtsps://viewer:${SECRET}@10.0.0.5:7441/NewPath`);
});

test('the mask with a different host is refused (no sending the password elsewhere)', async () => {
  const r = await jfetch('/api/content/' + S.cam, put(S.jwt, { remote_url: `rtsps://viewer:${CREDENTIAL_MASK}@203.0.113.9:7441/NewPath` }));
  assert.equal(r.status, 400, r.text);
  assert.equal(stored(S.cam).remote_url, `rtsps://viewer:${SECRET}@10.0.0.5:7441/NewPath`, 'unchanged');
  const port = await jfetch('/api/content/' + S.cam, put(S.jwt, { remote_url: `rtsps://viewer:${CREDENTIAL_MASK}@10.0.0.5:9999/NewPath` }));
  assert.equal(port.status, 400, 'a different port is a different service');
  const scheme = await jfetch('/api/content/' + S.cam, put(S.jwt, { remote_url: `rtsp://viewer:${CREDENTIAL_MASK}@10.0.0.5:7441/NewPath` }));
  assert.equal(scheme.status, 400, 'downgrading to plain rtsp with the saved password is refused');
});

test('a new password typed in replaces the stored one', async () => {
  const r = await jfetch('/api/content/' + S.cam, put(S.jwt, { remote_url: 'rtsps://viewer:another@10.0.0.5:7441/NewPath' }));
  assert.equal(r.status, 200, r.text);
  assert.equal(stored(S.cam).remote_url, 'rtsps://viewer:another@10.0.0.5:7441/NewPath');
  assert.ok(!r.text.includes('another'), 'even a just-typed password is masked in the reply');
});

test('tls_self_signed toggles on a camera and is refused on anything else', async () => {
  const off = await jfetch('/api/content/' + S.cam, put(S.jwt, { tls_self_signed: false }));
  assert.equal(off.status, 200, off.text);
  assert.equal(stored(S.cam).tls_self_signed, 0);
  const hls = await jfetch('/api/content/hls', post(S.jwt, { url: 'http://10.0.0.9/live.m3u8' }));
  const bad = await jfetch('/api/content/' + hls.body.id, put(S.jwt, { tls_self_signed: true }));
  assert.equal(bad.status, 400, bad.text);
});

test('the middleware leaves a device-token request (the screen itself) unmasked', () => {
  const { maskStreamCredentialsMiddleware } = require('../middleware/mask-stream-credentials');
  const run = (req) => {
    let sent = null;
    const res = {
      json(b) { sent = JSON.stringify(b); return this; },
      get() { return undefined; }, set() { return this; }, send(t) { sent = t; return this; },
    };
    maskStreamCredentialsMiddleware(req, res, () => {});
    res.json({ remote_url: `rtsp://a:${SECRET}@h/x` });
    return sent;
  };
  assert.ok(run({ device: { id: 'd1' }, app: null }).includes(SECRET), 'the screen gets the real URL');
  assert.ok(!run({ app: null }).includes(SECRET), 'everyone else gets the mask');
});
