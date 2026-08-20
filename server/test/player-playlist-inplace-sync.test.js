'use strict';

/*
 * #295 — a duration-only playlist edit never reached a running player.
 *
 * Reported from the field on 1.9.0: change nothing but an item's duration, publish, and the player
 * keeps advancing on the old value. Reloading did not help either, because the stale value was also
 * in the player's localStorage cache.
 *
 * The player builds a STRUCTURAL fingerprint of the item list to decide whether the playlist
 * changed enough to restart. duration_sec is deliberately not part of it — a duration edit must not
 * restart playback at item 1 (#234). The 1.9.0 handler simply had nowhere else to apply it, so it
 * fell out entirely.
 *
 * ⚠️ THE FIX IS NOT "ADD duration_sec TO THE FINGERPRINT", which is what the issue suggests. That
 * is right for 1.9.0 and wrong here: it buys the missing update back at the cost of a restart on
 * every duration edit. The fingerprint answers restart-or-not; the unchanged branch applies
 * everything that does not need one.
 *
 * This exercises the real source sliced out of index.html, so these are facts about the shipped
 * handler rather than a reading of it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PLAYER = fs.readFileSync(path.join(ROOT, 'server/player/index.html'), 'utf8');

/** The real fingerprint expression, lifted verbatim. */
function fingerprintFn() {
  const start = PLAYER.indexOf('const fingerprint = (items)');
  assert.ok(start > 0, 'the fingerprint builder is still in index.html');
  const end = PLAYER.indexOf('\n', start);
  // eslint-disable-next-line no-new-func
  return new Function(`${PLAYER.slice(start, end)}; return fingerprint;`)();
}

/** The real in-place sync block, lifted verbatim and run against fakes. */
function runSync({ playlist, newItems, currentIndex = 0 }) {
  const START = 'let patched = false;';
  const END = 'if (liveMuteChanged) applyMute(playlist[currentIndex]);';
  const i = PLAYER.indexOf(START);
  const j = PLAYER.indexOf(END, i);
  assert.ok(i > 0 && j > i, 'the in-place sync block is still in index.html');
  const src = `${PLAYER.slice(i, j + END.length)}\n}`;   // re-close the `if (patched) {`

  const saves = [];
  const muteCalls = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function('playlist', 'newItems', 'currentIndex', 'savePlaylistCache', 'applyMute',
    `${src}\n; return { patched, liveMuteChanged };`);
  const out = fn(playlist, newItems, currentIndex,
    (p) => saves.push(JSON.parse(JSON.stringify(p))),
    (item) => muteCalls.push(item));
  return { ...out, saves, muteCalls, playlist };
}

const item = (over = {}) => ({
  content_id: 'c1', widget_id: '', widget_rev: '', zone_id: '', remote_url: '', filepath: 'a.mp4',
  filename: 'a.mp4', schedules: [], transition: null, duration_sec: 10, muted: false, ...over,
});

test('a duration-only edit does NOT change the structural fingerprint (so it must not restart)', () => {
  const fp = fingerprintFn();
  assert.equal(fp([item({ duration_sec: 10 })]), fp([item({ duration_sec: 86400 })]),
    'duration is in the fingerprint again — that restarts playback on every duration edit (#234)');
});

test('nor does a mute, caption or subtitle edit', () => {
  const fp = fingerprintFn();
  const base = fp([item()]);
  for (const over of [{ muted: true }, { captions_enabled: true }, { subtitle_url: 's.vtt' }, { title: 'x' }]) {
    assert.equal(fp([item(over)]), base, `${Object.keys(over)[0]} is in the fingerprint — it should be synced in place instead`);
  }
});

test('a real content change DOES change the fingerprint', () => {
  const fp = fingerprintFn();
  assert.notEqual(fp([item()]), fp([item({ content_id: 'c2' })]));
  assert.notEqual(fp([item()]), fp([item(), item()]), 'a longer list is a different playlist');
  assert.notEqual(fp([item({ content_id: 'a' }), item({ content_id: 'b' })]),
    fp([item({ content_id: 'b' }), item({ content_id: 'a' })]), 'order is structural');
});

test('#295: the new duration lands on the live item', () => {
  const r = runSync({ playlist: [item({ duration_sec: 10 })], newItems: [item({ duration_sec: 86400 })] });
  assert.equal(r.playlist[0].duration_sec, 86400);
  assert.equal(r.patched, true);
});

test('#295: and is PERSISTED, so a reload does not revert it from cache', () => {
  const r = runSync({ playlist: [item({ duration_sec: 10 })], newItems: [item({ duration_sec: 86400 })] });
  assert.equal(r.saves.length, 1, 'the refreshed playlist was written back to the cache');
  assert.equal(r.saves[0][0].duration_sec, 86400, 'and the cache holds the NEW duration');
});

test('an unchanged refresh writes nothing — no cache churn on every poll', () => {
  const r = runSync({ playlist: [item()], newItems: [item()] });
  assert.equal(r.patched, false);
  assert.equal(r.saves.length, 0);
});

test('a rebuilt-but-identical schedules array is not a change', () => {
  // Arrays compare by reference; a fresh [] from the server each poll must not look edited or the
  // player would rewrite its cache forever.
  const r = runSync({
    playlist: [item({ schedules: [{ days: [1, 2] }] })],
    newItems: [item({ schedules: [{ days: [1, 2] }] })],
  });
  assert.equal(r.patched, false, 'a value-identical object counted as a change');
  assert.equal(r.saves.length, 0);
});

test('muting the item on screen applies immediately, through the mute resolver', () => {
  const r = runSync({ playlist: [item({ muted: false })], newItems: [item({ muted: true })], currentIndex: 0 });
  assert.equal(r.playlist[0].muted, true);
  assert.equal(r.muteCalls.length, 1, 'applyMute was called for the item on screen');
  assert.equal(r.muteCalls[0], r.playlist[0]);
});

test('muting an item that is NOT on screen patches it but touches no surface', () => {
  const r = runSync({
    playlist: [item({ content_id: 'a' }), item({ content_id: 'b', muted: false })],
    newItems: [item({ content_id: 'a' }), item({ content_id: 'b', muted: true })],
    currentIndex: 0,
  });
  assert.equal(r.playlist[1].muted, true, 'still patched, for the next time it mounts');
  assert.equal(r.muteCalls.length, 0, 'but nothing was applied to the playing item');
});

/*
 * ⚠️ THE ONE THAT MATTERS. duration_sec, schedules, transition, widget_rev and zone_id were each
 * added to this handler only after a field nobody remembered silently stopped taking effect — #295
 * is that bug reported from the field for duration, and muted/captions/subtitles were still missing
 * when it was filed. The sync is wholesale precisely so the list cannot drift again. If someone
 * turns it back into an enumeration, this fails.
 */
test('a per-item field nobody enumerated is still picked up', () => {
  const r = runSync({
    playlist: [item({ some_field_added_next_year: 'old' })],
    newItems: [item({ some_field_added_next_year: 'new' })],
  });
  assert.equal(r.playlist[0].some_field_added_next_year, 'new',
    'the in-place sync is an allowlist again — the next per-item field will silently stop working');
  assert.equal(r.saves.length, 1);
});
