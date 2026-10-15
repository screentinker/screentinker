'use strict';

/*
 * 3.0.1 preview refresh (lib/preview-refresh.js): one fresh screenshot after a screen is paired or
 * sent new content, and the bounds that keep a fleet-wide publish from becoming a screenshot storm.
 * Pure: the clock is passed in and the requester is a fake.
 */

process.env.PREVIEW_REFRESH_SETTLE_MS = '8000';
process.env.PREVIEW_REFRESH_MIN_GAP_MS = '60000';
process.env.PREVIEW_REFRESH_PER_MINUTE = '60';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../lib/preview-refresh');

let asked;
let answer;
beforeEach(() => {
  pr._reset();
  asked = [];
  answer = () => true;
  pr.setRequester((id) => { asked.push(id); return answer(id); });
});

// Far in the future, so the module's own 1s tick (real clock) never finds anything due mid-test.
const T0 = Date.now() + 10 * 365 * 24 * 3600 * 1000;

test('a change is followed by ONE ask, after the settle time (plus a per-screen jitter under half of it)', () => {
  assert.equal(pr.noteChange('dev-a', T0), true);
  assert.equal(pr.runDue(T0 + 7999), 0, 'not before the player has had time to draw');
  assert.deepEqual(asked, []);
  assert.equal(pr.runDue(T0 + 12000), 1, 'by settle + max jitter it has asked');
  assert.deepEqual(asked, ['dev-a']);
  assert.equal(pr.runDue(T0 + 60000), 0, 'and only once');
});

test('debounced: changes while one ask waits push it back, never add a second, never past MAX_WAIT_MS', () => {
  pr.noteChange('dev-a', T0);
  for (let t = T0 + 5000; t < T0 + 60000; t += 5000) {
    pr.noteChange('dev-a', t);
    pr.runDue(t);
  }
  assert.deepEqual(asked, ['dev-a'], 'a screen whose content keeps changing is still asked, once');
  // It fired no later than MAX_WAIT_MS after the first change.
  pr._reset(); asked = []; pr.setRequester((id) => { asked.push(id); return true; });
  pr.noteChange('dev-b', T0);
  for (let t = T0 + 1000; t <= T0 + pr.MAX_WAIT_MS; t += 1000) pr.noteChange('dev-b', t);
  assert.equal(pr._pending('dev-b').due, T0 + pr.MAX_WAIT_MS);
});

test('a floor per screen: a second change within the gap is asked for at the end of it, not at once', () => {
  pr.noteChange('dev-a', T0);
  pr.runDue(T0 + 12000);
  assert.equal(asked.length, 1);
  pr.noteChange('dev-a', T0 + 15000);
  assert.equal(pr.runDue(T0 + 40000), 0, 'within the per-screen gap nothing is asked');
  assert.equal(pr.runDue(T0 + 12000 + 60000), 1, 'the change is not lost: asked when the gap ends');
  assert.deepEqual(asked, ['dev-a', 'dev-a']);
});

test('a fleet-wide publish is capped per node per minute; the rest wait for the next minute', () => {
  for (let i = 0; i < 150; i++) pr.noteChange(`dev-${i}`, T0);
  assert.equal(pr.runDue(T0 + 20000), 60, 'at most the per-minute cap in the first minute');
  assert.equal(pr.runDue(T0 + 30000), 0, 'nothing more inside the same minute');
  assert.equal(pr.runDue(T0 + 20000 + 60000), 60);
  assert.equal(pr.runDue(T0 + 20000 + 120000), 30);
  assert.equal(new Set(asked).size, 150, 'every screen asked exactly once');
  assert.equal(asked.length, 150);
});

test('a screen that is offline / not here / cannot take screenshots costs nothing against the cap', () => {
  answer = (id) => id.startsWith('ok-');   // the requester refuses (deviceSocket checks connection, status, capability)
  for (let i = 0; i < 100; i++) pr.noteChange(`no-${i}`, T0);
  pr.noteChange('ok-1', T0);
  assert.equal(pr.runDue(T0 + 20000), 1, 'the refused ones were dropped, not counted');
  assert.ok(asked.includes('ok-1'));
  assert.equal(pr.runDue(T0 + 90000), 0, 'and not retried');
});

