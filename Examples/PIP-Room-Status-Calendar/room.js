'use strict';

// Meeting-room "Available / Busy" sign for ScreenTinker, driven by an ICS calendar
// feed. Polls the calendar and pushes a PiP web overlay showing whether the room is
// free right now (green) or in a meeting (red), plus the next/current meeting time.
//
//   node room.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.
//
// ICS time handling: DTSTART/DTEND ending in "Z" are UTC; a bare date-time
// (YYYYMMDDTHHMMSS) is treated as the monitor host's LOCAL time; an all-day
// VALUE=DATE (YYYYMMDD) spans local midnight..midnight. TZID parameters are NOT
// resolved to their zone — a floating time is read as local. For a single room
// display whose host shares the room's timezone this is correct; cross-timezone
// calendars should publish UTC.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// ICS parsing (minimal, dependency-free) — pure, exported, offline-testable
// ---------------------------------------------------------------------------

// RFC 5545 line folding: a CRLF followed by a space or tab continues the prior
// line. Unfold first, then split into logical lines.
function unfold(ics) {
  return ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

// Parse an ICS date/-time value into epoch ms. Handles:
//   20260618T143000Z   -> UTC
//   20260618T143000    -> local (floating)
//   20260618           -> all-day, local midnight
function parseIcsDate(val) {
  if (!val) return NaN;
  const v = val.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(+y, +mo - 1, +d, 0, 0, 0).getTime(); // local midnight
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

// Split a "NAME;PARAM=x:VALUE" property line into { name, value }.
function splitProp(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const name = head.split(';')[0].toUpperCase();
  return { name, value };
}

// RFC 5545 TEXT unescaping (\n \, \; \\).
function unescapeText(s) {
  return String(s)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Extract VEVENTs as { summary, start, end } (start/end = epoch ms). Events
// without a parseable start are skipped; a missing end defaults to start (a
// zero-length event, which is never "current").
function parseIcs(ics) {
  const lines = unfold(ics).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && Number.isFinite(cur.start)) {
        events.push({
          summary: cur.summary || '(busy)',
          start: cur.start,
          end: Number.isFinite(cur.end) ? cur.end : cur.start,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = splitProp(line);
    if (!p) continue;
    if (p.name === 'DTSTART') cur.start = parseIcsDate(p.value);
    else if (p.name === 'DTEND') cur.end = parseIcsDate(p.value);
    else if (p.name === 'SUMMARY') cur.summary = unescapeText(p.value);
  }
  return events;
}

// Given events and a `now` (epoch ms), decide if the room is busy. "current" is
// the soonest-ending event covering now; "next" is the soonest event starting
// strictly after now.
function status(events, now) {
  const current = events
    .filter(e => e.start <= now && now < e.end)
    .sort((a, b) => a.end - b.end)[0] || null;
  const next = events
    .filter(e => e.start > now)
    .sort((a, b) => a.start - b.start)[0] || null;
  const trim = e => e && { summary: e.summary, start: e.start, end: e.end };
  return {
    state: current ? 'busy' : 'available',
    current: trim(current),
    next: trim(next),
    busyUntil: current ? current.end : null,
    freeUntil: !current && next ? next.start : null,
  };
}

module.exports = { parseIcs, parseIcsDate, status, unfold, unescapeText };

// ---------------------------------------------------------------------------
// Runtime (only when executed directly) — config load, PiP push, poll loop
// ---------------------------------------------------------------------------

function runMain() {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const POLL_SEC = cfg.poll_interval_sec || 120;
  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE_ID = cfg.device_id;
  const ROOM_NAME = cfg.room_name || 'Meeting Room';
  const OVERLAY = cfg.overlay || {};
  const COLORS = Object.assign({ available: '1f9d55', busy: 'CC0000' }, cfg.colors || {});

  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE_ID || (!cfg.ics_url && !cfg.ics_file)) {
    console.error('config must set api_base, api_token, overlay_base_url, device_id, and ics_url or ics_file.');
    process.exit(1);
  }

  const hhmm = ms => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Map a status result to the overlay query fields.
  function viewOf(st) {
    if (st.state === 'busy') {
      return {
        state: 'BUSY', color: COLORS.busy,
        detail: st.current ? st.current.summary : 'In a meeting',
        sub: st.busyUntil ? `until ${hhmm(st.busyUntil)}` : '',
      };
    }
    return {
      state: 'AVAILABLE', color: COLORS.available,
      detail: st.next ? `Next: ${st.next.summary}` : 'No more meetings today',
      sub: st.next ? `at ${hhmm(st.next.start)}` : '',
    };
  }

  function overlayUri(st) {
    const v = viewOf(st);
    const q = new URLSearchParams({
      state: v.state, room: ROOM_NAME, detail: v.detail || '', sub: v.sub || '',
      color: (v.color || '1f9d55').replace(/[^0-9a-fA-F]/g, ''),
    });
    return `${OVERLAY_BASE}${OVERLAY_BASE.includes('?') ? '&' : '?'}${q.toString()}`;
  }

  let activePip = null;

  async function pipShow(st) {
    const body = {
      device_id: DEVICE_ID, type: 'web', uri: overlayUri(st),
      position: OVERLAY.position || 'center',
      width: OVERLAY.width || 900, height: OVERLAY.height || 360,
      duration: 0, // persistent; we refresh each poll and clear on exit
      opacity: OVERLAY.opacity != null ? OVERLAY.opacity : 1,
      border_radius: OVERLAY.border_radius != null ? OVERLAY.border_radius : 16,
      close_button: false,
      title: ROOM_NAME,
    };
    const res = await fetch(`${API_BASE}/api/pip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
    return json.pip_id;
  }

  async function pipClear(pipId) {
    const res = await fetch(`${API_BASE}/api/pip/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ device_id: DEVICE_ID, pip_id: pipId || undefined }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(`pip clear failed (${res.status}): ${json.error || 'unknown'}`);
    }
  }

  async function loadIcs() {
    if (cfg.ics_file) return fs.readFileSync(cfg.ics_file, 'utf8');
    const res = await fetch(cfg.ics_url, { headers: { Accept: 'text/calendar' } });
    if (!res.ok) throw new Error(`ICS HTTP ${res.status}`);
    return res.text();
  }

  async function tick() {
    let events;
    try { events = parseIcs(await loadIcs()); }
    catch (e) { console.error(`[${new Date().toISOString()}] calendar load error: ${e.message}`); return; }
    const st = status(events, Date.now());
    const v = viewOf(st);
    try {
      // last-show-wins: re-pushing replaces the previous overlay with fresh state.
      const pipId = await pipShow(st);
      activePip = pipId;
      console.log(`[${new Date().toISOString()}] ${v.state} — ${v.detail} ${v.sub} (pip=${pipId})`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] show error: ${e.message}`);
    }
  }

  (async () => {
    console.log(`Room status sign starting — room="${ROOM_NAME}"`);
    console.log(`  source: ${cfg.ics_file ? `file ${cfg.ics_file}` : cfg.ics_url}`);
    console.log(`  poll: every ${POLL_SEC}s`);
    await tick();
    const timer = setInterval(tick, POLL_SEC * 1000);

    async function shutdown() {
      clearInterval(timer);
      console.log('\nclearing overlay before exit...');
      try { if (activePip) await pipClear(activePip); } catch { /* best effort */ }
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}

if (require.main === module) runMain();
