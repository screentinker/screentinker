'use strict';

/*
 * "What will this screen show at…?" — the server's answer for ANY instant, with the reasons.
 *
 * The most repeated complaint about signage products is that the preview does not match the
 * screen. The way to make a forecast that matches is to not write a second scheduler: every rule
 * below is the LIVE rule, called with an injected instant instead of the wall clock.
 *
 *   which schedule wins     services/scheduler.js  schedulesForDevice / scheduleClockTz /
 *                                                   isScheduleActiveAt (the tick's own functions)
 *   which playlist plays    the device_resolved_playlist view's CASE, mirrored in resolveFromInputs
 *                           and proven equal to the view by test/device-simulate-equivalence.test.js
 *   what the payload holds  ws/deviceSocket.js buildPlaylistPayloadUnchecked(id, { resolved, forecast })
 *                           — the very builder every screen is fed by
 *   which items play        lib/schedule-eval.js (dayparts, play windows, play_when) — the module
 *                           the players themselves run
 *   is the backlight off    lib/power-window.js — the module the players run
 *   weather / area          lib/local-conditions.js passes(), optionally with a "what if" reading
 *   content expiry          content.expires_at, the column the content-expiry sweep acts on
 *
 * What a forecast deliberately does NOT project: a live emergency alert, a CAP feed, an automation
 * override (states of the present, reported separately as `live_now`), a trigger firing (device-side
 * and unpredictable: listed as "can interrupt"), and new content a smart playlist's rules would pick
 * up later (the published loop is what is forecast).
 *
 * TIME MODEL: instants are UTC; every rule is local wall-clock at minute resolution, so state can
 * only change on a minute boundary. The timeline exploits that: it walks the range a minute at a
 * time with a cheap clock (one Intl lookup per 15-minute bucket, not per rule per minute) and only
 * re-evaluates on a minute where some rule has an edge, at local midnight, on a UTC-offset change,
 * or when content expires. test/device-simulate.test.js checks that against a brute-force walk with
 * the canonical functions across DST weeks.
 */

const ScheduleEval = require('./schedule-eval');
const PowerWindow = require('./power-window');
const { MANDATE_EXPR } = require('./playlist-resolver-sql');
const { effectiveDeviceTz } = require('./device-timezone');
const capsLib = require('./player-capabilities');
const localConditions = require('./local-conditions');

const MINUTE = 60 * 1000;
const BUCKET = 15 * MINUTE;            // every real UTC-offset change lands on a 15-minute UTC boundary
const MAX_RANGE_MS = 14 * 24 * 60 * MINUTE;
const MAX_GROUP_DEVICES = 200;

function dbOf() { return require('../db/database').db; }
function scheduler() { return require('../services/scheduler'); }

/* ================================ clock ================================ */

const p2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * A fast UTC -> local-parts function for one zone, returning the SAME shape as schedule-eval's
 * _localParts ({y, mo, day, dow, min}). The UTC offset is looked up once per 15-minute bucket and
 * memoised; the rest is arithmetic. A falsy zone uses the server's own clock, exactly as
 * _localParts does. An unknown zone (which no live path accepts) falls back to the server clock.
 */
function makeClock(tz) {
  let fmt = null;
  if (tz) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    } catch (_) { fmt = null; }
  }
  const offsets = new Map();
  function offsetAt(ms) {
    const b = Math.floor(ms / BUCKET) * BUCKET;
    let off = offsets.get(b);
    if (off !== undefined) return off;
    if (!fmt) {
      off = -new Date(b).getTimezoneOffset() * MINUTE;
    } else {
      const p = {};
      for (const part of fmt.formatToParts(new Date(b))) p[part.type] = part.value;
      const wall = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
      off = wall - b;
    }
    offsets.set(b, off);
    return off;
  }
  function parts(ms) {
    const d = new Date(ms + offsetAt(ms));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  parts.offsetAt = offsetAt;
  parts.zone = fmt ? tz : null;
  return parts;
}

function stampOf(L) {
  return `${L.y}-${p2(L.mo)}-${p2(L.day)}T${p2(Math.floor(L.min / 60))}:${p2(L.min % 60)}`;
}

/* ============================ playlist resolution ============================ */

/*
 * The inputs of the device_resolved_playlist view, for one device: the mandate (same MANDATE_EXPR,
 * imported, never pasted), the wall's and the top group's playlist (the device_inherited_playlist
 * view itself), and the device's own columns.
 */
