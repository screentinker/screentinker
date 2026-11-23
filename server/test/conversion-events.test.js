'use strict';

// 3.0 funnel instrumentation: hosted only, closed vocabulary, once-per-account events, dedupe of
// repeated client events, and a limit refusal that names the plan that would have said yes.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-conv-'));
process.env.DATA_DIR = TMP;
delete process.env.SELF_HOSTED; // hosted: the only mode that records
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../config');
const { db } = require('../db/database');
const conversion = require('../lib/conversion-events');
const { suggestPlan } = require('../middleware/subscription');

const count = (u, e) => db.prepare('SELECT COUNT(*) AS n FROM conversion_events WHERE user_id = ? AND event = ?').get(u, e).n;

test('records known events, drops unknown ones, once-only events stay once', () => {
  const u = crypto.randomUUID();
  assert.equal(conversion.record(db, { userId: u, event: 'signup' }), true);
  assert.equal(conversion.record(db, { userId: u, event: 'signup' }), false, 'signup is once per account');
  assert.equal(conversion.record(db, { userId: u, event: 'rm -rf' }), false);
  assert.equal(count(u, 'signup'), 1);
});

test('repeated client events with the same meta are deduped; different meta is not', () => {
  const u = crypto.randomUUID();
  conversion.record(db, { userId: u, event: 'upgrade_prompt_shown', meta: { code: 'DEVICE_LIMIT' } });
  conversion.record(db, { userId: u, event: 'upgrade_prompt_shown', meta: { code: 'DEVICE_LIMIT' } });
  conversion.record(db, { userId: u, event: 'upgrade_prompt_shown', meta: { code: 'STORAGE_LIMIT' } });
  assert.equal(count(u, 'upgrade_prompt_shown'), 2);
});

test('meta is reduced to short scalars under safe keys', () => {
  assert.equal(conversion.cleanMeta({ code: 'X', 'bad key': 1, nested: { a: 1 }, n: 3, s: 'y'.repeat(200) }),
    JSON.stringify({ code: 'X', n: 3, s: 'y'.repeat(64) }));
  assert.equal(conversion.cleanMeta('nope'), null);
});

test('self-hosted records nothing', () => {
  const was = config.selfHosted;
  config.selfHosted = true;
  try {
    const u = crypto.randomUUID();
    assert.equal(conversion.record(db, { userId: u, event: 'signup' }), false);
    assert.equal(suggestPlan(null, { devices: 3 }), null, 'and suggests nothing to buy');
  } finally { config.selfHosted = was; }
});

test('suggestPlan names the cheapest paid plan that fits the need', () => {
  const free = db.prepare("SELECT id AS plan_id, price_monthly FROM plans WHERE id = 'free'").get();
  assert.equal(suggestPlan(free, { devices: 3 }).id, 'starter');
  assert.equal(suggestPlan(free, { devices: 9 }).id, 'pro');
  assert.equal(suggestPlan(free, { feature: 'remote_url' }).id, 'pro');
  const pro = db.prepare("SELECT id AS plan_id, price_monthly FROM plans WHERE id = 'pro'").get();
  assert.equal(suggestPlan(pro, { devices: 26 }).id, 'enterprise');
});

test('funnel counts distinct accounts per step within the signup cohort', () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  for (const u of [a, b]) conversion.record(db, { userId: u, event: 'signup' });
  conversion.record(db, { userId: a, event: 'first_pair' });
  conversion.record(db, { userId: crypto.randomUUID(), event: 'first_pair' }); // not in the cohort
  const f = conversion.funnel(db, { days: 7 });
  const step = (e) => f.steps.find((s) => s.event === e).accounts;
  assert.ok(step('signup') >= 2);
  assert.equal(step('first_pair') >= 1 && step('first_pair') <= step('signup'), true);
});

test('the import wizard may report which system was picked, with only the vendor id', () => {
  assert.ok(conversion.CLIENT_EVENTS.has('migrate_vendor_picked'), 'a client may report it');
  const u = crypto.randomUUID();
  assert.equal(conversion.record(db, { userId: u, event: 'migrate_vendor_picked', meta: { vendor: 'magicinfo' } }), true);
  const row = db.prepare("SELECT meta FROM conversion_events WHERE user_id = ? AND event = 'migrate_vendor_picked'").get(u);
  assert.deepEqual(JSON.parse(row.meta), { vendor: 'magicinfo' });
  // Picking it again in the same session is one row, a different system is another.
  assert.equal(conversion.record(db, { userId: u, event: 'migrate_vendor_picked', meta: { vendor: 'magicinfo' } }), false);
  assert.equal(conversion.record(db, { userId: u, event: 'migrate_vendor_picked', meta: { vendor: 'xibo' } }), true);
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'migrate.js'), 'utf8');
  assert.match(view, /api\.trackEvent\('migrate_vendor_picked', \{ vendor: state\.vendor\.id \}\)/, 'the wizard sends the id only');
});
