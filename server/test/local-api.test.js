'use strict';

/*
 * The INBOUND local REST door — the enablement half (Goal B part 3).
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. The trigger feature shipped its definitions and its player code
 * complete and INERT: nothing wrote trigger_secret or the accept flags, so the secret was always
 * NULL, the resolver answered bad_secret to everything, and no listener ever bound. It looked
 * finished. A QA pass found a system that could not be switched on. These tests assert the switch.
 *
 * The assertions that matter here are the ones about what CANNOT happen:
 *   - the secret must never reach an API token, and never appear in a device list
 *   - enabling without a secret must be refused at the door, not left for the panel to fail quietly
 *   - the flag and the secret must be SEPARATE from the trigger ones, sharing a socket but not a
 *     permission — a site that wanted an emergency overlay must not thereby get remote control
 *   - the flag must ride every payload, so DISABLING takes effect
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-lapi-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, deviceId, dbFile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const H = (tok = jwt) => ({ headers: { Authorization: `Bearer ${tok}` } });
const dev = (p) => `${BASE}/api/devices/${deviceId}${p}`;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `lapi${Date.now()}@example.com`, password: 'Passw0rd123', name: 'LAPI',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  const Database = require('better-sqlite3');
  dbFile = path.join(DATA_DIR, 'db', 'remote_display.db');
  const raw = new Database(dbFile);
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby 1', workspaceId, 'offline');
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const row = () => {
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile, { readonly: true });
  try { return raw.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId); }
  finally { raw.close(); }
};

/* ------------------------------------------------------------------ the switch */

test('⚠️ enabling without a secret is refused AT THE DOOR', async () => {
  const r = await fetch(dev('/local-api'), J(jwt, { enabled: true }));
  assert.equal(r.status, 400);
  const b = await r.json();
  // The message has to name the fix. The panel would refuse every request with
  // 503 no_secret_configured, but an operator who ticked a box and walked away believes it is on.
  assert.match(b.error, /local-api-secret/);
  assert.equal(row().local_api_enabled, 0);
});

test('a secret can be set, and then the door can be opened', async () => {
  const s = await (await fetch(dev('/local-api-secret'), J(jwt, { rotate: true }))).json();
  assert.equal(s.success, true);
  assert.match(s.secret, /^[0-9a-f]{48}$/);          // 24 bytes hex — more than the trigger secret

  const e = await (await fetch(dev('/local-api'), J(jwt, { enabled: true }))).json();
  assert.equal(e.success, true);
  assert.equal(e.local_api.enabled, true);
  assert.equal(e.local_api.secret_set, true);
  assert.equal(row().local_api_enabled, 1);

  // The response names the command set, so an integrator is not guessing what the door accepts.
  assert.deepEqual(e.local_api.commands.sort(),
    ['refresh', 'screen_off', 'screen_on', 'set_brightness', 'set_system_brightness', 'set_volume']);
  // ...and the port, because it is the TRIGGER port. Two doors, one socket.
  assert.equal(e.local_api.port, 8079);
});

test('a short secret is refused; the floor is offline-guessability, not policy', async () => {
  const r = await fetch(dev('/local-api-secret'), J(jwt, { secret: 'short' }));
  assert.equal(r.status, 400);
  const r2 = await fetch(dev('/local-api-secret'), J(jwt, { secret: 'has a space in it and is long enough' }));
  assert.equal(r2.status, 400);
});

test('it can be turned back OFF, which is the half that is usually missing', async () => {
  await fetch(dev('/local-api'), J(jwt, { enabled: true }));
  const e = await (await fetch(dev('/local-api'), J(jwt, { enabled: false }))).json();
  assert.equal(e.local_api.enabled, false);
  assert.equal(row().local_api_enabled, 0);
  // Re-enable for the payload test below; the secret is still set, so this must succeed.
  await fetch(dev('/local-api'), J(jwt, { enabled: true }));
});

/* ------------------------------------------------------------------ secrecy */

test('⚠️ the secret never appears in the device list', async () => {
  const list = await (await fetch(BASE + '/api/devices', H())).json();
  const blob = JSON.stringify(list);
  assert.ok(!blob.includes(row().local_api_secret), 'the local API secret escaped into the list');
  const arr = Array.isArray(list) ? list : list.devices;
  assert.equal(arr.find((d) => d.id === deviceId).local_api_secret, undefined);
});

test('⚠️ the secret never reaches an API token, even a full-scope one', async () => {
  const t = await (await fetch(BASE + '/api/tokens', J(jwt, { name: 'ci', scope: 'full' }))).json();
  const token = t.token || (t.api_token && t.api_token.token);
  assert.ok(token, 'no token issued: ' + JSON.stringify(t));

  // Detail: the endpoint with no scope gate, which is where the enrol-key version of this bug lived.
  const d = await (await fetch(`${BASE}/api/devices/${deviceId}`, H(token))).json();
  const device = d.device || d;
  assert.equal(device.local_api_secret, undefined);
  assert.equal(device.trigger_secret, undefined);

  // And rotation through a token says so rather than handing the value over.
  const rot = await (await fetch(dev('/local-api-secret'), J(token, { rotate: true }))).json();
  assert.equal(rot.secret, undefined);
  assert.equal(rot.secret_set, true);
  assert.match(rot.note, /not returned to API tokens/);
});

/* ------------------------------------------------------- separate from triggers */

