const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
// Phase 2.2k: workspace-aware access. requirePlaylistOwnership is replaced
// by read/write helpers gated on the playlist's workspace_id.
const { resourceAccess } = require('../lib/tenancy');
const { resolveItemDuration } = require('../lib/item-duration');
const { parseTags, parseMeta } = require('../lib/content-tags');
const smartPlaylist = require('../lib/smart-playlist');
const { applyRepeatEvery, normalizeRepeatEvery } = require('../lib/repeat-every');
const playToEnd = require('../lib/play-to-end');
const backgrounds = require('../lib/backgrounds');
const playlistLayout = require('../lib/playlist-layout');
const { emitMuteChanged } = require('../lib/mute-sync');
const corpGuard = require('../lib/corporate/guard');
const corpActor = require('../lib/corporate/actor');
const schemaProbe = require('../lib/corporate/schema-probe');
// Local slots and their store content (lazy: lib/corporate/fills requires the guard, which loads late).
function corpFillsLib() { return require('../lib/corporate/fills'); }

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
// The merge rules live in lib/play-stamps.js, shared with corporate slot composition.
const { laterStamp, earlierStamp } = require('../lib/play-stamps');

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
  // Where the screen is: its local weather, or an area (lib/local-conditions.js, server-evaluated).
  // 'screens': an experiment's per-location variant (lib/experiments), also server-evaluated.
  if (type === 'weather' || type === 'geo' || type === 'screens') return require('../lib/local-conditions').normalise(obj);
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
  decorateLayoutItems(items);
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

// #714: is this access context an admin OF THE PLAYLIST'S WORKSPACE? A direct workspace_admin
// membership, or an org/platform admin reaching the workspace act-as (ctx.actingAs — resolved by
// lib/tenancy.js accessContext, which only grants actingAs to org_owner/org_admin and platform
// staff). A workspace_editor/viewer is not an admin. Mirrors permissions.canAdmin, but evaluated
// against the resource's workspace rather than the request's active one.
function isPlaylistAdmin(ctx) {
  return !!ctx && (ctx.actingAs || ctx.workspaceRole === 'workspace_admin');
}

