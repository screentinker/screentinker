'use strict';

/*
 * Hosted AI image credits: the rate card, the org ledger, and the /api/ai/hosted/generate route.
 *
 * What has to hold, and why each one matters to a customer:
 *   - the price is 2x the provider cost of the EXACT model/tier chosen, rounded up to the cent, and
 *     an unknown combination is refused rather than guessed;
 *   - the included allotment is 10% of the org's screen bill (lib/billing.js's formula, read-only);
 *   - the balance never goes below zero, and an unaffordable choice is refused while a cheaper one
 *     still works;
 *   - a failed provider call refunds the reserve, and a retried request charges once.
 * In-process, one DATA_DIR. Each test uses its own org so balances never collide.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-aicredits-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
process.env.XAI_API_KEY = 'xai-test-SECRETKEY-0123456789';
delete process.env.OPENAI_API_KEY;
delete process.env.AI_HOSTED_COMPAT_API_KEY;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { db } = require('../db/database');
const credits = require('../lib/ai-credits');
const hosted = require('../lib/ai-hosted');

const MAR15 = Date.UTC(2026, 2, 15, 12, 0, 0);   // mid-month: 14 completed days

db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ('u-owner', 'owner@test.local', 'x', 'user')").run();
function seedOrg(id) {
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, 'u-owner')").run(id, id);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-${id}`, id, id);
}

/* n screens online a full 8h on every completed day of the month before `nowMs`. */
function seedScreens(orgId, n, month, days) {
  const dev = db.prepare('INSERT OR IGNORE INTO devices (id, name, workspace_id) VALUES (?, ?, ?)');
  const use = db.prepare('INSERT OR REPLACE INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, 28800)');
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `${orgId}-d${i}`;
      dev.run(id, id, `ws-${orgId}`);
      for (let d = 1; d <= days; d++) use.run(id, `${month}-${String(d).padStart(2, '0')}`);
    }
  })();
}

const sel = (model, resolution, quality) => ({ provider: 'xai', model, resolution, quality });
const IMG_1K = sel('grok-imagine-image', '1K', 'standard');
const V2_2K_MED = sel('grok-imagine-image-2.0', '2K', 'medium');

/* ------------------------------ rate card ------------------------------ */

test('rate card: every xAI tier is priced at 2x provider cost, in credits', () => {
  const expect = [
    ['grok-imagine-image', '1K', 'standard', 4], ['grok-imagine-image', '2K', 'standard', 4],
    ['grok-imagine-image-2.0', '1K', 'low', 8], ['grok-imagine-image-2.0', '1.5K', 'low', 10],
    ['grok-imagine-image-2.0', '2K', 'low', 12], ['grok-imagine-image-2.0', '1K', 'medium', 12],
    ['grok-imagine-image-2.0', '1.5K', 'medium', 14], ['grok-imagine-image-2.0', '2K', 'medium', 16],
    ['grok-imagine-image-quality', '1K', 'standard', 10], ['grok-imagine-image-quality', '1.5K', 'standard', 12],
    ['grok-imagine-image-quality', '2K', 'standard', 14],
  ];
  for (const [m, r, q, c] of expect) {
    const row = credits.findRow(sel(m, r, q));
    assert.ok(row, `${m} ${r} ${q} should be on the card`);
    const p = credits.priceOf(row);
    assert.equal(p.credits, c, `${m} ${r} ${q}`);
    assert.equal(p.charge_usd_micros, c * 10000, 'charge is exactly credits x $0.01');
    assert.equal(p.charge_usd_micros, row.provider_cost_usd_micros * 2, '2x, no hidden extra');
  }
});

test('rate card: Imagine 2.0 costs more than imagine-image at every tier', () => {
  const base = credits.priceOf(credits.findRow(IMG_1K)).credits;
  for (const r of credits.rateCard().filter((x) => x.model === 'grok-imagine-image-2.0')) {
    assert.ok(credits.priceOf(r).credits > base, `${r.resolution} ${r.quality}`);
  }
});

test('rate card: rounds UP to the cent', () => {
  // $0.012345 x 2 = $0.02469 -> 3 credits ($0.03), never 2.
  assert.equal(credits.priceOf({ provider_cost_usd_micros: 12345 }).credits, 3);
  assert.equal(credits.priceOf({ provider_cost_usd_micros: 10000 }).credits, 2);
});

