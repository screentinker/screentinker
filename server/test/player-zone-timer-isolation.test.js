'use strict';

/*
 * A second rotation must not have its advance timer cancelled by a layout change.
 *
 * showZoneItem() is the player's scoped rotation engine: its own container, its own item list, its
 * own keyed timer, advancing on duration or video-end. A multi-zone layout runs several of them at
 * once, and the triggers work (docs/triggers-design.md) runs one more inside #pipContainer.
 *
 * ⚠️ Every one of them used to key into the SAME module-level `zoneTimers` map, and renderZones()
 * begins with clearZoneTimers(), which wipes that map wholesale. So an unrelated layout change
 * silently cancelled any other rotation's pending advance — no throw, no log, the rotation simply
 * stopped advancing and sat on whatever item it had reached. That is the worst shape of bug this
 * player can have: something stops moving and nothing anywhere says why.
 *
 * `timers` is now a parameter defaulting to zoneTimers, so an independent rotation passes its own
 * store and clearZoneTimers() cannot reach it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(
  path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** The real declarations, lifted verbatim and run against fakes. */
function harness() {
  // showZoneEmpty and showZoneItem sit either side of renderZones, so the slice spans all three.
  // renderZones is only DECLARED here, never called, so its own globals never have to exist.
  const start = PLAYER.indexOf('    // #74/#75 zone-level schedule helpers.');
  const end = PLAYER.indexOf('    // ==================== Screenshots ====================', start);
  assert.ok(start > 0 && end > start, 'the zone rotation block is still in index.html');
  const src = PLAYER.slice(start, end);
  assert.match(src, /function showZoneItem\(/, 'the slice must contain the rotation itself');

  const timeouts = [];
  const env = {
    zoneTimers: {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: (id) => { if (id) timeouts[id - 1] = null; },
    // showZoneItem needs these; none are exercised by the timer-isolation assertions.
    scheduleAllows: () => true,   // zoneNextActive's only dependency
    itemFit: () => 'contain',     // defined outside the sliced block; fit isn't exercised here
    mediaUrl: (a) => a.src || 'x.mp4',
    config: { serverUrl: '', deviceId: 'd1' },
    widgetSandboxAttr: () => '',
    createYoutubeEmbed: () => {},
    addWebpageNote: () => {},
    PREVIEW_MODE: false,
    document: { createElement: () => fakeEl() },
  };
  function fakeEl() {
    return {
      style: {}, setAttribute() {}, appendChild() {}, querySelectorAll: () => [],
      set innerHTML(_v) {}, get innerHTML() { return ''; },
      addEventListener() {}, play: () => Promise.resolve(), pause() {}, load() {},
      removeAttribute() {},
    };
  }
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `${src}; return { showZoneItem, showZoneEmpty };`);
  const api = make(...names.map((n) => env[n]));
  return { api, env, timeouts, fakeEl };
}

test('the rotation still defaults to the shared map, so existing callers are unchanged', () => {
  const { api, env, fakeEl } = harness();
  const div = fakeEl();
  api.showZoneItem({ id: 'zoneA' }, div, [{ duration_sec: 5 }, { duration_sec: 5 }], 0);
  assert.ok(env.zoneTimers.zoneA, 'a caller passing no store must still use zoneTimers');
});

test('⚠️ a rotation given its OWN store does not touch the shared one', () => {
  const { api, env, fakeEl } = harness();
  const mine = {};
  api.showZoneItem({ id: '__trigger__' }, fakeEl(),
    [{ duration_sec: 5 }, { duration_sec: 5 }], 0, mine);
  assert.ok(mine.__trigger__, 'the timer went to the private store');
  assert.deepEqual(env.zoneTimers, {},
    'the shared map was written to — clearZoneTimers() would cancel this rotation');
});

test('THE BUG: clearing the layout timers leaves an independent rotation running', () => {
  const { api, env, timeouts, fakeEl } = harness();
  const mine = {};
  api.showZoneItem({ id: 'zoneA' }, fakeEl(), [{ duration_sec: 5 }, { duration_sec: 5 }], 0);
  api.showZoneItem({ id: '__trigger__' }, fakeEl(), [{ duration_sec: 5 }, { duration_sec: 5 }], 0, mine);

  // What renderZones() does first, verbatim: wipe every layout timer.
  for (const k in env.zoneTimers) env.clearTimeout(env.zoneTimers[k]);

  const mineId = mine.__trigger__;
  assert.ok(timeouts[mineId - 1], 'a layout change cancelled the independent rotation');
});

test('an empty zone reschedules into whichever store it was given', () => {
  // showZoneEmpty is the other writer, and it recurses back into showZoneItem — so it has to carry
  // the store through or the retry lands in the shared map and becomes cancellable again.
  const { api, env, fakeEl } = harness();
  const mine = {};
  api.showZoneEmpty({ id: '__trigger__' }, fakeEl(), [{ duration_sec: 5 }], mine);
  assert.ok(mine.__trigger__, 'the retry timer went to the private store');
  assert.deepEqual(env.zoneTimers, {}, 'and not to the shared one');
});
