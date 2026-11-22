'use strict';

// Pairing-code brute force across addresses. A dashboard session's failed claims used to count only
// against the EXACT client IP, so one IPv6 host rotating through its own /64 (or anyone with a pool
// of addresses) got a fresh 5-per-15-min budget per address, and the /api/provision 5/min limiter
// was per exact address too. What is pinned:
//  - unit: keysFor() charges a session to the account AND the network, IPv6 folded to its /64;
//  - e2e: an account rotating IPv4 addresses is locked after MAX_FAILS (the lockout, not the limiter);
//  - e2e: addresses inside one IPv6 /64 share one budget; another account elsewhere is unaffected.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const lk = require('../lib/pair-lockout');
const { freePort } = require('./helpers/free-port');

// ── unit ────────────────────────────────────────────────────────────────────────────────────────

test('keysFor: a session is charged to the account and the /64; a token to the account only', () => {
  assert.deepEqual(lk.keysFor({ userId: 'u1', ip: '2001:db8:1:2:aaaa::1' }), ['st-owner:u1', 'net:2001:db8:1:2::/64']);
  assert.deepEqual(lk.keysFor({ userId: 'u1', ip: '198.51.100.7' }), ['st-owner:u1', 'net:198.51.100.7']);
  assert.deepEqual(lk.keysFor({ userId: 'u1' }), ['st-owner:u1'], 'token path (#827): no IP bucket');
  assert.deepEqual(lk.keysFor({}), ['net:unknown'], 'an unidentified caller still has a bucket');
  assert.equal(lk.netKey('2001:db8:1:2::5'), lk.netKey('2001:DB8:1:2:ffff:ffff:ffff:ffff'), 'same /64, same key');
  assert.notEqual(lk.netKey('2001:db8:1:2::5'), lk.netKey('2001:db8:1:3::5'), 'next /64 is a different network');
});

test('unit: an account rotating addresses locks after MAX_FAILS, and the lock holds on a new address', () => {
  const user = 'rot-' + crypto.randomUUID();
  for (let i = 0; i < lk.MAX_FAILS; i++) {
    const keys = lk.keysFor({ userId: user, ip: `203.0.113.${10 + i}` });
    assert.equal(lk.isLockedAny(keys, 1000), false, `attempt ${i + 1} is allowed`);
    lk.recordFailureAll(keys, 1000);
  }
  assert.equal(lk.isLockedAny(lk.keysFor({ userId: user, ip: '203.0.113.250' }), 1000), true);
});

test('unit: many accounts inside one IPv6 /64 share the network budget', () => {
  const net = `2001:db8:${crypto.randomInt(0xffff).toString(16)}:7`;
  for (let i = 0; i < lk.MAX_FAILS; i++) lk.recordFailureAll(lk.keysFor({ userId: 'acct-' + crypto.randomUUID(), ip: `${net}::${i + 1}` }), 1000);
  assert.equal(lk.isLockedAny(lk.keysFor({ userId: 'acct-' + crypto.randomUUID(), ip: `${net}:dead:beef:1:2` }), 1000), true);
  assert.equal(lk.isLockedAny(lk.keysFor({ userId: 'acct-' + crypto.randomUUID(), ip: '2001:db8:ffff:8::1' }), 1000), false, 'other networks are untouched');
});

// ── e2e, the real server.js ─────────────────────────────────────────────────────────────────────

let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-pairkeys-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const PW = 'Passw0rd123';

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
// The test talks over loopback, which server.js trusts as a proxy, so X-Forwarded-For sets req.ip.
const post = (jwt, obj, ip) => ({
  method: 'POST',
  headers: { ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}), 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  body: JSON.stringify(obj),
});
const pair = (jwt, code, ip) => jfetch('/api/provision/pair', post(jwt, { pairing_code: code, name: 'Screen ' + code }, ip));

let regSeq = 0;
async function register() {
  const email = 'k' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', post(null, { email, password: PW }, `192.0.2.${++regSeq}`));
  assert.ok(reg.body && reg.body.token, 'registered: ' + JSON.stringify(reg.body));
  return { jwt: reg.body.token };
}
function seedDevice() {
  const id = crypto.randomUUID();
  const code = String(100000 + crypto.randomInt(900000));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO devices (id, pairing_code, status, app_version, created_at, last_heartbeat)
              VALUES (?, ?, 'provisioning', '1.1.0-web', ?, ?)`).run(id, code, now, now);
  return code;
}
// A code no seeded device holds (seeded codes are 100000..999999).
const missCode = (i) => '00000' + i;

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
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('e2e: a session rotating IPv4 addresses is locked out by the account bucket', async () => {
  const u = await register();
  for (let i = 0; i < lk.MAX_FAILS; i++) {
    const r = await pair(u.jwt, missCode(i), `198.51.100.${20 + i}`);
    assert.equal(r.status, 404, `guess ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  // A real code from yet another address: refused by the LOCKOUT (not the per-network 5/min limiter).
  const locked = await pair(u.jwt, seedDevice(), '198.51.100.99');
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /failed pairing attempts/i);

  // A different account on a different address is not affected.
  const other = await register();
  assert.equal((await pair(other.jwt, seedDevice(), '198.51.100.150')).status, 200);
});

test('e2e: addresses inside one IPv6 /64 share a budget, across accounts', async () => {
  const a = await register();
  const b = await register();
  // Five guesses, two accounts, five different addresses, all in 2001:db8:42:1::/64.
  for (let i = 0; i < lk.MAX_FAILS; i++) {
    const r = await pair(i % 2 ? b.jwt : a.jwt, missCode(i), `2001:db8:42:1::${(i + 1).toString(16)}`);
    assert.equal(r.status, 404, `guess ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  // A third, clean account from a fresh address in the same /64 is refused (the network is spent).
  const c = await register();
  const r = await pair(c.jwt, seedDevice(), '2001:db8:42:1:ffff:ffff:ffff:1');
  assert.equal(r.status, 429, JSON.stringify(r.body));
  // ... and from the next /64 over it pairs.
  assert.equal((await pair(c.jwt, seedDevice(), '2001:db8:42:2::1')).status, 200);
});