test('rate card: an unknown combination is refused, never matched to a neighbour', () => {
  assert.equal(credits.findRow(sel('grok-imagine-image', '1.5K', 'standard')), null);
  assert.equal(credits.findRow(sel('grok-imagine-image-2.0', '1K', 'high')), null);
  assert.equal(credits.findRow(sel('grok-imagine-image', '1k', 'standard')), null, 'case-exact');
  assert.equal(credits.findRow({ provider: 'openai', model: 'gpt-image-1', resolution: '1536x1024', quality: 'low' }), null,
    'OpenAI has no verified per-image price, so it offers nothing');
  seedOrg('org-unknown');
  credits.adminAdjust({ orgId: 'org-unknown', delta: 1000, nowMs: MAR15 });
  assert.throws(() => credits.reserve({ orgId: 'org-unknown', idempotencyKey: 'k-unknown-1', selection: sel('grok-imagine-image', '4K', 'standard'), nowMs: MAR15 }),
    (e) => e.code === 'unknown_model');
  assert.equal(credits.balance('org-unknown', MAR15).total, 1000, 'nothing charged');
});

test('catalog: only providers with a key, never the key itself', () => {
  const cat = hosted.catalog();
  assert.ok(cat.length >= 11);
  assert.ok(cat.every((r) => r.provider === 'xai'), 'OpenAI has no key in this test, so it is hidden');
  assert.doesNotMatch(JSON.stringify(cat), /SECRETKEY/);
  assert.doesNotMatch(JSON.stringify(hosted.providerStatus()), /SECRETKEY/);
  assert.equal(hosted.providerStatus().providers.find((p) => p.id === 'xai').key_set, true);
});

/* ------------------------------ included allotment ------------------------------ */

test('included grant = 10% of the screen bill: 100 screens -> $150 -> 1,500 credits', () => {
  seedOrg('org-100');
  seedScreens('org-100', 100, '2026-03', 14);
  const bill = credits.orgScreenBill('org-100', MAR15);
  assert.equal(bill.billable_screens, 100);
  assert.equal(bill.cost_cents, 15000);
  credits.ensureIncludedGrant('org-100', MAR15);
  assert.equal(credits.balance('org-100', MAR15).included, 1500);
  assert.equal(Math.floor(1500 / 4), 375, '375 images on the $0.04 SKU');
  assert.equal(Math.floor(1500 / 8), 187, '187 on Imagine 2.0 1K low');
  // Idempotent: calling again grants nothing more.
  credits.ensureIncludedGrant('org-100', MAR15);
  assert.equal(credits.balance('org-100', MAR15).included, 1500);
});

test('included grant: integer-exact and floored', () => {
  assert.equal(credits.includedFor(15000), 1500);
  assert.equal(credits.includedFor(150), 15);   // 1 screen = $1.50 -> 15 credits
  assert.equal(credits.includedFor(155), 15);   // floored
  assert.equal(credits.includedFor(0), 0);
});

test('included grant: zero screens grants zero, but purchased credits still spend', () => {
  seedOrg('org-zero');
  credits.ensureIncludedGrant('org-zero', MAR15);
  assert.equal(credits.balance('org-zero', MAR15).total, 0);
  assert.throws(() => credits.reserve({ orgId: 'org-zero', idempotencyKey: 'k-zero-1', selection: IMG_1K, nowMs: MAR15 }),
    (e) => e.code === 'insufficient_credits' && e.needed === 4);
  assert.equal(credits.recordPurchase({ orgId: 'org-zero', packId: 'pack_10', ref: 'cs_zero', nowMs: MAR15 }).applied, true);
  credits.reserve({ orgId: 'org-zero', idempotencyKey: 'k-zero-2', selection: IMG_1K, nowMs: MAR15 });
  assert.equal(credits.balance('org-zero', MAR15).purchased, 996);
});

test('included credits expire at month end; purchased do not', () => {
  seedOrg('org-roll');
  seedScreens('org-roll', 10, '2026-03', 31);
  credits.ensureIncludedGrant('org-roll', MAR15);
  credits.recordPurchase({ orgId: 'org-roll', packId: 'pack_10', ref: 'cs_roll', nowMs: MAR15 });
  assert.equal(credits.balance('org-roll', MAR15).included, 150);
  const apr2 = Date.UTC(2026, 3, 2, 12);
  const b = credits.balance('org-roll', apr2);
  assert.equal(b.included, 0, 'March included does not roll into April');
  assert.equal(b.purchased, 1000);
});

