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
 * Stage B adds the per-store COMPOSITION events (spec §3.4): a corporate publish, a fill publish, a
 * fill row made or removed, a fill crossing its limit. Each computes what every affected screen
 * composes to before and after, and pushes ONLY the screens whose composed loop actually changed —
 * the same change-triggered rule as publishPlaylist, so an unrelated edit never restarts a store's
 * loop (#234 shape). Correctness never depends on these pushes: the composition cache re-checks its
 * inputs on every read (lib/corporate/composition.js); a forgotten push only delays the update.
 */

const runtime = require('./runtime');

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

/* ── Compositions (Stage B) ─────────────────────────────────────────────────────────────────── */

const keyOfComposition = (c) => `${c.playback_order}|${JSON.stringify(c.items)}`;

/**
 * What each mandated screen of corporate playlist P composes to: Map<deviceId, key>. One compose per
 * distinct fill signature, never one per screen (risk R6). `only` restricts to a set of device ids.
 */
function composedKeys(db, playlistId, only = null) {
  const resolve = require('./resolve');
  const composition = require('./composition');
  const out = new Map();
  const bySig = new Map();
  for (const [id, d] of resolve.signaturesForPlaylist(db, playlistId)) {
    if (only && !only.has(id)) continue;
    let k = bySig.get(d.signature);
    if (k === undefined) {
      k = keyOfComposition(composition.compositionForFills(db, playlistId, d.fills));
      bySig.set(d.signature, k);
    }
    out.set(id, k);
  }
  return out;
}

function changedKeys(before, after) {
  const changed = [];
  for (const [id, k] of after) if (before.get(id) !== k) changed.push(id);
  for (const id of before.keys()) if (!after.has(id)) changed.push(id);
  return changed;
}

/**
 * Run fn (a fill row write, a fill state change), then push every screen on P whose composed loop
 * changed. Inactive machinery -> just fn().
 */
function withCompositionDiff(reqOrIo, playlistIds, fn) {
  const db = dbOf();
  const ids = [...new Set((Array.isArray(playlistIds) ? playlistIds : [playlistIds]).filter(Boolean))];
  if (!runtime.active(db) || !ids.length) return { result: fn(), changed: [] };
  const before = new Map(ids.map((p) => [p, composedKeys(db, p)]));
  const result = fn();
  const changed = new Set();
  for (const p of ids) for (const id of changedKeys(before.get(p), composedKeys(db, p))) changed.add(id);
  pushDevices(reqOrIo, withSyncPeers(db, [...changed]));
  return { result, changed: [...changed] };
}

/**
 * Called by publishPlaylist BEFORE it writes. Captures what the screens that can be affected play
 * now: every mandated screen for a corporate playlist; for a fill, the mandated screens inside the
 * fill's scope (whether they pick it today or not — a fill coming back from over_limit starts
 * playing on screens that did not have it). null = nothing corporate about this publish.
 */
function beforePublish(playlistId) {
  const db = dbOf();
  if (!runtime.active(db)) return null;
  const probe = require('./schema-probe');
  if (!probe.hasColumn(db, 'playlists', 'corporate')) return null;
  try {
    const row = db.prepare('SELECT corporate FROM playlists WHERE id = ?').get(playlistId);
    if (row && row.corporate) return { kind: 'corporate', playlistId, before: composedKeys(db, playlistId) };
    const fillsLib = require('./fills');
    const rows = fillsLib.fillsOfPlaylist(db, playlistId);
    if (!rows.length) return null;
    const per = new Map();   // corporate playlist -> Set(deviceId)
    for (const f of rows) {
      if (!per.has(f.corporate_playlist_id)) per.set(f.corporate_playlist_id, new Set());
      for (const id of fillsLib.devicesInFillScope(db, f)) per.get(f.corporate_playlist_id).add(id);
    }
    const out = new Map();
    for (const [p, ids] of per) out.set(p, { ids, before: composedKeys(db, p, ids) });
    return { kind: 'fill', playlistId, per: out };
  } catch (e) {
    console.warn(`[corporate] beforePublish failed for ${playlistId}: ${e && e.message}`);
    return null;
  }
}

/**
 * After a corporate publish, every fill of its slots is re-judged against the limits that just went
 * live: head office lowering a limit marks over-limit fills 'over_limit' (they stop playing; the
 * slot falls back) rather than silently truncating them — and raising it again brings them back.
 */
function recheckSlotFills(db, playlistId, reason = 'limit_changed') {
  const resolve = require('./resolve');
  const fillsLib = require('./fills');
  const { fillViolation } = require('./compose');
  const { contentDurationLookup } = require('./composition');
  const markers = resolve.publishedMarkers(db, playlistId);
  if (!markers.size) return [];
  const rows = db.prepare(`SELECT f.*, s.name AS slot_name FROM corporate_slot_fills f JOIN corporate_slots s ON s.id = f.slot_id
                            WHERE s.playlist_id = ?`).all(playlistId);
  const pairs = [];
  for (const f of rows) {
    const m = markers.get(f.slot_id);
    if (!m) continue;
    const t = fillsLib.publishedTotals(db, f.fill_playlist_id);
    if (!t.published) continue;
    const v = fillViolation(t.items_list, m.limits || {}, { slotName: f.slot_name, contentDuration: contentDurationLookup(db, [t.items_list]) });
    pairs.push([f, v ? 'over_limit' : 'ok']);
  }
  return fillsLib.setFillStates(db, pairs, reason);
}

/** Called by publishPlaylist AFTER it wrote: re-judge fills (corporate), then push what changed. */
function afterPublish(ctx, reqOrIo) {
  if (!ctx) return;
  const db = dbOf();
  try {
    const changed = new Set();
    if (ctx.kind === 'corporate') {
      recheckSlotFills(db, ctx.playlistId);
      for (const id of changedKeys(ctx.before, composedKeys(db, ctx.playlistId))) changed.add(id);
    } else {
      for (const [p, { ids, before }] of ctx.per) {
        for (const id of changedKeys(before, composedKeys(db, p, ids))) changed.add(id);
      }
    }
    pushDevices(reqOrIo, withSyncPeers(db, [...changed]));
  } catch (e) { console.warn(`[corporate] afterPublish failed for ${ctx.playlistId}: ${e && e.message}`); }
}

/**
 * A content row's bytes (or probed length) changed. Every fill whose PUBLISHED snapshot plays it is
 * re-judged with the new length: a video that grew past the slot's seconds marks the fill
 * 'over_limit' (not playing, store told why), and one that shrank back marks it 'ok'.
 */
function recheckFillsForContent(reqOrIo, contentId) {
  const db = dbOf();
  if (!contentId || !runtime.active(db)) return [];
  const fillsLib = require('./fills');
  const { fillViolation } = require('./compose');
  const { contentDurationLookup } = require('./composition');
  let rows = [];
  try {
    rows = db.prepare(`SELECT f.*, s.playlist_id AS corporate_playlist_id FROM corporate_slot_fills f
        JOIN corporate_slots s ON s.id = f.slot_id JOIN playlists fp ON fp.id = f.fill_playlist_id
       WHERE fp.published_snapshot LIKE ?`).all(`%${String(contentId).replace(/[%_]/g, '')}%`);
  } catch (_) { return []; }
  if (!rows.length) return [];
  let changedFills = [];
  withCompositionDiff(reqOrIo, rows.map((r) => r.corporate_playlist_id), () => {
    const pairs = [];
    for (const f of rows) {
      const slot = fillsLib.slotRow(db, f.slot_id);
      if (!slot) continue;
      const t = fillsLib.publishedTotals(db, f.fill_playlist_id);
      const v = fillViolation(t.items_list, fillsLib.limitsFor(db, slot), { slotName: slot.name, contentDuration: contentDurationLookup(db, [t.items_list]) });
      pairs.push([f, v ? 'over_limit' : 'ok']);
    }
    changedFills = fillsLib.setFillStates(db, pairs, 'content_changed');
  });
  return changedFills;
}

module.exports = {
  withResolutionDiff, pushDevices, workspacesForTarget, snapshotResolution,
  composedKeys, withCompositionDiff, beforePublish, afterPublish, recheckSlotFills, recheckFillsForContent, withSyncPeers,
};
