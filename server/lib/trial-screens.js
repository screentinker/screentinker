'use strict';

/*
 * ONE FREE TRIAL PER SCREEN (hosted only).
 *
 * Seen on production, 2026-10/11: one retailer ran ~29 screens for a month on six Gmail accounts,
 * opening a new 14-day Pro trial as each one lapsed and re-pairing the same screens to it within
 * minutes. Two trials overlapped to get past the 22-screen Pro cap. Nothing in the product noticed.
 *
 * Two parts, both here:
 *
 *   A. trial_screen_ledger. When a screen is paired by an account on a running trial, the screen's
 *      identity is recorded against that account. When ANOTHER account on a running trial later
 *      claims screens that an unpaid trial already used, the third such screen from the same
 *      earlier account is refused (403 TRIAL_SCREEN_USED). One or two pass: on production eight
 *      ordinary accounts each re-used exactly one screen (a person's own laptop browser, a test
 *      panel), and refusing them would be wrong. The hop moved 11-15 screens at a time.
 *
 *   B. suspectTrialReuse(): a REVIEW signal for the platform admins' daily digest, never a block.
 *      A running trial with 3+ screens whose dashboard sign-ins share a network with an account
 *      whose unpaid trial lapsed in the last 60 days. Part A alone cannot catch a determined web
 *      player user: its identity is designed to be thrown away (?reset=, unpair at the screen,
 *      clearing the browser). Shared offices, coworking spaces and mobile carriers share addresses
 *      too, which is why this one is for a person to read and not for the server to act on.
 *
 * WHAT A SCREEN'S IDENTITY IS. device_fingerprints.fingerprint, reduced to the part that names ONE
 * unit (screenKeyOf). The web player's fingerprint is `web-<hw>-<base36 len>-<16 hex install salt>`:
 * the hardware half describes a TV MODEL (two shops with the same Haier panel produce the same
 * value; see the 1.9.22 identity incident in ws/deviceSocket.js), and it drifts with browser
 * updates, so only the salt is used. A bare `web-<hw>-<len>` (old player, or storage that threw) is
 * model-level and is never a key. Every other platform's fingerprint is already per unit (Android
 * ANDROID_ID hash, Tizen stored UUID, roku: channel client id, native serial/machine-id hash).
 * Keys are stored hashed: the ledger never holds a usable device identifier.
 *
 * WHAT IS DELIBERATELY NOT COVERED:
 *   - every path that moves a screen between accounts on purpose: workspace moves (lib/device-
 *     move.js), organization import (lib/trust/import-screens.js), display-link mirrors, reinstall
 *     reclaim. None of them goes through the pairing route, and none of them calls this.
 *   - POST /api/devices/web-player: a display link gets a fresh per-link salt by design, so the
 *     ledger could never match it. Part B covers those accounts.
 *   - self-hosted servers: no trials to protect (signups get Enterprise), and the digest is off.
 *
 * PAID. An account that has ever paid (a Stripe subscription now or before, or a comped / invoiced
 * plan an admin assigned) paid for the screens it used: those screens are not burned.
 *
 * TEAMS. Sharing a workspace or organization is NOT on its own a reason to let a screen through:
 * the hopper controls both accounts, and one invite would make them "one customer". Two accounts
 * count as one team only when an organization they share is PAID FOR (its owner, or the org's own
 * subscription). And the count is per WORKSPACE as well as per account: every invitee still gets a
 * trial of their own (plan limits are per user), so counting only the claimant's own screens let
 * fifteen invitees into one workspace move two re-used screens each, none of them reaching three.
 *
 * RE-ATTRIBUTION. The first trial to use a screen owns its ledger row, so a chain A -> B -> C is
 * measured against A. But a row that has stopped counting (older than LEDGER_TTL, or its account
 * has since paid) is handed to the next trial that pairs the screen; otherwise one paid month on
 * the first account, or a year's wait, would clear that screen for every later trial for good.
 */

const crypto = require('crypto');
const { TRIAL_DAYS } = require('./trial-days');

const DAY = 86400;
/** The third re-used screen from one earlier unpaid trial is refused; the first two pass. */
const REUSE_THRESHOLD = 3;
/** A ledger entry older than this no longer counts (a panel sold on gets a trial eventually). */
const LEDGER_TTL = 365 * DAY;
/** Part B: how recently the other account's unpaid trial lapsed. */
const LAPSED_WINDOW = 60 * DAY;
/** Part B: a trial account is only looked at once it has this many screens. */
const SUSPECT_MIN_SCREENS = 3;

const WEB_SALTED = /^web-[0-9a-z]+-[0-9a-z]+-([0-9a-f]{16})$/;

