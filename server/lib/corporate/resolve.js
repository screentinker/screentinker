'use strict';

/*
 * Corporate resolution helpers that are NOT the view: "which mandate covers this screen / group",
 * and the group-sync key.
 *
 * mandateFor runs the SAME expression the resolver view uses (MANDATE_EXPR, imported, never
 * pasted), but directly against devices rather than through device_resolved_playlist — so it keeps
 * answering correctly in degraded mode, when the previous views are in place (the guards that call
 * it short-circuit on runtime.active anyway).
 *
 * Stage A: no slots, so a mandated screen's sync key is simply the corporate playlist id. Stage B
 * appends '|' + the fill signature (§2.4).
 */

const { MANDATE_EXPR } = require('../playlist-resolver-sql');
const runtime = require('./runtime');

function dbOf() { return require('../../db/database').db; }

const MANDATE_FOR_SQL = `
  SELECT cm.*, p.name AS playlist_name, d.id AS device_id
    FROM (SELECT d.id, ${MANDATE_EXPR} AS mandate_id FROM devices d WHERE d.id = ?) d
    JOIN corporate_mandates cm ON cm.id = d.mandate_id
    LEFT JOIN playlists p ON p.id = cm.playlist_id`;

/** The mandate a device plays under, or null. Never throws. */
function mandateFor(db, deviceId) {
  if (!deviceId) return null;
  try { return (db || dbOf()).prepare(MANDATE_FOR_SQL).get(deviceId) || null; } catch (_) { return null; }
}

/** Mandates for many devices at once: Map<deviceId, mandate|null>. */
function mandatesFor(db, deviceIds) {
  const out = new Map();
  for (const id of new Set(deviceIds || [])) out.set(id, mandateFor(db, id));
  return out;
}

// Only rows the view itself would honour: enabled, org switched on, a same-org corporate playlist.
const VALID_MANDATE = `cm.enabled = 1
  AND (SELECT o.corporate_enabled FROM organizations o WHERE o.id = cm.organization_id) = 1
  AND (cm.dark = 1 OR EXISTS (SELECT 1 FROM playlists p JOIN workspaces pw ON pw.id = p.workspace_id
                               WHERE p.id = cm.playlist_id AND p.corporate = 1
                                 AND pw.organization_id = cm.organization_id))`;

/**
 * The mandate that covers a GROUP as a whole — its own group-level mandate, else its workspace's,
 * else its org's — or null. "Covered" is what makes a group-level override pointless (every
 * non-wall member plays head office's playlist regardless).
 */
function groupCoverage(db, groupOrId) {
  db = db || dbOf();
  try {
    const group = typeof groupOrId === 'string'
      ? db.prepare('SELECT id, workspace_id, name FROM device_groups WHERE id = ?').get(groupOrId)
      : groupOrId;
    if (!group || !group.workspace_id) return null;
    const ws = db.prepare('SELECT id, organization_id FROM workspaces WHERE id = ?').get(group.workspace_id);
    if (!ws) return null;
    return db.prepare(`
      SELECT cm.*, p.name AS playlist_name FROM corporate_mandates cm
        LEFT JOIN playlists p ON p.id = cm.playlist_id
       WHERE cm.organization_id = ? AND ${VALID_MANDATE}
         AND ((cm.target_kind = 'group' AND cm.target_id = ?)
           OR (cm.target_kind = 'workspace' AND cm.target_id = ?)
           OR (cm.target_kind = 'org' AND cm.target_id = cm.organization_id))
       ORDER BY CASE cm.target_kind WHEN 'group' THEN 3 WHEN 'workspace' THEN 2 ELSE 1 END DESC,
                cm.created_at ASC, cm.id ASC
       LIMIT 1`).get(ws.organization_id, group.id, ws.id) || null;
  } catch (_) { return null; }
}

/** How many of a group's members are mandated (any level). */
function mandatedMembers(db, groupId) {
  db = db || dbOf();
  const ids = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(groupId).map((r) => r.device_id);
  return ids.filter((id) => mandateFor(db, id));
}

/* ── Group sync key (§2.4) ────────────────────────────────────────────────────────────────── */

/**
 * What a group's members must share to sync. Without a covering mandate: the group's playlist id
 * (today's behaviour, byte-identical). With one: the corporate playlist id. null = cannot sync.
 * A dark mandate has nothing to play, so nothing to sync.
 */
function syncKeyForGroup(db, group) {
  if (!group) return null;
  if (!runtime.active(db || dbOf())) return group.playlist_id || null;
  const m = groupCoverage(db, group.id ? { id: group.id, workspace_id: group.workspace_id || wsOfGroup(db, group.id) } : group);
  if (m) return m.dark ? null : m.playlist_id;
  return group.playlist_id || null;
}

function wsOfGroup(db, groupId) {
  try { return (db || dbOf()).prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(groupId)?.workspace_id || null; } catch (_) { return null; }
}

