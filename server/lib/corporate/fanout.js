'use strict';

/*
 * Who must be told when head office changes where a playlist plays.
 *
 * A mandate create/update/delete/enable, or the org's corporate_enabled toggle, changes what an
 * unknown set of screens RESOLVES to. Rather than predict that set per kind of change (the fan-out
 * that forgets a case is this codebase's recurring bug — lib/devices-playing.js), snapshot what
 * every device in the affected workspaces resolves to before and after, and push exactly the
 * devices whose answer changed. Members of a sync-enabled group containing a changed device are
 * pushed too: their group_sync block (leader, member set) can change without their own playlist
 * changing.
 *
 * Stage B adds the per-store composition events (fill publish, fill rows, recomposition).
 */

function dbOf() { return require('../../db/database').db; }

function snapshotResolution(db, workspaceIds) {
  if (!workspaceIds.length) return new Map();
  const ph = workspaceIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT d.id, r.playlist_id, r.source, r.layout_id FROM devices d
      JOIN device_resolved_playlist r ON r.device_id = d.id
     WHERE d.workspace_id IN (${ph})`).all(...workspaceIds);
  return new Map(rows.map((r) => [r.id, `${r.playlist_id}|${r.source}|${r.layout_id}`]));
}

/**
 * Run fn (a mandate or setting write), then push every device whose resolution changed.
 * @param {string[]} workspaceIds — the workspaces the change can reach (the whole org for an org mandate)
 * @returns {{result: any, changed: string[]}}
 */
function withResolutionDiff(reqOrIo, workspaceIds, fn) {
  const db = dbOf();
  const ids = [...new Set((workspaceIds || []).filter(Boolean))];
  const before = snapshotResolution(db, ids);
  const result = fn();
  const after = snapshotResolution(db, ids);
  const changed = [];
  for (const [id, key] of after) if (before.get(id) !== key) changed.push(id);
  for (const id of before.keys()) if (!after.has(id) && !changed.includes(id)) changed.push(id);
  pushDevices(reqOrIo, withSyncPeers(db, changed));
  return { result, changed };
}

function withSyncPeers(db, deviceIds) {
  const out = new Set(deviceIds);
  if (!deviceIds.length) return [...out];
  try {
    const stmt = db.prepare(`
      SELECT DISTINCT m2.device_id FROM device_group_members m1
        JOIN device_groups g ON g.id = m1.group_id AND g.sync_enabled = 1
        JOIN device_group_members m2 ON m2.group_id = g.id
       WHERE m1.device_id = ?`);
    for (const id of deviceIds) for (const r of stmt.all(id)) out.add(r.device_id);
  } catch (_) { /* no groups table in a fixture */ }
  return [...out];
}

function pushDevices(reqOrIo, deviceIds) {
  if (!deviceIds || !deviceIds.length) return;
  try {
    const io = reqOrIo && reqOrIo.app ? reqOrIo.app.get('io') : reqOrIo;
    if (!io) return;
    const { buildPlaylistPayload } = require('../../ws/deviceSocket');
    const commandQueue = require('../command-queue');
    const ns = io.of('/device');
    for (const id of new Set(deviceIds)) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
  } catch (e) { console.warn(`[corporate] push failed: ${e && e.message}`); }
}

/** The workspaces a mandate target can reach. */
function workspacesForTarget(db, orgId, kind, id) {
  db = db || dbOf();
  try {
    if (kind === 'org') return db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId).map((r) => r.id);
    if (kind === 'workspace') return [id];
    if (kind === 'group') return [db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(id)?.workspace_id].filter(Boolean);
    if (kind === 'wall') return [db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(id)?.workspace_id].filter(Boolean);
    if (kind === 'device') return [db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(id)?.workspace_id].filter(Boolean);
  } catch (_) { /* fall through */ }
  return [];
}

module.exports = { withResolutionDiff, pushDevices, workspacesForTarget, snapshotResolution };
