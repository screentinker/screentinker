'use strict';

/*
 * Triggers — externally-fired interrupt content. See docs/triggers-design.md.
 *
 * This router is the DEFINITION surface only: create, edit, assign. ⚠️ Nothing here is on the fire
 * path. A trigger fires on the device, against its own synced copy, with the WAN down — that is the
 * entire feature, and any lookup that reached back here would defeat it.
 *
 * Scoping is by req.workspaceId on every query, which is what makes a token bound to workspace A
 * unable to see or address a trigger in workspace B. Same guarantee, same mechanism, as pip.js.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');

/*
 * A trigger changes what appears on a screen, so it is a fleet-affecting write and carries the same
 * pairing pip.js uses: requireScope('full') gates API TOKENS (and is a deliberate pass-through for
 * JWT sessions), and this adds the role check that scope alone does not give a dashboard session.
 */
function requireFleetWrite(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  next();
}

const { validateTriggerBody, columnsFrom } = require('../lib/trigger-validate');

/** Shape a row for the API. Assignments come along because a trigger without them does nothing. */
function withAssignments(row) {
  if (!row) return row;
  const assignments = db.prepare(
    'SELECT target_type, target_id FROM trigger_assignments WHERE trigger_id = ?').all(row.id);
  return { ...row, assignments };
}

function validate(req, b, opts) { return validateTriggerBody(db, req.workspaceId, b, opts); }

/*
 * ⚠️ HEAD OFFICE EMERGENCY ALERTS (kind = 'emergency') live in the head office workspace and are
 * managed ONLY through /api/corporate/emergency, by the organization's owners and admins (spec §5.4).
 * This router lists them (with `kind`) but never creates, edits or deletes one — and their fire and
 * clear codes are shown only to org admins: anyone who knows them and a screen's secret can set the
 * alert off, or clear it, on that screen.
 */
function emergencyRefusal(res) {
  const g = require('../lib/corporate/guard');
  const e = g.err('CORPORATE_EMERGENCY');
  return res.status(e.status).json({ error: e.message, code: e.code });
}

function isOrgAdminHere(req) {
  try {
    const g = require('../lib/corporate/guard');
    return !req.viaToken && g.isOrgAdmin(req, g.orgOfWorkspace(db, req.workspaceId));
  } catch (_) { return false; }
}

/** Shape a row for a listing: emergency rows get their scope, and lose their codes for non-admins. */
function shapeRow(req, row, admin) {
  const out = withAssignments(row);
  if (out && out.kind === 'emergency') {
    try { out.scopes = require('../lib/corporate/emergency').scopesOf(db, row.id); } catch (_) { out.scopes = []; }
    if (!admin) { out.match_token = null; out.clear_token = null; out.codes_hidden = true; }
  }
  return out;
}

/*
 * What a STORE's Triggers page needs to know about head office (§7.6, §5.3): the emergency alerts
 * that reach this workspace (read-only, codes never included), and head office's policy for store
 * triggers on its screens when it is not "allow as before". Additive keys; empty on every install
 * that does not use either feature.
 */
function headOffice(req) {
  const out = { emergency: [], store_trigger_policy: null };
  try {
    const org = db.prepare(`SELECT o.* FROM organizations o JOIN workspaces w ON w.organization_id = o.id WHERE w.id = ?`).get(req.workspaceId);
    if (!org) return out;
    if (org.emergency_triggers_enabled && org.hq_workspace_id !== req.workspaceId) {
      const { EMERGENCY_SCOPE_MATCH } = require('../lib/device-triggers');
      out.emergency = db.prepare(`
        SELECT DISTINCT t.id, t.name, t.kind, t.enabled, t.mode FROM triggers t
          JOIN workspaces tw ON tw.id = t.workspace_id
          JOIN workspaces dw ON dw.organization_id = tw.organization_id AND dw.id = ?
          JOIN devices d ON d.workspace_id = dw.id
         WHERE tw.organization_id = ? AND t.kind = 'emergency' AND ${EMERGENCY_SCOPE_MATCH}
         ORDER BY t.name`).all(req.workspaceId, org.id)
        .map((t) => ({ ...t, enabled: !!t.enabled, live: !!require('../lib/corporate/emergency-live').liveFor(t.id) }));
    }
    if (org.store_triggers_under_mandate && org.store_triggers_under_mandate !== 'allow') {
      out.store_trigger_policy = { policy: org.store_triggers_under_mandate, cap_sec: org.store_trigger_cap_sec || 300 };
    }
  } catch (_) { /* no corporate columns: nothing to report */ }
  return out;
}

/** Replace a trigger's assignments, validating every target is in this workspace. */
function setAssignments(req, triggerId, assignments) {
  if (!Array.isArray(assignments)) return null;
  const rows = [];
  for (const a of assignments) {
    const type = a && a.target_type;
    const tid = a && String(a.target_id || '');
    if (type !== 'device' && type !== 'group') return `invalid target_type: ${type}`;
    const found = type === 'device'
      ? db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId)
      : db.prepare('SELECT id FROM device_groups WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId);
    if (!found) return `${type} ${tid} not found in this workspace`;
    rows.push({ type, tid });
  }
  db.prepare('DELETE FROM trigger_assignments WHERE trigger_id = ?').run(triggerId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(triggerId, r.type, r.tid);
  return null;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const rows = db.prepare('SELECT * FROM triggers WHERE workspace_id = ? ORDER BY priority DESC, name')
    .all(req.workspaceId);
  const admin = rows.some((r) => r.kind === 'emergency') && isOrgAdminHere(req);
  res.json({ triggers: rows.map((r) => shapeRow(req, r, admin)), head_office: headOffice(req) });
});

