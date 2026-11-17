'use strict';

// #148 Item 1 — paired + authenticated devices are exempt from the flap-limiter's 30-min
// QUARANTINE (a self-inflicted fleet-wide lockout behind one SNAT IP), while unpaired/anon
// flapping is still quarantined. Fast, deterministic: env shrinks the thresholds and we
// drive `now` explicitly instead of waiting.

const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-flapx-' + crypto.randomBytes(4).toString('hex'));
process.env.CONNECT_RATE_MAX = '2';
process.env.CONNECT_RATE_COOLDOWN_MS = '10';
process.env.CONNECT_RATE_QUARANTINE_TRIPS = '2';
process.env.CONNECT_RATE_WINDOW_MS = '100000';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const flap = require('../lib/flap-limiter');

beforeEach(() => flap.reset());

// Drive one "trip": exceed max within the window at time `now` (max=2 → 3 checks trips).
function tripAt(key, now, paired) { let v; for (let i = 0; i < 3; i++) v = flap.check(key, now, { paired }); return v; }

test('unpaired flapper IS quarantined after the trip threshold', () => {
  const k = 'attacker';
  assert.equal(tripAt(k, 0, false).tripped, true);          // trip 1
  const v = tripAt(k, 11, false);                           // trip 2 (past cooldown) → quarantine
  assert.equal(v.quarantined, true, 'unpaired escalates to quarantine');
  const q = flap.check(k, 12, { paired: false });
  assert.equal(q.allow, false); assert.equal(q.reason, 'quarantined');
});

test('PAIRED device is NEVER quarantined — soft cooldown at most', () => {
  const k = 'paired-device';
  tripAt(k, 0, true);
  const v = tripAt(k, 11, true);                            // would quarantine an unpaired
  assert.notEqual(v.reason, 'quarantined');
  assert.notEqual(v.quarantined, true, 'paired never escalates to the long lockout');
  // hammer for a long time — still never quarantined
  for (let t = 22; t < 5000; t += 11) {
    const r = tripAt(k, t, true);
    assert.notEqual(r.reason, 'quarantined', `t=${t} paired must not be quarantined`);
  }
});

test('presenting paired creds RELEASES an in-flight quarantine', () => {
  const k = 'dev-x';
  tripAt(k, 0, false); tripAt(k, 11, false);               // quarantine it as unpaired
  assert.equal(flap.check(k, 12, { paired: false }).reason, 'quarantined');
  const released = flap.check(k, 13, { paired: true });                 // now authenticated/paired
  assert.notEqual(released.reason, 'quarantined', 'quarantine released for a now-authenticated device (soft cooldown at most)');
  assert.equal(flap.check(k, 100, { paired: true }).allow, true, 'admitted once the brief soft cooldown passes');
});

test('SNAT: N paired devices from one IP all admitted on reconnect; repeated cycles never quarantine', () => {
  const N = 50;
  // A single flush → each device reconnects once (its own device_id key) → all admitted.
  for (let d = 0; d < N; d++) assert.equal(flap.check('device-' + d, 1000, { paired: true }).allow, true);
  // Repeated flush cycles → a paired device may hit the soft cooldown but is NEVER quarantined.
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let d = 0; d < N; d++) {
      const v = flap.check('device-' + d, 2000 + cycle * 5, { paired: true });
      assert.notEqual(v.reason, 'quarantined', `device ${d} cycle ${cycle} must not be quarantined`);
    }
  }
});

// A spoofer naming a victim's device_id without its token must not be able to spend the victim's
// bucket: device ids are not secret, and the paired exemption waives the quarantine but not the
// cooldown, so a shared bucket let anyone keep a real panel offline on a loop.
test('tokenless registers naming a device do not spend that device\'s flap bucket', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(src, /const flapKey = \(!paired && ident\.key\.startsWith\('d:'\)\) \? 'u' \+ ident\.key : ident\.key;/,
    'the register gate must key unproven callers apart from the device they name');
  assert.match(src, /flapLimiter\.check\(flapKey,/);
  // And the behaviour that keying buys: the spoofer's bucket trips, the device's stays clear.
  for (let t = 0; t < 40; t += 11) tripAt('ud:victim', t, false);
  assert.equal(flap.check('d:victim', 50, { paired: true }).allow, true,
    'the real, paired device was refused because of somebody else\'s connects');
});
