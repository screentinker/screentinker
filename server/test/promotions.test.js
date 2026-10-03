'use strict';

// Sales / limited-time discounts: validation, one-sale-at-a-time, the Stripe coupon that backs every
// sale, and — the point of it all — that CHECKOUT charges the price the page advertises.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-promo-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'false'; // cloud mode: the mode that sells
process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const promotions = require('../lib/promotions');
const stripeClient = require('../lib/stripe-client');

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

function fakeStripe() {
  const calls = { coupons: [], deleted: [], sessions: [] };
  return {
    calls,
    coupons: {
      create: async (p) => { calls.coupons.push(p); return { id: 'co_' + calls.coupons.length }; },
      del: async (id) => { calls.deleted.push(id); return { id, deleted: true }; },
      update: async (id, p) => { (calls.updated ||= []).push([id, p]); return { id, ...p }; },
    },
    customers: { create: async () => ({ id: 'cus_1' }) },
    billingPortal: { sessions: { create: async () => ({ url: 'https://portal.test' }) } },
    checkout: { sessions: { create: async (p) => { calls.sessions.push(p); return { url: 'https://checkout.test/s' }; } } },
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM promotions').run();
  // Price ids the checkout route needs; the seeded plans have none.
  db.prepare("UPDATE plans SET stripe_price_monthly = 'price_m_' || id, stripe_price_yearly = 'price_y_' || id WHERE price_monthly > 0").run();
});

const base = (o = {}) => ({ name: 'Black Friday', headline: '30% off your first year', percent_off: 30, ends_at: NOW() + 3 * DAY, ...o });

test('validation: the fields a sale needs, and honest limits', () => {
  assert.equal(promotions.validate(base()).error, undefined);
  assert.match(promotions.validate(base({ percent_off: 0 })).error, /1 to 90/);
  assert.match(promotions.validate(base({ percent_off: 95 })).error, /1 to 90/);
  assert.match(promotions.validate(base({ percent_off: 12.5 })).error, /whole number/);
  assert.match(promotions.validate(base({ headline: '' })).error, /headline/);
  assert.match(promotions.validate(base({ ends_at: NOW() - 10 })).error, /past|after it starts/);
  assert.match(promotions.validate(base({ duration: 'repeating' })).error, /1 to 36 months/);
  assert.match(promotions.validate(base({ plan_ids: ['nope'] })).error, /Unknown plan/);
  assert.match(promotions.validate(base({ plan_ids: ['free'] })).error, /paid plan/);
  assert.match(promotions.validate(base({ cycles: 'weekly' })).error, /monthly, yearly or both/);
  assert.match(promotions.validate(base({ starts_at: NOW(), ends_at: NOW() + 400 * DAY })).error, /a year at most/);
});

test('a sale cannot exist without its Stripe coupon, and the coupon ends when the sale does', async () => {
  await assert.rejects(promotions.create(base(), null), /Stripe is not configured/);
  assert.equal(promotions.list().length, 0);

  const s = fakeStripe();
  const ends = NOW() + 3 * DAY;
  const p = await promotions.create(base({ ends_at: ends, duration: 'repeating', duration_in_months: 3 }), s, 'u1');
  assert.equal(p.stripe_coupon_id, 'co_1');
  assert.deepEqual(s.calls.coupons[0], { percent_off: 30, duration: 'repeating', duration_in_months: 3, name: 'Black Friday', metadata: { promotion_id: p.id }, redeem_by: ends });

  const refusing = { coupons: { create: async () => { throw new Error('bad'); } } };
  db.prepare('DELETE FROM promotions').run();
  await assert.rejects(promotions.create(base(), refusing), /Stripe refused/);
  assert.equal(promotions.list().length, 0, 'nothing is stored when Stripe refuses');
});

test('one sale at a time; a scheduled sale is not current until it starts', async () => {
  const s = fakeStripe();
  await promotions.create(base({ starts_at: NOW() + DAY, ends_at: NOW() + 3 * DAY }), s);
  assert.equal(promotions.current(), null, 'scheduled, not started');
  await assert.rejects(promotions.create(base({ name: 'Other', starts_at: NOW() + 2 * DAY, ends_at: NOW() + 5 * DAY }), s), /Overlaps "Black Friday"/);
  const later = await promotions.create(base({ name: 'Later', starts_at: NOW() + 4 * DAY, ends_at: NOW() + 5 * DAY }), s);
  assert.ok(later.id, 'a non-overlapping sale is fine');
  assert.equal(promotions.current(NOW() + DAY + 10).name, 'Black Friday');
  assert.equal(promotions.current(NOW() + 4 * DAY + 10).name, 'Later');
  assert.equal(promotions.current(NOW() + 6 * DAY), null, 'over');
});

