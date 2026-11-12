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
const guests = require('../lib/mixer-guests');
const { resourceAccess } = require('../lib/tenancy');
const orgWebrtc = require('../lib/org-webrtc');
const running = (id) => streamOut.status(id).state !== 'off';
// Open invites outlive a restart of the server: they are kept on the output's row.
try {
  guests.restore(
    db.prepare('SELECT * FROM stream_outputs WHERE guest_invite IS NOT NULL OR guest_personal IS NOT NULL').all()
      .map((r) => { let personal = []; try { personal = JSON.parse(r.guest_personal || '[]'); } catch { personal = []; } return { outputId: r.id, workspaceId: r.workspace_id, token: r.guest_invite, until: r.guest_invite_until, personal }; }),
    { save: (id, token, until) => { try { db.prepare('UPDATE stream_outputs SET guest_invite = ?, guest_invite_until = ? WHERE id = ?').run(token, until, id); } catch { /* kept in memory only */ } },
      drop: (id) => { try { db.prepare('UPDATE stream_outputs SET guest_invite = NULL, guest_invite_until = NULL WHERE id = ?').run(id); } catch { /* already gone */ } },
      savePersonal: (id, list) => { try { db.prepare('UPDATE stream_outputs SET guest_personal = ? WHERE id = ?').run(list.length ? JSON.stringify(list) : null, id); } catch { /* kept in memory only */ } } },
  );
} catch { /* a database from before the columns: invites are kept in memory */ }
/** Whether this request may change the workspace's fleet: a read-only member sees who is in a green room, not the way in. */
function canWrite(req) {
  const ws = req.workspaceId && db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  return !!ctx && !(!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer');
}
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

const screenShare = require('../lib/screen-share');
const onScreens = (streamId) => [...screenShare._sessions.values()].filter((s) => s.system && s.streamId === streamId && !s.ended);
/** The screens following a stream, and whether each has the picture right now. */
function screensOf(streamId) {
  const live = new Map(onScreens(streamId).map((s) => [s.deviceId, s]));
  const ids = new Set([...((following.get(streamId) || new Map()).keys()), ...live.keys()]);
  return [...ids].map((id) => { const s = live.get(id); return { id, name: s ? s.deviceName : ((db.prepare('SELECT name FROM devices WHERE id = ?').get(id) || {}).name || ''), live: !!(s && s.live) }; });
}
const pub = (r) => ({
  id: r.id, name: r.name, kind: r.kind, kind_label: streamOut.KINDS[r.kind] ? streamOut.KINDS[r.kind].label : r.kind,
  url: r.url || null, has_key: !!r.key_enc, playlist_id: r.playlist_id || null,
  playlist_name: r.playlist_id ? ((db.prepare('SELECT name FROM playlists WHERE id = ?').get(r.playlist_id) || {}).name || null) : null,
  width: r.width, height: r.height, fps: r.fps, bitrate_k: r.bitrate_k, record: !!r.record || !!(streamOut.KINDS[r.kind] && streamOut.KINDS[r.kind].file),
  file_only: !!(streamOut.KINDS[r.kind] && streamOut.KINDS[r.kind].file),
  graphic: !!r.gfx_json,
  // Whether screens showing it are sent its sound too (POST /:id/screens/sound).
  screens_sound: !!r.screens_sound,
  // The screens showing this stream's picture right now (POST /:id/screens).
  on_screens: screensOf(r.id),
  // What is keyed over it, so the desk's Program monitor can show it too: the page and its box as fractions of the frame.
  graphic_on: (() => { try { const g = r.gfx_json ? JSON.parse(r.gfx_json) : null; return g && typeof g.uri === 'string' && g.uri.startsWith('/gfx/') ? { uri: g.uri, position: g.position, w: g.width / r.width, h: g.height / r.height } : null; } catch { return null; } })(),
  audio: { content_id: bedOf(r).id, name: bedOf(r).name, level: mixOf(r).bed.level, muted: mixOf(r).bed.muted, mix: shown(mixOf(r)),
    pads: mixOf(r).pad_list.map((p) => (p ? { ...p, name: bedOf({ ...r, audio_content_id: p.content_id }).name } : null)) },
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
    max_level: streamOut.MAX_LEVEL, max_pads: audio.MAX_PADS,
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
    if (st.state !== 'off') out[id] = { state: st.state, peaks: st.audio_peaks, limiting: st.limiting, inputs_live: st.inputs_live, pads: st.pads || [] };
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
  guests.revoke(r.id);
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
  try {
    const status = await streamOut.start(r, key, audioOf(r), { standby });
    // Stopped while it was starting: the Stop has forgotten it, and this must not bring it back.
    if (status.state !== 'off') remember(r.id, 'standby');
    res.json({ status });
  } catch (e) { res.status(e.code === 'limit' ? 409 : 500).json({ error: e.message, code: e.code || null }); }
});

router.post('/:id/stop', requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  // Stopped by the operator: it does not come back by itself, and its screens are let go.
  remember(r.id, null); following.delete(r.id); saveScreens(r.id);
  res.json({ status: await streamOut.stop(r.id) });
});

