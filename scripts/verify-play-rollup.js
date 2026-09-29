#!/usr/bin/env node
'use strict';

/*
 * Read-only: does play_log_hourly agree with the raw play_logs it was built from?
 *
 * Run this on a live instance BEFORE lowering PLAY_LOG_RETENTION_DAYS. Once retention drops, the
 * raw rows the aggregate was derived from are deleted and this comparison can never be made again
 * — the aggregate becomes the only record, correct or not. This is the last moment both copies
 * exist side by side.
 *
 *   node scripts/verify-play-rollup.js
 *   node scripts/verify-play-rollup.js --days 14
 *   node scripts/verify-play-rollup.js --start 2026-09-01 --end 2026-09-15
 *   node scripts/verify-play-rollup.js --db /opt/screentinker/server/db/remote_display.db
 *
 * Exit 0 = every workspace and device agrees. Exit 1 = a discrepancy (details printed).
 * Exit 2 = nothing comparable (no overlap yet — the rollup has not run, or raw is already gone).
 *
 * ⚠️ IT COMPARES ONLY THE OVERLAP, AND ONLY WHOLE HOURS.
 *
 * The two tables genuinely disagree outside the window where both are complete, and reporting that
 * as a fault would make the script cry wolf:
 *   - above the rollup watermark, raw has hours the rollup has not aggregated yet;
 *   - below the oldest surviving raw row, the rollup has hours whose raw rows are already pruned;
 *   - the hour CONTAINING the oldest raw row may have been partially pruned, so raw is short
 *     through no fault of the rollup. The comparison starts at the next whole hour boundary.
 *
 * It opens the database READ-ONLY and runs no writes, so it is safe against a live server.
 */

const path = require('node:path');
// better-sqlite3 lives in server/node_modules, and this script sits a directory above it — the
// same resolution scripts/backfill-last-login.js uses.
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));

const HOUR = 3600;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = arg('db', path.join(__dirname, '..', 'server', 'db', 'remote_display.db'));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const epochOf = (s) => Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);
const now = Math.floor(Date.now() / 1000);
const days = parseFloat(arg('days', '30'));
let start = arg('start') ? epochOf(arg('start')) : now - Math.round(days * 86400);
let end = arg('end') ? epochOf(arg('end')) + 86400 : now;

// ── the comparable window ─────────────────────────────────────────────────────────────────────
const floorRow = db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get();
const rawFloor = floorRow && floorRow.t != null ? floorRow.t : null;
const wmRow = db.prepare('SELECT rolled_through_hour AS h FROM play_log_rollup_state WHERE id = 1').get();
const watermark = wmRow ? wmRow.h : 0;

if (rawFloor == null) {
  console.error('No raw play_logs rows at all — nothing to compare against. (Retention already applied?)');
  process.exit(2);
}
if (!watermark) {
  console.error('The rollup has never run (watermark = 0) — nothing to compare yet.');
  process.exit(2);
}

// Start at the first WHOLE hour at or after the oldest surviving raw row, end at the last hour the
// rollup has written. Clamp to whatever the caller asked for.
const loHour = Math.max(Math.ceil(rawFloor / HOUR) * HOUR, Math.ceil(start / HOUR) * HOUR);
const hiHour = Math.min(watermark, Math.floor(end / HOUR) * HOUR - HOUR);

if (hiHour < loHour) {
  console.error('No overlapping whole hours in that range — raw and rollup do not both cover any of it.');
  console.error(`  raw floor  : ${new Date(rawFloor * 1000).toISOString()}`);
  console.error(`  watermark  : ${new Date(watermark * 1000).toISOString()}`);
  process.exit(2);
}

const loEpoch = loHour;
const hiEpoch = hiHour + HOUR;   // exclusive

console.log('Comparing raw play_logs against play_log_hourly');
console.log(`  database : ${dbPath}`);
console.log(`  window   : ${new Date(loEpoch * 1000).toISOString()} .. ${new Date(hiEpoch * 1000).toISOString()}`);
console.log(`  (raw floor ${new Date(rawFloor * 1000).toISOString()}, watermark ${new Date(watermark * 1000).toISOString()})`);
console.log('');