/** The per-unit part of a fingerprint, hashed, or null when it does not name one unit. */
function screenKeyOf(fingerprint) {
  if (typeof fingerprint !== 'string') return null;
  const fp = fingerprint.trim();
  if (!fp) return null;
  let raw;
  if (fp.startsWith('web-')) {
    const m = fp.match(WEB_SALTED);
    if (!m) return null;                       // bare hardware value: a model, not a unit
    raw = 'w:' + m[1];
  } else {
    if (fp.length < 16) return null;           // too short to be a per-unit id
    raw = 'f:' + fp;
  }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); }
  catch { return false; }
}

function keysForDevice(db, deviceId) {
  const rows = db.prepare('SELECT fingerprint FROM device_fingerprints WHERE device_id = ?').all(deviceId);
  return [...new Set(rows.map((r) => screenKeyOf(r.fingerprint)).filter(Boolean))];
}

/** Same rule ws/deviceSocket.js uses for "the trial is running". */
function trialRunning(plan) {
  return !!(plan && plan.trial_active && plan.plan_id === plan.trial_plan && !plan.stripe_subscription_id);
}

function orgOfWorkspace(db, workspaceId) {
  if (!workspaceId) return null;
  try { const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId); return (r && r.organization_id) || null; }
  catch { return null; }
}

/**
 * Has this account ever paid? A Stripe subscription (current, or a cancelled one: checkout_complete),
 * or a plan an admin assigned by hand (comped, PO, invoice: plan_comped, or a renewal date).
 */
function everPaid(db, userId) {
  if (!userId) return false;
  try {
    const u = db.prepare('SELECT stripe_subscription_id, plan_comped, renewal_at FROM users WHERE id = ?').get(userId);
    if (u && (u.stripe_subscription_id || u.plan_comped || u.renewal_at)) return true;
    return !!db.prepare("SELECT 1 FROM conversion_events WHERE user_id = ? AND event = 'checkout_complete' LIMIT 1").get(userId);
  } catch { return false; }
}

