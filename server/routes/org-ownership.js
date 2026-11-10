'use strict';

/*
 * Handing an organization to someone else.
 *
 * An organization has exactly one owner (organizations.owner_user_id, and the matching
 * 'org_owner' row in organization_members), and until this file nothing could change who that
 * is. The person who signed up for a company and then left it was stuck as its owner: they could
 * not delete their account while it had other members, nobody could remove them, and whoever took
 * over could never hold the owner's powers (billing, single sign-on, deleting the organization).
 *
 *   GET  /api/organizations/:orgId/ownership   who owns it, and who it could be handed to
 *   POST /api/organizations/:orgId/ownership   { user_id, acknowledge_plan_change? }
 *
 * WHO MAY HAND IT OVER: the owner, or the instance operator (for an owner who is gone or
 * unreachable). Not an organization admin: an admin promoting themself over the owner is a
 * takeover, not a hand-over.
 * TO WHOM: someone already in the organization (an organization member, or a member of one of its
 * workspaces). Never an outsider: joining comes first, by invitation.
 *
 * WHAT HAPPENS TO THE PLAN depends on who pays (lib/org-billing.js):
 *   - the ORGANIZATION pays: nothing. Its plan, subscription and Stripe customer stay with it; only
 *     the customer's contact email moves to the new owner.
 *   - the PERSON pays (today): the plan IS the owner's, so the organization takes the new owner's
 *     plan and the subscription stays with the person paying for it. A hand-over that would
 *     change the plan is refused (409 PLAN_FOLLOWS_OWNER) until the caller acknowledges it.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { logActivity, getClientIp } = require('../services/activity');
const limits = require('../middleware/subscription');

router.use(require('../lib/backstop-limiter'));

const publicUser = (u) => (u ? { id: u.id, name: u.name || null, email: u.email } : null);

/** Everyone in the organization: its members and the members of its workspaces. */
function peopleIn(orgId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email,
           (SELECT om.role FROM organization_members om WHERE om.organization_id = ? AND om.user_id = u.id) AS org_role
      FROM users u
     WHERE u.id IN (SELECT user_id FROM organization_members WHERE organization_id = ?
                    UNION SELECT wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ?)
     ORDER BY LOWER(COALESCE(u.name, u.email))`).all(orgId, orgId, orgId);
}
function isDisabled(userId) {
  try { const r = db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(userId); return !!(r && r.disabled_at); }
  catch { return false; }
}

/** Loads the organization; 404 for anyone who is neither in it nor the operator. */
function loadOrg(req, res, next) {
  const org = db.prepare('SELECT id, name, owner_user_id FROM organizations WHERE id = ?').get(req.params.orgId);
  const operator = isPlatformRole(req.user.role);
  if (!org || (!operator && !peopleIn(org.id).some((p) => p.id === req.user.id))) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  req.org = org;
  req.mayTransfer = operator || org.owner_user_id === req.user.id;
  next();
}

router.get('/:orgId/ownership', requireAuth, loadOrg, (req, res) => {
  const people = peopleIn(req.org.id);
  res.json({
    organization: { id: req.org.id, name: req.org.name },
    owner: publicUser(db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.org.owner_user_id)),
    can_transfer: req.mayTransfer,
    // Only the caller who can act on it gets the list of names.
    candidates: req.mayTransfer
      ? people.filter((p) => p.id !== req.org.owner_user_id && !isDisabled(p.id)).map((p) => ({ id: p.id, name: p.name || null, email: p.email, org_role: p.org_role || null }))
      : [],
    plan_follows_owner: limits.billingSource() !== 'org',
  });
});

/**
 * Make `targetId` the owner of `org`. Every rule of a hand-over lives here, for the two routes
 * that can cause one (handing over, and the owner leaving with a successor).
 * Returns { refuse: [status, body] } having changed nothing, or { target, previous, orgPays }.
 */
function handOver(req, org, targetId) {
  if (!targetId) return { refuse: [400, { error: 'user_id required' }] };
  if (targetId === org.owner_user_id) return { refuse: [400, { error: 'That person already owns this organization.' }] };
  const target = peopleIn(org.id).find((p) => p.id === targetId);
  if (!target) return { refuse: [400, { error: 'Choose someone who is already in this organization. Invite them first if they are not.' }] };
  if (isDisabled(targetId)) return { refuse: [400, { error: 'That account is deactivated.' }] };

  const previousId = org.owner_user_id;
  const orgPays = limits.billingSource() === 'org';
  if (!orgPays) {
    // The plan is the owner's. Say what will change before changing it.
    const from = limits.getUserPlan(previousId), to = limits.getUserPlan(targetId);
    const fromId = from ? from.plan_id : null, toId = to ? to.plan_id : null;
    if (fromId !== toId && !(req.body && req.body.acknowledge_plan_change === true)) {
      return { refuse: [409, {
        error: `This organization runs on its owner's plan. Handing it over moves it from ${from ? from.plan_display_name : 'no plan'} to ${to ? to.plan_display_name : 'no plan'}; the current subscription stays with the person paying for it.`,
        code: 'PLAN_FOLLOWS_OWNER', from_plan: fromId, to_plan: toId,
      }] };
    }
  }

  db.transaction(() => {
    db.prepare("UPDATE organizations SET owner_user_id = ?, updated_at = strftime('%s','now') WHERE id = ?").run(targetId, org.id);
    // Exactly one org_owner row, the new owner's; the previous owner stays, as an admin.
    db.prepare("UPDATE organization_members SET role = 'org_admin' WHERE organization_id = ? AND role = 'org_owner' AND user_id != ?").run(org.id, targetId);
    const has = db.prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?').get(org.id, targetId);
    if (has) db.prepare("UPDATE organization_members SET role = 'org_owner' WHERE organization_id = ? AND user_id = ?").run(org.id, targetId);
    else db.prepare("INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES (?, ?, 'org_owner', ?)").run(org.id, targetId, req.user.id);
    const prev = db.prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?').get(org.id, previousId);
    if (!prev && db.prepare('SELECT 1 FROM users WHERE id = ?').get(previousId)) {
      db.prepare("INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES (?, ?, 'org_admin', ?)").run(org.id, previousId, req.user.id);
    }
  })();

  const previous = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(previousId);
  logActivity(req.user.id, 'org:ownership_transferred',
    `${org.name}: from ${previous ? previous.email : previousId} to ${target.email}`, null, getClientIp(req));

  // The organization's Stripe customer writes to its owner. Best effort, after the answer.
  if (orgPays) {
    setImmediate(async () => {
      try {
        const stripe = require('../lib/stripe-client').get();
        const row = db.prepare('SELECT stripe_customer_id FROM organizations WHERE id = ?').get(org.id);
        if (stripe && row && row.stripe_customer_id) await stripe.customers.update(row.stripe_customer_id, { email: target.email });
      } catch (e) { console.warn(`[org-ownership] could not move the Stripe contact for ${org.id}: ${e.message}`); }
    });
  }
  return { target, previous, orgPays };
}

