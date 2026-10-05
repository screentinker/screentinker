'use strict';

/*
 * Polymorphic-target cleanup. corporate_mandates.target_id, corporate_slot_fills.scope_id and
 * emergency_trigger_scopes.scope_id name a device, group, wall or workspace WITHOUT a foreign key
 * (one column, several tables) — the same convention as trigger_assignments. Nothing cascades
 * them, so every delete path of those objects calls here; the resolver already ignores a dangling
 * row (it only matches live ones), so this is hygiene, never correctness.
 *
 * Callers: DELETE /api/devices/:id, DELETE /api/groups/:id, DELETE /api/walls/:id, the platform
 * workspace delete, and the maintenance sweep (provisioning prune) via sweepDanglingTargets.
 */

function dbOf() { return require('../../db/database').db; }

const KINDS = new Set(['device', 'group', 'wall', 'workspace']);

function removeTargets(db, kind, ids) {
  db = db || dbOf();
  if (!KINDS.has(kind)) return 0;
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  let n = 0;
  for (const id of list) {
    try { n += db.prepare('DELETE FROM corporate_mandates WHERE target_kind = ? AND target_id = ?').run(kind, id).changes; } catch (_) { /* no table */ }
    try { n += db.prepare('DELETE FROM corporate_slot_fills WHERE scope_kind = ? AND scope_id = ?').run(kind, id).changes; } catch (_) { /* no table */ }
    if (kind !== 'wall') {
      try { n += db.prepare('DELETE FROM emergency_trigger_scopes WHERE scope_kind = ? AND scope_id = ?').run(kind, id).changes; } catch (_) { /* no table */ }
    }
  }
  return n;
}

/** Everything a workspace delete orphans: the workspace itself and its groups, devices and walls. */
function removeWorkspaceTargets(db, workspaceId) {
  db = db || dbOf();
  let n = removeTargets(db, 'workspace', workspaceId);
  try {
    n += removeTargets(db, 'group', db.prepare('SELECT id FROM device_groups WHERE workspace_id = ?').all(workspaceId).map((r) => r.id));
    n += removeTargets(db, 'device', db.prepare('SELECT id FROM devices WHERE workspace_id = ?').all(workspaceId).map((r) => r.id));
    n += removeTargets(db, 'wall', db.prepare('SELECT id FROM video_walls WHERE workspace_id = ?').all(workspaceId).map((r) => r.id));
  } catch (_) { /* partial schema */ }
  return n;
}

/** Rows whose target no longer exists (devices removed by the provisioning prune, for one). */
function sweepDanglingTargets(db) {
  db = db || dbOf();
  let n = 0;
  const sweeps = [
    ["DELETE FROM corporate_mandates WHERE target_kind = 'device' AND target_id NOT IN (SELECT id FROM devices)"],
    ["DELETE FROM corporate_mandates WHERE target_kind = 'group' AND target_id NOT IN (SELECT id FROM device_groups)"],
    ["DELETE FROM corporate_mandates WHERE target_kind = 'wall' AND target_id NOT IN (SELECT id FROM video_walls)"],
    ["DELETE FROM corporate_mandates WHERE target_kind = 'workspace' AND target_id NOT IN (SELECT id FROM workspaces)"],
    ["DELETE FROM corporate_slot_fills WHERE scope_kind = 'device' AND scope_id NOT IN (SELECT id FROM devices)"],
    ["DELETE FROM corporate_slot_fills WHERE scope_kind = 'group' AND scope_id NOT IN (SELECT id FROM device_groups)"],
    ["DELETE FROM corporate_slot_fills WHERE scope_kind = 'wall' AND scope_id NOT IN (SELECT id FROM video_walls)"],
    ["DELETE FROM emergency_trigger_scopes WHERE scope_kind = 'device' AND scope_id NOT IN (SELECT id FROM devices)"],
    ["DELETE FROM emergency_trigger_scopes WHERE scope_kind = 'group' AND scope_id NOT IN (SELECT id FROM device_groups)"],
  ];
  for (const [sql] of sweeps) {
    try { n += db.prepare(sql).run().changes; } catch (_) { /* table absent */ }
  }
  return n;
}

module.exports = { removeTargets, removeWorkspaceTargets, sweepDanglingTargets };
