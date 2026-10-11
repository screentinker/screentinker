#!/usr/bin/env node
'use strict';
/*
 * Vector tests for the Roku player's pure BrightScript libraries, run in brs-node.
 *
 *   node roku/tests/run-vectors.js            (Node 22; see roku/tests/README.md)
 *
 * What it does:
 *   1. Reads shared/schedule-vectors.json and shared/power-window-vectors.json, and for every
 *      vector builds the tz_table the server would send for the vector's IANA zone (offset spans
 *      found with Intl at minute precision around utc_now).
 *   2. Generates extra cases: ST_LocalParts against Intl over many zones/instants, power-window
 *      next_edge_ms against a minute-by-minute Intl brute force, and play-order index sequences
 *      from tizen/js/play-order.js driven by a seeded LCG.
 *   3. Writes a fixture into a temp pkg root next to copies of roku/source/lib/{tz,schedule,
 *      powerwindow,playorder}.brs + roku/tests/brs/test_main.brs, runs brs-node on it, and
 *      parses the FAIL / COUNT lines.
 *   4. Repeats the zone-dependent cases with NO table (tz_table null) with brs-node's TZ set to
 *      the vector's zone, to exercise the roDateTime.ToLocalTime() fallback.
 * Exits non-zero on any FAIL, on a missing COUNT/DONE line, or when brs-node crashes.
 *
 * Env: BRS_CLI = path to brs-node's bin/brs.cli.js (default: roku/node_modules, then the repo's;
 *      node_modules); NODE_FOR_BRS = node binary used to run it (default: this node).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROKU = path.resolve(__dirname, '..');
const REPO = path.resolve(ROKU, '..');
const LIBS = ['tz.brs', 'schedule.brs', 'powerwindow.brs', 'playorder.brs'];

const PlayOrder = require(path.join(REPO, 'tizen/js/play-order.js'));
const PowerWindow = require(path.join(REPO, 'server/lib/power-window.js'));
const ScheduleEval = require(path.join(REPO, 'server/lib/schedule-eval.js'));
// The real payload builder's table, when this checkout has it (cross-checks buildTable below).
let ServerTz = null;
try { ServerTz = require(path.join(REPO, 'server/lib/tz-table.js')); } catch (_) { ServerTz = null; }

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAIN_RUN_TZ = 'America/New_York';   // the "device zone" brs-node runs in for table mode

// --------------------------------------------------------------------------------------------
// Intl helpers (the reference)
// --------------------------------------------------------------------------------------------

const fmtCache = new Map();
function fmt(zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short', era: 'short',
    });
    fmtCache.set(zone, f);
  }
  return f;
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const p2 = (n) => String(n).padStart(2, '0');

function intlParts(zone, ms) {
  const p = {};
  for (const x of fmt(zone).formatToParts(new Date(ms))) p[x.type] = x.value;
  let year = +p.year;
  if (p.era === 'BC' || p.era === 'B') year = 1 - year;
  const hour = (+p.hour) % 24;
  const r = { year, month: +p.month, day: +p.day, hour, minute: +p.minute, second: +p.second, dow: DOW[p.weekday] };
  const d = new Date(0);                                          // setUTCFullYear avoids the 0-99 quirk
  d.setUTCFullYear(year, r.month - 1, r.day);
  d.setUTCHours(r.hour, r.minute, r.second, 0);
  r.offset_min = Math.round((d.getTime() - Math.floor(ms / 1000) * 1000) / MIN);
  r.ymd = String(year).padStart(4, '0') + '-' + p2(r.month) + '-' + p2(r.day);
  r.hm = p2(r.hour) + ':' + p2(r.minute);
  r.minuteOfDay = r.hour * 60 + r.minute;
  return r;
}
const offsetAt = (zone, ms) => intlParts(zone, ms).offset_min;

function zoneValid(zone) {
  try { fmt(zone); return true; } catch (_) { return false; }
}

/*
 * The tz_table the server would send: spans covering [from, to], one per UTC-offset run, with
 * from_ms at the exact minute the offset changes. Scanned at 15 min then bisected to the minute.
 * An unresolvable zone gets a UTC table labelled zone 'UTC', exactly as server/lib/tz-table.js
 * does (the Roku notices the label does not match the schedule's zone — see powerwindow.brs).
 */
