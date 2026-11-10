'use strict';

/*
 * The vision mixer (frontend views/mixer.js): run screens like a live channel.
 *
 *   GET  /api/mixer         what the desk needs: the screens (outputs), their groups, the
 *                           published playlists (sources), and the graphics on offer
 *   POST /api/mixer/take    { device_ids: [...], playlist_id }  put a source on air NOW
 *
 * TAKE is the existing "this screen plays this playlist" (the device override the Playlists page
 * sets, with every rule that has: same workspace, head office's screens are not yours to
 * override), done for several screens at once and pushed with `cut_now`, which tells a player to
 * switch at once instead of at the end of the item it is showing. A player that does not know the
 * flag still takes the playlist, at its next item boundary.
 *
 * Graphics are keyed through the overlay API the players already have (routes/pip.js); the pages
 * themselves are lib/mixer-gfx.js, served at /gfx/:kind.
 *
 * Mounted behind the tenancy middleware and the token scope gate (config/api-surface.js).
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { resourceAccess } = require('../lib/tenancy');
const gfx = require('../lib/mixer-gfx');

const config = require('../config');
// ⚠️ SELF-HOSTED ONLY, all of it: the desk, takes, scenes. On the hosted service the mixer is not
// offered (it is arranged per enterprise agreement), the dashboard does not show it, and the API
// answers as if it were not there.
router.use((req, res, next) => (config.selfHosted ? next() : res.status(404).json({ error: 'The mixer is available on self-hosted instances.', code: 'on_prem_only' })));

const TRANSITIONS = ['cut', 'fade', 'flash', 'wipe'];

function requireFleetWrite(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return res.status(403).json({ error: 'Read-only access' });
  next();
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = req.workspaceId;
  const screens = db.prepare(`
    SELECT d.id, d.name, d.status, d.playlist_id, d.orientation, d.client_type,
           (SELECT p.name FROM playlists p WHERE p.id = d.playlist_id) AS playlist_name
      FROM devices d WHERE d.workspace_id = ? AND d.status != 'provisioning'
     ORDER BY COALESCE(d.sort_order, 0), d.created_at`).all(ws);
  let groups = [];
  try {
    groups = db.prepare('SELECT id, name FROM device_groups WHERE workspace_id = ? ORDER BY LOWER(name)').all(ws).map((g) => ({
      ...g, device_ids: db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(g.id).map((r) => r.device_id),
    }));
  } catch { groups = []; }
  const sources = db.prepare(`
    SELECT p.id, p.name, p.status,
           (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS items
      FROM playlists p WHERE p.workspace_id = ? AND COALESCE(p.is_auto_generated, 0) = 0
     ORDER BY LOWER(p.name)`).all(ws).filter((p) => p.items > 0);
  // Cameras that can be steered (ONVIF, added in Content): the desk's camera control drives them
  // through the existing camera API (routes/onvif.js).
  let cameras = [];
  try {
    cameras = db.prepare("SELECT id, filename, onvif FROM content WHERE workspace_id = ? AND onvif IS NOT NULL AND onvif != '' ORDER BY LOWER(filename)").all(ws)
      .map((c) => { let o = null; try { o = JSON.parse(c.onvif); } catch { o = null; } return o && o.ptz ? { id: c.id, name: c.filename } : null; }).filter(Boolean);
  } catch { cameras = []; }
  res.json({ screens, groups, sources, cameras, scenes: scenesOf(ws), transitions: TRANSITIONS, graphics: gfx.KINDS.map((k) => ({ kind: k, box: gfx.BOX[k] })) });
});

// ── scenes: a named look recalled with one key ───────────────────────────────────────────────────
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
function scenesOf(ws) {
  return db.prepare('SELECT * FROM mixer_scenes WHERE workspace_id = ? ORDER BY sort_order, created_at').all(ws)
    .map((s) => ({ id: s.id, name: s.name, playlist_id: s.playlist_id || null, graphic: parse(s.gfx_json), cameras: parse(s.ptz_json) || [] }));
}
/** Checks a scene as sent. Everything it names must belong to this workspace. */
function cleanScene(req, b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return { error: 'Give the scene a name.' };
  let playlist_id = null;
  if (b.playlist_id) {
    const p = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(String(b.playlist_id));
    if (!p || p.workspace_id !== req.workspaceId) return { error: 'That source is not in this workspace.' };
    playlist_id = p.id;
  }
  let graphic = null;
  if (b.graphic && typeof b.graphic === 'object') {
    if (!gfx.KINDS.includes(b.graphic.kind) || !String(b.graphic.a || '').trim()) return { error: 'A scene\'s graphic needs a kind and its text.' };
    graphic = { kind: b.graphic.kind, a: String(b.graphic.a).slice(0, 120), b: String(b.graphic.b || '').slice(0, 200), accent: /^#[0-9a-fA-F]{6}$/.test(b.graphic.accent || '') ? b.graphic.accent : '#ff2a1f' };
  }
  const cameras = [];
  for (const c of Array.isArray(b.cameras) ? b.cameras.slice(0, 16) : []) {
    const row = c && typeof c.camera_id === 'string' && db.prepare('SELECT id, workspace_id, onvif FROM content WHERE id = ?').get(c.camera_id);
    if (!row || row.workspace_id !== req.workspaceId || !row.onvif || typeof c.preset !== 'string' || !c.preset) return { error: 'A scene\'s camera position must be a camera of this workspace and one of its presets.' };
    cameras.push({ camera_id: row.id, preset: c.preset.slice(0, 100), preset_name: String(c.preset_name || '').slice(0, 100) });
  }
  if (!playlist_id && !graphic && !cameras.length) return { error: 'A scene needs a source, a graphic or a camera position.' };
  return { value: { name, playlist_id, graphic, cameras } };
}
router.post('/scenes', requireScope('full'), requireFleetWrite, (req, res) => {
  const v = cleanScene(req, req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const n = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS top FROM mixer_scenes WHERE workspace_id = ?').get(req.workspaceId);
  if (n.n >= 100) return res.status(400).json({ error: 'That is the most scenes a workspace can keep.' });
  const id = require('crypto').randomUUID(), x = v.value;
  db.prepare('INSERT INTO mixer_scenes (id, workspace_id, name, playlist_id, gfx_json, ptz_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.workspaceId, x.name, x.playlist_id, x.graphic ? JSON.stringify(x.graphic) : null, x.cameras.length ? JSON.stringify(x.cameras) : null, n.top + 1);
  res.status(201).json(scenesOf(req.workspaceId).find((s) => s.id === id));
});
router.delete('/scenes/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const r = db.prepare('DELETE FROM mixer_scenes WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  if (!r.changes) return res.status(404).json({ error: 'Scene not found' });
  res.json({ success: true });
});

router.post('/take', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.device_ids) ? [...new Set(b.device_ids.filter((x) => typeof x === 'string'))].slice(0, 500) : [];
  // Stream outputs (routes/stream-out.js) take a source the same way a screen does.
  const streamIds = Array.isArray(b.stream_ids) ? [...new Set(b.stream_ids.filter((x) => typeof x === 'string'))].slice(0, 50) : [];
  if (!ids.length && !streamIds.length) return res.status(400).json({ error: 'device_ids required: choose at least one screen' });
  if (typeof b.playlist_id !== 'string' || !b.playlist_id) return res.status(400).json({ error: 'playlist_id required' });
  const playlist = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?').get(b.playlist_id);
  if (!playlist || playlist.workspace_id !== req.workspaceId) return res.status(404).json({ error: 'Playlist not found in this workspace' });

  // The transition: none is a cut. Players that do not know take_fx cut (or switch at their next item).
  let fx = null;
  if (b.transition != null) {
    const tr = b.transition;
    if (typeof tr !== 'object' || !TRANSITIONS.includes(tr.type)) return res.status(400).json({ error: `transition.type is one of: ${TRANSITIONS.join(', ')}` });
    const ms = Number(tr.ms == null ? 600 : tr.ms);
    if (!Number.isFinite(ms) || ms < 200 || ms > 3000) return res.status(400).json({ error: 'transition.ms is 200 to 3000' });
    if (tr.type !== 'cut') fx = { type: tr.type, ms: Math.round(ms), ...(/^#[0-9a-fA-F]{6}$/.test(tr.color || '') ? { color: tr.color } : {}) };
  }

  const corpGuard = require('../lib/corporate/guard');
  const taken = [], skipped = [];
  const io = req.app.get('io');
  let push = null;
  try {
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    // cut_now: switch at once, not at the end of the current item (player/index.html).
    const cutPayload = (id) => { const p = buildPlaylistPayload(id); return p && !p.suspended ? { ...p, cut_now: true, ...(fx ? { take_fx: fx } : {}) } : p; };
    if (io && typeof buildPlaylistPayload === 'function') push = (id) => commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, cutPayload);
  } catch { push = null; }

  const setOverride = db.prepare("UPDATE devices SET playlist_id = ?, playlist_source = 'device' WHERE id = ?");
  for (const id of ids) {
    const d = db.prepare('SELECT id, name, workspace_id, playlist_id FROM devices WHERE id = ?').get(id);
    if (!d || d.workspace_id !== req.workspaceId) { skipped.push({ device_id: id, reason: 'not_found' }); continue; }
    let mandated = false;
    try { mandated = corpGuard.isControlledFor(req, id); } catch { mandated = false; }
    if (mandated) { skipped.push({ device_id: id, name: d.name, reason: 'corporate' }); continue; }
    setOverride.run(playlist.id, id);
    try { if (push) push(id); } catch { /* the override is saved; the screen takes it on its next sync */ }
    taken.push({ device_id: id, name: d.name, previous_playlist_id: d.playlist_id || null });
  }
  const streams = [];
  for (const id of streamIds) {
    const s = db.prepare('SELECT id, name, workspace_id, playlist_id FROM stream_outputs WHERE id = ?').get(id);
    if (!s || s.workspace_id !== req.workspaceId) { skipped.push({ stream_id: id, reason: 'not_found' }); continue; }
    db.prepare('UPDATE stream_outputs SET playlist_id = ? WHERE id = ?').run(playlist.id, id);
    try { require('./stream-out').noteTake(id, fx); } catch { /* the stream still takes it, as a cut */ }
    streams.push({ stream_id: id, name: s.name, previous_playlist_id: s.playlist_id || null });
  }
  res.json({ success: taken.length + streams.length > 0, playlist: { id: playlist.id, name: playlist.name }, taken, streams, skipped });
});

module.exports = router;
module.exports.requireFleetWrite = requireFleetWrite;
