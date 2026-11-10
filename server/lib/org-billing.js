'use strict';

/*
 * THE ORGANIZATION'S COPY OF ITS BILLING STATE (step 1 of moving payment from the person to the
 * organization).
 *
 * Today the account that pays is a row in `users`: plan, trial, Stripe customer and subscription,
 * status, the dunning clock, the comp flag and the once-only email stamps all live there, and
 * every limit is read through it. `organizations` has carried most of the same columns since the
 * multi-tenancy migration, written once when the organization is created and never again, which is
 * why nothing reads them (see the warning in routes/admin.js GET /plans).
 *
 * This module makes that copy TRUE and keeps it true, and changes nothing else:
 *
 *   - the columns the organization was missing are added;
 *   - every organization is filled from its owner;
 *   - database triggers repeat any later change to an owner's billing columns onto the
 *     organizations that person owns, and re-fill an organization when it is created, changes
 *     owner or a sibling is deleted.
 *
 * Triggers, not calls at the write sites, because the write sites are many (Stripe webhooks,
 * the trial and dunning sweeps, admin assignment, self-healing reads in getUserPlan, one-off SQL
 * run by an operator) and a copy that misses one of them is worse than no copy.
 *
 * ⚠️ `users` IS STILL THE SOURCE OF TRUTH. Nothing in the product reads the organization's copy
 * yet. `app_settings.billing_source` says which side is authoritative: absent or 'user' means this
 * mirror runs; 'org' (a later step) means the organization rows are the truth, and then the
 * triggers are REMOVED and the fill is skipped, or they would overwrite it.
 *
 * ONE PERSON, SEVERAL ORGANIZATIONS. Today such a person's plan covers all of them, because limits
 * follow the person. The copy records that honestly instead of inventing a subscription per
 * organization: the oldest organization they own is the PRIMARY and holds the Stripe ids; every
 * other one gets the same plan and status with NO Stripe ids, and `billing_follows_org` naming the
 * primary. That column is the list of cases a human has to decide when payment really moves.
 */

/** Copied to every organization the person owns. */
const SHARED = [
  'plan_id', 'subscription_status', 'subscription_ends',
  'trial_started', 'trial_plan', 'trial_expired_at',
  'trial_ending_email_sent_at', 'trial_expired_email_sent_at',
  'renewal_at', 'past_due_since', 'payment_failed_email_sent_at', 'subscription_lapsed_email_sent_at',
  'plan_comped',
];
/** Copied to the primary organization only: one Stripe subscription cannot belong to two. */
const PRIMARY_ONLY = ['stripe_customer_id', 'stripe_subscription_id'];
const MIRRORED = [...SHARED, ...PRIMARY_ONLY];

/** Columns `organizations` may lack (an older table, or one this feature has not touched yet). */
const ORG_COLUMNS = {
  plan_id: "TEXT DEFAULT 'free'",
  stripe_customer_id: 'TEXT',
  stripe_subscription_id: 'TEXT',
  subscription_status: "TEXT DEFAULT 'active'",
  subscription_ends: 'INTEGER',
  trial_started: 'INTEGER',
  trial_plan: 'TEXT',
  trial_expired_at: 'INTEGER',
  trial_ending_email_sent_at: 'INTEGER',
  trial_expired_email_sent_at: 'INTEGER',
  renewal_at: 'INTEGER',
  past_due_since: 'INTEGER',
  payment_failed_email_sent_at: 'INTEGER',
  subscription_lapsed_email_sent_at: 'INTEGER',
  plan_comped: 'INTEGER NOT NULL DEFAULT 0',
  billing_follows_org: 'TEXT',
};

const TRIGGERS = ['trg_org_billing_user_ins', 'trg_org_billing_user_upd', 'trg_org_billing_org_ins', 'trg_org_billing_org_owner', 'trg_org_billing_org_del'];

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** The oldest organization `ownerExpr` owns: the one that holds the Stripe ids. */
const primaryOf = (ownerExpr) =>
  `(SELECT p.id FROM organizations p WHERE p.owner_user_id = ${ownerExpr} ORDER BY p.created_at ASC, p.id ASC LIMIT 1)`;

/**
 * One UPDATE that makes the organizations matching `where` agree with their owners. `cols` are the
 * users columns that exist in THIS database (an older one may lack the newer stamps).
 */
function syncSql(cols, where) {
  const shared = SHARED.filter((c) => cols.includes(c));
  const primaryOnly = PRIMARY_ONLY.filter((c) => cols.includes(c));
  const primary = primaryOf('organizations.owner_user_id');
  const sets = [
    `(${shared.join(', ')}) = (SELECT ${shared.map((c) => `u.${c}`).join(', ')} FROM users u WHERE u.id = organizations.owner_user_id)`,
    ...primaryOnly.map((c) => `${c} = CASE WHEN organizations.id = ${primary}
        THEN (SELECT u.${c} FROM users u WHERE u.id = organizations.owner_user_id) ELSE NULL END`),
    `billing_follows_org = CASE WHEN organizations.id = ${primary} THEN NULL ELSE ${primary} END`,
  ];
  // An organization whose owner row is gone keeps what it has rather than being nulled.
  return `UPDATE organizations SET ${sets.join(',\n      ')}
    WHERE ${where} AND EXISTS (SELECT 1 FROM users u WHERE u.id = organizations.owner_user_id)`;
}

