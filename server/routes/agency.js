'use strict';

// #73: agency portal endpoints. Mounted behind bearerAuth + resolveTenancy + agencyGate
// (AGENCY_ROUTERS in config/api-surface.js). agencyGate has ALREADY proven, at one seam:
// the caller is an 'agency' token, and for any :playlistId the playlist is in THIS token's
// allowlist AND its bound workspace. So these handlers only add within-workspace content
// checks; router/target/cross-workspace confinement is proven upstream.

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const upload = require('../middleware/upload');
const { checkStorageLimit } = require('../middleware/subscription');
const { ingestUploadedFile } = require('../lib/content-ingest');
const { listDesignatedPlaylists, isZonedPlaylist, folderSubtree } = require('../lib/agency-targets');
const { listLayoutGeometry } = require('../lib/agency-layouts');
const { publishPlaylist } = require('./playlists'); // #73: shared publish path for auto-publish
const { isConfigured } = require('../services/email'); // #73: gate digest enqueue on SMTP being set

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// List the playlists THIS token may post to (so the portal can show them). No :playlistId,
// so router.param doesn't apply - the confinement is the query in lib/agency-targets.js
// (own token + bound workspace only). Bite-tested in test/agency-list.test.js.
router.get('/playlists', (req, res) => {
  res.json(listDesignatedPlaylists(db, req.apiToken.id, req.jwtWorkspaceId));
});

// Layout GEOMETRY for ONE designated playlist (the per-playlist size-guidance card): canvas
// size + zone positions/sizes, with feeds_zone_ids = the zones this playlist actually feeds
// (so the agency sees where/what-size their content lands). Returns [] when the playlist has
// no layout -> the card shows the full-screen message. Placement itself stays the admin's job
// (device-side). Has :playlistId, so router.param confines it. DEVICE-FREE (lib/agency-layouts.js).
router.get('/playlists/:playlistId/layout', (req, res) => {
  res.json(listLayoutGeometry(db, req.apiToken.id, req.jwtWorkspaceId, req.params.playlistId));
});

// #73 THE target seam. router.param fires for EVERY route with :playlistId, WITH the param,
// BEFORE the handler - so no targeted route can skip the allowlist + bound-workspace check
// (the api-surface.js can't-drift property, at the param level: you cannot add a :playlistId
// route without this triggering). One query enforces both the target allowlist and
// cross-workspace isolation. Neutralizing the `if (!ok)` return makes integration BITE 1 red.
router.param('playlistId', (req, res, next, playlistId) => {
  const ok = db.prepare(`
    SELECT 1 FROM api_token_targets t
    JOIN playlists p ON p.id = t.playlist_id
    WHERE t.token_id = ? AND t.playlist_id = ? AND p.workspace_id = ?
  `).get(req.apiToken.id, playlistId, req.jwtWorkspaceId);
  if (!ok) return res.status(403).json({ error: 'playlist not in this agency token\'s allowlist' });
  next();
});

// #158: the folders THIS token may drop uploads into = its bound upload_folder_id + descendants
// (Hybrid-C). No bound folder -> [] (portal shows no picker, uploads go to root). The subtree
// query in lib/agency-targets.js is the confinement, shared with the upload check below so the
// list and the writable set can't drift. No :playlistId, so router.param doesn't apply.
router.get('/folders', (req, res) => {
  res.json(folderSubtree(db, req.apiToken.upload_folder_id, req.workspaceId));
});

