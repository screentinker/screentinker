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
 * Stage B: local slots. Each slot of a corporate playlist resolves, per screen, to the NEAREST store
 * fill (device = video wall > group > workspace; §2.3), and the set of fills a screen plays is its
 * SIGNATURE ("slotA=fillPlaylist1;slotB=fillPlaylist7"). The composition cache is keyed by it and
 * the group-sync key appends it, so two screens sync only when they really play the same loop.
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

/* ── Local slots and the nearest fill (§2.3) ─────────────────────────────────────────────── */

const _markerCache = new WeakMap();   // db -> Map(playlistId -> { rev, len, markers })

/**
 * The slot markers of a corporate playlist's PUBLISHED composable, in order: Map<slotId, marker>.
 * Only these slots exist as far as any screen is concerned — a slot added in the draft, or removed
 * from it, takes effect on the next corporate publish (§1.3, R19). Cached per published_rev.
 */
function publishedMarkers(db, playlistId) {
  db = db || dbOf();
  const out = new Map();
  if (!playlistId) return out;
  let row;
  try { row = db.prepare('SELECT published_composable, published_rev FROM playlists WHERE id = ?').get(playlistId); } catch (_) { return out; }
  if (!row || !row.published_composable) return out;
  let perDb = _markerCache.get(db);
  if (!perDb) { perDb = new Map(); _markerCache.set(db, perDb); }
  const hit = perDb.get(playlistId);
  if (hit && hit.rev === row.published_rev && hit.len === row.published_composable.length) return hit.markers;
  let list = [];
  try { list = JSON.parse(row.published_composable); } catch (_) { list = []; }
  for (const el of Array.isArray(list) ? list : []) if (el && el.__slot) out.set(el.__slot, el);
  if (perDb.size > 500) perDb.clear();
  perDb.set(playlistId, { rev: row.published_rev, len: row.published_composable.length, markers: out });
  return out;
}

const SCOPE_RANK = { device: 4, wall: 4, group: 3, workspace: 2 };

/*
 * Fill rows that could apply to slots of P. Default = only fills a screen can play right now: in
 * state 'ok', with a published snapshot, the playlist still in the fill's workspace, the slot in P's
 * PUBLISHED composable. The add/edit redirects pass {anyState: true}: a store adding to its slot
 * must land in the fill it is building, even before that fill is first published.
 *
 * ⚠️ "In the published composable", not "not retired": removing a slot retires it in the DRAFT, and
 * like every slot change it reaches screens on the next corporate publish (R19). Filtering on
 * retired_at here blanked every store's slot content the moment head office clicked Remove.
 */
function fillCandidates(db, playlistId, { workspaceId = null, anyState = false } = {}) {
  const markers = publishedMarkers(db, playlistId);
  const rows = db.prepare(`
    SELECT f.id, f.slot_id, f.workspace_id, f.scope_kind, f.scope_id, f.fill_playlist_id, f.fill_state,
           g.priority AS g_priority, g.created_at AS g_created_at,
           (fp.published_snapshot IS NOT NULL) AS published
      FROM corporate_slot_fills f
      JOIN corporate_slots s ON s.id = f.slot_id AND s.playlist_id = ?
      JOIN playlists fp ON fp.id = f.fill_playlist_id AND fp.workspace_id = f.workspace_id
      LEFT JOIN device_groups g ON f.scope_kind = 'group' AND g.id = f.scope_id
     WHERE ${workspaceId ? 'f.workspace_id = ?' : '1 = 1'}`).all(...(workspaceId ? [playlistId, workspaceId] : [playlistId]));
  return rows.filter((r) => (anyState || (r.fill_state === 'ok' && r.published)) && (anyState || markers.has(r.slot_id)));
}

/** Does fill candidate `c` apply to device `d` (in group set `groups`)? Returns its rank, 0 = no. */
function scopeRank(c, d, groups) {
  if (c.workspace_id !== d.workspace_id) return 0;
  if (c.scope_kind === 'device') return !d.wall_id && c.scope_id === d.id ? SCOPE_RANK.device : 0;
  if (c.scope_kind === 'wall') return d.wall_id && c.scope_id === d.wall_id ? SCOPE_RANK.wall : 0;
  if (c.scope_kind === 'group') return !d.wall_id && groups && groups.has(c.scope_id) ? SCOPE_RANK.group : 0;
  if (c.scope_kind === 'workspace') return c.scope_id === d.workspace_id ? SCOPE_RANK.workspace : 0;
  return 0;
}

/** Nearest wins: device = wall > group (priority DESC, created_at ASC, id ASC) > workspace. */
function better(a, ra, b, rb) {
  if (!b) return true;
  if (ra !== rb) return ra > rb;
  if (a.scope_kind === 'group' && b.scope_kind === 'group') {
    const pa = Number(a.g_priority) || 0; const pb = Number(b.g_priority) || 0;
    if (pa !== pb) return pa > pb;
    const ca = Number(a.g_created_at) || 0; const cb = Number(b.g_created_at) || 0;
    if (ca !== cb) return ca < cb;
    return String(a.scope_id) < String(b.scope_id);
  }
  return String(a.id) < String(b.id);
}

