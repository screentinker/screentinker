'use strict';

// Editing plans from the dashboard (lib/plan-admin.js, PUT/POST /api/admin/plans).
//
// The rule that matters: checkout charges the linked Stripe Price, not the plan's price_monthly, so a
// save is refused while the two disagree — wrong amount, currency, interval, or an archived Price.
// Also: Free stays free, one Price cannot be on two plans, only platform admins edit, and every
// change is logged.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plan-admin-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const stripeClient = require('../lib/stripe-client');

// A Stripe double: prices.retrieve answers from this table.
const PRICES = new Map();
const fakeStripe = {
  prices: {
    retrieve: async (id) => {
      if (!PRICES.has(id)) { const e = new Error(`No such price: '${id}'`); e.code = 'resource_missing'; throw e; }
      return PRICES.get(id);
    },
  },
};
const price = (id, cents, interval, extra = {}) => PRICES.set(id, { id, unit_amount: cents, currency: 'usd', active: true, recurring: { interval, interval_count: 1 }, ...extra });

let server, base;
let role = 'platform_admin';
function call(method, p, body) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (r) => { let o = ''; r.on('data', (c) => (o += c)); r.on('end', () => resolve({ status: r.statusCode, json: o ? JSON.parse(o) : null })); });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

before(async () => {
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, plan_id, role) VALUES ('padmin', 'padmin@t.local', 'x', 'free', 'platform_admin')").run();
  for (const i of [1, 2, 3]) db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'pro')").run(`u${i}`, `u${i}@t.local`);
  db.prepare("UPDATE users SET stripe_subscription_id = 'sub_1' WHERE id = 'u1'").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'padmin', role }; next(); });
  app.use('/api/admin', require('../routes/admin'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  role = 'platform_admin';
  PRICES.clear();
  stripeClient.__setForTests(fakeStripe);
  db.prepare("UPDATE plans SET display_name = 'Pro', max_devices = 25, price_monthly = 24.99, price_yearly = 249, stripe_price_monthly = NULL, stripe_price_yearly = NULL, active = 1 WHERE id = 'pro'").run();
  db.prepare("UPDATE plans SET stripe_price_monthly = NULL, stripe_price_yearly = NULL WHERE id != 'pro'").run();
  db.prepare("DELETE FROM plans WHERE id NOT IN ('free','starter','pro','enterprise')").run();
});
after(() => { stripeClient.__setForTests(undefined); return new Promise((r) => server.close(r)); });