// ── aggregate both sides identically ──────────────────────────────────────────────────────────
// COALESCE mirrors the rollup's own '' sentinel so a NULL workspace lines up on both sides rather
// than appearing as a phantom difference.
const rawRows = db.prepare(`
  SELECT COALESCE(workspace_id,'') AS ws, device_id AS dev,
         COUNT(*) AS plays, COALESCE(SUM(duration_sec),0) AS seconds
    FROM play_logs
   WHERE started_at >= ? AND started_at < ?
   GROUP BY ws, dev
`).all(loEpoch, hiEpoch);

const rollRows = db.prepare(`
  SELECT workspace_id AS ws, device_id AS dev,
         SUM(play_count) AS plays, SUM(duration_sec) AS seconds
    FROM play_log_hourly
   WHERE hour_utc >= ? AND hour_utc < ?
   GROUP BY ws, dev
`).all(loEpoch, hiEpoch);

const key = (r) => `${r.ws}\u0000${r.dev}`;
const rawBy = new Map(rawRows.map((r) => [key(r), r]));
const rollBy = new Map(rollRows.map((r) => [key(r), r]));
const allKeys = new Set([...rawBy.keys(), ...rollBy.keys()]);

const perWs = new Map();
const deviceDiffs = [];
let rawPlays = 0, rollPlays = 0, rawSecs = 0, rollSecs = 0;

for (const k of allKeys) {
  const a = rawBy.get(k) || { plays: 0, seconds: 0 };
  const b = rollBy.get(k) || { plays: 0, seconds: 0 };
  const [ws, dev] = k.split('\u0000');
  rawPlays += a.plays; rollPlays += b.plays;
  rawSecs += a.seconds; rollSecs += b.seconds;

  const w = perWs.get(ws) || { ws, rawPlays: 0, rollPlays: 0, rawSecs: 0, rollSecs: 0, devices: 0, bad: 0 };
  w.rawPlays += a.plays; w.rollPlays += b.plays;
  w.rawSecs += a.seconds; w.rollSecs += b.seconds;
  w.devices++;
  if (a.plays !== b.plays || a.seconds !== b.seconds) {
    w.bad++;
    deviceDiffs.push({ ws, dev, rawPlays: a.plays, rollPlays: b.plays, rawSecs: a.seconds, rollSecs: b.seconds });
  }
  perWs.set(ws, w);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log('PER WORKSPACE');
console.log(`  ${pad('workspace', 38)}${num('raw plays', 11)}${num('rollup', 11)}${num('raw sec', 12)}${num('rollup', 12)}  devices`);
for (const w of [...perWs.values()].sort((x, y) => y.rawPlays - x.rawPlays)) {
  const ok = w.rawPlays === w.rollPlays && w.rawSecs === w.rollSecs;
  console.log(`  ${ok ? ' ' : '!'} ${pad(w.ws || '(none)', 36)}${num(w.rawPlays.toLocaleString(), 11)}`
    + `${num(w.rollPlays.toLocaleString(), 11)}${num(w.rawSecs.toLocaleString(), 12)}${num(w.rollSecs.toLocaleString(), 12)}`
    + `  ${w.devices}${w.bad ? ` (${w.bad} differ)` : ''}`);
}

console.log('');
console.log('TOTALS');
console.log(`  plays   raw ${rawPlays.toLocaleString()}   rollup ${rollPlays.toLocaleString()}   diff ${(rollPlays - rawPlays).toLocaleString()}`);
console.log(`  seconds raw ${rawSecs.toLocaleString()}   rollup ${rollSecs.toLocaleString()}   diff ${(rollSecs - rawSecs).toLocaleString()}`);

if (!deviceDiffs.length) {
  console.log('');
  console.log(`OK — ${allKeys.size} workspace/device pair(s) agree exactly across ${((hiEpoch - loEpoch) / HOUR)} hour(s).`);
  process.exit(0);
}

console.log('');
console.log(`MISMATCH on ${deviceDiffs.length} of ${allKeys.size} workspace/device pair(s):`);
for (const d of deviceDiffs.slice(0, 40)) {
  console.log(`  ws=${d.ws || '(none)'} device=${d.dev}`);
  console.log(`      plays   raw ${d.rawPlays}  rollup ${d.rollPlays}`);
  console.log(`      seconds raw ${d.rawSecs}  rollup ${d.rollSecs}`);
}
if (deviceDiffs.length > 40) console.log(`  ... and ${deviceDiffs.length - 40} more`);
console.log('');
console.log('DO NOT lower PLAY_LOG_RETENTION_DAYS until this reads OK: the raw rows being compared');
console.log('against are what retention deletes, and after that the aggregate cannot be checked.');
process.exit(1);