function buildTable(zone, nowMs, backMs = DAY, fwdMs = 3 * DAY) {
  if (!zoneValid(zone)) return Object.assign(buildTable('UTC', nowMs, backMs, fwdMs), { zone: 'UTC' });
  const start = Math.floor((nowMs - backMs) / MIN) * MIN;
  const end = nowMs + fwdMs;
  const spans = [{ from_ms: start, offset_min: offsetAt(zone, start) }];
  const STEP = 15 * MIN;
  let a = start, oa = spans[0].offset_min;
  while (a < end) {
    const b = Math.min(a + STEP, end + MIN);
    const ob = offsetAt(zone, b);
    if (ob !== oa) {
      let lo = a, hi = b;                       // offset(lo) = oa, offset(hi) != oa
      while (hi - lo > MIN) {
        const mid = lo + Math.floor((hi - lo) / MIN / 2) * MIN;
        if (offsetAt(zone, mid) === oa) lo = mid; else hi = mid;
      }
      spans.push({ from_ms: hi, offset_min: offsetAt(zone, hi) });
      oa = offsetAt(zone, hi);
      a = hi;
      continue;
    }
    a = b; oa = ob;
  }
  return { zone, generated_ms: nowMs, spans };
}

// --------------------------------------------------------------------------------------------
// Case builders
// --------------------------------------------------------------------------------------------

// mode: 'table' = buildTable (Intl, here), 'server' = server/lib/tz-table.js, 'device' = no table.
function tableFor(mode, zone, ms, fwdMs) {
  if (mode === 'device') return null;
  if (mode === 'server') return ServerTz.tzTable(zone, ms);
  return buildTable(zone, ms, DAY, fwdMs);
}

function scheduleCases(mode) {
  const file = 'shared/schedule-vectors.json';
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const out = [];
  doc.vectors.forEach((v, i) => {
    const ms = Date.parse(v.utc_now);
    const item = { schedules: v.blocks };
    if (v.window) { item.play_from = v.window.play_from; item.play_until = v.window.play_until; }
    // Self-check: the JS implementation agrees with its own contract.
    const js = ScheduleEval.isItemActiveNow(v.blocks, ms, v.timezone, v.window || null);
    if (js !== v.expected) throw new Error(`schedule-eval.js disagrees with vector ${i}`);
    out.push({
      kind: 'schedule', file, id: `#${i} ${v.description}`, zone: v.timezone,
      utc_ms: ms, tz_table: tableFor(mode, v.timezone, ms, 3 * DAY),
      item, expect: v.expected,
    });
  });
  return out;
}

// Reference next edge: first UTC minute after `ms` whose state differs, brute force over 8 days
// using Intl local parts + power-window.js's own windowCovers. null = none.
function refNextEdge(schedule, ms, zone) {
  if (!schedule || schedule.enabled === false) return null;
  const w = schedule.windows;
  if (!w || !w.length || !zoneValid(zone)) return null;
  const offAt = (t) => {
    const lp = intlParts(zone, t);
    for (const x of w) if (PowerWindow._windowCovers(x, lp.dow, lp.minuteOfDay)) return true;
    return false;
  };
  const now = offAt(ms);
  if (now !== PowerWindow.isOff(Object.assign({}, schedule, { timezone: zone }), ms)) {
    throw new Error('reference brute force disagrees with PowerWindow.isOff');
  }
  const t0 = Math.floor(ms / MIN) * MIN;
  for (let k = 1; k <= 8 * 1440; k++) {
    const t = t0 + k * MIN;
    if (offAt(t) !== now) {
      // Cross-check against the JS nextEdge's local stamp when no offset change lies between.
      if (offsetAt(zone, ms) === offsetAt(zone, t)) {
        const je = PowerWindow.nextEdge(Object.assign({}, schedule, { timezone: zone }), ms);
        const lp = intlParts(zone, t);
        if (!je || je.at !== lp.hm) throw new Error(`nextEdge cross-check failed at ${new Date(ms).toISOString()} ${zone}`);
      }
      return t;
    }
  }
  return null;
}