function pickFills(d, groups, candidates) {
  const best = new Map();   // slotId -> { c, rank }
  for (const c of candidates) {
    const r = scopeRank(c, d, groups);
    if (!r) continue;
    const cur = best.get(c.slot_id);
    if (better(c, r, cur && cur.c, cur && cur.rank)) best.set(c.slot_id, { c, rank: r });
  }
  const out = new Map();
  for (const [slotId, { c }] of best) {
    out.set(slotId, { fillId: c.id, playlistId: c.fill_playlist_id, scope_kind: c.scope_kind, scope_id: c.scope_id, workspace_id: c.workspace_id, fill_state: c.fill_state });
  }
  return out;
}

function deviceGroupsInOwnWorkspace(db, deviceId) {
  return new Set(db.prepare(`SELECT m.group_id FROM device_group_members m
      JOIN device_groups g ON g.id = m.group_id JOIN devices d ON d.id = m.device_id
     WHERE m.device_id = ? AND g.workspace_id = d.workspace_id`).all(deviceId).map((r) => r.group_id));
}

/**
 * The fill each slot of corporate playlist P resolves to on this device.
 * @returns {Map<slotId, {fillId, playlistId, scope_kind, scope_id, workspace_id}>} — never throws
 */
function fillsForDevice(db, deviceId, playlistId, opts = {}) {
  db = db || dbOf();
  try {
    const d = db.prepare('SELECT id, workspace_id, wall_id FROM devices WHERE id = ?').get(deviceId);
    if (!d || !playlistId) return new Map();
    const candidates = fillCandidates(db, playlistId, { workspaceId: d.workspace_id, anyState: !!opts.anyState });
    if (!candidates.length) return new Map();
    return pickFills(d, deviceGroupsInOwnWorkspace(db, deviceId), candidates);
  } catch (_) { return new Map(); }
}

/** "slotA=pl1;slotB=pl7", sorted by slot id; '' when the screen plays no fill. */
function signatureFor(fills) {
  if (!fills || !fills.size) return '';
  return [...fills.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([slot, f]) => `${slot}=${f.playlistId}`).join(';');
}

/**
 * Every device whose resolved playlist is corporate playlist P, with its fills and signature, in
 * THREE bulk queries (resolved devices, memberships, fill candidates) — never one query per device:
 * a corporate publish reaches thousands of screens (risk R6, the open loop-spike issue).
 * @returns {Map<deviceId, {signature, fills, workspace_id, wall_id}>}
 */
function signaturesForPlaylist(db, playlistId) {
  db = db || dbOf();
  const out = new Map();
  if (!playlistId) return out;
  try {
    const devices = db.prepare(`SELECT d.id, d.workspace_id, d.wall_id FROM device_resolved_playlist r
        JOIN devices d ON d.id = r.device_id WHERE r.playlist_id = ? AND r.source = 'corporate'`).all(playlistId);
    if (!devices.length) return out;
    const candidates = fillCandidates(db, playlistId);
    if (!candidates.length) {
      for (const d of devices) out.set(d.id, { signature: '', fills: new Map(), workspace_id: d.workspace_id, wall_id: d.wall_id });
      return out;
    }
    const groups = new Map();
    if (candidates.some((c) => c.scope_kind === 'group')) {
      for (const r of db.prepare(`SELECT m.device_id, m.group_id FROM device_group_members m
          JOIN device_groups g ON g.id = m.group_id JOIN devices d ON d.id = m.device_id
         WHERE g.workspace_id = d.workspace_id
           AND m.device_id IN (SELECT device_id FROM device_resolved_playlist WHERE playlist_id = ? AND source = 'corporate')`).all(playlistId)) {
        if (!groups.has(r.device_id)) groups.set(r.device_id, new Set());
        groups.get(r.device_id).add(r.group_id);
      }
    }
    for (const d of devices) {
      const fills = pickFills(d, groups.get(d.id) || null, candidates);
      out.set(d.id, { signature: signatureFor(fills), fills, workspace_id: d.workspace_id, wall_id: d.wall_id });
    }
  } catch (_) { /* tables absent: no fills */ }
  return out;
}

/* ── Group sync key (§2.4) ────────────────────────────────────────────────────────────────── */

// A key is the playlist id, plus '|' + the fill signature when there is one. No fills -> the plain
// playlist id, so a slot-less corporate playlist (and every Stage A expectation) keys exactly as before.
const keyOf = (playlistId, sig) => (playlistId ? (sig ? `${playlistId}|${sig}` : playlistId) : null);

/**
 * The fills a GROUP's members share for P: this group's own fill per slot, else its workspace's
 * (§2.4). A member with a device-level fill, or in a higher-priority group with its own, plays
 * something else and drops out of sync.
 */
