'use strict';

/*
 * #299 — the shared offline proof-of-play queue used by the web player (and therefore BrightSign
 * and Fire TV/Vega) and, byte-identically, by the Tizen .wgt.
 *
 * ⚠️ THE BUG: every player guarded its proof-of-play emit on a live socket and returned, so a play
 * occurring with the link down was thrown away where it happened. A measured 5h49m outage lost
 * ~1,040 plays — the screens played them all and play_logs has a 20,963-second hole.
 *
 * ⚠️ THIS FILE IS COPIED INTO THE .WGT BY tizen/build-wgt.sh, so these tests are the only place the
 * Tizen player's queue behaviour is checked at all — nothing else runs that code before a panel does.
 *
 * The mirror of these rules lives in android/.../data/OfflinePlayQueueTest.kt; the two
 * implementations must agree on the wire shape, which the last test here pins down.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OfflinePlayQueue = require('../lib/offline-play-queue');

let n = 0;
const play = (over = {}) => OfflinePlayQueue.makePlay({
  client_event_id: `evt-${n++}`,
  content_id: 'c1',
  content_name: 'clip.mp4',
  started_at: 1_800_000_000,
  ended_at: 1_800_000_020,
  completed: true,
  ...over,
});

test('THE BUG: a play recorded offline is kept rather than dropped', () => {
  const q = new OfflinePlayQueue();
  q.add(play());
  assert.equal(q.size(), 1);
});

test('a whole outage of plays survives', () => {
  // ~1,040 plays is what the real 5h49m outage produced at 20s an item.
  const q = new OfflinePlayQueue();
  for (let i = 0; i < 1040; i++) q.add(play({ started_at: 1_800_000_000 + i * 20 }));
  assert.equal(q.size(), 1040);
  assert.equal(q.dropped, 0);
});

test('⚠️ a panel offline for weeks cannot fill its storage', () => {
  // Unbounded growth would turn a reporting gap into a dead screen — worse than the bug.
  const q = new OfflinePlayQueue(100);
  for (let i = 0; i < 1000; i++) q.add(play({ started_at: 1_800_000_000 + i }));
  assert.equal(q.size(), 100);
  assert.equal(q.dropped, 900);
});

test('when full it drops the OLDEST, and counts what it dropped', () => {
  const q = new OfflinePlayQueue(3);
  for (const id of ['a', 'b', 'c', 'd']) q.add(play({ client_event_id: id }));
  assert.deepEqual(q.peekBatch().map((p) => p.client_event_id), ['b', 'c', 'd']);
  assert.ok(q.dropped > 0, 'a silent drop is how the original bug hid');
});

test('⚠️ entries are removed only by ACK, never by peeking', () => {
  const q = new OfflinePlayQueue();
  q.add(play({ client_event_id: 'x' }));
  q.add(play({ client_event_id: 'y' }));
  q.peekBatch();
  assert.equal(q.size(), 2, 'peek must not consume — a flush can still be lost in flight');
  q.ack(['x']);
  assert.equal(q.size(), 1);
  assert.equal(q.peekBatch()[0].client_event_id, 'y');
});

test('⚠️ ack by id survives a queue that moved under the flush', () => {
  /*
   * Why ack takes ids, not a count. Live plays keep arriving during a flush and an eviction can
   * shift the queue, so "remove the first N" would delete entries the server never received —
   * silently losing data again, by a different route.
   */
  const q = new OfflinePlayQueue();
  q.add(play({ client_event_id: 'old1' }));
  q.add(play({ client_event_id: 'old2' }));
  const batch = q.peekBatch();
  q.add(play({ client_event_id: 'new1' }));      // arrived mid-flush
  q.ack(batch.map((p) => p.client_event_id));
  assert.equal(q.size(), 1);
  assert.equal(q.peekBatch()[0].client_event_id, 'new1');
});

test('a flush is batched rather than sent in one lump', () => {
  const q = new OfflinePlayQueue();
  for (let i = 0; i < OfflinePlayQueue.BATCH * 3; i++) q.add(play());
  assert.equal(q.peekBatch().length, OfflinePlayQueue.BATCH);
});

test('it round-trips through persistence', () => {
  const q = new OfflinePlayQueue();
  q.add(play({ client_event_id: 'keep-me', started_at: 1_799_999_000, ended_at: 1_799_999_020 }));
  const back = new OfflinePlayQueue();
  back.restore(q.serialize());
  assert.equal(back.size(), 1);
  assert.equal(back.peekBatch()[0].client_event_id, 'keep-me');
  assert.equal(back.peekBatch()[0].started_at, 1_799_999_000);
});

test('⚠️ a corrupt store costs the backlog, never the boot', () => {
  // This runs at startup, and a panel losing power mid-write is the ordinary case for signage.
  for (const junk of [null, undefined, '', '   ', '{', 'not json', '[{"broken":', '[1,2,3]', '[{}]', '{"a":1}']) {
    const q = new OfflinePlayQueue();
    assert.doesNotThrow(() => q.restore(junk), `restore(${JSON.stringify(junk)}) threw`);
    assert.equal(q.size(), 0);
  }
});

test('entries without the fields that make them meaningful are refused', () => {
  // No start time cannot be reported honestly; no id cannot be de-duplicated on replay.
  const q = new OfflinePlayQueue();
  q.add({ client_event_id: 'no-start' });
  q.add({ started_at: 1_800_000_000 });
  q.add(play({ client_event_id: 'good' }));
  assert.equal(q.size(), 1);
  assert.equal(q.peekBatch()[0].client_event_id, 'good');
});

test('ids are unique across rapid creation', () => {
  // They are what makes a re-flush idempotent server-side; a collision would silently drop a play.
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(OfflinePlayQueue.newId());
  assert.equal(ids.size, 2000);
});

test('⚠️ the wire shape matches what the server and the Android queue expect', () => {
  /*
   * Three implementations (this, Kotlin, the server handler) have to agree. The server reads
   * exactly these keys in lib/play-backfill; a rename here would land as silently-rejected rows.
   */
  const p = play({ client_event_id: 'e1', started_at: 1_799_990_000, ended_at: 1_799_990_020 });
  assert.deepEqual(Object.keys(p).sort(),
    ['client_event_id', 'completed', 'content_id', 'content_name', 'ended_at', 'started_at', 'widget_id']);

  const { normalizeBackfillPlay } = require('../lib/play-backfill');
  const settled = normalizeBackfillPlay(p, 1_800_000_000);
  assert.ok(settled, 'the server must accept what this queue produces');
  assert.equal(settled.started_at, 1_799_990_000);
  assert.equal(settled.duration_sec, 20);
  assert.equal(settled.client_event_id, 'e1');
});
