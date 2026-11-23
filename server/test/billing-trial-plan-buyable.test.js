'use strict';
/**
 * The billing page must let a trial user buy the plan they are trialing.
 *
 * A trial puts the account ON the trial plan (plan_id === trial_plan), so that plan's card is the
 * "Current" one. The page used to hide the Monthly / Yearly buttons on every current card, and
 * "Manage subscription" only shows with a Stripe subscription, so a Pro trial saw Pro marked
 * Current with no button at all: the one plan they had tried could not be bought from the page.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'billing.js'), 'utf8');

function loadOffersCheckout() {
  const m = src.match(/export function offersCheckout\([\s\S]*?\n\}\n/);
  assert.ok(m, 'offersCheckout must stay a top-level function in billing.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0].replace(/^export /, '')}; return offersCheckout;`)();
}

const offersCheckout = loadOffersCheckout();
const pro = { id: 'pro', price_monthly: 99, price_yearly: 989 };
const home = { id: 'home', price_monthly: 9.99, price_yearly: 99 };
const free = { id: 'free', price_monthly: 0, price_yearly: 0 };

test('a trial user can buy the plan they are trialing (its card is "Current")', () => {
  const sub = { plan: { id: 'pro' }, trial: { active: true }, subscription: null };
  assert.strictEqual(offersCheckout(pro, sub, { paying: false, mayManage: true }), true);
  assert.strictEqual(offersCheckout(home, sub, { paying: false, mayManage: true }), true);
});

test('a lapsed trial or unpaid account on a paid plan can still buy it', () => {
  const sub = { plan: { id: 'pro' }, trial: { active: false }, subscription: null };
  assert.strictEqual(offersCheckout(pro, sub, { paying: false, mayManage: false }), true,
    'an org member may buy for an org that pays nothing yet (anyone_can_buy)');
});

test('a paying account changes its own plan in the portal, not with a second checkout', () => {
  const sub = { plan: { id: 'pro' }, subscription: { stripe_subscription_id: 'sub_1' } };
  assert.strictEqual(offersCheckout(pro, sub, { paying: true, mayManage: true }), false);
  assert.strictEqual(offersCheckout(home, sub, { paying: true, mayManage: true }), true);
  assert.strictEqual(offersCheckout(home, sub, { paying: true, mayManage: false }), false,
    'only the owner or an org admin may change a paid subscription');
});

test('free plans and self-hosted servers never show checkout', () => {
  const sub = { plan: { id: 'free' }, subscription: null };
  assert.strictEqual(offersCheckout(free, sub, { paying: false, mayManage: true }), false);
  assert.strictEqual(offersCheckout(pro, { ...sub, self_hosted: true }, { paying: false, mayManage: true }), false);
});

test('the plan cards use the helper, not an inline current-plan check', () => {
  assert.match(src, /\$\{offersCheckout\(p, subData, \{ paying, mayManage \}\) \? `/);
  assert.doesNotMatch(src, /p\.price_monthly > 0 && p\.id !== subData\.plan\.id && \(mayManage \|\| !paying\)/,
    'the old rule hid checkout on the trial plan');
});

/*
 * Prices: a 90% sale turns $99 into 9.9, which showed as "$9.9/mo" and "$38.9/year". Anything with
 * cents shows two digits; whole amounts stay whole.
 */
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'utils.js'), 'utf8');
function loadAmount() {
  const m = utilsSrc.match(/export function amount\([\s\S]*?\n\}\n/);
  assert.ok(m, 'amount() must stay a top-level function in utils.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0].replace(/^export /, '')}; return amount;`)();
}
const amount = loadAmount();

test('prices with cents always show two digits, whole prices stay whole', () => {
  assert.strictEqual(amount(9.9), '9.90');
  assert.strictEqual(amount(3.9), '3.90');
  assert.strictEqual(amount(38.9), '38.90');
  assert.strictEqual(amount(9.99), '9.99');
  assert.strictEqual(amount(1), '1');
  assert.strictEqual(amount(99), '99');
  assert.strictEqual(amount(1988), '1,988');
  assert.strictEqual(amount(198.9), '198.90');
  assert.strictEqual(amount(0), '0');
  assert.strictEqual(amount('12.5'), '12.50');
  assert.strictEqual(amount(undefined), '0');
});

test('every dashboard price render goes through amount()', () => {
  assert.doesNotMatch(src, /\$\$\{(p\.price_(monthly|yearly)|cut\()/, 'billing.js prints a raw price');
  assert.doesNotMatch(src, /(was|now|price): (p\.price_yearly|cut\()/, 'billing.js passes a raw price to t()');
  const nudges = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'plan-nudges.js'), 'utf8');
  assert.match(nudges, /\$\$\{amount\(sp\.price_monthly\)\}/);
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  assert.doesNotMatch(admin, /'\$'\+p\.price_(monthly|yearly)/);
});