/** Organizations an account belongs to, directly or through a workspace. */
function orgsOf(db, userId) {
  try {
    return new Set(db.prepare(`SELECT organization_id AS id FROM organization_members WHERE user_id = ?
                               UNION SELECT w.organization_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                                WHERE m.user_id = ?`).all(userId, userId).map((r) => r.id).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * Are these two accounts one PAYING team: do they share an organization that is paid for? Sharing an
 * unpaid one does not count (see TEAMS above).
 */
function samePaidTeam(db, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const mine = orgsOf(db, a);
  if (!mine.size) return false;
  for (const id of orgsOf(db, b)) {
    if (!mine.has(id)) continue;
    try {
      const o = db.prepare('SELECT owner_user_id, stripe_subscription_id FROM organizations WHERE id = ?').get(id);
      if (o && (o.stripe_subscription_id || everPaid(db, o.owner_user_id))) return true;
    } catch { /* no organizations table: not a team */ }
  }
  return false;
}

/**
 * The screens an account holds (optionally leaving one device out), each mapped to the earlier
 * account whose trial used it, if any, within LEDGER_TTL. Returns Map<priorUserId, count>.
 * The one definition both Part A and Part B count with.
 */
function heldByPrior(db, userId, { exceptDeviceId = null, workspaceId = null, now }) {
  const out = new Map();
  if (!tableExists(db, 'trial_screen_ledger')) return out;
  const lookup = db.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ? AND first_trial_at >= ?');
  // The claimant's own screens, and (see TEAMS) every screen already in the workspace it pairs into.
  // Only screens that have MOVED count: one still held by the trial that used it is just that
  // teammate's screen, not a re-use.
  // Two indexed selects, not one OR (which cannot use either index on the pairing hot path).
  const rows = db.prepare(`SELECT f.fingerprint, d.user_id AS holder FROM devices d JOIN device_fingerprints f ON f.device_id = d.id
                            WHERE d.user_id = ? AND d.id IS NOT ?
                           UNION
                           SELECT f.fingerprint, d.user_id AS holder FROM devices d JOIN device_fingerprints f ON f.device_id = d.id
                            WHERE ? IS NOT NULL AND d.workspace_id = ? AND d.id IS NOT ?`)
    .all(userId, exceptDeviceId, workspaceId, workspaceId, exceptDeviceId);
  const seen = new Set();
  for (const r of rows) {
    const k = screenKeyOf(r.fingerprint);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const row = lookup.get(k, now - LEDGER_TTL);
    if (row && row.user_id && row.user_id !== userId && row.user_id !== r.holder) out.set(row.user_id, (out.get(row.user_id) || 0) + 1);
  }
  return out;
}

/** An earlier account whose screens count against a new trial: never paid, and not a paying teammate. */
function countsAgainst(db, userId, prior, memo = new Map()) {
  if (!memo.has(prior)) memo.set(prior, !everPaid(db, prior) && !samePaidTeam(db, userId, prior));
  return memo.get(prior);
}

/**
 * Record a just-paired screen against a trialing account. First account wins: a screen burned by
 * one trial stays attributed to it, so a chain A -> B -> C is still measured against A.
 */
function recordTrialScreen(db, { userId, workspaceId, deviceId, plan, now = Math.floor(Date.now() / 1000) }) {
  if (!tableExists(db, 'trial_screen_ledger') || !trialRunning(plan) || everPaid(db, userId)) return 0;
  const org = orgOfWorkspace(db, workspaceId);
  const existing = db.prepare('SELECT user_id, first_trial_at FROM trial_screen_ledger WHERE screen_key = ?');
  const insert = db.prepare(`INSERT INTO trial_screen_ledger (screen_key, user_id, organization_id, first_trial_at, last_seen_at)
                             VALUES (?, ?, ?, ?, ?)`);
  const reassign = db.prepare(`UPDATE trial_screen_ledger SET user_id = ?, organization_id = ?, first_trial_at = ?, last_seen_at = ?
                                WHERE screen_key = ?`);
  const touch = db.prepare('UPDATE trial_screen_ledger SET last_seen_at = ? WHERE screen_key = ?');
  let n = 0;
  for (const key of keysForDevice(db, deviceId)) {
    const row = existing.get(key);
    if (!row) { n += insert.run(key, userId, org, now, now).changes; continue; }
    // See RE-ATTRIBUTION: a row that no longer counts passes to this trial; one that does keeps its owner.
    const stale = row.user_id !== userId && (row.first_trial_at < now - LEDGER_TTL || everPaid(db, row.user_id));
    n += (stale ? reassign.run(userId, org, now, now, key) : touch.run(now, key)).changes;
  }
  return n;
}

/**
 * May this trialing account claim this screen? { allowed, priorUserId?, reused? }.
 * Only a running trial is ever refused; a paying, comped or Free account always passes.
 */
function checkTrialScreen(db, { userId, workspaceId = null, deviceId, plan, now = Math.floor(Date.now() / 1000) }) {
  const ok = { allowed: true };
  if (!tableExists(db, 'trial_screen_ledger') || !trialRunning(plan) || everPaid(db, userId)) return ok;
  const keys = keysForDevice(db, deviceId);
  if (!keys.length) return ok;

  const since = now - LEDGER_TTL;
  const lookup = db.prepare('SELECT user_id FROM trial_screen_ledger WHERE screen_key = ? AND first_trial_at >= ?');
  const burnedBy = new Set();
  for (const k of keys) {
    const row = lookup.get(k, since);
    if (row && row.user_id && row.user_id !== userId) burnedBy.add(row.user_id);
  }
  if (!burnedBy.size) return ok;

  // How many screens this account ALREADY holds that the same earlier account burned.
  const held = heldByPrior(db, userId, { exceptDeviceId: deviceId, workspaceId, now });
  for (const prior of burnedBy) {
    if (!countsAgainst(db, userId, prior)) continue;
    const already = held.get(prior) || 0;
    if (already + 1 >= REUSE_THRESHOLD) return { allowed: false, priorUserId: prior, reused: already + 1 };
  }
  return ok;
}

/** An address reduced to its network: IPv4 as is, IPv6 to its /64 (privacy addresses rotate). */
function netOf(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const s = ip.trim().replace(/^::ffff:/i, '');
  if (!s) return null;
  if (s.includes(':')) {
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0) return null;
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : null;
}

/**
 * Part B. Running trials with SUSPECT_MIN_SCREENS+ screens that share a sign-in network with an
 * account whose unpaid trial lapsed in the last LAPSED_WINDOW, or that hold screens an earlier
 * unpaid trial used. Read-only; the caller decides what to do (today: list it in the digest).
 */
function suspectTrialReuse(db, { now = Math.floor(Date.now() / 1000), trialDays = TRIAL_DAYS } = {}) {
  if (!tableExists(db, 'activity_log')) return [];
  const trials = db.prepare(`SELECT u.id, u.email, u.created_at,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS screens
      FROM users u
     WHERE u.trial_started IS NOT NULL AND u.trial_started + ? > ? AND u.stripe_subscription_id IS NULL
       AND u.plan_id = u.trial_plan`).all(trialDays * DAY, now)
    .filter((u) => u.screens >= SUSPECT_MIN_SCREENS);
  if (!trials.length) return [];

  const lapsed = db.prepare(`SELECT id, email, trial_expired_at FROM users
     WHERE trial_expired_at IS NOT NULL AND trial_expired_at >= ? AND stripe_subscription_id IS NULL`).all(now - LAPSED_WINDOW);
  const ipsOf = db.prepare(`SELECT DISTINCT ip_address AS ip FROM activity_log
     WHERE user_id = ? AND ip_address IS NOT NULL AND ip_address <> '' AND created_at >= ?`);
  const netsOf = (userId) => new Set(ipsOf.all(userId, now - 2 * LAPSED_WINDOW).map((r) => netOf(r.ip)).filter(Boolean));

  const byNet = new Map();   // net -> lapsed accounts seen there
  for (const l of lapsed) {
    if (everPaid(db, l.id)) continue;
    for (const n of netsOf(l.id)) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push(l); }
  }
  const out = [];
  for (const t of trials) {
    const memo = new Map();
    const matched = new Map();
    const shared = new Set();
    for (const n of netsOf(t.id)) {
      for (const l of byNet.get(n) || []) {
        if (l.id === t.id) continue;
        const key = 'team:' + l.id;   // memoized: a shared carrier / coworking address repeats the same pairs
        if (!memo.has(key)) memo.set(key, samePaidTeam(db, t.id, l.id));
        if (memo.get(key)) continue;
        matched.set(l.id, l); shared.add(n);
      }
    }
    // Screens on this account that another unpaid account's trial already used (same rule as Part A).
    let reused = 0;
    for (const [prior, n] of heldByPrior(db, t.id, { now })) if (countsAgainst(db, t.id, prior, memo)) reused += n;
    if (!matched.size && !reused) continue;
    out.push({
      user_id: t.id, email: t.email, created_at: t.created_at, screens: t.screens, reused_screens: reused,
      shared_networks: [...shared],
      lapsed_accounts: [...matched.values()].map((l) => ({ user_id: l.id, email: l.email, trial_expired_at: l.trial_expired_at })),
    });
  }
  return out;
}

/**
 * One-time seed (db/database.js): every screen currently on an account that is trialing, or whose
 * trial lapsed unpaid, is recorded against that account. Without it the ledger starts empty and
 * the screens already being hopped between accounts would pass.
 */
function backfillLedger(db, { now = Math.floor(Date.now() / 1000), trialDays = TRIAL_DAYS } = {}) {
  if (!tableExists(db, 'trial_screen_ledger')) return 0;
  const rows = db.prepare(`SELECT f.fingerprint, d.user_id, d.workspace_id,
        COALESCE(u.trial_started, u.trial_expired_at - ?, u.created_at) AS at
      FROM device_fingerprints f JOIN devices d ON d.id = f.device_id JOIN users u ON u.id = d.user_id
     WHERE u.stripe_subscription_id IS NULL
       AND ((u.trial_started IS NOT NULL AND u.plan_id = u.trial_plan) OR u.trial_expired_at IS NOT NULL)
     ORDER BY at ASC`).all(trialDays * DAY);
  const ins = db.prepare(`INSERT OR IGNORE INTO trial_screen_ledger (screen_key, user_id, organization_id, first_trial_at, last_seen_at)
                          VALUES (?, ?, ?, ?, ?)`);
  let n = 0;
  for (const r of rows) {
    const k = screenKeyOf(r.fingerprint);
    if (!k || everPaid(db, r.user_id)) continue;
    n += ins.run(k, r.user_id, orgOfWorkspace(db, r.workspace_id), Math.min(r.at || now, now), now).changes;
  }
  return n;
}

/**
 * Account deletion. An unpaid trial's screens stay burned but the ledger no longer names the person;
 * a paid account's rows are deleted, since once its payment history is gone the tombstone would look
 * unpaid and wrongly burn screens it paid for. Call BEFORE the users row and conversion_events go.
 */
function anonymizeUser(db, userId) {
  if (!tableExists(db, 'trial_screen_ledger')) return 0;
  if (everPaid(db, userId)) return db.prepare('DELETE FROM trial_screen_ledger WHERE user_id = ?').run(userId).changes;
  const tomb = 'deleted:' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);
  return db.prepare('UPDATE trial_screen_ledger SET user_id = ? WHERE user_id = ?').run(tomb, userId).changes;
}

module.exports = {
  screenKeyOf, trialRunning, samePaidTeam, everPaid, recordTrialScreen, checkTrialScreen, suspectTrialReuse,
  backfillLedger, anonymizeUser, netOf, REUSE_THRESHOLD, LEDGER_TTL, LAPSED_WINDOW, SUSPECT_MIN_SCREENS,
};
