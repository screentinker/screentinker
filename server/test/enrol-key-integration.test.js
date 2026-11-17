'use strict';

/*
 * #313 — the enrolment key over a real socket, against a real server.
 *
 * The unit tests next door check the pieces. This checks the thing that actually matters and that
 * only a live register can show: a player arriving with NOTHING but a key ends up as the display
 * that key belongs to, and — the whole point — does not leave a new row behind.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO CATCH. A vMix browser input deletes its CEF profile when vMix
 * closes, so the player boots with no id, no token and no cache. Today that provisions a NEW
 * display: restart the production PC five times and the operator has five dead screens plus the
 * one they wanted. If the exchange ever regresses to falling through to the pairing path, the
 * device count in these tests goes up and this file fails.
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
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-enrol-int-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-enrol-int-' + crypto.randomBytes(4).toString('hex') + '.log');

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
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // Open the SAME database the server is using, to set keys and count rows the way an operator's
  // dashboard would — without needing an authenticated session for a test about sockets.
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const deviceCount = () => db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;

/** Provision a display the ordinary way, so there is a real row with a real token to adopt. */
function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve(d); });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(null); }, 5000);
  });
}

/** Connect carrying ONLY an enrolment key — the vMix-after-restart case. */
function connectWithKey(key) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => sock.emit('device:register', { enrol_key: key, device_info: { app_version: 'test' } }));
    sock.on('device:registered', (d) => finish({ registered: true, device_id: d.device_id }));
    sock.on('device:auth-error', (e) => finish({ registered: false, authError: e && e.error }));
    setTimeout(() => finish({ registered: false, timedOut: true }), 5000);
  });
}

test('a player with only a key becomes the display it belongs to — and adds no row', async () => {
  const dev = await provision();
  assert.ok(dev && dev.device_id, 'precondition: a display exists');

  const key = require('../lib/enrol-key').setEnrolKey(db, dev.device_id);
  const before = deviceCount();

  // The restart: no stored id, no token, no cache. Only the URL.
  const r = await connectWithKey(key);
  assert.equal(r.registered, true, `expected to register, got ${JSON.stringify(r)}`);
  assert.equal(r.device_id, dev.device_id, 'it must come back as the SAME display, not a new one');
  assert.equal(deviceCount(), before, 'no new display row may be created');
});

test('it survives being done repeatedly — five restarts, still one display', async () => {
  const dev = await provision();
  const key = require('../lib/enrol-key').setEnrolKey(db, dev.device_id);
  const before = deviceCount();

  for (let i = 0; i < 5; i++) {
    const r = await connectWithKey(key);
    assert.equal(r.device_id, dev.device_id, `restart ${i + 1} landed on a different display`);
  }
  // The actual bug being prevented: a production PC rebooted every morning for a month.
  assert.equal(deviceCount(), before, 'repeated enrolment must never accumulate rows');
});

test('an unknown key is refused, and provisions nothing', async () => {
  const before = deviceCount();
  const r = await connectWithKey(require('../lib/enrol-key').generateEnrolKey());

  assert.equal(r.registered, false, 'a key that resolves to nothing must not register');
  assert.ok(!r.timedOut, 'it must be told no, not left hanging');
  assert.match(String(r.authError || ''), /enrol/i, 'and told why');
  assert.equal(deviceCount(), before, 'a bad key must not leave a display row behind');
});

test('rolling the key locks out the old URL over a real socket', async () => {
  const dev = await provision();
  const enrol = require('../lib/enrol-key');
  const oldKey = enrol.setEnrolKey(db, dev.device_id);
  assert.equal((await connectWithKey(oldKey)).device_id, dev.device_id, 'precondition: the old URL works');

  const newKey = enrol.setEnrolKey(db, dev.device_id);
  const before = deviceCount();

  const stale = await connectWithKey(oldKey);
  assert.equal(stale.registered, false, 'the rolled-away URL must stop working');
  assert.equal(deviceCount(), before, 'and must not provision a replacement');

  assert.equal((await connectWithKey(newKey)).device_id, dev.device_id, 'the new URL works');
});

test('a display whose row has no token is still enrollable — and is issued one', async () => {
  /*
   * ⚠️ FOUND BY ACTUALLY RUNNING IT, not by reading it. The exchange resolved the key and handed
   * the register path a NULL token, validateDeviceToken failed on the missing stored value, and
   * the player fell back to asking for a pairing code — which is a new display row on every
   * restart, the exact failure this feature exists to prevent. The key IS the proof of identity,
   * so a row without a token gets issued one, the same way the fingerprint-match path does for a
   * reinstalled app.
   */
  const dev = await provision();
  db.prepare('UPDATE devices SET device_token = NULL WHERE id = ?').run(dev.device_id);
  const key = require('../lib/enrol-key').setEnrolKey(db, dev.device_id);
  const before = deviceCount();

  const r = await connectWithKey(key);
  assert.equal(r.registered, true, 'a tokenless row must still enrol, not fall through to pairing');
  assert.equal(r.device_id, dev.device_id);
  assert.equal(deviceCount(), before, 'and must not provision a replacement');

  const tok = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(dev.device_id).device_token;
  assert.ok(tok && tok.length > 0, 'it must be issued a token so it can authenticate from now on');
});

