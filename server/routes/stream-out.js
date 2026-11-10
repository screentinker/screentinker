'use strict';

/*
 * Stream outputs of the vision mixer (lib/stream-out.js): where a stream goes, and Go live / Stop.
 *
 *   GET    /api/stream-out             what is possible here, and this workspace's outputs
 *   POST   /api/stream-out             add a destination        PUT /:id   change it
 *   DELETE /api/stream-out/:id         remove it (stops it first)
 *   POST   /api/stream-out/:id/start   go live ({ standby: true }: meters and mix only, nothing sent)
 *   POST   /api/stream-out/:id/stop    GET /levels: the meters of this workspace's running outputs
 *   POST   /api/stream-out/:id/gfx     key a graphic over it    POST /:id/gfx/clear
 *   GET    /api/stream-out/recordings  this workspace's recordings
 *   POST   /api/stream-out/recordings/:name/link   a one-minute download link
 *   DELETE /api/stream-out/recordings/:name
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
function shown(mix) {
  for (const n of ['net', 'net2']) mix[n].url = audio.maskUrl(mix[n].url);
  for (const n of audio.inputNames(mix)) mix[n].noise = !!mix[n].noise;   // whether a noise print is kept, not the print
  return mix;
}
const audioOf = (row) => ({ file: bedOf(row).file, settings: mixOf(row) });

const pub = (r) => ({
  id: r.id, name: r.name, kind: r.kind, kind_label: streamOut.KINDS[r.kind] ? streamOut.KINDS[r.kind].label : r.kind,
  url: r.url || null, has_key: !!r.key_enc, playlist_id: r.playlist_id || null,
  playlist_name: r.playlist_id ? ((db.prepare('SELECT name FROM playlists WHERE id = ?').get(r.playlist_id) || {}).name || null) : null,
  width: r.width, height: r.height, fps: r.fps, bitrate_k: r.bitrate_k, record: !!r.record || !!(streamOut.KINDS[r.kind] && streamOut.KINDS[r.kind].file),
  file_only: !!(streamOut.KINDS[r.kind] && streamOut.KINDS[r.kind].file),
  graphic: !!r.gfx_json,
  // What is keyed over it, so the desk's Program monitor can show it too: the page and its box as fractions of the frame.
  graphic_on: (() => { try { const g = r.gfx_json ? JSON.parse(r.gfx_json) : null; return g && typeof g.uri === 'string' && g.uri.startsWith('/gfx/') ? { uri: g.uri, position: g.position, w: g.width / r.width, h: g.height / r.height } : null; } catch { return null; } })(),
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
    kinds: Object.entries(streamOut.KINDS).map(([kind, k]) => ({ kind, label: k.label, needs_url: !k.base && !k.file, file: !!k.file })),
    sizes: streamOut.SIZES.map(([width, height]) => ({ width, height })),
    max_level: streamOut.MAX_LEVEL,
    max_channels: audio.MAX_CHANNELS,
    // What the mixer can take in on this server: sound card inputs, and the programme's own sound
    // (which needs PulseAudio here).
    line_inputs: a.reason === 'hosted' ? [] : audio.captureDevices(),
    programme_audio: a.available ? await audio.pulse().catch(() => false) : false,
    audio_sources: a.reason === 'hosted' ? [] : db.prepare("SELECT id, filename AS name FROM content WHERE workspace_id = ? AND mime_type LIKE 'audio/%' ORDER BY LOWER(filename) LIMIT 200").all(req.workspaceId),
    outputs: rows.map(pub),
    recordings: a.reason === 'hosted' ? [] : streamOut.listRecordings(req.workspaceId),
  });
});

// ── recordings ───────────────────────────────────────────────────────────────────────────────────
// A recording is gigabytes, so the browser downloads it itself with a link, not through a session
// request: the link is a random ticket for that one file, good for a minute.
const tickets = new Map();   // ticket -> { file, name, until }
// The meters: small, and asked for several times a second by an open desk.
router.get('/levels', (req, res) => {
  const out = {};
  for (const { id } of db.prepare('SELECT id FROM stream_outputs WHERE workspace_id = ?').all(req.workspaceId)) {
    const st = streamOut.status(id);
    if (st.state !== 'off') out[id] = { state: st.state, peaks: st.audio_peaks, limiting: st.limiting, inputs_live: st.inputs_live };
  }
  res.json({ levels: out });
});
router.get('/recordings', (req, res) => res.json({ recordings: streamOut.listRecordings(req.workspaceId) }));
router.post('/recordings/:name/link', (req, res) => {
  const file = streamOut.recordingPath(req.workspaceId, req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Recording not found' });
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k);
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { file, name: req.params.name, until: Date.now() + 60000 });
  res.json({ url: `/stream-recording/${ticket}` });
});
router.delete('/recordings/:name', requireFleetWrite, (req, res) => {
  const file = streamOut.recordingPath(req.workspaceId, req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Recording not found' });
  if (streamOut.listRecordings(req.workspaceId).some((x) => x.name === req.params.name && x.recording)) return res.status(409).json({ error: 'That recording is still being written. Stop the stream first.' });
  try { fs.unlinkSync(file); } catch (e) { return res.status(500).json({ error: 'The file could not be removed.' }); }
  res.json({ success: true });
});

router.post('/', gate, requireFleetWrite, (req, res) => {
  const v = streamOut.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (db.prepare('SELECT COUNT(*) AS n FROM stream_outputs WHERE workspace_id = ?').get(req.workspaceId).n >= 20) return res.status(400).json({ error: 'That is the most stream destinations a workspace can keep.' });
  const id = crypto.randomUUID(), x = v.value;
  db.prepare(`INSERT INTO stream_outputs (id, workspace_id, name, kind, url, key_enc, width, height, fps, bitrate_k, record, feed_secret)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.workspaceId, x.name, x.kind, x.url, x.key ? secretbox.encrypt(x.key) : null, x.width, x.height, x.fps, x.bitrate_k, x.record ? 1 : 0, crypto.randomBytes(32).toString('base64url'));
  res.status(201).json(pub(mine(req, id)));
});

router.put('/:id', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (streamOut.status(r.id).state !== 'off') return res.status(409).json({ error: 'Stop the stream before changing it.' });
  const b = req.body || {};
  // An empty key field means "keep the key that is stored".
  const v = streamOut.validate({ ...r, record: !!r.record, ...b, key: b.key || 'kept' }, { needKey: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const x = v.value;
  db.prepare('UPDATE stream_outputs SET name = ?, kind = ?, url = ?, key_enc = ?, width = ?, height = ?, fps = ?, bitrate_k = ?, record = ? WHERE id = ?')
    .run(x.name, x.kind, x.url, b.key ? secretbox.encrypt(x.key) : r.key_enc, x.width, x.height, x.fps, x.bitrate_k, x.record ? 1 : 0, r.id);
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
  const standby = !!(req.body && req.body.standby === true);
  if (!r.playlist_id && !standby) return res.status(400).json({ error: 'Take a source to this stream first, so it has something to show.' });
  const key = secretbox.decrypt(r.key_enc) || '';
  if (r.key_enc && !key) return res.status(400).json({ error: 'The stored stream key can no longer be read. Enter it again.' });
  try { res.json({ status: await streamOut.start(r, key, audioOf(r), { standby }) }); }
  catch (e) { res.status(e.code === 'limit' ? 409 : 500).json({ error: e.message, code: e.code || null }); }
});

router.post('/:id/stop', requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  res.json({ status: await streamOut.stop(r.id) });
});

// The stream's sound: which audio bed (or none), the fader and mute. Live on a running stream.
router.post('/:id/audio', gate, requireFleetWrite, async (req, res) => {
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
  // A console on this server (a multichannel interface): which device, and how many of its
  // channels become strips. Set before the strips below, so a new channel can be named in the same call.
  if ('console_device' in b || 'console_count' in b) {
    const devs = audio.captureDevices();
    const device = 'console_device' in b ? (b.console_device || null) : mix.console.device;
    const dev = device ? devs.find((d) => d.device === device) : null;
    if (device && !dev) return res.status(400).json({ error: 'That sound input is not on this server.' });
    const want = 'console_count' in b ? Number(b.console_count) : (mix.console.count || (dev ? Math.min(dev.channels, 8) : 0));
    if (!Number.isInteger(want) || want < 0 || want > audio.MAX_CHANNELS) return res.status(400).json({ error: `A console brings in 0 to ${audio.MAX_CHANNELS} channels.` });
    const next = audio.cleanSettings({ ...mix, console: dev ? { device, channels: dev.channels, count: Math.min(want, dev.channels) } : null });
    for (const k of Object.keys(mix)) delete mix[k];
    Object.assign(mix, next);
  }
  const stripNames = [...audio.inputNames(mix), 'master'];
  const strips = Array.isArray(b.strips) ? b.strips : (b.strip !== undefined || b.level !== undefined || b.muted !== undefined ? [{ ...b, strip: b.strip || 'bed' }] : []);
  for (const st of strips) {
    if (!st || !stripNames.includes(st.strip)) return res.status(400).json({ error: `strip is one of: ${stripNames.join(', ')}` });
    const target = mix[st.strip];
    if (st.level !== undefined) {
      const l = Number(st.level);
      if (typeof st.level === 'string' || !Number.isFinite(l) || l < 0 || l > streamOut.MAX_LEVEL) return res.status(400).json({ error: `level is 0 to ${streamOut.MAX_LEVEL}` });
      target.level = l;
    }
    if (st.muted !== undefined) target.muted = st.muted === true;
    // The processing controls (lib/stream-dsp.js). Out-of-range values are brought into range when stored.
    if (st.eq && typeof st.eq === 'object') target.eq = { ...target.eq, ...st.eq };
    if (st.cmp && typeof st.cmp === 'object') target.cmp = { ...target.cmp, ...st.cmp };
    if (st.comp !== undefined) target.comp = st.comp;
    if (st.strip !== 'master') {
      for (const k of ['hpf', 'hpf_f', 'lpf', 'gate', 'fx', 'dly', 'trim', 'inv', 'pan', 'deess', 'chorus', 'duck']) if (st[k] !== undefined) target[k] = st[k];
      if (st.denoise !== undefined) target.denoise = st.denoise;
      if (st.label !== undefined && /^c\d+$/.test(st.strip)) target.label = String(st.label);
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
  if (b.fx && typeof b.fx === 'object') mix.fx = { ...mix.fx, ...Object.fromEntries(['decay', 'delay_ms', 'delay_fb'].filter((k) => b.fx[k] !== undefined).map((k) => [k, b.fx[k]])) };
  // The noise print of a strip: learned from what the input is carrying right now (so the stream
  // must be live and whoever is on the microphone quiet), or forgotten.
  if (b.forget_noise !== undefined) {
    if (!audio.inputNames(mix).includes(b.forget_noise)) return res.status(400).json({ error: 'No such strip.' });
    mix[b.forget_noise].noise = null;
  }
  if (b.learn_noise !== undefined) {
    if (!audio.inputNames(mix).includes(b.learn_noise)) return res.status(400).json({ error: 'No such strip.' });
    const print = await streamOut.learnNoise(r.id, b.learn_noise);
    if (!print) return res.status(409).json({ error: 'The noise can only be learned while the stream is live or on standby, and that input is connected.' });
    mix[b.learn_noise].noise = print;
    if (!mix[b.learn_noise].denoise) mix[b.learn_noise].denoise = 0.5;
  }
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

// The desk's microphone, a piece at a time: { chunk: base64 of the browser's recording, first: true on a new one },
// or { stop: true }. Only into an output that is running (live or on standby).
router.post('/:id/mic', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const b = req.body || {};
  if (b.stop === true) { streamOut.stopMic(r.id); return res.json({ success: true }); }
  if (typeof b.chunk !== 'string' || b.chunk.length > 400000 || !/^[A-Za-z0-9+/]*=*$/.test(b.chunk)) return res.status(400).json({ error: 'A piece of microphone sound is expected.' });
  if (!streamOut.pushMic(r.id, Buffer.from(b.chunk, 'base64'), b.first === true)) return res.status(409).json({ error: 'Put the stream on standby or live before opening a microphone.' });
  res.json({ success: true });
});

router.post('/:id/gfx', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const b = req.body || {};
  if (!gfx.KINDS.includes(b.kind)) return res.status(400).json({ error: 'Unknown graphic' });
  if (!String(b.a || '').trim()) return res.status(400).json({ error: 'A graphic needs its text.' });
  if (b.kind === 'countdown' && !gfx.seconds(b.a)) return res.status(400).json({ error: 'A countdown needs a time on line 1, like 5:00 or 10 (minutes).' });
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
  r.get('/stream-recording/:ticket', (req, res) => {
    quiet(res);
    const t = tickets.get(req.params.ticket);
    if (!t || t.until < Date.now() || !fs.existsSync(t.file)) return res.status(404).type('text/plain').send('This download link has expired. Ask for it again from the mixer.');
    res.download(t.file, t.name);
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
