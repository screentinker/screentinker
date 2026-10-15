'use strict';

/*
 * Screen verification — proving what a panel is SHOWING, not just that its player answers.
 *
 * A player can heartbeat perfectly while the panel shows a black frame, a picture that stopped an
 * hour ago, the wrong thing, or nothing at all because the TV was switched off. Operators found
 * out when somebody complained. This module watches the screenshots players already send (the
 * dashboard asks every visible card for one every 30s), asks for an occasional one of its own at a
 * modest per-workspace cadence when nobody is looking, and keeps a verification state per screen:
 *
 *   verified | blank | frozen | unexpected | panel_off | unknown      (+ since when)
 *
 * The decisions live in ./classify.js (pure, tested exhaustively); the pixels are measured in the
 * image-ops worker (./frame-metrics.js), never on the event loop. This file is the glue: it keeps
 * a short in-memory history per screen, gathers what the screen is SUPPOSED to be showing, runs
 * the state machine, persists incidents, and sends confirmed incidents to the workspace's alert
 * channels (lib/alert-channels.js) — with the same once-per-incident ledger discipline as offline
 * alerts, and a resolve when the screen recovers.
 *
 * ⚠️ BOUNDED BY DESIGN. Every frame that reaches ingestScreenshot passes through noteFrame, which
 * includes the 1fps remote-view stream, so the expensive part is gated three ways: at most one
 * analysis per screen per MIN_GAP_MS (unless a re-check was asked for), never more than
 * MAX_WORKER_BACKLOG jobs waiting in the shared image worker, and only for workspaces that have
 * verification on. A dropped frame costs nothing: the next one will do.
 *
 * ⚠️ PRIVACY: no image is stored by this module. Frames go through the existing screenshot ingest
 * (latest-only, in memory, written to disk once when the screen goes offline) and this module
 * keeps only the numbers frame-metrics derives from them — a 64x36 luma grid at most — in memory.
 * Incidents record measurements (mean, spread, a similarity score), never pixels.
 */

const path = require('path');
const fs = require('fs');
const cl = require('./classify');

function dbOf() { return require('../../db/database').db; }

const MIN_GAP_MS = 45 * 1000;          // per-screen analysis floor; the dashboard sends every 30s
const MAX_WORKER_BACKLOG = 6;          // shared with uploads: never be the reason a thumbnail waits
const HISTORY = 12;                    // frames remembered per screen (a 32x18 grid + hash each, ~600 bytes)
const STARTS = 24;                     // play_start events remembered per screen
const MAX_REQUESTS_PER_TICK = 120;     // fleet-wide cap on screenshots we ask for per minute
const SETTINGS_TTL_MS = 30 * 1000;
const CONTEXT_TTL_MS = 60 * 1000;
const REF_CACHE_MAX = 300;
const PANEL_REPORT_FRESH_SEC = 15 * 60;
const PROBLEMS = new Set(['blank', 'frozen', 'unexpected', 'panel_off']);

const mem = new Map();                 // deviceId -> per-screen runtime state (see memFor)
const settingsCache = new Map();       // workspaceId -> { at, value }
const refCache = new Map();            // contentId -> { v, metrics }
let requester = null;                  // (deviceId) => boolean — wired by ws/deviceSocket
let emitter = null;                    // (deviceId, payload) => void — the dashboard event
let timer = null;
let lastPrune = 0;
let imageOpsOverride = null;           // tests

function imageOps() { return imageOpsOverride || require('../image-ops'); }

function memFor(deviceId) {
  let m = mem.get(deviceId);
  if (!m) {
    m = { history: [], starts: [], lastAnalyzedMs: 0, inflight: false, recheckAt: 0, lastRequestAt: 0,
      display: null, panel: null, ctx: null, ctxAt: 0, sched: null, schedAt: 0 };
    mem.set(deviceId, m);
  }
  return m;
}

/* ============================== settings ============================== */

function settingsFor(workspaceId, db = dbOf()) {
  if (!workspaceId) return cl.presentSettings(null);
  const c = settingsCache.get(workspaceId);
  if (c && Date.now() - c.at < SETTINGS_TTL_MS) return c.value;
  let row = null;
  try { row = db.prepare('SELECT * FROM screen_verification_settings WHERE workspace_id = ?').get(workspaceId); } catch { /* table missing in a bare fixture */ }
  const value = cl.presentSettings(row);
  settingsCache.set(workspaceId, { at: Date.now(), value });
  return value;
}

function invalidateSettings(workspaceId) { settingsCache.delete(workspaceId); }

/* ============================== inputs from the device socket ============================== */

/** A play_start the player reported. Feeds "the player says it moved on" freeze evidence. */
function notePlayStart(deviceId, { content_id, widget_id, zone_id } = {}, atMs = Date.now()) {
  if (!deviceId) return;
  const m = memFor(deviceId);
  m.starts.push({ key: itemKey(content_id, widget_id), content_id: content_id || null, widget_id: widget_id || null, zone_id: zone_id || null, at: atMs });
  if (m.starts.length > STARTS) m.starts.splice(0, m.starts.length - STARTS);
  m.ctx = null;   // the expected item changed
}