router.post('/:orgId/ownership', requireAuth, loadOrg, (req, res) => {
  if (!req.mayTransfer) return res.status(403).json({ error: 'Only the organization\'s owner can hand it to someone else.' });
  const org = req.org;
  const r = handOver(req, org, req.body && typeof req.body.user_id === 'string' ? req.body.user_id : null);
  if (r.refuse) return res.status(r.refuse[0]).json(r.refuse[1]);
  res.json({
    organization: { id: org.id, name: org.name },
    owner: publicUser(r.target),
    previous_owner: publicUser(r.previous),
    plan_follows_owner: !r.orgPays,
  });
});

/*
 * LEAVING.
 *
 * Membership could only be ended by an administrator, so a member who wanted out had to ask and
 * the owner could not go at all. Leaving is the person's own decision:
 *
 *   GET  /api/organizations/mine          the organizations I am in, and what leaving each needs
 *   POST /api/organizations/:orgId/leave  { new_owner_id?, acknowledge_plan_change? }
 *
 * THE OWNER leaves only by naming a successor in the same request (409 OWNER_MUST_HAND_OVER
 * otherwise): the hand-over happens first, by every rule above, and if it is refused nothing has
 * changed and they are still the owner and still a member.
 * A WORKSPACE IS NOT LEFT HEADLESS: someone who is the only administrator of a workspace other
 * people are still in has to make one of them an administrator first (409 LAST_WORKSPACE_ADMIN).
 * What they made stays: screens, content and playlists belong to the workspace.
 */
const candidatesFor = (org) => peopleIn(org.id).filter((p) => p.id !== org.owner_user_id && !isDisabled(p.id))
  .map((p) => ({ id: p.id, name: p.name || null, email: p.email, org_role: p.org_role || null }));