function powerVectorCases(mode) {
  const file = 'shared/power-window-vectors.json';
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const out = [];
  doc.vectors.forEach((v, i) => {
    const ms = Date.parse(v.utc_now);
    if (PowerWindow.isOff({ enabled: v.enabled, timezone: v.timezone, windows: v.windows }, ms) !== v.expect.off) {
      throw new Error(`power-window.js disagrees with vector ${i}`);
    }
    const zone = v.timezone || MAIN_RUN_TZ;            // null zone = the device's own clock
    const schedule = { enabled: v.enabled, timezone: v.timezone, windows: v.windows };
    const tz_table = v.timezone ? tableFor(mode, v.timezone, ms, 9 * DAY) : null;
    out.push({
      kind: 'power', file, id: `#${i} ${v.name}`, zone: v.timezone,
      utc_ms: ms, tz_table, schedule, check_edge: mode !== 'server',
      expect: { on: !v.expect.off, next_edge_ms: refNextEdge(schedule, ms, zone) },
    });
  });
  return out;
}

// Deterministic pseudo-random for case generation (NOT the play-order LCG).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function transitionsIn(zone, fromMs, toMs) {
  return buildTable(zone, fromMs, 0, toMs - fromMs).spans.slice(1).map((s) => s.from_ms);
}

const EDGE_ZONES = ['America/Chicago', 'Australia/Sydney', 'Australia/Lord_Howe', 'Europe/Berlin', 'Asia/Kathmandu'];
const EDGE_SCHEDULES = [
  { name: 'weekdays 22:00-06:00', windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }] },
  { name: 'daily 01:00-03:00 (spans US/EU gaps)', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '03:00' }] },
  { name: 'daily 02:15-02:45 (inside a gap)', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '02:15', end: '02:45' }] },
  { name: 'Sun 01:30-02:30', windows: [{ days: [0], start: '01:30', end: '02:30' }] },
  { name: 'Mon 22:00-24:00 + Tue 09:00-17:00', windows: [{ days: [1], start: '22:00', end: '24:00' }, { days: [2], start: '09:00', end: '17:00' }] },
  { name: 'always off', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] },
  { name: 'junk + good', windows: [{ days: [3], start: 'x', end: '17:00' }, { days: [3, 6], start: '12:00', end: '12:01' }] },
  { name: 'disabled', enabled: false, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '12:00' }] },
  { name: 'only junk', windows: [{ days: [1], start: '25:00', end: '06:00' }, { days: [1], start: '07:00', end: '07:00' }] },
];

function powerEdgeCases(mode, zones) {
  const file = 'power-next-edge (generated vs Intl brute force)';
  const rnd = mulberry32(20261011);
  const out = [];
  const y0 = Date.parse('2026-01-01T00:00:00Z'), y1 = Date.parse('2027-01-01T00:00:00Z');
  for (const zone of zones) {
    const trans = transitionsIn(zone, y0, y1);
    const instants = [];
    for (const t of trans) instants.push(t - 3 * HOUR - 17 * 1000, t - 30 * MIN, t, t + 45 * MIN + 1234);
    for (let i = 0; i < 4; i++) instants.push(y0 + Math.floor(rnd() * (y1 - y0)));
    for (const ms of instants) {
      for (const s of EDGE_SCHEDULES) {
        const schedule = { enabled: s.enabled !== false, timezone: zone, windows: s.windows };
        out.push({
          kind: 'power', file, id: `${zone} ${new Date(ms).toISOString()} ${s.name}`, zone,
          utc_ms: ms, tz_table: mode === 'table' ? buildTable(zone, ms, DAY, 9 * DAY) : null,
          schedule, check_edge: true,
          expect: { on: !PowerWindow.isOff(schedule, ms), next_edge_ms: refNextEdge(schedule, ms, zone) },
        });
      }
    }
  }
  return out;
}