test('included grant on the 1st uses last month\'s final bill, and only ever tops up', () => {
  seedOrg('org-d1');
  seedScreens('org-d1', 10, '2026-03', 31);
  const apr1 = Date.UTC(2026, 3, 1, 9);
  const bill = credits.orgScreenBill('org-d1', apr1);
  assert.equal(bill.basis, 'previous_month');
  assert.equal(bill.billable_screens, 10);
  credits.ensureIncludedGrant('org-d1', apr1);
  assert.equal(credits.balance('org-d1', apr1).included, 150);
  // April so far has no usage, so the month-to-date estimate drops to 0: nothing is clawed back.
  credits.ensureIncludedGrant('org-d1', Date.UTC(2026, 3, 3, 9));
  assert.equal(credits.balance('org-d1', Date.UTC(2026, 3, 3, 9)).included, 150);
});

/* ------------------------------ ledger rules ------------------------------ */

test('cannot debit below zero; an unaffordable choice is refused while a cheaper one succeeds', () => {
  seedOrg('org-afford');
  credits.adminAdjust({ orgId: 'org-afford', delta: 10, nowMs: MAR15 });
  assert.throws(() => credits.reserve({ orgId: 'org-afford', idempotencyKey: 'k-aff-1', selection: V2_2K_MED, nowMs: MAR15 }),
    (e) => e.code === 'insufficient_credits' && e.needed === 16 && e.balance.total === 10);
  assert.equal(credits.balance('org-afford', MAR15).total, 10, 'a refused reserve moves nothing');
  credits.reserve({ orgId: 'org-afford', idempotencyKey: 'k-aff-2', selection: IMG_1K, nowMs: MAR15 });
  credits.reserve({ orgId: 'org-afford', idempotencyKey: 'k-aff-3', selection: IMG_1K, nowMs: MAR15 });
  assert.equal(credits.balance('org-afford', MAR15).total, 2);
  assert.throws(() => credits.reserve({ orgId: 'org-afford', idempotencyKey: 'k-aff-4', selection: IMG_1K, nowMs: MAR15 }),
    (e) => e.code === 'insufficient_credits');
  assert.equal(credits.balance('org-afford', MAR15).total, 2, 'never negative');
  assert.throws(() => credits.adminAdjust({ orgId: 'org-afford', delta: -3, nowMs: MAR15 }), (e) => e.code === 'would_go_negative');
});

test('included is spent before purchased', () => {
  seedOrg('org-order');
  seedScreens('org-order', 1, '2026-03', 14);       // $1.50 -> 15 included
  credits.recordPurchase({ orgId: 'org-order', packId: 'pack_10', ref: 'cs_order', nowMs: MAR15 });
  const { reservation } = credits.reserve({ orgId: 'org-order', idempotencyKey: 'k-ord-1', selection: V2_2K_MED, nowMs: MAR15 });
  assert.equal(reservation.from_included, 15);
  assert.equal(reservation.from_purchased, 1);
  const b = credits.balance('org-order', MAR15);
  assert.equal(b.included, 0);
  assert.equal(b.purchased, 999);
});

test('release refunds the reserve to the buckets it came from, exactly once', () => {
  seedOrg('org-refund');
  seedScreens('org-refund', 1, '2026-03', 14);
  credits.recordPurchase({ orgId: 'org-refund', packId: 'pack_10', ref: 'cs_refund', nowMs: MAR15 });
  credits.ensureIncludedGrant('org-refund', MAR15);   // the month's grant lands first, as reserve() would
  const before = credits.balance('org-refund', MAR15);
  assert.equal(before.included, 15);
  const { reservation } = credits.reserve({ orgId: 'org-refund', idempotencyKey: 'k-ref-1', selection: V2_2K_MED, nowMs: MAR15 });
  assert.equal(credits.release(reservation.id, 'boom', 400, MAR15), true);
  assert.equal(credits.release(reservation.id, 'boom', 400, MAR15), false, 'second release is a no-op');
  assert.deepEqual(credits.balance('org-refund', MAR15), before);
  assert.equal(credits.commit(reservation.id, 'c1', MAR15), false, 'a released attempt cannot then be committed');
});

test('a retried idempotency key charges once', () => {
  seedOrg('org-idem');
  credits.adminAdjust({ orgId: 'org-idem', delta: 100, nowMs: MAR15 });
  const a = credits.reserve({ orgId: 'org-idem', idempotencyKey: 'k-idem-1', selection: IMG_1K, nowMs: MAR15 });
  const b = credits.reserve({ orgId: 'org-idem', idempotencyKey: 'k-idem-1', selection: IMG_1K, nowMs: MAR15 });
  assert.equal(a.replay, false);
  assert.equal(b.replay, true);
  assert.equal(b.reservation.id, a.reservation.id);
  assert.equal(credits.balance('org-idem', MAR15).total, 96);
});

