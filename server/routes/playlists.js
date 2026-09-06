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
const { emitMuteChanged } = require('../lib/mute-sync');

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
function buildSnapshotItems(playlistId) {
  const items = db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url, c.unstable_connection,
           c.captions_enabled, c.captions_lang, c.subtitle_url, c.subtitle_lang,
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
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
  const dsMax = db.prepare(`
    SELECT MAX(updated_at) AS max_ds
    FROM data_sources
    WHERE workspace_id = (SELECT workspace_id FROM playlists WHERE id = ?)
  `).get(playlistId)?.max_ds || 0;

  for (const it of items) {
    if (it.widget_id && it.widget_config && it.widget_config.includes('{{ds:') && dsMax > (it.widget_rev || 0)) {
      it.widget_rev = dsMax;
    }
    const blocks = schedulesForItem(it._iid);
    if (blocks.length) it.schedules = blocks;
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
  return expandChildPlaylists(items, 0);
}

/** Max nesting depth. 1 = a playlist may contain playlists, but those may not. */
const MAX_NEST_DEPTH = 1;

function expandChildPlaylists(items, depth) {
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
    for (const child of buildSnapshotItems(it.child_playlist_id)) out.push(child);
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
function markDraft(playlistId) {
  db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
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
  const prev = db.prepare('SELECT status, published_snapshot, published_structure FROM playlists WHERE id = ?').get(playlistId);

  // ⚠️ Structure is captured PRE-expansion so "discard" can restore the nesting the flat snapshot
  // cannot describe. Device-facing data stays in published_snapshot; this is never sent anywhere.
  const structure = JSON.stringify(db.prepare(`
    SELECT content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted
      FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC
  `).all(playlistId));

  if (prev && prev.status === 'published' && prev.published_snapshot === next) {
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
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, published_structure = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(next, structure, playlistId);
  pushToDevices(playlistId, reqOrIo);

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
  res.json({ ...req.playlist, items, item_count: items.length, display_count: displayCount, layout });
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
  res.json(assemblePayload({ assignments, layout, orientation, wall_config: null, timezone: null }));
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
  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...values);
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
  publishPlaylist(req.params.id, req);
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
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
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
    const insert = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const item of publishedItems) {
      try {
        insert.run(req.params.id, item.content_id || null, item.widget_id || null,
                   item.child_playlist_id || null, item.zone_id || null, item.sort_order, item.duration_sec,
                   item.muted ? 1 : 0);
      } catch (e) {
        if (e.message.includes('FOREIGN KEY')) {
          console.warn(`Discard: skipping snapshot item (content_id=${item.content_id}, widget_id=${item.widget_id}) — referenced entity was deleted`);
          continue;
        }
        throw e;
      }
    }
    db.prepare("UPDATE playlists SET status = 'published', updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  });
  transaction();

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
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id), items });
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
  markDraft(req.params.id); // schedule changes affect playback -> draft until re-published
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
      if (child_playlist_id === req.params.id) {
        return res.status(400).json({ error: 'a playlist cannot contain itself' });
      }
      const child = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?').get(child_playlist_id);
      if (!child) return res.status(404).json({ error: 'Child playlist not found' });
      if (child.workspace_id && child.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Child playlist is not in this playlist\'s workspace' });
      }
      const grandchild = db.prepare(`
        SELECT p.name FROM playlist_items pi
          JOIN playlists p ON p.id = pi.child_playlist_id
         WHERE pi.playlist_id = ? LIMIT 1
      `).get(child_playlist_id);
      if (grandchild) {
        return res.status(400).json({
          error: `"${child.name}" already contains the playlist "${grandchild.name}", and playlists `
            + 'may only nest one level deep',
        });
      }
      // ⚠️ And the reverse direction: this playlist must not already BE a child somewhere. Without
      // it, A (already inside B) could take C, giving B→A→C — two levels, built from the far end.
      const parent = db.prepare(`
        SELECT p.name FROM playlist_items pi
          JOIN playlists p ON p.id = pi.playlist_id
         WHERE pi.child_playlist_id = ? LIMIT 1
      `).get(req.params.id);
      if (parent) {
        return res.status(400).json({
          error: `this playlist is already used inside "${parent.name}", so it cannot contain `
            + 'another playlist — playlists may only nest one level deep',
        });
      }
    }
    if (duration_sec !== undefined && duration_sec !== null && (typeof duration_sec !== 'number' || duration_sec < 1)) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
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
    markDraft(req.params.id);

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
    if (typeof duration_sec !== 'number' || duration_sec < 1) {
      return res.status(400).json({ error: 'duration_sec must be a positive integer' });
    }
    updates.push('duration_sec = ?');
    values.push(duration_sec);
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
    markDraft(req.params.id);
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
  markDraft(req.params.id);
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
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, item.content_id, item.widget_id, item.child_playlist_id, item.zone_id, order, item.duration_sec);
    const newId = result.lastInsertRowid;
    const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?').all(req.params.itemId);
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    for (const s of scheds) insSched.run(uuidv4(), newId, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
    return newId;
  });
  const newId = copy();
  markDraft(req.params.id);

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
      markDraft(req.params.id);
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

  markDraft(req.params.id);

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
module.exports.publishPlaylist = publishPlaylist;
module.exports.publishPlaylist = publishPlaylist; // #73: shared with the agency auto-publish path
