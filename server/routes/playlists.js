const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
// Phase 2.2k: workspace-aware access. requirePlaylistOwnership is replaced
// by read/write helpers gated on the playlist's workspace_id.
const { accessContext } = require('../lib/tenancy');
const { resolveItemDuration } = require('../lib/item-duration');
const { parseTags, parseMeta } = require('../lib/content-tags');
const { emitMuteChanged } = require('../lib/mute-sync');

// Per-item play window: local YYYY-MM-DDTHH:MM, inclusive. Empty/null clears.
const PLAY_STAMP_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
function normalizePlayStamp(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !PLAY_STAMP_RE.test(v)) return false;
  // Reject impossible calendar dates (e.g. 2026-13-01, 2026-02-30). The regex only checks shape, and
  // the JS player compares stamps as strings while the Kotlin player parses them — a bogus stamp
  // would make the two disagree. Validating at write time keeps only real dates in the snapshot.
  const [d] = v.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, da));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) return false;
  return v;
}
function laterStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}
function earlierStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a <= b ? a : b;
}

const FIT_MODES = new Set(['contain', 'cover', 'fill']);
function normalizeFitMode(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'inherit') return null;
  if (typeof v !== 'string') return false;
  const s = v.toLowerCase();
  // BrightSign-style aliases: fit=letterbox, stretch=distort, fill=crop.
  const mapped = s === 'fit' ? 'contain' : s === 'stretch' ? 'fill' : s;
  return FIT_MODES.has(mapped) ? mapped : false;
}
function parsePlayWhen(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === false) return null;
  const obj = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return false; } })() : v;
  if (!obj || typeof obj !== 'object') return false;
  const type = obj.type || (obj.slug ? 'ds' : (obj.tag || obj.op === 'has' || obj.op === 'lacks' ? 'tag' : 'ds'));
  if (type === 'tag') {
    const tag = String(obj.value || obj.tag || '').trim().toLowerCase();
    if (!tag) return false;
    return { type: 'tag', op: obj.op === 'lacks' ? 'lacks' : 'has', value: tag };
  }
  if (type === 'meta') {
    const path = typeof obj.path === 'string' ? obj.path.trim() : '';
    const op = obj.op || 'eq';
    if (!path) return false;
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'has'].includes(op)) return false;
    return { type: 'meta', path, op, value: obj.value == null ? null : obj.value };
  }
  const slug = typeof obj.slug === 'string' ? obj.slug.trim() : '';
  const path = typeof obj.path === 'string' ? obj.path.trim() : '';
  const op = obj.op || 'eq';
  if (!slug || !path) return false;
  if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'].includes(op)) return false;
  return { type: 'ds', slug, path, op, value: obj.value == null ? null : obj.value };
}
function normalizePlaybackOrder(v) {
  if (v === undefined) return undefined;
  const s = String(v || 'sequential').toLowerCase();
  return (s === 'shuffle' || s === 'weighted' || s === 'sequential') ? s : false;
}
function normalizeWeight(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return false;
  return Math.min(1000, Math.floor(n));
}
function attachPlayWhen(it) {
  if (!it.play_when) { delete it.play_when; return; }
  const parsed = parsePlayWhen(it.play_when);
  if (parsed) it.play_when = parsed; else delete it.play_when;
}
function decorateEditorItems(items) {
  const ids = [...new Set((items || []).map((it) => it.content_id).filter(Boolean))];
  if (!ids.length) return items;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, tags, meta FROM content WHERE id IN (${ph})`).all(...ids);
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const it of items) {
    const row = it.content_id && map.get(it.content_id);
    if (!row) continue;
    const tags = parseTags(row.tags);
    if (tags.length) it.tags = tags;
    const meta = parseMeta(row.meta);
    if (meta && Object.keys(meta).length) it.meta = meta;
  }
  return items;
}

// Re-probe video duration with ffprobe if content.duration_sec is missing
async function probeAndUpdateDuration(content) {
  if (content.duration_sec) return content.duration_sec;
  if (!content.mime_type || !content.mime_type.startsWith('video/')) return null;
  if (!content.filepath) return null;
  try {
    const { execFile } = require('child_process');
    const fullPath = path.join(config.contentDir, content.filepath);
    const probe = await new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', fullPath
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const info = JSON.parse(probe);
    if (info.format?.duration) {
      const dur = parseFloat(info.format.duration);
      db.prepare('UPDATE content SET duration_sec = ? WHERE id = ?').run(dur, content.id);
      return dur;
    }
  } catch (e) {
    console.warn('ffprobe re-probe failed for', content.id, e.message);
  }
  return null;
}

// Phase 2.2k: workspace-aware playlist access. Returns the playlist row (with
// req.playlistCtx populated) or sends 403/404. requireWrite=false for reads.
function loadPlaylistAccess(req, res, requireWrite) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) { res.status(404).json({ error: 'playlist not found' }); return null; }
  if (!playlist.workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(playlist.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.playlist = playlist;
  req.playlistCtx = ctx;
  return playlist;
}

function requirePlaylistRead(req, res, next) {
  if (!loadPlaylistAccess(req, res, false)) return;
  next();
}

function requirePlaylistWrite(req, res, next) {
  if (!loadPlaylistAccess(req, res, true)) return;
  next();
}

/*
 * Slide audio, resolved from content ids into URLs the player can actually fetch.
 *
 * ⚠️ RESOLVED HERE BECAUSE ONLY HERE CAN. The slide config stores content IDs, and a player has no
 * way to turn one into a file: /api/content/:id/file is authenticated and a player is not a
 * dashboard user. Every other media item in this snapshot is denormalized the same way — the
 * player is handed a path, never an id to look up.
 *
 * ⚠️ THE MUSIC ID IS SENT AS WELL AS ITS URL, and that is the load-bearing part. The player keeps
 * one bed alive across items for as long as consecutive items name the SAME track; it compares the
 * id, not the URL, because /api/content/:id/replace keeps the id and writes a new filepath — so
 * comparing URLs would restart the music the first time somebody swapped the file.
 *
 * Silent for everything that is not a slide with audio, so the snapshot for every other item is
 * byte-identical to what it was.
 */
function attachSlideAudio(it) {
  if (it.widget_type !== 'slide' || !it.widget_config) return;
  let cfg;
  try { cfg = JSON.parse(it.widget_config); } catch { return; }
  const a = cfg && cfg.template && cfg.template.audio;
  if (!a || (!a.vo && !a.music)) return;

  const url = (id) => {
    if (!id) return null;
    const row = db.prepare('SELECT filepath, remote_url FROM content WHERE id = ?').get(id);
    if (!row) return null;
    return row.remote_url || (row.filepath ? `/uploads/content/${row.filepath}` : null);
  };

  const vo = url(a.vo);
  const music = url(a.music);
  if (!vo && !music) return;

  it.audio = {
    ...(vo ? { vo_url: vo, vo_volume: typeof a.vo_volume === 'number' ? a.vo_volume : 1 } : {}),
    ...(music ? { music_id: a.music, music_url: music, music_volume: typeof a.music_volume === 'number' ? a.music_volume : 0.4 } : {}),
  };
}

// Build the snapshot item list for a playlist (denormalized for device payload)
function buildSnapshotItems(playlistId, _depth = 0, _ancestors = null) {
  // A nesting cycle (A contains B contains A) would recurse here until the stack overflows and
  // publish/preview 500s. The old MAX_NEST_DEPTH guard was DEAD: this function recursed via
  // expandChildPlaylists which called back in with depth reset to 0. Thread the depth, and also
  // track the ancestor chain PER PATH (so two items legitimately referencing the same child are
  // still fine) and refuse a repeat outright.
  const ancestors = _ancestors || [];
  if (ancestors.includes(playlistId)) {
    console.warn(`[playlist] nesting cycle at ${playlistId} — reference dropped`);
    return [];
  }
  const items = db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
           pi.play_from, pi.play_until, pi.enabled, pi.log_play, pi.fit_mode, pi.play_when, pi.weight,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url, c.unstable_connection,
           c.captions_enabled, c.captions_lang, c.subtitle_url, c.subtitle_lang,
           c.tags AS content_tags, c.meta AS content_meta,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
      -- #157: a content-backed item is dropped from the snapshot once it's deactivated
      -- (is_active=0) or past its expiry (expires_at<=now). Widget items (content_id NULL)
      -- and dangling content (deleted row -> c.* NULL) are unaffected via COALESCE. This is
      -- the LIVE check so a publish between expiry and the next sweep tick already excludes it.
      AND (
        pi.content_id IS NULL
        OR (COALESCE(c.is_active, 1) = 1 AND (c.expires_at IS NULL OR c.expires_at > strftime('%s','now')))
      )
      -- Deactivated playlist items are dropped so old players (which ignore enabled) skip them too.
      AND COALESCE(pi.enabled, 1) = 1
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
  // #74/#75: attach per-item schedule blocks (the player honours these in its own
  // local time via the shared evaluator). An item with zero blocks gets no
  // `schedules` field -> always on. Additive: old players ignore the field. _iid is
  // only used here to fetch blocks and is then dropped (snapshot stays id-free).
  // widget_rev is widgets.updated_at, and a data-source change bumps that for the widgets bound
  // to the changed slug (lib/data-sources/service.js bumpDependentWidgets); no workspace-wide
  // MAX(data_sources.updated_at) here, which re-revved unrelated widgets on any rename.
  for (const it of items) {
    const blocks = schedulesForItem(it._iid);
    if (blocks.length) it.schedules = blocks;
    if (!it.play_from) delete it.play_from;
    if (!it.play_until) delete it.play_until;
    if (it.enabled === 0) { /* kept out by the WHERE; belt */ }
    delete it.enabled;
    if (it.log_play === 0) it.log_play = 0; else delete it.log_play;
    if (!it.fit_mode) delete it.fit_mode;
    attachPlayWhen(it);
    const tags = parseTags(it.content_tags);
    if (tags.length) it.tags = tags;
    delete it.content_tags;
    const meta = parseMeta(it.content_meta);
    if (meta && Object.keys(meta).length) it.meta = meta;
    delete it.content_meta;
    if (it.weight && Number(it.weight) !== 1) it.weight = Number(it.weight); else delete it.weight;
    delete it._iid;
    attachSlideAudio(it);
  }

  /*
   * ⚠️ NESTING IS EXPANDED HERE, AND NOWHERE ELSE.
   *
   * This function is the single source of `published_snapshot`, so flattening here means the
   * snapshot stays a FLAT ordered array and NO PLAYER LEARNS WHAT NESTING IS. Three things fall
   * out of that for free, and they are the reason this is the right seam:
   *
   *   - offline pinning is unchanged: expanded items are ordinary items carrying `filepath`
   *   - the trigger offline-playability guard is unchanged: it walks published_snapshot, which is
   *     post-expansion, so a nested unpinnable item is already refused by the rule shipped earlier
   *   - the player's structural fingerprint sees ordinary items, so nothing there needs teaching
   *
   * ⚠️ ONE LEVEL ONLY, and that is enforced when the reference is CREATED (routes below refuse a
   * child that itself holds a child), not by traversing here. A→B→A therefore cannot be
   * constructed, so there is no cycle to detect at expansion time. This mirrors how MagicINFO does
   * it — by type rather than by traversal — because a checker that runs at publish is a checker
   * that can be reached with data already in the database.
   *
   * The `depth` guard below is belt-and-braces against a row written by some other path (an
   * import, a migration, a manual fix-up). It is not the primary defence and must not become it.
   */
  return expandChildPlaylists(items, _depth, [...ancestors, playlistId]);
}

/** Max nesting depth. 1 = a playlist may contain playlists, but those may not. */
const MAX_NEST_DEPTH = 1;

function expandChildPlaylists(items, depth, ancestors) {
  if (!items.some((i) => i && i.child_playlist_id)) return items;   // common case: no work, no copy
  const out = [];
  for (const it of items) {
    if (!it || !it.child_playlist_id) { out.push(it); continue; }
    if (depth >= MAX_NEST_DEPTH) {
      // Should be unreachable — creation refuses this. Dropping the reference is the only safe
      // action left: keeping it would ship an item the player cannot render.
      console.warn(`[playlist] nesting deeper than ${MAX_NEST_DEPTH} at child ${it.child_playlist_id} — reference dropped`);
      continue;
    }
    // Recurse through buildSnapshotItems so the child gets the SAME treatment as a top-level
    // playlist: the same is_active/expiry filter, the same per-item schedule blocks. Anything less
    // and a nested item would obey different rules from the identical item played directly.
    for (const child of buildSnapshotItems(it.child_playlist_id, depth + 1, ancestors)) {
      const play_from = laterStamp(it.play_from, child.play_from);
      const play_until = earlierStamp(it.play_until, child.play_until);
      const merged = { ...child, zone_id: child.zone_id || it.zone_id };
      if (play_from) merged.play_from = play_from; else delete merged.play_from;
      if (play_until) merged.play_until = play_until; else delete merged.play_until;
      out.push(merged);
    }
  }
  return out;
}

// #104: a playlist isn't bound to a device, so it has no intrinsic layout. Derive
// one from the playlist's own zone-bound items via the FK chain
// playlist_items.zone_id -> layout_zones.id -> layout_zones.layout_id. 0 zoned items
// -> fullscreen (null); 1 distinct layout -> use it; >1 (rare/legacy: zones from
// different layouts) -> the layout covering the MOST items, flagged ambiguous so the
// dashboard can caption it. Never throws.
function derivePreviewLayout(assignments) {
  const zoneIds = [...new Set((assignments || []).map(a => a && a.zone_id).filter(Boolean))];
  if (zoneIds.length === 0) return null;
  const ph = zoneIds.map(() => '?').join(',');
  const zoneRows = db.prepare(`SELECT id, layout_id FROM layout_zones WHERE id IN (${ph})`).all(...zoneIds);
  if (zoneRows.length === 0) return null; // dangling zone_ids -> fullscreen
  const layoutIds = [...new Set(zoneRows.map(r => r.layout_id))];
  let layoutId = layoutIds[0];
  let ambiguous = false;
  if (layoutIds.length > 1) {
    ambiguous = true;
    const z2l = new Map(zoneRows.map(r => [r.id, r.layout_id]));
    const tally = {};
    for (const a of assignments) { const l = z2l.get(a && a.zone_id); if (l) tally[l] = (tally[l] || 0) + 1; }
    layoutId = Object.entries(tally).sort((x, y) => y[1] - x[1])[0][0];
  }
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!layout) return null;
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
  if (ambiguous) layout._preview_ambiguous = true;
  return layout;
}

// Map an item's schedule rows into the evaluator's block shape.
function schedulesForItem(itemId) {
  return db.prepare(
    'SELECT active_days, start_time, end_time, start_date, end_date FROM playlist_item_schedules WHERE playlist_item_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(itemId).map(r => ({
    days: String(r.active_days || '').split(',').filter(s => s !== '').map(Number),
    start: r.start_time,
    end: r.end_time,
    start_date: r.start_date || null,
    end_date: r.end_date || null,
  }));
}

// Mark playlist as draft (called after item mutations from the playlist detail UI)
/*
 * Every item mutation lands here, so this is where the playlist's history is written. The
 * revision carries WHO made the change, which is what the approval workflow's no-self-approval
 * rule reads: an item added by Bob and submitted by Alice must still be un-approvable by Bob.
 * Without the record the check only knew the submitter.
 */
function markDraft(playlistId, req, summary) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
  if (req) require('../lib/revisions').recordCurrent(db, 'playlist', playlistId, { actor: require('../lib/releases').actorOf(req), summary: summary || 'Edited' });
}

// Push playlist update to all devices using this playlist. Accepts either an Express `req`
// (route path) or a raw Socket.IO `io` (background sweep path — #157 has no request).
function pushToDevices(playlistId, reqOrIo) {
  try {
    const io = reqOrIo && reqOrIo.app ? reqOrIo.app.get('io') : reqOrIo;
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    const ids = new Set(
/*
       * ⚠️ Resolved, not the raw column: a device that INHERITS its playlist has no copy of the id
       * on its row, so a fan-out keyed on devices.playlist_id skips exactly the devices the change
       * is for. Same shape as the trigger fan-out that selected WHERE playlist_id = ? and missed
       * every device referencing the playlist only as a trigger target.
       */
      db.prepare('SELECT device_id AS id FROM device_resolved_playlist WHERE playlist_id = ?').all(playlistId).map((d) => d.id)
    );
    /*
     * ⚠️ ALSO the devices that hold this playlist as a TRIGGER TARGET. The base-playlist query
     * alone misses them entirely: a screen can reference a playlist solely through a trigger, and
     * such a device is never in `WHERE playlist_id = ?`. Without this an operator swaps the
     * evacuation notice, publishes, sees "Published" — and every panel keeps firing the OLD items,
     * with the old asset still pinned and the new one never fetched, until it happens to reconnect.
     */
    try {
      const { devicesForTriggerTarget } = require('../lib/device-triggers');
      for (const id of devicesForTriggerTarget(db, playlistId)) ids.add(id);
    } catch (e) { console.warn(`[trigger] target fan-out failed: ${e && e.message}`); }
    /*
     * ⚠️ AND devices whose base playlist CONTAINS this one. A nested child is not any device's
     * playlist_id, so the query above cannot see them — edit a shared corporate block, publish, and
     * every screen showing a parent keeps the old items.
     *
     * This is the THIRD time this exact shape has bitten: pushToDevices originally missed
     * trigger-target devices, and the trigger routes pushed nothing at all. A fan-out that forgets
     * a case is the recurring bug here, which is why this goes in the same helper rather than
     * becoming a fourth call site somebody else has to remember.
     */
    try {
      // ⚠️ And it bit a FOURTH time, in the fan-out this comment is attached to: the join was on
      // devices.playlist_id, so every screen that INHERITS the parent playlist was skipped.
      for (const r of db.prepare(`
        SELECT DISTINCT d.id FROM devices d
          JOIN device_resolved_playlist rp ON rp.device_id = d.id
          JOIN playlist_items pi ON pi.playlist_id = rp.playlist_id
         WHERE pi.child_playlist_id = ?
      `).all(playlistId)) ids.add(r.id);
    } catch (e) { console.warn(`[playlist] ancestor fan-out failed: ${e && e.message}`); }
    for (const id of ids) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

// #73: the shared publish path - snapshot current items into published_snapshot (what
// devices actually consume) + push to devices. POST /:id/publish AND the agency
// auto-publish path both call this, so they can never drift (a "published" playlist that
// wasn't snapshotted would be live-on-no-screen).
function publishPlaylist(playlistId, reqOrIo, seen = new Set([playlistId])) {
  const snapshotItems = buildSnapshotItems(playlistId);
  const next = JSON.stringify(snapshotItems);

  /*
   * ⚠️ CHANGE-TRIGGERED, NOT PUBLISH-TRIGGERED. If the resolved snapshot is byte-identical, write
   * nothing and push nothing.
   *
   * This is the mitigation for the one hazard nesting carries: a child edit changes every
   * ancestor's flattened items, the player's structural fingerprint changes, and every screen
   * showing any ancestor restarts at item 1 — the #234 shape, estate-wide. BrightSign ships exactly
   * this defence (a CONTENT_DATA_FEED_UNCHANGED path behind "optimize feed updates (use HEAD
   * calls)"), and it is what keeps the common case — an edit that does not alter the resolved list
   * — from interrupting anything.
   *
   * It does NOT prevent a restart for a genuine change. Neither vendor that documented this shipped
   * a true mid-loop splice; doing that properly needs a player-side diff that preserves position,
   * which Carousel proved requires a player release (CSL-9211). Deferred, and named in the design
   * doc so it is not rediscovered.
   */
  const prev = db.prepare('SELECT status, published_snapshot, published_structure, playback_order, published_playback_order FROM playlists WHERE id = ?').get(playlistId);
  const order = normalizePlaybackOrder(prev && prev.playback_order) || 'sequential';

  // ⚠️ Structure is captured PRE-expansion so "discard" can restore the nesting the flat snapshot
  // cannot describe. Device-facing data stays in published_snapshot; this is never sent anywhere.
  const structureRows = db.prepare(`
    SELECT id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight
      FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC
  `).all(playlistId);
  // ⚠️ Per-item schedule blocks (dayparting/validity) must be captured too, or a discard rebuilds
  // the items WITHOUT them and silently strips the schedules from every item. `id` is used only to
  // fetch the blocks and is dropped from the stored structure.
  const structure = JSON.stringify(structureRows.map((row) => {
    const blocks = schedulesForItem(row.id);
    const { id, ...rest } = row;
    return blocks.length ? { ...rest, schedules: blocks } : rest;
  }));

  if (prev && prev.status === 'published' && prev.published_snapshot === next && (prev.published_playback_order || 'sequential') === order) {
    /*
     * The resolved list is unchanged, so no device is touched and nothing restarts — that is the
     * point of this early exit. But STRUCTURE can differ while the flat output does not: replacing
     * a child reference with the child's own items produces a byte-identical snapshot. Returning
     * here without writing it would leave a stale structure behind, and discard restores from the
     * structure — so the next undo would resurrect a reference the user had deliberately removed.
     * Write the column, push nothing.
     */
    if (prev.published_structure !== structure) {
      db.prepare('UPDATE playlists SET published_structure = ? WHERE id = ?').run(structure, playlistId);
    }
    return { changed: false, items: snapshotItems.length };
  }
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, published_structure = ?, published_playback_order = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(next, structure, order, playlistId);
  pushToDevices(playlistId, reqOrIo);
  try {
    const row = db.prepare('SELECT name, workspace_id FROM playlists WHERE id = ?').get(playlistId);
    require('../lib/plugins/hooks').emit('playlist.published', {
      id: playlistId,
      name: row && row.name,
      workspace_id: row && row.workspace_id,
    });
  } catch (_) { /* plugins off, or a handler threw inside emit's own isolation */ }

  /*
   * ⚠️ REPUBLISH PUBLISHED ANCESTORS. Flattening at publish means a parent's snapshot holds a COPY
   * of the child's items as they were at the parent's last publish — so editing and publishing a
   * child alone updates nothing that any screen actually reads.
   *
   * Caught by a test rather than by review: pushing to the parent's devices (which this already
   * did) delivers the parent's STALE snapshot, so the fan-out looked correct and the content was
   * still wrong. That is the flatten-at-publish tax, and it is the price of keeping the player
   * ignorant of nesting — worth paying, but only if it is paid here, once, in the shared path.
   *
   * Depth is capped at 1, so an ancestor has no ancestor of its own and this cannot recurse beyond
   * one hop. `seen` is a belt-and-braces stop against a row some other path wrote, not the primary
   * defence. Only PUBLISHED ancestors are touched: a draft parent must stay a draft.
   */
  for (const anc of db.prepare(`
    SELECT DISTINCT p.id FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
     WHERE pi.child_playlist_id = ? AND p.status = 'published'
  `).all(playlistId)) {
    if (seen.has(anc.id)) continue;
    seen.add(anc.id);
    publishPlaylist(anc.id, reqOrIo, seen);
  }

  return { changed: true, items: snapshotItems.length };
}

/**
 * Does this playlist hold a child reference that expands to nothing?
 *
 * ⚠️ Not a tidiness check. "Three or more 'empty' nested playlists in succession may fail to skip,
 * resulting in a black screen. Affected: Samsung Tizen, BrightSign XD (8.5.47)." We ship BrightSign.
 * The vendor's own workaround is to pad the child with "even if it's just a 1-second image", which
 * is a fix that lives in the operator's head; refusing the publish puts it in the product.
 *
 * @returns {string|null} the offending child's name, or null when clean.
 */
function emptyChildReference(playlistId) {
  const kids = db.prepare(`
    SELECT DISTINCT p.id, p.name FROM playlist_items pi
      JOIN playlists p ON p.id = pi.child_playlist_id
     WHERE pi.playlist_id = ?
  `).all(playlistId);
  for (const k of kids) {
    if (buildSnapshotItems(k.id).length === 0) return k.name;
  }
  return null;
}

// Phase 2.2k: list scoped to caller's current workspace. No platform_admin
// bypass - cross-workspace view comes from switch-workspace, matching the
// precedent established across all other migrated routes.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const playlists = db.prepare(`
    SELECT p.*, COUNT(DISTINCT pi.id) as item_count, COUNT(DISTINCT d.device_id) as display_count,
           EXISTS(SELECT 1 FROM playlist_items z WHERE z.playlist_id = p.id AND z.zone_id IS NOT NULL) as zoned,
           -- ⚠️ How many OTHER playlists include this one. Surfaced so the UI can mark it before the
           -- operator tries to delete it and hits a 409 — BrightSign's lock-icon idea, which is the
           -- one thing every vendor with shared children either has or conspicuously lacks.
           (SELECT COUNT(DISTINCT n.playlist_id) FROM playlist_items n WHERE n.child_playlist_id = p.id) as used_by_count,
           -- Whether this playlist itself nests, so the UI can show it and so a client can tell
           -- "cannot take a child" without a second round trip.
           EXISTS(SELECT 1 FROM playlist_items k WHERE k.playlist_id = p.id AND k.child_playlist_id IS NOT NULL) as has_children
    FROM playlists p
    LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
    -- Resolved, so "used by N screens" counts the screens that actually play it, inherited ones
    -- included. The raw column undercounts every group- and wall-driven display.
    LEFT JOIN device_resolved_playlist d ON d.playlist_id = p.id
    WHERE p.workspace_id = ?
    GROUP BY p.id
    ORDER BY p.name ASC
  `).all(req.workspaceId);
  res.json(playlists);
});

// Phase 2.2k: create stamps workspace_id from req.workspaceId. Viewer-deny
// gate so workspace_viewers cannot create playlists in their workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name.trim(), (description || '').trim());
  res.status(201).json(db.prepare(`
    SELECT p.*, 0 as item_count, 0 as display_count FROM playlists p WHERE p.id = ?
  `).get(id));
});

// Get single playlist with items
router.get('/:id', requirePlaylistRead, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  // Resolved, so the count matches the screens that actually play it, inherited ones included.
  const displayCount = db.prepare('SELECT COUNT(*) as count FROM device_resolved_playlist WHERE playlist_id = ?').get(req.params.id).count;
  for (const it of items) it.schedules = schedulesForItem(it.id); // #156: editor read-path needs the blocks (mirror :351)
  // #104's layout derivation, reused so the editor can SHOW where each item lands. A playlist
  // has no intrinsic layout — it is inferred from its own zone-bound items — so without this
  // the page lists a zone NAME with no sense of where that zone sits on the screen. Null (no
  // zoned items) means fullscreen, which the UI draws as a single frame.
  let layout = null;
  try { layout = derivePreviewLayout(items); } catch (e) { layout = null; }
  res.json({ ...req.playlist, items: decorateEditorItems(items), item_count: items.length, display_count: displayCount, layout });
});

// #104: device-free draft preview payload. Same shape the device player consumes
// (via assemblePayload, so it can't drift), but built from LIVE items (draft-aware,
// not published_snapshot) with a layout derived from the playlist's own zones. JWT-
// gated + workspace-scoped by requirePlaylistRead. The dashboard iframes /player
// with ?preview=1&playlist=:id and renders this with the unmodified player renderer.
const PREVIEW_ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);
router.get('/:id/preview-payload', requirePlaylistRead, (req, res) => {
  const { assemblePayload } = require('../ws/deviceSocket');
  const assignments = buildSnapshotItems(req.params.id);
  const layout = derivePreviewLayout(assignments);
  const orientation = PREVIEW_ORIENTATIONS.has(req.query.orientation) ? req.query.orientation : 'landscape';
  res.json(assemblePayload({
    assignments, layout, orientation, wall_config: null, timezone: null,
    // Without this the preview's data-source play_when gating and custom shader transitions no-op
    // (attachDataSourceBag/customShaderRegistry key off workspace_id), so the dashboard preview would
    // not match what a real device shows. Same omission that dropped it from the live device payload.
    workspace_id: req.playlist.workspace_id || null,
    playback_order: req.playlist.playback_order || 'sequential',
  }));
});

// Update playlist
router.put('/:id', requirePlaylistWrite, (req, res) => {
  const { name, description } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?');
    values.push(name.trim());
  }
  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description.trim());
  }
  if (req.body.playback_order !== undefined) {
    const order = normalizePlaybackOrder(req.body.playback_order);
    if (order === false) return res.status(400).json({ error: 'playback_order must be sequential, shuffle, or weighted' });
    updates.push('playback_order = ?');
    values.push(order);
  }
  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const summary = req.body.playback_order !== undefined ? 'Changed playback order' : 'Renamed';
    require('../lib/revisions').recordCurrent(db, 'playlist', req.params.id, { actor: require('../lib/releases').actorOf(req), summary });
    if (req.body.playback_order !== undefined) markDraft(req.params.id, req, 'Changed playback order');
  }
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id));
});

// Publish playlist — snapshot current items and push to devices
router.post('/:id/publish', requirePlaylistWrite, (req, res) => {
  // ⚠️ Refuse a nested reference that expands to nothing — a documented black screen on
  // BrightSign XD and Samsung Tizen. Named so the operator knows which playlist to fill.
  const empty = emptyChildReference(req.params.id);
  if (empty) {
    return res.status(400).json({
      error: `"${empty}" is included here but has nothing to play. Add an item to it, or remove it `
        + 'from this playlist — an empty nested playlist can leave some players on a black screen.',
    });
  }
  // Snapshot shape (no pi.id) is intentional — published_snapshot is consumed
  // by devices and stored as JSON; row IDs there would be misleading.
  // The release gate: with approval off this is the old direct publish; with approval on it
  // demands an approval for exactly this state (lib/release-policy.js).
  try {
    require('../lib/releases').releasePlaylist(db, req.params.id, req, { actor: require('../lib/releases').actorOf(req) });
  } catch (e) {
    if (e && e.name === 'ReleaseError') return res.status(e.status || 409).json({ error: e.message, code: e.code });
    throw e;
  }
  // UI response shape must include pi.id so the post-publish render can wire
  // per-row delete/duration listeners. TODO: refactor to share this SELECT
  // with GET /:id (also duplicated in /discard and POST /:id/items/reorder).
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items: decorateEditorItems(items) });
});

// Discard draft — revert playlist_items to match published_snapshot
router.post('/:id/discard', requirePlaylistWrite, (req, res) => {
  const playlist = req.playlist;
  if (!playlist.published_snapshot) {
    return res.status(400).json({ error: 'No published version to revert to' });
  }
  if (playlist.status === 'published') {
    return res.status(400).json({ error: 'Playlist has no unpublished changes' });
  }

  /*
   * ⚠️ Restore from STRUCTURE, not from the snapshot, when we have it.
   *
   * published_snapshot is flat by design — nesting is expanded out of it so no player has to
   * understand it — which makes it unable to describe a child reference. Rebuilding from it turned
   * "discard my draft changes" into "silently replace the nested playlist with a copy of whatever
   * it contained at publish time". The nesting was destroyed and the operation reported success.
   *
   * published_structure is the pre-expansion list. Rows published before it existed have none, so
   * fall back to the snapshot — those playlists cannot contain a child anyway, because the column
   * and the feature arrived together.
   */
  let publishedItems;
  try {
    publishedItems = playlist.published_structure
      ? JSON.parse(playlist.published_structure)
      : JSON.parse(playlist.published_snapshot);
  } catch (e) {
    return res.status(500).json({ error: 'Corrupt published snapshot' });
  }

  const transaction = db.transaction(() => {
    // Clear current draft items
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(req.params.id);
    // Re-insert from snapshot, skipping items whose content/widget was deleted
    // muted rides along too: #129's per-item mute was dropped by the old restore, so discarding an
    // unrelated draft edit silently un-muted every item that had been muted before publish.
    const insert = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    for (const item of publishedItems) {
      try {
        const r = insert.run(req.params.id, item.content_id || null, item.widget_id || null,
                   item.child_playlist_id || null, item.zone_id || null, item.sort_order, item.duration_sec,
                   item.muted ? 1 : 0, item.play_from || null, item.play_until || null,
                   item.enabled === 0 ? 0 : 1, item.log_play === 0 ? 0 : 1, item.fit_mode || null, item.play_when ? (typeof item.play_when === 'string' ? item.play_when : JSON.stringify(item.play_when)) : null, item.weight || 1);
        // Restore per-item schedule blocks (DELETE above cascaded them away). Both the structure and
        // the snapshot carry them in the same {days,start,end,...} shape.
        const blocks = Array.isArray(item.schedules) ? item.schedules : [];
        blocks.forEach((b, i) => {
          if (!b || !Array.isArray(b.days) || !b.days.length || !b.start || !b.end) return;
          insSched.run(uuidv4(), r.lastInsertRowid, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i);
        });
      } catch (e) {
        if (e.message.includes('FOREIGN KEY')) {
          console.warn(`Discard: skipping snapshot item (content_id=${item.content_id}, widget_id=${item.widget_id}) — referenced entity was deleted`);
          continue;
        }
        throw e;
      }
    }
    db.prepare("UPDATE playlists SET status = 'published', playback_order = COALESCE(published_playback_order, playback_order, 'sequential'), updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  });
  transaction();
  require('../lib/revisions').recordCurrent(db, 'playlist', req.params.id, { actor: require('../lib/releases').actorOf(req), summary: 'Draft discarded' });

  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items: decorateEditorItems(items) });
});

// Delete playlist
router.delete('/:id', requirePlaylistWrite, (req, res) => {
  // Which screens are about to lose their playlist — read BEFORE the delete, because
  // devices.playlist_id is ON DELETE SET NULL and the association is gone immediately after.
  // Resolved: a device inheriting this playlist is just as affected as one pinned to it.
  const affected = db.prepare('SELECT device_id AS id FROM device_resolved_playlist WHERE playlist_id = ?').all(req.params.id);

  /*
   * ⚠️ REFUSE, AND SAY WHAT IS USING IT — the reverse-dependency check.
   *
   * playlist_items.child_playlist_id is ON DELETE RESTRICT, so this DELETE throws a raw
   * SqliteError when the playlist is nested somewhere. Unhandled, that reached the client as a
   * 500 carrying "FOREIGN KEY constraint failed" AND a stack trace with server paths in it.
   *
   * The constraint is right — SET NULL would leave an item expanding to nothing (a documented
   * black screen on BrightSign XD and Samsung Tizen) and CASCADE would delete the parent's item.
   * What was missing is the answer to the only question the operator has at that moment: WHICH
   * playlist is using this one. Appspace ships the failure with no reverse view at all
   * ("deleting content from a source affects every zone and channel linked to it"); BrightSign
   * gets it right with a lock icon on anything used by an active presentation. This is that,
   * as an error you can act on.
   */
  const usedBy = db.prepare(`
    SELECT DISTINCT p.name FROM playlist_items pi
      JOIN playlists p ON p.id = pi.playlist_id
     WHERE pi.child_playlist_id = ?
     ORDER BY p.name
  `).all(req.params.id).map((r) => r.name);
  if (usedBy.length) {
    const shown = usedBy.slice(0, 3).map((n) => `"${n}"`).join(', ');
    const more = usedBy.length > 3 ? ` and ${usedBy.length - 3} more` : '';
    return res.status(409).json({
      error: `This playlist is used inside ${shown}${more}. Remove it from `
        + `${usedBy.length > 1 ? 'those playlists' : 'that playlist'} first.`,
      used_by: usedBy,
    });
  }

  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);

  // Tell them. The database detaches correctly, but nothing was emitted — so a screen kept showing
  // the deleted playlist until it happened to reconnect or was restarted. You delete a playlist to
  // take content off the wall; the wall carried on regardless. Every sibling mutation here already
  // pushes (publish, assign), and DELETE /devices/:id/playlist was given a push for exactly this
  // reason: "so the screen stops, rather than leaving the old content up".
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      for (const d of affected) {
        commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), d.id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }

  res.json({ success: true });
});

// --- Playlist Items ---

// List items
router.get('/:id/items', requirePlaylistRead, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  for (const it of items) it.schedules = schedulesForItem(it.id); // #74/#75: editor needs the blocks
  res.json(items);
});

// --- Per-item schedule blocks (#74 dayparting + #75 expiry) ---
// Same permission as editing items (requirePlaylistWrite). Block shape mirrors the
// evaluator: { days:[0-6], start:"HH:MM", end:"HH:MM"|"24:00", start_date, end_date }.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return 'each block must be an object';
    if (!Array.isArray(b.days) || b.days.length === 0 || !b.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return 'days must be a non-empty array of integers 0-6';
    if (!TIME_RE.test(b.start)) return 'start must be HH:MM (00:00-23:59)';
    if (!(TIME_RE.test(b.end) || b.end === '24:00')) return 'end must be HH:MM or 24:00';
    // A zero-length window (start == end) evaluates as NEVER active — the item silently disappears
    // rather than showing in the intended window. Reject it. (start > end is a valid OVERNIGHT window
    // and is allowed; use end=24:00 for "until midnight".)
    if (b.start === b.end) return 'start and end must differ (a zero-length window never plays; for an overnight window make end earlier than start)';
    for (const k of ['start_date', 'end_date']) if (b[k] != null && !DATE_RE.test(b[k])) return `${k} must be YYYY-MM-DD or null`;
  }
  return null;
}
function itemInPlaylist(itemId, playlistId) {
  return db.prepare('SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?').get(itemId, playlistId);
}

router.get('/:id/items/:itemId/schedules', requirePlaylistRead, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(schedulesForItem(item.id));
});

// Replace an item's schedule blocks wholesale ([] = no schedule = always on).
router.put('/:id/items/:itemId/schedules', requirePlaylistWrite, (req, res) => {
  const item = itemInPlaylist(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const blocks = req.body.blocks;
  const err = validateBlocks(blocks);
  if (err) return res.status(400).json({ error: err });
  const ins = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(item.id);
    blocks.forEach((b, i) => ins.run(uuidv4(), item.id, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i));
  })();
  markDraft(req.params.id, req, 'Changed item schedule'); // schedule changes affect playback -> draft until re-published
  res.json(schedulesForItem(item.id));
});

// Phase 2.2k: add item closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who owns content in another workspace could push it into a playlist
//      in this workspace. Now: content must be in playlist's workspace (or
//      be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to a playlist they could reach. Now: widget must be in
//      playlist's workspace (or be a platform-template).
router.post('/:id/items', requirePlaylistWrite, async (req, res) => {
  try {
    const { content_id, widget_id, child_playlist_id, sort_order, zone_id } = req.body;
    let { duration_sec } = req.body;

    if (!content_id && !widget_id && !child_playlist_id) {
      return res.status(400).json({ error: 'content_id, widget_id or child_playlist_id required' });
    }
    if ([content_id, widget_id, child_playlist_id].filter(Boolean).length > 1) {
      // The three are alternatives, not a composite. Accepting two would leave the snapshot
      // builder to pick one silently.
      return res.status(400).json({ error: 'an item is content, a widget, or a child playlist — not more than one' });
    }

    /*
     * ⚠️ DEPTH AND CYCLES ARE BOTH REFUSED HERE, at creation, by TYPE rather than by traversal.
     *
     * Refusing a child that itself holds a child caps nesting at one level, and that single rule
     * also makes A→B→A unconstructible: for the loop to close, B would have to hold a child while
     * already being one. So there is no cycle detector anywhere in this feature, and none is
     * needed. MagicINFO does it this way; a traversal-based check is a check that can be reached
     * with rows some other path already wrote.
     *
     * ⚠️ We also say so out loud. Of seventeen vendors surveyed, NOT ONE documents a depth cap or
     * shows a cycle error — the failure is left to be discovered. Naming the offending playlist
     * costs one query.
     */
    if (child_playlist_id) {
      const bad = require('../lib/playlist-nesting').nestingError(db, req.params.id, child_playlist_id, req.playlist.workspace_id);
      if (bad) return res.status(bad.status).json({ error: bad.error });
    }
    // 0 is allowed through here (it is the live "stay until skipped" dwell); resolveItemDuration
    // below coerces a 0 on any NON-live item back to a safe default, so a 0ms advance can never
    // reach finite media. A negative or non-number is still rejected.
    if (duration_sec !== undefined && duration_sec !== null && (typeof duration_sec !== 'number' || duration_sec < 0)) {
      return res.status(400).json({ error: 'duration_sec must be a non-negative integer' });
    }

    let content = null;
    if (content_id) {
      content = db.prepare(`SELECT id, workspace_id, duration_sec, mime_type, filepath, remote_url,
                                   is_active, expires_at
                              FROM content WHERE id = ?`).get(content_id);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
      }
      /*
       * ⚠️ REFUSED HERE, BECAUSE THE PUBLISHED SNAPSHOT SILENTLY DROPS IT.
       *
       * buildSnapshotItems filters out content that is deactivated or past its expiry. This route
       * only checked that the ROW existed — so adding an expired clip returned 201, publishing
       * returned 200, and the snapshot came out one item short. The operator is told it worked and
       * the wall plays something else. A short playlist that publishes successfully IS the silent
       * failure, and it is worse than an error by exactly the amount nobody notices it.
       *
       * Reachable today from the mesh write allowlist too, which is how it surfaced — but it is a
       * local bug and this is the local fix.
       */
      const expired = content.expires_at !== null && content.expires_at !== undefined
        && Number(content.expires_at) <= Math.floor(Date.now() / 1000);
      if (content.is_active === 0 || expired) {
        return res.status(400).json({
          error: expired
            ? 'That content has expired, so it would be dropped when the playlist is published. ' +
              'Extend its expiry first.'
            : 'That content is deactivated, so it would be dropped when the playlist is published. ' +
              'Reactivate it first.',
        });
      }
      // Rows ingested before the probe existed (or while ffprobe was missing) have no stored
      // duration; re-probe once so this add still gets the clip's length, and backfill the row.
      if (duration_sec === undefined || duration_sec === null) {
        content.duration_sec = await probeAndUpdateDuration(content);
      }
    }
    duration_sec = resolveItemDuration(duration_sec, content);
    if (widget_id) {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
    }

    // #public-api: optional multi-zone placement. Validate the zone belongs to a
    // template or a layout in this playlist's workspace (the agency portal needs this).
    if (zone_id) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }

    // Auto-increment sort_order if not specified
    let order = sort_order;
    if (order === undefined || order === null) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      order = (max.max_order || 0) + 1;
    }

    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, content_id || null, widget_id || null, child_playlist_id || null,
           zone_id || null, order, duration_sec);

    // Mark as draft (items changed since last publish)
    markDraft(req.params.id, req, 'Added item');

    const item = db.prepare(`
      SELECT pi.*,
             COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
             c.mime_type, c.filepath, c.thumbnail_path,
             c.duration_sec as content_duration, c.file_size, c.remote_url,
             w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
      FROM playlist_items pi
      LEFT JOIN content c ON pi.content_id = c.id
      LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
      WHERE pi.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(item);
  } catch (err) {
    console.error('Failed to add playlist item:', err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Update item
router.put('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const { sort_order, duration_sec, zone_id } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  // #public-api: multi-zone placement (zone_id null clears it). Undefined = no change.
  if (zone_id !== undefined) {
    if (zone_id !== null) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }
    updates.push('zone_id = ?'); values.push(zone_id || null);
  }
  if (duration_sec !== undefined) {
    // A live stream (video/hls) accepts dwell 0 ("stay until skipped"); finite media must stay
    // >= 1, because 0 self-loops into a black screen. The item's content mime decides which.
    const liveItem = !!(item.content_id
      && db.prepare("SELECT 1 AS live FROM content WHERE id = ? AND mime_type = 'video/hls'").get(item.content_id));
    const minDur = liveItem ? 0 : 1;
    if (typeof duration_sec !== 'number' || duration_sec < minDur) {
      return res.status(400).json({ error: liveItem ? 'duration_sec must be 0 or a positive integer' : 'duration_sec must be a positive integer' });
    }
    updates.push('duration_sec = ?');
    values.push(duration_sec);
  }
  const playFrom = Object.prototype.hasOwnProperty.call(req.body, 'play_from')
    ? normalizePlayStamp(req.body.play_from) : undefined;
  const playUntil = Object.prototype.hasOwnProperty.call(req.body, 'play_until')
    ? normalizePlayStamp(req.body.play_until) : undefined;
  if (playFrom === false) return res.status(400).json({ error: 'play_from must be YYYY-MM-DDTHH:MM or empty' });
  if (playUntil === false) return res.status(400).json({ error: 'play_until must be YYYY-MM-DDTHH:MM or empty' });
  if (playFrom !== undefined) { updates.push('play_from = ?'); values.push(playFrom); }
  if (playUntil !== undefined) { updates.push('play_until = ?'); values.push(playUntil); }
  const nextFrom = playFrom !== undefined ? playFrom : item.play_from;
  const nextUntil = playUntil !== undefined ? playUntil : item.play_until;
  if (nextFrom && nextUntil && nextFrom > nextUntil) {
    return res.status(400).json({ error: 'play_from must be at or before play_until' });
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'enabled')) {
    updates.push('enabled = ?'); values.push(req.body.enabled ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'log_play')) {
    updates.push('log_play = ?'); values.push(req.body.log_play ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'fit_mode')) {
    const fit = normalizeFitMode(req.body.fit_mode);
    if (fit === false) return res.status(400).json({ error: 'fit_mode must be contain, cover, fill, or empty' });
    updates.push('fit_mode = ?'); values.push(fit);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'play_when')) {
    const when = parsePlayWhen(req.body.play_when);
    if (when === false) return res.status(400).json({ error: 'play_when must be { slug, path, op, value }, { type:tag }, { type:meta }, or empty' });
    updates.push('play_when = ?'); values.push(when ? JSON.stringify(when) : null);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'weight')) {
    const w = normalizeWeight(req.body.weight);
    if (w === false) return res.status(400).json({ error: 'weight must be an integer from 1 to 1000' });
    updates.push('weight = ?'); values.push(w);
  }
  /*
   * ⚠️ #129's per-item mute, which this route never read.
   *
   * The sibling route on the device page (routes/assignments.js) handled it; here the field was
   * accepted, dropped, and answered 200. The dashboard's only mute toggle lives on the device page,
   * so no screen was affected today — but this endpoint is part of the public API surface, and an
   * API client muting through it got success and silence. Found while auditing playlist_items
   * writers for nesting: the same shape — a column added later that only some writers were told
   * about.
   *
   * Writing the column is not enough on its own: devices play published_snapshot, not these rows.
   * emitMuteChanged patches the snapshot (and its parents') and tells live devices.
   */
  const existing = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'item not found' });
  const { muted } = req.body;
  const mutedChanged = muted !== undefined && (existing.muted ? 1 : 0) !== (muted ? 1 : 0);
  if (muted !== undefined) { updates.push('muted = ?'); values.push(muted ? 1 : 0); }

  // #105 replace: swap the item's content/widget in place while preserving zone_id,
  // duration, sort_order and schedule rows. playlist_items is normalized (no
  // type-specific columns — mime_type/remote_url/filepath/widget_type are JOINed at
  // read time), so this is a clean FK swap across ANY content type (image<->video<->
  // youtube<->widget). Exactly one of content_id/widget_id ends up set; the other is
  // nulled. Only acts when the request explicitly carries content_id or widget_id, so
  // partial PUTs (duration/zone/sort) are unaffected.
  const replacingContent = Object.prototype.hasOwnProperty.call(req.body, 'content_id');
  const replacingWidget = Object.prototype.hasOwnProperty.call(req.body, 'widget_id');
  if (replacingContent || replacingWidget) {
    const newContentId = replacingContent ? req.body.content_id : null;
    const newWidgetId = replacingWidget ? req.body.widget_id : null;
    if (!newContentId && !newWidgetId) return res.status(400).json({ error: 'content_id or widget_id required to replace' });
    if (newContentId && newWidgetId) return res.status(400).json({ error: 'provide only one of content_id / widget_id' });
    if (newContentId) {
      const content = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(newContentId);
      if (!content) return res.status(404).json({ error: 'Content not found' });
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Content is not in this playlist\'s workspace' });
      }
    } else {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(newWidgetId);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
    }
    updates.push('content_id = ?'); values.push(newContentId || null);
    updates.push('widget_id = ?'); values.push(newWidgetId || null);
    // ⚠️ And clear the child reference. "Exactly one of content_id/widget_id ends up set" above was
    // written when those were the only two, and a swap on a NESTED row left child_playlist_id
    // standing beside the new content_id. expandChildPlaylists tests child_playlist_id first, so
    // that row would have kept expanding as a playlist while every UI query showed it as content.
    updates.push('child_playlist_id = ?'); values.push(null);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.itemId);
    db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    if (mutedChanged) emitMuteChanged(req, existing, muted ? 1 : 0);
    markDraft(req.params.id, req, 'Edited item');
  }

  const updated = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.id = ?
  `).get(req.params.itemId);
  res.json(updated);
});

// Delete item
router.delete('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.itemId);
  markDraft(req.params.id, req, 'Removed item');
  res.json({ success: true });
});

// #105 duplicate: append a copy of an item (same content/widget + zone + duration)
// plus its schedule rows (new ids). One transaction so a half-copied item can't exist.
router.post('/:id/items/:itemId/duplicate', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const copy = db.transaction(() => {
    const max = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
    const order = (max.m || 0) + 1;
    // child_playlist_id rides along: without it, duplicating a nested row produced an item with
    // content_id, widget_id AND child_playlist_id all NULL — a ghost that renders as nothing. No
    // depth check is needed here, because the copy lands in the playlist that already holds it.
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_from, play_until, muted, enabled, log_play, fit_mode, play_when, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, item.content_id, item.widget_id, item.child_playlist_id, item.zone_id, order, item.duration_sec, item.play_from || null, item.play_until || null, item.muted ? 1 : 0, item.enabled === 0 ? 0 : 1, item.log_play === 0 ? 0 : 1, item.fit_mode || null, item.play_when || null, item.weight || 1);
    const newId = result.lastInsertRowid;
    const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?').all(req.params.itemId);
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    for (const s of scheds) insSched.run(uuidv4(), newId, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
    return newId;
  });
  const newId = copy();
  markDraft(req.params.id, req, 'Duplicated item');

  const newItem = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.id = ?
  `).get(newId);
  res.status(201).json(newItem);
});

