'use strict';

/*
 * WHAT CHANGES FOR WHOM when limits are counted per ORGANIZATION instead of per PERSON.
 *
 * Read-only. Given a database, it works out for every screen whether it is allowed to play under
 * today's rule and under the organization rule, and reports only the differences, plus the cases a
 * human has to decide before payment can move (lib/org-billing.js):
 *
 *   TODAY         a screen is held to the plan of the person who PAIRED it (devices.user_id),
 *                 counted among that person's own screens, oldest first
 *                 (ws/deviceSocket.js checkDeviceAccess).
 *   ORGANIZATION  a screen is held to the plan of the organization its workspace belongs to,
 *                 counted among ALL that organization's screens, oldest first.
 *
 * The plan rules are restated here rather than called, because the real getUserPlan WRITES (it
 * downgrades a lapsed trial as it reads) and this must be safe to point at a copy of production.
 * test/org-billing-report.test.js holds the two side by side on the same rows.
 */

const TRIAL_DAYS = 14;

function load(db) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  const plans = new Map(db.prepare('SELECT * FROM plans').all().map((p) => [p.id, p]));
  const users = new Map(db.prepare('SELECT * FROM users').all().map((u) => [u.id, u]));
  const orgs = has('organizations') ? db.prepare('SELECT * FROM organizations').all() : [];
  const workspaces = has('workspaces') ? db.prepare('SELECT id, organization_id, name FROM workspaces').all() : [];
  const devices = db.prepare('SELECT id, name, user_id, workspace_id, created_at, status FROM devices ORDER BY created_at ASC, id ASC').all();
  let storage = [];
  try { storage = db.prepare('SELECT user_id, workspace_id, COALESCE(SUM(file_size), 0) AS bytes FROM content GROUP BY user_id, workspace_id').all(); } catch { /* */ }
  let members = [];
  try { members = db.prepare('SELECT workspace_id, user_id, role FROM workspace_members').all(); } catch { /* */ }
  return { plans, users, orgs, workspaces, devices, storage, members };
}

/** The plan a person is REALLY on right now, as getUserPlan would leave them after reading. */
function planOf(user, plans, now) {
  if (!user) return null;
  let planId = user.plan_id;
  let trialExpiredAt = user.trial_expired_at || null;
  let trialRunning = false;
  if (user.trial_started) {
    const active = now < user.trial_started + TRIAL_DAYS * 86400;
    if (!active && !user.stripe_subscription_id && planId === user.trial_plan && planId !== 'free') {
      planId = 'free'; trialExpiredAt = trialExpiredAt || now;      // the pending downgrade
    } else {
      trialRunning = active && planId === user.trial_plan && !user.stripe_subscription_id;
    }
  }
  const plan = plans.get(planId);
  if (!plan) return null;
  return { id: planId, name: plan.name, max_devices: plan.max_devices, max_storage_mb: plan.max_storage_mb,
    trialRunning, trialExpiredAt, paying: !!user.stripe_subscription_id, comped: !!user.plan_comped };
}

/** The verdict for the screen at `index` (0-based, oldest first) of the set it is counted in. */
function verdict(plan, index) {
  if (!plan) return 'plays';
  if (plan.trialExpiredAt && plan.name === 'free' && plan.max_devices > 0 && index >= plan.max_devices) return 'trial_expired';
  if (!plan.trialRunning && plan.max_devices > 0 && index >= plan.max_devices) return 'device_limit';
  return 'plays';
}