/** display_on / display_off from the player's own OS (Android, the native Pi/Windows player, Tizen). */
function noteDisplayEvent(deviceId, type, reason, atSec = Math.floor(Date.now() / 1000)) {
  if (!deviceId || (type !== 'display_on' && type !== 'display_off')) return;
  memFor(deviceId).display = { power: type === 'display_off' ? 'off' : 'on', reason: reason || null, at: atSec };
}

/*
 * A panel state report: telemetry.panel / device_info.panel = { power, input, input_ok, source }.
 * Modelled now so a player that CAN ask the panel (HDMI-CEC power status, RS-232, DDC/CI) has a
 * field to put it in; no shipping player sends it yet, and the dashboard says "not reporting".
 * Every value is device-supplied and rendered in the dashboard, so it is whitelisted or capped.
 */
function notePanelReport(deviceId, panel) {
  if (!deviceId || !panel || typeof panel !== 'object') return;
  const power = ['on', 'off', 'standby'].includes(panel.power) ? panel.power : null;
  const input = typeof panel.input === 'string' ? panel.input.replace(/[^\w .:/-]/g, '').trim().slice(0, 32) || null : null;
  const source = ['cec', 'rs232', 'ddc', 'os', 'vendor'].includes(panel.source) ? panel.source : null;
  const inputOk = typeof panel.input_ok === 'boolean' ? panel.input_ok : null;
  if (!power && !input) return;
  const at = Math.floor(Date.now() / 1000);
  memFor(deviceId).panel = { power, input, input_ok: inputOk, source, at };
  try {
    dbOf().prepare(`INSERT INTO screen_verification_state (device_id, workspace_id, panel_power, panel_input, panel_source, panel_at)
        VALUES (?, (SELECT workspace_id FROM devices WHERE id = ?), ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET panel_power = excluded.panel_power, panel_input = excluded.panel_input,
        panel_source = excluded.panel_source, panel_at = excluded.panel_at`).run(deviceId, deviceId, power, input, source, at);
  } catch { /* best effort */ }
}

/*
 * A genuine reconnect: whatever we believed about the panel and the picture before is stale. An
 * Android player that restarts with the screen on never sends display_on, so a display_off from
 * before the restart would otherwise read as "panel off" for ever.
 */
function noteReconnect(deviceId) {
  const m = mem.get(deviceId);
  if (!m) return;
  m.display = null;
  m.history = [];
  m.ctx = null;
}

/*
 * The screen went offline. Offline alerts take over from here, so an open verification incident
 * is closed (reason 'offline') rather than left to page alongside them — and its channels are told
 * it is no longer being watched, so a PagerDuty incident does not hang open.
 */
function noteOffline(deviceId) {
  const m = mem.get(deviceId);
  if (m) { m.history = []; m.display = null; m.ctx = null; m.recheckAt = 0; }
  try {
    const db = dbOf();
    const row = db.prepare('SELECT * FROM screen_verification_state WHERE device_id = ?').get(deviceId);
    if (!row) return;
    const now = Math.floor(Date.now() / 1000);
    if (row.open_incident_id) {
      const inc = db.prepare('SELECT * FROM screen_verification_incidents WHERE id = ?').get(row.open_incident_id);
      if (inc && !inc.resolved_at) {
        if (inc.confirmed_at) db.prepare("UPDATE screen_verification_incidents SET resolved_at = ?, resolved_reason = 'offline' WHERE id = ?").run(now, inc.id);
        else db.prepare('DELETE FROM screen_verification_incidents WHERE id = ?').run(inc.id);
      }
    }
    db.prepare("UPDATE screen_verification_state SET state = 'unknown', state_since = ?, open_incident_id = NULL, detail = NULL, updated_at = ? WHERE device_id = ?")
      .run(now, now, deviceId);
  } catch { /* best effort */ }
}

/**
 * Every screenshot, from whatever carried it (ws/deviceSocket ingestScreenshot). Synchronous and
 * cheap: decides whether this frame is worth analysing and hands the bytes to the worker.
 */
function noteFrame(deviceId, imageB64, nowMs = Date.now()) {
  if (!deviceId || typeof imageB64 !== 'string') return false;
  const m = memFor(deviceId);
  if (m.inflight) return false;
  const recheckDue = m.recheckAt && nowMs >= m.recheckAt * 1000;
  if (!recheckDue && nowMs - m.lastAnalyzedMs < MIN_GAP_MS) return false;
  let device;
  try { device = dbOf().prepare('SELECT id, workspace_id, status FROM devices WHERE id = ?').get(deviceId); } catch { return false; }
  if (!device || !device.workspace_id) return false;
  if (isCopiedWorkspace(device.workspace_id)) return false;   // the primary that owns it verifies it
  const settings = settingsFor(device.workspace_id);
  if (!settings.enabled) return false;
  try { if (imageOps().pending() >= MAX_WORKER_BACKLOG) return false; } catch { return false; }
  m.inflight = true;
  m.lastAnalyzedMs = nowMs;
  m.recheckAt = 0;
  const buf = Buffer.from(imageB64, 'base64');
  analyse(device, buf, settings, nowMs)
    .catch((e) => { if (process.env.NODE_ENV !== 'test') console.warn(`[screen-verify] ${deviceId}: ${e && e.message}`); })
    .finally(() => { m.inflight = false; });
  return true;
}

/* ============================== what SHOULD be on screen ============================== */