// Phase 2.2k: workspace-aware playlist access. Returns the playlist row (with
// req.playlistCtx populated) or sends 403/404. requireWrite=false for reads.
function loadPlaylistAccess(req, res, requireWrite) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) { res.status(404).json({ error: 'playlist not found' }); return null; }
  if (!playlist.workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(playlist.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  /*
   * #714 admin-only playlists: a workspace admin can lock a playlist so only an admin may edit,
   * reorder or delete it. THE one check — like the corporate guard below, it covers every write
   * route in this file (PUT /:id, publish, discard, DELETE, every item route, selection, bulk,
   * reorder, item schedules and /:id/assign), because they all pass through requirePlaylistWrite.
   * "Admin" here is the resource workspace's admin: a workspace_admin, or an org/platform admin
   * reaching it act-as (ctx.actingAs). A workspace_editor (content manager) is refused.
   */
  if (requireWrite && playlist.admin_locked && !isPlaylistAdmin(ctx)) {
    res.status(403).json({ error: 'This playlist is admin-only. Ask a workspace admin to make this change.', code: 'PLAYLIST_ADMIN_LOCKED' });
    return null;
  }
  /*
   * ⚠️ CORPORATE: the ONE call that covers every write route in this file — PUT /:id, publish,
   * discard, DELETE, every item route, selection, bulk, reorder, item schedules and /:id/assign all
   * pass through requirePlaylistWrite. A governed playlist (corporate, or a child of one) may be
   * changed only by a corporate author; never by an API token. lib/corporate/guard.js.
   */
  if (requireWrite) {
    try { corpGuard.assertPlaylistWritable(req, playlist, req.method === 'DELETE' ? 'delete' : 'items'); } catch (e) {
      if (corpGuard.send(res, e, req)) return null;
      throw e;
    }
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

// The media columns every snapshot item carries, joined from content (c) and widgets (w). Shared by
// the playlist query below and snapshotItemForRef (a slot's fallback item), so a fallback is
// denormalized exactly like any other item and the two cannot drift.
const SNAPSHOT_MEDIA_COLS = `COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url, c.unstable_connection, c.tls_self_signed, c.fisheye,
           c.captions_enabled, c.captions_lang, c.subtitle_url, c.subtitle_lang,
           c.tags AS content_tags, c.meta AS content_meta,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev`;

/*
 * Per-row decoration of a snapshot item (dayparts, play window, tags/meta, weight, slide audio).
 * #74/#75: per-item schedule blocks are attached here (the player honours them in its own local
 * time via the shared evaluator); an item with zero blocks gets no `schedules` field -> always on.
 * _iid is only used to fetch blocks and is then dropped (snapshot stays id-free). widget_rev is
 * widgets.updated_at, and a data-source change bumps that for the widgets bound to the changed slug
 * (lib/data-sources/service.js bumpDependentWidgets); no workspace-wide MAX(data_sources.updated_at)
 * here, which re-revved unrelated widgets on any rename.
 */
function decorateSnapshotItem(it) {
  const blocks = it._iid ? schedulesForItem(it._iid) : [];
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
  if (!it.repeat_every_sec) delete it.repeat_every_sec;
  // #624: sent only when set and only on YouTube, so every other snapshot stays byte-identical.
  if (it.play_to_end && playToEnd.appliesTo(it.mime_type)) it.play_to_end = 1; else delete it.play_to_end;
  // rtsps camera with a self-signed certificate: sent only when set and only on a camera item, so
  // every other snapshot stays byte-identical.
  if (Number(it.tls_self_signed) === 1 && it.mime_type === 'video/rtsp') it.tls_self_signed = 1; else delete it.tls_self_signed;
  // A fisheye camera's view settings (lib/fisheye.js): sent only when set, on a live item.
  const fisheye = it.fisheye && require('../lib/remote-url').LIVE_MIMES.includes(it.mime_type) ? require('../lib/fisheye').normalize(it.fisheye) : null;
  if (fisheye) it.fisheye = fisheye; else delete it.fisheye;
  // #660: likewise only when set, and only where there is a page of ours to draw see-through.
  if (it.transparent_bg && backgrounds.transparentApplies(it)) it.transparent_bg = 1; else delete it.transparent_bg;
  delete it._iid;
  attachSlideAudio(it);
  return it;
}

/**
 * One fully denormalized snapshot item for a bare content/widget reference — a local slot's
 * fallback (spec §3.1). The same columns and the same decoration as a playlist row, and the same
 * live is_active/expiry rule: deactivated or expired content (or a deleted row) gives null, so an
 * expired fallback means "skip the slot", never a dead item on screen.
 */
function snapshotItemForRef({ content_id = null, widget_id = null, duration_sec = null, zone_id = null } = {}) {
  if (!content_id && !widget_id) return null;
  if (content_id) {
    const c = db.prepare('SELECT id, is_active, expires_at, duration_sec, mime_type FROM content WHERE id = ?').get(content_id);
    if (!c || c.is_active === 0 || (c.expires_at !== null && c.expires_at !== undefined && Number(c.expires_at) <= Math.floor(Date.now() / 1000))) return null;
    duration_sec = resolveItemDuration(duration_sec, c);
  } else {
    if (!db.prepare('SELECT 1 FROM widgets WHERE id = ?').get(widget_id)) return null;
    duration_sec = resolveItemDuration(duration_sec, null);
  }
  const it = db.prepare(`
    SELECT NULL AS _iid, ? AS content_id, ? AS widget_id, NULL AS child_playlist_id, ? AS zone_id, 0 AS sort_order,
           ? AS duration_sec, 0 AS muted, NULL AS play_from, NULL AS play_until, 1 AS enabled, 1 AS log_play,
           NULL AS fit_mode, NULL AS play_when, 1 AS weight, NULL AS repeat_every_sec, NULL AS play_to_end, NULL AS transparent_bg,
           ${SNAPSHOT_MEDIA_COLS}
      FROM (SELECT 1) one
      LEFT JOIN content c ON c.id = ?
      LEFT JOIN widgets w ON w.id = ?
  `).get(content_id, widget_id, zone_id, duration_sec, content_id, widget_id);
  return it ? decorateSnapshotItem(it) : null;
}

/*
 * A LOCAL SLOT row of a corporate playlist, as the snapshot sees it (spec §3.1).
 *   keepSlots — a marker the composition replaces with each store's content
 *               (`published_composable`; never sent to a player);
 *   otherwise — its fallback item, or nothing. So a corporate playlist's own published_snapshot,
 *               its preview, a trigger targeting it and an HQ screen assigned it directly NEVER
 *               see a marker.
 * A retired (removed) or missing slot plays nothing.
 */
function slotSnapshotEntry(row, slot, keepSlots) {
  if (!slot || slot.retired_at) return null;
  const corpFills = require('../lib/corporate/fills');
  const fallback = (slot.fallback_content_id || slot.fallback_widget_id)
    ? snapshotItemForRef({ content_id: slot.fallback_content_id, widget_id: slot.fallback_widget_id, duration_sec: slot.fallback_duration_sec, zone_id: row.zone_id || null })
    : null;
  const marker = { __slot: slot.id, zone_id: row.zone_id || null, sort_order: row.sort_order };
  if (row.play_from) marker.play_from = row.play_from;
  if (row.play_until) marker.play_until = row.play_until;
  if (row.weight && Number(row.weight) !== 1) marker.weight = Number(row.weight);
  marker.limits = corpFills.limitsOfRow(slot);
  marker.fallback = fallback;
  if (keepSlots) return marker;
  return fallback ? require('../lib/corporate/compose').applyMarker({ ...fallback }, marker) : null;
}

// Build the snapshot item list for a playlist (denormalized for device payload)
/*
 * opts (corporate playlists, spec §3.1):
 *   keepSlots — emit local slots as markers instead of their fallbacks (published_composable)
 *   noWeave   — skip "play every N": the weave runs after each store's content is spliced in
 * Every existing caller passes neither, and for a playlist without slots the output is unchanged.
 */
function buildSnapshotItems(playlistId, _depth = 0, _ancestors = null, opts = {}) {
  let items = buildSnapshotItemsInner(playlistId, _depth, _ancestors, opts);
  /*
   * 3.0 campaigns: at the top level a list holding layout items becomes the FALLBACK every player
   * already plays (lib/campaign.js fallbackOf). Only publish asks for the markers (keepLayouts), to
   * store the structure beside it. A playlist without layout items is returned as it always was.
   */
  if (_depth === 0 && !opts.keepLayouts && require('../lib/campaign').hasMarkers(items)) {
    items = require('../lib/campaign').fallbackOf(db, items);
  }
  /*
   * 3.0 playlist layouts: at the TOP level only, items without a zone go to the playlist's main
   * zone (lib/playlist-layout.js). Here, in the one function every snapshot comes from, so the
   * editor, the Simple view, Make a sign, content requests and experiments — none of which set a
   * zone — all land in the same place. A nested child's own layout is ignored: only the playlist a
   * screen actually resolved to decides the layout. No layout (every playlist until one is picked)
   * leaves the list untouched.
   */
  if (_depth === 0 && schemaProbe.hasColumn(db, 'playlists', 'layout_id')) {
    const row = db.prepare('SELECT layout_id FROM playlists WHERE id = ?').get(playlistId);
    if (row && row.layout_id) playlistLayout.fillMainZone(items, playlistLayout.loadLayout(db, row.layout_id));
  }
  return items;
}

function buildSnapshotItemsInner(playlistId, _depth = 0, _ancestors = null, opts = {}) {
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
  // Named columns, not *: this runs for every build (children included), and * would drag the large
  // published_snapshot blob along each time. user_id is read only for a smart playlist, because the
  // embedded build's playlists table has no such column.
  const own = db.prepare('SELECT id, workspace_id, smart_rules, playback_order FROM playlists WHERE id = ?').get(playlistId);
  // A smart playlist's items come from its rules, never from playlist_items. Same output shape, so
  // nesting, publish and the players cannot tell the difference (lib/smart-playlist.js).
  if (own && own.smart_rules) {
    let userId = null;
    try { userId = (db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId) || {}).user_id || null; } catch (_) { userId = null; }
    return smartPlaylist.snapshotItems(db, { ...own, user_id: userId });
  }
  // slot_id is selected LAST and deleted from ordinary rows, so a playlist without slots produces a
  // snapshot byte-identical to one built before the column existed.
  const hasSlots = schemaProbe.hasColumn(db, 'playlist_items', 'slot_id');
  // 3.0 campaigns: layout_ref_id likewise — selected last, deleted from every ordinary row.
  const hasLayoutRef = schemaProbe.hasColumn(db, 'playlist_items', 'layout_ref_id');
  // #660 likewise; decorateSnapshotItem deletes it unless set.
  const hasTransparentBg = schemaProbe.hasColumn(db, 'playlist_items', 'transparent_bg');
  const items = db.prepare(`
    SELECT pi.id AS _iid, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.zone_id, pi.sort_order, pi.duration_sec, pi.muted,
           pi.play_from, pi.play_until, pi.enabled, pi.log_play, pi.fit_mode, pi.play_when, pi.weight, pi.repeat_every_sec, pi.play_to_end,
           ${SNAPSHOT_MEDIA_COLS}${hasSlots ? ', pi.slot_id' : ''}${hasLayoutRef ? ', pi.layout_ref_id' : ''}${hasTransparentBg ? ', pi.transparent_bg' : ''}
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
  // Local slots (corporate playlists only): their rows carry no content, so they skip the item
  // decoration and become a marker or their fallback below.
  const slotIds = hasSlots ? [...new Set(items.filter((it) => it.slot_id).map((it) => it.slot_id))] : [];
  const slots = new Map();
  if (slotIds.length) {
    for (const r of db.prepare(`SELECT * FROM corporate_slots WHERE id IN (${slotIds.map(() => '?').join(',')})`).all(...slotIds)) slots.set(r.id, r);
  }
  let campaignRows = false;
  if (hasLayoutRef) {
    for (const it of items) {
      if (it.layout_ref_id == null) delete it.layout_ref_id;
      else { it.__lid = it._iid; campaignRows = true; }   // decorate drops _iid; the zone sources need it
    }
  }
  let resolved = items;
  if (slotIds.length) {
    resolved = [];
    for (const it of items) {
      if (it.slot_id) { const e = slotSnapshotEntry(it, slots.get(it.slot_id), !!opts.keepSlots); if (e) resolved.push(e); continue; }
      delete it.slot_id;
      resolved.push(decorateSnapshotItem(it));
    }
  } else {
    for (const it of items) { if (hasSlots) delete it.slot_id; decorateSnapshotItem(it); }
  }
  // 3.0 campaigns (lib/campaign.js): each layout item becomes a marker carrying its zones' items, and
  // the rows those zones play leave the sequence. A playlist without one is untouched.
  if (campaignRows) resolved = layoutItemsToMarkers(resolved, playlistId, _depth, ancestors);

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
  const flat = expandChildPlaylists(resolved, _depth, [...ancestors, playlistId]);
  // The composable keeps its flags: the weave runs per store, after the splice (lib/corporate/compose.js).
  if (opts.noWeave) return flat;
  /*
   * ⚠️ A FILL (a store's content in head office's slot) is never woven on its own. Its items are
   * spliced into head office's loop, and a weave here would repeat the store's list several times
   * inside one corporate cycle (a 3-item fill published as 13) and make the slot limits count the
   * copies. compose.applyMarker drops the flag at the splice for the same reason.
   */
  if (_depth === 0 && !opts.keepSlots && corpFillsLib().fillsOfPlaylist(db, playlistId).length) {
    for (const it of flat) if (it) delete it.repeat_every_sec;
    return flat;
  }
  /*
   * "Play every N minutes" is woven in HERE, after nesting is flattened, so the result is still one
   * flat list and no player learns about it (lib/repeat-every.js). Sequential only: in shuffle or
   * weighted order there is no fixed spacing to keep, and the copies would just skew the odds.
   */
  if ((own && own.playback_order || 'sequential') !== 'sequential') {
    for (const it of flat) if (it) delete it.repeat_every_sec;
    if (slotIds.length) flat.forEach((it, i) => { it.sort_order = i; });
    return flat;
  }
  const woven = applyRepeatEvery(flat);
  // A slot that expanded to nothing leaves a gap; Tizen re-sorts by sort_order, so close it.
  if (slotIds.length) woven.forEach((it, i) => { it.sort_order = i; });
  return woven;
}

/*
 * 3.0 campaigns: turn this playlist's layout items into markers (lib/campaign.js, MARK).
 *
 * Each zone of a layout item plays either the playlist chosen for it (playlist_item_zone_sources,
 * built like a nested child — one level, its own layout items and children ignored) or, with no
 * choice, this playlist's own rows bound to that zone. Rows bound to a zone of any layout item here
 * are the LAYOUT's content and leave the sequence. A layout item whose layout no longer exists is
 * dropped. Every zone item carries its zone's id.
 */
function layoutItemsToMarkers(rows, playlistId, depth, ancestors) {
  const camp = require('../lib/campaign');
  const layoutRows = rows.filter((r) => r && r.layout_ref_id);
  const zonesByLayout = new Map();
  for (const r of layoutRows) {
    if (!zonesByLayout.has(r.layout_ref_id)) zonesByLayout.set(r.layout_ref_id, camp.zonesOf(db, r.layout_ref_id).map((z) => z.id));
  }
  const boundZone = new Set([].concat(...[...zonesByLayout.values()]));
  const bound = new Map();   // zone id -> decorated rows bound to it
  for (const r of rows) {
    if (!r || r.layout_ref_id || !r.zone_id || !boundZone.has(r.zone_id)) continue;
    if (!bound.has(r.zone_id)) bound.set(r.zone_id, []);
    bound.get(r.zone_id).push(r);
  }
  const sources = camp.sourcesFor(db, layoutRows.map((r) => r.__lid));
  const path = [...(ancestors || []), playlistId];
  const expandRow = (r, zid) => {
    if (r.child_playlist_id) {
      return buildSnapshotItems(r.child_playlist_id, depth + 1, path).filter((x) => !camp.isMarker(x)).map((x) => ({ ...x, zone_id: zid }));
    }
    return [{ ...JSON.parse(JSON.stringify(r)), zone_id: zid }];
  };
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    if (!r.layout_ref_id) {
      if (r.zone_id && boundZone.has(r.zone_id)) continue;   // the layout's content, not a step
      out.push(r);
      continue;
    }
    const zoneIds = zonesByLayout.get(r.layout_ref_id) || [];
    if (!zoneIds.length) continue;   // layout deleted: skipped
    const src = sources.get(r.__lid) || {};
    const zones = {};
    for (const zid of zoneIds) {
      let list;
      if (src[zid]) {
        list = buildSnapshotItems(src[zid], depth + 1, path).filter((x) => !camp.isMarker(x)).map((x) => ({ ...x, zone_id: zid }));
      } else {
        list = [].concat(...(bound.get(zid) || []).map((b) => expandRow(b, zid)));
      }
      list.forEach((x, i) => { x.sort_order = i; });
      zones[zid] = list;
    }
    const m = { [camp.MARK]: { layout_id: r.layout_ref_id, zones }, sort_order: r.sort_order, duration_sec: Number(r.duration_sec) || 10 };
    for (const k of ['play_from', 'play_until', 'schedules', 'play_when']) if (r[k]) m[k] = r[k];
    if (r.log_play === 0) m.log_play = 0;
    out.push(m);
  }
  return out;
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
  /*
   * ⚠️ Renumber: an expanded child keeps ITS OWN sort_order (0..n), which collides with the
   * parent's, and Tizen re-sorts every playlist by sort_order (the web player, Android and native
   * do per zone). Without this a nested child's items get shuffled in among the parent's on those
   * players. Only reached when a child was actually expanded, so a flat playlist is byte-identical.
   */
  out.forEach((it, i) => { it.sort_order = i; });
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

/*
 * 3.0: the layout the editor and the preview draw. A playlist that CHOSE a layout (the draft one —
 * the editor is showing the draft) is drawn in it, flagged `explicit` so the page can offer to
 * change it; one that did not keeps #104's derivation from its zoned items.
 */
function playlistPreviewLayout(playlist, items) {
  if (playlist && playlist.layout_id) {
    const l = playlistLayout.loadLayout(db, playlist.layout_id);
    if (l) {
      l.explicit = true;
      const main = playlistLayout.mainZone(l.zones);
      l.main_zone_id = main ? main.id : null;
      // The zone new items added without one are given (zoneForNewItem), while it is in this layout.
      l.default_zone_id = playlist.default_zone_id && l.zones.some((z) => z.id === playlist.default_zone_id) ? playlist.default_zone_id : null;
      return l;
    }
  }
  return derivePreviewLayout(items);
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
function pushToDevices(playlistId, reqOrIo, { skipCorporate = false } = {}) {
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
      db.prepare(`SELECT device_id AS id FROM device_resolved_playlist WHERE playlist_id = ?${skipCorporate ? " AND IFNULL(source, '') != 'corporate'" : ''}`)
        .all(playlistId).map((d) => d.id)
    );
    // ⚠️ skipCorporate: a corporate publish reaches its MANDATED screens through
    // lib/corporate/fanout.js afterPublish instead, which pushes only the screens whose composed loop
    // (head office's items + that store's slot content) actually changed. Pushing them all here would
    // restart every store's loop for an edit that changed nothing they play.
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
      // ⚠️ Except screens a head office mandate drives: they are reached ONCE, by the corporate
      // ancestor's own republish below, after its snapshot is fresh. Pushing them here first sent
      // the parent's STALE snapshot and restarted their loop for nothing (critique R13).
      for (const r of db.prepare(`
        SELECT DISTINCT d.id FROM devices d
          JOIN device_resolved_playlist rp ON rp.device_id = d.id
          JOIN playlist_items pi ON pi.playlist_id = rp.playlist_id
         WHERE pi.child_playlist_id = ? AND IFNULL(rp.source, '') != 'corporate'
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
  /*
   * ⚠️ CORPORATE: the publish permission lives HERE, not only at the route (critique H6). Approvals
   * publish, agency auto-publish, schedules and slide decks all reach this without passing
   * loadPlaylistAccess; one check covers them all. Only judged when a request actor is present —
   * system republishes (ancestors below, smart refresh, content expiry) run as system.
   */
  corpGuard.assertCanPublish(playlistId);
  /*
   * 3.0 campaigns: built ONCE with the layout markers kept, then split into the structure
   * (published_campaign, for players that declare layout.campaign) and the fallback every other
   * player plays (published_snapshot). No layout item: the structure is null and the snapshot is
   * exactly what it always was.
   */
  const camp = require('../lib/campaign');
  const rawItems = buildSnapshotItems(playlistId, 0, null, { keepLayouts: true });
  const campaignObj = camp.campaignOf(rawItems);
  const nextCampaign = campaignObj ? JSON.stringify(campaignObj) : null;
  const snapshotItems = campaignObj ? camp.fallbackOf(db, rawItems) : rawItems;
  const hasCampaignCol = schemaProbe.hasColumn(db, 'playlists', 'published_campaign');
  const next = JSON.stringify(snapshotItems);
  /*
   * ⚠️ CORPORATE (Stage B). A corporate playlist also stores its COMPOSABLE — the same list with each
   * local slot kept as a marker, unwoven — which every mandated screen's composition is built from
   * (lib/corporate/composition.js). Its published_snapshot stays the fallback-only list, for anything
   * that plays the playlist directly (an HQ screen, a trigger, the preview).
   */
  const isCorporate = schemaProbe.hasColumn(db, 'playlists', 'corporate')
    && !!(db.prepare('SELECT corporate FROM playlists WHERE id = ?').get(playlistId) || {}).corporate;
  const composable = isCorporate ? JSON.stringify(buildSnapshotItems(playlistId, 0, null, { keepSlots: true, noWeave: true })) : null;
  const corpFanout = require('../lib/corporate/fanout');
  // What the affected mandated screens compose to NOW, before this publish changes it (null when
  // nothing corporate is involved), so only screens whose loop really changes are pushed afterwards.
  const corpCtx = corpFanout.beforePublish(playlistId);
  /*
   * ⚠️ A FILL (store content in head office's slot) is judged against the slot's limits HERE, the
   * one chokepoint every publish passes — dashboard, approvals release, agency auto-publish, slide
   * decks (spec §3.1, §6.2). A person is refused with the rule; system work (content expiry) marks
   * the fill over_limit instead, so it stops playing rather than breaking the limit.
   */
  require('../lib/corporate/fills').judgePublish(db, playlistId, snapshotItems, { actorPresent: !!corpActor.current() });

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
  /*
   * ⚠️ published_composable is written on EVERY publish once the column exists: NULL for an ordinary
   * playlist. A corporate playlist that is demoted, republished as ordinary and promoted again would
   * otherwise keep the composable of its LAST CORPORATE publish, and every mandated screen would play
   * that old loop (composition.composeInputs prefers the composable over the snapshot).
   */
  const hasComposable = isCorporate || schemaProbe.hasColumn(db, 'playlists', 'published_composable');
  // #660: the playlist's background colour goes live with the publish, like playback_order.
  const hasBg = schemaProbe.hasColumn(db, 'playlists', 'published_background_color');
  const prev = db.prepare(`SELECT status, published_snapshot, published_structure, playback_order, published_playback_order, smart_rules, published_smart_rules${hasComposable ? ', published_composable' : ''}${hasBg ? ', background_color, published_background_color' : ''} FROM playlists WHERE id = ?`).get(playlistId);
  const bgSame = !hasBg || !prev || (prev.published_background_color || null) === (prev.background_color || null);
  const order = normalizePlaybackOrder(prev && prev.playback_order) || 'sequential';

  // ⚠️ Structure is captured PRE-expansion so "discard" can restore the nesting the flat snapshot
  // cannot describe. Device-facing data stays in published_snapshot; this is never sent anywhere.
  // ⚠️ slot_id too (a local slot placement), or discard brings a slot back as an all-NULL ghost item —
  // the nesting audit's exact shape. Only present when set, so every other structure is unchanged.
  const hasSlots = schemaProbe.hasColumn(db, 'playlist_items', 'slot_id');
  const structureRows = db.prepare(`
    SELECT id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec, play_to_end${hasSlots ? ', slot_id' : ''}${schemaProbe.hasColumn(db, 'playlist_items', 'layout_ref_id') ? ', layout_ref_id' : ''}${schemaProbe.hasColumn(db, 'playlist_items', 'transparent_bg') ? ', transparent_bg' : ''}
      FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC
  `).all(playlistId);
  const structSources = camp.sourcesFor(db, structureRows.filter((r) => r.layout_ref_id).map((r) => r.id));
  // ⚠️ Per-item schedule blocks (dayparting/validity) must be captured too, or a discard rebuilds
  // the items WITHOUT them and silently strips the schedules from every item. `id` is used only to
  // fetch the blocks and is dropped from the stored structure.
  const structure = JSON.stringify(structureRows.map((row) => {
    const blocks = schedulesForItem(row.id);
    const { id, slot_id, play_to_end, transparent_bg, layout_ref_id, ...rest } = row;
    const out = blocks.length ? { ...rest, schedules: blocks } : rest;
    // play_to_end (#624) only when set, like slot_id, so every existing structure stays byte-identical.
    if (play_to_end) out.play_to_end = 1;
    if (transparent_bg) out.transparent_bg = 1;   // #660, same rule
    // 3.0 campaigns: a layout item and its zone sources, only when set (same reason).
    if (layout_ref_id) { out.layout_ref_id = layout_ref_id; const s = structSources.get(id); if (s) out.zone_sources = s; }
    return slot_id ? { ...out, slot_id } : out;
  }));

  // 3.0 playlist layouts: the layout goes live WITH the snapshot whose zones it explains.
  const hasLayout = schemaProbe.hasColumn(db, 'playlists', 'published_layout_id');
  const layoutRow = hasLayout ? db.prepare('SELECT layout_id, published_layout_id FROM playlists WHERE id = ?').get(playlistId) : null;
  const nextLayout = layoutRow ? (layoutRow.layout_id || null) : null;
  const layoutSame = !layoutRow || (layoutRow.published_layout_id || null) === nextLayout;
  const campaignSame = !hasCampaignCol || ((db.prepare('SELECT published_campaign FROM playlists WHERE id = ?').get(playlistId) || {}).published_campaign || null) === nextCampaign;
  if (prev && prev.status === 'published' && prev.published_snapshot === next && (prev.published_playback_order || 'sequential') === order
      && (!hasComposable || (prev.published_composable || null) === composable) && layoutSame && campaignSame && bgSame) {
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
    // Same for a smart rule edit that happens to select the same items: discard must restore it.
    if ((prev.published_smart_rules || null) !== (prev.smart_rules || null)) {
      db.prepare('UPDATE playlists SET published_smart_rules = smart_rules WHERE id = ?').run(playlistId);
    }
    // A fill whose limit state flipped (judgePublish) changes what screens play with no new snapshot.
    corpFanout.afterPublish(corpCtx, reqOrIo);
    return { changed: false, items: snapshotItems.length };
  }
  /*
   * published_rev moves on every write of the snapshot, so a cached composition built from the old
   * one knows it is stale (spec §1.1). A hand-built test schema without the column skips it.
   */
  const hasRev = schemaProbe.hasColumn(db, 'playlists', 'published_rev');
  // The composable's pairing with this snapshot, so a snapshot some other version writes is noticed.
  const hasPair = hasComposable && schemaProbe.hasColumn(db, 'playlists', 'published_composable_of');
  const pair = composable ? require('../lib/corporate/digest').snapshotDigest(next) : null;
  db.prepare(`UPDATE playlists SET status = 'published', published_snapshot = ?, published_structure = ?, published_playback_order = ?, published_smart_rules = smart_rules${hasComposable ? ', published_composable = ?' : ''}${hasPair ? ', published_composable_of = ?' : ''}${hasRev ? ', published_rev = published_rev + 1' : ''}${hasLayout ? ', published_layout_id = layout_id' : ''}${hasBg ? ', published_background_color = background_color' : ''}${hasCampaignCol ? ', published_campaign = ?' : ''}, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(...[next, structure, order, ...(hasComposable ? [composable] : []), ...(hasPair ? [pair] : []), ...(hasCampaignCol ? [nextCampaign] : []), playlistId]);
  pushToDevices(playlistId, reqOrIo, { skipCorporate: isCorporate });
  corpFanout.afterPublish(corpCtx, reqOrIo);
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
  // ...and every published CAMPAIGN that plays this playlist in a zone (3.0, lib/campaign.js): its
  // stored structure holds a copy of these items exactly as a parent holds a child's.
  const zoneUsers = camp.campaignsUsing(db, playlistId)
    .filter((id) => (db.prepare('SELECT status FROM playlists WHERE id = ?').get(id) || {}).status === 'published')
    .map((id) => ({ id }));
  for (const anc of db.prepare(`
    SELECT DISTINCT p.id FROM playlists p
      JOIN playlist_items pi ON pi.playlist_id = p.id
     WHERE pi.child_playlist_id = ? AND p.status = 'published'
  `).all(playlistId).concat(zoneUsers)) {
    if (seen.has(anc.id)) continue;
    seen.add(anc.id);
    // As system: the CHILD's publish was the authorised act; refreshing the parent's copy of it is
    // bookkeeping that must not be re-judged against the parent (a store's child can never sit in
    // a corporate parent — nesting refuses a cross-workspace child).
    corpActor.runAsSystem(() => publishPlaylist(anc.id, reqOrIo, seen));
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

/** Map<fillPlaylistId, {slot_id, slot_name, playlist_id, playlist_name, scope_kind, scope_id, fill_state}> for a workspace. */
function fillInfoByPlaylist(workspaceId) {
  const out = new Map();
  if (!workspaceId) return out;
  try {
    for (const r of db.prepare(`SELECT f.id AS fill_id, f.fill_playlist_id, f.scope_kind, f.scope_id, f.fill_state,
                                       s.id AS slot_id, s.name AS slot_name, p.id AS playlist_id, p.name AS playlist_name
                                  FROM corporate_slot_fills f JOIN corporate_slots s ON s.id = f.slot_id
                                  JOIN playlists p ON p.id = s.playlist_id
                                 WHERE f.workspace_id = ?`).all(workspaceId)) {
      const { fill_playlist_id, ...rest } = r;
      out.set(fill_playlist_id, rest);
    }
  } catch (_) { /* no corporate tables */ }
  return out;
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
  // Screens a head office mandate has paused this playlist on (would play it, play head office's).
  const paused = require('../lib/corporate/resolve').pausedCounts(db, req.workspaceId);
  for (const p of playlists) p.paused_count = paused.get(p.id) || 0;
  // Store content for head office's local slots: the list badges it "Your slot" (spec §7.10).
  const fillOf = fillInfoByPlaylist(req.workspaceId);
  for (const p of playlists) if (fillOf.has(p.id)) p.corporate_slot = fillOf.get(p.id);
  res.json(playlists);
});

// Phase 2.2k: create stamps workspace_id from req.workspaceId. Viewer-deny
// gate so workspace_viewers cannot create playlists in their workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  let rules = null;
  if (req.body.smart_rules !== undefined && req.body.smart_rules !== null) {
    rules = smartPlaylist.normalizeRules(req.body.smart_rules);
    if (!rules) return res.status(400).json({ error: SMART_RULES_ERROR });
  }
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description, smart_rules) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name.trim(), (description || '').trim(), rules ? JSON.stringify(rules) : null);
  res.status(201).json(db.prepare(`
    SELECT p.*, 0 as item_count, 0 as display_count FROM playlists p WHERE p.id = ?
  `).get(id));
});

const SMART_RULES_ERROR = 'smart_rules must be { match: "all"|"any", rules: [{ field, op, value }...] } with 1 to 20 rules '
  + '(fields: tag, meta, type, folder, name)';

/*
 * What a rule set would select right now, for the editor's live preview. POST so a draft rule set
 * can be tried before it is saved. Scoped exactly like publish: the caller's own workspace only.
 */
router.post('/smart-preview', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  if (!ws || !resourceAccess(req, ws)) return res.status(403).json({ error: 'Access denied' });
  const rules = smartPlaylist.normalizeRules(req.body && req.body.smart_rules);
  if (!rules) return res.status(400).json({ error: SMART_RULES_ERROR });
  const rows = smartPlaylist.matchContent(db, { workspace_id: req.workspaceId, user_id: req.user.id }, rules);
  res.json({
    count: rows.length,
    limit: rules.limit,
    items: rows.slice(0, 100).map((c) => ({
      id: c.id, filename: c.filename, mime_type: c.mime_type, thumbnail_path: c.thumbnail_path,
      duration_sec: c.duration_sec, type: smartPlaylist.contentType(c),
    })),
  });
});

/*
 * 3.0 campaigns: a layout item in the editor carries its layout (name + zones) and, per zone, the
 * playlist it plays (null = the items placed in that zone), so the page can draw it without more
 * round trips.
 */
function decorateLayoutItems(items) {
  const rows = (items || []).filter((it) => it && it.layout_ref_id);
  if (!rows.length) return items;
  const camp = require('../lib/campaign');
  const src = camp.sourcesFor(db, rows.map((r) => r.id));
  const names = new Map();
  for (const it of rows) {
    const l = db.prepare('SELECT id, name, width, height FROM layouts WHERE id = ?').get(it.layout_ref_id);
    it.layout = l ? { ...l, zones: db.prepare('SELECT id, name, x_percent, y_percent, width_percent, height_percent, sort_order FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(l.id) } : null;
    it.filename = l ? l.name : null;
    const s = src.get(it.id) || {};
    it.zone_sources = s;
    it.zone_source_names = {};
    for (const pid of Object.values(s)) {
      if (!names.has(pid)) names.set(pid, (db.prepare('SELECT name FROM playlists WHERE id = ?').get(pid) || {}).name || null);
    }
    for (const [zid, pid] of Object.entries(s)) it.zone_source_names[zid] = names.get(pid);
  }
  return items;
}

/*
 * 3.0 campaigns: add a WHOLE LAYOUT as an item (lib/campaign.js). Body: { layout_ref_id,
 * duration_sec, zone_sources: { zoneId: playlistId|null } }. Refused where a layout cannot play:
 * head office playlists and slot content (their layout is head office's), a playlist that chose a
 * layout of its own (it is drawn IN a layout, it cannot also switch between them), and a playlist
 * that plays inside another campaign's zone (a zone plays a plain list).
 */
function addLayoutItem(req, res) {
  const camp = require('../lib/campaign');
  const { layout_ref_id } = req.body;
  if (typeof layout_ref_id !== 'string') return res.status(400).json({ error: 'layout_ref_id must be a layout id' });
  if ([req.body.content_id, req.body.widget_id, req.body.child_playlist_id].some(Boolean)) {
    return res.status(400).json({ error: 'a layout item shows a layout — not content, a widget or a playlist as well' });
  }
  if (req.playlist.corporate || corpFillsLib().fillsOfPlaylist(db, req.params.id).length) {
    return res.status(400).json({ error: 'Head office content plays in head office\'s layout, so it cannot switch between layouts.', code: 'CORPORATE_CAMPAIGN' });
  }
  if (req.playlist.layout_id) {
    return res.status(400).json({ error: 'This playlist plays in a layout of its own. Set its layout back to "each screen\'s own" to switch between layouts instead.', code: 'CAMPAIGN_HAS_LAYOUT' });
  }
  if (camp.campaignsUsing(db, req.params.id).length) {
    return res.status(400).json({ error: 'This playlist plays inside a layout zone of another playlist, so it cannot contain layouts itself.', code: 'CAMPAIGN_IN_ZONE' });
  }
  const why = playlistLayout.layoutRefusal(db, layout_ref_id, req.playlist.workspace_id);
  if (why) return res.status(why === 'Layout not found' ? 404 : 403).json({ error: why });
  let duration = req.body.duration_sec;
  if (duration === undefined || duration === null) duration = 30;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1 || duration > 43200) {
    return res.status(400).json({ error: 'duration_sec must be between 1 and 43200 seconds' });
  }
  let id;
  try {
    db.transaction(() => {
      const max = db.prepare('SELECT MAX(sort_order) AS m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
      id = db.prepare('INSERT INTO playlist_items (playlist_id, layout_ref_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)')
        .run(req.params.id, layout_ref_id, (max.m || 0) + 1, Math.floor(duration)).lastInsertRowid;
      camp.writeSources(db, { id, playlist_id: req.params.id, layout_ref_id }, req.body.zone_sources === undefined ? {} : req.body.zone_sources, req.playlist.workspace_id);
    })();
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  markDraft(req.params.id, req, 'Added layout');
  require('../lib/audit').auditFromReq(req, 'playlist.layout_item_added', { playlist_id: req.params.id, layout_id: layout_ref_id, item_id: Number(id) });
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(id);
  res.status(201).json(decorateLayoutItems([item])[0]);
}

/*
 * The editor's view of one playlist: GET /:id, and what publish and discard answer with.
 * ⚠️ One builder on purpose: publish/discard used to answer with the bare row + items, and the
 * editor redrew from that — no layout, no item schedules — so after Publish the Layout row said
 * "Each screen's own layout", the zone pickers vanished and the schedule chips were gone until a
 * reload. Anything that redraws the editor must get this exact shape.
 */
function editorPlaylistPayload(playlist) {
  const playlistId = playlist.id;
  // c.video_prerotated: 3.0 TV-safe video — the editor shows the content's "already rotated for
  // portrait screens" switch on a video row (it is the content's flag, so it reads the content's).
  const items = db.prepare(`
    SELECT pi.*,
           COALESCE(c.filename, w.name) as filename, cp.name as child_playlist_name,
           c.mime_type, c.filepath, c.thumbnail_path, c.video_prerotated,
           c.duration_sec as content_duration, c.file_size, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config, w.updated_at as widget_rev
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    LEFT JOIN playlists cp ON pi.child_playlist_id = cp.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
  // Resolved, so the count matches the screens that actually play it, inherited ones included.
  const displayCount = db.prepare('SELECT COUNT(*) as count FROM device_resolved_playlist WHERE playlist_id = ?').get(playlistId).count;
  for (const it of items) it.schedules = schedulesForItem(it.id); // #156: editor read-path needs the blocks (mirror :351)
  // #104's layout derivation, reused so the editor can SHOW where each item lands. A playlist
  // has no intrinsic layout — it is inferred from its own zone-bound items — so without this
  // the page lists a zone NAME with no sense of where that zone sits on the screen. Null (no
  // zoned items) means fullscreen, which the UI draws as a single frame.
  let layout = null;
  try { layout = playlistPreviewLayout(playlist, items); } catch (e) { layout = null; }
  // A smart playlist shows what its rules select right now, so the editor never has to guess.
  let smart = null;
  if (playlist.smart_rules) {
    const rules = smartPlaylist.parseRules(playlist.smart_rules);
    const rows = rules ? smartPlaylist.matchContent(db, playlist, rules) : [];
    smart = {
      rules,
      count: rows.length,
      items: rows.slice(0, 100).map((c) => ({
        id: c.id, filename: c.filename, mime_type: c.mime_type, thumbnail_path: c.thumbnail_path,
        duration_sec: c.duration_sec, type: smartPlaylist.contentType(c),
      })),
    };
  }
  const pausedCount = require('../lib/corporate/resolve').pausedCounts(db, playlist.workspace_id).get(playlistId) || 0;
  // Corporate: slot rows carry their slot (name, limits, fallback) so the editor can draw them as
  // slots; store slot content says which slot it fills.
  const slotIds = [...new Set(items.map((it) => it.slot_id).filter(Boolean))];
  if (slotIds.length) {
    const slots = new Map(db.prepare(`SELECT * FROM corporate_slots WHERE id IN (${slotIds.map(() => '?').join(',')})`).all(...slotIds).map((r) => [r.id, r]));
    for (const it of items) if (it.slot_id && slots.has(it.slot_id)) it.slot = slots.get(it.slot_id);
  }
  const corporateSlot = fillInfoByPlaylist(playlist.workspace_id).get(playlistId) || null;
  /*
   * 3.0 campaigns: which screens playing this playlist will see the whole campaign, and which the
   * simplified fallback (a player that does not declare layout.campaign, or a wall member) — so the
   * editor can say so BEFORE someone wonders why one screen never switches layout.
   */
  let campaignScreens = null;
  if (items.some((it) => it.layout_ref_id)) {
    const caps = require('../lib/player-capabilities');
    campaignScreens = db.prepare(`SELECT d.* FROM device_resolved_playlist r JOIN devices d ON d.id = r.device_id
                                   WHERE r.playlist_id = ? AND IFNULL(r.source, '') != 'corporate' ORDER BY d.name COLLATE NOCASE LIMIT 500`)
      .all(playlistId)
      .map((d) => ({ id: d.id, name: d.name, full: !d.wall_id && caps.supports(d, 'layout.campaign') }));
  }
  return { ...playlist, ...(campaignScreens ? { campaign_screens: campaignScreens } : {}), items: decorateEditorItems(items), item_count: items.length, display_count: displayCount, paused_count: pausedCount, layout, smart, ...(corporateSlot ? { corporate_slot: corporateSlot } : {}) };
}

// Get single playlist with items
router.get('/:id', requirePlaylistRead, (req, res) => {
  res.json(editorPlaylistPayload(req.playlist));
});

/*
 * 3.0: before a playlist changes layout, where would its zoned items go? Returns the zones in use
 * (with how many items each holds) and a SUGGESTED new zone for each (same name, else the zone in
 * the same place, else the main zone — lib/playlist-layout.js suggestZoneMap). Read-only: the editor
 * shows it, the person confirms or changes each row, and PUT /:id sends the confirmed zone_map.
 */
router.get('/:id/layout-zone-map', requirePlaylistRead, (req, res) => {
  const target = typeof req.query.layout_id === 'string' && req.query.layout_id ? req.query.layout_id : null;
  if (target) {
    const why = playlistLayout.layoutRefusal(db, target, req.playlist.workspace_id);
    if (why) return res.status(why === 'Layout not found' ? 404 : 403).json({ error: why });
  }
  const to = target ? playlistLayout.loadLayout(db, target) : null;
  // The zones this playlist's items sit in now, wherever they came from (its old layout, or zones a
  // screen's own layout gave them before the playlist had one).
  const used = db.prepare(`SELECT z.id, z.name, z.layout_id, z.x_percent, z.y_percent, z.width_percent, z.height_percent,
                                  l.name AS layout_name, COUNT(*) AS items
                             FROM playlist_items pi JOIN layout_zones z ON z.id = pi.zone_id
                             LEFT JOIN layouts l ON l.id = z.layout_id
                            WHERE pi.playlist_id = ?
                            GROUP BY z.id ORDER BY l.name, z.sort_order`).all(req.params.id);
  const unzoned = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND zone_id IS NULL').get(req.params.id).n;
  // Zones already in the target layout need no move.
  const moving = to ? used.filter((z) => z.layout_id !== to.id) : used;
  const suggestion = to ? playlistLayout.suggestZoneMap(moving, to.zones) : {};
  const main = to ? playlistLayout.mainZone(to.zones) : null;
  res.json({
    layout: to ? { id: to.id, name: to.name, width: to.width, height: to.height, zones: to.zones } : null,
    main_zone_id: main ? main.id : null,
    zones: moving.map((z) => ({ id: z.id, name: z.name, layout_name: z.layout_name || null, items: z.items, suggested: suggestion[z.id] || null })),
    unzoned_items: unzoned,
  });
});

// #104: device-free draft preview payload. Same shape the device player consumes
// (via assemblePayload, so it can't drift), but built from LIVE items (draft-aware,
// not published_snapshot) with a layout derived from the playlist's own zones. JWT-
// gated + workspace-scoped by requirePlaylistRead. The dashboard iframes /player
// with ?preview=1&playlist=:id and renders this with the unmodified player renderer.
const PREVIEW_ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);
router.get('/:id/preview-payload', requirePlaylistRead, (req, res) => {
  const { assemblePayload } = require('../ws/deviceSocket');
  // 3.0 campaigns: built once with the layout markers kept; the preview player (the web player, which
  // plays campaigns) gets the structure as a screen would, and `assignments` stays the fallback.
  const camp = require('../lib/campaign');
  const raw = buildSnapshotItems(req.params.id, 0, null, { keepLayouts: true });
  const campaignObj = camp.campaignOf(raw);
  const assignments = campaignObj ? camp.fallbackOf(db, raw) : raw;
  const layout = playlistPreviewLayout(req.playlist, assignments);
  const orientation = PREVIEW_ORIENTATIONS.has(req.query.orientation) ? req.query.orientation : 'landscape';
  // 3.0: the portrait toggle shows the layout's portrait version, as a portrait screen would get it.
  const lv = require('../lib/layout-variants');
  if (layout && lv.orientationVariant(orientation)) lv.applyVariant(db, layout, lv.orientationVariant(orientation));
  const out = assemblePayload({
    assignments, layout, orientation, wall_config: null, timezone: null,
    // Without this the preview's data-source play_when gating and custom shader transitions no-op
    // (attachDataSourceBag/customShaderRegistry key off workspace_id), so the dashboard preview would
    // not match what a real device shows. Same omission that dropped it from the live device payload.
    workspace_id: req.playlist.workspace_id || null,
    playback_order: req.playlist.playback_order || 'sequential',
    // #660: the draft's colour, as a screen will show it once published.
    background_color: req.playlist.background_color || null,
  });
  if (campaignObj) {
    const c = camp.payloadCampaign(db, campaignObj, { orientation }, (l) => l);
    if (c) out.campaign = c;
  }
  res.json(out);
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
  /*
   * #714: lock/unlock the playlist for admins only. Changing the designation is itself an
   * admin-only act — an editor must not be able to lock a playlist (or, on an unlocked one they can
   * still reach, unlock it). loadPlaylistAccess already refuses an editor any write to a LOCKED
   * playlist; this additionally refuses an editor who tries to set the flag on an unlocked one.
   */
  let lockChanged = false;
  if (req.body.admin_locked !== undefined) {
    if (!isPlaylistAdmin(req.playlistCtx)) {
      return res.status(403).json({ error: 'Only a workspace admin can change whether a playlist is admin-only.', code: 'PLAYLIST_ADMIN_LOCKED' });
    }
    const locked = req.body.admin_locked ? 1 : 0;
    if (locked !== (req.playlist.admin_locked ? 1 : 0)) {
      updates.push('admin_locked = ?');
      values.push(locked);
      lockChanged = true;
    }
  }
  if (req.body.playback_order !== undefined) {
    const order = normalizePlaybackOrder(req.body.playback_order);
    if (order === false) return res.status(400).json({ error: 'playback_order must be sequential, shuffle, or weighted' });
    updates.push('playback_order = ?');
    values.push(order);
  }
  // #660: '' or null clears it (the screen's own colour); anything else must be a hex colour.
  let bgChanged = false;
  if (req.body.background_color !== undefined) {
    const bg = backgrounds.normalizePlaylistBg(req.body.background_color);
    const clearing = req.body.background_color === null || req.body.background_color === '';
    if (bg === null && !clearing) return res.status(400).json({ error: 'background_color must be a hex colour like #1a2b3c, or empty for the screen\'s colour' });
    if (bg !== (req.playlist.background_color || null)) {
      updates.push('background_color = ?');
      values.push(bg);
      bgChanged = true;
    }
  }
  let rulesChanged = false;
  if (req.body.smart_rules !== undefined) {
    // A generated playlist (a slide deck's, a schedule's throwaway) is rebuilt by its owner; rules
    // there would silently override what that owner publishes.
    if (req.body.smart_rules !== null && req.playlist.corporate) {
      return corpGuard.send(res, corpGuard.err('CORPORATE_SMART'), req);
    }
    // Store slot content is a plain list of items (decision D4): rules would pick items the slot's
    // limits were never checked against.
    if (req.body.smart_rules !== null && corpFillsLib().fillsOfPlaylist(db, req.params.id).length) {
      return corpGuard.send(res, corpGuard.err('FILL_FLAT'), req);
    }
    if (req.body.smart_rules !== null && req.playlist.is_auto_generated) {
      return res.status(400).json({ error: 'Auto-generated playlists cannot become smart playlists' });
    }
    if (req.body.smart_rules !== null) {
      let deck = null;
      try { deck = db.prepare('SELECT 1 FROM slide_decks WHERE playlist_id = ? LIMIT 1').get(req.params.id); } catch (_) { deck = null; }
      if (deck) return res.status(400).json({ error: 'A slide deck\'s playlist cannot become a smart playlist' });
      // A smart playlist has no items of its own, so one that holds a nested playlist would drop it.
      const kid = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND child_playlist_id IS NOT NULL LIMIT 1').get(req.params.id);
      if (kid) return res.status(400).json({ error: 'Remove the nested playlists first: a smart playlist cannot contain other playlists' });
    }
    // null turns a smart playlist back into an ordinary one (its hand-added items, if any, return).
    const rules = smartPlaylist.normalizeRules(req.body.smart_rules);
    if (rules === false) return res.status(400).json({ error: SMART_RULES_ERROR });
    updates.push('smart_rules = ?');
    values.push(rules ? JSON.stringify(rules) : null);
    rulesChanged = true;
  }
  /*
   * 3.0: the playlist's own layout (docs/layouts-and-campaigns.md). null = none (screens use their
   * own, as before). `zone_map` {oldZoneId: newZoneId|null} moves the items in the same transaction
   * — the editor offers a suggestion (GET /:id/layout-zone-map) and sends what the person confirmed.
   * A DRAFT change like playback order: screens get the layout on Publish, with the moved items.
   */
  let layoutChanged = false;
  let zoneMoves = null;
  if (req.body.layout_id !== undefined && schemaProbe.hasColumn(db, 'playlists', 'layout_id')) {
    const next = req.body.layout_id || null;
    if (next !== null && typeof next !== 'string') return res.status(400).json({ error: 'layout_id must be a layout id or null' });
    if (next && req.playlist.corporate) {
      return res.status(400).json({ error: 'A head office playlist takes its layout from the head office assignment, not from the playlist.', code: 'CORPORATE_LAYOUT' });
    }
    if (next && schemaProbe.hasColumn(db, 'playlist_items', 'layout_ref_id')
        && db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND layout_ref_id IS NOT NULL LIMIT 1').get(req.params.id)) {
      return res.status(400).json({ error: 'This playlist switches between layouts (it has layout items), so it cannot also play in one layout.', code: 'CAMPAIGN_HAS_LAYOUT' });
    }
    if (next && corpFillsLib().fillsOfPlaylist(db, req.params.id).length) {
      return res.status(400).json({ error: 'Content for a head office slot plays inside head office\'s layout, so it cannot have a layout of its own.', code: 'FILL_LAYOUT' });
    }
    if (next) {
      const why = playlistLayout.layoutRefusal(db, next, req.playlist.workspace_id);
      if (why) return res.status(why === 'Layout not found' ? 400 : 403).json({ error: why });
    }
    if (next !== (req.playlist.layout_id || null)) {
      updates.push('layout_id = ?');
      values.push(next);
      layoutChanged = true;
    }
    const map = req.body.zone_map;
    if (map !== undefined && map !== null) {
      if (typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 200) {
        return res.status(400).json({ error: 'zone_map must be an object of old zone id -> new zone id (or null)' });
      }
      // Every target must be a zone OF THE NEW LAYOUT: a map cannot be used to point items at
      // another tenant's zone, or at a zone the screen will not draw.
      const valid = next ? new Set(db.prepare('SELECT id FROM layout_zones WHERE layout_id = ?').all(next).map((r) => r.id)) : new Set();
      zoneMoves = [];
      for (const [from, to] of Object.entries(map)) {
        if (to !== null && (typeof to !== 'string' || !valid.has(to))) {
          return res.status(400).json({ error: 'zone_map points at a zone that is not in the new layout' });
        }
        zoneMoves.push([from, to]);
      }
    }
  }

  /*
   * The playlist's default zone: the zone NEW items added without one are given
   * (lib/playlist-layout.js zoneForNewItem). A setting, not a draft: it changes no item already in the
   * playlist, so there is nothing to publish. It must be a zone of the layout the playlist has AFTER
   * this request. A layout change carries it through the confirmed zone_map and drops it when the new
   * layout has no such zone; clearing the layout clears it.
   */
  let defaultZoneChanged = false;
  if (schemaProbe.hasColumn(db, 'playlists', 'default_zone_id')) {
    const layoutAfter = layoutChanged ? (req.body.layout_id || null) : (req.playlist.layout_id || null);
    const current = req.playlist.default_zone_id || null;
    const asked = req.body.default_zone_id !== undefined;
    let wanted = current;
    if (asked) {
      wanted = req.body.default_zone_id || null;
      if (wanted !== null && typeof wanted !== 'string') return res.status(400).json({ error: 'default_zone_id must be a zone id or null' });
      if (wanted && !layoutAfter) return res.status(400).json({ error: 'Choose a layout for this playlist before choosing its default zone.', code: 'DEFAULT_ZONE_NO_LAYOUT' });
    } else if (layoutChanged && current) {
      const moved = (zoneMoves || []).find(([from]) => from === current);
      if (moved) wanted = moved[1];
    }
    if (!layoutAfter) wanted = null;
    if (wanted && !db.prepare('SELECT 1 FROM layout_zones WHERE id = ? AND layout_id = ?').get(wanted, layoutAfter)) {
      if (asked) return res.status(400).json({ error: 'default_zone_id is not a zone of this playlist\'s layout' });
      wanted = null;
    }
    if (wanted !== current) {
      updates.push('default_zone_id = ?');
      values.push(wanted);
      defaultZoneChanged = true;
    }
  }

  const moving = !!(zoneMoves && zoneMoves.length);
  if (updates.length > 0 || moving) {
    if (updates.length) {
      updates.push("updated_at = strftime('%s','now')");
      values.push(req.params.id);
    }
    // One transaction: a layout change and the item moves that go with it land together or not at all.
    db.transaction(() => {
      if (updates.length) db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const move = db.prepare('UPDATE playlist_items SET zone_id = ? WHERE playlist_id = ? AND zone_id = ?');
      for (const [from, to] of zoneMoves || []) move.run(to, req.params.id, from);
    })();
    const summary = rulesChanged ? 'Changed smart rules'
      : req.body.playback_order !== undefined ? 'Changed playback order'
        : (layoutChanged || moving) ? 'Changed layout'
          : defaultZoneChanged ? 'Changed default zone'
            : bgChanged ? 'Changed background colour'
              : lockChanged ? (req.body.admin_locked ? 'Locked to admins' : 'Unlocked for editors') : 'Renamed';
    require('../lib/revisions').recordCurrent(db, 'playlist', req.params.id, { actor: require('../lib/releases').actorOf(req), summary });
    // #714: a security-relevant setting change, so it goes to the audit log (not the draft/publish flow).
    if (lockChanged) require('../lib/audit').auditFromReq(req, 'playlist.admin_lock_changed', { playlist_id: req.params.id, admin_locked: req.body.admin_locked ? 1 : 0 });
    if (req.body.playback_order !== undefined) markDraft(req.params.id, req, 'Changed playback order');
    if (rulesChanged) markDraft(req.params.id, req, 'Changed smart rules');
    if (bgChanged) markDraft(req.params.id, req, 'Changed background colour');
    if (layoutChanged || moving) {
      markDraft(req.params.id, req, 'Changed layout');
      require('../lib/audit').auditFromReq(req, 'playlist.layout_changed', {
        playlist_id: req.params.id, layout_id: req.body.layout_id || null, moved_zones: moving ? zoneMoves.length : 0,
      });
    }
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
  // 3.0 accessibility: the workspace's opt-in "do not publish with accessibility errors" policy
  // (lib/a11y publishGate). Off by default, in which case this is one indexed lookup and nothing else.
  {
    const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(req.params.id);
    const gate = pl && require('../lib/a11y').publishGate(db, pl.workspace_id, 'playlist', req.params.id);
    if (gate) return res.status(gate.status).json({ error: gate.error, code: gate.code, errors: gate.check.errors });
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
  // The editor redraws from this, so it is GET /:id's shape (editorPlaylistPayload), never the bare row.
  const published = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  const payload = editorPlaylistPayload(published);
  // Zapier-style subscribers (lib/automation/events.js): a playlist went out to screens.
  require('../lib/automation/events').emit(db, published.workspace_id, 'playlist_published', { playlist_id: published.id, playlist_name: published.name, items: payload.items.length });
  res.json(payload);
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
    // ⚠️ slot_id rides along (a local slot placement, published_structure carries it): without it a
    // discarded corporate draft brought every slot back as an all-NULL ghost item (spec §6.1-1).
    const hasSlots = schemaProbe.hasColumn(db, 'playlist_items', 'slot_id');
    const hasTransparentBg = schemaProbe.hasColumn(db, 'playlist_items', 'transparent_bg');
    const insert = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec, play_to_end${hasSlots ? ', slot_id' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${hasSlots ? ', ?' : ''})`);
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    const restoredSlots = [];
    for (const item of publishedItems) {
      try {
        const r = insert.run(req.params.id, item.content_id || null, item.widget_id || null,
                   item.child_playlist_id || null, item.zone_id || null, item.sort_order, item.duration_sec,
                   item.muted ? 1 : 0, item.play_from || null, item.play_until || null,
                   item.enabled === 0 ? 0 : 1, item.log_play === 0 ? 0 : 1, item.fit_mode || null, item.play_when ? (typeof item.play_when === 'string' ? item.play_when : JSON.stringify(item.play_when)) : null, item.weight || 1,
                   item.repeat_every_sec || null, playToEnd.normalizePlayToEnd(item.play_to_end), ...(hasSlots ? [item.slot_id || null] : []));
        if (item.slot_id) restoredSlots.push(item.slot_id);
        // #660: a see-through item comes back see-through.
        if (item.transparent_bg && hasTransparentBg) db.prepare('UPDATE playlist_items SET transparent_bg = 1 WHERE id = ?').run(r.lastInsertRowid);
        // 3.0 campaigns: a layout item comes back with its zone sources. A layout or source playlist
        // deleted since is simply not restored (the FK/the check below), like deleted content.
        if (item.layout_ref_id && db.prepare('SELECT 1 FROM layouts WHERE id = ?').get(item.layout_ref_id)) {
          db.prepare('UPDATE playlist_items SET layout_ref_id = ? WHERE id = ?').run(item.layout_ref_id, r.lastInsertRowid);
          for (const [zid, pid] of Object.entries(item.zone_sources || {})) {
            try { db.prepare('INSERT INTO playlist_item_zone_sources (item_id, zone_id, playlist_id) VALUES (?, ?, ?)').run(r.lastInsertRowid, zid, pid); } catch (_) { /* zone or playlist gone */ }
          }
        } else if (item.layout_ref_id) {
          db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.lastInsertRowid);
        }
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
    // A slot removed in the draft was retired (kept, with its stores' content); bringing its placement
    // back un-retires it (spec §1.3).
    for (const sid of restoredSlots) db.prepare('UPDATE corporate_slots SET retired_at = NULL WHERE id = ?').run(sid);
    // A smart playlist's rules are part of what was published; discarding a rule edit restores them.
    db.prepare("UPDATE playlists SET status = 'published', playback_order = COALESCE(published_playback_order, playback_order, 'sequential'), smart_rules = published_smart_rules, updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
    // #660: and the background colour screens have.
    if (schemaProbe.hasColumn(db, 'playlists', 'published_background_color')) {
      db.prepare('UPDATE playlists SET background_color = published_background_color WHERE id = ?').run(req.params.id);
    }
    // A layout change is part of the draft too: discarding it puts back the layout screens have.
    if (schemaProbe.hasColumn(db, 'playlists', 'published_layout_id')) {
      db.prepare('UPDATE playlists SET layout_id = published_layout_id WHERE id = ?').run(req.params.id);
    }
  });
  transaction();
  require('../lib/revisions').recordCurrent(db, 'playlist', req.params.id, { actor: require('../lib/releases').actorOf(req), summary: 'Draft discarded' });

  // Same shape as GET /:id: the editor redraws from it (see editorPlaylistPayload).
  res.json(editorPlaylistPayload(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)));
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
  // 3.0 campaigns: a playlist playing in a layout zone of another is "used inside" it too.
  for (const pid of require('../lib/campaign').campaignsUsing(db, req.params.id)) {
    const n = (db.prepare('SELECT name FROM playlists WHERE id = ?').get(pid) || {}).name;
    if (n && !usedBy.includes(n)) usedBy.push(n);
  }
  /*
   * ⚠️ And refuse a corporate playlist that head office has assigned somewhere: the mandate's
   * foreign key is NO ACTION precisely so this cannot delete the content out from under the
   * screens. Answered before the DELETE, naming where it plays.
   */
  if (req.playlist.corporate) {
    const mandates = db.prepare('SELECT id, target_kind, target_id FROM corporate_mandates WHERE playlist_id = ?').all(req.params.id);
    if (mandates.length) {
      const screens = db.prepare("SELECT COUNT(*) AS n FROM device_resolved_playlist WHERE playlist_id = ? AND source = 'corporate'").get(req.params.id).n;
      return corpGuard.send(res, corpGuard.err('CORPORATE_MANDATED', { n: mandates.length, screens },
        { mandates: mandates.map((m) => ({ ...m, label: corpGuard.targetLabel(db, m) })) }), req);
    }
  }
  if (usedBy.length) {
    const shown = usedBy.slice(0, 3).map((n) => `"${n}"`).join(', ');
    const more = usedBy.length > 3 ? ` and ${usedBy.length - 3} more` : '';
    return res.status(409).json({
      error: `This playlist is used inside ${shown}${more}. Remove it from `
        + `${usedBy.length > 1 ? 'those playlists' : 'that playlist'} first.`,
      used_by: usedBy,
    });
  }

  // CORPORATE: a store's slot content plays on screens that never resolve to it (they resolve to
  // head office's playlist), so `affected` above misses them. Collected BEFORE the delete — the FK
  // cascade removes the fill row with it, and those screens fall back to the next level or the slot's
  // fallback (spec §3.4).
  const fillScreens = corpFillsLib().devicesPlayingFill(db, req.params.id);

  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  if (fillScreens.length) require('../lib/corporate/fanout').pushDevices(req, fillScreens);

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
/** Is this row a local slot placement (corporate playlists only)? */
function isSlotRow(itemId) {
  if (!schemaProbe.hasColumn(db, 'playlist_items', 'slot_id')) return false;
  return !!(db.prepare('SELECT slot_id FROM playlist_items WHERE id = ?').get(itemId) || {}).slot_id;
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
  // A slot's times are its store items' times; a block on the slot row would be dropped silently at
  // composition (the R9 shape nested rows already have), so it is refused.
  if (isSlotRow(item.id)) return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_SCHEDULE'), req);
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
    if (req.playlist.smart_rules) {
      return res.status(400).json({ error: 'This is a smart playlist: its items come from its rules. Change the rules, or tag the content so it matches.' });
    }
    // 3.0 campaigns: a whole layout as an item has its own path.
    if (req.body.layout_ref_id !== undefined && req.body.layout_ref_id !== null) return addLayoutItem(req, res);
    const { content_id, widget_id, child_playlist_id, sort_order, zone_id } = req.body;
    let { duration_sec } = req.body;
    // A slot placement is made by the corporate slot routes (Stage B), never as an ordinary item.
    if (req.body.slot_id !== undefined && req.body.slot_id !== null) {
      return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_FIELD'), req);
    }

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
      if (bad) return res.status(bad.status).json({ error: bad.error, ...(bad.code ? { code: bad.code } : {}) });
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
    // #624: a YouTube item plays to the end unless the request says otherwise.
    const playToEndValue = playToEnd.resolvePlayToEnd(req.body.play_to_end, content && content.mime_type);
    if (widget_id) {
      const widget = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
      if (!widget) return res.status(404).json({ error: 'Widget not found' });
      if (widget.workspace_id && widget.workspace_id !== req.playlist.workspace_id) {
        return res.status(403).json({ error: 'Widget is not in this playlist\'s workspace' });
      }
    }

    // #public-api: optional multi-zone placement. Validate the zone belongs to a
    // template or a layout in this playlist's workspace (the agency portal needs this).
    // Given none, a new item takes the playlist's default zone (lib/playlist-layout.js zoneForNewItem).
    if (zone_id) {
      const zone = db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)').get(zone_id, req.playlist.workspace_id);
      if (!zone) return res.status(400).json({ error: 'zone_id not found in this workspace' });
    }

    // CORPORATE: store content for head office's slot is flat, bounded and within the slot's limits.
    // Early, for a good message; publishPlaylist holds the authoritative check.
    corpFillsLib().assertCanAdd(db, req.params.id, [{ content_id: content_id || null, widget_id: widget_id || null, child_playlist_id: child_playlist_id || null, duration_sec }]);

    // Auto-increment sort_order if not specified
    let order = sort_order;
    if (order === undefined || order === null) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      order = (max.max_order || 0) + 1;
    }

    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_to_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, content_id || null, widget_id || null, child_playlist_id || null,
           playlistLayout.zoneForNewItem(db, req.params.id, zone_id || null), order, duration_sec, playToEndValue);

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
    // A backstop refusal is an answer, not a server fault.
    if (corpGuard.send(res, err, req)) return;
    console.error('Failed to add playlist item:', err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Update item
router.put('/:id/items/:itemId', requirePlaylistWrite, (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
  /*
   * 3.0 campaigns: a layout item's zones (zone_sources) are set here; swapping content into a layout
   * row would leave a layout_ref_id beside a content_id, so it is refused like a slot swap.
   */
  if (item.layout_ref_id) {
    if (has('content_id') || has('widget_id') || has('child_playlist_id')) {
      return res.status(400).json({ error: 'a layout item shows a layout; remove it and add the content instead' });
    }
    if (has('zone_sources')) {
      try { require('../lib/campaign').writeSources(db, item, req.body.zone_sources, req.playlist.workspace_id); } catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
      markDraft(req.params.id, req, 'Changed layout zones');
      if (Object.keys(req.body).every((k) => k === 'zone_sources')) {
        return res.json(decorateLayoutItems([db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(item.id)])[0]);
      }
    }
  } else if (has('zone_sources')) {
    return res.status(400).json({ error: 'zone_sources applies to layout items only' });
  }
  /*
   * ⚠️ A LOCAL SLOT ROW (spec §4.7). Swapping content into it would leave slot_id standing beside a
   * content_id — the nesting audit's ghost-row shape — so it is refused; a slot has no interval of
   * its own; and mute belongs to the items stores put in it, so it is ignored here.
   */
  if (item.slot_id) {
    if (has('content_id') || has('widget_id')) return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_SWAP'), req);
    if (has('repeat_every_sec') && normalizeRepeatEvery(req.body.repeat_every_sec)) return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_REPEAT'), req);
    delete req.body.muted;
  }
  // A swap inside store slot content: the new item must be a kind the slot allows (limits are
  // judged at publish, where an over-limit draft is refused with the totals).
  if (has('content_id') || has('widget_id')) {
    try {
      const fl = corpFillsLib();
      if (fl.fillsOfPlaylist(db, req.params.id).length) {
        const shape = fl.itemShape(db, { content_id: req.body.content_id || null, widget_id: req.body.widget_id || null, duration_sec: item.duration_sec });
        const others = fl.draftItems(db, req.params.id).filter((r) => String(r.id) !== String(item.id));
        fl.assertFillItems(db, req.params.id, [...others, shape]);
      }
    } catch (e) {
      // Over the count/seconds limit already (head office lowered it) must not block a swap that
      // fixes the TYPE; only a FLAT/LIVE/TYPE refusal of the new item stops it.
      if (!(e && e.code === 'FILL_LIMIT')) { if (corpGuard.send(res, e, req)) return; throw e; }
    }
  }

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
    // A live stream (HLS, an RTSP camera, HDMI in) accepts dwell 0 ("stay until skipped"); finite
    // media must stay >= 1, because 0 self-loops into a black screen. The item's content mime
    // decides which. This used to check video/hls only, so a camera could be ADDED with 0 but never
    // set back to it.
    const liveMime = item.content_id && db.prepare('SELECT mime_type FROM content WHERE id = ?').get(item.content_id);
    const liveItem = !!(liveMime && require('../lib/remote-url').LIVE_MIMES.includes(liveMime.mime_type));
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
    if (when === false) return res.status(400).json({ error: 'play_when must be { slug, path, op, value }, { type:tag }, { type:meta }, { type:weather }, { type:geo }, or empty' });
    updates.push('play_when = ?'); values.push(when ? JSON.stringify(when) : null);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'weight')) {
    const w = normalizeWeight(req.body.weight);
    if (w === false) return res.status(400).json({ error: 'weight must be an integer from 1 to 1000' });
    updates.push('weight = ?'); values.push(w);
  }
  // "Play every N seconds" (lib/repeat-every.js). A nested playlist is a block of items, not one
  // item, so it cannot be woven in on its own.
  if (Object.prototype.hasOwnProperty.call(req.body, 'repeat_every_sec')) {
    const every = normalizeRepeatEvery(req.body.repeat_every_sec);
    if (every === false) return res.status(400).json({ error: 'repeat_every_sec must be a number of seconds from 10 to 86400, or empty' });
    if (every && item.child_playlist_id) return res.status(400).json({ error: 'A nested playlist cannot repeat on its own interval; set it on the items inside it' });
    updates.push('repeat_every_sec = ?'); values.push(every);
  }
  // #624 "Play to end" (lib/play-to-end.js): YouTube only. Turning it off is always allowed; a row
  // later swapped to other content keeps the column, but the snapshot drops it for non-YouTube.
  if (has('play_to_end')) {
    const on = playToEnd.normalizePlayToEnd(req.body.play_to_end);
    if (on) {
      const c = item.content_id ? db.prepare('SELECT mime_type FROM content WHERE id = ?').get(item.content_id) : null;
      if (!c || !playToEnd.appliesTo(c.mime_type)) return res.status(400).json({ error: 'play_to_end applies to YouTube items only' });
    }
    updates.push('play_to_end = ?'); values.push(on);
  }
  // #660 "Transparent background": widgets and HTML bundles only, the items with a page of ours.
  if (has('transparent_bg')) {
    const on = backgrounds.normalizeTransparentBg(req.body.transparent_bg);
    if (on) {
      const c = item.content_id ? db.prepare('SELECT mime_type FROM content WHERE id = ?').get(item.content_id) : null;
      if (!backgrounds.transparentApplies({ widget_id: item.widget_id, mime_type: c && c.mime_type })) {
        return res.status(400).json({ error: 'transparent_bg applies to widgets and HTML bundles only' });
      }
    }
    updates.push('transparent_bg = ?'); values.push(on);
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
  // "Remove slot" (DELETE /api/corporate/slots/:id) retires the slot so discard/restore can bring it
  // back with its stores' content; a bare row delete would orphan it instead.
  if (item.slot_id) return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_REMOVE'), req);

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
  // A slot is placed once (unique index): copying the row would 500, dropping slot_id a ghost.
  if (item.slot_id) return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_DUPLICATE'), req);
  try { corpFillsLib().assertCanAdd(db, req.params.id, [item]); } catch (e) { if (corpGuard.send(res, e, req)) return; throw e; }

  const copy = db.transaction(() => {
    const max = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(req.params.id);
    const order = (max.m || 0) + 1;
    // child_playlist_id rides along: without it, duplicating a nested row produced an item with
    // content_id, widget_id AND child_playlist_id all NULL — a ghost that renders as nothing. No
    // depth check is needed here, because the copy lands in the playlist that already holds it.
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_from, play_until, muted, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec, play_to_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, item.content_id, item.widget_id, item.child_playlist_id, item.zone_id, order, item.duration_sec, item.play_from || null, item.play_until || null, item.muted ? 1 : 0, item.enabled === 0 ? 0 : 1, item.log_play === 0 ? 0 : 1, item.fit_mode || null, item.play_when || null, item.weight || 1, item.repeat_every_sec || null, playToEnd.normalizePlayToEnd(item.play_to_end));
    const newId = result.lastInsertRowid;
    if (item.transparent_bg) db.prepare('UPDATE playlist_items SET transparent_bg = 1 WHERE id = ?').run(newId);   // #660
    const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?').all(req.params.itemId);
    const insSched = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
    for (const s of scheds) insSched.run(uuidv4(), newId, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
    // 3.0 campaigns: a layout item is copied with its layout and its zones' playlists, or it would
    // be a ghost row with nothing to show.
    if (item.layout_ref_id) {
      db.prepare('UPDATE playlist_items SET layout_ref_id = ? WHERE id = ?').run(item.layout_ref_id, newId);
      db.prepare('INSERT INTO playlist_item_zone_sources (item_id, zone_id, playlist_id) SELECT ?, zone_id, playlist_id FROM playlist_item_zone_sources WHERE item_id = ?').run(newId, item.id);
    }
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
  'fit_mode', 'mute', 'schedules', 'play_when', 'transition', 'paste', 'weight', 'play_to_end', 'transparent_bg',
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
  if (req.playlist.smart_rules) return res.status(400).json({ error: smartPlaylist.SMART_ADD_ERROR });
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
        (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec, play_to_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
      // CORPORATE: store slot content stays flat and within head office's limits. A pasted nested
      // playlist is refused outright (the backstop's FILL_FLAT would refuse the row anyway); the rest
      // is counted against the slot before anything is written. A slot row never pastes: it has no
      // content of its own, so the kinds check below already drops it (and slot_id is never read).
      if (corpFillsLib().fillsOfPlaylist(db, req.params.id).length) {
        if (incoming.some((it) => it && it.child_playlist_id)) return corpGuard.send(res, corpGuard.err('FILL_FLAT'), req);
        corpFillsLib().assertCanAdd(db, req.params.id, incoming.filter((it) => it && [it.content_id, it.widget_id].filter(Boolean).length === 1)
          .map((it) => ({ content_id: it.content_id || null, widget_id: it.widget_id || null, duration_sec: it.duration_sec || 10 })));
      }
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
            fit, when ? JSON.stringify(when) : null, it.weight || 1, normalizeRepeatEvery(it.repeat_every_sec) || null,
            playToEnd.normalizePlayToEnd(it.play_to_end));
          added.push(r.lastInsertRowid);
          if (backgrounds.normalizeTransparentBg(it.transparent_bg) && backgrounds.transparentApplies(it.widget_id ? it : { mime_type: (db.prepare('SELECT mime_type FROM content WHERE id = ?').get(it.content_id || '') || {}).mime_type })) {
            db.prepare('UPDATE playlist_items SET transparent_bg = 1 WHERE id = ?').run(r.lastInsertRowid);   // #660
          }
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
    // Local slot rows (spec §4.7): removed only by "Remove slot", never copied, never dayparted.
    if (rows.some((r) => r.slot_id)) {
      if (action === 'delete') return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_REMOVE'), req);
      if (action === 'duplicate') return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_DUPLICATE'), req);
      if (action === 'schedules') return corpGuard.send(res, corpGuard.err('CORPORATE_SLOT_SCHEDULE'), req);
    }
    if (action === 'duplicate') corpFillsLib().assertCanAdd(db, req.params.id, rows);
    // 3.0 campaigns: a layout item carries zone sources the bulk copy does not know about.
    if (action === 'duplicate' && rows.some((r) => r.layout_ref_id)) {
      return res.status(400).json({ error: 'Layout items are duplicated one at a time (with the item\'s own Duplicate button).' });
    }
    if (action === 'transition' && req.body.widget_id) {
      corpFillsLib().assertCanAdd(db, req.params.id, rows.map(() => ({ widget_id: req.body.widget_id, duration_sec: 1 })));
    }

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
            (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_from, play_until, muted, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec, play_to_end)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            req.params.id, r.content_id, r.widget_id, r.child_playlist_id, r.zone_id, order, r.duration_sec,
            r.play_from, r.play_until, r.muted ? 1 : 0, r.enabled === 0 ? 0 : 1, r.log_play === 0 ? 0 : 1, r.fit_mode, r.play_when, r.weight || 1, r.repeat_every_sec || null, playToEnd.normalizePlayToEnd(r.play_to_end));
          if (r.transparent_bg) db.prepare('UPDATE playlist_items SET transparent_bg = 1 WHERE id = ?').run(result.lastInsertRowid);   // #660
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

    // #624: switch "Play to end" on or off across a selection. Only the YouTube items in it change;
    // the rest are reported as skipped, so "select all, play to end" is safe on a mixed playlist.
    if (action === 'play_to_end') {
      const on = playToEnd.normalizePlayToEnd(req.body.play_to_end);
      const mimeOf = db.prepare('SELECT mime_type FROM content WHERE id = ?');
      const target = rows.filter((r) => r.content_id && playToEnd.appliesTo((mimeOf.get(r.content_id) || {}).mime_type));
      const up = db.prepare("UPDATE playlist_items SET play_to_end = ?, updated_at = strftime('%s','now') WHERE id = ?");
      db.transaction(() => { for (const r of target) up.run(on, r.id); })();
      if (target.length) markDraft(req.params.id, req, `Set play to end on ${target.length} item(s)`);
      return res.json({ updated: target.length, skipped: rows.length - target.length });
    }

    // #660: "Transparent background" across a selection; only widgets and HTML bundles change.
    if (action === 'transparent_bg') {
      const on = backgrounds.normalizeTransparentBg(req.body.transparent_bg);
      const mimeOf = db.prepare('SELECT mime_type FROM content WHERE id = ?');
      const target = rows.filter((r) => backgrounds.transparentApplies({ widget_id: r.widget_id, mime_type: r.content_id ? (mimeOf.get(r.content_id) || {}).mime_type : null }));
      const up = db.prepare("UPDATE playlist_items SET transparent_bg = ?, updated_at = strftime('%s','now') WHERE id = ?");
      db.transaction(() => { for (const r of target) up.run(on, r.id); })();
      if (target.length) markDraft(req.params.id, req, `Set transparent background on ${target.length} item(s)`);
      return res.json({ updated: target.length, skipped: rows.length - target.length });
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
      if (when === false) return res.status(400).json({ error: 'play_when must be a data-source, tag, meta, weather or area condition, or empty' });
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
    // A corporate refusal (fill limits, or a backstop RAISE) is an answer, not a server fault.
    if (corpGuard.send(res, err, req)) return undefined;
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
    if (req.playlist.smart_rules) {
      return res.status(400).json({ error: 'This is a smart playlist: its items come from its rules. Change the rules, or tag the content so it matches.' });
    }
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
      ready.push({ content_id: cid, duration_sec: resolveItemDuration(undefined, content), play_to_end: playToEnd.resolvePlayToEnd(undefined, content.mime_type) });
    }

    /*
     * CORPORATE: into store slot content, each item must be a kind the slot allows (refused ones are
     * itemised like any other skip), and the whole batch must fit the slot's limits — refused whole,
     * because which half of a party to keep is the operator's call, not ours.
     */
    const fl = corpFillsLib();
    if (ready.length && fl.fillsOfPlaylist(db, req.params.id).length) {
      const fitting = [];
      for (const r of ready) {
        const v = fl.violationFor(db, req.params.id, [fl.itemShape(db, r)]);
        if (v && v.code !== 'FILL_LIMIT') skipped.push({ content_id: r.content_id, reason: corpGuard.err(v.code, v.vars).message, code: v.code });
        else fitting.push(r);
      }
      ready.length = 0;
      ready.push(...fitting);
      if (ready.length) fl.assertCanAdd(db, req.params.id, ready);
    }

    let inserted = [];
    if (ready.length) {
      const max = db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
        .get(req.params.id);
      let order = (max.max_order || 0) + 1;
      const zid = playlistLayout.zoneForNewItem(db, req.params.id, zone_id || null);
      const ins = db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, play_to_end)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
      `);
      const ids = [];
      // One transaction: 160 photos are one operation to the person who asked for them, so a
      // failure halfway must not leave half a party in the playlist.
      db.transaction(() => {
        for (const r of ready) {
          ids.push(ins.run(req.params.id, r.content_id, zid, order++, r.duration_sec, r.play_to_end || null).lastInsertRowid);
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
    if (corpGuard.send(res, err, req)) return;
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
  // CORPORATE: a device override on a mandated screen would never play (the mandate outranks it).
  try { corpGuard.assertNotMandated(req, device_id); } catch (e) {
    if (corpGuard.send(res, e, req)) return;
    throw e;
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