const INPUTS_SQL = `
  SELECT d.id AS device_id, d.playlist_id, d.playlist_source, d.layout_id, d.wall_id,
         d.scheduled_playlist_id, d.scheduled_layout_id,
         i.wall_playlist_id, i.group_playlist_id,
         cm.id AS mandate_id, cm.playlist_id AS mandate_playlist_id, cm.layout_id AS mandate_layout_id,
         cm.dark AS mandate_dark, cm.target_kind AS mandate_target_kind, cm.target_id AS mandate_target_id
    FROM (SELECT d.*, ${MANDATE_EXPR} AS mandate_id FROM devices d WHERE d.id = ?) d
    JOIN device_inherited_playlist i ON i.device_id = d.id
    LEFT JOIN corporate_mandates cm ON cm.id = d.mandate_id`;

function resolverInputs(db, deviceId) {
  const r = db.prepare(INPUTS_SQL).get(deviceId) || null;
  if (!r) return null;
  /*
   * The view's playlist-layout tier reads the PUBLISHED layout of whichever playlist the screen
   * resolves to — and under a hypothetical schedule that can be any playlist, so it is a lookup
   * rather than a column. Not enumerable: the inputs stay a plain row for anything that compares or
   * logs them.
   */
  const memo = new Map();
  const hasCol = require('./corporate/schema-probe').hasColumn(db, 'playlists', 'published_layout_id');
  Object.defineProperty(r, 'playlistLayout', {
    enumerable: false,
    value: (playlistId) => {
      if (!playlistId || !hasCol) return null;
      if (!memo.has(playlistId)) memo.set(playlistId, (db.prepare('SELECT published_layout_id FROM playlists WHERE id = ?').get(playlistId) || {}).published_layout_id ?? null);
      return memo.get(playlistId);
    },
  });
  return r;
}

/**
 * The view's rule (lib/playlist-resolver-sql.js RESOLVED_VIEW), as a pure function of its inputs
 * and a HYPOTHETICAL schedule — what the scheduler would have written into scheduled_playlist_id /
 * scheduled_layout_id at that instant.
 *
 * ⚠️ A MIRROR, and mirrors drift. test/device-simulate-equivalence.test.js asserts it equals the
 * view for every device of a fixture matrix (every tier, 'none', mandates, walls, groups, ties), and
 * simulate() re-checks it against the view for the CURRENT schedule on every call and reports any
 * disagreement as `resolver_check: 'mismatch'` instead of trusting itself.
 */
function resolveFromInputs(r, sched = { playlist_id: null, layout_id: null }) {
  if (!r) return { playlist_id: null, source: null, layout_id: null };
  const sp = sched.playlist_id ?? null;
  const sl = sched.layout_id ?? null;
  if (r.mandate_id != null) {
    return { playlist_id: r.mandate_playlist_id ?? null, source: 'corporate', layout_id: r.mandate_layout_id ?? null };
  }
  let playlist_id;
  if (r.playlist_source === 'none' && sp == null) playlist_id = null;
  else {
    playlist_id = sp
      ?? (r.playlist_source === 'device' ? (r.playlist_id ?? null) : null)
      ?? r.wall_playlist_id ?? r.group_playlist_id ?? r.playlist_id ?? null;
  }
  let source;
  if (sp != null) source = 'schedule';
  else if (r.playlist_source === 'none') source = null;
  else if (r.playlist_source === 'device' && r.playlist_id != null) source = 'device';
  else if (r.wall_playlist_id != null) source = 'wall';
  else if (r.group_playlist_id != null) source = 'group';
  else if (r.playlist_id != null) source = 'device';
  else source = null;
  // Schedule's layout > the playlist's own (not on a wall member) > the device's.
  const playlistLayout = r.wall_id == null && playlist_id != null && typeof r.playlistLayout === 'function'
    ? r.playlistLayout(playlist_id) : null;
  return { playlist_id, source, layout_id: sl ?? playlistLayout ?? r.layout_id ?? null };
}

/* ============================== schedule reasons ============================== */

/**
 * WHY a schedule is or is not live at local moment L — for the explanation only. The verdict
 * itself always comes from scheduler.isScheduleActiveAt (the tick's function); this only names the
 * first gate that failed, in the same order that function tests them.
 */
function scheduleReason(s, L) {
  const S = scheduler();
  if (S.isScheduleActiveAt(s, L)) return 'active';
  const nowStamp = stampOf(L);
  const startStamp = String(s.start_time).slice(0, 16);
  const endStamp = String(s.end_time).slice(0, 16);
  const rule = s.recurrence ? S.parseSimpleRRule(s.recurrence) : null;
  if (!rule) return nowStamp < startStamp ? 'not_started' : 'ended';
  const nowDate = nowStamp.slice(0, 10);
  if (nowDate < startStamp.slice(0, 10)) return 'not_started';
  if (s.recurrence_end && nowDate > String(s.recurrence_end).slice(0, 10)) return 'ended';
  if (rule.byDay && !rule.byDay.includes(L.dow)) return 'wrong_day';
  if (rule.freq === 'MONTHLY' && L.day !== Number(startStamp.slice(8, 10))) return 'wrong_day';
  return 'outside_hours';
}