function source(db) {
  try {
    const r = db.prepare("SELECT value FROM app_settings WHERE key = 'billing_source'").get();
    return r && r.value === 'org' ? 'org' : 'user';
  } catch { return 'user'; }
}

function dropTriggers(db) {
  for (const t of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
}

/**
 * Add the columns, (re)create the triggers, fill every organization. Safe on every boot. Returns
 * what it did, for the boot log and the tests. Never throws: a database this cannot be installed
 * on (no organizations table yet, a single-tenant install) simply has no mirror.
 */
function install(db, log = console) {
  const out = { installed: false, added: [], filled: 0, reason: null };
  try {
    const orgCols = columnsOf(db, 'organizations');
    if (!orgCols.length || !orgCols.includes('owner_user_id')) { out.reason = 'no organizations table'; return out; }
    const userCols = columnsOf(db, 'users');
    if (!userCols.includes('plan_id')) { out.reason = 'users has no plan column'; return out; }

    if (source(db) === 'org') {
      // The organization rows are the truth now: this mirror must not exist.
      dropTriggers(db);
      out.reason = 'billing_source is org';
      return out;
    }

    for (const [name, decl] of Object.entries(ORG_COLUMNS)) {
      if (orgCols.includes(name)) continue;
      db.exec(`ALTER TABLE organizations ADD COLUMN ${name} ${decl}`);
      out.added.push(name);
    }
    const cols = MIRRORED.filter((c) => userCols.includes(c));

    // Recreated every boot so a change to this file reaches a database that already has them.
    dropTriggers(db);
    db.exec(`CREATE TRIGGER trg_org_billing_user_upd AFTER UPDATE OF ${cols.join(', ')} ON users
      BEGIN ${syncSql(cols, 'organizations.owner_user_id = NEW.id')}; END`);
    // An import or a replica can write the organization before the person it belongs to.
    db.exec(`CREATE TRIGGER trg_org_billing_user_ins AFTER INSERT ON users
      BEGIN ${syncSql(cols, 'organizations.owner_user_id = NEW.id')}; END`);
    db.exec(`CREATE TRIGGER trg_org_billing_org_ins AFTER INSERT ON organizations
      BEGIN ${syncSql(cols, 'organizations.owner_user_id = NEW.owner_user_id')}; END`);
    db.exec(`CREATE TRIGGER trg_org_billing_org_owner AFTER UPDATE OF owner_user_id ON organizations
      BEGIN ${syncSql(cols, 'organizations.owner_user_id IN (NEW.owner_user_id, OLD.owner_user_id)')}; END`);
    db.exec(`CREATE TRIGGER trg_org_billing_org_del AFTER DELETE ON organizations
      BEGIN ${syncSql(cols, 'organizations.owner_user_id = OLD.owner_user_id')}; END`);

    out.filled = db.prepare(syncSql(cols, '1 = 1')).run().changes;
    out.installed = true;
    if (out.added.length && log) log.log(`[migrate] organizations: added billing columns ${out.added.join(', ')}`);
  } catch (e) {
    out.reason = e.message;
    // A half-installed mirror must not be able to fail a billing write on `users`.
    try { dropTriggers(db); } catch { /* */ }
    if (log) log.error(`[org-billing] mirror not installed: ${e.message}`);
  }
  return out;
}

/**
 * Every place the organization's copy disagrees with its owner: [{ organization_id, column,
 * organization, owner }]. Empty when the mirror is doing its job.
 */
function drift(db) {
  const orgCols = columnsOf(db, 'organizations');
  const userCols = columnsOf(db, 'users');
  if (!orgCols.includes('owner_user_id')) return [];
  const cols = MIRRORED.filter((c) => userCols.includes(c) && orgCols.includes(c));
  const rows = db.prepare(`SELECT o.id AS organization_id, ${primaryOf('o.owner_user_id')} AS primary_id,
      ${orgCols.includes('billing_follows_org') ? 'o.billing_follows_org' : 'NULL'} AS follows,
      ${cols.map((c) => `o.${c} AS o_${c}, u.${c} AS u_${c}`).join(', ')}
    FROM organizations o JOIN users u ON u.id = o.owner_user_id`).all();
  const out = [];
  for (const r of rows) {
    const isPrimary = r.organization_id === r.primary_id;
    for (const c of cols) {
      const want = (PRIMARY_ONLY.includes(c) && !isPrimary) ? null : r[`u_${c}`];
      if ((r[`o_${c}`] ?? null) !== (want ?? null)) out.push({ organization_id: r.organization_id, column: c, organization: r[`o_${c}`] ?? null, owner: want ?? null });
    }
    const wantFollows = isPrimary ? null : r.primary_id;
    if ((r.follows ?? null) !== wantFollows) out.push({ organization_id: r.organization_id, column: 'billing_follows_org', organization: r.follows ?? null, owner: wantFollows });
  }
  return out;
}

module.exports = { install, drift, source, MIRRORED, SHARED, PRIMARY_ONLY, TRIGGERS };
