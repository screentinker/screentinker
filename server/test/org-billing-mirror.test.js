'use strict';

/*
 * AN ORGANIZATION'S COPY OF ITS BILLING STATE AGREES WITH ITS OWNER, ALWAYS.
 *
 * Payment is moving from the person to the organization. The first step changes no behaviour: the
 * organization row is given a true copy of its owner's plan, trial, Stripe ids, status, dunning
 * clock and comp flag, kept in step by database triggers (lib/org-billing.js). Everything later
 * (reading limits from the organization, charging it) stands on that copy being right, so this
 * file is about one thing: after ANY write to a person's billing state, by any route, no
 * organization they own disagrees with them.
 *
 * It drives the real writers (the trial expiry, the dunning helpers, plan restore), the statements
 * the Stripe webhook runs, a hand-typed operator UPDATE, and the organization lifecycle (created,
 * handed to someone else, deleted), and checks `drift()` is empty after each.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-orgbilling-' + crypto.randomBytes(4).toString('hex'));
const { db } = require('../db/database');
const orgBilling = require('../lib/org-billing');
const sub = require('../middleware/subscription');

const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();

function person(fields = {}) {
  const uid = id();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id) VALUES (?, ?, 'P', 'x', 'local', 'user', 'free')`)
    .run(uid, uid + '@example.com');
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), uid);
  return uid;
}
function org(ownerId, createdAt) {
  const oid = id();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(oid, 'Org ' + oid.slice(0, 4), ownerId, createdAt || now());
  return oid;
}
const orgRow = (oid) => db.prepare('SELECT * FROM organizations WHERE id = ?').get(oid);
const userRow = (uid) => db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
const agree = (label) => assert.deepEqual(orgBilling.drift(db), [], `organizations agree with their owners after: ${label}`);

before(() => {
  for (const p of [['free', 2], ['pro', 25], ['enterprise', -1], ['starter', 8]]) {
    db.prepare(`INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES (?, ?, ?, ?, 1000)`).run(p[0], p[0], p[0], p[1]);
  }
});

test('the mirror is installed on a normal database, with the columns it needs', () => {
  const cols = db.prepare('PRAGMA table_info(organizations)').all().map((c) => c.name);
  for (const c of [...orgBilling.MIRRORED, 'billing_follows_org']) assert.ok(cols.includes(c), 'organizations.' + c);
  const trig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_org_billing_%'").all().map((r) => r.name).sort();
  assert.deepEqual(trig, [...orgBilling.TRIGGERS].sort());
  assert.equal(orgBilling.source(db), 'user', 'the person is still the source of truth');
});

test('a new organization starts as a copy of its owner, whatever the INSERT said', () => {
  const u = person({ plan_id: 'pro', trial_started: now(), trial_plan: 'pro' });
  const oid = id();
  // The oldest writer in the codebase copies four columns by hand; a stale or missing copy is corrected.
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, 'X', ?, 'free', 'active')`).run(oid, u);
  assert.equal(orgRow(oid).plan_id, 'pro');
  assert.equal(orgRow(oid).trial_plan, 'pro');
  agree('organization created');
});

test('the statements the Stripe webhook runs reach the organization', () => {
  const u = person({ plan_id: 'pro', trial_started: now(), trial_plan: 'pro' });
  const o = org(u);
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_1', u); agree('customer created');
  db.prepare(`UPDATE users SET stripe_subscription_id = ?, plan_id = ?, plan_comped = 0, subscription_status = 'active', trial_started = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
    .run('sub_1', 'starter', u); agree('checkout completed');
  assert.equal(orgRow(o).stripe_subscription_id, 'sub_1');
  assert.equal(orgRow(o).plan_id, 'starter');
  assert.equal(orgRow(o).trial_started, null);
  db.prepare(`UPDATE users SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE COALESCE(?, plan_id) END, subscription_status = ?, subscription_ends = ? WHERE id = ?`)
    .run('pro', 'past_due', now() + 86400, u); agree('subscription updated');
  db.prepare(`UPDATE users SET plan_id = CASE WHEN plan_comped = 1 THEN plan_id ELSE 'free' END, subscription_status = 'cancelled', stripe_subscription_id = NULL WHERE id = ?`).run(u);
  agree('subscription deleted');
  assert.equal(orgRow(o).plan_id, 'free');
  assert.equal(orgRow(o).stripe_subscription_id, null);
});

test('the real trial and dunning writers reach the organization', () => {
  const u = person({ plan_id: 'pro', trial_started: now() - 20 * 86400, trial_plan: 'pro' });
  const o = org(u);
  sub.expireTrial(u); agree('expireTrial');
  assert.equal(orgRow(o).plan_id, userRow(u).plan_id);
  assert.equal(orgRow(o).trial_expired_at, userRow(u).trial_expired_at);
  const payer = person({ plan_id: 'pro', stripe_customer_id: 'cus_2', stripe_subscription_id: 'sub_2' });
  const po = org(payer);
  sub.startGrace(payer); agree('startGrace');
  assert.equal(orgRow(po).subscription_status, 'past_due');
  assert.ok(orgRow(po).past_due_since);
  sub.clearGrace(payer); agree('clearGrace');
  sub.startGrace(payer, now() - 30 * 86400);
  sub.downgradeLapsed(payer); agree('downgradeLapsed');
  assert.equal(orgRow(po).plan_id, 'free');
  sub.restorePlan(payer, 'pro'); agree('restorePlan');
  assert.equal(orgRow(po).plan_id, 'pro');
  // getUserPlan heals an expired trial as a side effect of being READ.
  const lazy = person({ plan_id: 'pro', trial_started: now() - 40 * 86400, trial_plan: 'pro' });
  org(lazy);
  sub.getUserPlan(lazy); agree('getUserPlan self-heal');
});

test('an operator typing SQL, and a comp, reach the organization', () => {
  const u = person();
  const o = org(u);
  db.prepare("UPDATE users SET plan_id = 'enterprise', plan_comped = 1, renewal_at = ? WHERE id = ?").run(now() + 90 * 86400, u);
  agree('hand-typed comp');
  assert.equal(orgRow(o).plan_comped, 1);
  assert.equal(orgRow(o).plan_id, 'enterprise');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Renamed', u);   // not a billing column: nothing to do, nothing breaks
  agree('unrelated user edit');
});

test('one person, several organizations: all carry the plan, only the oldest carries the Stripe ids', () => {
  const u = person({ plan_id: 'pro', stripe_customer_id: 'cus_3', stripe_subscription_id: 'sub_3' });
  const oldest = org(u, 1000), middle = org(u, 2000), newest = org(u, 3000);
  agree('three organizations');
  for (const o of [oldest, middle, newest]) assert.equal(orgRow(o).plan_id, 'pro');
  assert.equal(orgRow(oldest).stripe_subscription_id, 'sub_3');
  assert.equal(orgRow(oldest).billing_follows_org, null);
  for (const o of [middle, newest]) {
    assert.equal(orgRow(o).stripe_subscription_id, null, 'one subscription is not written onto two organizations');
    assert.equal(orgRow(o).stripe_customer_id, null);
    assert.equal(orgRow(o).billing_follows_org, oldest, 'and it says whose subscription covers it');
  }
  db.prepare('DELETE FROM organizations WHERE id = ?').run(oldest);
  agree('the primary organization deleted');
  assert.equal(orgRow(middle).stripe_subscription_id, 'sub_3', 'the next oldest becomes the primary');
  assert.equal(orgRow(newest).billing_follows_org, middle);
});

test('an organization handed to someone else takes the new owner\'s state, and both sides stay right', () => {
  const a = person({ plan_id: 'pro', stripe_customer_id: 'cus_a', stripe_subscription_id: 'sub_a' });
  const b = person({ plan_id: 'free' });
  const a1 = org(a, 1000), a2 = org(a, 2000), b1 = org(b, 1500);
  db.prepare('UPDATE organizations SET owner_user_id = ? WHERE id = ?').run(b, a1);
  agree('ownership transferred');
  assert.equal(orgRow(a1).plan_id, 'free', 'today the plan is the owner\'s, so it follows the new owner');
  assert.equal(orgRow(a1).stripe_subscription_id, null);
  assert.equal(orgRow(a2).stripe_subscription_id, 'sub_a', 'the old owner\'s remaining organization is now their primary');
  assert.equal(orgRow(a2).billing_follows_org, null);
  assert.equal(orgRow(b1).billing_follows_org, a1, 'and the new owner\'s primary is now the older, transferred one');
});

test('an organization written before its owner (an import) is filled when the owner arrives', () => {
  const uid = id(), oid = id();
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(oid, 'Imported', uid);
    db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id) VALUES (?, ?, 'P', 'x', 'local', 'user', 'pro')`).run(uid, uid + '@example.com');
  } finally { db.pragma('foreign_keys = ON'); }
  agree('owner inserted after the organization');
  assert.equal(orgRow(oid).plan_id, 'pro');
});

test('installing again changes nothing, and repairs a copy that was tampered with', () => {
  const u = person({ plan_id: 'pro' });
  const o = org(u);
  db.exec("DROP TRIGGER trg_org_billing_user_upd");
  db.prepare("UPDATE users SET plan_id = 'starter' WHERE id = ?").run(u);
  assert.notDeepEqual(orgBilling.drift(db), [], 'without the trigger the copy goes stale (this is what the mirror prevents)');
  const r = orgBilling.install(db, null);
  assert.equal(r.installed, true);
  assert.deepEqual(r.added, [], 'no column is added twice');
  agree('reinstall');
  assert.equal(orgRow(o).plan_id, 'starter');
  assert.deepEqual(orgBilling.install(db, null).added, []);
  agree('third install');
});

test('once the organization is the source of truth, the copy runs the other way and nothing overwrites it', () => {
  const u = person({ plan_id: 'pro' });
  const o = org(u);
  const r = orgBilling.switchToOrganizations(db);
  assert.equal(r.ok, true);
  try {
    assert.equal(orgBilling.source(db), 'org');
    const trig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_org_billing_%'").all().map((x) => x.name).sort();
    assert.deepEqual(trig, [...orgBilling.REVERSE_TRIGGERS].sort(), 'only the organization-to-owner copy remains');
    db.prepare("UPDATE organizations SET plan_id = 'enterprise', stripe_subscription_id = 'sub_org' WHERE id = ?").run(o);
    assert.equal(userRow(u).plan_id, 'enterprise', 'the owner\'s row follows their organization');
    assert.equal(userRow(u).stripe_subscription_id, 'sub_org');
    db.prepare("UPDATE users SET plan_id = 'free' WHERE id = ?").run(u);
    orgBilling.install(db, null);
    assert.equal(orgRow(o).plan_id, 'enterprise', 'a person-side write and a reinstall do not touch the organization');
    // The shared view now presents organizations, with the owner as the contact.
    const acct = db.prepare('SELECT * FROM billing_accounts WHERE id = ?').get(o);
    assert.equal(acct.organization_id, o); assert.equal(acct.owner_user_id, u);
    assert.equal(acct.plan_id, 'enterprise'); assert.equal(acct.email, userRow(u).email);
  } finally {
    db.prepare("UPDATE organizations SET stripe_subscription_id = NULL WHERE id = ?").run(o);
    assert.equal(orgBilling.switchToPeople(db, { force: true }).ok, true);
  }
  assert.equal(orgBilling.source(db), 'user');
  agree('switched back to people');
  const acct = db.prepare('SELECT * FROM billing_accounts WHERE id = ?').get(u);
  assert.equal(acct.organization_id, null); assert.equal(acct.owner_user_id, u);
});

test('the switch to organizations is refused while any organization disagrees with its owner', () => {
  const u = person({ plan_id: 'pro' });
  const o = org(u);
  db.exec('DROP TRIGGER trg_org_billing_user_upd');
  db.prepare("UPDATE users SET plan_id = 'starter' WHERE id = ?").run(u);
  // switchToOrganizations reinstalls first, which repairs the copy, so the switch is safe by construction...
  const r = orgBilling.switchToOrganizations(db);
  assert.equal(r.ok, true);
  assert.equal(orgRow(o).plan_id, 'starter', '...and what it switched to is the owner\'s current state, not the stale copy');
  assert.equal(orgBilling.switchToPeople(db, { force: true }).ok, true);
  agree('round trip');
});

test('switching back says which organizations would lose their own state, and waits to be told', () => {
  const u = person({ plan_id: 'pro', stripe_subscription_id: 'sub_p' });
  const first = org(u, 100), second = org(u, 200);
  assert.equal(orgBilling.switchToOrganizations(db).ok, true);
  db.prepare("UPDATE organizations SET plan_id = 'starter', stripe_subscription_id = 'sub_second' WHERE id = ?").run(second);
  const r = orgBilling.switchToPeople(db);
  assert.equal(r.ok, false);
  assert.ok(r.would_overwrite.includes(second) && !r.would_overwrite.includes(first));
  assert.equal(orgBilling.source(db), 'org', 'nothing was switched');
  assert.equal(orgBilling.switchToPeople(db, { force: true }).ok, true);
  agree('forced back');
});

test('a database with no organizations table is left alone, and billing writes still work', () => {
  const Database = require('better-sqlite3');
  const bare = new Database(':memory:');
  bare.exec("CREATE TABLE users (id TEXT PRIMARY KEY, plan_id TEXT DEFAULT 'free'); INSERT INTO users (id) VALUES ('u1');");
  const r = orgBilling.install(bare, null);
  assert.equal(r.installed, false);
  bare.prepare("UPDATE users SET plan_id = 'pro' WHERE id = 'u1'").run();
  assert.deepEqual(orgBilling.drift(bare), []);
  bare.close();
});
