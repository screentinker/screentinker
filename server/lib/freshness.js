'use strict';

/*
 * Content freshness: is what this workspace's screens are showing quietly rotting?
 *
 * Industry telemetry (Kitcast, State of Digital Signage 2026) puts the median screen's content at
 * 16.8 days old and 27.7% of scheduled creative at over a year old: content is uploaded once and
 * then ages without anybody deciding it should. Nothing here changes a screen. It READS what played
 * and what is assigned, and says where the rot is and why, in sentences a person can check.
 *
 * ⚠️ AGE IS WEIGHTED BY WHAT ACTUALLY PLAYED. A two-year-old logo bumper that shows for three
 * seconds a loop is not what makes a screen stale; the 40-second promo that runs every loop is. So a
 * screen's age is the play-time-weighted mean age of the items it showed in the last `window_days`
 * (proof-of-play, play_logs). A screen with no plays in the window (offline, or proof-of-play
 * switched off for its items) falls back to its resolved playlist, weighted by each item's dwell —
 * and the report says which basis it used.
 *
 * ⚠️ AN ITEM'S AGE ON A SCREEN IS SINCE IT LAST CHANGED *OR* ARRIVED. A photo uploaded two years
 * ago and added to the lobby playlist yesterday is new to everyone walking past the lobby. So the
 * age is measured from the later of the item's last change and the moment its playlist row was
 * created.
 *
 * ⚠️ WHAT COUNTS AS A CHANGE. Content: created, or its file REPLACED (content.updated_at is bumped
 * only when the bytes change — routes/content.js). Renaming it or setting an expiry is not a change
 * to what anybody sees, and must not "freshen" it, or this page's own "set an expiry" button would
 * make the problem it reports disappear. Widgets: widgets.updated_at, which every config edit bumps.
 *
 * ⚠️ LIVE THINGS DO NOT ROT. A web page, a live stream, a clock, a weather or RSS widget changes by
 * itself; its row's age says nothing about what is on screen. Those items still get the date checks
 * on their NAMES, but they carry no age and do not count towards a screen's weighted age.
 *
 * Detectors, each with an explanation sentence (lib/freshness-dates.js is the conservative date
 * reader):
 *   past_date        the item's name or slide text mentions a date that is over
 *   out_of_season    a holiday with no year, well outside its season (leftovers only)
 *   expired_assigned the item's expiry passed but it still sits in a playlist (it no longer plays)
 *   stale/very_stale nobody has changed it in stale_days / very_stale_days
 * and per workspace:
 *   dark             no admin or editor has signed in for DARK_DAYS
 *
 * Only items IN USE are judged — on a screen's resolved playlist, in a published playlist, or played
 * in the window. An old file sitting unused in the library is not rot on a screen.
 */

const dates = require('./freshness-dates');
const { LIVE_MIMES } = require('./remote-url');
const { HOLD_MIME } = require('./hold-item');

const DAY = 86400;
const DEFAULTS = Object.freeze({ stale_days: 30, very_stale_days: 90, window_days: 7, digest_enabled: 1 });
const DARK_DAYS = 90;
const SNOOZE_TYPES = ['content', 'widget', 'device', 'playlist'];
// Widgets whose words are authored and stay put until someone edits them. Everything else
// (clock, weather, rss, webpage, social, cloud-doc, bi-dashboard, room-display...) feeds itself.
const AGEABLE_WIDGETS = new Set(['slide', 'text', 'menu-board', 'directory-board']);
// Keys of a non-slide widget's config that hold words a person typed.
const TEXT_KEYS = new Set(['text', 'title', 'heading', 'subtitle', 'message', 'body', 'caption', 'content', 'headline']);
const MAX_NESTING = 4;
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function nowSec() { return Math.floor(Date.now() / 1000); }

// ---------------------------------------------------------------------------------------------
// Settings and snoozes
// ---------------------------------------------------------------------------------------------

function getSettings(db, workspaceId) {
  let row = null;
  try { row = db.prepare('SELECT * FROM freshness_settings WHERE workspace_id = ?').get(workspaceId); } catch (_) { /* table absent */ }
  return {
    stale_days: row ? row.stale_days : DEFAULTS.stale_days,
    very_stale_days: row ? row.very_stale_days : DEFAULTS.very_stale_days,
    window_days: row ? row.window_days : DEFAULTS.window_days,
    digest_enabled: row ? row.digest_enabled : DEFAULTS.digest_enabled,
  };
}