test('⚠️ the trigger flag and the local-api flag are INDEPENDENT', async () => {
  // Triggers off, control API on: the site that wants remote control but no overlays.
  await fetch(dev('/trigger-config'), J(jwt, { accept_http: false, accept_udp: false }));
  await fetch(dev('/local-api'), J(jwt, { enabled: true }));
  let r = row();
  assert.equal(r.triggers_accept_http, 0);
  assert.equal(r.local_api_enabled, 1);

  // And the reverse: the emergency-overlay site that must NOT get remote control thrown in.
  await fetch(dev('/local-api'), J(jwt, { enabled: false }));
  await fetch(dev('/trigger-config'), J(jwt, { accept_http: true }));
  r = row();
  assert.equal(r.triggers_accept_http, 1);
  assert.equal(r.local_api_enabled, 0, 'enabling triggers must not enable the control door');
});

test('⚠️ the secrets are separate values, so revoking one does not revoke the other', async () => {
  await fetch(dev('/trigger-secret'), J(jwt, { rotate: true }));
  const before = row();
  assert.ok(before.trigger_secret && before.local_api_secret);
  assert.notEqual(before.trigger_secret, before.local_api_secret);

  await fetch(dev('/local-api-secret'), J(jwt, { rotate: true }));
  const after = row();
  assert.equal(after.trigger_secret, before.trigger_secret, 'rotating one rotated the other');
  assert.notEqual(after.local_api_secret, before.local_api_secret);
});

/* ------------------------------------------------------------------ the payload */

/*
 * ⚠️ ASSERTED ON WHAT A REAL DEVICE RECEIVES, not on an in-process buildPlaylistPayload().
 *
 * That helper is only exported once setupDeviceSocket(io) has run, so requiring it here would read
 * a different database from the one the routes just wrote — which is exactly the mistake that made
 * two earlier tests in this feature assert on an empty DB and pass for the wrong reason. A socket
 * client costs a few lines and tests the thing the panel actually gets.
 */
function registerDevice() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => resolve({ sock, id: d.device_id, token: d.device_token }));
    setTimeout(() => resolve(null), 5000);
  });
}

/** A self-provisioned device has no workspace; the routes under test are workspace-scoped. */
function claim(id) {
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile);
  try { raw.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(workspaceId, id); }
  finally { raw.close(); }
}

/**
 * Wait for a playlist-update that SATISFIES the predicate, not merely the next one.
 *
 * ⚠️ `once` was wrong and failed for the right reason: a device that has just registered already has
 * a payload in flight, so the first update to arrive after a toggle is frequently the one from
 * before it. A test that asserts on "the next payload" is a test that passes or fails on timing.
 */
function payloadWhere(sock, pred, ms = 5000) {
  return new Promise((resolve) => {
    const seen = [];
    const onUpdate = (p) => {
      seen.push(p && p.local_api);
      if (pred(p)) { cleanup(); resolve({ payload: p, seen }); }
    };
    const cleanup = () => { clearTimeout(t); sock.off('device:playlist-update', onUpdate); };
    const t = setTimeout(() => { cleanup(); resolve({ payload: null, seen }); }, ms);
    sock.on('device:playlist-update', onUpdate);
  });
}

test('⚠️ the payload carries local_api — and carries it when OFF, too', async () => {
  const d = await registerDevice();
  assert.ok(d, 'the device never registered');
  claim(d.id);
  try {
    const target = (p) => `${BASE}/api/devices/${d.id}${p}`;
    const sr = await fetch(target('/local-api-secret'), J(jwt, { rotate: true }));
    assert.equal(sr.status, 200, 'secret rotation on the socket device: ' + (await sr.text()).slice(0, 200));

    const onWait = payloadWhere(d.sock, (p) => p && p.local_api && p.local_api.enabled === true);
    const er = await fetch(target('/local-api'), J(jwt, { enabled: true }));
    const eb = await er.json();
    assert.equal(er.status, 200, 'enable: ' + JSON.stringify(eb));
    assert.equal(eb.local_api.enabled, true, 'route echo: ' + JSON.stringify(eb));
    assert.equal(eb.delivered, true, 'the push was queued, not emitted: ' + JSON.stringify(eb));
    const onResult = await onWait;
    const on = onResult.payload;
    assert.ok(on, 'no payload with local_api.enabled arrived; saw ' + JSON.stringify(onResult.seen));
    // The panel cannot compare a credential it was never given.
    assert.ok(on.local_api.secret && on.local_api.secret.length >= 16);

    const offWait = payloadWhere(d.sock, (p) => p && p.local_api && p.local_api.enabled === false);
    await fetch(target('/local-api'), J(jwt, { enabled: false }));
    const offResult = await offWait;
    const off = offResult.payload;
    assert.ok(off, 'no payload with the door closed arrived: ' + JSON.stringify(offResult.seen));
    /*
     * ⚠️ The field must still be PRESENT when disabled. A panel that only ever learned "on" would
     * keep the door open for the rest of its life — absence has to mean off, and the only way to
     * make absence mean off is to always send the field.
     */
    assert.ok(off.local_api, 'local_api vanished when disabled, so a panel could never be told to close');
    assert.equal(off.local_api.enabled, false);

    /*
     * ⚠️ TOP-LEVEL, outside the item list. Same rule as triggers, the power schedule and saved
     * endpoints: toggling a door must not read as a content change and restart playback (#234).
     */
    assert.ok(Object.prototype.hasOwnProperty.call(off, 'local_api'));
    assert.ok(!JSON.stringify(off.assignments || []).includes('local_api'));
  } finally {
    try { d.sock.close(); } catch { /* */ }
  }
});