test('limits and features save, apply to everyone on the plan, and the change is logged', async () => {
  const r = await call('PUT', '/api/admin/plans/pro', { display_name: 'Pro (2026)', max_devices: 40, max_storage_mb: -1, remote_url: false, priority_support: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.plan.max_devices, 40);
  assert.equal(r.json.plan.max_storage_mb, -1, '-1 = unlimited');
  assert.equal(r.json.plan.remote_url, 0);
  assert.deepEqual(r.json.impact, { accounts: 3, subscribers: 1 });
  assert.deepEqual(r.json.changed.sort(), ['display_name', 'max_devices', 'max_storage_mb', 'priority_support', 'remote_url'].sort());
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'admin_update_plan' ORDER BY rowid DESC LIMIT 1").get();
  assert.match(log.details, /max_devices: 25 → 40/);
  // getUserPlan reads it live: a user on Pro now has 40.
  const { getUserPlan } = require('../middleware/subscription');
  assert.equal(getUserPlan('u2').max_devices, 40);
});

test('bad values are refused with the field named, and nothing is written', async () => {
  for (const [body, field] of [[{ max_devices: -2 }, 'max_devices'], [{ max_devices: 2.5 }, 'max_devices'], [{ price_monthly: -1 }, 'price_monthly'],
    [{ price_monthly: 9.999 }, 'price_monthly'], [{ display_name: '' }, 'display_name'], [{ stripe_price_monthly: 'prod_123' }, 'stripe_price_monthly']]) {
    const r = await call('PUT', '/api/admin/plans/pro', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.field, field);
  }
  assert.equal(db.prepare("SELECT max_devices FROM plans WHERE id = 'pro'").get().max_devices, 25);
  assert.equal((await call('PUT', '/api/admin/plans/nope', { max_devices: 1 })).status, 404);
});

test('a linked Stripe price must charge exactly the price shown', async () => {
  price('price_pro_month_1', 2499, 'month');
  price('price_pro_year_01', 24900, 'year');
  let r = await call('PUT', '/api/admin/plans/pro', { stripe_price_monthly: 'price_pro_month_1', stripe_price_yearly: 'price_pro_year_01' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.stripe_checked.map((c) => c.field), ['stripe_price_monthly', 'stripe_price_yearly']);
  // The shown price changes but the linked Price does not: refused, because Stripe would charge $24.99.
  r = await call('PUT', '/api/admin/plans/pro', { price_monthly: 29.99 });
  assert.equal(r.status, 400);
  assert.equal(r.json.field, 'price_monthly');
  assert.match(r.json.error, /Stripe charges \$24\.99/);
  assert.equal(db.prepare("SELECT price_monthly FROM plans WHERE id = 'pro'").get().price_monthly, 24.99, 'nothing written');
  // Change both together, to a Price that really is $29.99: accepted.
  price('price_pro_month_2', 2999, 'month');
  r = await call('PUT', '/api/admin/plans/pro', { price_monthly: 29.99, stripe_price_monthly: 'price_pro_month_2' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.plan.stripe_price_monthly, 'price_pro_month_2');
});

test('wrong interval, wrong currency, archived and unknown Prices are each refused', async () => {
  price('price_yearly_one', 2499, 'year');
  price('price_eur_month1', 2499, 'month', { currency: 'eur' });
  price('price_archived_1', 2499, 'month', { active: false });
  price('price_quarterly1', 2499, 'month', { recurring: { interval: 'month', interval_count: 3 } });
  for (const [id, re] of [['price_yearly_one', /not billed every month/], ['price_eur_month1', /EUR/], ['price_archived_1', /archived/],
    ['price_quarterly1', /not billed every month/], ['price_missing_01', /no price with that id/]]) {
    const r = await call('PUT', '/api/admin/plans/pro', { stripe_price_monthly: id });
    assert.equal(r.status, 400, id);
    assert.match(r.json.error, re, id);
  }
});

test('one Stripe price cannot sit on two plans, nor on both intervals of one', async () => {
  price('price_shared_m01', 2499, 'month');
  db.prepare("UPDATE plans SET price_monthly = 24.99, stripe_price_monthly = 'price_shared_m01' WHERE id = 'starter'").run();
  let r = await call('PUT', '/api/admin/plans/pro', { stripe_price_monthly: 'price_shared_m01' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /already linked to Starter/);
  r = await call('PUT', '/api/admin/plans/pro', { stripe_price_monthly: 'price_same_both1', stripe_price_yearly: 'price_same_both1' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /two different Stripe prices/);
});

test('Free stays free: lapsed accounts are moved to it', async () => {
  let r = await call('PUT', '/api/admin/plans/free', { price_monthly: 5 });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/admin/plans/free', { stripe_price_monthly: 'price_free_m001' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/admin/plans/free', { max_devices: 2 });
  assert.equal(r.status, 200, 'its limits can change');
  r = await call('PUT', '/api/admin/plans/pro', { price_monthly: 0, stripe_price_monthly: 'price_pro_month_1' });
  assert.equal(r.status, 400, 'a Price linked to a plan shown as $0 is refused');
});

test('without Stripe the ids are stored unchecked, and the answer says so', async () => {
  stripeClient.__setForTests(null);
  const r = await call('PUT', '/api/admin/plans/pro', { stripe_price_monthly: 'price_unchecked1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.plan.stripe_price_monthly, 'price_unchecked1');
  assert.match(r.json.warnings[0], /not configured/);
});

test('a new plan is created hidden, with its id checked', async () => {
  let r = await call('POST', '/api/admin/plans', { id: 'Team Plan', display_name: 'Team' });
  assert.equal(r.status, 400);
  assert.equal(r.json.field, 'id');
  r = await call('POST', '/api/admin/plans', { id: 'team', display_name: 'Team', max_devices: 10, price_monthly: 59 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.plan.active, 0, 'kept off the pricing page until it is shown');
  assert.equal(r.json.plan.name, 'team');
  assert.equal((await call('POST', '/api/admin/plans', { id: 'team', display_name: 'Again' })).status, 409);
  const { status, json } = await call('GET', '/api/admin/plans/team/impact');
  assert.equal(status, 200);
  assert.deepEqual(json, { accounts: 0, subscribers: 0 });
});

test('only platform admins can edit plans', async () => {
  role = 'user';
  assert.equal((await call('PUT', '/api/admin/plans/pro', { max_devices: 99 })).status, 403);
  assert.equal((await call('POST', '/api/admin/plans', { id: 'x1', display_name: 'X' })).status, 403);
  role = 'platform_operator';
  assert.equal((await call('PUT', '/api/admin/plans/pro', { max_devices: 99 })).status, 403, 'operators look, admins change');
  assert.equal(db.prepare("SELECT max_devices FROM plans WHERE id = 'pro'").get().max_devices, 25);
});