/**
 * Validate a settings patch against the current settings. Returns { ok, settings } or { ok:false, error }.
 * ⚠️ very_stale must be strictly greater than stale: equal thresholds would make "stale" a state no
 * screen can ever be in, and the chip that explains it would lie.
 */
function validateSettings(current, body) {
  const b = body && typeof body === 'object' ? body : {};
  const next = { ...current };
  const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  if (b.stale_days !== undefined) { const n = int(b.stale_days, 1, 3650); if (n == null) return { ok: false, error: 'stale_days must be a whole number of days from 1 to 3650' }; next.stale_days = n; }
  if (b.very_stale_days !== undefined) { const n = int(b.very_stale_days, 2, 3650); if (n == null) return { ok: false, error: 'very_stale_days must be a whole number of days from 2 to 3650' }; next.very_stale_days = n; }
  if (b.window_days !== undefined) { const n = int(b.window_days, 1, 90); if (n == null) return { ok: false, error: 'window_days must be a whole number of days from 1 to 90' }; next.window_days = n; }
  if (b.digest_enabled !== undefined) next.digest_enabled = b.digest_enabled ? 1 : 0;
  if (next.very_stale_days <= next.stale_days) return { ok: false, error: 'very_stale_days must be greater than stale_days' };
  return { ok: true, settings: next };
}