test('a frame that arrives on its own after the settle time cancels the ask; an earlier one does not', () => {
  pr.noteChange('dev-a', T0);
  pr.noteFrame('dev-a', T0 + 2000);       // e.g. still the pairing frame
  assert.ok(pr._pending('dev-a'), 'a frame taken before the player could draw the change does not count');
  pr.noteFrame('dev-a', T0 + 9000);       // the dashboard's own poll got a fresh one
  assert.equal(pr._pending('dev-a'), null);
  assert.equal(pr.runDue(T0 + 20000), 0);
  assert.deepEqual(asked, []);
});

test('offline forgets the screen: nothing pending, and its floor is not kept', () => {
  pr.noteChange('dev-a', T0);
  pr.forget('dev-a');
  assert.equal(pr.runDue(T0 + 20000), 0);
  pr.noteChange('dev-b', T0);
  pr.runDue(T0 + 20000);
  pr.forget('dev-b');
  pr.noteChange('dev-b', T0 + 25000);
  assert.ok(pr._pending('dev-b').due < T0 + 25000 + 20000, 'a screen back from offline is not held to the old floor');
});

test('nothing wired or nonsense input: never throws, never asks', () => {
  pr.setRequester(null);
  assert.equal(pr.noteChange(null, T0), false);
  assert.equal(pr.noteChange('', T0), false);
  pr.noteChange('dev-a', T0);
  assert.equal(pr.runDue(T0 + 20000), 0);
  pr.setRequester(() => { throw new Error('boom'); });
  pr.noteChange('dev-b', T0 + 100000);
  assert.equal(pr.runDue(T0 + 200000), 0);
});

test('the pending map is bounded', () => {
  for (let i = 0; i < pr.MAX_PENDING; i++) pr.noteChange(`d${i}`, T0);
  assert.equal(pr.noteChange('one-too-many', T0), false);
  pr._reset();
});

test('wired into the one place every playlist push meets: delivered → followed up; queued for an offline screen → not', () => {
  const commandQueue = require('../lib/command-queue');
  const rooms = new Map([['here', new Set(['sock1'])]]);
  const deviceNs = { adapter: { rooms }, to: () => ({ emit: () => {} }) };
  const build = () => ({ assignments: [] });
  assert.equal(commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'here', build, true).delivered, true);
  assert.ok(pr._pending('here'), 'a delivered push schedules the preview refresh');
  assert.equal(commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'away', build, true).queued, true);
  assert.equal(pr._pending('away'), null, 'a screen that is not connected is not followed up');
  pr._reset();
});

/* ───────────── only when what the screen was told to show CHANGED ───────────── */

const ITEM = { content_id: 'c1', filepath: 'c1.jpg', filename: 'c1.jpg', duration_sec: 10, schedules: [] };
const payloadOf = (items, extra = {}) => ({ assignments: items, layout: null, orientation: 'landscape', background_color: null,
  default_content: null, triggers: [], power_schedule: null, endpoints: [], timezone: 'UTC', local_api: null, ...extra });

test('the same payload pushed twice → one ask', () => {
  const p = payloadOf([ITEM]);
  assert.equal(pr.notePush('dev-a', p, T0), true, 'the first push the screen was sent is followed up');
  assert.equal(pr.runDue(T0 + 12000), 1);
  // A data-source refresh / local-conditions / replica re-push: a NEW object, the same content.
  assert.equal(pr.notePush('dev-a', JSON.parse(JSON.stringify(p)), T0 + 20000), false);
  assert.equal(pr.notePush('dev-a', payloadOf([{ ...ITEM }]), T0 + 200000), false, 'not even long after the gap');
  assert.equal(pr.runDue(T0 + 400000), 0);
  assert.deepEqual(asked, ['dev-a']);
});

test('the per-screen gap holds across several changes: the MAX_WAIT_MS cap never pulls an ask in under it', () => {
  // Asked at ~T0+12 s (the first change). Two more changes inside the gap: the ask must wait for the
  // gap to end. Before the fix the second one moved it to firstAt + MAX_WAIT_MS, inside the gap.
  pr.noteChange('dev-a', T0);
  assert.equal(pr.runDue(T0 + 12000), 1);
  const askedAt = T0 + 12000;
  pr.noteChange('dev-a', T0 + 20000);
  pr.noteChange('dev-a', T0 + 25000);
  assert.ok(pr._pending('dev-a').due >= askedAt + 60000, 'still due at the end of the gap, not before');
  assert.equal(pr.runDue(T0 + 20000 + pr.MAX_WAIT_MS), 0, 'not at firstAt + MAX_WAIT_MS, which is inside the gap');
  assert.equal(pr.runDue(askedAt + 60000), 1, 'asked when the gap ends');
  assert.deepEqual(asked, ['dev-a', 'dev-a']);
});