function powerZoneCases() {
  const file = 'power-zone (generated)';
  const ms = Date.parse('2026-09-22T21:00:00Z');            // Tue 16:00 Chicago, 23:00 Berlin
  const always = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }];
  const tue22 = [{ days: [2], start: '22:00', end: '06:00' }];
  const chi = buildTable('America/Chicago', ms, DAY, 9 * DAY);
  const ber = buildTable('Europe/Berlin', ms, DAY, 9 * DAY);
  const c = (id, schedule, tz_table, on, edgeZone) => ({
    kind: 'power', file, id, utc_ms: ms, tz_table, schedule, check_edge: true,
    expect: { on, next_edge_ms: edgeZone ? refNextEdge(schedule, ms, edgeZone) : null },
  });
  return [
    c('schedule zone differs from the table zone -> lit, no edge', { enabled: true, timezone: 'Europe/Berlin', windows: always }, chi, true, null),
    c('schedule zone matches the table zone', { enabled: true, timezone: 'America/Chicago', windows: tue22 }, chi, true, 'America/Chicago'),
    c('schedule without a zone uses the table', { enabled: true, timezone: null, windows: tue22 }, ber, false, 'Europe/Berlin'),
    c('powerSchedule.tz_table overrides the playlist table', { enabled: true, timezone: 'Europe/Berlin', windows: tue22, tz_table: ber }, chi, false, 'Europe/Berlin'),
    c('unknown zone: server sends a UTC table -> lit', { enabled: true, timezone: 'Not/AZone', windows: always }, buildTable('Not/AZone', ms), true, null),
    c('table with no usable spans -> lit', { enabled: true, timezone: 'America/Chicago', windows: always }, { zone: 'America/Chicago', spans: [] }, true, null),
    c('table with malformed spans only -> lit', { enabled: true, windows: always }, { zone: 'X', spans: [{ from_ms: 'x', offset_min: 0 }, null, { offset_min: 60 }] }, true, null),
    c('table with one good span among junk is usable', { enabled: true, windows: always }, { spans: [{ from_ms: 'x' }, { from_ms: 0, offset_min: 60 }] }, false, null),
    c('null schedule -> lit', null, chi, true, null),
    c('enabled 0 is NOT disabled (JS: === false only)', { enabled: 0, timezone: 'America/Chicago', windows: always }, chi, false, null),
  ];
}

const LP_ZONES = ['UTC', 'America/Chicago', 'America/New_York', 'America/St_Johns', 'America/Santiago',
  'America/Sao_Paulo', 'Europe/Berlin', 'Europe/London', 'Asia/Kathmandu', 'Asia/Kolkata', 'Asia/Tehran',
  'Australia/Sydney', 'Australia/Lord_Howe', 'Australia/Adelaide', 'Pacific/Chatham', 'Pacific/Auckland',
  'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Pacific/Apia', 'Africa/Casablanca'];