test('activeFor honours the plans and billing cycles a sale covers', async () => {
  await promotions.create(base({ plan_ids: ['pro'], cycles: 'yearly' }), fakeStripe());
  assert.ok(promotions.activeFor('pro', 'yearly'));
  assert.equal(promotions.activeFor('pro', 'monthly'), null);
  assert.equal(promotions.activeFor('starter', 'yearly'), null);
});

test('ending early deletes the coupon and stops the sale at once', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  const out = await promotions.end(p.id, s);
  assert.ok(out.promo.ended_at);
  assert.deepEqual(s.calls.deleted, [p.stripe_coupon_id]);
  assert.equal(promotions.current(), null);
  // And it no longer blocks a new sale.
  assert.ok((await promotions.create(base({ name: 'Again' }), s)).id);
});

test('the public view carries no internal name and no Stripe ids', async () => {
  const p = await promotions.create(base(), fakeStripe());
  const v = promotions.publicView(p);
  assert.equal(v.headline, '30% off your first year');
  assert.ok(!('name' in v) && !('stripe_coupon_id' in v) && !('id' in v));
  assert.equal(promotions.salePrice(99, 30), 69.3);
  assert.equal(promotions.salePrice(989, 25), 741.75);
});

// A real account and a real session token: the route's own requireAuth runs, not a stub.
function userToken() {
  const { generateToken } = require('../middleware/auth');
  const id = 'promo-test-user';
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, stripe_customer_id) VALUES (?, 'buyer@promo.test', 'Buyer', 'x', 'user', 'cus_1')").run(id);
  }
  return generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