function saveSettings(db, workspaceId, s, userId) {
  db.prepare(`INSERT INTO freshness_settings (workspace_id, stale_days, very_stale_days, window_days, digest_enabled, updated_by, updated_at)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id) DO UPDATE SET stale_days = excluded.stale_days, very_stale_days = excluded.very_stale_days,
                window_days = excluded.window_days, digest_enabled = excluded.digest_enabled,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(workspaceId, s.stale_days, s.very_stale_days, s.window_days, s.digest_enabled, userId || null, nowSec());
  invalidate(workspaceId);
}

function activeSnoozes(db, workspaceId, now) {
  const out = new Map();
  try {
    for (const r of db.prepare('SELECT resource_type, resource_id, until FROM freshness_snoozes WHERE workspace_id = ? AND until > ?').all(workspaceId, now)) {
      out.set(`${r.resource_type}:${r.resource_id}`, r.until);
    }
  } catch (_) { /* table absent */ }
  return out;
}

/** The workspace a snoozable resource belongs to, or null. The tenancy check for snooze writes. */
function resourceWorkspace(db, type, id) {
  const table = { content: 'content', widget: 'widgets', device: 'devices', playlist: 'playlists' }[type];
  if (!table) return null;
  const row = db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(String(id || ''));
  return row ? row.workspace_id : null;
}

/*
 * Bumped by every invalidate. A report computed off-thread is only remembered if no invalidate
 * happened while it was being computed, or a snooze made during a slow compute would be undone by
 * the stale answer arriving after it.
 */
const generations = new Map();
let allGeneration = 0;
function generation(workspaceId) { return `${allGeneration}:${generations.get(workspaceId) || 0}`; }

function invalidate(workspaceId) {
  if (workspaceId) { cache.delete(workspaceId); generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1); }
  else { cache.clear(); allGeneration++; }
}

/** The cached report if it is younger than maxAgeMs (default: the chips' TTL), else null. */
function cached(workspaceId, maxAgeMs = CACHE_TTL_MS) {
  const hit = workspaceId ? cache.get(workspaceId) : null;
  return hit && Date.now() - hit.at < maxAgeMs ? hit.report : null;
}

/** Store a report computed elsewhere (the worker) as this process's cached copy. */
function remember(workspaceId, report) {
  if (workspaceId && report) cache.set(workspaceId, { at: Date.now(), report });
}

// ---------------------------------------------------------------------------------------------
// Per-item judgement
// ---------------------------------------------------------------------------------------------

function contentAgeable(c) {
  if (!c) return false;
  if (c.mime_type === HOLD_MIME || LIVE_MIMES.includes(c.mime_type)) return false;
  // A remote web page renders whatever the site says today.
  if (c.remote_url && /^text\/html/i.test(c.mime_type || '')) return false;
  return true;
}

function parseJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/*
 * The words on a widget, as the date reader's parts. Slides keep their words in config.fields
 * (lib/slide-render.js: the template/record split); other authored widgets in a few known keys.
 * A field with a data-source placeholder ({{...}}) or a URL is skipped: its words are not the
 * operator's, and a URL is full of digits that are not dates.
 */
function widgetTextParts(w) {
  const cfg = parseJson(w.config) || {};
  const parts = [];
  const take = (v) => {
    if (typeof v !== 'string' || !v.trim()) return;
    if (v.includes('{{') || /^\s*https?:\/\//i.test(v)) return;
    parts.push({ text: v.slice(0, 2000), source: 'text' });
  };
  if (w.widget_type === 'slide') {
    const f = cfg.fields && typeof cfg.fields === 'object' ? cfg.fields : {};
    for (const v of Object.values(f).slice(0, 64)) take(v);
  } else {
    for (const [k, v] of Object.entries(cfg).slice(0, 64)) if (TEXT_KEYS.has(k)) take(v);
  }
  return parts;
}

function itemFromContent(c, now) {
  return {
    type: 'content', id: c.id, name: c.filename, kind: c.mime_type,
    ageable: contentAgeable(c),
    last_changed: Math.max(c.created_at || 0, c.updated_at || 0) || null,
    expires_at: c.expires_at || null,
    textParts: [{ text: c.filename || '', source: 'name' }],
    expired: !!(c.expires_at && c.expires_at <= now),
  };
}

function itemFromWidget(w) {
  return {
    type: 'widget', id: w.id, name: w.name, kind: w.widget_type,
    ageable: AGEABLE_WIDGETS.has(w.widget_type),
    last_changed: Math.max(w.created_at || 0, w.updated_at || 0) || null,
    expires_at: null,
    textParts: [{ text: w.name || '', source: 'name' }, ...widgetTextParts(w)],
    expired: false,
  };
}

/** Flags and status for one item, independent of any screen. Mutates and returns `it`. */
function judgeItem(it, settings, now) {
  it.flags = [];
  const anchor = it.last_changed || now;
  const pd = dates.pastDateInParts(it.textParts, { now, anchor });
  if (pd) {
    it.flags.push({ code: 'past_date', date: pd.date, match: pd.match, inferred: pd.inferred,
      changed: new Date(anchor * 1000).toISOString().slice(0, 10), explain: pd.explain });
  }
  else {
    for (const p of it.textParts) {
      const os = dates.outOfSeason(p.text, { now, source: p.source });
      if (os) { it.flags.push({ code: 'out_of_season', holiday: os.holiday, explain: os.explain }); break; }
    }
  }
  if (it.expired) {
    const when = new Date(it.expires_at * 1000).toISOString().slice(0, 10);
    it.flags.push({ code: 'expired_assigned', date: when,
      explain: `Its expiry date (${when}) has passed, so it no longer plays, but it is still in a playlist.` });
  }
  it.age_days = it.ageable && it.last_changed ? Math.max(0, Math.floor((now - it.last_changed) / DAY)) : null;
  it.status = statusFor(it.age_days, settings);
  if (it.status === 'stale' || it.status === 'very_stale') {
    it.flags.push({ code: it.status, days: it.age_days,
      explain: `Nobody has changed this in ${it.age_days} days.` });
  }
  delete it.textParts;
  return it;
}

function statusFor(ageDays, s) {
  if (ageDays == null) return 'live';
  if (ageDays >= s.very_stale_days) return 'very_stale';
  if (ageDays >= s.stale_days) return 'stale';
  return 'fresh';
}

const SEVERITY = { past_date: 3, expired_assigned: 3, very_stale: 2, out_of_season: 2, stale: 1 };
function severity(flags) { return (flags || []).reduce((m, f) => Math.max(m, SEVERITY[f.code] || 0), 0); }

// ---------------------------------------------------------------------------------------------
// The workspace report
// ---------------------------------------------------------------------------------------------

/**
 * Everything the Freshness page, the chips, the Simple home line and the digest need, for one
 * workspace. Every query is scoped by `workspaceId`; nothing here takes a resource id from a caller.
 */
/*
 * ⚠️ PROOF-OF-PLAY IS READ ONE SCREEN AND ONE DAY AT A TIME, NEVER AS ONE STATEMENT.
 *
 * The single GROUP BY this replaced read every play in the window in one go: a workspace whose 28
 * screens log a play every 11 s is ~900k rows a week, 3-13 s on production. On the main thread that
 * froze the whole server (every heartbeat, every page) for its duration; the dashboard chips and the
 * 09:00 digest both ran it. Moving it to a worker (lib/freshness-runner.js) is not enough on its own:
 * one long statement holds a read snapshot for its whole run, and the WAL checkpoint's TRUNCATE waits
 * on that snapshot while holding the write lock, which stalls every main-thread write instead.
 *
 * Each slice is its own short statement (its own snapshot) on the (device_id, started_at) index, so
 * the checkpoint is never kept waiting longer than one slice. The sums add up to exactly what the one
 * statement returned: the slices partition the window by device and by [start, end) time.
 */
const _playSliceSql = `
    SELECT content_id, widget_id, COUNT(*) AS n, SUM(COALESCE(duration_sec, 10)) AS secs
      FROM play_logs
     WHERE device_id = ? AND workspace_id = ? AND started_at >= ? AND started_at < ?
     GROUP BY content_id, widget_id`;
function playsInWindow(db, workspaceId, deviceIds, since, now) {
  const stmt = db.prepare(_playSliceSql);
  // The last slice is open-ended, like the one statement was: a play stamped ahead of this clock (a
  // player whose clock runs fast) still counts.
  const OPEN = Number.MAX_SAFE_INTEGER;
  const out = [];
  for (const deviceId of deviceIds) {
    const byKey = new Map();
    for (let from = since; from <= now; from += DAY) {
      const to = from + DAY > now ? OPEN : from + DAY;
      for (const r of stmt.all(deviceId, workspaceId, from, to)) {
        const key = JSON.stringify([r.content_id, r.widget_id]);
        const acc = byKey.get(key);
        if (acc) { acc.n += r.n; acc.secs += r.secs || 0; }
        else byKey.set(key, { device_id: deviceId, content_id: r.content_id, widget_id: r.widget_id, n: r.n, secs: r.secs || 0 });
      }
    }
    for (const v of byKey.values()) out.push(v);
  }
  return out;
}

function computeWorkspace(db, workspaceId, { now = nowSec(), useCache = true, keep = true } = {}) {
  if (!workspaceId) return null;
  if (useCache) {
    const hit = cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
  }
  const settings = getSettings(db, workspaceId);
  const snoozes = activeSnoozes(db, workspaceId, now);
  const since = now - settings.window_days * DAY;

  const devices = db.prepare(`
    SELECT d.id, d.name, d.status, r.playlist_id
      FROM devices d LEFT JOIN device_resolved_playlist r ON r.device_id = d.id
     WHERE d.workspace_id = ?`).all(workspaceId);
  const playlists = db.prepare('SELECT id, name, status, smart_rules, updated_at FROM playlists WHERE workspace_id = ?').all(workspaceId);
  const plById = new Map(playlists.map((p) => [p.id, p]));
  const rawItems = db.prepare(`
    SELECT pi.playlist_id, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.duration_sec, pi.created_at
      FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
     WHERE p.workspace_id = ? AND COALESCE(pi.enabled, 1) = 1`).all(workspaceId);
  const itemsByPl = new Map();
  for (const r of rawItems) {
    if (!itemsByPl.has(r.playlist_id)) itemsByPl.set(r.playlist_id, []);
    itemsByPl.get(r.playlist_id).push(r);
  }

  // Proof-of-play, per device and item, over the window. The device list is this workspace's, and
  // the snapshotted play_logs.workspace_id must agree (lib/play-report.js says why).
  const plays = playsInWindow(db, workspaceId, devices.map((d) => d.id), since, now);

  const content = new Map();
  for (const c of db.prepare(`SELECT id, filename, mime_type, remote_url, created_at, updated_at, expires_at
                                FROM content WHERE workspace_id = ?`).all(workspaceId)) content.set(c.id, c);
  const widgets = new Map();
  for (const w of db.prepare('SELECT id, name, widget_type, config, created_at, updated_at FROM widgets WHERE workspace_id = ?').all(workspaceId)) widgets.set(w.id, w);

  // Item judgements, built lazily for items that are in use.
  const items = new Map();
  const itemFor = (contentId, widgetId) => {
    const key = contentId ? `content:${contentId}` : widgetId ? `widget:${widgetId}` : null;
    if (!key) return null;
    if (items.has(key)) return items.get(key);
    let it = null;
    if (contentId && content.has(contentId)) it = itemFromContent(content.get(contentId), now);
    else if (widgetId && widgets.has(widgetId)) it = itemFromWidget(widgets.get(widgetId));
    if (!it) { items.set(key, null); return null; }
    judgeItem(it, settings, now);
    it.key = key;
    it.snoozed_until = snoozes.get(key) || null;
    it.play_seconds = 0;
    it.playlists = new Set();
    it.devices = new Set();
    items.set(key, it);
    return it;
  };

  // A playlist's leaf rows, nested children expanded (depth- and cycle-guarded).
  const leaves = (playlistId, depth = 0, seen = new Set()) => {
    if (!playlistId || depth > MAX_NESTING || seen.has(playlistId)) return [];
    seen.add(playlistId);
    const out = [];
    for (const r of itemsByPl.get(playlistId) || []) {
      if (r.child_playlist_id) out.push(...leaves(r.child_playlist_id, depth + 1, seen));
      else out.push(r);
    }
    return out;
  };

  // Item ages and workspace-wide play seconds.
  const playsByDevice = new Map();
  for (const p of plays) {
    if (!playsByDevice.has(p.device_id)) playsByDevice.set(p.device_id, []);
    playsByDevice.get(p.device_id).push(p);
    const it = itemFor(p.content_id, p.widget_id);
    if (it) { it.play_seconds += p.secs || 0; it.devices.add(p.device_id); }
  }

  // Playlists that are "in use": resolved by a screen in this workspace, or published.
  const inUse = new Set(devices.map((d) => d.playlist_id).filter(Boolean));
  for (const p of playlists) if (p.status === 'published') inUse.add(p.id);
  for (const plId of inUse) {
    if (!plById.has(plId)) continue;
    for (const r of leaves(plId)) {
      const it = itemFor(r.content_id, r.widget_id);
      if (it) it.playlists.add(plId);
    }
  }

  /*
   * Weighted age over a list of { it, weight, added_at }. Only ageable, unsnoozed, unexpired items
   * count. An item's age here is since its last change OR its arrival in the playlist, whichever is
   * later.
   */
  const weigh = (entries) => {
    let w = 0, sum = 0, newest = null;
    for (const e of entries) {
      // An expired item no longer plays (the expiry sweep took it off), so it shows nobody anything.
      if (!e.it || !e.it.ageable || e.it.snoozed_until || e.it.expired || !e.it.last_changed) continue;
      const since = Math.max(e.it.last_changed, e.added_at || 0);
      const weight = Math.max(0, e.weight || 0) || 1;
      w += weight; sum += weight * Math.max(0, (now - since) / DAY);
      if (newest == null || since > newest) newest = since;
    }
    if (!w) return { age_days: null, newest_change: null, weight: 0 };
    return { age_days: Math.round((sum / w) * 10) / 10, newest_change: newest, weight: w };
  };
  const flagSummary = (its) => {
    const counts = {};
    for (const it of its) {
      if (!it || it.snoozed_until) continue;
      for (const f of it.flags) counts[f.code] = (counts[f.code] || 0) + 1;
    }
    return counts;
  };

  // Screens.
  const wsEntries = [];
  const deviceOut = devices.map((d) => {
    const addedAt = new Map();
    for (const r of leaves(d.playlist_id)) {
      const k = r.content_id ? `content:${r.content_id}` : `widget:${r.widget_id}`;
      addedAt.set(k, Math.max(addedAt.get(k) || 0, r.created_at || 0));
    }
    let basis = 'none';
    let entries = [];
    const dp = playsByDevice.get(d.id) || [];
    if (dp.length) {
      basis = 'plays';
      entries = dp.map((p) => {
        const it = itemFor(p.content_id, p.widget_id);
        return { it, weight: p.secs, added_at: it ? addedAt.get(it.key) : 0 };
      });
    } else if (d.playlist_id) {
      basis = 'assigned';
      entries = leaves(d.playlist_id).map((r) => ({ it: itemFor(r.content_id, r.widget_id), weight: r.duration_sec || 10, added_at: r.created_at }));
    }
    for (const e of entries) if (e.it) e.it.devices.add(d.id);
    wsEntries.push(...entries);
    const wv = weigh(entries);
    const its = [...new Set(entries.map((e) => e.it).filter(Boolean))];
    const flags = flagSummary(its);
    const status = statusFor(wv.age_days == null ? null : Math.floor(wv.age_days), settings);
    return {
      id: d.id, name: d.name, online: d.status === 'online', playlist_id: d.playlist_id || null,
      basis, age_days: wv.age_days, newest_change: wv.newest_change, status, flags,
      items: its.length,
      snoozed_until: snoozes.get(`device:${d.id}`) || null,
      explain: explainScreen(basis, wv, status, settings),
    };
  });

  // Playlists in use.
  const playlistOut = [];
  for (const p of playlists) {
    if (!inUse.has(p.id)) continue;
    const rows = leaves(p.id);
    const its = rows.map((r) => itemFor(r.content_id, r.widget_id));
    const anyPlays = its.some((it) => it && it.play_seconds > 0);
    const entries = rows.map((r, i) => ({ it: its[i], weight: anyPlays ? (its[i] ? its[i].play_seconds : 0) : (r.duration_sec || 10), added_at: r.created_at }));
    const wv = weigh(anyPlays ? entries.filter((e) => e.weight > 0) : entries);
    const status = statusFor(wv.age_days == null ? null : Math.floor(wv.age_days), settings);
    playlistOut.push({
      id: p.id, name: p.name, smart: !!p.smart_rules, age_days: wv.age_days, newest_change: wv.newest_change,
      status, flags: flagSummary([...new Set(its.filter(Boolean))]),
      screens: devices.filter((d) => d.playlist_id === p.id).length,
      snoozed_until: snoozes.get(`playlist:${p.id}`) || null,
      explain: explainScreen(anyPlays ? 'plays' : 'assigned', wv, status, settings),
    });
  }

  // Items in use, worst first.
  const itemOut = [];
  for (const it of items.values()) {
    if (!it) continue;
    if (!it.playlists.size && !it.play_seconds) continue;
    itemOut.push({
      type: it.type, id: it.id, name: it.name, kind: it.kind, ageable: it.ageable,
      last_changed: it.last_changed, age_days: it.age_days, status: it.status, flags: it.flags,
      expires_at: it.expires_at, play_seconds: it.play_seconds,
      playlists: [...it.playlists].map((id) => ({ id, name: plById.get(id) ? plById.get(id).name : '' })),
      screens: it.devices.size, snoozed_until: it.snoozed_until,
    });
  }
  itemOut.sort((a, b) => (severity(b.flags) - severity(a.flags)) || (b.play_seconds - a.play_seconds) || ((b.age_days || 0) - (a.age_days || 0)));

  const wsW = weigh(wsEntries);
  const dark = darkness(db, workspaceId, now);
  const activeDevices = deviceOut.filter((d) => !d.snoozed_until);
  const report = {
    workspace_id: workspaceId,
    generated_at: now,
    settings,
    workspace: {
      age_days: wsW.age_days,
      status: statusFor(wsW.age_days == null ? null : Math.floor(wsW.age_days), settings),
      dark: dark.dark, last_editor_login: dark.last_login,
    },
    counts: {
      screens: deviceOut.length,
      stale_screens: activeDevices.filter((d) => d.status === 'stale').length,
      very_stale_screens: activeDevices.filter((d) => d.status === 'very_stale').length,
      past_date_items: itemOut.filter((i) => !i.snoozed_until && i.flags.some((f) => f.code === 'past_date')).length,
      out_of_season_items: itemOut.filter((i) => !i.snoozed_until && i.flags.some((f) => f.code === 'out_of_season')).length,
      expired_assigned_items: itemOut.filter((i) => !i.snoozed_until && i.flags.some((f) => f.code === 'expired_assigned')).length,
      stale_items: itemOut.filter((i) => !i.snoozed_until && (i.status === 'stale' || i.status === 'very_stale')).length,
    },
    devices: deviceOut,
    playlists: playlistOut,
    items: itemOut,
  };
  // keep:false is the worker's: its copy of this module is not the cache anyone reads from.
  if (keep) cache.set(workspaceId, { at: Date.now(), report });
  return report;
}

function explainScreen(basis, wv, status, s) {
  if (wv.age_days == null) {
    return basis === 'none' ? 'Nothing is assigned and nothing played recently.'
      : 'Everything here is live (web pages, streams, live widgets) or snoozed, so it has no age.';
  }
  const how = basis === 'plays' ? `what played in the last ${s.window_days} days, weighted by play time`
    : 'its playlist, weighted by how long each item shows (no plays were recorded recently)';
  const lead = `On average, ${how} was last changed ${Math.floor(wv.age_days)} days ago.`;
  if (status === 'very_stale') return `${lead} That is past this workspace's "very stale" mark of ${s.very_stale_days} days.`;
  if (status === 'stale') return `${lead} That is past this workspace's "stale" mark of ${s.stale_days} days.`;
  return lead;
}

/*
 * "Dark": no admin or editor has signed in for DARK_DAYS. The people counted are the workspace's own
 * admins and editors plus its organization's owners and admins (who can act in it). A person who
 * has never signed in counts from when their account was made, and a workspace younger than
 * DARK_DAYS is never dark — a new team is not a neglected one.
 */
function darkness(db, workspaceId, now) {
  try {
    const ws = db.prepare('SELECT organization_id, created_at FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws) return { dark: false, last_login: null };
    const r = db.prepare(`
      SELECT MAX(COALESCE(u.last_login, u.created_at)) AS t FROM users u
       WHERE u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role IN ('workspace_admin','workspace_editor')
                      UNION SELECT user_id FROM organization_members WHERE organization_id = ? AND role IN ('org_owner','org_admin'))`)
      .get(workspaceId, ws.organization_id);
    const last = r && r.t ? r.t : null;
    const young = ws.created_at && now - ws.created_at < DARK_DAYS * DAY;
    return { dark: !young && (!last || now - last >= DARK_DAYS * DAY), last_login: last };
  } catch (_) { return { dark: false, last_login: null }; }
}

/**
 * The compact form the chips use: per id, a status, the flag codes and one tooltip sentence each.
 * Snoozed things are omitted — a snooze is "stop telling me".
 */
function chipsFrom(report) {
  const out = { devices: {}, playlists: {}, content: {}, widgets: {} };
  if (!report) return out;
  const s = report.settings;
  // Structured, so the dashboard can say it in the viewer's language; `explain` is the English
  // sentence the digest and the API use.
  const group = (g, basis) => {
    const reasons = [];
    if (g.status === 'stale' || g.status === 'very_stale') {
      reasons.push({ code: g.status, days: Math.floor(g.age_days), basis,
        mark: g.status === 'very_stale' ? s.very_stale_days : s.stale_days, window: s.window_days, explain: g.explain });
    }
    if (g.flags.past_date) reasons.push({ code: 'past_date', count: g.flags.past_date });
    if (g.flags.expired_assigned) reasons.push({ code: 'expired_assigned', count: g.flags.expired_assigned });
    return reasons;
  };
  for (const d of report.devices) {
    if (d.snoozed_until) continue;
    const reasons = group(d, d.basis);
    if (reasons.length) out.devices[d.id] = { status: d.status, age_days: d.age_days, reasons };
  }
  for (const p of report.playlists) {
    if (p.snoozed_until) continue;
    const reasons = group(p, 'playlist');
    if (reasons.length) out.playlists[p.id] = { status: p.status, age_days: p.age_days, reasons };
  }
  for (const i of report.items) {
    if (i.snoozed_until || !i.flags.length) continue;
    (i.type === 'content' ? out.content : out.widgets)[i.id] = { status: i.status, age_days: i.age_days, reasons: i.flags };
  }
  return out;
}

module.exports = {
  DEFAULTS, DARK_DAYS, SNOOZE_TYPES,
  getSettings, validateSettings, saveSettings, activeSnoozes, resourceWorkspace, invalidate, cached, remember, generation,
  computeWorkspace, playsInWindow, chipsFrom, statusFor, contentAgeable, widgetTextParts, darkness,
};
