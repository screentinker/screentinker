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
  res.json({ screens, groups, sources, graphics: gfx.KINDS.map((k) => ({ kind: k, box: gfx.BOX[k] })) });
});

router.post('/take', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.device_ids) ? [...new Set(b.device_ids.filter((x) => typeof x === 'string'))].slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: 'device_ids required: choose at least one screen' });
  if (typeof b.playlist_id !== 'string' || !b.playlist_id) return res.status(400).json({ error: 'playlist_id required' });
  const playlist = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?').get(b.playlist_id);
  if (!playlist || playlist.workspace_id !== req.workspaceId) return res.status(404).json({ error: 'Playlist not found in this workspace' });

  const corpGuard = require('../lib/corporate/guard');
  const taken = [], skipped = [];
  const io = req.app.get('io');
  let push = null;
  try {
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    // cut_now: switch at once, not at the end of the current item (player/index.html).
    const cutPayload = (id) => { const p = buildPlaylistPayload(id); return p && !p.suspended ? { ...p, cut_now: true } : p; };
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
  res.json({ success: taken.length > 0, playlist: { id: playlist.id, name: playlist.name }, taken, skipped });
});

module.exports = router;