function itemKey(contentId, widgetId) {
  if (contentId) return `c:${contentId}`;
  if (widgetId) return `w:${widgetId}`;
  return null;
}

/*
 * The screen's own loop, flattened one level (nesting depth is capped at 1 — playlist-nesting.js).
 * { keys: Set, visualItems, maxDurationSec, durations: Map(key -> sec) } or null with no playlist.
 */
function playlistInfo(db, deviceId) {
  let pl;
  try { pl = db.prepare('SELECT playlist_id FROM device_resolved_playlist WHERE device_id = ?').get(deviceId); } catch { return null; }
  if (!pl || !pl.playlist_id) return null;
  const q = db.prepare(`SELECT pi.content_id, pi.widget_id, pi.child_playlist_id, pi.duration_sec,
      c.mime_type, c.remote_url, c.duration_sec AS cdur
    FROM playlist_items pi LEFT JOIN content c ON c.id = pi.content_id
    WHERE pi.playlist_id = ? AND COALESCE(pi.enabled, 1) = 1 ORDER BY pi.sort_order`);
  const rows = [];
  for (const r of q.all(pl.playlist_id)) {
    if (r.child_playlist_id) rows.push(...q.all(r.child_playlist_id).filter((x) => !x.child_playlist_id));
    else rows.push(r);
  }
  const keys = new Set();
  const durations = new Map();
  let visualItems = 0, maxDurationSec = 0;
  for (const r of rows) {
    const key = itemKey(r.content_id, r.widget_id);
    if (!key) continue;
    const kind = cl.itemKind({ mime_type: r.mime_type, remote_url: r.remote_url, widget_id: r.widget_id });
    if (String(r.mime_type || '').startsWith('audio/')) continue;
    keys.add(key);
    const dur = Math.max(Number(r.duration_sec) || 0, kind === 'video' ? Number(r.cdur) || 0 : 0) || 10;
    durations.set(key, Math.max(durations.get(key) || 0, dur));
    visualItems++;
    if (dur > maxDurationSec) maxDurationSec = dur;
  }
  return { playlistId: pl.playlist_id, keys, durations, visualItems, maxDurationSec };
}

/* Is the zone this item played in the whole screen, on its own? */
function zoneIsFullScreen(db, zoneId) {
  if (!zoneId) return true;
  try {
    const z = db.prepare('SELECT layout_id, x_percent, y_percent, width_percent, height_percent FROM layout_zones WHERE id = ?').get(zoneId);
    if (!z) return false;
    const n = db.prepare('SELECT COUNT(*) AS n FROM layout_zones WHERE layout_id = ?').get(z.layout_id).n;
    return n === 1 && z.x_percent <= 0.5 && z.y_percent <= 0.5 && z.width_percent >= 99.5 && z.height_percent >= 99.5;
  } catch { return false; }
}

function contentRow(db, contentId, workspaceId) {
  if (!contentId) return null;
  try {
    const c = db.prepare('SELECT id, workspace_id, mime_type, remote_url, duration_sec, thumbnail_path, filepath, updated_at FROM content WHERE id = ?').get(contentId);
    // A play_start id is the player's word. Only this workspace's own content is ever used as a
    // reference, so a forged id cannot make us decode — or compare against — another tenant's file.
    if (!c || (c.workspace_id && c.workspace_id !== workspaceId)) return null;
    return c;
  } catch { return null; }
}

/* The expected item for a frame, from the player's own play_start reports. */
function expectedContext(db, device, m, nowMs) {
  if (m.ctx && nowMs - m.ctxAt < CONTEXT_TTL_MS) return m.ctx;
  const nowPlaying = require('../now-playing');
  const zones = nowPlaying.forDevice(device.id);
  const pl = playlistInfo(db, device.id);
  let wall = false;
  try { wall = !!db.prepare('SELECT 1 FROM video_wall_devices WHERE device_id = ?').get(device.id); } catch { /* no walls table */ }
  let current = null;
  if (zones.length) {
    const latest = zones.slice().sort((a, b) => b.started_ms - a.started_ms)[0];
    const key = itemKey(latest.content_id, latest.widget_id);
    const c = contentRow(db, latest.content_id, device.workspace_id);
    const kind = latest.content_id
      ? (c ? cl.itemKind(c) : 'other')
      : (latest.widget_id ? 'widget' : 'none');
    const durationSec = (pl && pl.durations.get(key)) || (c && kind === 'video' ? Number(c.duration_sec) || 0 : 0) || 0;
    current = {
      key, kind, content: c, startedMs: latest.started_ms, durationSec,
      fullScreen: zones.length === 1 && zoneIsFullScreen(db, latest.zone_id),
      wall, inPlaylist: !!(pl && key && pl.keys.has(key)),
    };
  }
  // The item before this one, so a frame that is a beat behind is not "unexpected".
  let previous = null;
  if (current) {
    for (let i = m.starts.length - 1; i >= 0; i--) {
      const s = m.starts[i];
      if (s.key && s.key !== current.key) { previous = contentRow(db, s.content_id, device.workspace_id); break; }
    }
  }
  m.ctx = { current, previous, playlist: pl };
  m.ctxAt = nowMs;
  return m.ctx;
}

/*
 * The reference picture for an image item: its thumbnail if one exists on local disk, else the
 * file itself when it is a local image. Nothing remote is fetched — content in object storage
 * simply has no reference, and the "unexpected" check stays silent for it.
 */
