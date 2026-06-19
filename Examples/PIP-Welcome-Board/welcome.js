'use strict';

// PIP-Welcome-Board — rotate a celebratory card (welcome / birthday / work
// anniversary) onto a ScreenTinker screen or group via the PiP overlay API,
// driven by a local CSV. Birthdays/anniversaries are shown on their day;
// 'welcome' rows show every day.
//
//   node welcome.js [--config config.json]
//
// Ctrl-C (SIGINT) clears the overlay and exits.
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

const POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

// --- pure helpers (exported for the offline test) -------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// "today" as MM-DD in LOCAL time (the same basis we compare CSV dates on).
function mmddOf(now) {
  return `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// Extract MM-DD from "MM-DD" or "YYYY-MM-DD" (returns '' if unparseable).
function mmdd(dateStr) {
  const m = String(dateStr || '').trim().match(/(\d{1,2})-(\d{1,2})$/);
  return m ? `${pad2(m[1])}-${pad2(m[2])}` : '';
}

// Year from "YYYY-MM-DD" (else null) — lets anniversaries show "<n> years".
function yearOf(dateStr) {
  const m = String(dateStr || '').trim().match(/^(\d{4})-\d{1,2}-\d{1,2}$/);
  return m ? Number(m[1]) : null;
}

// Minimal CSV parser: one record per line, comma-separated, with "quoted"
// fields that may contain commas and "" escapes. Returns array of row objects
// keyed by the header row (lower-cased). Blank lines skipped.
function parseCsv(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ''; });
    return row;
  });
}

// Which rows to show right now: dated entries (birthday/anniversary) whose
// MM-DD is today, plus every 'welcome'. If nothing qualifies and
// showAllWhenEmpty is set, fall back to all rows (so the screen isn't blank).
function todaysEntries(rows, now, opts = {}) {
  const today = mmddOf(now);
  const dated = rows.filter(
    (r) => (r.type === 'birthday' || r.type === 'anniversary') && mmdd(r.date) === today
  );
  const welcomes = rows.filter((r) => r.type === 'welcome');
  const result = [...dated, ...welcomes];
  if (result.length === 0 && opts.showAllWhenEmpty) return rows.slice();
  return result;
}

// Map a row to display fields. Accent colour by type. name is kept separate
// from the greeting so the overlay can make it prominent.
const TYPE_COLOR = { birthday: 'E8730C', anniversary: '8E44AD', welcome: '1F9D55' };

function buildMessage(entry, now) {
  const name = entry.name || '';
  const note = entry.note || '';
  if (entry.type === 'birthday') {
    return { kind: 'BIRTHDAY', emoji: '🎂', greeting: 'Happy Birthday', name, note, color: TYPE_COLOR.birthday };
  }
  if (entry.type === 'anniversary') {
    const y = yearOf(entry.date);
    const years = y != null && now ? now.getFullYear() - y : null;
    const greeting = years != null && years > 0 ? `${years} Year${years === 1 ? '' : 's'}!` : 'Happy Work Anniversary';
    return { kind: 'WORK ANNIVERSARY', emoji: '🎉', greeting, name, note, color: TYPE_COLOR.anniversary };
  }
  // default: welcome
  return { kind: 'WELCOME', emoji: '👋', greeting: 'Welcome', name, note, color: TYPE_COLOR.welcome };
}

function sanitizeColor(c) {
  const hex = String(c || '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 6 ? hex : '1F9D55';
}

// overlay_base_url + ?kind&emoji&greeting&name&note&color
function buildOverlayUri(base, view) {
  const q = new URLSearchParams({
    kind: view.kind || '',
    emoji: view.emoji || '',
    greeting: view.greeting || '',
    name: view.name || '',
    note: view.note || '',
    color: sanitizeColor(view.color),
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

// --- runtime --------------------------------------------------------------

function loadConfig(p) {
  const configPath = p || path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Could not read config at ${configPath}: ${e.message}`);
    console.error('Copy config.example.json to config.json and fill it in.');
    process.exit(1);
  }
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { args.config = argv[i + 1]; i++; }
  }
  const cfg = loadConfig(args.config);

  const apiBase = String(cfg.api_base || '').replace(/\/$/, '');
  const token = cfg.api_token;
  const target = cfg.device_id;
  const overlayBase = cfg.overlay_base_url;
  if (!apiBase || !token || !target || !overlayBase) {
    console.error('config must set api_base, api_token, overlay_base_url, and device_id.');
    process.exit(1);
  }

  const csvFile = path.isAbsolute(cfg.csv_file || '') ? cfg.csv_file : path.join(__dirname, cfg.csv_file || 'people.csv');
  let rows;
  try { rows = parseCsv(fs.readFileSync(csvFile, 'utf8')); }
  catch (e) { console.error(`could not read csv_file ${csvFile}: ${e.message}`); process.exit(1); }

  const rotateSec = cfg.rotate_interval_sec || 12;
  const position = cfg.position || 'center';
  if (!POSITIONS.includes(position)) { console.error(`invalid position; use one of: ${POSITIONS.join(', ')}`); process.exit(1); }
  const width = cfg.width || 820;
  const height = cfg.height || 300;
  const showAllWhenEmpty = cfg.show_all_when_empty !== false;

  const entries = todaysEntries(rows, new Date(), { showAllWhenEmpty });
  if (entries.length === 0) {
    console.log('no entries to show today (and show_all_when_empty is false). Nothing to do.');
    return;
  }

  console.log(`Welcome board — ${entries.length} card(s), rotating every ${rotateSec}s on ${target}`);
  entries.forEach((e) => { const v = buildMessage(e, new Date()); console.log(`  • ${v.emoji} ${v.greeting} — ${v.name}`); });

  let idx = 0;
  let currentPip = null;

  async function showNext() {
    const entry = entries[idx % entries.length];
    idx++;
    const view = buildMessage(entry, new Date());
    const uri = buildOverlayUri(overlayBase, view);
    const body = {
      device_id: target, type: 'web', uri, position, width, height,
      duration: 0, border_radius: 18, opacity: 1, close_button: false,
      title: `${view.emoji} ${view.name}`.slice(0, 200),
    };
    try {
      const { ok, status, json } = await postJson(`${apiBase}/api/pip`, token, body);
      if (!ok || !json.pip_id) { console.error(`[${new Date().toISOString()}] show failed (${status}): ${json.error || 'unknown'}`); return; }
      currentPip = json.pip_id;
      console.log(`[${new Date().toISOString()}] ${view.emoji} ${view.greeting}, ${view.name} pip=${json.pip_id} sent=${json.sent} offline=${json.offline}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] show error: ${e.message}`);
    }
  }

  await showNext();
  const timer = entries.length > 1 ? setInterval(showNext, rotateSec * 1000) : null;

  async function shutdown() {
    if (timer) clearInterval(timer);
    console.log('\nclearing overlay before exit...');
    try { await postJson(`${apiBase}/api/pip/clear`, token, currentPip ? { device_id: target, pip_id: currentPip } : { device_id: target }); } catch { /* best effort */ }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { parseCsv, mmdd, mmddOf, yearOf, todaysEntries, buildMessage, buildOverlayUri, sanitizeColor, TYPE_COLOR, POSITIONS };