/*
 * ⚠️ A STALE KEY MUST NOT LOCK THE BUILDING OUT OF PAIRING.
 *
 * Three ordinary operator actions leave a player holding a dead key — rolling it, revoking it, or
 * deleting the display. The player re-derives that key from its own URL on every load and retries
 * about every ten seconds forever. The first version counted each of those as a pairing failure, and
 * five failures locks the whole IP out of pairing for fifteen minutes: behind one office NAT, a
 * single stranded screen in a corner made every other display in the building un-pairable, on a
 * loop, with nothing in the dashboard to explain it.
 *
 * The 256-bit key is not worth guessing, so the lockout bought nothing in exchange.
 */
test('a rolled-away key falls back to pairing instead of locking the IP out', async () => {
  const enrol = require('../lib/enrol-key');
  const dev = await provision();
  const stale = enrol.setEnrolKey(db, dev.device_id);
  enrol.setEnrolKey(db, dev.device_id);          // rolled: `stale` now resolves to nothing

  const before = deviceCount();

  // The stranded player, hammering with the dead key the way it does in the field.
  for (let i = 0; i < 6; i++) await connectWithKey(stale);
  assert.equal(deviceCount(), before, 'a dead key must still not provision anything by itself');

  /*
   * The check that matters: ordinary pairing from the SAME address still works. Before the fix the
   * sixth attempt above had already tripped pairLockout and this would be refused.
   */
  const fresh = await provision();
  assert.ok(fresh && fresh.device_id,
    'pairing from this IP was refused — a stranded display has locked out the whole site');
  assert.notEqual(fresh.device_id, dev.device_id, 'and it is a genuinely new display');
});

/*
 * #630 — a key in the URL of a browser that ALSO kept an identity in its storage.
 *
 * The web player used to send the key only when it had no stored device_id, so a browser that keeps
 * its storage never presented a new link at all: a UniFi Cast whose server had been rebuilt sent
 * the dead id from its storage, was told "not found", re-paired, and showed a pairing code as a
 * brand-new display while the display its link named stayed offline. The player now sends both,
 * and the server decides. These pin each answer.
 */
function connectWith(payload) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => sock.emit('device:register', { device_info: { app_version: 'test' }, ...payload }));
    sock.on('device:registered', (d) => finish({ registered: true, device_id: d.device_id, device_token: d.device_token }));
    sock.on('device:unpaired', (d) => finish({ registered: false, unpaired: d && d.reason }));
    sock.on('device:auth-error', (e) => finish({ registered: false, authError: e && e.error, reason: e && e.reason }));
    setTimeout(() => finish({ registered: false, timedOut: true }), 5000);
  });
}

test('#630: a stored identity the server never had + a valid key = the key\'s display, no new row', async () => {
  const dev = await provision();
  const key = require('../lib/enrol-key').setEnrolKey(db, dev.device_id);
  const before = deviceCount();
  const r = await connectWith({ device_id: crypto.randomUUID(), device_token: 'f'.repeat(64), enrol_key: key });
  assert.equal(r.registered, true, `expected to register, got ${JSON.stringify(r)}`);
  assert.equal(r.device_id, dev.device_id, 'the link names the display; the dead stored id must not win');
  assert.equal(deviceCount(), before, 'and no display row may be created');
});

test('#630: a working identity + a key for ANOTHER display = the other display (the newer link wins)', async () => {
  const a = await provision();
  const b = await provision();
  const keyB = require('../lib/enrol-key').setEnrolKey(db, b.device_id);
  const r = await connectWith({ device_id: a.device_id, device_token: a.device_token, enrol_key: keyB });
  assert.equal(r.device_id, b.device_id);
  assert.ok(r.device_token, 'the player is handed the new display\'s token, so its storage follows');
});

test('#630: a working identity + a key nobody has = the stored identity, untouched', async () => {
  const a = await provision();
  const r = await connectWith({ device_id: a.device_id, device_token: a.device_token, enrol_key: require('../lib/enrol-key').generateEnrolKey() });
  assert.equal(r.registered, true, `a stale link must not unpair a working screen: ${JSON.stringify(r)}`);
  assert.equal(r.device_id, a.device_id);
});

test('#630: the display\'s own key heals a stale stored token instead of forcing a re-pair', async () => {
  const a = await provision();
  const key = require('../lib/enrol-key').setEnrolKey(db, a.device_id);
  const r = await connectWith({ device_id: a.device_id, device_token: '0'.repeat(64), enrol_key: key });
  assert.equal(r.registered, true, JSON.stringify(r));
  assert.equal(r.device_id, a.device_id);
});

test('#630: a stored identity alone, with no key, is unaffected', async () => {
  const a = await provision();
  const r = await connectWith({ device_id: a.device_id, device_token: a.device_token });
  assert.equal(r.device_id, a.device_id);
});

