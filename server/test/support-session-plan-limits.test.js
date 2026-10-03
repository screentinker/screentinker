'use strict';

// A support session could not upload: `No plan found`, 403, before a byte was accepted.
//
// checkStorageLimit guards POST /api/content/ and /api/content/uploads; checkDeviceLimit guards
// pairing. Both start with getUserPlan(req.user.id), which returns null for a caller with no
// `users` row — and a support session has no users row by design. So signing in through a support
// token to reproduce a customer's problem meant being unable to upload the very content needed to
// reproduce it. Reported from the field on 2026-09-28.
//
// The fix is deliberately narrow. getUserPlan returns null for two situations that deserve
// opposite answers:
//   - a session with no billable account (support) -> allow
//   - a real user whose plan_id does not join a plans row -> a data fault; keep refusing, because
//     silently granting unlimited storage is the wrong repair
// These tests pin BOTH halves; widening the guard to "any plan-less caller" must fail here.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-supportplan-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supportUser, isSupportSession } = require('../lib/support-access');
const { checkStorageLimit, checkDeviceLimit } = require('../middleware/subscription');

const SUPPORT = supportUser({ id: 'support:' + crypto.randomBytes(16).toString('hex'), by: 'ops@example.test' });
const PLANLESS_ACCOUNT = { id: crypto.randomUUID(), email: 'nobody@example.test', auth_provider: 'local', role: 'admin' };

function run(mw, user) {
  let nexted = false, status = null, body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  mw({ user }, res, () => { nexted = true; });
  return { nexted, status, body };
}

test('isSupportSession needs BOTH the provider and the id prefix', () => {
  assert.equal(isSupportSession(SUPPORT), true);

  assert.equal(isSupportSession(PLANLESS_ACCOUNT), false);
  assert.equal(isSupportSession({ ...SUPPORT, auth_provider: 'local' }), false, 'id prefix alone is not enough');
  assert.equal(isSupportSession({ ...SUPPORT, id: crypto.randomUUID() }), false, 'a stored auth_provider is not enough');
  assert.equal(isSupportSession(null), false);
  assert.equal(isSupportSession(undefined), false);
  assert.equal(isSupportSession({}), false);
});

test('a support session may upload', () => {
  const r = run(checkStorageLimit, SUPPORT);
  assert.equal(r.nexted, true, 'blocked here is the bug: no upload can reach the route');
  assert.equal(r.status, null);
});

test('a support session may pair a device', () => {
  const r = run(checkDeviceLimit, SUPPORT);
  assert.equal(r.nexted, true);
});

test('a plan-less REAL account is still refused, on both guards', () => {
  // The half that must not be widened away: this is a data fault, not a support session.
  for (const mw of [checkStorageLimit, checkDeviceLimit]) {
    const r = run(mw, PLANLESS_ACCOUNT);
    assert.equal(r.nexted, false, 'a broken plan lookup must not become unlimited');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'No plan found');
  }
});