// Upload to the bound workspace via the SHARED ingest -> first-class content (identical
// thumbnail/dimensions/duration to a dashboard upload). #158: the file lands in the token's
// bound folder by default; the agency may target a SUBFOLDER of it via folder_id, but nothing
// outside that subtree (folder_id read from the multipart body, then confined to folderSubtree).
router.post('/content', checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Default target = the bound folder (or root if none bound). A supplied folder_id must be
    // WITHIN the bound subtree — never a sibling, a parent, or another workspace's folder.
    let folderId = req.apiToken.upload_folder_id || null;
    const requested = req.body && req.body.folder_id;
    if (requested) {
      const allowed = new Set(folderSubtree(db, req.apiToken.upload_folder_id, req.workspaceId).map(f => f.id));
      if (!allowed.has(requested)) return res.status(403).json({ error: 'folder is not in this agency token\'s upload area' });
      folderId = requested;
    }
    const content = await ingestUploadedFile({ file: req.file, userId: req.user.id, workspaceId: req.workspaceId, folderId });
    res.status(201).json(content);
  } catch (e) {
    console.error('agency upload error:', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Add a date-bounded item to a DESIGNATED playlist (#74/#75 schedule block). The playlist
// is already gate-verified. Lands as DRAFT (markDraft) so the admin's re-publish is the
// approval gate for external-party content - same draft-on-change behavior as the dashboard.
router.post('/playlists/:playlistId/items', (req, res) => {
  const { content_id } = req.body;
  if (!content_id) return res.status(400).json({ error: 'content_id required' });

  // #73 full-screen guardrail, upload-time (MANDATORY because auto-publish has no draft net):
  // if the designated playlist has BECOME zoned since designation, block the add - a full-screen
  // agency upload can't target a zone. 409 (not 401/403) so the portal shows the message, not its
  // "key invalid" reset. This runs BEFORE the draft/publish branch, so auto-publish can't slip through.
  if (isZonedPlaylist(db, req.params.playlistId)) {
    return res.status(409).json({ error: "This playlist can't accept uploads right now — it's been assigned to a zone on a screen. Ask your contact." });
  }

  const content = db.prepare('SELECT id, workspace_id, duration_sec FROM content WHERE id = ?').get(content_id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  // cross-tenant guard: content must be in the token's bound workspace (or a template)
  if (content.workspace_id && content.workspace_id !== req.workspaceId) {
    return res.status(403).json({ error: 'Content is not in this workspace' });
  }

  let { duration_sec, days, start, end, start_date, end_date } = req.body;
  if (duration_sec != null && (typeof duration_sec !== 'number' || duration_sec < 1)) {
    return res.status(400).json({ error: 'duration_sec must be a positive integer' });
  }
  duration_sec = duration_sec || content.duration_sec || 10;

  const sd = start_date ?? null, ed = end_date ?? null;
  for (const [k, v] of [['start_date', sd], ['end_date', ed]]) {
    if (v != null && !DATE_RE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD or null` });
  }
  const dys = (Array.isArray(days) && days.length) ? days : [0, 1, 2, 3, 4, 5, 6];
  if (!dys.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return res.status(400).json({ error: 'days must be integers 0-6' });
  const st = start ?? '00:00', en = end ?? '24:00';
  if (!TIME_RE.test(st)) return res.status(400).json({ error: 'start must be HH:MM' });
  if (!(TIME_RE.test(en) || en === '24:00')) return res.status(400).json({ error: 'end must be HH:MM or 24:00' });

  const order = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM playlist_items WHERE playlist_id = ?').get(req.params.playlistId).n;
  const itemId = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)')
    .run(req.params.playlistId, content_id, order, duration_sec).lastInsertRowid;
  db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,0)')
    .run(uuidv4(), itemId, dys.join(','), st, en, sd, ed);
  // #73: draft vs live is decided by the TOKEN's auto_publish (admin-set, read from
  // req.apiToken - NEVER req.body, so the agency can't opt itself out of approval). Default
  // 0 -> draft for admin re-publish. 1 -> the SHARED publishPlaylist path (snapshot + push).
  let published = false;
  if (req.apiToken.auto_publish) {
    publishPlaylist(req.params.playlistId, req);
    published = true;
  } else {
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(req.params.playlistId);
  }

  // #73: enqueue a digest notification ONLY when email is configured, so the queue can't
  // balloon on installs without SMTP. action reflects what actually happened (draft vs live).
  if (isConfigured()) {
    db.prepare('INSERT INTO agency_notifications (workspace_id, token_id, playlist_id, action, content_id) VALUES (?,?,?,?,?)')
      .run(req.workspaceId, req.apiToken.id, req.params.playlistId, published ? 'published' : 'draft', content_id);
  }

  res.status(201).json({ id: itemId, playlist_id: req.params.playlistId, content_id, duration_sec, start_date: sd, end_date: ed, published });
});

module.exports = router;
