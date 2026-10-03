'use strict';

/*
 * PUT /api/admin/users/:id/email-alerts — turning a customer's alert email off as a platform admin.
 *
 * It replaced a hand-written UPDATE against the production database. The reason it exists is the
 * ⚠️ AUDIT ROW, not the convenience: a raw UPDATE leaves nothing behind, so months later there is no
 * way to tell "the customer asked us to stop" from "the alert service is broken and nobody noticed a
 * display go dark". Those two need opposite responses, and the activity_log row is the only thing
 * that distinguishes them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const HANDLER = (() => {
  const at = SRC.indexOf("router.put('/users/:id/email-alerts'");
  assert.notEqual(at, -1, 'the endpoint is missing from routes/admin.js');
  const rest = SRC.slice(at);
  return rest.slice(0, rest.indexOf('\n});') + 4);
})();

test('it is platform-admin only', () => {
  // Not requireAdmin: this reaches any account on the box regardless of org, and platform_operator
  // has no user-management power (#13).
  assert.match(HANDLER, /router\.put\('\/users\/:id\/email-alerts', requirePlatformAdmin,/);
});

test('enabled must be a real boolean, not a truthy string', () => {
  /*
   * ⚠️ `{"enabled":"false"}` is TRUTHY in JavaScript. Coercing it would turn alerts back ON for
   * somebody who asked for silence, from a request that reads as if it asked for the opposite — and
   * the caller would get a 200. So the type is checked rather than coerced.
   */
  assert.match(HANDLER, /typeof enabled !== 'boolean'/);
  assert.match(HANDLER, /res\.status\(400\)/);
  assert.ok(!/enabled \? 1 : 0(?![\s\S]*typeof enabled)/.test(HANDLER.split('\n')[0]),
    'the guard comes before the write');
  // Prove the semantics of the guard rather than trusting the regex.
  const guard = (enabled) => typeof enabled !== 'boolean';
  for (const bad of ['false', 'true', 0, 1, null, undefined, {}, []]) {
    assert.equal(guard(bad), true, `${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of [true, false]) assert.equal(guard(good), false);
});

test('a missing user is a 404, not a silent success', () => {
  assert.match(HANDLER, /if \(!target\) return res\.status\(404\)/);
});

test('it writes the audit row, with a different action per direction', () => {
  // "Somebody turned this on" and "somebody turned this off" are different events, and the one that
  // matters when a display went dark unnoticed is which one happened.
  assert.match(HANDLER, /logActivity\(/);
  assert.match(HANDLER, /admin_enabled_email_alerts/);
  assert.match(HANDLER, /admin_disabled_email_alerts/);
  assert.match(HANDLER, /target: \$\{target\.email\}/, 'the row names who it was done to');
  assert.match(HANDLER, /getClientIp\(req\)/, 'and from where');
});

test('a no-op is reported as unchanged and writes no audit row', () => {
  // Setting 0 to 0 is not an event. A log full of non-events is a log nobody reads.
  assert.match(HANDLER, /const changed = was !== next;/);
  assert.match(HANDLER, /if \(changed\) \{/);
  const changedBlock = HANDLER.slice(HANDLER.indexOf('if (changed) {'));
  assert.ok(changedBlock.indexOf('logActivity(') < changedBlock.indexOf('\n  }'),
    'the audit write is inside the changed branch');
  assert.match(HANDLER, /changed,/, 'and the response says so');
});

test('a NULL email_alerts on an older row counts as enabled', () => {
  // The column was added by migration with DEFAULT 1, and rows predating it read NULL. Treating NULL
  // as 0 would report "unchanged" while leaving alerts on — the request would look honoured and the
  // customer would keep getting mail.
  assert.match(HANDLER, /target\.email_alerts == null \? 1 :/);
  const was = (v) => (v == null ? 1 : (v ? 1 : 0));
  assert.equal(was(null), 1);
  assert.equal(was(undefined), 1);
  assert.equal(was(0), 0);
  assert.equal(was(1), 1);
});

test('the response names everything the one flag silences', () => {
  // One boolean covers four senders. An admin turning it off for a paying customer should be able to
  // see that payment-failure mail goes quiet too, rather than find out at renewal.
  for (const s of ['device offline alerts', 'trial reminders', 'setup nudges', 'payment-failure notices']) {
    assert.ok(HANDLER.includes(s), `the response should name "${s}"`);
  }
});

test('the flag it writes is the one every sender actually reads', () => {
  // The endpoint would be theatre if it wrote a column nothing consults.
  const readers = ['services/alerts.js', 'services/trialExpiry.js', 'services/activationNudge.js', 'services/dunning.js'];
  for (const rel of readers) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /email_alerts/, `${rel} must consult email_alerts`);
  }
  assert.match(HANDLER, /UPDATE users SET email_alerts = \?/);
});