async function referenceFor(content) {
  if (!content || content.remote_url) return null;
  if (cl.itemKind(content) !== 'image') return null;
  const v = `${content.updated_at || 0}`;
  const hit = refCache.get(content.id);
  if (hit && hit.v === v) return hit.metrics;
  const config = require('../../config');
  const candidates = [content.thumbnail_path, content.filepath].filter(Boolean).map((p) => path.join(config.contentDir, path.basename(p)));
  let metrics = null;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 15 * 1024 * 1024) continue;
      metrics = await imageOps().frameMetrics(p);
      if (metrics && metrics.width >= 64 && metrics.height >= 36) break;
      metrics = null;
    } catch { metrics = null; }
  }
  if (refCache.size >= REF_CACHE_MAX) refCache.delete(refCache.keys().next().value);
  refCache.set(content.id, { v, metrics });
  return metrics;
}

/* ============================== power schedule ============================== */

function scheduledOff(db, deviceId, m, nowMs = Date.now()) {
  if (m.schedAt && nowMs - m.schedAt < 60 * 1000) return m.sched;
  let off = false;
  try {
    const sched = require('../device-power-schedule').powerScheduleForDevice(db, deviceId);
    off = !!(sched && sched.enabled && require('../power-window').isOff(sched, new Date(nowMs)));
  } catch { off = false; }
  m.sched = off; m.schedAt = nowMs;
  return off;
}

/* ============================== one frame ============================== */

async function analyse(device, buf, settings, nowMs) {
  const db = dbOf();
  const m = memFor(device.id);
  const metrics = await imageOps().frameMetrics(buf);
  const nowSec = Math.floor(nowMs / 1000);

  // Asleep on purpose: the native player paints black and Android turns the backlight off.
  if (scheduledOff(db, device.id, m, nowMs)) {
    record(db, device, { unknown: true, at: nowSec, scheduled: true }, settings);
    return { verdict: 'unknown', reason: 'scheduled_off' };
  }
  const ctx = expectedContext(db, device, m, nowMs);
  const current = ctx.current;
  const reference = current && current.content ? await referenceFor(current.content) : null;
  const previousReference = ctx.previous ? await referenceFor(ctx.previous) : null;

  const v = cl.judgeFrame(metrics, { level: settings.sensitivity, current, reference, previousReference, nowMs });
  /*
   * Spaced history. While a dashboard is open a frame arrives every 30s, and twelve of those would
   * span six minutes — too short to ever see a freeze that has to outlast the persistence window.
   * So an UNCHANGED frame closer than a quarter of that window to the one before the newest
   * replaces the newest instead of pushing the oldest out. A frame that differs is always kept:
   * a change is the evidence of movement, and thinning it away would let a two-item loop sampled
   * at the wrong rhythm alias into a "frozen" one.
   */
  // Labelled with the item only once it has been on screen a few seconds: a capture taken during a
  // transition can still show the previous item, and a mislabel is exactly what freeze rule (A)
  // would read as "the player moved on and the picture did not".
  const settled = current && current.startedMs && nowMs - current.startedMs >= 4000;
  const entry = { at: nowMs, metrics: { grid: cl.shrinkGrid(metrics.grid), hash: metrics.hash }, itemKey: settled ? current.key : null };
  const spacingMs = Math.max(60 * 1000, (settings.persist_minutes * 60 * 1000) / 4);
  const h0 = m.history;
  const newest = h0[h0.length - 1];
  if (h0.length >= 2 && nowMs - h0[h0.length - 2].at < spacingMs && newest.itemKey === entry.itemKey
    && cl.sameFrame(newest.metrics, entry.metrics, settings.sensitivity)) h0[h0.length - 1] = entry;
  else h0.push(entry);
  if (h0.length > HISTORY) h0.splice(0, h0.length - HISTORY);

  let obs;
  if (v.verdict === 'unknown') {
    obs = { unknown: true, at: nowSec, reason: v.detail.reason };
  } else if (v.verdict === 'blank' || v.verdict === 'unexpected') {
    obs = { kind: v.verdict, scope: 'frame', at: nowSec, detail: v.detail };
  } else {
    const fr = cl.evaluateFreeze(m.history, {
      level: settings.sensitivity, persistSec: settings.persist_minutes * 60, playlist: ctx.playlist, current,
      startsDuring: (from, to) => m.starts.filter((s) => s.at > from && s.at <= to && s.key).length,
    });
    obs = fr.frozen
      ? { kind: 'frozen', scope: 'frame', at: nowSec, since: Math.floor(fr.sinceMs / 1000), detail: { reason: fr.reason, frames: fr.frames } }
      : { kind: null, scope: 'frame', at: nowSec };
    // Two identical frames on a screen that should be moving: look again before the cadence would.
    const h = m.history;
    if (!fr.frozen && h.length >= 2 && ctx.playlist && ctx.playlist.visualItems >= 2
      && cl.sameFrame(h[h.length - 2].metrics, h[h.length - 1].metrics, settings.sensitivity)) {
      // Randomised, so repeated looks do not keep landing on the same beat of a short loop.
      const base = Math.max(60, Math.floor((settings.persist_minutes * 60) / 3));
      m.recheckAt = nowSec + base + Math.floor(Math.random() * (base / 2));
    }
  }
  record(db, device, obs, settings);
  return { verdict: obs.unknown ? 'unknown' : (obs.kind || 'ok'), metrics };
}