test('PREVIEW_REFRESH=off: no change is followed up', () => {
  const config = require('../config');
  const was = config.previewRefreshEnabled;
  config.previewRefreshEnabled = false;
  try {
    assert.equal(pr.noteChange('dev-a', T0), false);
    assert.equal(pr._pending('dev-a'), null);
    assert.equal(pr.runDue(T0 + 120000), 0);
    assert.deepEqual(asked, []);
  } finally { config.previewRefreshEnabled = was; }
});

test('a changed payload → a second ask, after the per-screen gap', () => {
  pr.notePush('dev-a', payloadOf([ITEM]), T0);
  pr.runDue(T0 + 12000);
  assert.equal(pr.notePush('dev-a', payloadOf([ITEM, { content_id: 'c2', filepath: 'c2.mp4' }]), T0 + 20000), true);
  assert.equal(pr.runDue(T0 + 40000), 0, 'not inside the gap');
  assert.equal(pr.runDue(T0 + 12000 + 60000), 1);
  assert.deepEqual(asked, ['dev-a', 'dev-a']);
});

test('what changes the picture counts; what does not, does not', () => {
  const base = payloadOf([ITEM]);
  pr.seen('dev-a', base);
  const same = [
    { triggers: [{ id: 't1' }] }, { power_schedule: { windows: [] } }, { endpoints: [{ id: 'e1' }] },
    { timezone: 'Europe/London' }, { local_api: { enabled: true } }, { group_sync: { key: 'k' } },
  ];
  for (const extra of same) assert.equal(pr.notePush('dev-a', payloadOf([ITEM], extra), T0), false, JSON.stringify(extra));
  // Per-item fields the player's structural fingerprint leaves out (synced in place) are not a change either.
  assert.equal(pr.notePush('dev-a', payloadOf([{ ...ITEM, duration_sec: 99, muted: 1, title: 'x' }]), T0), false);
  assert.equal(pr._pending('dev-a'), null);
  const changed = [
    payloadOf([{ ...ITEM, widget_rev: 2 }]), payloadOf([ITEM], { orientation: 'portrait' }),
    payloadOf([ITEM], { background_color: '#202020' }), payloadOf([ITEM], { layout: { id: 'L1', zones: [] } }),
    payloadOf([ITEM], { default_content: { content_id: 'c9' } }), payloadOf([]),
  ];
  let prev = base;
  for (const p of changed) {
    pr._reset(); pr.seen('dev-a', prev);
    assert.equal(pr.notePush('dev-a', p, T0), true, JSON.stringify(p).slice(0, 120));
    prev = p;
  }
});

test('the register path\'s payload is a baseline, never an ask; an identical push after it costs nothing', () => {
  const p = payloadOf([ITEM]);
  assert.equal(pr.seen('dev-a', p), p, 'seen() hands the payload through for the emit');
  assert.equal(pr._pending('dev-a'), null);
  assert.equal(pr.notePush('dev-a', payloadOf([ITEM]), T0), false);
  assert.equal(pr.runDue(T0 + 20000), 0);
});

test('the reconnect flush seeds the baseline without asking (a mass reconnect asks for nothing)', () => {
  const commandQueue = require('../lib/command-queue');
  const rooms = new Map();
  const deviceNs = { adapter: { rooms }, to: () => ({ emit: () => {} }) };
  const build = () => payloadOf([ITEM]);
  commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'back', build, true);   // offline: queued
  rooms.set('back', new Set(['s']));
  assert.equal(commandQueue.flushQueue(deviceNs, 'back', build).playlistUpdate, true);
  assert.equal(pr._pending('back'), null, 'the flush did not ask');
  commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'back', build, true);   // the same content re-pushed
  assert.equal(pr._pending('back'), null, 'and the identical push after it costs nothing');
  pr._reset();
});

test('the item signature is the web player\'s STRUCTURAL fingerprint, field for field', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const mine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'preview-refresh.js'), 'utf8');
  const theirs = player.match(/const fingerprint = \(items\) => items\.map\(a => (`[^`]+`)\)\.join/);
  const ours = mine.match(/function itemFingerprint\(a\) \{\n\s*return (`[^`]+`);/);
  assert.ok(theirs && ours, 'both fingerprints found');
  assert.equal(ours[1], theirs[1], 'if the player\'s fingerprint changes, change itemFingerprint() with it');
});