function groupFills(db, group, playlistId) {
  const ws = group.workspace_id || wsOfGroup(db, group.id);
  const out = new Map();
  for (const c of fillCandidates(db, playlistId, { workspaceId: ws })) {
    const rank = c.scope_kind === 'group' && c.scope_id === group.id ? 3 : c.scope_kind === 'workspace' && c.scope_id === ws ? 2 : 0;
    if (!rank) continue;
    const cur = out.get(c.slot_id);
    if (!cur || rank > cur.rank) out.set(c.slot_id, { rank, playlistId: c.fill_playlist_id });
  }
  return out;
}

/**
 * What a group's members must share to sync. Without a covering mandate: the group's playlist id
 * (today's behaviour, byte-identical). With one: the corporate playlist id, plus the signature of
 * the fills the group's members play. null = cannot sync. A dark mandate has nothing to play, so
 * nothing to sync.
 */
function syncKeyForGroup(db, group) {
  if (!group) return null;
  db = db || dbOf();
  if (!runtime.active(db)) return group.playlist_id || null;
  const g = group.id ? { id: group.id, workspace_id: group.workspace_id || wsOfGroup(db, group.id) } : group;
  const m = groupCoverage(db, g);
  if (m) {
    if (m.dark) return null;
    let sig = '';
    try { sig = signatureFor(groupFills(db, g, m.playlist_id)); } catch (_) { sig = ''; }
    return keyOf(m.playlist_id, sig);
  }
  return group.playlist_id || null;
}

function wsOfGroup(db, groupId) {
  try { return (db || dbOf()).prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(groupId)?.workspace_id || null; } catch (_) { return null; }
}

/** A device's sync key: its resolved playlist id, plus its fill signature on a mandated screen. */
function syncKeyForDevice(db, deviceId) {
  db = db || dbOf();
  const r = db.prepare('SELECT playlist_id, source FROM device_resolved_playlist WHERE device_id = ?').get(deviceId);
  if (!r || !r.playlist_id) return null;
  if (r.source !== 'corporate' || !runtime.active(db)) return r.playlist_id;
  return keyOf(r.playlist_id, signatureFor(fillsForDevice(db, deviceId, r.playlist_id)));
}

/** Does any member's key need its signature checked? Only when the base playlist has fills at all. */
function keyNeedsSignature(db, key) {
  if (!key || !runtime.active(db)) return false;
  if (String(key).includes('|')) return true;
  try {
    return !!db.prepare(`SELECT 1 FROM corporate_slot_fills f JOIN corporate_slots s ON s.id = f.slot_id
        WHERE s.playlist_id = ? LIMIT 1`).get(key);
  } catch (_) { return false; }
}

const baseOf = (key) => String(key).split('|')[0];

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
  const rows = db.prepare(`
    SELECT ${columns}${keyNeedsSignature(db, key) ? ', d.id AS __sync_id' : ''} FROM devices d
    JOIN device_group_members dgm ON dgm.device_id = d.id
    JOIN device_resolved_playlist r ON r.device_id = d.id
    WHERE dgm.group_id = ? AND r.playlist_id = ? ORDER BY d.id
  `).all(group.id, baseOf(key));
  if (!keyNeedsSignature(db, key)) return rows;
  return rows.filter((r) => syncKeyForDevice(db, r.__sync_id) === key).map((r) => { const { __sync_id, ...rest } = r; return rest; });
}

/** Is deviceId an eligible sync sender/member of this sync-enabled group? */
function isSyncMember(db, group, deviceId) {
  db = db || dbOf();
  if (!group || !group.sync_enabled) return false;
  const key = syncKeyForGroup(db, group);
  if (!key) return false;
  const ok = !!db.prepare(`
    SELECT 1 FROM device_group_members dgm
    JOIN device_resolved_playlist r ON r.device_id = dgm.device_id
    WHERE dgm.group_id = ? AND dgm.device_id = ? AND r.playlist_id = ?
  `).get(group.id, deviceId, baseOf(key));
  if (!ok || !keyNeedsSignature(db, key)) return ok;
  return syncKeyForDevice(db, deviceId) === key;
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
  let deviceKey;   // computed once, and only if some group's key needs the signature
  for (const g of candidates) {
    const gk = syncKeyForGroup(db, g);
    if (!gk || baseOf(gk) !== devicePlaylistId) continue;
    if (keyNeedsSignature(db, gk)) {
      if (deviceKey === undefined) deviceKey = syncKeyForDevice(db, deviceId);
      if (deviceKey !== gk) continue;
    }
    const { workspace_id, ...row } = g;   // same shape as the pre-feature query
    return row;
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
  publishedMarkers, fillCandidates, fillsForDevice, signatureFor, signaturesForPlaylist, scopeRank,
  syncKeyForGroup, syncKeyForDevice, syncMembers, isSyncMember, deviceSyncGroup,
};
