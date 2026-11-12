'use strict';

/*
 * Writing a scanned catalog into a workspace (lib/migrate). Called by the job runner in index.js with
 * a catalog an adapter produced (vendors/*.js) and an open adapter session that can fetch media bytes.
 *
 * ⚠️ IDEMPOTENT BY SOURCE ID. Every object brought over is recorded in migration_items under
 * (workspace, vendor, source account, kind, source id) with the row it became. A re-run — a resume
 * after a crash, a second click, a retry after freeing storage — finds the row and reuses it instead
 * of creating a second copy. If the person deleted the row since, it is created again: the map
 * points at what exists, not at history. An existing row is never overwritten, so edits made after
 * the first import survive a re-run.
 *
 * ⚠️ MEDIA GOES THROUGH THE SAME DOOR AS AN UPLOAD. Bytes land in contentDir as <uuid>.part and are
 * handed to lib/content-ingest ingestUploadedFile: sniffed (lib/upload-sniff decides the type from
 * the bytes, never from the vendor's claim), thumbnailed, digested, placed on the workspace's
 * storage. The download is capped by the instance's per-file limit and by what is left of the
 * plan's storage; when the allowance runs out the job STOPS (status 'stopped', reason
 * storage_limit) instead of failing item after item — everything already imported stays, and a
 * resume after freeing space carries on.
 *
 * ⚠️ SCREENS ARE NEVER CLAIMED. A source display becomes a migration_screens placeholder: its name,
 * the groups it was in (created here as real, empty device groups) and what it played. Pairing a
 * real screen to it is a person's act (routes/migrate.js /placeholders/:id/link after the normal
 * pairing flow). Schedules that targeted one display target a group made for it, so they start
 * working the moment the screen is paired into that group.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../db/database');
const config = require('../../config');
const map = require('./map');

const REPORT_LIST_CAP = 500;

class StopImport extends Error {
  constructor(reason, message) { super(message); this.name = 'StopImport'; this.reason = reason; }
}

function now() { return Math.floor(Date.now() / 1000); }

/* ------------------------------------------------------------------ the id map */

function itemKey(job) { return { ws: job.workspace_id, vendor: job.vendor, account: job.source_account || '' }; }

