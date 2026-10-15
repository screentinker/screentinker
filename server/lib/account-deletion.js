'use strict';

/*
 * Self-service account deletion (routes/auth.js GET /me/deletion and DELETE /me).
 *
 * Google Play requires an app with accounts to let people delete them, and the privacy policy has
 * always promised "Delete your account and all associated data from Settings". The data side is
 * lib/user-deletion.js deleteUserCascade, the same cascade a platform admin's delete uses; this
 * module holds what is different about a person deleting THEMSELVES:
 *
 *   - Proof that the person is at the keyboard, not just a session. A password account types its
 *     password (and its TOTP or recovery code when two-factor is on). An account with no password
 *     (single sign-on, or a passwordless local account) has nothing to type, so it proves presence
 *     by having SIGNED IN within the last REAUTH_WINDOW_S seconds: the token's `auth_time` claim,
 *     which only a sign-in finisher sets (middleware/auth.js generateToken). A stolen week-old
 *     session therefore cannot delete anything; the person must go through their identity provider
 *     again, which is where their MFA and conditional access live.
 *   - What would be refused, said up front (GET /me/deletion), so the dialog can explain it before
 *     anyone types a password: a shared organization they own, being the last platform admin.
 *   - Their Stripe subscriptions, cancelled BEFORE anything is deleted. The other order would leave
 *     a deleted account still being charged, with no account left to cancel from.
 */

const REAUTH_WINDOW_S = 10 * 60;
const PLATFORM_ROLES = ['superadmin', 'platform_admin'];

const nowSec = () => Math.floor(Date.now() / 1000);
const tableHas = (db, table, col) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
};

/** A signed-in person proves presence by password, or (no password) by a sign-in this recent. */
function reauthMethod(user) {
  return user && user.auth_provider === 'local' && user.password_hash ? 'password' : 'recent_sign_in';
}

function recentSignIn(authTime, now = nowSec()) {
  return Number.isInteger(authTime) && authTime <= now + 60 && now - authTime <= REAUTH_WINDOW_S;
}

/**
 * Deleting this account would leave the server with no platform admin: nobody could manage users,
 * plans or updates again short of the break-glass script. Disabled (SCIM-deactivated) admins do not
 * count as another admin, because they cannot sign in either.
 */
