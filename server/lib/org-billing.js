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

/*
 * billing_accounts: ONE SHAPE FOR "THE THING THAT PAYS", whichever table that is.
 *
 * The sweeps and emails (trial expiry, dunning, renewal reminders, receipts) each read billing
 * state AND who to write to from one row. With the person paying that row is `users`; with the
 * organization paying, the state is on `organizations` and the contact is its owner. The view
 * gives both the same columns, so those readers name the view and never the table:
 *
 *   id               the account: a user id (person pays) or an organization id (organization pays)
 *   owner_user_id    the person to contact (the user themself, or the organization's owner)
 *   organization_id  NULL when the person pays
 *   email, name, role, email_alerts, auth_provider, origin_node_id   the contact's
 *   ...every billing column
 *
 * Recreated by install() for the current billing_source. WRITES still name the table
 * (middleware/subscription.js billingTable()).
 */
const VIEW = 'billing_accounts';
const CONTACT = ['email', 'name', 'role', 'email_alerts', 'email_verified', 'last_login', 'auth_provider', 'created_at'];

function createView(db, src, userCols, orgCols) {
  db.exec(`DROP VIEW IF EXISTS ${VIEW}`);
  const contact = CONTACT.filter((c) => userCols.includes(c));
  if (src === 'org') {
    const bill = MIRRORED.filter((c) => orgCols.includes(c));
    db.exec(`CREATE VIEW ${VIEW} AS SELECT o.id AS id, o.owner_user_id AS owner_user_id, o.id AS organization_id,
      ${contact.map((c) => `u.${c} AS ${c}`).join(', ')}, ${bill.map((c) => `o.${c} AS ${c}`).join(', ')}
      FROM organizations o JOIN users u ON u.id = o.owner_user_id`);
  } else {
    const bill = MIRRORED.filter((c) => userCols.includes(c));
    db.exec(`CREATE VIEW ${VIEW} AS SELECT u.id AS id, u.id AS owner_user_id, NULL AS organization_id,
      ${contact.map((c) => `u.${c} AS ${c}`).join(', ')}, ${bill.map((c) => `u.${c} AS ${c}`).join(', ')}
      FROM users u`);
  }
}

/**
 * Organization pays: the owner's `users` row is now the COPY, of their primary organization, so
 * the many places that still read a person's plan (admin lists, profile payloads) are not stale
 * while they are moved over one at a time.
 */
function reverseSql(cols) {
  const primary = primaryOf('NEW.owner_user_id');
  return `UPDATE users SET ${cols.map((c) => `${c} = NEW.${c}`).join(', ')}
    WHERE id = NEW.owner_user_id AND NEW.id = ${primary}`;
}

const REVERSE_TRIGGERS = ['trg_org_billing_rev_upd', 'trg_org_billing_rev_ins'];
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
  for (const t of [...TRIGGERS, ...REVERSE_TRIGGERS]) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
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

    for (const [name, decl] of Object.entries(ORG_COLUMNS)) {
      if (orgCols.includes(name)) continue;
      db.exec(`ALTER TABLE organizations ADD COLUMN ${name} ${decl}`);
      out.added.push(name);
    }
    const cols = MIRRORED.filter((c) => userCols.includes(c));
    const orgColsNow = columnsOf(db, 'organizations');

    if (source(db) === 'org') {
      // The organization rows are the truth now: the forward mirror must not exist, and the
      // owner's row becomes the copy instead.
      dropTriggers(db);
      db.exec(`CREATE TRIGGER trg_org_billing_rev_upd AFTER UPDATE OF ${cols.join(', ')} ON organizations
        BEGIN ${reverseSql(cols)}; END`);
      /*
       * A person's FIRST organization takes over what the person has: the trial a signup was given
       * (which lives on their row until they have an organization), or the plan an invited member
       * was on when they later start a workspace of their own. Only the first: a second
       * organization starts with what its INSERT says (Free), so nobody gets a second trial by
       * making another one, and an organization a platform admin provisions is not handed the
       * admin's plan.
       */
      db.exec(`CREATE TRIGGER trg_org_billing_rev_ins AFTER INSERT ON organizations
        BEGIN
          UPDATE organizations SET (${cols.join(', ')}) = (SELECT ${cols.map((c) => `u.${c}`).join(', ')} FROM users u WHERE u.id = NEW.owner_user_id)
           WHERE id = NEW.id
             AND (SELECT COUNT(*) FROM organizations x WHERE x.owner_user_id = NEW.owner_user_id) = 1
             AND EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.owner_user_id);
        END`);
      createView(db, 'org', userCols, orgColsNow);
      out.reason = 'billing_source is org';
      out.source = 'org';
      return out;
    }

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
    createView(db, 'user', userCols, orgColsNow);
    out.installed = true;
    out.source = 'user';
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

/**
 * Make the ORGANIZATION the source of truth. Refuses unless every organization currently agrees
 * with its owner (so nothing is lost by the switch). After it: billing writes go to
 * `organizations`, the owner's row is a copy of their primary organization, and an organization
 * that was riding on a sibling's subscription (billing_follows_org) keeps its plan with no Stripe
 * ids, to be dealt with by a person. Returns { ok } or { ok: false, drift }.
 */
function switchToOrganizations(db) {
  if (source(db) === 'org') return { ok: true, already: true };
  install(db, null);
  const d = drift(db);
  if (d.length) return { ok: false, drift: d };
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('billing_source', 'org', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run();
  try { require('./app-settings').__reload(); } catch { /* */ }
  install(db, null);
  return { ok: true };
}

/**
 * Back to the person paying. Each owner's row takes its primary organization's state (it already
 * holds it, through the reverse copy), and the forward mirror resumes.
 * ⚠️ Anything written to a NON-primary organization while organizations paid is overwritten by its
 * owner's state again. The caller is told which organizations that is, before deciding.
 */
function switchToPeople(db, { force = false } = {}) {
  if (source(db) !== 'org') return { ok: true, already: true };
  const userCols = columnsOf(db, 'users');
  const cols = SHARED.filter((c) => userCols.includes(c));
  const lost = db.prepare(`SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id
    WHERE o.id != ${primaryOf('o.owner_user_id')} AND (${cols.map((c) => `o.${c} IS NOT u.${c}`).join(' OR ')} OR o.stripe_subscription_id IS NOT NULL)`).all().map((r) => r.id);
  if (lost.length && !force) return { ok: false, would_overwrite: lost };
  db.prepare("DELETE FROM app_settings WHERE key = 'billing_source'").run();
  try { require('./app-settings').__reload(); } catch { /* */ }
  install(db, null);
  return { ok: true, overwritten: lost };
}

module.exports = { install, drift, source, switchToOrganizations, switchToPeople, MIRRORED, SHARED, PRIMARY_ONLY, TRIGGERS, REVERSE_TRIGGERS, VIEW };
