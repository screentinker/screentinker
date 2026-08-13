'use strict';

// A user reported not knowing how to get content onto a screen. There WAS onboarding — a modal
// wizard — but it is gated on a localStorage flag: skip it once and it never returns, and it
// never knew whether you actually succeeded at anything. Someone who closed it was left with no
// thread to pull.
//
// The replacement reads the account's real state instead of a flag. That is the property worth
// pinning: it must not congratulate someone who has not finished, must not nag someone who has,
// and must point at the FIRST thing that is actually possible rather than the first thing missing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The component and the i18n module it imports both read localStorage — that is not incidental,
// it is how the dismissal persists. Give them a real one rather than stubbing the behaviour out,
// so the dismissal tests below exercise the actual mechanism.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
// Node 22 added a built-in `navigator` global, defined as a getter with NO setter — so the plain
// assignment this used to do throws ("only a getter") under 'use strict' there, while being fine on
// Node 20 where the global does not exist at all. It is configurable, so define it rather than
// assign. Doing that unconditionally is also the more honest fixture: Node 22's own navigator
// reports the HOST locale (en-US here, something else on another machine or in CI), and a test that
// reads its language should not depend on where it runs.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en' }, configurable: true, writable: true,
});

const MOD = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'getting-started.js')).href;
let GS;
test('load', async () => {
  GS = await import(MOD);
  assert.ok(typeof GS.computeSteps === 'function');
});

const withDevice = [{ id: 'd1' }];
const assignedDevice = [{ id: 'd1', playlist_id: 'p1' }];

test('an empty account is at step one, and step one is the screen', async () => {
  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  assert.equal(s.doneCount, 0);
  assert.equal(s.complete, false);
  assert.equal(s.steps[s.nextIndex].key, 'device', 'nothing else is possible until a screen exists');
});

test('progress reflects what is really there, not what was clicked through', async () => {
  const s = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [] });
  assert.equal(s.doneCount, 2);
  assert.equal(s.steps[s.nextIndex].key, 'playlist');
});

test('THE POINT: it is only finished when something is actually ON a screen', async () => {
  // Creating a playlist and walking away is the exact failure the report described — plenty of
  // objects, nothing playing. That must NOT read as complete.
  const almost = GS.computeSteps({ devices: withDevice, content: [{ id: 'c1' }], playlists: [{ id: 'p1' }] });
  assert.equal(almost.complete, false, 'objects exist but no screen is showing anything');
  assert.equal(almost.steps[almost.nextIndex].key, 'assign');

  const done = GS.computeSteps({ devices: assignedDevice, content: [{ id: 'c1' }], playlists: [{ id: 'p1' }] });
  assert.equal(done.complete, true);
  assert.equal(done.nextIndex, -1);
});

test('assigning a playlist or a layout counts', async () => {
  for (const d of [{ id: 'x', playlist_id: 'p' }, { id: 'x', layout_id: 'l' }]) {
    const s = GS.computeSteps({ devices: [d], content: [{ id: 'c' }], playlists: [{ id: 'p' }] });
    assert.equal(s.complete, true, `${Object.keys(d).join(',')} should count as assigned`);
  }
});

test('default_content_id does NOT count, because no player reads it', async () => {
  // This test previously asserted the opposite, and it was wrong. Grep the whole tree and
  // default_content appears only in this checklist, the device form, the settings snapshot, the
  // schema and the devices route — never in a socket payload, in assemblePayload, or in any of the
  // four players. Setting it changes nothing on the screen, so counting it told the operator
  // "content assigned" while their display went on showing "waiting for content". A checklist that
  // lies about the one thing it exists to confirm is worse than no checklist.
  const s = GS.computeSteps({ devices: [{ id: 'x', default_content_id: 'c' }], content: [{ id: 'c' }], playlists: [{ id: 'p' }] });
  assert.equal(s.complete, false, 'a screen with only default_content is not actually showing anything');
});

test('steps stay in dependency order — never sent somewhere unusable', async () => {
  // Content before a screen exists is not wrong, but it cannot be PUT anywhere, so the next
  // action must remain the screen.
  const s = GS.computeSteps({ devices: [], content: [{ id: 'c1' }], playlists: [{ id: 'p1' }] });
  assert.equal(s.steps[s.nextIndex].key, 'device');
});

test('it shows while there is work left and hides once finished', async () => {
  GS.undismiss();
  assert.equal(GS.shouldShow(GS.computeSteps({ devices: [], content: [], playlists: [] })), true);
  assert.equal(GS.shouldShow(GS.computeSteps({ devices: assignedDevice, content: [{ id: 'c' }], playlists: [{ id: 'p' }] })), false,
    'a finished account is never nagged');
});

test('dismissing sticks — it is guidance, not a demand', async () => {
  GS.undismiss();
  const empty = GS.computeSteps({ devices: [], content: [], playlists: [] });
  assert.equal(GS.shouldShow(empty), true);
  GS.dismiss();
  assert.equal(GS.shouldShow(empty), false, 'stays hidden even with everything still to do');
  GS.undismiss();
  assert.equal(GS.shouldShow(empty), true, 'and can be brought back');
});

test('every step offers a way to act on it', async () => {
  const s = GS.computeSteps({ devices: [], content: [], playlists: [] });
  for (const step of s.steps) {
    assert.ok(step.title && step.desc && step.cta, `${step.key} is explained`);
    assert.ok(step.href, `${step.key} goes somewhere`);
  }
});