/** A device's sync key: its resolved playlist id (Stage B adds the fill signature). */
function syncKeyForDevice(db, deviceId) {
  db = db || dbOf();
  const r = db.prepare('SELECT playlist_id FROM device_resolved_playlist WHERE device_id = ?').get(deviceId);
  return (r && r.playlist_id) || null;
}

/**
 * Sync-eligible members of a group, with the given device columns. THE ONE definition used by
 * groupSyncMembers, syncDecisionFor and groupSenderEligible (critique R2: a fourth reader was
 * missed once). Inactive -> the exact pre-feature SQL.
 */
function syncMembers(db, group, columns) {
  db = db || dbOf();
  if (!group) return [];
  const key = syncKeyForGroup(db, group);
  if (!key) return [];
  return db.prepare(`
    SELECT ${columns} FROM devices d
    JOIN device_group_members dgm ON dgm.device_id = d.id
    JOIN device_resolved_playlist r ON r.device_id = d.id
    WHERE dgm.group_id = ? AND r.playlist_id = ? ORDER BY d.id
  `).all(group.id, key);
}

/** Is deviceId an eligible sync sender/member of this sync-enabled group? */
function isSyncMember(db, group, deviceId) {
  db = db || dbOf();
  if (!group || !group.sync_enabled) return false;
  const key = syncKeyForGroup(db, group);
  if (!key) return false;
  return !!db.prepare(`
    SELECT 1 FROM device_group_members dgm
    JOIN device_resolved_playlist r ON r.device_id = dgm.device_id
    WHERE dgm.group_id = ? AND dgm.device_id = ? AND r.playlist_id = ?
  `).get(group.id, deviceId, key);
}

/**
 * The device's sync group: a sync-enabled group it belongs to whose key matches the device's.
 * Inactive -> the exact pre-feature query (groups whose playlist_id IS the device's playlist).
 */
function deviceSyncGroup(db, deviceId, devicePlaylistId) {
  db = db || dbOf();
  if (!devicePlaylistId) return null;
  if (!runtime.active(db)) {
    return db.prepare(`
      SELECT g.id, g.sync_enabled, g.playlist_id, g.leader_device_id, g.sync_backend
      FROM device_groups g JOIN device_group_members dgm ON dgm.group_id = g.id
      WHERE dgm.device_id = ? AND g.sync_enabled = 1 AND g.playlist_id = ?
      ORDER BY g.name ASC, g.id ASC LIMIT 1
    `).get(deviceId, devicePlaylistId) || null;
  }
  const candidates = db.prepare(`
    SELECT g.id, g.workspace_id, g.sync_enabled, g.playlist_id, g.leader_device_id, g.sync_backend
    FROM device_groups g JOIN device_group_members dgm ON dgm.group_id = g.id
    WHERE dgm.device_id = ? AND g.sync_enabled = 1
    ORDER BY g.name ASC, g.id ASC
  `).all(deviceId);
  for (const g of candidates) {
    if (syncKeyForGroup(db, g) === devicePlaylistId) {
      const { workspace_id, ...row } = g;   // same shape as the pre-feature query
      return row;
    }
  }
  return null;
}

/* ── "Paused by head office" (§7.10, critique R13) ─────────────────────────────────────────── */

/*
 * What each mandated screen in a workspace WOULD play without its mandate — the pre-mandate ladder,
 * identical to the view's ELSE branch. A store playlist that a mandate shadows is not "used by 0
 * screens", and a list that says so invites someone to delete it.
 *
 * @returns {Map<playlistId, count>}
 */
function pausedCounts(db, workspaceId) {
  db = db || dbOf();
  const out = new Map();
  if (!workspaceId || !runtime.active(db)) return out;
  try {
    for (const r of db.prepare(`
      SELECT CASE WHEN d.playlist_source = 'none' AND d.scheduled_playlist_id IS NULL THEN NULL ELSE COALESCE(
               d.scheduled_playlist_id, CASE WHEN d.playlist_source = 'device' THEN d.playlist_id END,
               i.wall_playlist_id, i.group_playlist_id, d.playlist_id) END AS would_play
        FROM devices d
        JOIN device_inherited_playlist i ON i.device_id = d.id
        JOIN device_resolved_playlist r ON r.device_id = d.id
       WHERE d.workspace_id = ? AND r.source = 'corporate'`).all(workspaceId)) {
      if (r.would_play) out.set(r.would_play, (out.get(r.would_play) || 0) + 1);
    }
  } catch (_) { /* views degraded or absent */ }
  return out;
}

module.exports = {
  pausedCounts,
  mandateFor, mandatesFor, groupCoverage, mandatedMembers,
  syncKeyForGroup, syncKeyForDevice, syncMembers, isSyncMember, deviceSyncGroup,
};
