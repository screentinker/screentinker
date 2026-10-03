'use strict';

// GET /api/subscription/me threw for any caller without a `users` row.
//
// getUserPlan() returns null there — deliberately, and its own comment says callers must read
// that as "unrestricted" — but this route dereferenced it (`plan.plan_id`) on the next line. The
// caller is not hypothetical: a support session authenticates as `support:<jti>` and has no users
// row by design, so opening Subscription through a support token threw a TypeError.
//
// The reason it is worth a test rather than a one-line fix: an unhandled throw in an API route
// reaches Express's DEFAULT error handler, which replies with an HTML page. The dashboard then
// fails at r.json() with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, and the user
// sees "Failed to load" on the Subscription page — a message that points nowhere near a null
// dereference in a plan lookup. Observed on a customer instance on 2026-09-28.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-subnull-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getUserPlan } = require('../middleware/subscription');
const router = require('../routes/subscription');

// The last handler on the '/me' route is the one under test; the auth middleware ahead of it is
// not what this is about, so it is driven directly with an already-authenticated request.
function meHandler() {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/me') {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error('GET /api/subscription/me not found on the router');
}

function callMe(userId) {
  let body = null, status = 200;
  const res = {
    json(payload) { body = payload; return this; },
    status(code) { status = code; return this; },
  };
  // Any throw here is the regression: in the real app it becomes an HTML error page.
  meHandler()({ user: { id: userId } }, res, (err) => { throw err || new Error('unexpected next()'); });
  return { body, status };
}

test('getUserPlan returns null for a caller with no users row', () => {
  // The contract this route has to honour.
  assert.equal(getUserPlan('support:' + crypto.randomBytes(8).toString('hex')), null);
});

test('a support session gets JSON, not a thrown TypeError', () => {
  const { body, status } = callMe('support:abcdef0123456789');
  assert.equal(status, 200);
  assert.ok(body, 'a body must be sent');
  assert.equal(body.unbilled, true);
});

test('the payload keeps every field the Billing view reads unconditionally', () => {
  // frontend/js/views/billing.js dereferences these without guarding, so `plan: null` would only
  // move the same crash into the browser.
  const { body } = callMe('support:abcdef0123456789');
  assert.equal(typeof body.plan.display_name, 'string');
  assert.ok(body.plan.display_name.length > 0);
  assert.equal(typeof body.plan.max_devices, 'number');
  assert.equal(typeof body.usage.devices, 'number');
  assert.equal(typeof body.usage.storage_mb, 'number');
  assert.ok(body.subscription, 'subscription object must exist');
  assert.equal(body.trial.active, false);
  assert.equal(body.self_hosted, true);
});

test('it claims no plan and no limits rather than inventing one', () => {
  const { body } = callMe('support:abcdef0123456789');
  assert.equal(body.plan.id, null, 'there is no plan row to name');
  assert.equal(body.plan.max_devices, -1, 'unlimited, matching getUserPlan null == unrestricted');
  assert.equal(body.subscription.stripe_subscription_id, null);
});
