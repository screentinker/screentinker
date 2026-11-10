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
const path = require('path');
const fs = require('fs');
const config = require('../config');

/** An audio bed must be an uploaded audio item of this workspace whose file is on this server. */
function bedOf(row) {
  if (!row.audio_content_id) return { id: null, name: null, file: null };
  const c = db.prepare('SELECT id, filename, filepath, mime_type, workspace_id FROM content WHERE id = ?').get(row.audio_content_id);
  if (!c || c.workspace_id !== row.workspace_id || !/^audio\//.test(c.mime_type || '')) return { id: null, name: null, file: null };
  const base = path.resolve(config.contentDir);
  const file = c.filepath ? path.resolve(base, path.basename(String(c.filepath))) : null;
  return { id: c.id, name: c.filename, file: file && file.startsWith(base + path.sep) && fs.existsSync(file) ? file : null };
}
const audio = require('../lib/stream-audio');
/** The mixer's strips for a row. Rows from before the mixer had only a bed level and mute. */
function mixOf(row) {
  let saved = null; try { saved = row.audio_mix ? JSON.parse(row.audio_mix) : null; } catch { saved = null; }
  return audio.cleanSettings(saved || { bed: { level: row.audio_level, muted: !!row.audio_muted } });
}
/** The strips as the desk may see them: a network feed's password is not shown. */
function shown(mix) { for (const n of ['net', 'net2']) mix[n].url = audio.maskUrl(mix[n].url); return mix; }
const audioOf = (row) => ({ file: bedOf(row).file, settings: mixOf(row) });

const pub = (r) => ({
  id: r.id, name: r.name, kind: r.kind, kind_label: streamOut.KINDS[r.kind] ? streamOut.KINDS[r.kind].label : r.kind,
  url: r.url || null, has_key: !!r.key_enc, playlist_id: r.playlist_id || null,
  playlist_name: r.playlist_id ? ((db.prepare('SELECT name FROM playlists WHERE id = ?').get(r.playlist_id) || {}).name || null) : null,
  width: r.width, height: r.height, fps: r.fps, bitrate_k: r.bitrate_k,
  graphic: !!r.gfx_json,
  audio: { content_id: bedOf(r).id, name: bedOf(r).name, level: mixOf(r).bed.level, muted: mixOf(r).bed.muted, mix: shown(mixOf(r)) },
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
    max_level: streamOut.MAX_LEVEL,
    // What the mixer can take in on this server: sound card inputs, and the programme's own sound
    // (which needs PulseAudio here).
    line_inputs: a.reason === 'hosted' ? [] : audio.captureDevices(),
    programme_audio: a.available ? await audio.pulse().catch(() => false) : false,
    audio_sources: a.reason === 'hosted' ? [] : db.prepare("SELECT id, filename AS name FROM content WHERE workspace_id = ? AND mime_type LIKE 'audio/%' ORDER BY LOWER(filename) LIMIT 200").all(req.workspaceId),
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
  try { res.json({ status: await streamOut.start(r, key, audioOf(r)) }); }
  catch (e) { res.status(e.code === 'limit' ? 409 : 500).json({ error: e.message, code: e.code || null }); }
});

router.post('/:id/stop', requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  res.json({ status: await streamOut.stop(r.id) });
});