function build(db, now = Math.floor(Date.now() / 1000)) {
  const d = load(db);
  const wsOrg = new Map(d.workspaces.map((w) => [w.id, w.organization_id]));
  const orgById = new Map(d.orgs.map((o) => [o.id, o]));
  const email = (uid) => (d.users.get(uid) || {}).email || null;

  // Position of each screen among its pairer's screens, and among its organization's.
  const perUser = new Map(), perOrg = new Map();
  const screens = d.devices.map((dev) => {
    const orgId = wsOrg.get(dev.workspace_id) || null;
    const iu = perUser.get(dev.user_id) || 0; if (dev.user_id) perUser.set(dev.user_id, iu + 1);
    const io = perOrg.get(orgId) || 0; if (orgId) perOrg.set(orgId, io + 1);
    const org = orgId ? orgById.get(orgId) : null;
    const today = dev.user_id ? verdict(planOf(d.users.get(dev.user_id), d.plans, now), iu) : 'plays';
    // No organization (an old single-tenant row, an unclaimed screen): the organization rule has
    // nothing to say, so the screen keeps today's answer.
    const after = org ? verdict(planOf(d.users.get(org.owner_user_id), d.plans, now), io) : today;
    return { id: dev.id, name: dev.name, status: dev.status, paired_by: dev.user_id, organization_id: orgId,
      owner: org ? org.owner_user_id : null, today, after };
  });

  const orgLine = (orgId) => {
    const o = orgById.get(orgId); if (!o) return null;
    const p = planOf(d.users.get(o.owner_user_id), d.plans, now);
    return { organization_id: o.id, name: o.name, owner_email: email(o.owner_user_id), plan: p ? p.id : null,
      screen_limit: p ? p.max_devices : null, screens: perOrg.get(o.id) || 0, paying: !!(p && p.paying), comped: !!(p && p.comped),
      trial_running: !!(p && p.trialRunning) };
  };
  const group = (list) => {
    const m = new Map();
    for (const s of list) { const k = s.organization_id || '(none)'; if (!m.has(k)) m.set(k, []); m.get(k).push({ id: s.id, name: s.name, status: s.status, paired_by: email(s.paired_by) }); }
    return [...m.entries()].map(([k, v]) => ({ ...(orgLine(k) || { organization_id: k }), affected: v.length, screens_affected: v }))
      .sort((a, b) => b.affected - a.affected);
  };

  const goDark = screens.filter((s) => s.today === 'plays' && s.after !== 'plays');
  const comeBack = screens.filter((s) => s.today !== 'plays' && s.after === 'plays');

  // One person, several organizations: today one plan covers them all.
  const byOwner = new Map();
  for (const o of d.orgs) { if (!byOwner.has(o.owner_user_id)) byOwner.set(o.owner_user_id, []); byOwner.get(o.owner_user_id).push(o); }
  const multiOwners = [...byOwner.entries()].filter(([, list]) => list.length > 1).map(([uid, list]) => {
    const p = planOf(d.users.get(uid), d.plans, now);
    const sorted = [...list].sort((a, b) => (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
    return { owner_email: email(uid), plan: p ? p.id : null, paying: !!(p && p.paying), comped: !!(p && p.comped),
      organizations: sorted.map((o, i) => ({ organization_id: o.id, name: o.name, screens: perOrg.get(o.id) || 0, holds_subscription: i === 0 })) };
  }).sort((a, b) => Number(b.paying) - Number(a.paying));

  // People whose OWN plan is what currently lets them add screens to somebody else's organization.
  const guests = new Map();
  for (const s of screens) {
    if (!s.organization_id || !s.paired_by || s.paired_by === s.owner) continue;
    const k = s.paired_by + '|' + s.organization_id;
    guests.set(k, (guests.get(k) || 0) + 1);
  }
  const guestScreens = [...guests.entries()].map(([k, n]) => {
    const [uid, orgId] = k.split('|');
    const p = planOf(d.users.get(uid), d.plans, now);
    return { member_email: email(uid), member_plan: p ? p.id : null, member_trial_running: !!(p && p.trialRunning),
      ...orgLine(orgId), screens_paired_by_member: n };
  }).sort((a, b) => b.screens_paired_by_member - a.screens_paired_by_member);

  // Storage, the same two ways.
  const mb = (bytes) => Math.ceil(bytes / (1024 * 1024));
  const userBytes = new Map(), orgBytes = new Map();
  for (const r of d.storage) {
    userBytes.set(r.user_id, (userBytes.get(r.user_id) || 0) + Number(r.bytes));
    const orgId = wsOrg.get(r.workspace_id); if (orgId) orgBytes.set(orgId, (orgBytes.get(orgId) || 0) + Number(r.bytes));
  }
  const storageOver = [];
  for (const o of d.orgs) {
    const p = planOf(d.users.get(o.owner_user_id), d.plans, now);
    if (!p || p.max_storage_mb === -1) continue;
    const orgMb = mb(orgBytes.get(o.id) || 0), ownerMb = mb(userBytes.get(o.owner_user_id) || 0);
    if (orgMb >= p.max_storage_mb && ownerMb < p.max_storage_mb) {
      storageOver.push({ ...orgLine(o.id), storage_limit_mb: p.max_storage_mb, owner_uses_mb: ownerMb, organization_uses_mb: orgMb });
    }
  }

  return {
    generated_at: now,
    totals: {
      people: d.users.size, organizations: d.orgs.length, screens: screens.length,
      screens_without_an_organization: screens.filter((s) => !s.organization_id).length,
      playing_today: screens.filter((s) => s.today === 'plays').length,
      playing_after: screens.filter((s) => s.after === 'plays').length,
      would_go_dark: goDark.length, would_come_back: comeBack.length,
      owners_with_several_organizations: multiOwners.length,
      paying_owners_with_several_organizations: multiOwners.filter((m) => m.paying).length,
      organizations_where_a_member_paired_screens: new Set([...guests.keys()].map((k) => k.split('|')[1])).size,
      organizations_newly_over_storage: storageOver.length,
    },
    would_go_dark: group(goDark),
    would_come_back: group(comeBack),
    owners_with_several_organizations: multiOwners,
    screens_paired_by_members: guestScreens,
    organizations_newly_over_storage: storageOver,
    // Every screen with both verdicts ('plays' | 'device_limit' | 'trial_expired'), for --json and the tests.
    screens: screens.map((s) => ({ id: s.id, organization_id: s.organization_id, today: s.today, after: s.after })),
  };
}

function text(r) {
  const L = [];
  const t = r.totals;
  L.push('Limits per organization instead of per person: what changes');
  L.push('');
  L.push(`  ${t.people} people, ${t.organizations} organizations, ${t.screens} screens (${t.screens_without_an_organization} with no organization: unchanged)`);
  L.push(`  playing today: ${t.playing_today}    playing after: ${t.playing_after}`);
  L.push(`  WOULD GO DARK: ${t.would_go_dark}    would come back: ${t.would_come_back}`);
  L.push(`  owners with several organizations: ${t.owners_with_several_organizations} (${t.paying_owners_with_several_organizations} paying)`);
  L.push(`  organizations where a member (not the owner) paired screens: ${t.organizations_where_a_member_paired_screens}`);
  L.push(`  organizations newly over their storage limit: ${t.organizations_newly_over_storage}`);
  const orgHead = (o) => `${o.name || o.organization_id}  owner ${o.owner_email || '?'}  plan ${o.plan} (limit ${o.screen_limit}, has ${o.screens})${o.paying ? '  PAYING' : ''}${o.comped ? '  comped' : ''}${o.trial_running ? '  trial' : ''}`;
  const section = (title, rows, line) => { if (!rows.length) return; L.push(''); L.push(title); for (const x of rows) for (const s of [].concat(line(x))) L.push('  ' + s); };
  section('Screens that would go dark, by organization', r.would_go_dark,
    (o) => [`${o.affected} of ${orgHead(o)}`, ...o.screens_affected.map((s) => `    ${s.name || s.id} [${s.status || '?'}] paired by ${s.paired_by || '?'}`)]);
  section('Screens that would come back', r.would_come_back, (o) => `${o.affected} of ${orgHead(o)}`);
  section('Owners with several organizations (the first holds the subscription today)', r.owners_with_several_organizations,
    (m) => [`${m.owner_email}  plan ${m.plan}${m.paying ? '  PAYING' : ''}${m.comped ? '  comped' : ''}`,
      ...m.organizations.map((o) => `    ${o.holds_subscription ? '*' : ' '} ${o.name} (${o.screens} screens)`)]);
  section('Members whose own plan currently covers screens in someone else\'s organization', r.screens_paired_by_members,
    (g) => `${g.member_email} (${g.member_plan}${g.member_trial_running ? ', trial running' : ''}) paired ${g.screens_paired_by_member} in ${orgHead(g)}`);
  section('Organizations newly over their storage limit', r.organizations_newly_over_storage,
    (o) => `${orgHead(o)}  storage ${o.organization_uses_mb} MB of ${o.storage_limit_mb} MB (owner alone ${o.owner_uses_mb} MB)`);
  return L.join('\n');
}

module.exports = { build, text, planOf, verdict };
