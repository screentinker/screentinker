'use strict';

// A pairing code must be claimable for as long as the screen is DISPLAYING it.
//
// Expiry was measured from `devices.created_at`, but the row is created once, on the
// device's first registration, and is never recreated: a player persists its device_id and
// its code and re-registers with them forever. So 15 minutes after first boot the row was
// permanently unclaimable, while the screen kept showing a code and the device kept
// heartbeating. The on-screen instruction ("restart the display to get a new code") could
// not help, because restarting reuses the stored identity and produces the same code.
//
// Observed in production: an unclaimed web player, still heartbeating, whose row was
// created 4 days 20 hours earlier and had been unpairable for all but the first 15 minutes
// of that.
//
// The fix keys expiry on LIVENESS instead: a device that has checked in recently is
// pairable; one that has been gone longer than the TTL is not. That matches what an
// operator sees — if the code is on the screen, typing it works — while still killing the
// code for a device that has actually gone away.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-pairlive-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-pairlive-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
const S = {};
const TTL_SEC = require('../lib/pair-lockout').PAIRING_TTL_SEC;

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const post = (tok, obj) => ({
  method: 'POST',
  headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

// Seed an unclaimed device exactly as a registered-but-unpaired player leaves it.
// createdMinAgo models how long ago the row first appeared; seenMinAgo models the last
// heartbeat, i.e. whether the screen is still alive and showing the code.
function seedDevice({ createdMinAgo, seenMinAgo }) {
  const id = crypto.randomUUID();
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO devices (id, pairing_code, status, app_version, created_at, last_heartbeat)
              VALUES (?, ?, 'provisioning', '1.1.0-web', ?, ?)`)
    .run(id, code, now - createdMinAgo * 60, seenMinAgo === null ? null : now - seenMinAgo * 60);
  return { id, code };
}
// NOTE: /api/provision is rate-limited to 5 requests/minute per IP (server.js), so this
// suite deliberately spends at most five pair attempts.
const pair = (code) => jfetch('/api/provision/pair', post(S.token, { pairing_code: code, name: 'Test Screen' }));

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
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', post(null, { email, password: PW }));
  S.token = reg.body.token;
  assert.ok(S.token, 'registered an operator to pair as');
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a freshly-registered screen pairs', async () => {
  const d = seedDevice({ createdMinAgo: 1, seenMinAgo: 0 });
  const r = await pair(d.code);
  assert.equal(r.status, 200, `a new screen must pair (got ${r.status} ${JSON.stringify(r.body)})`);
});

test('THE BUG: a screen that is still alive and showing its code pairs, however old the row is', async () => {
  // The exact production shape: row created days ago, device heartbeating right now.
  const d = seedDevice({ createdMinAgo: 60 * 24 * 5, seenMinAgo: 0 });
  const r = await pair(d.code);
  assert.equal(r.status, 200,
    `a live screen displaying its code must be pairable regardless of row age (got ${r.status} ${JSON.stringify(r.body)})`);
});

test('a screen that has been gone longer than the TTL is refused', async () => {
  // The property the expiry exists for: an abandoned code must not stay claimable.
  const d = seedDevice({ createdMinAgo: 60, seenMinAgo: Math.ceil(TTL_SEC / 60) + 5 });
  const r = await pair(d.code);
  assert.equal(r.status, 410, 'an abandoned code must expire');
  assert.match(r.body.error, /expired/i);
  // ...and says what helps. A restart cannot produce a new code (same stored identity, same code);
  // the code works again once the screen is back online.
  assert.doesNotMatch(r.body.error, /restart the display|get a new code/i);
  assert.match(r.body.error, /online|connected/i);
});

test('a device that never checked in falls back to its creation time', async () => {
  const stale = seedDevice({ createdMinAgo: Math.ceil(TTL_SEC / 60) + 5, seenMinAgo: null });
  assert.equal((await pair(stale.code)).status, 410, 'never-seen and old -> expired');
});

test('an unknown code is still a 404, not an expiry', async () => {
  const r = await pair('000001');
  assert.equal(r.status, 404);
});
