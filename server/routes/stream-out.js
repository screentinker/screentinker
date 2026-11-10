'use strict';

/*
 * Stream outputs of the vision mixer (lib/stream-out.js): where a stream goes, and Go live / Stop.
 *
 *   GET    /api/stream-out             what is possible here, and this workspace's outputs
 *   POST   /api/stream-out             add a destination        PUT /:id   change it
 *   DELETE /api/stream-out/:id         remove it (stops it first)
 *   POST   /api/stream-out/:id/start   go live                  POST /:id/stop
 *   POST   /api/stream-out/:id/gfx     key a graphic over it    POST /:id/gfx/clear
 *
 * Session only (not reachable with an API token): it holds stream keys and starts encoders on the
 * server. The key is write-only: stored encrypted, never sent back. Self-hosted instances only;
 * on a hosted instance GET says so and everything else refuses.
 *
 * The two routes the server's own renderer uses (the page and its feed) are `renderer`, mounted
 * without a session in server.js: they are addressed by the output's random feed secret.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const secretbox = require('../lib/secretbox');
const streamOut = require('../lib/stream-out');
const gfx = require('../lib/mixer-gfx');
const { requireFleetWrite } = require('./mixer');

const pub = (r) => ({
  id: r.id, name: r.name, kind: r.kind, kind_label: streamOut.KINDS[r.kind] ? streamOut.KINDS[r.kind].label : r.kind,
  url: r.url || null, has_key: !!r.key_enc, playlist_id: r.playlist_id || null,
  playlist_name: r.playlist_id ? ((db.prepare('SELECT name FROM playlists WHERE id = ?').get(r.playlist_id) || {}).name || null) : null,
  width: r.width, height: r.height, fps: r.fps, bitrate_k: r.bitrate_k,
  graphic: !!r.gfx_json,
  status: { ...streamOut.status(r.id), last_error: streamOut.lastError(r.id) },
});
const mine = (req, id) => {
  const r = db.prepare('SELECT * FROM stream_outputs WHERE id = ?').get(id);
  return r && r.workspace_id === req.workspaceId ? r : null;
};
async function gate(req, res, next) {
  const a = await streamOut.availability();
  if (!a.available) return res.status(403).json({ error: 'Streaming out is not available on this server.', code: a.reason });
  next();
}

router.get('/', async (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const a = await streamOut.availability();
  const rows = a.reason === 'hosted' ? [] : db.prepare('SELECT * FROM stream_outputs WHERE workspace_id = ? ORDER BY created_at').all(req.workspaceId);
  res.json({
    available: a.available, reason: a.reason, max: streamOut.MAX_STREAMS,
    // Which ffmpeg this server has, so the desk can say what licence it is under.
    ffmpeg: a.ffmpeg ? { present: a.ffmpeg.present, licence: a.ffmpeg.licence, version: a.ffmpeg.version } : null,
    kinds: Object.entries(streamOut.KINDS).map(([kind, k]) => ({ kind, label: k.label, needs_url: !k.base })),
    sizes: streamOut.SIZES.map(([width, height]) => ({ width, height })),
    outputs: rows.map(pub),
  });
});

router.post('/', gate, requireFleetWrite, (req, res) => {
  const v = streamOut.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (db.prepare('SELECT COUNT(*) AS n FROM stream_outputs WHERE workspace_id = ?').get(req.workspaceId).n >= 20) return res.status(400).json({ error: 'That is the most stream destinations a workspace can keep.' });
  const id = crypto.randomUUID(), x = v.value;
  db.prepare(`INSERT INTO stream_outputs (id, workspace_id, name, kind, url, key_enc, width, height, fps, bitrate_k, feed_secret)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.workspaceId, x.name, x.kind, x.url, secretbox.encrypt(x.key), x.width, x.height, x.fps, x.bitrate_k, crypto.randomBytes(32).toString('base64url'));
  res.status(201).json(pub(mine(req, id)));
});

router.put('/:id', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (streamOut.status(r.id).state !== 'off') return res.status(409).json({ error: 'Stop the stream before changing it.' });
  const b = req.body || {};
  // An empty key field means "keep the key that is stored".
  const v = streamOut.validate({ ...r, ...b, key: b.key || 'kept' }, { needKey: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const x = v.value;
  db.prepare('UPDATE stream_outputs SET name = ?, kind = ?, url = ?, key_enc = ?, width = ?, height = ?, fps = ?, bitrate_k = ? WHERE id = ?')
    .run(x.name, x.kind, x.url, b.key ? secretbox.encrypt(x.key) : r.key_enc, x.width, x.height, x.fps, x.bitrate_k, r.id);
  res.json(pub(mine(req, r.id)));
});

router.delete('/:id', requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  await streamOut.stop(r.id);
  db.prepare('DELETE FROM stream_outputs WHERE id = ?').run(r.id);
  res.json({ success: true });
});

router.post('/:id/start', gate, requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!r.playlist_id) return res.status(400).json({ error: 'Take a source to this stream first, so it has something to show.' });
  const key = secretbox.decrypt(r.key_enc) || '';
  if (r.key_enc && !key) return res.status(400).json({ error: 'The stored stream key can no longer be read. Enter it again.' });
  try { res.json({ status: await streamOut.start(r, key) }); }
  catch (e) { res.status(e.code === 'limit' ? 409 : 500).json({ error: e.message, code: e.code || null }); }
});

router.post('/:id/stop', requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  res.json({ status: await streamOut.stop(r.id) });
});

router.post('/:id/gfx', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const b = req.body || {};
  if (!gfx.KINDS.includes(b.kind)) return res.status(400).json({ error: 'Unknown graphic' });
  if (!String(b.a || '').trim()) return res.status(400).json({ error: 'A graphic needs its text.' });
  const q = new URLSearchParams({ a: String(b.a).slice(0, 120), b: String(b.b || '').slice(0, 200), accent: String(b.accent || '') });
  const box = gfx.BOX[b.kind];
  db.prepare('UPDATE stream_outputs SET gfx_json = ? WHERE id = ?').run(JSON.stringify({
    pip_id: crypto.randomUUID(), type: 'web', uri: `/gfx/${b.kind}?${q}`, position: box.position, keyed: true,
    width: Math.round(r.width * box.w), height: Math.round(r.height * box.h), duration: 0, opacity: 1, border_radius: 0,
  }), r.id);
  feedCache.delete(r.id);
  res.json({ success: true });
});
router.post('/:id/gfx/clear', requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  db.prepare('UPDATE stream_outputs SET gfx_json = NULL WHERE id = ?').run(r.id);
  res.json({ success: true });
});

// ── what the server's own renderer fetches ───────────────────────────────────────────────────────
const feedCache = new Map();   // id -> { at, playlist_id, payload, rev }
const viewAccess = require('../lib/view-access');
function feedFor(r) {
  const hit = feedCache.get(r.id);
  if (hit && hit.playlist_id === r.playlist_id && Date.now() - hit.at < 5000) return hit;
  let payload = { assignments: [] };
  const pl = r.playlist_id && db.prepare('SELECT * FROM playlists WHERE id = ?').get(r.playlist_id);
  if (pl && pl.workspace_id === r.workspace_id) {
    // As the Preview monitor shows it, and switched at once: a stream has no "end of this item" to wait for.
    payload = { ...require('./playlists').previewPayload(pl, r.height > r.width ? 'portrait' : 'landscape'), cut_now: true };
  }
  const entry = { at: Date.now(), playlist_id: r.playlist_id, payload, rev: viewAccess.revOf(payload) };
  feedCache.set(r.id, entry);
  return entry;
}
const bySecret = (secret) => (typeof secret === 'string' && secret.length >= 40 ? db.prepare('SELECT * FROM stream_outputs WHERE feed_secret = ?').get(secret) : null);

function renderer({ sendPlayer }) {
  const r = express.Router();
  const quiet = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); };
  r.get('/stream-render/:secret', (req, res) => {
    quiet(res);
    if (!bySecret(req.params.secret)) return res.status(404).type('text/plain').send('not found');
    sendPlayer(res, 'index.html', { viewer: { payload_url: `/api/stream-feed/${req.params.secret}`, poll_ms: 1000, fast: true } });
  });
  r.get('/api/stream-feed/:secret', (req, res) => {
    quiet(res);
    const row = bySecret(req.params.secret);
    if (!row) return res.status(404).json({ error: 'not found' });
    const f = feedFor(row);
    let graphic = null; try { graphic = row.gfx_json ? JSON.parse(row.gfx_json) : null; } catch { graphic = null; }
    const out = { rev: f.rev, server_ms: Date.now(), now_playing: [], poll_ms: 1000, gfx: graphic };
    if (req.query.rev !== f.rev) out.payload = f.payload; else out.unchanged = true;
    res.json(out);
  });
  return r;
}

module.exports = router;
module.exports.renderer = renderer;
module.exports.forgetFeed = (id) => feedCache.delete(id);
