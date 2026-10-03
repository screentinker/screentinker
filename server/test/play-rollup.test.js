'use strict';

/*
 * Proof-of-play rollup: aggregate hourly, then prune raw.
 *
 * Every test here guards something that fails SILENTLY and is UNRECOVERABLE once raw rows are
 * gone. A double-counted play, a play deleted before it was aggregated, or a play attributed to
 * the wrong tenant cannot be detected later by looking at the aggregate — the aggregate IS the
 * record by then. So the invariants are pinned directly rather than inferred from a report.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-rollup-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const rollup = require('../services/play-rollup');
const report = require('../lib/play-report');
const config = require('../config');

const HOUR = 3600;
const ORG = 'org-r';
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const DEV = 'dev-1';
const CONTENT = 'content-1';

// A fixed, hour-aligned clock. Real "now" would make `lastCompleteHour` drift mid-test.
const T0 = 1750000000 - (1750000000 % HOUR);          // some hour boundary
const NOW = T0 + 10 * HOUR;                            // 10 complete hours of history

before(() => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES ('u-r','r@t.local','x','admin')").run();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(ORG, 'R', 'u-r');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?,?,?)').run(WS_A, ORG, 'A');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?,?,?)').run(WS_B, ORG, 'B');
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(DEV, 'D1', WS_A);
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?,?,?,?,?,?)")
    .run(CONTENT, 'a.mp4', 'a.mp4', 'video/mp4', 1, WS_A);
});

beforeEach(() => {
  db.prepare('DELETE FROM play_logs').run();
  db.prepare('DELETE FROM play_log_hourly').run();
  rollup.setWatermark(0, NOW);
});

/** Insert a raw play with an explicit workspace snapshot, as deviceSocket does. */
function play(at, { ws = WS_A, dev = DEV, content = CONTENT, dur = 10 } = {}) {
  db.prepare(`INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, trigger_type, workspace_id)
              VALUES (?,?,?,?,?,?, 'playlist', ?)`)
    .run(dev, content, 'a.mp4', at, at + dur, dur, ws);
}

// ───────────────────────────────── idempotence ─────────────────────────────────

test('re-running the rollup produces identical rows, not doubled ones', () => {
  for (let i = 0; i < 5; i++) play(T0 + 60 * i);
  rollup.rollupOnce({ now: NOW });
  const first = db.prepare('SELECT * FROM play_log_hourly ORDER BY hour_utc').all();
  assert.equal(first.length, 1);
  assert.equal(first[0].play_count, 5);
  assert.equal(first[0].duration_sec, 50);

  // Rewind the watermark and do it all again — a crash-retry, or a manual re-run.
  rollup.setWatermark(0, NOW);
  rollup.rollupOnce({ now: NOW });
  const second = db.prepare('SELECT * FROM play_log_hourly ORDER BY hour_utc').all();
  assert.deepEqual(second, first, 'recompute must overwrite, never accumulate');
});

test('a NULL workspace or content still upserts instead of duplicating', () => {
  /*
   * SQLite allows NULLs in a non-INTEGER primary key and two NULLs never compare equal, so
   * without the '' sentinel ON CONFLICT never matches and every recompute inserts a NEW row.
   * This is the exact shape that would quietly multiply a widget play (no content_id) or an
   * unattributed device's plays on every nightly sweep.
   */
  db.prepare(`INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, trigger_type, workspace_id)
              VALUES (?, NULL, 'w', ?, ?, 5, 'playlist', NULL)`).run(DEV, T0, T0 + 5);
  rollup.rollupOnce({ now: NOW });
  rollup.setWatermark(0, NOW);
  rollup.rollupOnce({ now: NOW });
  const rows = db.prepare('SELECT * FROM play_log_hourly').all();
  assert.equal(rows.length, 1, 'a NULL in the key must not create a second row on recompute');
  assert.equal(rows[0].play_count, 1);
  assert.equal(rows[0].content_id, '');
  assert.equal(rows[0].workspace_id, '');
});

test('an incomplete hour is not rolled up', () => {
  // The current hour is still receiving plays; aggregating it would have to be rewritten later.
  const currentHour = Math.floor(NOW / HOUR) * HOUR;
  play(currentHour + 60);
  rollup.rollupOnce({ now: NOW });
  const rows = db.prepare('SELECT * FROM play_log_hourly WHERE hour_utc = ?').all(currentHour);
  assert.equal(rows.length, 0, 'the in-progress hour must be left alone');
  assert.ok(rollup.watermark() < currentHour);
});

// ───────────────────────────── the prune invariant ─────────────────────────────

