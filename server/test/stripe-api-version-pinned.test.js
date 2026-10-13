'use strict';

/*
 * Every Stripe client the server builds pins its API version. Unpinned, the version is whatever the
 * installed SDK defaults to, so a dependency bump changes the API under live billing with nothing
 * in the test suite noticing (every other billing test uses a double). stripe 23 defaulted to
 * 2026-09-30.endive, which rejects the payment_method_types both checkout routes send.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const stripeClient = require('../lib/stripe-client');

test('the real SDK client carries the pinned API version, not the SDK default', () => {
  const s = stripeClient.create('sk_test_dummy_never_sent');
  assert.strictEqual(s.getApiField('version'), stripeClient.STRIPE_API_VERSION);
});

test('no server code constructs a Stripe client except through lib/stripe-client', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && p !== path.join(root, 'lib', 'stripe-client.js')) {
        if (/require\(\s*['"]stripe['"]\s*\)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepStrictEqual(offenders, [], `build Stripe clients with stripe-client.create(): ${offenders.join(', ')}`);
});