async function checkout(planId, interval) {
  const app = express();
  app.use(express.json());
  delete require.cache[require.resolve('../routes/stripe')];
  app.use('/api/stripe', require('../routes/stripe'));
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/stripe/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken()}` }, body: JSON.stringify({ plan_id: planId, interval }),
    });
    return { status: r.status, body: await r.json() };
  } finally { srv.close(); }
}

test('checkout CHARGES the sale: the coupon is attached to a covered plan, and only to it', async () => {
  const s = fakeStripe();
  stripeClient.__setForTests(s);
  try {
    // No sale: promotion codes allowed, no discount.
    let r = await checkout('pro', 'monthly');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let sess = s.calls.sessions.at(-1);
    assert.equal(sess.allow_promotion_codes, true);
    assert.equal(sess.discounts, undefined);

    const p = await promotions.create(base({ plan_ids: ['pro'] }), s);
    r = await checkout('pro', 'yearly');
    sess = s.calls.sessions.at(-1);
    assert.deepEqual(sess.discounts, [{ coupon: p.stripe_coupon_id }]);
    assert.equal(sess.allow_promotion_codes, undefined, 'Stripe refuses both at once');
    assert.equal(sess.metadata.promotion_id, p.id);

    r = await checkout('starter', 'monthly');
    sess = s.calls.sessions.at(-1);
    assert.equal(sess.discounts, undefined, 'a plan outside the sale pays full price');

    await promotions.end(p.id, s);
    r = await checkout('pro', 'yearly');
    assert.equal(s.calls.sessions.at(-1).discounts, undefined, 'an ended sale is not applied');
  } finally {
    stripeClient.__setForTests(undefined);
  }
});

test('one rule for every surface: a self-hosted server shows no sale and cannot create one', async () => {
  const s = fakeStripe();
  await promotions.create(base(), s);
  assert.ok(promotions.publicCurrent({ selfHosted: false }), 'cloud mode shows the running sale');
  assert.equal(promotions.publicCurrent({ selfHosted: true }), null, 'self-hosted: the homepage hides it, like the Subscription page');
  assert.match(promotions.salesAvailable(s, { selfHosted: true }).reason, /self-hosted mode/);
  assert.match(promotions.salesAvailable(null, { selfHosted: false }).reason, /Stripe is not configured/);
  assert.equal(promotions.salesAvailable(s, { selfHosted: false }).ok, true);
});

// ---------------------------------------------------------------------------
// Editing and deleting sales
// ---------------------------------------------------------------------------

// A sale that ran and finished on its own (its window is over; its coupon still exists in Stripe).
async function expiredSale(s, o = {}) {
  const p = await promotions.create(base(o), s);
  db.prepare('UPDATE promotions SET starts_at = ?, ends_at = ? WHERE id = ?').run(NOW() - 10 * DAY, NOW() - 3 * DAY, p.id);
  return promotions.get(p.id);
}

test('editing words, plans or cycles of a live sale keeps its coupon', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  const { promo } = await promotions.update(p.id, { headline: 'New banner', plan_ids: ['pro'], cycles: 'yearly' }, s);
  assert.equal(promo.headline, 'New banner');
  assert.deepEqual(promo.plan_ids, ['pro']);
  assert.equal(promo.cycles, 'yearly');
  assert.equal(promo.stripe_coupon_id, p.stripe_coupon_id);
  assert.equal(s.calls.coupons.length, 1, 'no new coupon');
  assert.deepEqual(s.calls.deleted, []);
  assert.equal(promotions.activeFor('pro', 'yearly').id, p.id);
  assert.equal(promotions.activeFor('pro', 'monthly'), null, 'checkout follows the edited cycles at once');
});

test('renaming a sale renames its coupon (the one thing Stripe lets us change)', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  await promotions.update(p.id, { name: 'Cyber Monday' }, s);
  assert.deepEqual(s.calls.updated, [[p.stripe_coupon_id, { name: 'Cyber Monday' }]]);
  assert.equal(s.calls.coupons.length, 1);
});

test('changing what is CHARGED swaps in a new coupon, then deletes the old one', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  const ends = NOW() + 5 * DAY;
  const { promo } = await promotions.update(p.id, { percent_off: 40, ends_at: ends }, s);
  assert.equal(s.calls.coupons.length, 2);
  assert.equal(s.calls.coupons[1].percent_off, 40);
  assert.equal(s.calls.coupons[1].redeem_by, ends, 'the new coupon expires with the edited sale');
  assert.notEqual(promo.stripe_coupon_id, p.stripe_coupon_id);
  assert.deepEqual(s.calls.deleted, [p.stripe_coupon_id]);
  assert.equal(promotions.activeFor('pro', 'monthly').stripe_coupon_id, promo.stripe_coupon_id);
});

test('if Stripe refuses the new coupon, the sale is unchanged and keeps its old coupon', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  s.coupons.create = async () => { throw new Error('rate limited'); };
  await assert.rejects(promotions.update(p.id, { percent_off: 50 }, s), (e) => e.status === 502);
  const after = promotions.get(p.id);
  assert.equal(after.percent_off, 30);
  assert.equal(after.stripe_coupon_id, p.stripe_coupon_id);
  assert.deepEqual(s.calls.deleted, [], 'the coupon checkout uses is never deleted first');
});

test('an edit is validated like a new sale: no overlap, no end in the past', async () => {
  const s = fakeStripe();
  const a = await promotions.create(base({ ends_at: NOW() + 2 * DAY }), s);
  const b = await promotions.create(base({ name: 'Later', starts_at: NOW() + 5 * DAY, ends_at: NOW() + 9 * DAY }), s);
  await assert.rejects(promotions.update(b.id, { starts_at: NOW() + DAY }, s), /Overlaps "Black Friday"/);
  await assert.rejects(promotions.update(a.id, { ends_at: NOW() - 60 }, s), (e) => e.status === 400);
  await assert.rejects(promotions.update(a.id, { starts_at: NOW() - 2 * DAY, ends_at: NOW() - 60 }, s), /already in the past/);
  await assert.rejects(promotions.update('promo_nope', { name: 'x' }, s), (e) => e.status === 404);
});

test('a finished sale: words can be corrected, terms cannot be rewritten', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  await promotions.end(p.id, s);
  const { promo } = await promotions.update(p.id, { name: 'BF 2026', headline: 'Thanks for coming', percent_off: '30', plan_ids: [] }, s);
  assert.equal(promo.name, 'BF 2026');
  assert.equal(promo.headline, 'Thanks for coming');
  assert.ok(promo.ended_at, 'still ended');
  await assert.rejects(promotions.update(p.id, { percent_off: 50 }, s), /give it new dates/);
  assert.equal(s.calls.coupons.length, 1, 'no coupon for a record');
});

test('a finished sale given new dates runs again, with a new coupon', async () => {
  const s = fakeStripe();
  const p = await promotions.create(base(), s);
  await promotions.end(p.id, s);
  const ends = NOW() + 4 * DAY;
  const { promo } = await promotions.update(p.id, { starts_at: NOW(), ends_at: ends }, s);
  assert.equal(promo.ended_at, null);
  assert.notEqual(promo.stripe_coupon_id, p.stripe_coupon_id);
  assert.equal(promotions.current().id, p.id);
  assert.deepEqual(s.calls.deleted, [p.stripe_coupon_id], 'only the delete from ending it: that coupon was already gone');

  await promotions.end(promo.id, s);
  const old = await expiredSale(s, { name: 'Summer' });
  const out = await promotions.update(old.id, { starts_at: NOW(), ends_at: NOW() + DAY }, s);
  assert.ok(s.calls.deleted.includes(old.stripe_coupon_id), 'an expired sale still had its coupon; it is cleaned up');
  assert.notEqual(out.promo.stripe_coupon_id, old.stripe_coupon_id);
});

test('deleting: finished and scheduled sales go, a running one must be ended first', async () => {
  const s = fakeStripe();
  const live = await promotions.create(base(), s);
  await assert.rejects(promotions.remove(live.id, s), (e) => e.status === 409 && /End it first/.test(e.message));
  assert.ok(promotions.get(live.id));

  await promotions.end(live.id, s);
  const deletedBefore = s.calls.deleted.length;
  await promotions.remove(live.id, s);
  assert.equal(promotions.get(live.id), null);
  assert.equal(s.calls.deleted.length, deletedBefore, 'an ended sale has no coupon left to delete');

  const later = await promotions.create(base({ name: 'Later', starts_at: NOW() + 5 * DAY, ends_at: NOW() + 9 * DAY }), s);
  await promotions.remove(later.id, s);
  assert.equal(promotions.get(later.id), null);
  assert.ok(s.calls.deleted.includes(later.stripe_coupon_id), 'a scheduled sale takes its unused coupon with it');

  const old = await expiredSale(s, { name: 'Summer' });
  s.coupons.del = async () => { throw Object.assign(new Error('No such coupon'), { code: 'resource_missing' }); };
  const out = await promotions.remove(old.id, s);
  assert.equal(out.stripeWarning, null, 'a coupon already gone from Stripe is not an error');
  assert.equal(promotions.get(old.id), null);
});

test('PUT and DELETE /api/admin/promotions/:id are platform-admin only and work end to end', async () => {
  const s = fakeStripe();
  stripeClient.__setForTests(s);
  const { generateToken } = require('../middleware/auth');
  const mk = (id, role) => {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
      db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'x', 'x', ?)").run(id, `${id}@promo.test`, role);
    }
    return generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  };
  const app = express();
  app.use(express.json());
  // Mounted the way api-surface.js mounts it: requireAuth in front (JWT_ONLY_ROUTERS).
  app.use('/api/admin', require('../middleware/auth').requireAuth, require('../routes/admin'));
  const srv = app.listen(0);
  const url = (id) => `http://127.0.0.1:${srv.address().port}/api/admin/promotions/${id}`;
  const call = (method, id, tok, body) => fetch(url(id), { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body) });
  try {
    const p = await promotions.create(base(), s);
    const user = mk('promo-plain-user', 'user');
    const admin = mk('promo-platform-admin', 'superadmin');
    assert.equal((await call('PUT', p.id, user, { headline: 'x' })).status, 403);
    assert.equal((await call('DELETE', p.id, user)).status, 403);

    const r = await call('PUT', p.id, admin, { headline: 'Edited' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).promotion.headline, 'Edited');
    assert.equal((await call('DELETE', p.id, admin)).status, 409, 'running');
    await promotions.end(p.id, s);
    assert.equal((await call('DELETE', p.id, admin)).status, 200);
    assert.equal(promotions.get(p.id), null);
  } finally {
    srv.close();
    stripeClient.__setForTests(undefined);
  }
});