function localPartsCases(mode, zones) {
  const file = 'tz-localparts (generated vs Intl)';
  const rnd = mulberry32(42);
  const out = [];
  const push = (zone, ms, label) => {
    const e = intlParts(zone, ms);
    out.push({
      kind: 'localparts', file, id: `${zone} ${label || new Date(ms).toISOString()}`, zone,
      utc_ms: ms, tz_table: mode === 'table' ? buildTable(zone, ms) : null, expect: e,
    });
  };
  const lo = Date.parse('1971-01-01T00:00:00Z'), hi = Date.parse('2099-12-31T00:00:00Z');
  for (const zone of zones) {
    for (let i = 0; i < 12; i++) push(zone, lo + Math.floor(rnd() * (hi - lo)));
    // every transition in 2026, one second either side
    for (const t of transitionsIn(zone, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'))) {
      push(zone, t - 1000); push(zone, t);
    }
  }
  if (mode === 'table') {
    // calendar edges, UTC table: leap days, centuries, pre-epoch (floor division paths)
    for (const iso of ['1969-12-31T23:59:59.999Z', '1970-01-01T00:00:00Z', '1900-02-28T23:59:59Z', '1900-03-01T00:00:00Z',
      '2000-02-29T12:00:00Z', '2024-02-29T23:59:59Z', '2100-02-28T23:59:59Z', '2100-03-01T00:00:00Z',
      '1600-02-29T00:00:00Z', '0001-01-01T00:00:00Z', '2038-01-19T03:14:08Z', '2262-04-11T00:00:00Z']) {
      push('UTC', Date.parse(iso), iso);
    }
  }
  return out;
}

function lcg(seed) {
  let s = seed;
  return () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
}

function playOrderCases() {
  const file = 'play-order (generated vs tizen/js/play-order.js)';
  const out = [];
  const allowsFn = (allows) => (it, i) => (allows == null || i >= allows.length || typeof allows[i] !== 'boolean' || allows[i]);
  const add = (id, items, mode, seed, steps) => {
    const rnd = lcg(seed);
    const state = {};
    let from = -1;
    const expect = [];
    for (const a of steps) {
      const idx = PlayOrder.nextIndex(items, from, allowsFn(a), mode, state, rnd);
      expect.push(idx);
      if (idx >= 0) from = idx;
    }
    out.push({ kind: 'playorder', file, id, items, mode, seed, steps, expect, weights: items.map(PlayOrder.weightOf) });
  };
  const n = (k) => Array.from({ length: k }, () => ({}));
  const rep = (a, k) => Array.from({ length: k }, () => a);
  const T = true, F = false;

  add('sequential all eligible', n(5), 'sequential', 7, rep(null, 12));
  add('sequential partial', n(6), 'sequential', 7, rep([T, F, T, F, F, T], 10));
  add('sequential nothing eligible', n(3), 'sequential', 7, rep([F, F, F], 3));
  add('sequential empty list', [], 'sequential', 7, rep(null, 2));
  add('sequential changing eligibility', n(5), 'sequential', 7, [[T, T, T, T, T], [F, T, F, T, F], [F, F, F, F, T], [T, F, F, F, F], null, [F, F, F, F, F], [F, F, T, F, F]]);
  add('sequential short allows array (missing = eligible)', n(5), 'sequential', 7, rep([F, F], 6));
  add('unknown mode falls back to sequential', n(4), 'random', 7, rep(null, 6));
  add('empty mode falls back to sequential', n(4), '', 7, rep(null, 6));
  add('shuffle all eligible, many bags (repeat)', n(6), 'shuffle', 12345, rep(null, 60));
  add('shuffle partial eligibility', n(8), 'shuffle', 999, rep([T, F, T, T, F, T, F, T], 25));
  add('shuffle single eligible', n(4), 'shuffle', 31337, rep([F, F, T, F], 5));
  add('shuffle two items (no repeat across bag boundary)', n(2), 'shuffle', 2024, rep(null, 30));
  add('shuffle eligibility changes mid-bag', n(6), 'shuffle', 5150, [null, null, [T, T, F, F, T, T], [T, T, F, F, T, T], [F, F, F, F, F, F], [T, F, T, F, T, F], null, null, null, null, null, null]);
  add('shuffle nothing eligible', n(3), 'shuffle', 77, rep([F, F, F], 3));
  add('weighted mixed weights', [{ weight: 1 }, { weight: 5 }, { weight: 10 }, { weight: 0 }, { weight: 'x' }, { weight: 2000.7 }, { weight: 2.9 }, {}, { weight: -3 }, { weight: 0.5 }],
    'weighted', 4242, rep(null, 80));
  add('weighted partial eligibility', [{ weight: 3 }, { weight: 1 }, { weight: 7 }, { weight: 2 }], 'weighted', 8080, rep([T, F, T, T], 30));
  add('weighted single eligible repeats', [{ weight: 3 }, { weight: 1 }], 'weighted', 1, rep([F, T], 5));
  add('weighted nothing eligible', [{ weight: 3 }], 'weighted', 1, rep([F], 2));

  // fuzz: random scenarios
  const r = mulberry32(777);
  const modes = ['sequential', 'shuffle', 'weighted'];
  for (let k = 0; k < 60; k++) {
    const len = 1 + Math.floor(r() * 9);
    const items = Array.from({ length: len }, () => (r() < 0.7 ? { weight: Math.floor(r() * 12) } : (r() < 0.5 ? {} : { weight: r() * 20 })));
    const mode = modes[k % 3];
    const steps = [];
    let cur = null;
    for (let s = 0; s < 40; s++) {
      if (r() < 0.15) cur = r() < 0.2 ? null : Array.from({ length: len }, () => r() < 0.7);
      steps.push(cur);
    }
    add(`fuzz #${k} ${mode} n=${len}`, items, mode, 1 + Math.floor(r() * 2147483646), steps);
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// brs-node
// --------------------------------------------------------------------------------------------

function findBrsCli() {
  const cands = [
    process.env.BRS_CLI,
    path.join(ROKU, 'node_modules/brs-node/bin/brs.cli.js'),
    path.join(REPO, 'node_modules/brs-node/bin/brs.cli.js'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('brs-node not found; set BRS_CLI=/path/to/node_modules/brs-node/bin/brs.cli.js');
}

function runBrs(label, cases, tz) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-roku-vec-'));
  fs.mkdirSync(path.join(root, 'source/lib'), { recursive: true });
  for (const f of LIBS) fs.copyFileSync(path.join(ROKU, 'source/lib', f), path.join(root, 'source/lib', f));
  fs.copyFileSync(path.join(ROKU, 'tests/brs/test_main.brs'), path.join(root, 'source/test_main.brs'));
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ label, cases }));
  const files = ['source/test_main.brs', ...LIBS.map((f) => 'source/lib/' + f)];
  const node = process.env.NODE_FOR_BRS || process.execPath;
  const res = spawnSync(node, [findBrsCli(), '-n', '-c', '0', '-r', root, ...files], {
    cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { TZ: tz }), maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(root, { recursive: true, force: true });
  const outText = (res.stdout || '') + (res.stderr || '');
  const lines = outText.split(/\r?\n/);
  const fails = lines.filter((l) => l.startsWith('FAIL '));
  const counts = lines.filter((l) => l.startsWith('COUNT ')).map((l) => {
    const [file, pass, fail] = l.slice(6).split(' | ');
    return { file, pass: +pass, fail: +fail };
  });
  const done = lines.find((l) => l.startsWith('DONE '));
  const crashed = !done || +done.slice(5) !== cases.length || /BRIGHTSCRIPT_CRASH|ERROR/.test(outText);
  return { fails, counts, crashed, outText };
}

// --------------------------------------------------------------------------------------------

function main() {
  const t0 = Date.now();
  const runs = [];

  const tableCases = [
    ...scheduleCases('table'),
    ...powerVectorCases('table'),
    ...powerEdgeCases('table', EDGE_ZONES),
    ...localPartsCases('table', LP_ZONES),
    ...powerZoneCases(),
    ...playOrderCases(),
  ];
  runs.push({ label: `tz_table mode (brs-node TZ=${MAIN_RUN_TZ})`, cases: tableCases, tz: MAIN_RUN_TZ });

  // The same vectors on tables from the real payload builder (next_edge not checked: its table
  // stops at +73 h, the brute-force reference looks 8 days ahead).
  if (ServerTz) {
    const tag = (c) => Object.assign(c, { file: c.file + ' [server/lib/tz-table.js]' });
    runs.push({
      label: `server tz_table mode (brs-node TZ=${MAIN_RUN_TZ})`,
      cases: [...scheduleCases('server').map(tag), ...powerVectorCases('server').map(tag)], tz: MAIN_RUN_TZ,
    });
  }

  // Device-zone fallback: tz_table null, brs-node's own zone = the vector's zone.
  const devSched = scheduleCases('device');
  const devPower = powerVectorCases('device').filter((c) => c.zone && zoneValid(c.zone));
  const zones = [...new Set([...devSched, ...devPower].map((c) => c.zone))];
  for (const zone of zones) {
    const cases = [
      ...devSched.filter((c) => c.zone === zone),
      ...devPower.filter((c) => c.zone === zone),
      ...powerEdgeCases('device', [zone]),
      ...localPartsCases('device', [zone]),
    ];
    runs.push({ label: `device-zone fallback (no tz_table, brs-node TZ=${zone})`, cases, tz: zone });
  }

  let failed = false;
  for (const r of runs) {
    const res = runBrs(r.label, r.cases, r.tz);
    console.log(`\n== ${r.label}: ${r.cases.length} cases`);
    for (const c of res.counts) console.log(`   ${c.fail ? 'FAIL' : 'ok  '}  ${c.file}: ${c.pass} pass, ${c.fail} fail`);
    for (const f of res.fails.slice(0, 40)) console.log('   ' + f);
    if (res.fails.length > 40) console.log(`   ... ${res.fails.length - 40} more`);
    if (res.crashed) {
      console.log('   brs-node did not finish cleanly:\n' + res.outText.split('\n').filter((l) => !/Network Gateway/.test(l)).slice(-30).join('\n'));
    }
    if (res.fails.length || res.crashed) failed = true;
  }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASS'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}

main();