/** The row a source object became, if it still exists in this workspace. */
function existingTarget(job, kind, sourceId, table) {
  const k = itemKey(job);
  const row = db.prepare(`SELECT target_id FROM migration_items WHERE workspace_id = ? AND vendor = ? AND source_account = ?
    AND kind = ? AND source_id = ? AND status = 'done'`).get(k.ws, k.vendor, k.account, kind, String(sourceId));
  if (!row || !row.target_id) return null;
  const still = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND workspace_id = ?`).get(row.target_id, k.ws);
  return still ? row.target_id : null;
}

function remember(job, kind, sourceId, targetId, status = 'done', note = null) {
  const k = itemKey(job);
  db.prepare(`INSERT INTO migration_items (workspace_id, vendor, source_account, kind, source_id, target_id, job_id, status, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, vendor, source_account, kind, source_id)
    DO UPDATE SET target_id = excluded.target_id, job_id = excluded.job_id, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`)
    .run(k.ws, k.vendor, k.account, kind, String(sourceId), targetId, job.id, status, note ? String(note).slice(0, 500) : null, now());
}

/* ------------------------------------------------------------------ the run */

/**
 * opts: { job, catalog, session, options, userId, onProgress(progress), shouldStop() }
 * Resolves the report. Throws StopImport for a storage stop (report attached as err.report).
 */
async function applyCatalog({ job, catalog, session, options, userId, onProgress = () => {}, shouldStop = () => false }) {
  const o = normalizeOptions(options);
  const report = {
    created: { media: 0, playlists: 0, layouts: 0, schedules: 0, groups: 0, screens: 0 },
    reused: { media: 0, playlists: 0, layouts: 0, schedules: 0, groups: 0, screens: 0 },
    failed: [],
    lossy: [],
    unpublished: 0,
    stopped_reason: null,
  };
  const fail = (kind, name, reason) => { if (report.failed.length < REPORT_LIST_CAP) report.failed.push({ kind, name: map.cleanName(name), reason }); };
  const lossy = (kind, name, note) => { if (report.lossy.length < REPORT_LIST_CAP) report.lossy.push({ kind, name: map.cleanName(name), note }); };

  const media = o.media ? catalog.media || [] : [];
  const playlists = o.playlists ? catalog.playlists || [] : [];
  const layouts = o.layouts ? catalog.layouts || [] : [];
  const schedules = o.schedules ? catalog.schedules || [] : [];
  const screens = o.screens ? catalog.screens || [] : [];
  const groups = (o.screens || o.schedules) ? catalog.groups || [] : [];
  const progress = { phase: 'media', done: 0, total: media.length + playlists.length + layouts.length + schedules.length + screens.length + groups.length, failed: 0 };
  const tick = (failed) => { progress.done++; if (failed) progress.failed++; onProgress({ ...progress }); };
  const checkStop = () => { if (shouldStop()) throw new StopImport('cancelled', 'Cancelled'); };

  const ws = job.workspace_id;
  const folderId = ensureFolder(job, o, userId);

  /* ---- media ---- */
  const mediaMap = new Map();   // source media id -> content row id
  // Media imported by an earlier run is usable by this run's playlists even when not re-selected.
  for (const m of catalog.media || []) {
    const t = existingTarget(job, 'media', m.id, 'content');
    if (t) mediaMap.set(String(m.id), t);
  }
  onProgress({ ...progress });
  for (const m of media) {
    checkStop();
    if (mediaMap.has(String(m.id))) { report.reused.media++; tick(); continue; }
    try {
      const id = await importMedia({ job, m, session, userId, folderId });
      mediaMap.set(String(m.id), id);
      remember(job, 'media', m.id, id);
      report.created.media++;
      tick();
    } catch (e) {
      if (e instanceof StopImport) { report.stopped_reason = e.reason; e.report = report; throw e; }
      remember(job, 'media', m.id, null, 'failed', e.userMessage || e.message);
      fail('media', m.name, e.userMessage || 'The file could not be imported.');
      tick(true);
    }
  }

  /* ---- groups (the source's display groups, real and empty until screens are paired) ---- */
  progress.phase = 'groups';
  const groupMap = new Map();
  for (const g of groups) {
    checkStop();
    let id = existingTarget(job, 'group', g.id, 'device_groups');
    if (id) report.reused.groups++;
    else {
      id = uuidv4();
      db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, color) VALUES (?, ?, ?, ?, ?)')
        .run(id, ownerOf(job, userId), ws, map.cleanName(g.name, 'Imported group'), '#3B82F6');
      remember(job, 'group', g.id, id);
      report.created.groups++;
    }
    groupMap.set(String(g.id), id);
    tick();
  }

  /* ---- layouts (zones + one playlist holding every zone's items) ---- */
  progress.phase = 'layouts';
  const layoutMap = new Map();   // source layout id -> { layoutId, playlistId }
  for (const l of layouts) {
    checkStop();
    try {
      const got = importLayout({ job, l, mediaMap, userId, lossy, folderId });
      layoutMap.set(String(l.id), got);
      if (got.reused) report.reused.layouts++; else report.created.layouts++;
      tick();
    } catch (e) {
      fail('layout', l.name, e.userMessage || 'The layout could not be imported.');
      tick(true);
    }
  }

  /* ---- playlists ---- */
  progress.phase = 'playlists';
  const playlistMap = new Map();
  for (const p of playlists) {
    checkStop();
    let id = existingTarget(job, 'playlist', p.id, 'playlists');
    if (id) { report.reused.playlists++; playlistMap.set(String(p.id), id); tick(); continue; }
    id = uuidv4();
    const items = (p.items || []).filter((it) => mediaMap.has(String(it.media_id)));
    const dropped = (p.items || []).length - items.length;
    db.transaction(() => {
      db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
        .run(id, ownerOf(job, userId), ws, map.cleanName(p.name, 'Imported playlist'), `Imported from ${catalog.vendorName || job.vendor}`);
      insertItems(id, items, mediaMap, null);
    })();
    if (dropped > 0) lossy('playlist', p.name, `${dropped} item(s) were left out: their media was not imported or is a type ScreenTinker does not import.`);
    for (const n of p.notes || []) lossy('playlist', p.name, n);
    remember(job, 'playlist', p.id, id);
    playlistMap.set(String(p.id), id);
    report.created.playlists++;
    tick();
  }

  /* ---- screens: unpaired placeholders ---- */
  progress.phase = 'screens';
  const screenGroup = new Map();   // source screen id -> group made for schedules aimed at it alone
  const needsOwnGroup = new Set(schedules.filter((s) => s.target && s.target.type === 'screen').map((s) => String(s.target.id)));
  const screenById = new Map((catalog.screens || []).map((s) => [String(s.id), s]));
  for (const sid of needsOwnGroup) {
    const s = screenById.get(sid);
    if (!s) continue;
    let gid = existingTarget(job, 'screen_group', sid, 'device_groups');
    if (!gid) {
      gid = uuidv4();
      db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, color) VALUES (?, ?, ?, ?, ?)')
        .run(gid, ownerOf(job, userId), ws, `${map.cleanName(s.name, 'Screen')} (imported)`.slice(0, 200), '#64748B');
      remember(job, 'screen_group', sid, gid);
      report.created.groups++;
    }
    screenGroup.set(sid, gid);
  }
  for (const s of screens) {
    checkStop();
    let id = existingTarget(job, 'screen', s.id, 'migration_screens');
    if (id) { report.reused.screens++; tick(); continue; }
    id = uuidv4();
    const gids = (s.group_ids || []).map((g) => groupMap.get(String(g))).filter(Boolean);
    if (screenGroup.has(String(s.id))) gids.push(screenGroup.get(String(s.id)));
    const lay = s.layout_id ? layoutMap.get(String(s.layout_id)) : null;
    const plId = s.playlist_id ? playlistMap.get(String(s.playlist_id)) || null : lay ? lay.playlistId : null;
    db.prepare(`INSERT INTO migration_screens (id, workspace_id, job_id, vendor, name, group_ids, playlist_id, layout_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ws, job.id, job.vendor, map.cleanName(s.name, 'Screen'), JSON.stringify([...new Set(gids)]), plId,
        lay ? lay.layoutId : null, s.note ? map.cleanName(s.note) : null);
    remember(job, 'screen', s.id, id);
    report.created.screens++;
    tick();
  }

  /* ---- schedules ---- */
  progress.phase = 'schedules';
  for (const s of schedules) {
    checkStop();
    const gid = s.target && s.target.type === 'group' ? groupMap.get(String(s.target.id))
      : s.target && s.target.type === 'screen' ? screenGroup.get(String(s.target.id)) : null;
    if (!gid) { fail('schedule', s.name, 'Its screens or groups were not imported, so it has nothing to target.'); tick(true); continue; }
    let playlistId = null, layoutId = null;
    if (s.layout_id) {
      const lay = layoutMap.get(String(s.layout_id));
      if (lay) { layoutId = lay.layoutId; playlistId = lay.playlistId; }
    } else if (s.playlist_id) playlistId = playlistMap.get(String(s.playlist_id)) || null;
    if (!playlistId) { fail('schedule', s.name, 'What it plays was not imported.'); tick(true); continue; }

    const m = map.scheduleRows({ start: s.start, end: s.end, timezone: s.timezone, recurrence: s.recurrence });
    if (m.skip) { fail('schedule', s.name, m.skip); tick(true); continue; }
    for (const n of (s.notes || []).concat(m.notes)) lossy('schedule', s.name, n);
    m.rows.forEach((r, i) => {
      const key = i === 0 ? String(s.id) : `${s.id}#${i}`;
      if (existingTarget(job, 'schedule', key, 'schedules')) { report.reused.schedules++; return; }
      const id = uuidv4();
      db.prepare(`INSERT INTO schedules (id, user_id, workspace_id, group_id, layout_id, playlist_id, title, start_time, end_time, timezone,
          recurrence, recurrence_end, priority, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerOf(job, userId), ws, gid, layoutId, playlistId, map.cleanName(s.name, 'Imported schedule'), r.start_time, r.end_time,
          r.timezone, r.recurrence, r.recurrence_end, Math.max(0, Math.min(100, Number(s.priority) || 0)), '#8B5CF6');
      remember(job, 'schedule', key, id);
      report.created.schedules++;
    });
    tick();
  }

  /* ---- publish what was created ---- */
  if (o.publish) {
    progress.phase = 'publishing';
    onProgress({ ...progress });
    const ids = [...new Set([...playlistMap.values(), ...[...layoutMap.values()].map((x) => x.playlistId)])];
    for (const id of ids) {
      const row = db.prepare("SELECT status, published_snapshot FROM playlists WHERE id = ? AND workspace_id = ?").get(id, ws);
      if (!row || row.published_snapshot) continue;   // already published (by a previous run or a person)
      try {
        require('../releases').releasePlaylist(db, id, null, { actor: { userId, kind: 'user', label: null }, source: 'migrate' });
      } catch (e) {
        report.unpublished++;
        if (e && e.name !== 'ReleaseError') console.warn(`[migrate] publish ${id}: ${(e && e.name) || 'error'}`);
      }
    }
  }

  try { require('../revisions').recordMissingIn(db, ws, { userId, kind: 'import', label: `import from ${job.vendor}` }, 'Imported'); }
  catch { /* history is best effort */ }
  try { require('../smart-playlist').notifyContentChanged(ws); } catch { /* best effort */ }
  return report;
}

function normalizeOptions(options) {
  const o = options || {};
  const on = (k) => o[k] !== false;
  return {
    media: on('media'), playlists: on('playlists'), layouts: on('layouts'), schedules: on('schedules'), screens: on('screens'),
    publish: o.publish !== false, folder_id: o.folder_id || null, folder_name: o.folder_name || null,
  };
}

function ownerOf(job, userId) {
  // playlists/schedules/device_groups.user_id is NOT NULL; a support session has no users row. The
  // workspace's org owner then owns what was imported, which is who would own it after a user delete.
  if (userId && db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return userId;
  const o = db.prepare('SELECT o.owner_user_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ?').get(job.workspace_id);
  return o ? o.owner_user_id : userId;
}

/** The folder imported media lands in: the one chosen, or "Imported from <Vendor>" (made once). */
function ensureFolder(job, o, userId) {
  const ws = job.workspace_id;
  if (o.folder_id) {
    const f = db.prepare('SELECT id FROM content_folders WHERE id = ? AND workspace_id = ?').get(String(o.folder_id), ws);
    if (f) return f.id;
  }
  if (o.folder_id === 'root') return null;
  const existing = existingTarget(job, 'folder', 'root', 'content_folders');
  if (existing) return existing;
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM content_folders WHERE workspace_id = ?').get(ws);
  if (count >= 100) return null;   // routes/folders.js MAX_FOLDERS_PER_WORKSPACE: the root it is
  const id = uuidv4();
  const name = map.cleanName(o.folder_name || `Imported from ${require('./vendors').get(job.vendor)?.name || job.vendor}`).slice(0, 100);
  db.prepare('INSERT INTO content_folders (id, user_id, workspace_id, parent_id, name) VALUES (?, ?, ?, NULL, ?)').run(id, ownerOf(job, userId), ws, name);
  remember(job, 'folder', 'root', id);
  return id;
}

function insertItems(playlistId, items, mediaMap, zoneId) {
  const { resolveItemDuration } = require('../item-duration');
  const ins = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?)');
  const get = db.prepare('SELECT mime_type, duration_sec FROM content WHERE id = ?');
  let order = Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM playlist_items WHERE playlist_id = ?').get(playlistId).m) + 1;
  for (const it of items) {
    const contentId = mediaMap.get(String(it.media_id));
    const c = get.get(contentId);
    ins.run(playlistId, contentId, zoneId, order++, resolveItemDuration(map.seconds(it.duration), c));
  }
}

function importLayout({ job, l, mediaMap, userId, lossy, folderId }) {
  const ws = job.workspace_id;
  const existing = existingTarget(job, 'layout', l.id, 'layouts');
  const existingPl = existingTarget(job, 'layout_playlist', l.id, 'playlists');
  if (existing && existingPl) return { layoutId: existing, playlistId: existingPl, reused: true };
  const W = Math.max(1, Math.min(16384, Number(l.width) || 1920)), H = Math.max(1, Math.min(16384, Number(l.height) || 1080));
  const layoutId = existing || uuidv4();
  const playlistId = uuidv4();
  let dropped = 0;
  db.transaction(() => {
    if (!existing) {
      db.prepare('INSERT INTO layouts (id, name, width, height, is_template, user_id, workspace_id) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(layoutId, map.cleanName(l.name, 'Imported layout'), W, H, userId && db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) ? userId : null, ws);
    }
    db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
      .run(playlistId, ownerOf(job, userId), ws, `${map.cleanName(l.name, 'Layout')} (layout)`.slice(0, 200), 'Plays the zones of an imported layout');
    const zones = (l.zones || []).slice(0, 32);
    const zoneIds = existing ? db.prepare('SELECT id FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId).map((z) => z.id) : [];
    zones.forEach((z, i) => {
      let zid = zoneIds[i];
      if (!zid) {
        zid = uuidv4();
        const pct = map.zonePercent(z, W, H);
        db.prepare(`INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'content', 'contain', '#000000', ?)`)
          .run(zid, layoutId, map.cleanName(z.name, `Zone ${i + 1}`).slice(0, 100), pct.x_percent, pct.y_percent, pct.width_percent, pct.height_percent,
            Math.max(0, Math.min(99, Number(z.z) || 0)), i);
      }
      const items = (z.items || []).filter((it) => mediaMap.has(String(it.media_id)));
      dropped += (z.items || []).length - items.length;
      // One zone alone is the whole screen: zone_id stays NULL, as the player strips it anyway.
      insertItems(playlistId, items, mediaMap, zones.length > 1 ? zid : null);
    });
    if ((l.zones || []).length > 32) lossy('layout', l.name, 'Only the first 32 zones were kept.');
  })();
  if (dropped) lossy('layout', l.name, `${dropped} widget(s) or item(s) were left out: web pages, tickers, clocks and other widgets are not imported. Add a ScreenTinker widget in their place.`);
  for (const n of l.notes || []) lossy('layout', l.name, n);
  if (!existing) remember(job, 'layout', l.id, layoutId);
  remember(job, 'layout_playlist', l.id, playlistId);
  void folderId;
  return { layoutId, playlistId, reused: false };
}

/* ------------------------------------------------------------------ media */

async function importMedia({ job, m, session, userId, folderId }) {
  const { storageRoomBytes } = require('../../middleware/subscription');
  const room = userId ? storageRoomBytes(userId, job && job.workspace_id) : null;
  if (room !== null && room <= 0) throw new StopImport('storage_limit', 'The storage allowance is used up.');
  const limit = room === null ? config.maxFileSize : Math.min(config.maxFileSize, Math.max(0, room));
  const declared = Number(m.size) || 0;
  if (declared > config.maxFileSize) throw userError(`It is larger than this server's ${Math.round(config.maxFileSize / 1048576)} MB upload limit.`);
  if (room !== null && declared > room) throw new StopImport('storage_limit', 'The next file would exceed the storage allowance.');

  fs.mkdirSync(config.contentDir, { recursive: true });
  const tmp = path.join(config.contentDir, `${uuidv4()}.part`);
  let got;
  try {
    got = await session.fetchMedia(m, tmp, limit);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* not written */ }
    if (e && e.code === 'too_large') {
      if (room !== null && limit < config.maxFileSize) throw new StopImport('storage_limit', 'The next file would exceed the storage allowance.');
      throw userError(`It is larger than this server's ${Math.round(config.maxFileSize / 1048576)} MB upload limit.`);
    }
    if (e && e.code === 'blocked') throw userError(e.message);
    throw userError((e && e.name === 'MigrateHttpError' && e.message) || 'The file could not be downloaded.');
  }
  const { ingestUploadedFile } = require('../content-ingest');
  const name = originalName(m);
  let row;
  try {
    row = await ingestUploadedFile({ file: { path: tmp, size: got.size, originalname: name }, userId, workspaceId: job.workspace_id, folderId });
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* moved or gone */ }
    if (e && e.name === 'UnsupportedUploadError') throw userError('It is not an image, video or audio file ScreenTinker can play.');
    if (e && e.name === 'StorageWriteError') { try { e.discard(); } catch { /* gone */ } throw userError(e.message); }
    if (e && e.code && /^BUNDLE_|ZIP/.test(String(e.code))) throw userError('It is a zip that is not an HTML bundle ScreenTinker can play.');
    throw userError('The file could not be added to the library.');
  }
  return row.id;
}

function originalName(m) {
  const n = map.cleanName(m.name, `media-${m.id}`).replace(/[/\\]/g, '_');
  if (/\.[a-z0-9]{2,5}$/i.test(n) || !m.ext) return n;
  return `${n}.${String(m.ext).replace(/[^a-z0-9]/gi, '').slice(0, 5)}`;
}

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

module.exports = { applyCatalog, StopImport, normalizeOptions, existingTarget, remember };