/* ================================ item verdicts ================================ */

/**
 * ScheduleEval.itemShouldPlay, from local parts, with the reason it does not play. Same gates, same
 * order, same fail-open on a throw — test/device-simulate.test.js pins it to itemShouldPlay.
 */
function itemVerdict(item, L) {
  try {
    if (!item) return null;
    if (item.enabled === 0 || item.enabled === false) return 'disabled';
    let reason = null;
    try {
      const w = ScheduleEval.windowOf(item);
      if (!ScheduleEval._intervalOk(w, L)) {
        reason = (w && w.play_from && stampOf(L) < w.play_from) ? 'not_started' : 'ended';
      } else if (item.schedules && item.schedules.length) {
        let hit = false;
        for (const b of item.schedules) if (ScheduleEval._blockMatches(b, L)) { hit = true; break; }
        if (!hit) reason = 'daypart';
      }
    } catch (_) { reason = null; }   // isItemActiveNow fails OPEN
    if (reason) return reason;
    if (!ScheduleEval.conditionOk(item.play_when, item._ds, item)) return 'condition';
    return null;
  } catch (_) {
    return null;
  }
}

/** PowerWindow.isOff, from local parts. Same fail-to-ON rule. */
function powerOffAt(schedule, L) {
  try {
    if (!schedule || schedule.enabled === false) return false;
    const windows = schedule.windows;
    if (!windows || typeof windows.length !== 'number' || windows.length === 0) return false;
    for (const w of windows) if (PowerWindow._windowCovers(w, L.dow, L.min)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/*
 * Items a player could be asked to play but does not declare it can. The HARD ones (live streams,
 * HDMI in, holds) are stripped from the payload by the builder and reported via its trace; these
 * are advisory — the server sends them and the player does its best.
 */
function advisoryCapability(item) {
  if (!item) return null;
  const mime = String(item.mime_type || '');
  if (mime === 'video/youtube') return 'playback.youtube';
  if (item.widget_type || item.widget_id) return 'playback.widget';
  if (mime.startsWith('video/')) return 'playback.video';
  if (mime.startsWith('image/')) return 'playback.image';
  return null;
}

function itemLabel(it) {
  if (!it) return '';
  return String(it.filename || it.widget_name || it.remote_url || it.mime_type || '').slice(0, 160);
}

/* ================================ context ================================ */

/**
 * Everything that does not depend on the instant, loaded once per device: the device, the
 * resolver inputs, its schedules and clocks, and a payload cache keyed by the schedule that would
 * be live (a fortnight with three schedules builds at most four payloads, not twenty thousand).
 */
function loadContext(deviceId, opts = {}) {
  const db = opts.db || dbOf();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) return null;
  const S = scheduler();
  const inputs = resolverInputs(db, deviceId);
  const schedules = S.schedulesForDevice(device);
  const scheduleTz = schedules.length ? S.scheduleClockTz(device) : effectiveDeviceTz(device);
  const itemTz = effectiveDeviceTz(device);
  const ctx = {
    db, device, inputs, schedules, weather: opts.weather || null,
    scheduleTz: scheduleTz || null, itemTz: itemTz || null,
    scheduleClock: makeClock(scheduleTz),
    itemClock: makeClock(itemTz),
    payloads: new Map(),
    names: new Map(),
  };
  // Power schedule and triggers do not depend on which playlist runs (forecast mode never has a
  // live override), so the first payload answers them for the whole range.
  const first = payloadFor(ctx, { playlist_id: null, layout_id: null });
  ctx.power = first.payload.power_schedule || null;
  ctx.powerSupported = capsLib.supports(device, 'display.power_schedule');
  ctx.powerClock = makeClock(ctx.power && ctx.power.timezone);
  ctx.triggers = Array.isArray(first.payload.triggers) ? first.payload.triggers : [];
  return ctx;
}

function payloadFor(ctx, sched) {
  const key = `${sched.playlist_id || ''}|${sched.layout_id || ''}`;
  let entry = ctx.payloads.get(key);
  if (entry) return entry;
  const resolved = resolveFromInputs(ctx.inputs, sched);
  const trace = {};
  const { buildPlaylistPayloadUnchecked } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayloadUnchecked(ctx.device.id, {
    resolved: { ...resolved, scheduled_layout_id: sched.layout_id || null },
    forecast: true,
    weather: ctx.weather || undefined,
    trace,
  });
  const items = Array.isArray(payload.assignments) ? payload.assignments : [];
  // Content expiry: the instant each content-backed item stops (the sweep removes it then).
  const ids = [...new Set(items.map((a) => a && a.content_id).filter(Boolean))];
  const expiry = new Map();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of ctx.db.prepare(`SELECT id, expires_at FROM content WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        if (r.expires_at != null && Number.isFinite(Number(r.expires_at))) expiry.set(r.id, Number(r.expires_at) * 1000);
      }
    }
  }
  entry = { key, sched, resolved, payload, items, trace, expiry };
  ctx.payloads.set(key, entry);
  return entry;
}

/* ================================ one instant ================================ */

/** The bare state at instant `ms` (used by both simulate and the timeline). */
function stateAt(ctx, ms) {
  const LS = ctx.scheduleClock(ms);
  const S = scheduler();
  let active = null;
  for (const s of ctx.schedules) if (S.isScheduleActiveAt(s, LS)) { active = s; break; }
  const sched = active ? { playlist_id: active.playlist_id || null, layout_id: active.layout_id || null } : { playlist_id: null, layout_id: null };
  const entry = payloadFor(ctx, sched);
  const LI = ctx.itemClock(ms);
  const verdicts = entry.items.map((it) => {
    const exp = it && it.content_id ? entry.expiry.get(it.content_id) : undefined;
    if (exp !== undefined && exp <= ms) return 'expired';
    return itemVerdict(it, LI);
  });
  const powerOff = !!(ctx.powerSupported && ctx.power && powerOffAt(ctx.power, ctx.powerClock(ms)));
  // 3.0 campaigns: each step's own verdict (its dayparts / window / play_when), for the timeline.
  const steps = entry.payload && entry.payload.campaign && Array.isArray(entry.payload.campaign.steps) ? entry.payload.campaign.steps : null;
  const stepVerdicts = steps ? steps.map((s) => itemVerdict(s.type === 'layout' ? s : s.item, LI)) : null;
  return { ms, active, entry, verdicts, powerOff, stepVerdicts };
}

function playlistName(ctx, id) {
  if (!id) return null;
  if (ctx.names.has(id)) return ctx.names.get(id);
  const row = ctx.db.prepare('SELECT name FROM playlists WHERE id = ?').get(id);
  const name = row ? row.name : null;
  ctx.names.set(id, name);
  return name;
}

function scheduleScope(s) {
  return s.wall_id ? 'wall' : s.device_id ? 'device' : 'group';
}

/*
 * Why the fallback chain landed where it did when no schedule (or a mandate) decides. Codes, not
 * English: the dashboard words them through i18n.
 */
function fallbackTrail(ctx, resolved) {
  const db = ctx.db, r = ctx.inputs || {};
  const steps = [];
  if (resolved.source === 'corporate') {
    steps.push({ code: r.mandate_dark ? 'mandate_dark' : 'mandate', target_kind: r.mandate_target_kind || null, playlist: playlistName(ctx, r.mandate_playlist_id) });
    return steps;
  }
  if (resolved.source === 'schedule') return steps;
  if (r.playlist_source === 'none') { steps.push({ code: 'none_chosen' }); return steps; }
  if (resolved.source === 'device') {
    steps.push({ code: r.playlist_source === 'device' ? 'device_override' : 'device_unclassified', playlist: playlistName(ctx, resolved.playlist_id) });
  }
  if (r.wall_playlist_id) {
    const wall = r.wall_id ? db.prepare('SELECT name FROM video_walls WHERE id = ?').get(r.wall_id) : null;
    steps.push({ code: resolved.source === 'wall' ? 'wall' : 'wall_outranked', wall: wall ? wall.name : null, playlist: playlistName(ctx, r.wall_playlist_id) });
  }
  const groups = db.prepare(`SELECT g.id, g.name, g.priority, g.playlist_id FROM device_groups g
      JOIN device_group_members m ON m.group_id = g.id
     WHERE m.device_id = ? AND g.playlist_id IS NOT NULL
     ORDER BY g.priority DESC, g.created_at ASC, g.id ASC`).all(ctx.device.id);
  groups.forEach((g, i) => {
    const won = i === 0 && resolved.source === 'group';
    steps.push({ code: won ? 'group' : (i === 0 ? 'group_outranked' : 'group_lower'), group: g.name, priority: g.priority, playlist: playlistName(ctx, g.playlist_id) });
  });
  if (!resolved.playlist_id) steps.push({ code: 'nothing_assigned' });
  return steps;
}

/*
 * Which tier chose the layout — the same order as the view (mandate > schedule > the playlist's own
 * > the device's), read back from the inputs so the preview can say "this playlist's layout".
 */
function layoutInfo(ctx, resolved, sched) {
  const id = resolved.layout_id || null;
  if (!id) return null;
  const r = ctx.inputs || {};
  let source = 'device';
  if (resolved.source === 'corporate') source = 'mandate';
  else if (sched && sched.layout_id) source = 'schedule';
  else if (r.wall_id == null && resolved.playlist_id && typeof r.playlistLayout === 'function' && r.playlistLayout(resolved.playlist_id) === id) source = 'playlist';
  let name = null;
  try { name = (ctx.db.prepare('SELECT name FROM layouts WHERE id = ?').get(id) || {}).name || null; } catch (_) { name = null; }
  return { id, name, source };
}

/*
 * 3.0 campaigns: what a campaign screen shows at this instant — its steps (layouts and full-screen
 * items) with the same per-step verdicts as items — or, for a screen that will play the simplified
 * fallback, says so (`fallback: true`; `items` above is then that fallback, which is what it plays).
 */
function campaignInfo(ctx, entry, LI) {
  const c = entry.payload && entry.payload.campaign;
  if (c && Array.isArray(c.steps)) {
    return {
      fallback: false,
      steps: c.steps.map((s) => {
        const reason = itemVerdict(s.type === 'layout' ? s : s.item, LI);
        if (s.type === 'layout') {
          const zones = Object.values(s.zones || {});
          return { type: 'layout', layout_id: s.layout_id, label: (s.layout && s.layout.name) || '', duration_sec: s.duration_sec || null,
            zones: zones.length, items: zones.reduce((n, l) => n + l.length, 0), variant: (s.layout && s.layout.variant) || null, plays: reason === null, reason };
        }
        return { type: 'item', label: itemLabel(s.item), duration_sec: (s.item && s.item.duration_sec) || null, plays: reason === null, reason };
      }),
    };
  }
  const pid = entry.resolved && entry.resolved.playlist_id;
  if (!pid) return null;
  let has = false;
  try { has = !!(ctx.db.prepare('SELECT published_campaign FROM playlists WHERE id = ?').get(pid) || {}).published_campaign; } catch (_) { has = false; }
  return has ? { fallback: true, steps: [] } : null;
}

function liveNow(deviceId) {
  const db = dbOf();
  const out = [];
  try { if (require('./corporate/emergency-live').activationFor(db, deviceId)) out.push('emergency'); } catch (_) { /* */ }
  try { if (require('./cap/feeds').overrideFor(db, deviceId)) out.push('cap'); } catch (_) { /* */ }
  try { if (require('./automation/overrides').overrideFor(db, deviceId)) out.push('automation'); } catch (_) { /* */ }
  return out;
}

/**
 * The full answer for one instant: state plus the explanation trail.
 *
 * @returns {object|null} null when the device does not exist
 */
function simulate(deviceId, atMs, opts = {}) {
  const ctx = opts.ctx || loadContext(deviceId, opts);
  if (!ctx) return null;
  const st = stateAt(ctx, atMs);
  const { entry } = st;
  const LS = ctx.scheduleClock(atMs);
  const LI = ctx.itemClock(atMs);
  const resolved = entry.resolved;

  // Self-check the mirror against the live view for the schedule the scheduler last wrote.
  let resolverCheck = 'ok';
  try {
    const live = ctx.db.prepare('SELECT playlist_id, source, layout_id FROM device_resolved_playlist WHERE device_id = ?').get(deviceId);
    const mine = resolveFromInputs(ctx.inputs, { playlist_id: ctx.inputs && ctx.inputs.scheduled_playlist_id, layout_id: ctx.inputs && ctx.inputs.scheduled_layout_id });
    if (!live || (live.playlist_id ?? null) !== mine.playlist_id || (live.source ?? null) !== mine.source || (live.layout_id ?? null) !== mine.layout_id) resolverCheck = 'mismatch';
  } catch (_) { resolverCheck = 'unavailable'; }

  const schedules = ctx.schedules.map((s) => ({
    id: s.id,
    title: s.title || '',
    scope: scheduleScope(s),
    priority: s.priority || 0,
    playlist: playlistName(ctx, s.playlist_id),
    playlist_id: s.playlist_id || null,
    start: String(s.start_time).slice(0, 16),
    end: String(s.end_time).slice(0, 16),
    recurrence: s.recurrence || null,
    // A head office mandate sits above every schedule (the view's top tier): a schedule that is
    // live underneath one is reported as overruled, not as the winner.
    state: st.active && st.active.id === s.id ? (resolved.source === 'corporate' ? 'mandate_overrides' : 'won')
      : (scheduler().isScheduleActiveAt(s, LS) ? 'outranked' : scheduleReason(s, LS)),
  }));

  const items = entry.items.map((it, i) => {
    const out = {
      index: i,
      label: itemLabel(it),
      content_id: it && it.content_id || null,
      widget_id: it && it.widget_id || null,
      mime_type: it && it.mime_type || null,
      duration_sec: it && it.duration_sec || null,
      plays: st.verdicts[i] === null,
      reason: st.verdicts[i],
    };
    if (st.verdicts[i] === 'expired') out.expired_at = new Date(entry.expiry.get(it.content_id)).toISOString();
    if (st.verdicts[i] === 'not_started' && it.play_from) out.play_from = it.play_from;
    if (st.verdicts[i] === 'ended' && it.play_until) out.play_until = it.play_until;
    const cap = advisoryCapability(it);
    if (cap && !capsLib.supports(ctx.device, cap)) out.may_not_play = cap;
    return out;
  });

  // Left out before the player ever sees them: unsupported on this player, or a weather/area
  // condition that fails here.
  const skipped = [];
  for (const it of entry.trace.unsupported || []) {
    const cap = it.mime_type === 'video/hls' ? 'playback.hls'
      : it.mime_type === 'video/rtsp' ? (/^rtsps:/i.test(String(it.remote_url || '')) ? 'playback.rtsps' : 'playback.rtsp')
      : it.mime_type === 'video/hdmi-in' ? 'playback.hdmi_in' : 'playback.hold';
    skipped.push({ label: itemLabel(it), reason: 'unsupported', capability: cap });
  }
  for (const it of entry.trace.before_local || []) {
    if (!it || !localConditions.isLocal(it.play_when)) continue;
    if (localConditions.passes(it.play_when, ctx.device, ctx.weather || undefined)) continue;
    const w = it.play_when;
    skipped.push({ label: itemLabel(it), reason: w.type === 'geo' ? 'geo' : w.type === 'screens' ? 'experiment' : 'weather', condition: w });
  }

  const playing = items.filter((x) => x.plays).length;
  const weatherReading = ctx.weather || localConditions.readingFor(ctx.device);
  return {
    device: {
      id: ctx.device.id, name: ctx.device.name, status: ctx.device.status,
      orientation: ctx.device.orientation || 'landscape',
      screen_width: ctx.device.screen_width || null, screen_height: ctx.device.screen_height || null,
      client_type: ctx.device.client_type || null, platform: ctx.device.platform || null,
      wall_id: ctx.device.wall_id || null,
    },
    at: new Date(atMs).toISOString(),
    local: { schedule: stampOf(LS), items: stampOf(LI) },
    timezone: ctx.itemTz,
    schedule_timezone: ctx.scheduleTz,
    timezone_assumed: !ctx.itemTz,
    resolved: { ...resolved, playlist_name: playlistName(ctx, resolved.playlist_id) },
    resolver_check: resolverCheck,
    active_schedule: st.active && resolved.source !== 'corporate' ? schedules.find((s) => s.id === st.active.id) : null,
    schedules,
    fallback: fallbackTrail(ctx, resolved),
    items,
    skipped,
    playing,
    default_content: playing === 0 && entry.payload.default_content
      ? { content_id: entry.payload.default_content.content_id, label: entry.payload.default_content.filename || '' } : null,
    layout_id: resolved.layout_id || null,
    layout: layoutInfo(ctx, resolved, entry.sched),
    campaign: campaignInfo(ctx, entry, LI),
    power: {
      schedule: !!ctx.power,
      supported: ctx.powerSupported,
      off: st.powerOff,
      source: ctx.power ? ctx.power.source || null : null,
      ignored: !!(ctx.power && !ctx.powerSupported && ctx.power.windows && ctx.power.windows.length),
    },
    triggers: ctx.triggers.map((t) => ({ name: t && t.name ? String(t.name).slice(0, 120) : '', kind: t && t.kind || 'normal' })),
    live_now: atMs > Date.now() - MINUTE ? liveNow(deviceId) : [],
    weather: weatherReading ? { group: weatherReading.group || null, temperature_c: Number.isFinite(weatherReading.temperature_c) ? weatherReading.temperature_c : null, assumed: !!ctx.weather } : null,
    offline: ctx.device.status !== 'online',
  };
}

/**
 * The payload a preview frame renders for instant `atMs`: the real payload for that instant, with
 * the items that would not play left out and the time gates taken OFF the rest — the preview
 * player runs on today's clock, and would otherwise re-filter a 9am Monday loop against now.
 * Nothing in it can act on a LAN: no triggers, no listener settings, no endpoints, no power
 * schedule (the dashboard draws the "screen is off" state itself).
 */
function previewPayload(deviceId, atMs, opts = {}) {
  const ctx = opts.ctx || loadContext(deviceId, opts);
  if (!ctx) return null;
  const st = stateAt(ctx, atMs);
  const assignments = st.entry.items
    .filter((_, i) => st.verdicts[i] === null)
    .map((it) => {
      const { schedules, play_from, play_until, play_when, _ds, ...rest } = it;   // eslint-disable-line no-unused-vars
      return rest;
    });
  return {
    ...st.entry.payload,
    assignments,
    wall_config: null,
    group_sync: null,
    triggers: [],
    trigger_config: null,
    local_api: null,
    endpoints: [],
    power_schedule: null,
    audience: null,
    preview_at: new Date(atMs).toISOString(),
    preview_power_off: st.powerOff,
  };
}

/* ================================ timeline ================================ */

function hmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/*
 * The local minutes-of-day at which SOME rule could flip: schedule start/end (+1: a schedule's end
 * minute is inclusive), item daypart start/end, play-window minutes (+1 for the inclusive end),
 * power window start/end. Local midnight, UTC-offset changes and expiry instants are added by the
 * walker. Anything not on this list cannot change state between two of its entries.
 */
function edgeMinutes(ctx) {
  const set = new Set([0]);
  const add = (m) => { if (m !== null && m !== undefined && Number.isFinite(m)) set.add(((m % 1440) + 1440) % 1440); };
  for (const s of ctx.schedules) {
    const a = hmToMin(String(s.start_time).slice(11, 16)), b = hmToMin(String(s.end_time).slice(11, 16));
    add(a); add(b); if (b !== null) add(b + 1);
  }
  for (const e of ctx.payloads.values()) {
    // 3.0 campaigns: a step's own gates and every zone item's are edges too.
    const steps = e.payload && e.payload.campaign && Array.isArray(e.payload.campaign.steps) ? e.payload.campaign.steps : [];
    const campaignGated = steps.map((s) => (s.type === 'layout' ? s : s.item))
      .concat(...steps.filter((s) => s.type === 'layout').map((s) => [].concat(...Object.values(s.zones || {}))));
    for (const it of e.items.concat(campaignGated)) {
      if (!it) continue;
      for (const b of it.schedules || []) { add(hmToMin(b && b.start)); add(hmToMin(b && b.end)); }
      for (const k of ['play_from', 'play_until']) {
        const v = it[k];
        if (typeof v === 'string' && v.length >= 16) { const m = hmToMin(v.slice(11, 16)); add(m); if (k === 'play_until' && m !== null) add(m + 1); }
      }
    }
  }
  for (const w of (ctx.power && ctx.power.windows) || []) { add(hmToMin(w && w.start)); add(hmToMin(w && w.end)); }
  return set;
}

function signatureOf(st) {
  return `${st.active ? st.active.id : ''}|${st.entry.key}|${st.powerOff ? 1 : 0}|${st.verdicts.map((v) => (v === null ? '1' : '0')).join('')}`
    + (st.stepVerdicts ? `|c${st.stepVerdicts.map((v) => (v === null ? '1' : '0')).join('')}` : '');
}

/**
 * Segments of constant state over [fromMs, toMs). Bounded to 14 days.
 *
 * @returns {{segments: Array, from, to, timezone}|null}
 */
function timeline(deviceId, fromMs, toMs, opts = {}) {
  const ctx = opts.ctx || loadContext(deviceId, opts);
  if (!ctx) return null;
  const start = Math.floor(fromMs / MINUTE) * MINUTE;
  const end = Math.min(toMs, start + MAX_RANGE_MS);
  // Every payload a schedule in range could produce, built up front so edgeMinutes sees their items.
  payloadFor(ctx, { playlist_id: null, layout_id: null });
  for (const s of ctx.schedules) payloadFor(ctx, { playlist_id: s.playlist_id || null, layout_id: s.layout_id || null });
  const edges = edgeMinutes(ctx);
  const expiries = new Set();
  for (const e of ctx.payloads.values()) for (const v of e.expiry.values()) if (v > start && v < end) expiries.add(Math.ceil(v / MINUTE) * MINUTE);
  const clocks = [ctx.scheduleClock, ctx.itemClock, ctx.powerClock];

  const segments = [];
  let cur = null, curSig = null;
  const prevOff = clocks.map((c) => c.offsetAt(start));
  for (let ms = start; ms < end; ms += MINUTE) {
    let due = ms === start || expiries.has(ms);
    if (!due) {
      for (let k = 0; k < clocks.length; k++) {
        const off = clocks[k].offsetAt(ms);
        if (off !== prevOff[k]) { prevOff[k] = off; due = true; }
        if (!due) {
          const L = clocks[k](ms);
          if (edges.has(L.min)) due = true;
        }
        if (due) break;
      }
    }
    if (!due) continue;
    const st = stateAt(ctx, ms);
    const sig = signatureOf(st);
    if (sig === curSig) continue;
    if (cur) cur.to = new Date(ms).toISOString();
    cur = segmentOf(ctx, st);
    curSig = sig;
    segments.push(cur);
  }
  if (cur) cur.to = new Date(end).toISOString();
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    timezone: ctx.itemTz,
    timezone_assumed: !ctx.itemTz,
    truncated: toMs > end,
    segments,
  };
}

function segmentOf(ctx, st) {
  const names = [];
  let playing = 0;
  st.entry.items.forEach((it, i) => {
    if (st.verdicts[i] !== null) return;
    playing++;
    if (names.length < 6) names.push(itemLabel(it));
  });
  const r = st.entry.resolved;
  const sched = r.source === 'corporate' ? null : st.active;
  return {
    from: new Date(st.ms).toISOString(),
    to: null,
    local: stampOf(ctx.itemClock(st.ms)),
    schedule_id: sched ? sched.id : null,
    schedule_title: sched ? (sched.title || '') : null,
    playlist_id: r.playlist_id || null,
    playlist_name: playlistName(ctx, r.playlist_id),
    source: r.source || null,
    power: st.powerOff ? 'off' : 'on',
    playing,
    total: st.entry.items.length,
    items: names,
    default_content: playing === 0 && !!st.entry.payload.default_content,
    // 3.0 campaigns: the steps that play in this segment, by name ("Lunch layout", "promo.mp4").
    ...(st.stepVerdicts ? { campaign: st.entry.payload.campaign.steps
      .filter((s, i) => st.stepVerdicts[i] === null)
      .map((s) => (s.type === 'layout' ? (s.layout && s.layout.name) || '' : itemLabel(s.item))).slice(0, 8) } : {}),
  };
}

/* ================================ group / fleet ================================ */

/** Every member of a group at one instant, compactly. Bounded. */
function simulateGroup(db, groupId, atMs, opts = {}) {
  // ⚠️ Members are re-scoped to the group's workspace: membership rows are written by several
  // paths, and a stray cross-tenant row must not turn this read into a look at another tenant's screen.
  const ids = db.prepare(`SELECT d.id FROM devices d JOIN device_group_members m ON m.device_id = d.id
     JOIN device_groups g ON g.id = m.group_id AND g.workspace_id = d.workspace_id
     WHERE m.group_id = ? ORDER BY d.name COLLATE NOCASE, d.id LIMIT ?`).all(groupId, MAX_GROUP_DEVICES + 1).map((r) => r.id);
  const truncated = ids.length > MAX_GROUP_DEVICES;
  const devices = [];
  for (const id of ids.slice(0, MAX_GROUP_DEVICES)) {
    try {
      const ctx = loadContext(id, opts);
      if (!ctx) continue;
      const st = stateAt(ctx, atMs);
      const seg = segmentOf(ctx, st);
      devices.push({
        id, name: ctx.device.name, status: ctx.device.status, orientation: ctx.device.orientation || 'landscape',
        local: seg.local, timezone: ctx.itemTz,
        playlist_id: seg.playlist_id, playlist_name: seg.playlist_name, source: seg.source,
        schedule_title: seg.schedule_title, power: seg.power, playing: seg.playing, total: seg.total, items: seg.items,
        default_content: seg.default_content,
      });
    } catch (e) {
      devices.push({ id, error: true });
    }
  }
  return { at: new Date(atMs).toISOString(), truncated, devices };
}

/* ================================ input parsing ================================ */

/** An ISO instant from a query value, or null. "now" and empty mean now. */
function parseInstant(v, fallback = Date.now()) {
  if (v === undefined || v === null || v === '' || v === 'now') return fallback;
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  // Keep to a sane window: a year back, five years ahead.
  if (ms < Date.now() - 366 * 24 * 3600 * 1000 || ms > Date.now() + 5 * 366 * 24 * 3600 * 1000) return null;
  return ms;
}

/** The optional "what if the weather were…" reading. null = use the cached reading. */
function parseWeather(q) {
  const out = {};
  const g = typeof q.weather === 'string' ? q.weather.toLowerCase() : '';
  if (g) {
    if (!localConditions.GROUPS.includes(g)) return false;
    out.group = g;
  }
  if (q.temp_c !== undefined && q.temp_c !== '') {
    const t = Number(q.temp_c);
    if (!Number.isFinite(t) || t < -80 || t > 70) return false;
    out.temperature_c = t;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  simulate, previewPayload, timeline, simulateGroup, loadContext, stateAt,
  resolveFromInputs, resolverInputs, itemVerdict, powerOffAt, scheduleReason, makeClock,
  parseInstant, parseWeather, MAX_RANGE_MS, MAX_GROUP_DEVICES,
};
