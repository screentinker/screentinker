'use strict';

/*
 * compose() — head office's playlist with a store's slot content spliced in (spec §3.2, D15).
 * Pure: no database. Every output is also checked for a leaked marker (`__slot`), which must never
 * reach a player.
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - compose.js composeDetailed: weave BEFORE the splice (move applyRepeatEvery onto the composable)
 *       -> "a slot marker is replaced by the store's items, in place" (and the repeat-every test)
 *   - compose.js isUnboundedItem: drop the LIVE_MIMES test -> "every unbounded item is dropped ..."
 *   - compose.js effectiveSeconds: count a video at duration_sec only -> "a video counts at its real length ..."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  compose, composeDetailed, fillViolation, filterFillItems, isUnboundedItem, effectiveSeconds,
} = require('../lib/corporate/compose');

const HQ = 'ws-hq';
const STORE = 'ws-store';
const img = (id, extra = {}) => ({ content_id: id, mime_type: 'image/png', duration_sec: 10, zone_id: null, sort_order: 0, ...extra });
const vid = (id, len, extra = {}) => ({ content_id: id, mime_type: 'video/mp4', duration_sec: 10, content_duration: len, sort_order: 0, ...extra });
const marker = (slot, extra = {}) => ({ __slot: slot, zone_id: null, sort_order: 0, limits: { max_items: null, max_total_sec: null, allow_video: 1, allow_widgets: 1 }, fallback: null, ...extra });
const noMarker = (items) => assert.ok(items.every((it) => !('__slot' in it)), 'a marker leaked into a player payload');
const ids = (items) => items.map((it) => it.content_id || it.widget_id);

test('a slot marker is replaced by the store\'s items, in place', () => {
  const out = compose([img('hq1'), marker('S'), img('hq2')], new Map([['S', [img('s1'), img('s2')]]]));
  assert.deepEqual(ids(out), ['hq1', 's1', 's2', 'hq2']);
  noMarker(out);
});

test('an empty slot plays its fallback; with no fallback the slot is skipped', () => {
  const fb = img('fallback');
  assert.deepEqual(ids(compose([img('a'), marker('S', { fallback: fb }), img('b')], new Map())), ['a', 'fallback', 'b']);
  assert.deepEqual(ids(compose([img('a'), marker('S', { fallback: fb }), img('b')], new Map([['S', []]]))), ['a', 'fallback', 'b']);
  const skipped = compose([img('a'), marker('S'), img('b')], new Map());
  assert.deepEqual(ids(skipped), ['a', 'b']);
  noMarker(skipped);
  const d = composeDetailed([marker('S')], new Map());
  assert.equal(d.slots[0].outcome, 'skipped');
});

test('max_items and max_total_sec truncate (the belt; publish refuses first)', () => {
  const m = marker('S', { limits: { max_items: 2, max_total_sec: null } });
  assert.deepEqual(ids(compose([m], new Map([['S', [img('1'), img('2'), img('3')]]]))), ['1', '2']);
  const m2 = marker('S', { limits: { max_items: null, max_total_sec: 25 } });
  // 10 + 10 = 20 fits, + 10 = 30 does not: the longest prefix that fits.
  assert.deepEqual(ids(compose([m2], new Map([['S', [img('1'), img('2'), img('3')]]]))), ['1', '2']);
});

test('type filters: no videos / no widgets', () => {
  const items = [img('i'), vid('v', 20), { widget_id: 'w', duration_sec: 10 }];
  assert.deepEqual(ids(compose([marker('S', { limits: { allow_video: 0, allow_widgets: 1 } })], new Map([['S', items]]))), ['i', 'w']);
  assert.deepEqual(ids(compose([marker('S', { limits: { allow_video: 1, allow_widgets: 0 } })], new Map([['S', items]]))), ['i', 'v']);
});

test('every unbounded item is dropped: HLS (any duration), RTSP, YouTube, a video with no known length', () => {
  const unbounded = [
    { content_id: 'hls0', mime_type: 'video/hls', duration_sec: null },
    { content_id: 'hls1', mime_type: 'video/hls', duration_sec: 0 },
    { content_id: 'hls30', mime_type: 'video/hls', duration_sec: 30 },
    { content_id: 'rtsp', mime_type: 'video/rtsp', duration_sec: 30 },
    // A probe CAN report a length for a stream; a live mime is unbounded regardless.
    { content_id: 'hls-probed', mime_type: 'video/hls', duration_sec: 30, content_duration: 30 },
    { content_id: 'rtsp-probed', mime_type: 'video/rtsp', duration_sec: 30, content_duration: 30 },
    { content_id: 'yt', mime_type: 'video/youtube', duration_sec: 30 },
    { content_id: 'remote', mime_type: 'video/mp4', duration_sec: 30, content_duration: null, remote_url: 'https://x/v.mp4' },
  ];
  for (const u of unbounded) assert.equal(isUnboundedItem(u), true, `${u.content_id} must count as unbounded`);
  const out = compose([marker('S')], new Map([['S', [...unbounded, img('ok')]]]));
  assert.deepEqual(ids(out), ['ok']);
  for (const u of unbounded) {
    const v = fillViolation([u], {});
    assert.equal(v && v.code, 'FILL_LIVE', `${u.content_id} is refused at publish too`);
  }
});

test('a video counts at its real length: duration_sec 10, content length 600 -> 600', () => {
  const v = vid('v', 600);
  assert.equal(effectiveSeconds(v), 600);
  assert.equal(effectiveSeconds(vid('short', 4)), 10, 'and never less than its dwell');
  const viol = fillViolation([v], { max_total_sec: 60 });
  assert.equal(viol.code, 'FILL_LIMIT');
  assert.equal(viol.vars.sec, 600);
  // compose's belt agrees: a 600 s video does not fit a 60 s slot.
  assert.deepEqual(compose([marker('S', { limits: { max_total_sec: 60 } })], new Map([['S', [v]]])), []);
  // The length read at compose time beats the snapshot's copy (a replaced file).
  assert.equal(effectiveSeconds(vid('v', 5), { contentDuration: () => 900 }), 900);
});

test('fillViolation: flat, live, type and limit refusals, in that order', () => {
  assert.equal(fillViolation([{ child_playlist_id: 'p' }], {}).code, 'FILL_FLAT');
  assert.equal(fillViolation([{ slot_id: 's' }], {}).code, 'FILL_FLAT');
  assert.equal(fillViolation([vid('v', 5)], { allow_video: 0 }).code, 'FILL_TYPE');
  const lim = fillViolation([img('1'), img('2'), img('3')], { max_items: 2 });
  assert.equal(lim.code, 'FILL_LIMIT');
  assert.deepEqual([lim.vars.n, lim.vars.max_items, lim.vars.max_sec], [3, 2, null]);
  assert.equal(fillViolation([img('1'), img('2')], { max_items: 2, max_total_sec: 20 }), null, 'exactly at the limit is fine');
});

test('__origin_ws: head office for corporate items and fallbacks, the store for slot items', () => {
  const out = compose([img('hq'), marker('S'), marker('T', { fallback: img('fb') })],
    new Map([['S', { items: [img('s1')], workspace_id: STORE }]]), { tagOrigin: true, hqWorkspaceId: HQ });
  assert.deepEqual(out.map((it) => [it.content_id, it.__origin_ws]), [['hq', HQ], ['s1', STORE], ['fb', HQ]]);
});

test('head office decides where and when: zone from the marker; play windows intersect both ways; weight from the marker', () => {
  const m = marker('S', { zone_id: 'zone-hq', play_from: '2026-10-01T09:00', play_until: '2026-10-31T18:00', weight: 3 });
  const [a, b] = compose([m], new Map([['S', [
    img('early', { zone_id: 'store-zone', play_from: '2026-09-01T00:00', play_until: '2026-10-15T00:00' }),
    img('late', { play_from: '2026-10-20T00:00', play_until: '2026-12-01T00:00' }),
  ]]]));
  assert.equal(a.zone_id, 'zone-hq', 'a store zone id means nothing on head office\'s layout');
  assert.deepEqual([a.play_from, a.play_until], ['2026-10-01T09:00', '2026-10-15T00:00']);
  assert.deepEqual([b.play_from, b.play_until], ['2026-10-20T00:00', '2026-10-31T18:00']);
  assert.equal(a.weight, 3);
});

test('item dayparts, mute, fit, play_when and log_play ride along untouched; a store item never weaves', () => {
  const s = img('s', { schedules: [{ days: [1], start: '09:00', end: '12:00' }], muted: 1, fit_mode: 'cover', play_when: { type: 'tag', op: 'has', value: 'x' }, log_play: 0, repeat_every_sec: 60 });
  const [out] = compose([marker('S')], new Map([['S', [s]]]));
  assert.deepEqual(out.schedules, s.schedules);
  assert.equal(out.muted, 1);
  assert.equal(out.fit_mode, 'cover');
  assert.deepEqual(out.play_when, s.play_when);
  assert.equal(out.log_play, 0);
  assert.ok(!('repeat_every_sec' in out));
});

test('repeat-every is woven AFTER the splice: head office\'s "every 60 s" spaces over the store\'s real loop', () => {
  const every = img('hq-every', { duration_sec: 10, repeat_every_sec: 60 });
  const longFill = Array.from({ length: 12 }, (_, i) => img(`s${i}`, { duration_sec: 10 }));
  const out = compose([every, marker('S')], new Map([['S', longFill]]));
  const copies = out.filter((it) => it.content_id === 'hq-every').length;
  // A 130 s loop with a 60 s interval holds the item more than once; woven over the fallback-only
  // loop (just the item, no store content) it could only ever appear once.
  assert.ok(copies >= 2, `expected the interval item to repeat across the store's loop, got ${copies}`);
  const short = compose([every, marker('S')], new Map([['S', [img('only', { duration_sec: 10 })]]]));
  assert.equal(short.filter((it) => it.content_id === 'hq-every').length, 1, 'a short store loop keeps one copy');
  noMarker(out);
});

test('shuffle / weighted strip repeat_every_sec instead of weaving', () => {
  const out = compose([img('a', { repeat_every_sec: 60 }), marker('S')], new Map([['S', [img('s')]]]), { playbackOrder: 'shuffle' });
  assert.ok(out.every((it) => !('repeat_every_sec' in it)));
  assert.equal(out.length, 2);
});

test('sort_order is renumbered when anything was spliced (Tizen re-sorts by it)', () => {
  const out = compose([img('a', { sort_order: 5 }), marker('S', { sort_order: 6 }), img('b', { sort_order: 7 })], new Map([['S', [img('s1', { sort_order: 0 }), img('s2', { sort_order: 1 })]]]));
  assert.deepEqual(out.map((it) => it.sort_order), [0, 1, 2, 3]);
});

test('a marker-free list comes back byte-identical (a corporate playlist with no slots, published before slots existed)', () => {
  const list = [img('a', { sort_order: 4 }), vid('b', 30, { sort_order: 9 })];
  const before = JSON.stringify(list);
  const out = compose(list, new Map());
  assert.equal(JSON.stringify(out), before);
  assert.equal(JSON.stringify(list), before, 'and the input is never mutated');
});

test('nested and slot rows smuggled into a fill never play', () => {
  const out = compose([marker('S')], new Map([['S', [{ child_playlist_id: 'p', duration_sec: 10 }, { __slot: 'X' }, img('ok')]]]));
  assert.deepEqual(ids(out), ['ok']);
  noMarker(out);
  assert.equal(filterFillItems([{ slot_id: 'x', duration_sec: 5 }]).length, 0);
});