/*
 * ON SCREENS: show this stream's composed picture (programme, graphics, guests) on screens of the
 * workspace, over whatever they are playing, until released or the stream stops. The renderer shares
 * its own picture to each screen (lib/stream-out.js showOn, on lib/screen-share.js), so a screen
 * needs what a screen share needs: a player that can show one, online, sharing on in the workspace.
 */
// The screens that FOLLOW each stream: streamId -> Map(deviceId -> { userId }). A screen stays in it until it is
// released or the stream stops; one that reloads, drops off the network or loses the connection is given the
// picture again by itself (reconcile, below).
const following = new Map();
/*
 * ACROSS A RESTART. A stream the operator has running is brought back ON STANDBY when the server
 * starts again (an update, a crash), with the screens that followed it: never live, because sending
 * to a streaming service is the operator's decision each time. Stopping it by hand forgets it.
 */
const remember = (id, state) => { try { db.prepare('UPDATE stream_outputs SET resume_state = ? WHERE id = ?').run(state, id); } catch { /* a database from before the column */ } };
const saveScreens = (id) => { try { const set = following.get(id); db.prepare('UPDATE stream_outputs SET screens_json = ? WHERE id = ?').run(set && set.size ? JSON.stringify([...set.keys()]) : null, id); } catch { /* as above */ } };
async function resumeAll() {
  let rows = []; try { rows = db.prepare("SELECT * FROM stream_outputs WHERE resume_state IS NOT NULL").all(); } catch { return; }
  if (!rows.length) return;
  const a = await streamOut.availability().catch(() => null);
  if (!a || !a.available) return;
  for (const r of rows) {
    if (running(r.id)) continue;
    try {
      const key = secretbox.decrypt(r.key_enc) || '';
      await streamOut.start(r, key, audioOf(r), { standby: true });
      let ids = []; try { ids = JSON.parse(r.screens_json || '[]'); } catch { ids = []; }
      if (Array.isArray(ids) && ids.length) following.set(r.id, new Map(ids.filter((x) => typeof x === 'string').slice(0, 50).map((id) => [id, {}])));
      console.log(`[stream-out] "${r.name}" is back on standby after a restart${ids.length ? `, followed by ${ids.length} screen(s)` : ''}`);
    } catch (e) { console.warn(`[stream-out] "${r.name}" could not be brought back on standby: ${e.message}`); }
  }
}
// Once the server is up and its screens have had a moment to reconnect. Not in tests: they start their own streams.
if (process.env.NODE_ENV !== 'test') setTimeout(() => { resumeAll().catch(() => {}); }, 8000).unref();
/** Shares the stream's picture to these screens. Returns { shown, skipped } or { error, status, code }. */
async function putOnScreens(r, ids, by) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(r.workspace_id);
  const already = new Set(onScreens(r.id).map((s) => s.deviceId));
  const targets = [], skipped = [], shown = [];
  for (const id of ids) {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device || device.workspace_id !== r.workspace_id) { skipped.push({ device_id: id, reason: 'not_found' }); continue; }
    if (already.has(id)) { shown.push({ device_id: id, name: device.name }); continue; }
    const a = screenShare.availability(device, workspace);
    if (!a.ok) { skipped.push({ device_id: id, name: device.name, reason: a.reason }); continue; }
    targets.push({ device, workspace });
  }
  if (targets.length) {
    const out = screenShare.createShare({ targets, sharedBy: r.name, userId: by && by.userId, ip: by && by.ip, audio: !!r.screens_sound, system: true, streamId: r.id, source: 'stream' });
    if (out.error) return { status: 409, code: out.error, device_id: out.device_id || null, error: out.error === 'too_many_targets' ? `A stream can be shown on at most ${screenShare.maxTargets()} screens at once.` : 'One of those screens is showing something else that was shared to it.' };
    const legs = out.legs.map((l) => ({ device_id: l.device.id, screen_name: l.device.name || '', session_id: l.session.id, ticket: l.ticket, ice_servers: screenShare.iceServersFor(l.device.id) }));
    if (!(await streamOut.showOn(r.id, legs, '/api/screen-share/ws', { sound: !!r.screens_sound }))) {
      screenShare.stopShare(out.shareId, 'not_connected');
      return { status: 502, error: 'The stream\'s renderer could not send its picture: ' + (streamOut.shareError(r.id) || 'unknown reason') };
    }
    for (const l of out.legs) shown.push({ device_id: l.device.id, name: l.device.name });
  }
  return { shown, skipped };
}
router.post('/:id/screens', gate, requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!running(r.id)) return res.status(409).json({ error: 'Put the stream on standby or live first: there is no picture to show until it is running.', code: 'off' });
  const ids = Array.isArray((req.body || {}).device_ids) ? [...new Set(req.body.device_ids.filter((x) => typeof x === 'string'))].slice(0, 50) : [];
  if (!ids.length) return res.status(400).json({ error: 'device_ids required: choose at least one screen' });
  const by = { userId: req.user && req.user.id, ip: req.ip };
  const out = await putOnScreens(r, ids, by);
  if (out.error) return res.status(out.status).json({ error: out.error, code: out.code, device_id: out.device_id });
  // These screens follow the stream from now on: the ones showing it, and the ones that cannot take it just now
  // (offline, or showing something that was shared to them), which are given it as soon as they can.
  if (!following.has(r.id)) following.set(r.id, new Map());
  const later = out.skipped.filter((x) => x.reason === 'offline' || x.reason === 'busy');
  for (const x of [...out.shown, ...later]) following.get(r.id).set(x.device_id, by);
  saveScreens(r.id);
  // The ones that will be given it later are not refused: they are listed apart, as waiting.
  const waiting = later.map((x) => ({ ...x, waiting: true }));
  res.json({ shown: out.shown, skipped: out.skipped.filter((x) => !later.includes(x)), waiting });
});
// Release screens: all of them, or the ones named. Each gets its own content back.
router.delete('/:id/screens', requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const only = Array.isArray((req.body || {}).device_ids) ? new Set(req.body.device_ids) : null;
  const set = following.get(r.id);
  let n = 0;
  if (set) { for (const id of [...set.keys()]) if (!only || only.has(id)) { set.delete(id); n += 1; } if (!set.size) following.delete(r.id); }
  saveScreens(r.id);
  for (const s of onScreens(r.id)) if (!only || only.has(s.deviceId) || only.has(s.roomKey)) screenShare.endSession(s, 'stopped_by_owner', req.user && req.user.id);
  res.json({ released: n });
});
/*
 * A screen that follows a stream and has lost its picture (the player was reloaded, it dropped off the
 * network and came back, the connection failed) is given it again. A stream that has stopped has no
 * followers any more. One pass at a time; a screen that cannot take it now is tried again next pass.
 */
