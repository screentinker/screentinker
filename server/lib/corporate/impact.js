'use strict';

/*
 * Store triggers a change would hide or cap because it NEWLY brings screens under head office.
 *
 * ⚠️ NEVER HIDE A STORE'S TRIGGER SILENTLY. Under the default policy ('off') a store trigger is not
 * projected to a screen head office drives — an evacuation relay among them. So every change that
 * brings a screen under a mandate lists the store triggers it stops showing and is refused with 409
 * CORPORATE_STORE_TRIGGERS_IMPACT until the caller resends with acknowledge_impact. Two families of
 * change do that:
 *   - head office's own (mandate create/update/enable, switching corporate on): routes/corporate.js,
 *     which simulates the write in a rolled-back transaction;
 *   - membership (moving a screen to another workspace, into a group or onto a wall, deleting a
 *     group): guard.assertNoMandateLoss, which already runs the change in a transaction and compares
 *     every affected screen's mandate before and after — this module is asked from inside it, while
 *     the new state is still in place, so the list is what the screen will ACTUALLY lose (a trigger
 *     of the workspace a screen leaves stops reaching it anyway; triggers are workspace-scoped, see
 *     lib/device-triggers.js NORMAL_SQL, and are not counted).
 * Both read the list from storeTriggerImpact (lib/corporate/emergency.js) and write the same audit.
 */

function dbOf() { return require('../../db/database').db; }

/** Did the caller tick "I've checked these"? Body for POST/PUT, query for DELETE. */
function acknowledged(req) {
  if (!req) return false;
  if (req.body && req.body.acknowledge_impact === true) return true;
  const q = req.query && req.query.acknowledge_impact;
  return q === '1' || q === 'true';
}

function orgPolicy(db, orgId) {
  try {
    const o = db.prepare('SELECT store_triggers_under_mandate AS policy, store_trigger_cap_sec AS cap FROM organizations WHERE id = ?').get(orgId);
    if (!o) return null;
    return { policy: o.policy || 'off', cap: Number(o.cap) > 0 ? Number(o.cap) : 300 };
  } catch (_) { return null; }
}

/**
 * The store triggers hidden or capped on `deviceIds` (screens just brought under head office), read
 * in the CURRENT database state. Screens are grouped by org; each org's own policy applies.
 * Returns [{ trigger_id, name, workspace_id, workspace_name, mode, ..., screens, organization_id, policy }].
 */
function impactForNewlyCovered(db, deviceIds) {
  db = db || dbOf();
  const ids = [...new Set((deviceIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const byOrg = new Map();
  for (const id of ids) {
    let org = null;
    try { org = db.prepare('SELECT w.organization_id AS o FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?').get(id)?.o || null; } catch (_) { org = null; }
    if (!org) continue;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(id);
  }
  const out = [];
  for (const [orgId, devs] of byOrg) {
    const p = orgPolicy(db, orgId);
    if (!p || p.policy === 'allow') continue;
    const rows = require('./emergency').storeTriggerImpact(db, orgId, p.policy, p.cap, devs);
    for (const r of rows) out.push({ ...r, organization_id: orgId, policy: p.policy });
  }
  return out;
}

/** Each store whose triggers a change hides or caps hears about it in its own activity feed. */
function auditLimited(req, orgId, impact, policy, cap, cause, extra = {}) {
  if (!impact || !impact.length) return;
  const { audit } = require('../audit');
  for (const wsId of new Set(impact.map((i) => i.workspace_id))) {
    try {
      audit('corporate.store_triggers.limited', {
        userId: req && req.user && req.user.id, workspaceId: wsId, ip: (req && req.ip) || null,
        details: {
          organization_id: orgId, workspace_id: wsId, policy, cap_sec: cap, cause, ...extra,
          triggers: impact.filter((i) => i.workspace_id === wsId).map((i) => ({ id: i.trigger_id, name: i.name })),
        },
      });
    } catch (_) { /* the audit trail never breaks the change */ }
  }
}

/** auditLimited for a list that may span orgs (a membership change), each with its org's policy. */
function auditLimitedByOrg(db, req, impact, cause, extra) {
  db = db || dbOf();
  const orgs = new Map();
  for (const i of impact || []) {
    if (!orgs.has(i.organization_id)) orgs.set(i.organization_id, []);
    orgs.get(i.organization_id).push(i);
  }
  for (const [orgId, list] of orgs) {
    const p = orgPolicy(db, orgId) || { policy: list[0].policy, cap: 300 };
    auditLimited(req, orgId, list, p.policy, p.cap, cause, extra);
  }
}

/**
 * Store triggers that START showing again on `deviceIds` (screens a change took out from under head
 * office), in the current state — only where the org's policy had been hiding or capping them.
 * Returned as a count of distinct triggers, for the move notice; never a prompt.
 */
function restoredCount(db, deviceIds) {
  db = db || dbOf();
  const ids = [...new Set((deviceIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const { triggersForDevice } = require('../device-triggers');
  const seen = new Set();
  for (const id of ids) {
    let org = null;
    try { org = db.prepare('SELECT w.organization_id AS o FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?').get(id)?.o || null; } catch (_) { org = null; }
    const p = org && orgPolicy(db, org);
    if (!p || p.policy === 'allow') continue;
    try { for (const t of triggersForDevice(db, id, { skipEmergency: true, mandated: false })) seen.add(t.id); } catch (_) { /* no triggers table */ }
  }
  return seen.size;
}

module.exports = { acknowledged, impactForNewlyCovered, auditLimited, auditLimitedByOrg, restoredCount, orgPolicy };