/*
 * ⚠️ GHSA-rvxj 5.2: "NEW URL" MUST CUT OFF WHOEVER ALREADY REDEEMED THE OLD ONE.
 *
 * Redeeming a key hands back the display's device_token. Rolling only the key left that token
 * working, so a leaked URL's holder stayed the display after the operator pressed "New URL" — and
 * the fingerprint the exchange linked to the row let the reinstall path mint them a fresh one.
 */
let _owner = null;
async function owner() {
  if (_owner) return _owner;
  const email = 'enrol' + crypto.randomBytes(4).toString('hex') + '@example.com';
  const reg = await (await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123', name: 'Op' }) })).json();
  assert.ok(reg.token, JSON.stringify(reg));
  _owner = { token: reg.token, userId: reg.user.id, ws: reg.current_workspace_id };
  return _owner;
}
/** A display claimed into the operator's workspace — the shape the reinstall reclaim path serves. */
async function claimed() {
  const o = await owner();
  const dev = await provision();
  db.prepare('UPDATE devices SET user_id = ?, workspace_id = ?, pairing_code = NULL, status = ? WHERE id = ?')
    .run(o.userId, o.ws, 'offline', dev.device_id);
  return dev;
}

test('5.2: rolling the key re-issues the token the old key handed out; the new URL still works', async () => {
  const enrol = require('../lib/enrol-key');
  const dev = await claimed();
  const oldKey = enrol.setEnrolKey(db, dev.device_id);
  const fp = 'web-leak-' + crypto.randomBytes(6).toString('hex');
  const leaked = await connectWith({ enrol_key: oldKey, fingerprint: fp });
  assert.equal(leaked.registered, true, JSON.stringify(leaked));
  assert.ok(leaked.device_token, 'precondition: redeeming the URL handed out the device token');

  const newKey = enrol.setEnrolKey(db, dev.device_id);   // the operator presses "New URL"

  const replay = await connectWith({ device_id: dev.device_id, device_token: leaked.device_token, fingerprint: fp });
  assert.equal(replay.registered, false, `the old holder must be cut off: ${JSON.stringify(replay)}`);
  assert.match(String(replay.authError || ''), /token/i);

  // ...and cannot be handed a fresh token by the reinstall (fingerprint) reclaim path either.
  const reclaim = await connectWith({ fingerprint: fp, pairing_code: String(crypto.randomInt(100000, 1000000)) });
  assert.notEqual(reclaim.device_id, dev.device_id, `fingerprint reclaim gave the old holder the display: ${JSON.stringify(reclaim)}`);

  // The legitimate player, given the new URL, is the display again and gets the new token.
  const legit = await connectWith({ enrol_key: newKey });
  assert.equal(legit.device_id, dev.device_id, JSON.stringify(legit));
  assert.ok(legit.device_token && legit.device_token !== leaked.device_token, 'handed the NEW token');
  const again = await connectWith({ device_id: dev.device_id, device_token: legit.device_token });
  assert.equal(again.registered, true, 'and that new token keeps working');
});

test('5.2: clearing the key cuts off a redeemed token too', async () => {
  const enrol = require('../lib/enrol-key');
  const dev = await provision();
  const key = enrol.setEnrolKey(db, dev.device_id);
  const leaked = await connectWith({ enrol_key: key });
  assert.ok(leaked.device_token, JSON.stringify(leaked));
  enrol.clearEnrolKey(db, dev.device_id);
  const replay = await connectWith({ device_id: dev.device_id, device_token: leaked.device_token });
  assert.equal(replay.registered, false, JSON.stringify(replay));
});

test('5.2: a code-paired screen whose link nobody opened keeps its own token through a roll', async () => {
  const enrol = require('../lib/enrol-key');
  const dev = await provision();
  enrol.setEnrolKey(db, dev.device_id);
  enrol.setEnrolKey(db, dev.device_id);
  enrol.clearEnrolKey(db, dev.device_id);
  const r = await connectWith({ device_id: dev.device_id, device_token: dev.device_token });
  assert.equal(r.registered, true, `a screen whose token never left through the URL must not be knocked off: ${JSON.stringify(r)}`);
});

test('5.2: pressing New URL in the dashboard drops the redeemed holder\'s live socket', async () => {
  const enrol = require('../lib/enrol-key');
  const reg = await owner();
  const dev = await claimed();
  const key = enrol.setEnrolKey(db, dev.device_id);

  const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  const registered = new Promise((resolve) => sock.on('device:registered', resolve));
  const dropped = new Promise((resolve) => sock.on('disconnect', resolve));
  sock.on('connect', () => sock.emit('device:register', { enrol_key: key, device_info: { app_version: 'test' } }));
  try {
    const d = await Promise.race([registered, new Promise((_, rej) => setTimeout(() => rej(new Error('no register')), 5000))]);
    assert.equal(d.device_id, dev.device_id);

    const r = await fetch(`${BASE}/api/devices/${dev.device_id}/enrol-key`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + reg.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200, await r.text());
    const why = await Promise.race([dropped, new Promise((res) => setTimeout(() => res('still connected'), 3000))]);
    assert.notEqual(why, 'still connected', 'the holder of the old token must be disconnected now, not at its next reconnect');
  } finally { try { sock.close(); } catch { /* */ } }
});
