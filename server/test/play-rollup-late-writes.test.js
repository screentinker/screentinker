'use strict';

/*
 * Raw play_logs keep changing after their hour is rolled up, and the aggregate must follow — or it
 * diverges from raw and, once raw is pruned, stays wrong for ever. Measured on production
 * 2026-10-13 before this existed: seconds up to 40% short (plays closed after their hour was rolled),
 * backlogged plays missing, and deleted devices still counted.
 *
 * The other half is just as important: the PRUNE deletes raw too, and that must NOT be treated as a
 * change — recomputing a pruned hour from the nothing left of it would empty the only record.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-rollup-late-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const rollup = require('../services/play-rollup');

const HOUR = 3600;
const WS = 'ws-late';
const DEV = 'dev-late';
const DEV2 = 'dev-late-2';
const CONTENT = 'content-late';

const T0 = 1750000000 - (1750000000 % HOUR);
const NOW = T0 + 10 * HOUR;

before(() => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES ('u-l','l@t.local','x','admin')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-l','L','u-l')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, 'org-l', 'W')").run(WS);
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?,?,?,?,?,?)")
    .run(CONTENT, 'a.mp4', 'a.mp4', 'video/mp4', 1, WS);
});

beforeEach(() => {
  db.prepare('DELETE FROM devices').run();
  db.prepare('DELETE FROM play_logs').run();
  db.prepare('DELETE FROM play_log_hourly').run();
  db.prepare('DELETE FROM play_log_rollup_dirty').run();
  db.prepare('UPDATE play_log_rollup_state SET rolled_through_hour = 0, raw_floor_hour = 0 WHERE id = 1').run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('play_rollup_late_writes_reroll_v1')").run();
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(DEV, 'D', WS);
  db.prepare('INSERT INTO devices (id, name, workspace_id) VALUES (?,?,?)').run(DEV2, 'D2', WS);
});

function play(at, { dev = DEV, dur = 10, open = false } = {}) {
  return db.prepare(`INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, trigger_type, workspace_id)
                     VALUES (?,?,?,?,?,?, 'playlist', ?)`)
    .run(dev, CONTENT, 'a.mp4', at, open ? null : at + dur, open ? null : dur, WS).lastInsertRowid;
}

/** Roll forward, then keep sweeping until nothing is queued (the budget makes one pass partial). */
function settle() {
  let r = rollup.rollupOnce({ now: NOW });
  for (let i = 0; i < 100 && r.dirtyLeft > 0; i++) r = rollup.rollupOnce({ now: NOW });
  assert.equal(r.dirtyLeft, 0, 'the dirty queue drains');
}

const hourly = (hour, dev = DEV) => db.prepare(
  "SELECT COALESCE(SUM(play_count),0) AS plays, COALESCE(SUM(duration_sec),0) AS secs FROM play_log_hourly WHERE hour_utc = ? AND device_id = ?").get(hour, dev);
const raw = (hour, dev = DEV) => db.prepare(
  'SELECT COUNT(*) AS plays, COALESCE(SUM(duration_sec),0) AS secs FROM play_logs WHERE started_at >= ? AND started_at < ? AND device_id = ?').get(hour, hour + HOUR, dev);

test('a play closed after its hour was rolled up gets its duration counted', () => {
  const id = play(T0 + 3500, { open: true });     // starts 100 s before the hour ends, still playing
  settle();
  assert.deepEqual(hourly(T0), { plays: 1, secs: 0 }, 'rolled while open: no duration yet');
  db.prepare('UPDATE play_logs SET ended_at = ?, duration_sec = ? WHERE id = ?').run(T0 + 3800, 300, id);
  settle();
  assert.deepEqual(hourly(T0), { plays: 1, secs: 300 });
});

test('an offline backlog arriving for a rolled-up hour is counted', () => {
  play(T0 + 60);
  settle();
  play(T0 + 120, { dur: 30 });                     // replayed later, timestamped in the past
  settle();
  assert.deepEqual(hourly(T0), raw(T0));
  assert.deepEqual(hourly(T0), { plays: 2, secs: 40 });
});

test('deleting a device removes its plays from the aggregate too, and only its plays', () => {
  play(T0 + 60);
  play(T0 + 70, { dev: DEV2 });
  settle();
  db.prepare('DELETE FROM devices WHERE id = ?').run(DEV);     // FK cascade deletes its raw rows
  settle();
  assert.deepEqual(hourly(T0), { plays: 0, secs: 0 });
  assert.deepEqual(hourly(T0, DEV2), { plays: 1, secs: 10 });
});

