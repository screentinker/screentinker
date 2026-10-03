'use strict';

/*
 * #307 — plays that are open forever.
 *
 * ⚠️ THE NUMBERS THIS WAS WRITTEN AGAINST, from a copy of the production database: **36,096 open
 * play_logs rows, 35,982 of them more than a day old, the oldest from 4 June.** Nothing in the
 * product would ever have closed them.
 *
 * closeStrandedPlays infers an end from the NEXT play on the same device and zone — better data
 * when it exists, but it needs a next row, and it deliberately declines when the gap exceeds the
 * item's own length rather than crediting a dark screen with playback. Correct, and it leaves the
 * last play before a device goes quiet open for good.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-exp-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
/*
 * ⚠️ THE PROJECT'S DRIVER, NOT better-sqlite3 DIRECTLY.
 *
 * This suite is about SQL that runs on every deployment, and one of those deployments is a
 * BrightSign, where the server has no native module and reaches SQLite through node:sqlite via
 * db/sqlite-compat. Hard-requiring better-sqlite3 here would mean the "node:sqlite fallback" CI job
 * ran these assertions against the native driver anyway — agreement between one driver and itself.
 *
 * Going through db/sqlite-driver makes ST_SQLITE_DRIVER decide, so the fallback job genuinely
 * exercises this UPDATE ... FROM and its lastInsertRowid on the engine a player would use.
 */
const { Database } = require('../db/sqlite-driver');
const { expireStrandedPlays } = require('../lib/play-backfill');