// Reorder items
/*
 * Selection actions: one transaction over N already-in-the-playlist items.
 * Copy/cut live in the dashboard; paste and the rest land here so a 40-item
 * duration change is not 40 PUTs and 40 draft records.
 */
const MAX_SELECTION = 500;
const SELECTION_ACTIONS = new Set([
  'delete', 'duplicate', 'duration', 'play_window', 'enabled', 'log_play',
  'fit_mode', 'mute', 'schedules', 'play_when', 'transition', 'paste', 'weight',
]);

function loadSelectionItems(playlistId, ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'ids must be a non-empty array', status: 400 };
  if (ids.length > MAX_SELECTION) return { error: `Too many items. The limit is ${MAX_SELECTION}.`, status: 400 };
  const uniq = [...new Set(ids.map(String))];
  const ph = uniq.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM playlist_items WHERE playlist_id = ? AND id IN (${ph})`).all(playlistId, ...uniq);
  if (rows.length !== uniq.length) return { error: 'one or more items are not in this playlist', status: 404 };
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return { rows: uniq.map((id) => byId.get(id)) };
}

router.post('/:id/items/selection', requirePlaylistWrite, (req, res) => {
  const action = req.body && req.body.action;
  if (!SELECTION_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'action must be one of ' + [...SELECTION_ACTIONS].join(', ') });
  }
  const ws = req.playlist.workspace_id;
  try {
    if (action === 'paste') {
      const incoming = req.body.items;
      if (!Array.isArray(incoming) || !incoming.length) {
        return res.status(400).json({ error: 'items must be a non-empty array' });
      }
      if (incoming.length > MAX_SELECTION) {
        return res.status(400).json({ error: `Too many items. The limit is ${MAX_SELECTION}.` });
      }
      const max = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
      let order = (max && max.m) || 0;
      const ins = db.prepare(`INSERT INTO playlist_items
        (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
      // A pasted zone_id from another playlist may not exist in this workspace's layouts. Keep it
      // only if it resolves here; otherwise drop to the default zone so the item still renders
      // rather than landing on a zone id the destination layout doesn't have. Memoized per zone.
      const zoneCache = new Map();
      const resolveZone = (zid) => {
        if (!zid) return null;
        if (zoneCache.has(zid)) return zoneCache.get(zid);
        const z = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zid, ws);
        const val = z ? zid : null;
        zoneCache.set(zid, val);
        return val;
      };
      const added = [];
      db.transaction(() => {
        for (const it of incoming) {
          const kinds = [it.content_id, it.widget_id, it.child_playlist_id].filter(Boolean);
          if (kinds.length !== 1) continue;
          if (it.content_id) {
            const c = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(it.content_id);
            if (!c || (c.workspace_id && c.workspace_id !== ws)) continue;
          }
          if (it.widget_id) {
            const w = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(it.widget_id);
            if (!w || (w.workspace_id && w.workspace_id !== ws)) continue;
          }
          if (it.child_playlist_id) {
            if (it.child_playlist_id === req.params.id) continue;
            const ch = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(it.child_playlist_id);
            if (!ch || (ch.workspace_id && ch.workspace_id !== ws)) continue;
            // The same one-level-deep guard the single-item add route enforces, which paste skipped:
            // refuse a child that itself holds a child (2 levels), or one that would make THIS
            // playlist a grandchild (the reverse direction, which builds a cycle A->B->A). Paste
            // skips a bad item rather than failing the batch. buildSnapshotItems now also refuses
            // cycles/over-depth at render, but keeping them out of the DB is the real fix.
            const grandchild = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND child_playlist_id IS NOT NULL LIMIT 1').get(it.child_playlist_id);
            if (grandchild) continue;
            const parentRef = db.prepare('SELECT 1 FROM playlist_items WHERE child_playlist_id = ? LIMIT 1').get(req.params.id);
            if (parentRef) continue;
          }
          const fit = it.fit_mode == null ? null : normalizeFitMode(it.fit_mode);
          if (fit === false) continue;
          const when = it.play_when == null ? null : parsePlayWhen(it.play_when);
          if (when === false) continue;
          const r = ins.run(req.params.id, it.content_id || null, it.widget_id || null, it.child_playlist_id || null,
            resolveZone(it.zone_id), ++order, it.duration_sec || 10, it.muted ? 1 : 0,
            it.play_from || null, it.play_until || null, it.enabled === 0 ? 0 : 1, it.log_play === 0 ? 0 : 1,
            fit, when ? JSON.stringify(when) : null, it.weight || 1);
          added.push(r.lastInsertRowid);
          const blocks = Array.isArray(it.schedules) ? it.schedules : [];
          blocks.forEach((b, i) => {
            // days must be NON-EMPTY: an empty array stores active_days='' and the evaluator treats
            // that as "no day matches", so the item silently never plays. validateBlocks rejects it
            // on the normal path; paste dropped the length check.
            if (!b || !Array.isArray(b.days) || !b.days.length || !b.start || !b.end) return;
            insSched.run(uuidv4(), r.lastInsertRowid, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i);
          });
        }
      })();
      markDraft(req.params.id, req, `Pasted ${added.length} item(s)`);
      return res.json({ added: added.length });
    }

    const sel = loadSelectionItems(req.params.id, req.body.ids);
    if (sel.error) return res.status(sel.status).json({ error: sel.error });
    const rows = sel.rows;

    if (action === 'delete') {
      const del = db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?');
      db.transaction(() => { for (const r of rows) del.run(r.id, req.params.id); })();
      markDraft(req.params.id, req, `Removed ${rows.length} item(s)`);
      return res.json({ deleted: rows.length });
    }

    if (action === 'duplicate') {
      // Wrap in a transaction like every other selection action: a mid-loop throw (an FK failure, or
      // a schedule insert failing after its item inserted) otherwise leaves a partially-duplicated
      // selection committed while markDraft still runs.
      db.transaction(() => {
        for (const r of rows) {
          // Reuse the existing single-item duplicate (copies schedules too).
          const max = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
          const order = ((max && max.m) || 0) + 1;
          const result = db.prepare(`INSERT INTO playlist_items
            (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_from, play_until, muted, enabled, log_play, fit_mode, play_when, weight)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            req.params.id, r.content_id, r.widget_id, r.child_playlist_id, r.zone_id, order, r.duration_sec,
            r.play_from, r.play_until, r.muted ? 1 : 0, r.enabled === 0 ? 0 : 1, r.log_play === 0 ? 0 : 1, r.fit_mode, r.play_when, r.weight || 1);
          const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?').all(r.id);
          const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
          for (const s of scheds) insSched.run(uuidv4(), result.lastInsertRowid, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
        }
      })();
      markDraft(req.params.id, req, `Duplicated ${rows.length} item(s)`);
      return res.json({ duplicated: rows.length });
    }

    if (action === 'duration') {
      const d = req.body.duration_sec;
      if (typeof d !== 'number' || d < 1) return res.status(400).json({ error: 'duration_sec must be a positive integer' });
      const up = db.prepare("UPDATE playlist_items SET duration_sec = ?, updated_at = strftime('%s','now') WHERE id = ?");
      db.transaction(() => { for (const r of rows) { if (!r.child_playlist_id) up.run(d, r.id); } })();
      markDraft(req.params.id, req, `Set duration on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'play_window') {
      const from = Object.prototype.hasOwnProperty.call(req.body, 'play_from') ? normalizePlayStamp(req.body.play_from) : undefined;
      const until = Object.prototype.hasOwnProperty.call(req.body, 'play_until') ? normalizePlayStamp(req.body.play_until) : undefined;
      if (from === false) return res.status(400).json({ error: 'play_from must be YYYY-MM-DDTHH:MM or empty' });
      if (until === false) return res.status(400).json({ error: 'play_until must be YYYY-MM-DDTHH:MM or empty' });
      const nextFrom = from !== undefined ? from : null;
      const nextUntil = until !== undefined ? until : null;
      if (from !== undefined && until !== undefined && nextFrom && nextUntil && nextFrom > nextUntil) {
        return res.status(400).json({ error: 'play_from must be at or before play_until' });
      }
      const sets = [];
      const valsBase = [];
      if (from !== undefined) { sets.push('play_from = ?'); valsBase.push(from); }
      if (until !== undefined) { sets.push('play_until = ?'); valsBase.push(until); }
      if (!sets.length) return res.status(400).json({ error: 'play_from or play_until required' });
      const up = db.prepare(`UPDATE playlist_items SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`);
      db.transaction(() => { for (const r of rows) up.run(...valsBase, r.id); })();
      markDraft(req.params.id, req, `Set play window on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'enabled' || action === 'log_play' || action === 'mute') {
      const col = action === 'mute' ? 'muted' : action;
      const on = action === 'mute' ? (req.body.muted ? 1 : 0)
        : action === 'enabled' ? (req.body.enabled ? 1 : 0)
        : (req.body.log_play ? 1 : 0);
      const up = db.prepare(`UPDATE playlist_items SET ${col} = ?, updated_at = strftime('%s','now') WHERE id = ?`);
      db.transaction(() => { for (const r of rows) up.run(on, r.id); })();
      markDraft(req.params.id, req, `Set ${col} on ${rows.length} item(s)`);
      // Bulk mute must live-sync to playing devices the same way the single-item PUT does, or a
      // bulk mute would only take effect on the next publish.
      if (action === 'mute') { for (const r of rows) emitMuteChanged(req, r, on); }
      return res.json({ updated: rows.length });
    }

    if (action === 'fit_mode') {
      const fit = normalizeFitMode(req.body.fit_mode);
      if (fit === false) return res.status(400).json({ error: 'fit_mode must be contain, cover, fill, or empty' });
      const up = db.prepare("UPDATE playlist_items SET fit_mode = ?, updated_at = strftime('%s','now') WHERE id = ?");
      db.transaction(() => { for (const r of rows) up.run(fit, r.id); })();
      markDraft(req.params.id, req, `Set fit on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'schedules') {
      const blocks = req.body.blocks;
      const err = validateBlocks(blocks);
      if (err) return res.status(400).json({ error: err });
      const ins = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
      const wipe = db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?');
      db.transaction(() => {
        for (const r of rows) {
          wipe.run(r.id);
          (blocks || []).forEach((b, i) => ins.run(uuidv4(), r.id, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i));
        }
      })();
      markDraft(req.params.id, req, `Set validity on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'play_when') {
      const when = parsePlayWhen(req.body.play_when);
      if (when === false) return res.status(400).json({ error: 'play_when must be a data-source, tag, or meta condition, or empty' });
      const up = db.prepare("UPDATE playlist_items SET play_when = ?, updated_at = strftime('%s','now') WHERE id = ?");
      const json = when ? JSON.stringify(when) : null;
      db.transaction(() => { for (const r of rows) up.run(json, r.id); })();
      markDraft(req.params.id, req, `Set condition on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'weight') {
      const w = normalizeWeight(req.body.weight);
      if (w === false) return res.status(400).json({ error: 'weight must be an integer from 1 to 1000' });
      const up = db.prepare("UPDATE playlist_items SET weight = ?, updated_at = strftime('%s','now') WHERE id = ?");
      db.transaction(() => { for (const r of rows) up.run(w, r.id); })();
      markDraft(req.params.id, req, `Set weight on ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    if (action === 'transition') {
      const widgetId = req.body.widget_id;
      if (!widgetId) return res.status(400).json({ error: 'widget_id required' });
      const widget = db.prepare('SELECT id, workspace_id, widget_type FROM widgets WHERE id = ?').get(widgetId);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== ws) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
      if (widget.widget_type !== 'transition') {
        return res.status(400).json({ error: 'widget must be a transition' });
      }
      const ins = db.prepare('INSERT INTO playlist_items (playlist_id, widget_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, 1)');
      const bump = db.prepare('UPDATE playlist_items SET sort_order = sort_order + 1 WHERE playlist_id = ? AND sort_order >= ?');
      db.transaction(() => {
        // Insert immediately before each selected item, highest sort_order first so earlier inserts don't shift later targets.
        const ordered = [...rows].sort((a, b) => b.sort_order - a.sort_order);
        for (const r of ordered) {
          bump.run(req.params.id, r.sort_order);
          ins.run(req.params.id, widgetId, r.zone_id || null, r.sort_order);
        }
      })();
      markDraft(req.params.id, req, `Applied transition to ${rows.length} item(s)`);
      return res.json({ updated: rows.length });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('selection action failed:', err);
    return res.status(500).json({ error: 'Failed to apply selection' });
  }
});

/*
 * Add many content items at once (#318).
 *
 * Somebody uploaded ~160 photos from a company party and then had to add them to a playlist ONE AT
 * A TIME, because POST /:id/items takes a single item. That is the same wall as the upload cap in
 * #317, one screen further along.
 *
 * Content only, deliberately. Widgets and child playlists are singular things an operator places
 * deliberately — nobody adds ninety widgets — and the nesting rules on the single-item route exist
 * to be reasoned about one at a time. Keeping this to content leaves that logic untouched.
 *
 * PARTIAL SUCCESS IS THE POINT. Refusing 160 photos because one of them expired last week is not a
 * safety property, it is an obstacle. Valid rows go in and the refused ones come back itemised, so
 * the operator can see exactly which and why rather than rediscovering it by bisection.
 */
const MAX_BULK_ITEMS = 500;

router.post('/:id/items/bulk', requirePlaylistWrite, async (req, res) => {
  try {
    const { content_ids, zone_id } = req.body;
    if (!Array.isArray(content_ids) || content_ids.length === 0) {
      return res.status(400).json({ error: 'content_ids must be a non-empty array of content IDs' });
    }
    if (content_ids.length > MAX_BULK_ITEMS) {
      return res.status(400).json({ error: `Too many items in one request. The limit is ${MAX_BULK_ITEMS}; send them in batches.` });
    }

    if (zone_id) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }

    const now = Math.floor(Date.now() / 1000);
    const ready = [];      // { content_id, duration_sec }
    const skipped = [];    // { content_id, reason }

    // Validate and probe BEFORE opening the transaction: probing is async and a better-sqlite3
    // transaction is synchronous, so an await inside one would run outside it.
    for (const cid of content_ids) {
      const content = db.prepare(`SELECT id, workspace_id, duration_sec, mime_type, filepath, remote_url,
                                         is_active, expires_at
                                    FROM content WHERE id = ?`).get(cid);
      if (!content) { skipped.push({ content_id: cid, reason: 'not found' }); continue; }
      if (content.workspace_id && content.workspace_id !== req.playlist.workspace_id) {
        skipped.push({ content_id: cid, reason: 'not in this playlist\'s workspace' });
        continue;
      }
      // Same refusal as the single-item route: the published snapshot drops these, so accepting
      // them here would report success and quietly publish a shorter playlist.
      const expired = content.expires_at !== null && content.expires_at !== undefined
        && Number(content.expires_at) <= now;
      if (content.is_active === 0 || expired) {
        skipped.push({ content_id: cid, reason: expired ? 'expired' : 'deactivated' });
        continue;
      }
      if (content.duration_sec === undefined || content.duration_sec === null) {
        content.duration_sec = await probeAndUpdateDuration(content);
      }
      ready.push({ content_id: cid, duration_sec: resolveItemDuration(undefined, content) });
    }

    let inserted = [];
    if (ready.length) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      let order = (max.max_order || 0) + 1;
      const ins = db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec)
        VALUES (?, ?, NULL, NULL, ?, ?, ?)
      `);
      const ids = [];
      // One transaction: 160 photos are one operation to the person who asked for them, so a
      // failure halfway must not leave half a party in the playlist.
      db.transaction(() => {
        for (const r of ready) {
          ids.push(ins.run(req.params.id, r.content_id, zone_id || null, order++, r.duration_sec).lastInsertRowid);
        }
      })();

      const sel = db.prepare(`
        SELECT pi.*,
               COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
               c.mime_type, c.filepath, c.thumbnail_path,
               c.duration_sec as content_duration, c.file_size, c.remote_url,
               w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
        FROM playlist_items pi
        LEFT JOIN content c ON pi.content_id = c.id
        LEFT JOIN widgets w ON pi.widget_id = w.id
        LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
        WHERE pi.id = ?
      `);
      inserted = ids.map((id) => sel.get(id));
      markDraft(req.params.id, req, `Added ${ids.length} item(s)`);
    }

    res.status(inserted.length ? 201 : 400).json({ added: inserted, skipped });
  } catch (err) {
    console.error('Failed to bulk-add playlist items:', err);
    res.status(500).json({ error: 'Failed to add items' });
  }
});

router.post('/:id/items/reorder', requirePlaylistWrite, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(() => {
    order.forEach((itemId, index) => {
      updateStmt.run(index, itemId, req.params.id);
    });
  });
  transaction();

  markDraft(req.params.id, req, 'Reordered items');

  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(req.params.id);
  res.json(items);
});

// Assign playlist to a device. Phase 2.2k: closes a pre-existing cross-tenant
// leak. Today checks device.user_id only; a caller with reach into a foreign
// workspace could assign their own playlist to a device in that workspace
// (or vice versa). Now: device must be in the playlist's workspace.
router.post('/:id/assign', requirePlaylistWrite, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(device_id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.workspace_id !== req.playlist.workspace_id) {
    return res.status(403).json({ error: 'Device is not in this playlist\'s workspace' });
  }

  // The one action that genuinely means "this screen, this playlist" — stamp it as an override so
  // the resolver honours it above the device's group and wall, and so a later group edit cannot
  // silently destroy it the way the old copy-on-assign did.
  db.prepare("UPDATE devices SET playlist_id = ?, playlist_source = 'device' WHERE id = ?").run(req.params.id, device_id);

  // Push update to device
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), device_id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }

  res.json({ success: true });
});

module.exports = router;
/*
 * ⚠️ EXPORTED SO SLIDE DECKS PUBLISH THROUGH THE REAL PATH, not a second copy of it.
 *
 * Publishing carries the change-triggered guard that keeps an unchanged resolved list from
 * restarting every screen showing this playlist (the #234 shape, estate-wide) and the pre-expansion
 * structure capture that makes "discard" able to restore nesting. A deck that wrote
 * published_snapshot itself would have neither, and would look correct until the first nested deck
 * or the first no-op republish.
 */
module.exports.publishPlaylist = publishPlaylist; // #73: shared with the agency auto-publish path
module.exports.buildSnapshotItems = buildSnapshotItems;
