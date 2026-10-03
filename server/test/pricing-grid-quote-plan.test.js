'use strict';

/*
 * The quote-only plan on the marketing page.
 *
 * It IS a row in the plans table — today `name: 'enterprise'`, `display_name: 'Custom'`,
 * `max_devices: -1`, `price_monthly: 0` — and it is the one row the pricing grid cannot render,
 * because a price of 0 makes the card say "Free" beside the actual Free plan. So it is excluded and
 * given its own card.
 *
 * ⚠️ WHAT THIS GUARDS. The exclusion used to test `p.name !== 'enterprise'`. `name` is the one field
 * on that row nothing displays, so renaming it in admin — the natural thing to do when the card
 * already reads "Custom" — would put a $0 "Free" card in the grid AND leave the hardcoded card below
 * it. Two wrong cards, from an edit that looks like tidying up. The exclusion now tests the shape
 * that actually means "ask us": unlimited devices, no price.
 *
 * Asserted against the real rendering logic lifted out of the page, rather than by reading the
 * source for a string, because the failure is in what the filter SELECTS.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LANDING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'landing.html'), 'utf8'
);

// The two lines the page uses to decide. Lifted from the page so this cannot pass while the page
// does something else.
function extract(re, what) {
  const m = LANDING.match(re);
  assert.ok(m, `could not find ${what} in landing.html`);
  return m[1];
}
const isQuoteSlotSrc = extract(
  /const isQuoteSlot = (\(p\) => [\s\S]*?);\n/, 'the isQuoteSlot predicate'
);
// eslint-disable-next-line no-new-func
const isQuoteSlot = new Function(`return ${isQuoteSlotSrc}`)();

// Prod's live rows, 2026-09-24.
const PLANS = [
  { name: 'free',       display_name: 'Free',     max_devices: 1,  price_monthly: 0,   price_yearly: 0,    active: 1 },
  { name: 'home',       display_name: 'Home',     max_devices: 2,  price_monthly: 9.99, price_yearly: 99,  active: 1 },
  { name: 'starter',    display_name: 'Starter',  max_devices: 5,  price_monthly: 39,  price_yearly: 389,  active: 1 },
  { name: 'pro',        display_name: 'Pro',      max_devices: 15, price_monthly: 99,  price_yearly: 989,  active: 1 },
  { name: 'business',   display_name: 'Business', max_devices: 50, price_monthly: 199, price_yearly: 1989, active: 1 },
  { name: 'enterprise', display_name: 'Custom',   max_devices: -1, price_monthly: 0,   price_yearly: 0,    active: 1 },
];

const grid = (plans) => plans.filter((p) => p.active && !isQuoteSlot(p));

// ⚠️ What db/schema.sql SEEDS, which is what every fresh self-hosted instance serves. Its enterprise
// row is PRICED ($49.99) and unlimited, so a shape-only test would leave it in the grid while the
// quote card rendered below it: two enterprise cards, on every new install. Prod's row has been
// edited to price 0 since, which is exactly why testing only one deployment's shape is not enough.
const SEEDED = [
  { name: 'free',       display_name: 'Free',       max_devices: 2,  price_monthly: 0,     price_yearly: 0,   active: 1 },
  { name: 'starter',    display_name: 'Starter',    max_devices: 8,  price_monthly: 9.99,  price_yearly: 99,  active: 1 },
  { name: 'pro',        display_name: 'Pro',        max_devices: 25, price_monthly: 24.99, price_yearly: 249, active: 1 },
  { name: 'enterprise', display_name: 'Enterprise', max_devices: -1, price_monthly: 49.99, price_yearly: 499, active: 1 },
];

test('a FRESH instance gets one enterprise card, not two', () => {
  assert.deepEqual(grid(SEEDED).map((p) => p.display_name), ['Free', 'Starter', 'Pro']);
  assert.equal(SEEDED.filter(isQuoteSlot).length, 1);
});

test('the quote-only row is kept out of the grid and the priced rows are kept in', () => {
  assert.deepEqual(
    grid(PLANS).map((p) => p.display_name),
    ['Free', 'Home', 'Starter', 'Pro', 'Business']
  );
  assert.equal(PLANS.filter(isQuoteSlot).length, 1, 'exactly one quote-only row');
});

test('the Free plan is NOT mistaken for quote-only', () => {
  // Both have price 0. Only one has an unlimited device cap, which is the distinguishing property —
  // and getting this backwards would delete the Free tier from the page, the single card most
  // responsible for a signup.
  assert.equal(isQuoteSlot(PLANS.find((p) => p.name === 'free')), false);
});

test('renaming the plan cannot smuggle a $0 card into the grid', () => {
  // The exact edit the old `name !== 'enterprise'` filter broke on.
  const renamed = PLANS.map((p) => (p.name === 'enterprise' ? { ...p, name: 'custom' } : p));
  assert.deepEqual(
    grid(renamed).map((p) => p.display_name),
    ['Free', 'Home', 'Starter', 'Pro', 'Business'],
    'a renamed quote-only row must still be excluded'
  );

  // And a display_name change must not either.
  const relabelled = PLANS.map((p) => (p.name === 'enterprise' ? { ...p, display_name: 'Enterprise' } : p));
  assert.equal(grid(relabelled).length, 5);
});

test('a priced unlimited plan outside the reserved slot stays in the grid', () => {
  // "Unlimited devices" alone does not mean "ask us": a priced unlimited tier is buyable and belongs
  // in the grid with its price on it — as long as it is not the reserved `enterprise` row, which is
  // the quote slot by convention whatever it is priced at.
  const priced = { name: 'unlimited', display_name: 'Unlimited', max_devices: -1, price_monthly: 499, price_yearly: 4990, active: 1 };
  assert.equal(isQuoteSlot(priced), false);
  assert.ok(grid([...PLANS, priced]).some((p) => p.display_name === 'Unlimited'));
});

test('the card title comes from the row, and survives the row being absent', () => {
  const src = extract(/const quoteTitle = ([^;]+);/, 'the quoteTitle expression');
  // eslint-disable-next-line no-new-func
  const titleOf = new Function('quotePlan', `return ${src}`);
  assert.equal(titleOf(PLANS.find(isQuoteSlot)), 'Custom', 'follows display_name');
  assert.equal(titleOf({ display_name: 'Enterprise' }), 'Enterprise');
  // ⚠️ A self-hosted instance that deleted the plan still needs a way to reach sales. Dropping the
  // card would remove the only enterprise contact path on the page.
  assert.equal(titleOf(undefined), 'Enterprise / Custom', 'falls back rather than rendering blank');
  assert.equal(titleOf({ display_name: '' }), 'Enterprise / Custom', 'an empty name is not a title');
});

test('the contact route is still on the card', () => {
  // The button is the point of the card. A refactor that loses it loses every enterprise lead the
  // page would have produced, silently.
  assert.match(LANDING, /onclick="openContactModal\(\)"[^>]*>Contact Us</);
  assert.match(LANDING, /id="contactModal"/);
  assert.match(LANDING, /Enterprise Inquiry/);
});