test('deleting content moves its plays to no-content without counting them twice', () => {
  play(T0 + 60);
  settle();
  db.prepare('DELETE FROM content WHERE id = ?').run(CONTENT); // content_id SET NULL on raw
  settle();
  const rows = db.prepare('SELECT content_id, play_count FROM play_log_hourly WHERE hour_utc = ?').all(T0);
  assert.deepEqual(rows, [{ content_id: '', play_count: 1 }]);
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?,?,?,?,?,?)")
    .run(CONTENT, 'a.mp4', 'a.mp4', 'video/mp4', 1, WS);
});

test('⚠️ the retention prune never recomputes (and so never empties) the hours it deletes', () => {
  for (let h = 0; h < 6; h++) play(T0 + h * HOUR + 60);
  settle();
  const before = db.prepare('SELECT SUM(play_count) AS n FROM play_log_hourly').get().n;
  // What services/heartbeat.prunePlayLogs does: raise the floor, then delete below it.
  rollup.setRawFloor(T0 + 3 * HOUR);
  db.prepare('DELETE FROM play_logs WHERE started_at < ?').run(T0 + 3 * HOUR);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_log_rollup_dirty').get().n, 0, 'nothing marked');
  settle();
  assert.equal(db.prepare('SELECT SUM(play_count) AS n FROM play_log_hourly').get().n, before, 'aggregate intact');
});

test('a late write into an already-pruned hour keeps the aggregate instead of replacing it', () => {
  for (let h = 0; h < 4; h++) play(T0 + h * HOUR + 60);
  settle();
  rollup.setRawFloor(T0 + 2 * HOUR);
  db.prepare('DELETE FROM play_logs WHERE started_at < ?').run(T0 + 2 * HOUR);
  play(T0 + 90);                                   // a backlog older than retention
  settle();
  assert.deepEqual(hourly(T0), { plays: 1, secs: 10 }, 'the old aggregate, not just the late row');
});

test('the real prune deletes whole hours, raises the floor first, and leaves the aggregate alone', async () => {
  const config = require('../config');
  const heartbeat = require('../services/heartbeat');
  for (let h = 0; h < 6; h++) { play(T0 + h * HOUR + 60); play(T0 + h * HOUR + 3000); }
  settle();
  const before = db.prepare('SELECT SUM(play_count) AS n FROM play_log_hourly').get().n;
  const saved = config.playLogRetentionDays;
  // A retention cutoff half way through hour T0+2: the prune must stop at T0+2, not inside it.
  config.playLogRetentionDays = (Math.floor(Date.now() / 1000) - (T0 + 2 * HOUR + 1800)) / 86400;
  try { await heartbeat.prunePlayLogs(); } finally { config.playLogRetentionDays = saved; }
  assert.equal(rollup.rawFloor(), T0 + 2 * HOUR);
  assert.equal(db.prepare('SELECT MIN(started_at) AS t FROM play_logs').get().t, T0 + 2 * HOUR + 60, 'hour T0+2 kept whole');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_log_rollup_dirty').get().n, 0, 'nothing marked');
  settle();
  assert.equal(db.prepare('SELECT SUM(play_count) AS n FROM play_log_hourly').get().n, before, 'aggregate intact');
});

test('the one-time repair rebuilds every recomputable hour from raw', () => {
  for (let h = 0; h < 5; h++) play(T0 + h * HOUR + 60);
  settle();
  // A legacy prune stopped mid-hour T0; hours T0+1..T0+4 are whole. Corrupt the aggregate the way
  // production's was, then run the repair as a first boot on this code would.
  db.prepare('DELETE FROM play_logs WHERE started_at < ?').run(T0 + 30);
  play(T0 + 40);
  db.prepare('UPDATE play_log_hourly SET duration_sec = 1, play_count = 99').run();
  db.prepare("DELETE FROM schema_migrations WHERE id = 'play_rollup_late_writes_reroll_v1'").run();
  db.prepare('DELETE FROM play_log_rollup_dirty').run();
  rollup.__resetRepairForTests();
  settle();
  assert.equal(rollup.rawFloor(), T0 + HOUR, "the legacy-pruned oldest hour is treated as partial");
  for (let h = 1; h < 5; h++) assert.deepEqual(hourly(T0 + h * HOUR), raw(T0 + h * HOUR), `hour +${h} rebuilt`);
  assert.deepEqual(hourly(T0), { plays: 99, secs: 1 }, 'the partial hour is left alone');
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'play_rollup_late_writes_reroll_v1'").get());
});

test('the sweep is bounded: a big repair queue drains over several passes', () => {
  for (let h = 0; h < 9; h++) play(T0 + h * HOUR + 60);
  rollup.rollupOnce({ now: NOW });
  db.prepare('INSERT OR IGNORE INTO play_log_rollup_dirty (hour_utc) SELECT hour_utc FROM play_log_hourly').run();
  const r = rollup.rerollDirty({ maxHours: 3 });
  assert.equal(r.rerolled, 3);
  assert.ok(r.left > 0);
});