/* ============================== the state machine, persisted ============================== */

function loadState(db, deviceId) {
  const row = db.prepare('SELECT * FROM screen_verification_state WHERE device_id = ?').get(deviceId) || null;
  let open = null;
  if (row && row.open_incident_id) {
    const inc = db.prepare('SELECT * FROM screen_verification_incidents WHERE id = ? AND resolved_at IS NULL').get(row.open_incident_id);
    if (inc) open = { id: inc.id, kind: inc.kind, openedAt: inc.opened_at, confirmedAt: inc.confirmed_at, count: inc.observations, goodStreak: inc.good_streak, lastSeenAt: inc.last_seen_at };
  }
  return { row, open };
}

/**
 * Apply one observation: run the state machine, write what it decided, and tell the dashboard
 * when the screen's displayed state changed. Exported for tests (via _record).
 */
function record(db, device, obs, settings) {
  const now = obs.at || Math.floor(Date.now() / 1000);
  const { row, open } = loadState(db, device.id);
  const prevState = row && row.workspace_id === device.workspace_id ? row.state : 'unknown';
  const m = memFor(device.id);

  const tx = db.transaction(() => {
    if (!row) db.prepare('INSERT OR IGNORE INTO screen_verification_state (device_id, workspace_id, state, state_since) VALUES (?, ?, ?, ?)').run(device.id, device.workspace_id, 'unknown', now);
    if (obs.unknown) {
      // Scheduled sleep is shown as "panel off (scheduled)" and never raises an incident; one that
      // was already open when the schedule began is closed, since the dark screen is now intended.
      if (obs.scheduled) {
        if (open && open.confirmedAt) db.prepare("UPDATE screen_verification_incidents SET resolved_at = ?, resolved_reason = 'scheduled' WHERE id = ?").run(now, open.id);
        else if (open) db.prepare('DELETE FROM screen_verification_incidents WHERE id = ?').run(open.id);
        const wasScheduled = prevState === 'panel_off' && (safeJson(row && row.detail) || {}).scheduled;
        setState(db, device, 'panel_off', wasScheduled ? (row && row.state_since) || now : now, { scheduled: true }, null, now, null);
        m.recheckAt = 0;
      } else {
        db.prepare('UPDATE screen_verification_state SET last_check_at = ?, last_verdict = ?, workspace_id = ?, updated_at = ? WHERE device_id = ?')
          .run(now, obs.reason || 'unknown', device.workspace_id, now, device.id);
      }
      return;
    }
    const { state: next, actions } = cl.step({ open }, obs, { persistSec: settings.persist_minutes * 60 });
    let openId = open ? open.id : null;
    for (const a of actions) {
      if (a.type === 'discard' && openId) { db.prepare('DELETE FROM screen_verification_incidents WHERE id = ?').run(openId); openId = null; }
      if (a.type === 'resolve' && openId) {
        db.prepare('UPDATE screen_verification_incidents SET resolved_at = ?, resolved_reason = ? WHERE id = ?').run(now, a.reason, openId);
        openId = null;
      }
      if (a.type === 'open') {
        const info = db.prepare(`INSERT INTO screen_verification_incidents (device_id, workspace_id, kind, detail, opened_at, last_seen_at, observations)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(device.id, device.workspace_id, a.kind, JSON.stringify(obs.detail || {}).slice(0, 2000), next.open.openedAt, now, next.open.count);
        openId = Number(info.lastInsertRowid);
      }
    }
    if (next.open && openId) {
      db.prepare('UPDATE screen_verification_incidents SET observations = ?, good_streak = ?, last_seen_at = ?, confirmed_at = ? WHERE id = ?')
        .run(next.open.count, next.open.goodStreak || 0, next.open.lastSeenAt || now, next.open.confirmedAt || null, openId);
    }

    // What the screen is displayed as. Only a CONFIRMED incident is ever shown as a problem.
    const prevSince = (row && row.state_since) || now;
    const prevDetail = row && row.detail ? safeJson(row.detail) : null;
    let state, since, detail;
    const confirmed = next.open && next.open.confirmedAt ? next.open : null;
    if (confirmed) {
      state = confirmed.kind; since = confirmed.openedAt;
      detail = obs.kind === confirmed.kind ? (obs.detail || null) : (prevState === confirmed.kind ? prevDetail : null);
    } else if (obs.scope === 'frame' && !obs.kind && !(next.open && next.open.kind === 'panel_off')) {
      state = 'verified'; since = prevState === 'verified' ? prevSince : now; detail = null;
    } else if (PROBLEMS.has(prevState)) {
      // The problem it showed is gone (or not yet re-confirmed as something else): say so honestly.
      state = 'unknown'; since = now; detail = null;
    } else {
      state = prevState; since = prevSince; detail = prevDetail;
    }
    setState(db, device, state, since, detail, next.open ? openId : null, now, obs.scope === 'frame' ? (obs.kind || 'ok') : null);

    // Re-checks: confirm a suspicion quickly, and notice a recovery without waiting for the cadence.
    const persist = settings.persist_minutes * 60;
    if (next.open && !next.open.confirmedAt) m.recheckAt = now + Math.max(60, Math.floor(persist / 3));
    else if (next.open && next.open.goodStreak > 0) m.recheckAt = now + 60;
    else if (next.open) m.recheckAt = now + Math.min(600, Math.max(120, Math.floor(persist / 2)));
  });
  tx();
}

function setState(db, device, state, since, detail, openId, now, verdict) {
  const prev = db.prepare('SELECT state, state_since FROM screen_verification_state WHERE device_id = ?').get(device.id);
  db.prepare(`UPDATE screen_verification_state SET state = ?, state_since = ?, detail = ?, open_incident_id = ?, workspace_id = ?,
      last_check_at = CASE WHEN ? IS NULL THEN last_check_at ELSE ? END,
      last_verdict = COALESCE(?, last_verdict), updated_at = ? WHERE device_id = ?`)
    .run(state, since, detail ? JSON.stringify(detail).slice(0, 2000) : null, openId, device.workspace_id,
      verdict, now, verdict, now, device.id);
  if (!prev || prev.state !== state || prev.state_since !== since) {
    try { if (emitter) emitter(device.id, { device_id: device.id, state, since, detail: detail || null }); } catch { /* best effort */ }
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/* ============================== the minute tick ============================== */

function isCopiedWorkspace(workspaceId) {
  try { return !!dbOf().prepare('SELECT 1 FROM workspaces WHERE id = ? AND origin_node_id IS NOT NULL').get(workspaceId); } catch { return false; }
}

/* The panel's power, best source first: a fresh panel report, then the player's OS events. */
function panelPower(m, nowSec) {
  if (m.panel && m.panel.power && nowSec - m.panel.at <= PANEL_REPORT_FRESH_SEC) return { power: m.panel.power, source: m.panel.source || 'panel' };
  if (m.display) return { power: m.display.power, source: 'os', at: m.display.at };
  return null;
}

/**
 * One pass, every minute: the panel checks, the verification screenshots we ask for, and the
 * alert deliveries. `localRowsSql`: the replica filter, as the other sweeps use it.
 */
async function tick({ db = dbOf(), now = Math.floor(Date.now() / 1000), localRowsSql = defaultLocalRows } = {}) {
  let devices;
  try {
    devices = db.prepare(`SELECT d.* FROM devices d WHERE d.status = 'online' AND d.workspace_id IS NOT NULL AND ${localRowsSql('d')}`).all();
  } catch { return { requested: 0, sent: 0 }; }
  const caps = require('../player-capabilities');
  let requested = 0;
  // Oldest-checked first, so a capped tick is fair across the fleet rather than starving the tail.
  // One read of every state row up front, so a quiet screen costs no query and no write per tick.
  const known = new Map();
  try {
    for (const r of db.prepare(`SELECT s.device_id, s.last_check_at, s.state, s.detail, i.kind AS open_kind
        FROM screen_verification_state s LEFT JOIN screen_verification_incidents i ON i.id = s.open_incident_id AND i.resolved_at IS NULL`).all()) {
      known.set(r.device_id, r);
    }
  } catch { /* */ }
  const lastCheckOf = (id) => (known.get(id) && known.get(id).last_check_at) || 0;
  devices.sort((a, b) => lastCheckOf(a.id) - lastCheckOf(b.id));

  for (const d of devices) {
    const settings = settingsFor(d.workspace_id, db);
    if (!settings.enabled) continue;
    const m = memFor(d.id);
    const sleeping = scheduledOff(db, d.id, m, now * 1000);
    const k = known.get(d.id) || null;
    const shownScheduled = !!(k && k.state === 'panel_off' && (safeJson(k.detail) || {}).scheduled);
    const panelIncident = !!(k && (k.open_kind === 'panel_off' || (k.state === 'panel_off' && !shownScheduled)));

    // Panel power. Written only when it changes something: an "on" report on a screen with no
    // panel incident is the normal case and costs nothing.
    const p = panelPower(m, now);
    if (sleeping) {
      if (!shownScheduled || (k && k.open_kind)) record(db, d, { unknown: true, at: now, scheduled: true }, settings);
    } else if (p && (p.power === 'off' || p.power === 'standby')) {
      record(db, d, { kind: 'panel_off', scope: 'panel', at: now, since: p.at, detail: { source: p.source, power: p.power } }, settings);
    } else if (p && p.power === 'on') {
      if (panelIncident || shownScheduled) record(db, d, { kind: null, scope: 'panel', at: now }, settings);
    } else if (shownScheduled) {
      // No panel signal at all: a scheduled-off state that just ended must not linger.
      setState(db, d, 'unknown', now, null, null, now, null);
    }

    // Verification screenshots: a re-check that is due, or the cadence. Never while asleep.
    if (sleeping || !requester || requested >= MAX_REQUESTS_PER_TICK) continue;
    if (!caps.supports(d, 'remote.screenshot')) continue;
    const last = Math.max(lastCheckOf(d.id), Math.floor(m.lastAnalyzedMs / 1000));
    const recheckDue = m.recheckAt && now >= m.recheckAt;
    const cadence = settings.cadence_minutes * 60;
    const cadenceDue = cadence > 0 && now - last >= cadence + jitter(d.id, cadence);
    if (!recheckDue && !cadenceDue) continue;
    if (now - m.lastRequestAt < 50) continue;
    m.lastRequestAt = now;
    try { if (requester(d.id)) requested++; } catch { /* best effort */ }
  }

  // Safety net: a screen marked offline by any path other than the socket's offline applier (the
  // heartbeat sweep, a mesh relay) must not keep an incident open — offline alerts own that screen now.
  try {
    for (const r of db.prepare(`SELECT s.device_id FROM screen_verification_state s JOIN devices d ON d.id = s.device_id
        WHERE s.open_incident_id IS NOT NULL AND d.status != 'online' AND ${localRowsSql('d')}`).all()) noteOffline(r.device_id);
  } catch { /* best effort */ }

  let sent = 0;
  try { sent = await deliverAlerts(db, now, localRowsSql); } catch (e) { console.warn(`[screen-verify] alert delivery failed: ${e && e.message}`); }
  if (now - lastPrune > 3600) { lastPrune = now; prune(db, now); }
  return { requested, sent };
}

/* Spread the fleet over the cadence instead of asking every screen in the same minute. */
function jitter(deviceId, cadence) {
  let h = 0;
  for (let i = 0; i < deviceId.length; i++) h = (h * 31 + deviceId.charCodeAt(i)) >>> 0;
  return h % Math.max(60, Math.floor(cadence / 4));
}

function defaultLocalRows(alias) { return require('../replica-proxy').LOCAL_ROWS_SQL(alias); }

/* ============================== alerts ============================== */

const MAX_ATTEMPTS = 3;

async function deliverAlerts(db, now, localRowsSql) {
  const ch = require('../alert-channels');
  let channels;
  try { channels = db.prepare('SELECT * FROM alert_channels WHERE enabled = 1').all(); } catch { return 0; }
  channels = channels.filter((c) => { const ev = ch.parseEvents(c.events); return ev.includes('screen_problem') || ev.includes('screen_ok'); });
  if (!channels.length) return 0;
  let sent = 0;
  const url = ch.dashboardUrl();
  const wsName = new Map();
  const nameOf = (id) => { if (!wsName.has(id)) wsName.set(id, (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id) || {}).name || ''); return wsName.get(id); };

  for (const c of channels) {
    const events = ch.parseEvents(c.events);
    const settings = settingsFor(c.workspace_id, db);
    // A channel that answered 429 gets nothing more this pass (lib/alert-channels tick, the same rule).
    let limited = false;
    if (events.includes('screen_problem') && settings.enabled) {
      // Confirmed, still open, a check this workspace alerts on, the device still in this workspace.
      const rows = db.prepare(`SELECT i.*, d.name AS device_name FROM screen_verification_incidents i
          JOIN devices d ON d.id = i.device_id
        WHERE i.workspace_id = ? AND d.workspace_id = i.workspace_id AND i.confirmed_at IS NOT NULL AND i.resolved_at IS NULL
          AND d.status = 'online' AND ${localRowsSql('d')}`).all(c.workspace_id);
      for (const inc of rows) {
        if (limited) break;
        if (!settings.alert_checks.includes(inc.kind)) continue;
        if (!ch.inScope(db, c.id, inc.device_id)) continue;
        const del = db.prepare('SELECT * FROM screen_verification_deliveries WHERE channel_id = ? AND incident_id = ?').get(c.id, inc.id);
        if (del && (del.problem_sent_at || del.attempts >= MAX_ATTEMPTS)) continue;
        const r = await ch.deliver(ch.buildMessage(c, {
          event: 'screen_problem', device: { id: inc.device_id, name: inc.device_name }, check: inc.kind,
          minutes: Math.max(0, Math.floor((now - inc.opened_at) / 60)), workspace: { name: nameOf(c.workspace_id) }, dashboardUrl: url,
          dedupKey: `screentinker-verify-${inc.device_id}-${inc.id}`, nowIso: new Date(now * 1000).toISOString(),
        }));
        db.prepare(`INSERT INTO screen_verification_deliveries (channel_id, incident_id, problem_sent_at, attempts) VALUES (?, ?, ?, 1)
          ON CONFLICT(channel_id, incident_id) DO UPDATE SET problem_sent_at = excluded.problem_sent_at, attempts = screen_verification_deliveries.attempts + 1`)
          .run(c.id, inc.id, r.ok ? now : null);
        ch.recordResult(db, c, r, now);
        if (r.ok) sent++;
        if (r.rateLimited) limited = true;
      }
    }
    if (events.includes('screen_ok') && !limited) {
      // Resolved after a problem alert went out on THIS channel: tell it, once.
      const rows = db.prepare(`SELECT i.*, d.name AS device_name FROM screen_verification_deliveries x
          JOIN screen_verification_incidents i ON i.id = x.incident_id
          JOIN devices d ON d.id = i.device_id
        WHERE x.channel_id = ? AND x.problem_sent_at IS NOT NULL AND x.ok_sent_at IS NULL AND x.ok_attempts < ?
          AND i.resolved_at IS NOT NULL AND ${localRowsSql('d')}`).all(c.id, MAX_ATTEMPTS);
      for (const inc of rows) {
        if (limited) break;
        const r = await ch.deliver(ch.buildMessage(c, {
          event: 'screen_ok', device: { id: inc.device_id, name: inc.device_name }, check: inc.kind, reason: inc.resolved_reason,
          minutes: Math.max(0, Math.floor((inc.resolved_at - inc.opened_at) / 60)), workspace: { name: nameOf(c.workspace_id) }, dashboardUrl: url,
          dedupKey: `screentinker-verify-${inc.device_id}-${inc.id}`, nowIso: new Date(now * 1000).toISOString(),
        }));
        db.prepare('UPDATE screen_verification_deliveries SET ok_sent_at = ?, ok_attempts = ok_attempts + 1 WHERE channel_id = ? AND incident_id = ?')
          .run(r.ok ? now : null, c.id, inc.id);
        ch.recordResult(db, c, r, now);
        if (r.ok) sent++;
        if (r.rateLimited) limited = true;
      }
    }
  }
  return sent;
}

/* History is kept 90 days; a pending suspicion nobody confirmed for a day is dropped. */
function prune(db, now) {
  try {
    db.prepare('DELETE FROM screen_verification_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(now - 90 * 86400);
    db.prepare('DELETE FROM screen_verification_incidents WHERE confirmed_at IS NULL AND resolved_at IS NULL AND last_seen_at < ?').run(now - 86400);
  } catch { /* best effort */ }
}

/* ============================== reads (routes) ============================== */

/**
 * The state a screen is DISPLAYED as, with the reason when it is unknown. Computed at read time
 * from the stored row plus the live facts the row cannot know (offline, switched off, stale).
 */
function presentState(device, row, settings, nowSec = Math.floor(Date.now() / 1000)) {
  const caps = require('../player-capabilities');
  const r = row && row.workspace_id === device.workspace_id ? row : null;
  const m = mem.get(device.id);
  const p = m ? panelPower(m, nowSec) : null;
  const panel = {
    reporting: !!(p || (r && r.panel_at)),
    power: p ? p.power : (r && r.panel_power) || null,
    input: (m && m.panel && m.panel.input) || (r && r.panel_input) || null,
    source: p ? p.source : (r && r.panel_source) || null,
  };
  const base = { device_id: device.id, panel, last_check_at: r ? r.last_check_at : null };
  if (!settings.enabled) return { ...base, state: 'unknown', reason: 'disabled', since: null };
  if (device.status !== 'online') return { ...base, state: 'unknown', reason: 'offline', since: null };
  if (!r || !r.state || r.state === 'unknown') {
    const reason = !caps.supports(device, 'remote.screenshot') ? 'no_capture' : (r && r.last_verdict && !['ok', 'blank', 'frozen', 'unexpected'].includes(r.last_verdict) ? r.last_verdict : 'no_frames');
    return { ...base, state: 'unknown', reason, since: r ? r.state_since : null };
  }
  const detail = r.detail ? safeJson(r.detail) : null;
  if (r.state === 'verified') {
    const staleAfter = settings.cadence_minutes > 0 ? Math.max(3 * settings.cadence_minutes * 60, 3 * 3600) : 24 * 3600;
    if (!r.last_check_at || nowSec - r.last_check_at > staleAfter) return { ...base, state: 'unknown', reason: 'stale', since: r.last_check_at };
  }
  return { ...base, state: r.state, since: r.state_since, detail, scheduled: !!(detail && detail.scheduled) };
}

/**
 * "Check now" from the dashboard: ask for a frame and make sure the next one is judged even if
 * one was judged a moment ago. Returns 'requested' | 'not_connected' | 'too_soon'.
 */
function requestNow(deviceId, nowMs = Date.now()) {
  const m = memFor(deviceId);
  if (nowMs - m.lastRequestAt * 1000 < 20 * 1000) return 'too_soon';
  m.lastRequestAt = Math.floor(nowMs / 1000);
  m.recheckAt = Math.floor(nowMs / 1000);
  let ok = false;
  try { ok = !!(requester && requester(deviceId)); } catch { ok = false; }
  return ok ? 'requested' : 'not_connected';
}

/* ============================== wiring ============================== */

function setRequester(fn) { requester = typeof fn === 'function' ? fn : null; }
function setEmitter(fn) { emitter = typeof fn === 'function' ? fn : null; }

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.warn(`[screen-verify] tick failed: ${e && e.message}`)); }, 60 * 1000);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

/*
 * What this module last heard about a screen's panel power, for lib/energy (docs/energy.md): the
 * panel report and the player's display_on/off, both already reset by noteReconnect. Read-only;
 * never creates a per-screen entry for a screen this module has not seen.
 */
function powerEvidence(deviceId) {
  const m = mem.get(deviceId);
  if (!m) return { panel: null, display: null };
  return { panel: m.panel ? { power: m.panel.power, at: m.panel.at } : null, display: m.display ? { power: m.display.power, at: m.display.at } : null };
}

function _reset() { mem.clear(); settingsCache.clear(); refCache.clear(); lastPrune = 0; }
function _setImageOps(x) { imageOpsOverride = x || null; }
function _mem(deviceId) { return memFor(deviceId); }

module.exports = {
  noteFrame, notePlayStart, noteDisplayEvent, notePanelReport, noteReconnect, noteOffline,
  settingsFor, invalidateSettings, presentState, requestNow, tick, powerEvidence, analyse, record, setRequester, setEmitter, start, stop,
  PROBLEMS, _reset, _setImageOps, _mem,
};