test('a crashed attempt (stale pending) is refunded by the sweep', () => {
  seedOrg('org-stale');
  credits.adminAdjust({ orgId: 'org-stale', delta: 20, nowMs: MAR15 });
  credits.reserve({ orgId: 'org-stale', idempotencyKey: 'k-stale-1', selection: IMG_1K, nowMs: MAR15 });
  assert.equal(credits.balance('org-stale', MAR15).total, 16);
  assert.ok(credits.sweepStale(MAR15 + 3600 * 1000) >= 1);
  assert.equal(credits.balance('org-stale', MAR15).total, 20);
});

test('a Stripe redelivery grants a pack once', () => {
  seedOrg('org-pack');
  assert.equal(credits.recordPurchase({ orgId: 'org-pack', packId: 'pack_25', ref: 'cs_dup', nowMs: MAR15 }).applied, true);
  assert.equal(credits.recordPurchase({ orgId: 'org-pack', packId: 'pack_25', ref: 'cs_dup', nowMs: MAR15 }).reason, 'already_applied');
  assert.equal(credits.balance('org-pack', MAR15).purchased, 2500);
  assert.equal(credits.recordPurchase({ orgId: 'org-pack', packId: 'pack_999', ref: 'cs_x', nowMs: MAR15 }).applied, false);
});

test('the ledger is append-only', () => {
  assert.throws(() => db.prepare('UPDATE ai_credit_ledger SET delta_credits = 999999').run(), /append-only/);
});

test('the screen meter is only read: no ledger work writes device_usage_daily', () => {
  const before = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(online_seconds),0) s FROM device_usage_daily').get();
  credits.ensureIncludedGrant('org-100', MAR15);
  credits.balance('org-100', MAR15);
  assert.deepEqual(db.prepare('SELECT COUNT(*) n, COALESCE(SUM(online_seconds),0) s FROM device_usage_daily').get(), before);
});

/* ------------------------------ the route, end to end ------------------------------ */

// 1x1 PNG, so the real ingest's sniffer accepts it as an image.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
let providerMode = 'ok';
let providerCalls = 0;
let lastProviderBody = null;
const realFetch = global.fetch;
let server, base;

