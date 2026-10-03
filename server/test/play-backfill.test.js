'use strict';

/*
 * #299 — plays recorded while a device was offline.
 *
 * ⚠️ THE BUG THIS EXISTS FOR: playback is offline-native, reporting was online-only. Every player
 * guarded its proof-of-play emit on `socket.connected` and returned, so a play that happened while
 * the link was down was discarded where it occurred. A measured 5h49m outage on alpha lost ~1,040
 * plays: play_logs had one 20,963-second hole and nothing was ever backfilled into it.
 *
 * Two layers, no socket server needed — the shape lib/incident-classify's tests use next door:
 *   1. the pure rules (lib/play-backfill), which the live handler calls, so they cannot drift;
 *   2. an in-memory better-sqlite3 running the handler's real INSERT, so the persistence shape
 *      (and the uniqueness that makes a re-flush idempotent) is proven too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  normalizeBackfillPlay,
  boundBatch,
  closeStrandedPlays,
  INFER_UNKNOWN_MAX_SEC,
  MAX_BACKFILL_BATCH,
  BACKFILL_MAX_AGE_SEC,
  BACKFILL_FUTURE_SKEW_SEC,
  BACKFILL_MAX_DURATION_SEC,
} = require('../lib/play-backfill');

const NOW = 1_800_000_000;                 // fixed clock; the rules take it as a parameter
const ok = (over = {}) => ({ started_at: NOW - 3600, ended_at: NOW - 3580, content_id: 'c1', content_name: 'clip.mp4', completed: true, client_event_id: 'evt-1', ...over });

/* ===================================================== the rules */

test('a plain offline play survives with its OWN times, not the time it arrived', () => {
  /*
   * ⚠️ THE WHOLE POINT. The live path stamps rows with strftime('%s','now'); replaying a backlog
   * through that would record ~1,000 plays as having all happened in the few seconds after
   * reconnect. That is worse than the gap, because it reads as real data.
   */
  const p = normalizeBackfillPlay(ok(), NOW);
  assert.equal(p.started_at, NOW - 3600);
  assert.equal(p.ended_at, NOW - 3580);
  assert.equal(p.duration_sec, 20);
  assert.equal(p.completed, 1);
  assert.equal(p.content_name, 'clip.mp4');
});

test('⚠️ a future timestamp is DROPPED, not clamped', () => {
  // A panel with a bad RTC will offer one. Clamping it to "now" would manufacture a play that
  // never happened at a time it did not happen — indistinguishable from a real one afterwards.
  assert.equal(normalizeBackfillPlay(ok({ started_at: NOW + BACKFILL_FUTURE_SKEW_SEC + 60 }), NOW), null);
});

test('mild clock skew is tolerated — panels are not NTP-perfect', () => {
  assert.ok(normalizeBackfillPlay(ok({ started_at: NOW + 60, ended_at: NOW + 70 }), NOW));
});

test('⚠️ an ancient timestamp is DROPPED', () => {
  // 1970 is what a dead RTC reports. It is a broken clock, not an outage anyone is reporting.
  assert.equal(normalizeBackfillPlay(ok({ started_at: 0, ended_at: 10 }), NOW), null);
  assert.equal(normalizeBackfillPlay(ok({ started_at: NOW - BACKFILL_MAX_AGE_SEC - 1 }), NOW), null);
});

test('a real outage-length backlog is well inside the window', () => {
  const sixHoursAgo = NOW - 6 * 3600;
  const p = normalizeBackfillPlay(ok({ started_at: sixHoursAgo, ended_at: sixHoursAgo + 20 }), NOW);
  assert.equal(p.started_at, sixHoursAgo);
});

test('⚠️ a missing or impossible end leaves the row OPEN rather than inventing one', () => {
  for (const bad of [undefined, null, 'x', NOW - 4000 /* before its start */, NOW + 99999 /* future */]) {
    const p = normalizeBackfillPlay(ok({ ended_at: bad }), NOW);
    assert.ok(p, `started_at should still be accepted (ended_at=${bad})`);
    assert.equal(p.ended_at, null, `ended_at=${bad} should leave the row open`);
    assert.equal(p.duration_sec, null);
  }
});

test('an absurd duration is capped', () => {
  const p = normalizeBackfillPlay(ok({ started_at: NOW - 20, ended_at: NOW }), NOW);
  assert.equal(p.duration_sec, 20);
  const long = normalizeBackfillPlay({ started_at: NOW - 2 * BACKFILL_MAX_DURATION_SEC, ended_at: NOW }, NOW);
  assert.equal(long.duration_sec, BACKFILL_MAX_DURATION_SEC);
});