test('raw is never prunable past the rollup watermark', () => {
  for (let i = 0; i < 4; i++) play(T0 + i * HOUR);

  // Nothing aggregated yet: nothing may be deleted, whatever retention says.
  rollup.setWatermark(0, NOW);
  assert.equal(rollup.prunableBefore(NOW), 0, 'an un-aggregated table must refuse the prune entirely');

  rollup.rollupOnce({ now: NOW, maxHours: 2 });
  const w = rollup.watermark();
  assert.ok(w > 0);

  /*
   * The case the clamp exists for: the rollup is BEHIND retention. With the default 90 days the
   * retention cutoff is far OLDER than anything here, so retention binds and the watermark is
   * irrelevant (covered by the next test). Shorten retention so the cutoff moves up to ~now, which
   * is what a long outage or a slow first pass over an adopted database looks like.
   */
  const saved = config.playLogRetentionDays;
  try {
    config.playLogRetentionDays = 0;              // cutoff == NOW
    assert.equal(rollup.prunableBefore(NOW), w + HOUR,
      'with retention past the watermark, the prune must stop at what has been aggregated');
    assert.ok(w + HOUR < NOW, 'and that is strictly less than the retention cutoff');
  } finally {
    config.playLogRetentionDays = saved;
  }
});

test('retention wins when the rollup is ahead of it', () => {
  // The other direction: once everything is aggregated, retention is the binding constraint.
  play(T0);
  rollup.rollupOnce({ now: NOW });
  const retentionCut = NOW - Math.round(config.playLogRetentionDays * 86400);
  assert.equal(rollup.prunableBefore(NOW), Math.min(retentionCut, rollup.watermark() + HOUR));
  assert.equal(rollup.prunableBefore(NOW), retentionCut, 'with 90d retention the cutoff is retention');
});

test('maxHours bounds one pass and the next resumes where it stopped', () => {
  for (let i = 0; i < 6; i++) play(T0 + i * HOUR);
  const a = rollup.rollupOnce({ now: NOW, maxHours: 2 });
  assert.equal(a.hours, 2);
  const afterFirst = db.prepare('SELECT COUNT(*) n FROM play_log_hourly').get().n;
  assert.equal(afterFirst, 2);
  rollup.rollupOnce({ now: NOW, maxHours: 10 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM play_log_hourly').get().n, 6);
});

// ───────────────────────────────── tenancy ─────────────────────────────────────

test('moving a device does NOT re-attribute its history', () => {
  /*
   * The defect this table was redesigned around. With workspace resolved by joining devices, a
   * reseller moving a display from client A to client B would, on the next recompute, move A's
   * past plays into B's reports and out of A's — silently, and permanently once raw is pruned.
   */
  play(T0, { ws: WS_A });
  rollup.rollupOnce({ now: NOW });
  assert.equal(db.prepare('SELECT workspace_id FROM play_log_hourly').get().workspace_id, WS_A);

  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WS_B, DEV);
  rollup.setWatermark(0, NOW);
  rollup.rollupOnce({ now: NOW });

  const rows = db.prepare('SELECT * FROM play_log_hourly').all();
  assert.equal(rows.length, 1, 'recompute after a move must not create a second, B-owned row');
  assert.equal(rows[0].workspace_id, WS_A, 'the play still belongs to the workspace it happened in');

  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WS_A, DEV);   // restore
});

test('a report for the new workspace does not inherit the old history', () => {
  play(T0, { ws: WS_A });
  rollup.rollupOnce({ now: NOW });
  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WS_B, DEV);

  const bRows = report.hourlyRows({ startEpoch: T0 - HOUR, endEpoch: NOW, workspaceId: WS_B });
  assert.equal(bRows.reduce((n, r) => n + r.plays, 0), 0, 'B must not see plays from before the move');
  const aRows = report.hourlyRows({ startEpoch: T0 - HOUR, endEpoch: NOW, workspaceId: WS_A });
  assert.equal(aRows.reduce((n, r) => n + r.plays, 0), 1, 'A keeps what happened while it owned the device');

  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WS_A, DEV);
});

test('a request with no workspace context reads nothing', () => {
  play(T0);
  rollup.rollupOnce({ now: NOW });
  assert.deepEqual(report.hourlyRows({ startEpoch: 0, endEpoch: NOW, workspaceId: null }), []);
});

// ─────────────────────────── reading across the seam ───────────────────────────

