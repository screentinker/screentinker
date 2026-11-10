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

router.post('/:orgId/ownership', requireAuth, loadOrg, (req, res) => {
  if (!req.mayTransfer) return res.status(403).json({ error: 'Only the organization\'s owner can hand it to someone else.' });
  const org = req.org;
  const targetId = req.body && typeof req.body.user_id === 'string' ? req.body.user_id : null;
  if (!targetId) return res.status(400).json({ error: 'user_id required' });
  if (targetId === org.owner_user_id) return res.status(400).json({ error: 'That person already owns this organization.' });
  const target = peopleIn(org.id).find((p) => p.id === targetId);
  if (!target) return res.status(400).json({ error: 'Choose someone who is already in this organization. Invite them first if they are not.' });
  if (isDisabled(targetId)) return res.status(400).json({ error: 'That account is deactivated.' });

  const previousId = org.owner_user_id;
  const orgPays = limits.billingSource() === 'org';
  if (!orgPays) {
    // The plan is the owner's. Say what will change before changing it.
    const from = limits.getUserPlan(previousId), to = limits.getUserPlan(targetId);
    const fromId = from ? from.plan_id : null, toId = to ? to.plan_id : null;
    if (fromId !== toId && !(req.body && req.body.acknowledge_plan_change === true)) {
      return res.status(409).json({
        error: `This organization runs on its owner's plan. Handing it over moves it from ${from ? from.plan_display_name : 'no plan'} to ${to ? to.plan_display_name : 'no plan'}; the current subscription stays with the person paying for it.`,
        code: 'PLAN_FOLLOWS_OWNER', from_plan: fromId, to_plan: toId,
      });
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

  const prevUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(previousId);
  logActivity(req.user.id, 'org:ownership_transferred',
    `${org.name}: from ${prevUser ? prevUser.email : previousId} to ${target.email}`, null, getClientIp(req));

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

  res.json({
    organization: { id: org.id, name: org.name },
    owner: publicUser(target),
    previous_owner: publicUser(prevUser),
    plan_follows_owner: !orgPays,
  });
});

module.exports = router;