test('junk in never throws', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}, { started_at: NaN }, { started_at: 'x' }]) {
    assert.doesNotThrow(() => normalizeBackfillPlay(bad, NOW));
    assert.equal(normalizeBackfillPlay(bad, NOW), null);
  }
});

test('⚠️ a flush is bounded, so one payload cannot insert without limit', () => {
  const many = Array.from({ length: MAX_BACKFILL_BATCH * 3 }, () => ok());
  assert.equal(boundBatch(many).length, MAX_BACKFILL_BATCH);
  assert.deepEqual(boundBatch('not an array'), []);
  assert.deepEqual(boundBatch(undefined), []);
});

/* ===================================================== the persistence */

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      content_id TEXT, widget_id TEXT, zone_id TEXT,
      content_name TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL, ended_at INTEGER, duration_sec INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      trigger_type TEXT DEFAULT 'playlist',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      client_event_id TEXT
    );
    CREATE UNIQUE INDEX idx_play_logs_client_event
      ON play_logs(client_event_id) WHERE client_event_id IS NOT NULL;
    CREATE TABLE content (id TEXT PRIMARY KEY, duration_sec INTEGER);
  `);
  return db;
}

// The handler's real statement.
const insertOf = (db) => db.prepare(`
  INSERT OR IGNORE INTO play_logs
    (device_id, content_id, widget_id, zone_id, content_name, started_at, ended_at,
     duration_sec, completed, trigger_type, client_event_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'playlist', ?)
`);

const store = (db, p) => insertOf(db).run('dev1', p.content_id, p.widget_id, p.zone_id,
  p.content_name, p.started_at, p.ended_at, p.duration_sec, p.completed, p.client_event_id);

test('a backfilled row lands with the play times the player reported', () => {
  const db = freshDb();
  store(db, normalizeBackfillPlay(ok(), NOW));
  const row = db.prepare('SELECT * FROM play_logs').get();
  assert.equal(row.started_at, NOW - 3600);
  assert.equal(row.duration_sec, 20);
  assert.equal(row.completed, 1);
  assert.notEqual(row.started_at, row.created_at, 'the play time must not be the arrival time');
});

test('⚠️ RE-FLUSHING THE SAME BACKLOG DOES NOT DOUBLE-COUNT', () => {
  /*
   * The failure this guards: a player flushes, the ack is lost (or it dies first), and it flushes
   * the same queue again on its next boot. Without the unique client_event_id every outage would
   * over-report instead of under-reporting — trading one wrong number for another.
   */
  const db = freshDb();
  const p = normalizeBackfillPlay(ok({ client_event_id: 'evt-42' }), NOW);
  const first = store(db, p);
  const second = store(db, p);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0, 'the second flush inserted a duplicate row');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 1);
});

test('two DIFFERENT plays of the same content both store', () => {
  const db = freshDb();
  store(db, normalizeBackfillPlay(ok({ client_event_id: 'a' }), NOW));
  store(db, normalizeBackfillPlay(ok({ client_event_id: 'b' }), NOW));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 2);
});

test('⚠️ live rows (no client_event_id) never collide with each other', () => {
  // The index is partial for exactly this reason: NULLs must not be treated as a duplicate key,
  // or the first live play would block every one after it.
  const db = freshDb();
  for (let i = 0; i < 5; i++) store(db, normalizeBackfillPlay(ok({ client_event_id: null }), NOW));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM play_logs').get().c, 5);
});

test('a whole outage backlog stores in one pass, with its shape intact', () => {
  // ~1,040 plays is what the real outage produced; prove the batch bound and the rules together.
  const db = freshDb();
  const start = NOW - 6 * 3600;
  const backlog = Array.from({ length: 1040 }, (_, i) => ok({
    started_at: start + i * 20, ended_at: start + i * 20 + 20, client_event_id: `e${i}`,
  }));
  let written = 0;
  for (const raw of boundBatch(backlog)) {
    const p = normalizeBackfillPlay(raw, NOW);
    if (p) written += store(db, p).changes;
  }
  assert.equal(written, MAX_BACKFILL_BATCH, 'one flush should write exactly a bounded batch');
  const spread = db.prepare('SELECT MAX(started_at) - MIN(started_at) AS s FROM play_logs').get().s;
  assert.ok(spread > 3000, `plays must keep their real spread over time, got ${spread}s`);
});

/* ===================================================== closing what an outage stranded */

/*
 * ⚠️ THE ROW THE BACKFILL CANNOT REACH. The play in flight when the link drops had its play_start
 * recorded LIVE and its play_end lost, so it sits open forever with no duration — one per outage,
 * plus every reboot mid-item. The queue cannot backfill it without duplicating the row that already
 * exists.
 *
 * But the evidence is already in the table: the device advancing to another item proves the
 * previous one ran until that moment. The successor's started_at IS the predecessor's end. Nothing
 * is invented here — it is read off data we already have.
 */

const addRow = (db, o) => db.prepare(`
  INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, ended_at, duration_sec)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(o.device_id || 'dev1', o.content_id || 'c1', o.zone_id ?? null, o.content_name || 'clip',
       o.started_at, o.ended_at ?? null, o.duration_sec ?? null);