// The stream's sound: which audio bed (or none), the fader and mute. Live on a running stream.
router.post('/:id/audio', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const b = req.body || {};
  let bedId = r.audio_content_id;
  const mix = mixOf(r);
  if ('content_id' in b) {
    if (b.content_id == null || b.content_id === '') bedId = null;
    else {
      const bed = bedOf({ ...r, audio_content_id: String(b.content_id) });
      if (!bed.id) return res.status(404).json({ error: 'That audio item is not in this workspace.' });
      if (!bed.file) return res.status(400).json({ error: 'That audio file is not stored on this server, so it cannot be mixed here.' });
      bedId = bed.id;
    }
  }
  // One strip at a time or several: { strip: 'programme' | 'bed' | 'line' | 'master', level, muted },
  // or the same fields without `strip` for the bed (how the first version of this was called).
  const strips = Array.isArray(b.strips) ? b.strips : (b.strip !== undefined || b.level !== undefined || b.muted !== undefined ? [{ ...b, strip: b.strip || 'bed' }] : []);
  for (const st of strips) {
    if (!st || ![...audio.INPUTS, 'master'].includes(st.strip)) return res.status(400).json({ error: `strip is one of: ${[...audio.INPUTS, 'master'].join(', ')}` });
    const target = mix[st.strip];
    if (st.level !== undefined) {
      const l = Number(st.level);
      if (typeof st.level === 'string' || !Number.isFinite(l) || l < 0 || l > streamOut.MAX_LEVEL) return res.status(400).json({ error: `level is 0 to ${streamOut.MAX_LEVEL}` });
      target.level = l;
    }
    if (st.muted !== undefined) target.muted = st.muted === true;
    // The processing controls (lib/stream-dsp.js). Out-of-range values are brought into range when stored.
    if (st.eq && typeof st.eq === 'object') target.eq = { ...target.eq, ...st.eq };
    if (st.strip !== 'master') {
      for (const k of ['hpf', 'gate', 'comp', 'fx']) if (st[k] !== undefined) target[k] = st[k];
      if (st.denoise !== undefined && 'denoise' in target) target.denoise = st.denoise;
    }
  }
  for (const n of ['net', 'net2']) {
    const field = n + '_url';
    if (!(field in b)) continue;
    if (b[field] == null || b[field] === '') mix[n].url = null;
    else if (typeof b[field] === 'string' && /:\*{3,}@/.test(b[field])) { /* the masked address the desk was shown: unchanged */ }
    else if (!audio.netUrl(b[field])) return res.status(400).json({ error: 'A network feed is an srt://, rtmp://, rtsp://, rtp://, udp:// or http(s):// address.' });
    else mix[n].url = audio.netUrl(b[field]);
  }
  if (b.fx && typeof b.fx === 'object' && b.fx.decay !== undefined) mix.fx = { decay: b.fx.decay };
  if ('line_device' in b) {
    if (b.line_device == null || b.line_device === '') mix.line.device = null;
    else if (!audio.captureDevices().some((d) => d.device === b.line_device)) return res.status(400).json({ error: 'That sound input is not on this server.' });
    else mix.line.device = b.line_device;
  }
  db.prepare('UPDATE stream_outputs SET audio_content_id = ?, audio_level = ?, audio_muted = ?, audio_mix = ? WHERE id = ?')
    .run(bedId, mix.bed.level, mix.bed.muted ? 1 : 0, JSON.stringify(audio.cleanSettings(mix)), r.id);
  const now = mine(req, r.id);
  streamOut.setAudio(r.id, audioOf(now));
  res.json(pub(now));
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
const lastTake = new Map();    // id -> { seq, type, ms, color }: the transition of the take that last changed it
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
    sendPlayer(res, 'index.html', { viewer: { payload_url: `/api/stream-feed/${req.params.secret}`, poll_ms: 1000, fast: true, sound: true } });
  });
  r.get('/api/stream-feed/:secret', (req, res) => {
    quiet(res);
    const row = bySecret(req.params.secret);
    if (!row) return res.status(404).json({ error: 'not found' });
    const f = feedFor(row);
    let graphic = null; try { graphic = row.gfx_json ? JSON.parse(row.gfx_json) : null; } catch { graphic = null; }
    const out = { rev: f.rev, server_ms: Date.now(), now_playing: [], poll_ms: 1000, gfx: graphic };
    const tk = lastTake.get(row.id);
    if (tk && Date.now() - tk.at < 15000) out.take = { seq: tk.seq, type: tk.type, ms: tk.ms, color: tk.color };
    if (req.query.rev !== f.rev) out.payload = f.payload; else out.unchanged = true;
    res.json(out);
  });
  return r;
}

module.exports = router;
module.exports.renderer = renderer;
module.exports.forgetFeed = (id) => feedCache.delete(id);
let takeSeq = 0;
module.exports.noteTake = (id, fx) => { if (fx) lastTake.set(id, { ...fx, seq: ++takeSeq + '-' + Date.now(), at: Date.now() }); else lastTake.delete(id); };