before(async () => {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      providerCalls++;
      lastProviderBody = JSON.parse(opts.body);
      if (providerMode === 'fail') {
        return new Response(`{"error":"bad key xai-test-SECRETKEY-0123456789"}`, { status: 500 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  seedOrg('org-http');
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ('u-http', 'http@test.local', 'x', 'user')").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u-http', email: 'http@test.local', role: 'user' };
    req.organizationId = 'org-http';
    req.workspaceId = 'ws-org-http';
    req.workspaceRole = req.headers['x-role'] || 'workspace_editor';
    req.orgRole = null;
    req.actingAs = false;
    req.isPlatformAdmin = false;
    next();
  });
  app.use('/api/ai/hosted', require('../routes/ai-hosted'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { global.fetch = realFetch; return new Promise((r) => server.close(r)); });

const gen = (body, headers = {}) => realFetch(`${base}/api/ai/hosted/generate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ prompt: 'a calm lake at dawn', ...IMG_1K, ...body }),
});
const bal = () => credits.balance('org-http').total;

test('route: a generation charges the quoted price and returns a library content item', async () => {
  credits.adminAdjust({ orgId: 'org-http', delta: 20 });
  const start = bal();
  const res = await gen({ idempotency_key: 'route-ok-0001' });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.credits_spent, 4);
  assert.ok(j.content_id);
  assert.ok(db.prepare('SELECT 1 FROM content WHERE id = ? AND workspace_id = ?').get(j.content_id, 'ws-org-http'), 'a normal content row in the workspace');
  assert.equal(bal(), start - 4);
  assert.equal(lastProviderBody.model, 'grok-imagine-image');
  assert.equal(lastProviderBody.resolution, '1k', 'the tier asked for is the tier quoted');
  assert.equal(lastProviderBody.aspect_ratio, '16:9');
  const act = db.prepare("SELECT details FROM activity_log WHERE action = 'ai_hosted_image' ORDER BY id DESC LIMIT 1").get();
  assert.ok(act && /grok-imagine-image · 1K · standard · 4 credits/.test(act.details));
  assert.doesNotMatch(act.details, /lake/, 'no prompt in the audit line');
});

test('route: a retry with the same key charges once and replays the result', async () => {
  const start = bal();
  const calls = providerCalls;
  const a = await (await gen({ idempotency_key: 'route-idem-0001' })).json();
  const b = await (await gen({ idempotency_key: 'route-idem-0001' })).json();
  assert.equal(b.replayed, true);
  assert.equal(b.content_id, a.content_id);
  assert.equal(providerCalls, calls + 1, 'the provider was called once');
  assert.equal(bal(), start - 4);
});

test('route: a failed provider call refunds the reserve and never leaks the key', async () => {
  providerMode = 'fail';
  try {
    const start = bal();
    const res = await gen({ idempotency_key: 'route-fail-0001' });
    const j = await res.json();
    assert.equal(res.status, 400);
    assert.equal(j.credits_refunded, 4);
    assert.equal(bal(), start, 'fail closed: no credits moved');
    assert.doesNotMatch(JSON.stringify(j), /SECRETKEY/);
    const r = db.prepare("SELECT status, error FROM ai_credit_reservations WHERE idempotency_key = 'route-fail-0001'").get();
    assert.equal(r.status, 'released');
    assert.doesNotMatch(r.error, /SECRETKEY/);
  } finally { providerMode = 'ok'; }
});

test('route: an unaffordable model is a 402 the UI can act on; a cheaper one still works', async () => {
  const have = bal();
  if (have > 6) credits.adminAdjust({ orgId: 'org-http', delta: -(have - 6) });
  const res = await gen({ idempotency_key: 'route-402-0001', ...V2_2K_MED });
  const j = await res.json();
  assert.equal(res.status, 402);
  assert.equal(j.code, 'insufficient_credits');
  assert.equal(j.needed, 16);
  assert.equal(j.balance, 6);
  assert.equal((await gen({ idempotency_key: 'route-402-0002' })).status, 200);
  assert.equal(bal(), 2);
});

test('route: no model chosen = refused; viewers cannot spend', async () => {
  const res = await gen({ idempotency_key: 'route-nomodel-1', model: '', resolution: '', quality: '' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'unknown_model');
  assert.equal((await gen({ idempotency_key: 'route-viewer-1' }, { 'x-role': 'workspace_viewer' })).status, 403);
  assert.equal((await gen({})).status, 400, 'idempotency key required');
});

test('route: status shows the catalog with prices and no keys; only org admins can buy', async () => {
  const j = await (await realFetch(`${base}/api/ai/hosted/status`)).json();
  assert.equal(j.enabled, true);
  assert.equal(j.can_buy, false);
  const row = j.catalog.find((r) => r.model === 'grok-imagine-image-2.0' && r.resolution === '1K' && r.quality === 'low');
  assert.equal(row.credits, 8);
  assert.equal(row.charge_usd, 0.08);
  assert.doesNotMatch(JSON.stringify(j), /SECRETKEY/);
  const co = await realFetch(`${base}/api/ai/hosted/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pack_id":"pack_10"}' });
  assert.equal(co.status, 403);
});

test('a duplicate rate-card combo collapses to one row, the later (env) row winning', () => {
  const config = require('../config');
  const prev = config.aiHosted.extraRateCard;
  config.aiHosted.extraRateCard = [{ provider: 'xai', model: 'grok-imagine-image', resolution: '1K', quality: 'standard',
    provider_cost_usd_micros: 30000, request: { resolution: '1k' } }];
  credits.__resetCardForTests();
  try {
    const rows = credits.rateCard().filter((r) => r.model === 'grok-imagine-image' && r.resolution === '1K');
    assert.equal(rows.length, 1);
    assert.equal(credits.priceOf(credits.findRow(IMG_1K)).credits, 6, 'what is charged...');
    assert.equal(hosted.catalog().filter((r) => r.model === 'grok-imagine-image' && r.resolution === '1K')[0].credits, 6, '...is what is shown');
  } finally { config.aiHosted.extraRateCard = prev; credits.__resetCardForTests(); }
});

test('the stale sweep can never fire inside a live provider call', () => {
  const config = require('../config');
  const prev = config.aiHosted.reservationStaleSec;
  config.aiHosted.reservationStaleSec = 60;
  try { assert.ok(credits.staleWindowSec() * 1000 > config.aiHosted.providerTimeoutMs); }
  finally { config.aiHosted.reservationStaleSec = prev; }
});