test('⚠️ an open row is closed by the start of the play that followed it', () => {
  const db = freshDb();
  addRow(db, { started_at: NOW - 100 });                       // stranded by the outage
  addRow(db, { started_at: NOW - 80, ended_at: NOW - 60 });    // the play after it
  assert.equal(closeStrandedPlays(db, 'dev1'), 1);
  const row = db.prepare('SELECT * FROM play_logs ORDER BY started_at').get();
  assert.equal(row.ended_at, NOW - 80, 'it ended when the next item began');
  assert.equal(row.duration_sec, 20);
});

test('⚠️ THE ITEM PLAYING RIGHT NOW IS LEFT OPEN', () => {
  // It has no successor because it has not ended. Closing it would invent an end for something
  // still on screen.
  const db = freshDb();
  addRow(db, { started_at: NOW - 100, ended_at: NOW - 80, duration_sec: 20 });
  addRow(db, { started_at: NOW - 80 });                        // currently playing
  assert.equal(closeStrandedPlays(db, 'dev1'), 0);
  const open = db.prepare('SELECT COUNT(*) c FROM play_logs WHERE ended_at IS NULL').get().c;
  assert.equal(open, 1);
});

test('⚠️ a week-long gap does NOT become a week-long play', () => {
  /*
   * A panel that played one item, went dark for a week and came back has a "next" play a week
   * later. Attributing that to the item would be a far bigger lie than leaving the row open.
   */
  const db = freshDb();
  addRow(db, { started_at: NOW - 8 * 24 * 3600 });
  addRow(db, { started_at: NOW - 60, ended_at: NOW - 40 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 0, 'an implausible span must stay open');
  assert.equal(db.prepare('SELECT ended_at FROM play_logs ORDER BY started_at').get().ended_at, null);
});

test('⚠️ a multi-zone device closes against ITS OWN zone, not a neighbour', () => {
  /*
   * Zones play at the same time. Taking "the next row for this device" would let zone B's start cut
   * zone A's play short — under-reporting exactly the screens that show the most.
   */
  const db = freshDb();
  addRow(db, { zone_id: 'zoneA', started_at: NOW - 100 });                     // open, zone A
  addRow(db, { zone_id: 'zoneB', started_at: NOW - 90, ended_at: NOW - 70 });  // a DIFFERENT zone
  assert.equal(closeStrandedPlays(db, 'dev1'), 0, "another zone's play must not close this one");
  addRow(db, { zone_id: 'zoneA', started_at: NOW - 40, ended_at: NOW - 20 });  // zone A's real successor
  assert.equal(closeStrandedPlays(db, 'dev1'), 1);
  const a = db.prepare("SELECT * FROM play_logs WHERE zone_id='zoneA' ORDER BY started_at").get();
  assert.equal(a.ended_at, NOW - 40);
  assert.equal(a.duration_sec, 60);
});

test('it closes against the NEXT play, not the newest one', () => {
  const db = freshDb();
  addRow(db, { started_at: NOW - 100 });                        // stranded
  addRow(db, { started_at: NOW - 80, ended_at: NOW - 60 });
  addRow(db, { started_at: NOW - 60, ended_at: NOW - 40 });
  closeStrandedPlays(db, 'dev1');
  const row = db.prepare('SELECT * FROM play_logs ORDER BY started_at').get();
  assert.equal(row.ended_at, NOW - 80, 'the immediate successor ends it, not the latest play');
  assert.equal(row.duration_sec, 20);
});

test('another device is never touched', () => {
  const db = freshDb();
  addRow(db, { device_id: 'other', started_at: NOW - 100 });
  addRow(db, { device_id: 'other', started_at: NOW - 80, ended_at: NOW - 60 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 0);
  assert.equal(db.prepare("SELECT ended_at FROM play_logs WHERE device_id='other' ORDER BY started_at").get().ended_at, null);
});

test('already-closed rows are not rewritten', () => {
  const db = freshDb();
  addRow(db, { started_at: NOW - 100, ended_at: NOW - 95, duration_sec: 5 });
  addRow(db, { started_at: NOW - 80, ended_at: NOW - 60, duration_sec: 20 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 0);
  assert.equal(db.prepare('SELECT duration_sec FROM play_logs ORDER BY started_at').get().duration_sec, 5,
    'a real recorded duration must never be overwritten by an inferred one');
});

test('completed is deliberately left alone', () => {
  // We have evidence it PLAYED that long, not that it ran to its end — an error-advance looks
  // identical from here. Claiming completion would assert more than the data supports.
  const db = freshDb();
  addRow(db, { started_at: NOW - 100 });
  addRow(db, { started_at: NOW - 80, ended_at: NOW - 60 });
  closeStrandedPlays(db, 'dev1');
  assert.equal(db.prepare('SELECT completed FROM play_logs ORDER BY started_at').get().completed, 0);
});

test('an empty table is a no-op, not an error', () => {
  const db = freshDb();
  assert.doesNotThrow(() => closeStrandedPlays(db, 'dev1'));
  assert.equal(closeStrandedPlays(db, 'dev1'), 0);
});

/* ============ the cap, tightened after it wrote 8.7 hours of runtime for a 20-second clip ============ */

/*
 * ⚠️ THIS IS THE BUG THE FIRST VERSION SHIPPED WITH, caught on alpha within minutes of deploying.
 * The cap was a blanket 24 hours, so when a device had been offline overnight with no backfill
 * available, the "next play" was the following morning — and a 20-second clip was closed with
 * dur=31368 (8h43m). A fabricated duration in a billing report is exactly what the rest of this
 * module refuses to produce, and the cap was the only thing standing between an inference and that.
 *
 * The item's own length is the ceiling now: a 20s clip cannot have played for hours, whatever the
 * gap says.
 */

const withContent = (db, id, len) => db.prepare('INSERT INTO content (id, duration_sec) VALUES (?, ?)').run(id, len);

test('⚠️ A 20-SECOND CLIP IS NEVER CREDITED WITH HOURS', () => {
  const db = freshDb();
  withContent(db, 'c1', 20);
  addRow(db, { content_id: 'c1', started_at: NOW - 31368 });          // stranded overnight
  addRow(db, { content_id: 'c1', started_at: NOW, ended_at: NOW + 20 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 0, 'a 20s clip must not absorb an 8h gap');
  assert.equal(db.prepare('SELECT ended_at FROM play_logs ORDER BY started_at').get().ended_at, null,
    'it must stay OPEN — a missing duration reads as missing, an invented one reads as fact');
});

test('a normal gap still closes, using the item length as the ceiling', () => {
  const db = freshDb();
  withContent(db, 'c1', 20);
  addRow(db, { content_id: 'c1', started_at: NOW - 20 });
  addRow(db, { content_id: 'c1', started_at: NOW, ended_at: NOW + 20 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 1);
  assert.equal(db.prepare('SELECT duration_sec FROM play_logs ORDER BY started_at').get().duration_sec, 20);
});

test('a little slack over the known length is allowed, a lot is not', () => {
  // Rounding and a stalled decoder can push a play slightly past its nominal length.
  const db = freshDb();
  withContent(db, 'c1', 20);
  addRow(db, { content_id: 'c1', started_at: NOW - 50 });             // 30s over nominal
  addRow(db, { content_id: 'c1', started_at: NOW, ended_at: NOW + 10 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 1, 'modest overrun should still close');

  const db2 = freshDb();
  withContent(db2, 'c1', 20);
  addRow(db2, { content_id: 'c1', started_at: NOW - 600 });           // 10 minutes for a 20s clip
  addRow(db2, { content_id: 'c1', started_at: NOW, ended_at: NOW + 10 });
  assert.equal(closeStrandedPlays(db2, 'dev1'), 0, 'a wild overrun must not close');
});

test('a LONG item is allowed its real length', () => {
  // The cap is the content's own duration, so a 40-minute video closes at 40 minutes — a fixed
  // small cap would have wrongly refused this.
  const db = freshDb();
  withContent(db, 'film', 2400);
  addRow(db, { content_id: 'film', started_at: NOW - 2400 });
  addRow(db, { content_id: 'film', started_at: NOW, ended_at: NOW + 10 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 1);
  assert.equal(db.prepare('SELECT duration_sec FROM play_logs ORDER BY started_at').get().duration_sec, 2400);
});

test('unknown length (a widget) falls back to a modest absolute cap', () => {
  const db = freshDb();
  addRow(db, { content_id: null, started_at: NOW - 300 });            // no content row to join
  addRow(db, { content_id: null, started_at: NOW, ended_at: NOW + 10 });
  assert.equal(closeStrandedPlays(db, 'dev1'), 1, 'a 5-minute widget dwell is plausible');

  const db2 = freshDb();
  addRow(db2, { content_id: null, started_at: NOW - (INFER_UNKNOWN_MAX_SEC + 600) });
  addRow(db2, { content_id: null, started_at: NOW, ended_at: NOW + 10 });
  assert.equal(closeStrandedPlays(db2, 'dev1'), 0, 'beyond the fallback cap it stays open');
});