const NOW = 1_800_000_000;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content (id TEXT PRIMARY KEY, duration_sec INTEGER);
    CREATE TABLE play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, content_id TEXT, widget_id TEXT,
      zone_id TEXT, content_name TEXT, started_at INTEGER, ended_at INTEGER,
      duration_sec INTEGER, completed INTEGER, trigger_type TEXT);
    INSERT INTO content (id, duration_sec) VALUES ('clip20', 20), ('film', 3600);
  `);
  return db;
}
const open = (db, o) => db.prepare(
  'INSERT INTO play_logs (device_id, content_id, widget_id, started_at) VALUES (?,?,?,?)'
).run(o.device || 'd1', o.content || null, o.widget || null, o.started).lastInsertRowid;
const row = (db, id) => db.prepare('SELECT * FROM play_logs WHERE id = ?').get(id);

test('⚠️ a play still within its own length is LEFT ALONE', () => {
  // The screen is showing it right now. Closing it would invent an ending.
  const db = makeDb();
  const id = open(db, { content: 'film', started: NOW - 60 });   // an hour-long film, 60s in
  assert.equal(expireStrandedPlays(db, { now: NOW }), 0);
  assert.equal(row(db, id).ended_at, null);
});

test('⚠️ a play open longer than its content could run is closed AT ITS CEILING', () => {
  /*
   * A 20-second clip open for a week did not play for a week. Closing it at started_at + its own
   * length keeps the promise the inference path makes — downtime is never credited as playback —
   * while actually ending the row.
   */
  const db = makeDb();
  const id = open(db, { content: 'clip20', started: NOW - 7 * 86400 });
  assert.equal(expireStrandedPlays(db, { now: NOW }), 1);
  const r = row(db, id);
  assert.equal(r.duration_sec, 20 + 60, 'credited its own length plus the grace, not a week');
  assert.equal(r.ended_at, NOW - 7 * 86400 + 80);
  assert.equal(r.completed, 0, 'we know it stopped, not that it finished');
});

test('a play with no known length uses the unknown ceiling', () => {
  // Widgets and images carry no duration; an hour is the documented cap.
  const db = makeDb();
  const id = open(db, { widget: 'w1', started: NOW - 86400 });
  assert.equal(expireStrandedPlays(db, { now: NOW }), 1);
  assert.equal(row(db, id).duration_sec, 3600);
});

test('the grace period is respected at the boundary', () => {
  const db = makeDb();
  const justInside = open(db, { content: 'clip20', started: NOW - 79 });   // 20 + 60 = 80
  const justOutside = open(db, { content: 'clip20', started: NOW - 81 });
  assert.equal(expireStrandedPlays(db, { now: NOW }), 1, 'exactly one is past its ceiling');
  assert.equal(row(db, justInside).ended_at, null, 'inside the grace stays open');
  assert.ok(row(db, justOutside).ended_at, 'outside it is closed');
});

test('an already-closed play is never touched again', () => {
  const db = makeDb();
  const id = open(db, { content: 'clip20', started: NOW - 99999 });
  db.prepare('UPDATE play_logs SET ended_at = ?, duration_sec = ?, completed = 1 WHERE id = ?')
    .run(NOW - 99000, 999, id);
  assert.equal(expireStrandedPlays(db, { now: NOW }), 0);
  const r = row(db, id);
  assert.equal(r.duration_sec, 999, 'its measured duration must survive');
  assert.equal(r.completed, 1, 'and its completion flag');
});

test('⚠️ the sweep is CHUNKED, so it cannot become the thing it was written to prevent', () => {
  /*
   * This runs against a table with 1.44 million rows on a synchronous driver. An unbounded UPDATE
   * here would block the event loop exactly the way the 153ms close query did — which is the whole
   * subject of #307.
   */
  const db = makeDb();
  for (let i = 0; i < 25; i++) open(db, { content: 'clip20', started: NOW - 99999 - i });
  assert.equal(expireStrandedPlays(db, { now: NOW, limit: 10 }), 10, 'the limit is honoured');
  assert.equal(expireStrandedPlays(db, { now: NOW, limit: 10 }), 10);
  assert.equal(expireStrandedPlays(db, { now: NOW, limit: 10 }), 5, 'and it drains');
  assert.equal(expireStrandedPlays(db, { now: NOW, limit: 10 }), 0, 'then stays drained');
});

test('the real production shape drains completely', () => {
  // 36,096 open rows of mixed kinds, which is what prod actually has.
  const db = makeDb();
  for (let i = 0; i < 300; i++) {
    open(db, { content: i % 3 === 0 ? 'clip20' : null, widget: i % 3 === 0 ? null : 'w', started: NOW - 200000 - i });
  }
  const live = open(db, { content: 'film', started: NOW - 10 });
  let total = 0; let n;
  do { n = expireStrandedPlays(db, { now: NOW, limit: 100 }); total += n; } while (n > 0);
  assert.equal(total, 300, 'every stranded row closed');
  assert.equal(row(db, live).ended_at, null, 'and the one that is genuinely playing did not');
});

/* ============ the driver contract this change leans on ============ */

const { driverName } = require('../db/sqlite-driver');

test('⚠️ lastInsertRowid comes back as a usable number on THIS driver', () => {
  /*
   * #307 closes a play by the rowid the insert handed back, instead of searching 377k rows for it.
   * That rests entirely on `run()` returning lastInsertRowid — and the server runs on two different
   * drivers: better-sqlite3 everywhere with a native module, and node:sqlite via db/sqlite-compat on
   * a BrightSign, which has none.
   *
   * The shim says it passes the value through "verified, not assumed". This executes it, on
   * whichever driver is active, so the fallback CI job proves it rather than repeating the claim.
   */
  const db = makeDb();
  const info = db.prepare(
    'INSERT INTO play_logs (device_id, content_id, started_at) VALUES (?,?,?)'
  ).run('d1', 'clip20', NOW - 5);
  assert.equal(typeof info.lastInsertRowid, 'number', `lastInsertRowid is not a number on ${driverName}`);
  assert.ok(info.lastInsertRowid > 0);
  assert.equal(typeof info.changes, 'number');

  // And it addresses the row it claims to: closing BY that rowid must hit exactly one row.
  const closed = db.prepare(
    "UPDATE play_logs SET ended_at = ?, completed = 0 WHERE rowid = ? AND ended_at IS NULL"
  ).run(NOW, info.lastInsertRowid);
  assert.equal(closed.changes, 1, 'the remembered rowid must address the row it came from');
  assert.equal(db.prepare('SELECT ended_at FROM play_logs WHERE rowid = ?').get(info.lastInsertRowid).ended_at, NOW);
});

test('the UPDATE ... FROM form the sweep uses is supported on this driver', () => {
  // SQLite gained UPDATE ... FROM in 3.33. Both drivers embed their own SQLite build, so "the
  // engine is the same" is an assumption worth one assertion rather than a comment.
  const db = makeDb();
  open(db, { content: 'clip20', started: NOW - 99999 });
  assert.doesNotThrow(() => expireStrandedPlays(db, { now: NOW }), `UPDATE ... FROM failed on ${driverName}`);
});