function isLastPlatformAdmin(db, user) {
  if (!user || !PLATFORM_ROLES.includes(user.role)) return false;
  const disabled = tableHas(db, 'users', 'disabled_at') ? ' AND disabled_at IS NULL' : '';
  const others = db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE id != ? AND role IN (${PLATFORM_ROLES.map(() => '?').join(',')})${disabled}`,
  ).get(user.id, ...PLATFORM_ROLES).c;
  return others === 0;
}

/** The platform admin who inherits a legacy row nobody else owns (user-deletion.js step 2b). */
function fallbackOwner(db, userId) {
  const row = db.prepare(
    `SELECT id FROM users WHERE id != ? AND role IN (${PLATFORM_ROLES.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 1`,
  ).get(userId, ...PLATFORM_ROLES);
  return row ? row.id : null;
}

/** The organizations the person owns: the ones that go with them, and the ones that block it. */
function ownedOrganizations(db, userId) {
  const { listOwnedOrgsWithSharing } = require('./user-deletion');
  const owned = listOwnedOrgsWithSharing(db, userId);
  const count = (sql, ...a) => { try { return db.prepare(sql).get(...a).c; } catch { return 0; } };
  return owned.map((o) => {
    const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(o.id) || { id: o.id, name: '' };
    const inOrg = 'SELECT id FROM workspaces WHERE organization_id = ?';
    return {
      id: org.id,
      name: org.name,
      shared: o.shared,
      members: count('SELECT COUNT(DISTINCT user_id) AS c FROM (SELECT user_id FROM organization_members WHERE organization_id = ? UNION SELECT wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ?)', org.id, org.id),
      workspaces: count('SELECT COUNT(*) AS c FROM workspaces WHERE organization_id = ?', org.id),
      screens: count(`SELECT COUNT(*) AS c FROM devices WHERE workspace_id IN (${inOrg})`, org.id),
      content: count(`SELECT COUNT(*) AS c FROM content WHERE workspace_id IN (${inOrg})`, org.id),
      playlists: count(`SELECT COUNT(*) AS c FROM playlists WHERE workspace_id IN (${inOrg})`, org.id),
    };
  });
}

const LIVE_SUB = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

/** Is this account paying for something right now (as far as this server knows)? */
function hasActiveSubscription(user) {
  return !!(user && user.stripe_subscription_id && LIVE_SUB.has(String(user.subscription_status || 'active')));
}

/** What GET /me/deletion answers: everything the dialog needs to explain before asking. */
function deletionInfo(db, user, { authTime, sessionKind = 'user', now = nowSec() } = {}) {
  const orgs = ownedOrganizations(db, user.id);
  const method = reauthMethod(user);
  let blocked = null;
  if (sessionKind !== 'user') blocked = 'session_not_eligible';
  else if (isLastPlatformAdmin(db, user)) blocked = 'last_platform_admin';
  else if (orgs.some((o) => o.shared)) blocked = 'org_has_other_members';
  const memberships = (() => {
    try {
      return db.prepare(`SELECT COUNT(DISTINCT w.organization_id) AS c FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
                          WHERE wm.user_id = ? AND w.organization_id NOT IN (SELECT id FROM organizations WHERE owner_user_id = ?)`).get(user.id, user.id).c;
    } catch { return 0; }
  })();
  return {
    email: user.email,
    blocked,
    reauth: {
      method,
      totp_required: method === 'password' && !!user.totp_enabled,
      recent_sign_in: recentSignIn(authTime, now),
      window_seconds: REAUTH_WINDOW_S,
      sso_start: method === 'recent_sign_in' ? ssoStartPath(user) : null,
    },
    owned_organizations: orgs,
    other_organizations: memberships,
    subscription: { active: hasActiveSubscription(user), status: user.subscription_status || null, plan_id: user.plan_id || null },
  };
}

/** Where this account signs in again: its own provider's start URL, or null (use the login page). */
function ssoStartPath(user) {
  if (!user || user.auth_provider === 'local') return null;
  try {
    const p = require('./oidc-providers').get(user.auth_provider);
    if (!p) return null;
    return `/api/auth/${p.kind === 'saml' ? 'saml' : 'oidc'}/${encodeURIComponent(p.slug)}/start`;
  } catch { return null; }
}

/*
 * Cancel every Stripe subscription this account pays for, immediately (not at period end: the
 * account is about to stop existing, so there is no period left to serve). Collected from the
 * user row, the organizations that go with them, and Stripe's own list for their customer, which
 * also catches the duplicate a double-clicked checkout leaves (routes/stripe.js webhook notes).
 *
 * Throws on the first failure, so the caller deletes nothing: an account that is gone while its
 * card is still charged is the worst outcome available. An id Stripe no longer knows is fine.
 * `stripe` is lib/stripe-client.get() (null on a server without billing: nothing to do).
 */
async function cancelSubscriptions(db, user, soloOrgIds, stripe) {
  if (!stripe) return [];
  const ids = new Set();
  if (user.stripe_subscription_id) ids.add(user.stripe_subscription_id);
  if (soloOrgIds.length && tableHas(db, 'organizations', 'stripe_subscription_id')) {
    for (const r of db.prepare(`SELECT stripe_subscription_id AS s FROM organizations WHERE id IN (${soloOrgIds.map(() => '?').join(',')})`).all(...soloOrgIds)) {
      if (r.s) ids.add(r.s);
    }
  }
  if (user.stripe_customer_id) {
    const list = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all', limit: 100 });
    for (const sub of (list && list.data) || []) {
      if (sub && sub.id && !['canceled', 'incomplete_expired'].includes(sub.status)) ids.add(sub.id);
    }
  }
  const cancelled = [];
  for (const id of ids) {
    try {
      await stripe.subscriptions.cancel(id);
      cancelled.push(id);
    } catch (e) {
      // Already cancelled or never existed in this Stripe account: nothing is being charged.
      if (e && (e.code === 'resource_missing' || e.statusCode === 404)) continue;
      throw e;
    }
  }
  return cancelled;
}

module.exports = {
  REAUTH_WINDOW_S, reauthMethod, recentSignIn, isLastPlatformAdmin, fallbackOwner,
  ownedOrganizations, deletionInfo, cancelSubscriptions, hasActiveSubscription,
};