test('a range spanning the seam counts every play exactly once', () => {
  // 6 hours of history, one play each.
  for (let i = 0; i < 6; i++) play(T0 + i * HOUR);
  rollup.rollupOnce({ now: NOW });

  // Both tables now hold the same 6 hours — the overlap window that exists between aggregating
  // and pruning. A reader splitting on the WATERMARK here would report 12 plays.
  const both = report.hourlyRows({ startEpoch: T0 - HOUR, endEpoch: NOW, workspaceId: WS_A });
  assert.equal(both.reduce((n, r) => n + r.plays, 0), 6, 'the overlap must not be double counted');

  // Now prune the first 3 hours, as maintenance would once they are aggregated.
  db.prepare('DELETE FROM play_logs WHERE started_at < ?').run(T0 + 3 * HOUR);
  const after = report.hourlyRows({ startEpoch: T0 - HOUR, endEpoch: NOW, workspaceId: WS_A });
  assert.equal(after.reduce((n, r) => n + r.plays, 0), 6, 'pruned hours must still be reported, from the rollup');
  assert.equal(after.length, 6, 'and still as six distinct hours');
});

test('a report older than the raw floor is served entirely from the rollup', () => {
  for (let i = 0; i < 4; i++) play(T0 + i * HOUR);
  rollup.rollupOnce({ now: NOW });
  db.prepare('DELETE FROM play_logs').run();       // everything pruned
  const rows = report.hourlyRows({ startEpoch: T0 - HOUR, endEpoch: NOW, workspaceId: WS_A });
  assert.equal(rows.reduce((n, r) => n + r.plays, 0), 4, 'the record survives the raw rows');
});

test('totals and duration survive the seam unchanged', () => {
  for (let i = 0; i < 4; i++) play(T0 + i * HOUR, { dur: 7 });
  const beforeRollup = report.hourlyRows({ startEpoch: 0, endEpoch: NOW, workspaceId: WS_A });
  rollup.rollupOnce({ now: NOW });
  db.prepare('DELETE FROM play_logs').run();
  const afterPrune = report.hourlyRows({ startEpoch: 0, endEpoch: NOW, workspaceId: WS_A });

  const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
  assert.equal(sum(afterPrune, 'plays'), sum(beforeRollup, 'plays'));
  assert.equal(sum(afterPrune, 'seconds'), sum(beforeRollup, 'seconds'));
  assert.equal(sum(afterPrune, 'seconds'), 28);
});

// ──────────────────────────── timezone bucketing ───────────────────────────────

test('days are bucketed in the DEVICE zone, not the server zone', () => {
  /*
   * 01:30 UTC is still the previous day in New York. Bucketing on the server's clock would put it
   * on the UTC day and disagree with the operator looking at the screen — and, on a self-hosted
   * box in a third zone, with both.
   */
  const utcMorning = Math.floor(Date.UTC(2026, 0, 2, 1, 30) / 1000);
  const rows = [{ device_id: DEV, content_id: CONTENT, content_name: 'a', hour_utc: utcMorning - (utcMorning % HOUR), plays: 1, seconds: 10 }];

  const utc = report.summarise(rows, new Map([[DEV, 'UTC']]));
  assert.equal(utc.by_day[0].day, '2026-01-02');

  const ny = report.summarise(rows, new Map([[DEV, 'America/New_York']]));
  assert.equal(ny.by_day[0].day, '2026-01-01', 'New York is still on the previous day at 01:30 UTC');
});

test('an unknown device zone degrades to UTC instead of failing the report', () => {
  const rows = [{ device_id: DEV, content_id: CONTENT, content_name: 'a', hour_utc: T0, plays: 1, seconds: 3 }];
  const out = report.summarise(rows, new Map([[DEV, 'Mars/Olympus_Mons']]));
  assert.equal(out.overall.total_plays, 1, 'a bad zone must not take the whole report down');
  assert.equal(out.by_day.length, 1);
});

test('hour-of-day has 24 buckets, never 25', () => {
  const rows = [];
  for (let h = 0; h < 24; h++) rows.push({ device_id: DEV, content_id: CONTENT, content_name: 'a', hour_utc: T0 + h * HOUR, plays: 1, seconds: 1 });
  const out = report.summarise(rows, new Map([[DEV, 'UTC']]));
  assert.equal(out.by_hour.length, 24);
  assert.ok(out.by_hour.every((b) => b.hour >= 0 && b.hour <= 23), 'midnight must not land in an hour 24');
  assert.equal(out.by_hour.reduce((n, b) => n + b.plays, 0), 24);
});

test('avg duration is derived from sums, not averaged twice', () => {
  // Two hours with different play counts: averaging the per-hour means would give 7.5, not 8.
  const rows = [
    { device_id: DEV, content_id: CONTENT, content_name: 'a', hour_utc: T0, plays: 1, seconds: 5 },
    { device_id: DEV, content_id: CONTENT, content_name: 'a', hour_utc: T0 + HOUR, plays: 3, seconds: 27 },
  ];
  const out = report.summarise(rows, new Map([[DEV, 'UTC']]));
  assert.equal(out.overall.total_plays, 4);
  assert.equal(out.overall.total_duration_sec, 32);
  assert.equal(out.overall.avg_duration_sec, 8);
});