router.get('/:id', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const row = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'trigger not found' });
  res.json(shapeRow(req, row, row.kind === 'emergency' && isOrgAdminHere(req)));
});

/**
 * Push the new definitions AND their media to every device this trigger touches, now.
 *
 * ⚠️ THIS IS THE HALF THAT MAKES THE OFFLINE GUARANTEE TRUE. A trigger's whole point is that it
 * fires with the WAN down, which requires the device to be holding both the definition and the
 * target playlist's content BEFORE anything goes wrong. Without a push, none of that happens until
 * the panel next reconnects — for a screen that has been up for weeks, effectively never. The
 * definition sits in the database looking configured, the media is not pinned, and the first time
 * anyone learns otherwise is when an alarm fires against nothing.
 *
 * The payload the device receives carries `triggers` with their playlists resolved inline, and the
 * player's own handler re-pins on a trigger-set change — so one playlist-update does both jobs.
 *
 * `before` lets a delete/reassign reach the devices that are LOSING the trigger as well as the
 * ones gaining it; a device dropped from the assignment list still needs to be told, or it keeps
 * a definition nobody can see in the dashboard.
 */
function pushTrigger(req, triggerId, before) {
  try {
    const io = req.app && req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const { devicesForTrigger } = require('../lib/device-triggers');
    const ns = io.of('/device');
    const ids = new Set(before || []);
    for (const id of devicesForTrigger(db, triggerId)) ids.add(id);
    for (const id of ids) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
    if (ids.size) console.log(`[trigger] pushed ${triggerId} to ${ids.size} device(s)`);
  } catch (e) { console.warn(`[trigger] push failed: ${e && e.message}`); }
}

router.post('/', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  if (b.kind === 'emergency') return emergencyRefusal(res);
  if (b.kind != null && b.kind !== '' && b.kind !== 'normal') return res.status(400).json({ error: 'invalid kind — use normal (emergency alerts are made under Corporate → Emergency)' });
  const bad = validate(req, b);
  if (bad) return res.status(400).json({ error: bad });

  const id = uuidv4();
  const c = columnsFrom(b);
  db.prepare(`INSERT INTO triggers
      (id, workspace_id, name, match_token, clear_token, source_http, source_udp,
       target_kind, target_ref, position, width, height, opacity, border_radius,
       mode, max_duration_sec, lease_sec, priority, enabled)
      VALUES (@id, @workspace_id, @name, @match_token, @clear_token, @source_http, @source_udp,
              @target_kind, @target_ref, @position, @width, @height, @opacity, @border_radius,
              @mode, @max_duration_sec, @lease_sec, @priority, @enabled)`)
    .run({ id, workspace_id: req.workspaceId, ...c });

  const aErr = setAssignments(req, id, b.assignments);
  if (aErr) { db.prepare('DELETE FROM triggers WHERE id = ?').run(id); return res.status(400).json({ error: aErr }); }

  console.log(`[trigger] created ${id} "${c.name}" token=${c.match_token} mode=${c.mode}`);
  pushTrigger(req, id);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(id)));
});

router.put('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });
  if (existing.kind === 'emergency') return emergencyRefusal(res);

  const b = req.body || {};
  if (b.kind === 'emergency') return emergencyRefusal(res);
  const bad = validate(req, b, { id: existing.id });
  if (bad) return res.status(400).json({ error: bad });

  // Captured before the assignment rewrite, so a device REMOVED from the list is still told —
  // otherwise it holds a definition that no longer appears anywhere in the dashboard.
  const { devicesForTrigger } = require('../lib/device-triggers');
  const before = devicesForTrigger(db, existing.id);

  const c = columnsFrom(b);
  db.prepare(`UPDATE triggers SET
      name=@name, match_token=@match_token, clear_token=@clear_token,
      source_http=@source_http, source_udp=@source_udp,
      target_kind=@target_kind, target_ref=@target_ref, position=@position,
      width=@width, height=@height, opacity=@opacity, border_radius=@border_radius,
      mode=@mode, max_duration_sec=@max_duration_sec, lease_sec=@lease_sec,
      priority=@priority, enabled=@enabled, updated_at=strftime('%s','now')
      WHERE id=@id`).run({ id: existing.id, ...c });

  if (b.assignments !== undefined) {
    const aErr = setAssignments(req, existing.id, b.assignments);
    if (aErr) return res.status(400).json({ error: aErr });
  }

  console.log(`[trigger] updated ${existing.id} "${c.name}"`);
  pushTrigger(req, existing.id, before);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(existing.id)));
});

router.delete('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });
  if (existing.kind === 'emergency') return emergencyRefusal(res);
  // ⚠️ Read the affected devices BEFORE the row goes: trigger_assignments cascades on this delete
  // (FK declared inline, foreign_keys is ON), so afterwards there is nothing left to ask.
  const { devicesForTrigger } = require('../lib/device-triggers');
  const before = devicesForTrigger(db, existing.id);
  db.prepare('DELETE FROM triggers WHERE id = ?').run(existing.id);
  console.log(`[trigger] deleted ${existing.id}`);
  // The push also frees the pinned media: the player's keep-set no longer lists it, so the
  // service worker's prune reclaims the space on the next update rather than holding it forever.
  pushTrigger(req, existing.id, before);
  res.json({ success: true });
});

module.exports = router;