let reconciling = false;
async function reconcile() {
  if (reconciling || !following.size) return;
  reconciling = true;
  try {
    for (const [streamId, set] of [...following]) {
      if (!running(streamId)) { following.delete(streamId); continue; }      // (what is saved stays: a restart brings both back)
      const have = new Set(onScreens(streamId).map((s) => s.deviceId));
      const missing = [...set.keys()].filter((id) => !have.has(id));
      if (!missing.length) continue;
      const r = db.prepare('SELECT * FROM stream_outputs WHERE id = ?').get(streamId);
      if (!r) { following.delete(streamId); continue; }
      const out = await putOnScreens(r, missing, set.get(missing[0])).catch(() => null);
      // A screen that no longer exists stops following; the rest (offline, busy) stay and are tried again.
      const gone = ((out && out.skipped) || []).filter((k) => k.reason === 'not_found');
      for (const k of gone) set.delete(k.device_id);
      if (gone.length) { if (!set.size) following.delete(streamId); saveScreens(streamId); }
    }
  } finally { reconciling = false; }
}
setInterval(() => { reconcile().catch(() => {}); }, 4000).unref();

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
  // ...and 'guest' (what a new guest's strip starts as) and 'g:<guest id>' (a guest's own strip, while they are here).
  const stripNames = [...audio.inputNames(mix), 'master', 'guest'];
  const strips = Array.isArray(b.strips) ? b.strips : (b.strip !== undefined || b.level !== undefined || b.muted !== undefined ? [{ ...b, strip: b.strip || 'bed' }] : []);
  const touched = [];
  for (const st of strips) {
    // A strip name is looked up on the mix and written through: never a name that reaches the prototype.
    if (st && (st.strip === '__proto__' || st.strip === 'constructor' || st.strip === 'prototype')) return res.status(400).json({ error: 'Unknown strip' });
    const gm = st && typeof st.strip === 'string' ? /^g:([A-Za-z0-9_-]{1,64})$/.exec(st.strip) : null;
    const gg = gm ? guests.list(r.id).find((x) => x.id === gm[1]) : null;
    if (gm && !gg) return res.status(404).json({ error: 'That guest has left.' });
    if (!st || (!gg && !stripNames.includes(st.strip))) return res.status(400).json({ error: `strip is one of: ${stripNames.join(', ')}, or g:<guest id>` });
    const target = gg ? { ...mix.guest, ...(gg.strip || {}), level: gg.level, muted: gg.muted } : (Object.prototype.hasOwnProperty.call(mix, st.strip) ? mix[st.strip] : null);
    if (!target || typeof target !== 'object') return res.status(400).json({ error: `strip is one of: ${stripNames.join(', ')}, or g:<guest id>` });
    if (gg) touched.push([gg, target]);
    if (st.level !== undefined) {
      const l = Number(st.level);
      if (typeof st.level === 'string' || !Number.isFinite(l) || l < 0 || l > streamOut.MAX_LEVEL) return res.status(400).json({ error: `level is 0 to ${streamOut.MAX_LEVEL}` });
      target.level = l;
    }
    if (st.muted !== undefined) target.muted = st.muted === true;
    // The processing controls (lib/stream-dsp.js). Out-of-range values are brought into range when stored.
    // Only the known keys of each (lib/stream-dsp.js cleanProcessing), never whatever a body names.
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));
    if (st.eq && typeof st.eq === 'object') target.eq = { ...target.eq, ...pick(st.eq, ['low', 'lomid', 'mid', 'high', 'low_f', 'lomid_f', 'lomid_q', 'mid_f', 'mid_q', 'high_f']) };
    if (st.cmp && typeof st.cmp === 'object') target.cmp = { ...target.cmp, ...pick(st.cmp, ['on', 'thr', 'ratio', 'att', 'rel', 'gain']) };
    if (st.comp !== undefined) target.comp = st.comp;
    if (st.strip !== 'master') {
      for (const k of ['hpf', 'hpf_f', 'lpf', 'gate', 'fx', 'dly', 'trim', 'inv', 'pan', 'deess', 'chorus', 'duck']) if (st[k] !== undefined) target[k] = st[k];
      if (st.denoise !== undefined) target.denoise = st.denoise;
      if (st.label !== undefined && /^c\d+$/.test(st.strip)) target.label = String(st.label);
    }
  }
  // A guest's strip lives as long as they are here (lib/mixer-guests.js), not in the stored mix.
  for (const [gg, target] of touched) {
    const { level, muted } = target;
    // Brought into range and into shape the way every other strip is (cleanSettings): what is kept
    // goes back to every desk, so no value may be a string of a caller's choosing.
    const { level: _l, muted: _m, noise: _n, ...proc } = audio.cleanSettings({ guest: target }).guest;
    guests.setLevel(r.id, gg.id, level); guests.setMuted(r.id, gg.id, muted); guests.setStrip(r.id, gg.id, proc);
  }
  // "Use for new guests": a guest's processing becomes what every guest who comes in after starts with.
  if (b.guest_default_from !== undefined) {
    const gg = guests.list(r.id).find((x) => x.id === b.guest_default_from);
    if (!gg) return res.status(404).json({ error: 'That guest has left.' });
    mix.guest = { ...mix.guest, ...(gg.strip || {}), level: mix.guest.level, muted: false };
  }
  // The sound pads: [{ content_id, label, level, loop } | null] (at most audio.MAX_PADS). Each is an audio item of this workspace.
  if (b.pads !== undefined) {
    if (!Array.isArray(b.pads) || b.pads.length > audio.MAX_PADS) return res.status(400).json({ error: `pads is a list of at most ${audio.MAX_PADS}.` });
    for (const p of b.pads) {
      if (p == null) continue;
      if (typeof p !== 'object' || typeof p.content_id !== 'string') return res.status(400).json({ error: 'Each pad is { content_id, label, level, loop } or null.' });
      const it = bedOf({ ...r, audio_content_id: p.content_id });
      if (!it.id) return res.status(404).json({ error: 'That audio item is not in this workspace.' });
      if (!it.file) return res.status(400).json({ error: 'That audio file is not stored on this server, so it cannot be played here.' });
    }
    mix.pad_list = b.pads;
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

// A sound pad: fired (from the top, again if it is sounding) or stopped. { action: 'fire' | 'stop' }. /pads/stop stops them all.
router.post('/:id/pads/stop', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!streamOut.stopPads(r.id)) return res.status(409).json({ error: 'The stream is off.', code: 'off' });
  res.json({ success: true });
});
router.post('/:id/pads/:n', gate, requireFleetWrite, async (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const n = Number(req.params.n), pad = Number.isInteger(n) ? mixOf(r).pad_list[n] : null;
  if (!pad) return res.status(404).json({ error: 'No sound on that pad.' });
  if ((req.body || {}).action === 'stop') { if (!streamOut.stopPads(r.id, n)) return res.status(409).json({ error: 'The stream is off.', code: 'off' }); return res.json({ success: true }); }
  const it = bedOf({ ...r, audio_content_id: pad.content_id });
  if (!it.file) return res.status(400).json({ error: 'That pad\'s audio item is no longer here.' });
  const out = await streamOut.firePad(r.id, n, it.file);
  if (out.error === 'off') return res.status(409).json({ error: 'Put the stream on standby or live to play pads.', code: 'off' });
  if (out.error) return res.status(400).json({ error: 'That audio file could not be read.' });
  res.json({ success: true });
});
// Whether screens showing this stream get its sound as well as its picture. Those showing it now are given it again with the change.
router.post('/:id/screens/sound', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (typeof (req.body || {}).on !== 'boolean') return res.status(400).json({ error: 'on: true or false' });
  db.prepare('UPDATE stream_outputs SET screens_sound = ? WHERE id = ?').run(req.body.on ? 1 : 0, r.id);
  // The followers stay; their sessions end and the next pass (reconcile) shows the stream again, as it now is.
  for (const s of onScreens(r.id)) screenShare.endSession(s, 'stopped_by_owner', req.user && req.user.id);
  res.json(pub(mine(req, r.id)));
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

// ── guests (lib/mixer-guests.js) ─────────────────────────────────────────────────────────────────
// The green rooms of this workspace's outputs: who has come in by each invite, and who is on air.
router.get('/guests', (req, res) => {
  const out = {}, write = canWrite(req);
  for (const { id } of db.prepare('SELECT id FROM stream_outputs WHERE workspace_id = ?').all(req.workspaceId)) {
    // A desk that names itself (?desk=) is sent each guest's picture directly: lib/mixer-guests.js.
    const g = guests.forDesk(id, Date.now(), write && typeof req.query.desk === 'string' ? req.query.desk : null);
    if (!(g.invite || g.personal.length || g.guests.length)) continue;
    // A read-only member: who is here and who is on air, without the links in or anyone's picture.
    out[id] = write ? { ...g, invite: undefined, invite_url: g.invite ? `/guest/${g.invite}` : null, personal: g.personal.map(({ token, ...p }) => ({ ...p, url: `/guest/${token}` })) }
      : { ...g, invite: undefined, invite_url: null, expires_at: null, personal: g.personal.map(({ token, until, ...p }) => p), guests: g.guests.map((x) => ({ ...x, thumb: null })) };
  }
  res.json({ rooms: out, ice_servers: write && Object.keys(out).length ? orgWebrtc.iceServersForWorkspace(req.workspaceId) : [] });
});
// This desk's answer to a guest's offer of a picture, or (again: true) its request for a new offer.
router.post('/:id/guests/:gid/desk', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (!guests.fromDesk(r.id, req.params.gid, String(b.desk || ''), b)) return res.status(409).json({ error: 'That guest has left, or has made a new offer.' });
  res.json({ success: true });
});
router.post('/:id/guests/invite', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  res.json({ invite_url: `/guest/${guests.invite(r)}` });
});
// A link for one person, by name (lib/mixer-guests.js PERSONAL LINKS), and cancelling one.
router.post('/:id/guests/personal', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const p = guests.personal(r, (req.body || {}).name);
  if (p.error) return res.status(p.status).json({ error: p.error });
  res.json({ id: p.id, invite_url: `/guest/${p.token}` });
});
router.delete('/:id/guests/personal/:pid', requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!guests.cancelPersonal(r.id, req.params.pid)) return res.status(404).json({ error: 'That link is not open.' });
  res.json({ success: true });
});
router.delete('/:id/guests/invite', requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  guests.revoke(r.id);
  res.json({ success: true });
});
router.post('/:id/guests/layout', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!guests.setLayout(r.id, (req.body || {}).layout)) return res.status(400).json({ error: `layout is one of: ${guests.LAYOUTS.join(', ')}` });
  res.json({ success: true });
});
router.post('/:id/guests/:gid', gate, requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  const b = req.body || {};
  // Cut out (shown without their background) is set on its own or together with on air.
  if (typeof b.cut === 'boolean' && !guests.setCut(r.id, req.params.gid, b.cut)) return res.status(404).json({ error: 'That guest has left.' });
  // Their own volume in the stream, likewise.
  if (typeof b.level === 'number' && !guests.setLevel(r.id, req.params.gid, b.level)) return res.status(404).json({ error: 'That guest has left.' });
  // Their strip's mute, and whether they hear the show (without their own voice) on their page.
  if (typeof b.muted === 'boolean' && !guests.setMuted(r.id, req.params.gid, b.muted)) return res.status(404).json({ error: 'That guest has left.' });
  if (typeof b.hear === 'boolean' && !guests.setHear(r.id, req.params.gid, b.hear)) return res.status(404).json({ error: 'That guest has left.' });
  const other = ['cut', 'muted', 'hear'].some((k) => typeof b[k] === 'boolean') || typeof b.level === 'number';
  if (typeof b.on_air === 'boolean' || !other) {
    const x = guests.setOnAir(r.id, req.params.gid, b.on_air === true);
    if (!x.ok) return res.status(x.status).json({ error: x.error });
  }
  res.json({ success: true });
});
router.delete('/:id/guests/:gid', requireFleetWrite, (req, res) => {
  const r = mine(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Stream not found' });
  if (!guests.remove(r.id, req.params.gid)) return res.status(404).json({ error: 'That guest has left.' });
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
  // Self-hosted only, like everything else here: on the hosted service none of these addresses
  // exist (they only ever act on streams, invites and sessions the gated routes make, but off is off).
  r.use(['/stream-render', '/guest', '/stream-recording', '/api/stream-feed', '/api/stream-guest'], (req, res, next) => (
    config.selfHosted ? next() : res.status(404).type('text/plain').send('not found')));
  // The renderer's own page and feed are opened by this server's renderer, over loopback
  // (lib/stream-out.js localBaseUrl), and by nothing else: their secret never crosses a network.
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  r.use(['/stream-render', '/api/stream-feed'], (req, res, next) => (
    LOOPBACK.has(req.socket && req.socket.remoteAddress) ? next() : res.status(404).type('text/plain').send('not found')));
  const quiet = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); };
  r.get('/stream-render/:secret', (req, res) => {
    quiet(res);
    if (!bySecret(req.params.secret)) return res.status(404).type('text/plain').send('not found');
    sendPlayer(res, 'index.html', { viewer: { payload_url: `/api/stream-feed/${req.params.secret}`, poll_ms: 1000, fast: true, sound: true } });
  });
  // The guest's side: the page, and the four things it does. Addressed by the invite token; a
  // guest who has joined also proves who they are with the key they were given.
  r.get('/guest/:token', (req, res) => {
    quiet(res);
    // No page (and so no request for a camera) behind a link that lets nobody in.
    if (!guests.invited(req.params.token)) return res.status(404).type('text/plain').send('This invitation is no longer open. Ask for a new link.');
    res.sendFile(path.join(config.frontendDir, 'guest.html'));
  });
  const limiter = require('../lib/backstop-limiter');
  const rowOf = (inv) => db.prepare('SELECT id, name, workspace_id FROM stream_outputs WHERE id = ?').get(inv.outputId);
  r.post('/api/stream-guest/:token/join', limiter, (req, res) => {
    quiet(res);
    const j = guests.join(req.params.token, (req.body || {}).name);
    if (j.error) return res.status(j.status).json({ error: j.error });
    const row = rowOf(guests.invited(req.params.token));
    if (!row) { guests.leave(j.guest); return res.status(404).json({ error: 'This invitation is no longer open. Ask for a new link.' }); }
    res.json({ guest_id: j.guest.id, key: j.guest.key, name: j.guest.name, ice_servers: orgWebrtc.guestIceServers(orgWebrtc.orgIdForWorkspace(row.workspace_id)), ...guests.stateFor(j.guest, running(row.id)) });
  });
  const me = (req, res) => {
    quiet(res);
    const b = req.body || {};
    const g = guests.who(req.params.token, b.guest_id, b.key);
    // 410: the operator removed this guest. 404: the server no longer knows them (a restart, a long silence): the page comes in again.
    if (!g) { res.status(guests.wasRemoved(b.guest_id) ? 410 : 404).json({ error: 'gone' }); return null; }
    return g;
  };
  // What a guest's page is told: how things stand, and (when it has an offer to make) the servers to make it through, with a fresh login.
  const told = (g) => {
    const st = guests.stateFor(g, running(g.outputId));
    if (st.need_offer || st.desks.some((d) => d.need_offer)) { const row = rowOf({ outputId: g.outputId }); if (row) st.ice_servers = orgWebrtc.guestIceServers(orgWebrtc.orgIdForWorkspace(row.workspace_id)); }
    return st;
  };
  r.post('/api/stream-guest/:token/offer', limiter, (req, res) => {
    const g = me(req, res); if (!g) return;
    if (!guests.sdpOk((req.body || {}).sdp)) return res.status(400).json({ error: 'That is not a session description.' });
    if (!guests.mayOffer(g)) return res.status(429).json({ error: 'Too soon after the last offer.' });
    guests.setOffer(g, req.body.sdp);
    res.json(told(g));
  });
  r.post('/api/stream-guest/:token/desk-offer', limiter, (req, res) => {
    const g = me(req, res); if (!g) return;
    const seq = guests.setDeskOffer(g, String((req.body || {}).desk || ''), (req.body || {}).sdp);
    if (!seq) return res.status(400).json({ error: 'That desk is not here, or that is not a session description.' });
    res.json({ seq });
  });
  // POST, so the guest's key is in the body and not in anyone's access log.
  r.post('/api/stream-guest/:token/state', limiter, (req, res) => { const g = me(req, res); if (!g) return; if (typeof req.body.green === 'boolean') guests.setGreen(g, req.body.green); res.json(told(g)); });
  r.post('/api/stream-guest/:token/leave', limiter, (req, res) => { const g = me(req, res); if (g) { guests.leave(g); res.json({ success: true }); } });
  // The renderer's side: its answer to a guest, the state of that connection, a thumbnail.
  r.post('/api/stream-feed/:secret/guest', (req, res) => {
    quiet(res);
    const row = bySecret(req.params.secret);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!guests.fromRenderer(row.id, req.body || {})) return res.status(400).json({ error: 'refused' });
    res.json({ success: true });
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
    // Guests: who is in the green room, who is on air, and the offer of anyone the renderer is not yet connected to.
    if (guests.open(row.id)) out.guests = { ...guests.forRenderer(row.id, req.query.have), ice_servers: orgWebrtc.iceServersForWorkspace(row.workspace_id) };
    if (req.query.rev !== f.rev) out.payload = f.payload; else out.unchanged = true;
    res.json(out);
  });
  return r;
}

module.exports = router;
module.exports.renderer = renderer;
module.exports._resumeAll = resumeAll;
module.exports.forgetFeed = (id) => feedCache.delete(id);
let takeSeq = 0;
module.exports.noteTake = (id, fx) => { if (fx) lastTake.set(id, { ...fx, seq: ++takeSeq + '-' + Date.now(), at: Date.now() }); else lastTake.delete(id); };