/** Workspaces of this organization where `userId` is the ONLY administrator and others remain. */
function headlessIfGone(orgId, userId) {
  return db.prepare(`
    SELECT w.id, w.name FROM workspaces w
      JOIN workspace_members me ON me.workspace_id = w.id AND me.user_id = ? AND me.role = 'workspace_admin'
     WHERE w.organization_id = ?
       AND NOT EXISTS (SELECT 1 FROM workspace_members a WHERE a.workspace_id = w.id AND a.role = 'workspace_admin' AND a.user_id != ?)
       AND EXISTS (SELECT 1 FROM workspace_members o WHERE o.workspace_id = w.id AND o.user_id != ?)`).all(userId, orgId, userId, userId);
}

router.get('/mine', requireAuth, (req, res) => {
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.owner_user_id FROM organizations o
     WHERE o.id IN (SELECT organization_id FROM organization_members WHERE user_id = ?
                    UNION SELECT w.organization_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ?)
     ORDER BY LOWER(o.name)`).all(req.user.id, req.user.id);
  res.json({ organizations: orgs.map((o) => {
    const isOwner = o.owner_user_id === req.user.id;
    const blocking = isOwner ? [] : headlessIfGone(o.id, req.user.id);
    const candidates = isOwner ? candidatesFor(o) : [];
    return {
      id: o.id, name: o.name, is_owner: isOwner,
      needs_new_owner: isOwner,
      candidates,
      last_admin_of: blocking,
      // The owner can leave once they pick someone; a sole owner has nobody to pick.
      can_leave: isOwner ? candidates.length > 0 : blocking.length === 0,
      plan_follows_owner: limits.billingSource() !== 'org',
    };
  }) });
});

router.post('/:orgId/leave', requireAuth, (req, res) => {
  const org = db.prepare('SELECT id, name, owner_user_id FROM organizations WHERE id = ?').get(req.params.orgId);
  if (!org || !peopleIn(org.id).some((p) => p.id === req.user.id)) return res.status(404).json({ error: 'Organization not found' });
  const me = req.user.id;

  if (org.owner_user_id === me) {
    const successor = req.body && typeof req.body.new_owner_id === 'string' ? req.body.new_owner_id : null;
    if (!successor) {
      const candidates = candidatesFor(org);
      return res.status(409).json({
        error: candidates.length
          ? 'You own this organization. Choose who takes it over, then you can leave.'
          : 'You own this organization and nobody else is in it. Invite someone to take it over, or delete it.',
        code: 'OWNER_MUST_HAND_OVER', candidates,
      });
    }
    const r = handOver(req, org, successor);
    if (r.refuse) return res.status(r.refuse[0]).json(r.refuse[1]);
  } else {
    const blocking = headlessIfGone(org.id, me);
    if (blocking.length) {
      return res.status(409).json({
        error: `You are the only administrator of ${blocking.map((w) => w.name).join(', ')}. Make someone else an administrator there first.`,
        code: 'LAST_WORKSPACE_ADMIN', workspaces: blocking,
      });
    }
  }

  const wsIds = db.prepare(`SELECT wm.workspace_id AS id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
                             WHERE w.organization_id = ? AND wm.user_id = ?`).all(org.id, me).map((r) => r.id);
  db.transaction(() => {
    db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?').run(org.id, me);
    if (wsIds.length) {
      db.prepare(`DELETE FROM workspace_members WHERE user_id = ? AND workspace_id IN (${wsIds.map(() => '?').join(',')})`).run(me, ...wsIds);
      // What they set up under their own name goes with the membership (lib/user-deletion.js).
      require('../lib/user-deletion').releaseWorkspaceMember(db, { userId: me, workspaceIds: wsIds });
    }
  })();
  for (const id of wsIds) { try { require('../ws/dashboardSocket').dropUserFromWorkspace(me, id); } catch (_) { /* best effort */ } }
  logActivity(me, 'org:member_left', `${org.name} (${wsIds.length} workspace${wsIds.length === 1 ? '' : 's'})`, null, getClientIp(req));
  const now = db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').get(org.id);
  res.json({ success: true, organization: { id: org.id, name: org.name }, left_workspaces: wsIds.length,
    owner: publicUser(db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(now.owner_user_id)) });
});

module.exports = router;
