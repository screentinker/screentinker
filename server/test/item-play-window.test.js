'use strict';

// Play window (playlist_items.play_from / play_until): an interval skip next to duration.
// Evaluated on the sign via ScheduleEval; the Outlook calendar only READS it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isItemActiveNow, windowOf, itemShouldPlay, conditionOk } = require('../lib/schedule-eval');

const ROOT = path.join(__dirname, '..', '..');

test('empty window is always on (duration-only still works)', () => {
  assert.equal(isItemActiveNow([], '2026-06-12T00:00:00Z', 'Australia/Sydney', null), true);
  assert.equal(isItemActiveNow([], '2026-06-12T00:00:00Z', 'Australia/Sydney', windowOf({})), true);
});

test('malformed play_from fails OPEN', () => {
  assert.equal(isItemActiveNow([], '2026-06-12T00:00:00Z', 'Australia/Sydney', { play_from: 'not-a-stamp' }), true);
});

test('windowOf reads play_from / play_until off an item', () => {
  assert.equal(windowOf({ play_from: '2026-10-01T18:00' }).play_from, '2026-10-01T18:00');
  assert.equal(windowOf({ duration_sec: 10 }), null);
});

test('web, Tizen, e-ink and BrightSign/webOS players pass windowOf into the evaluator', () => {
  const files = [
    'tizen/js/player.js',
    'server/routes/embedded.js',
  ];
  const web = fs.readFileSync(path.join(ROOT, 'server/player/index.html'), 'utf8');
  assert.match(web, /ScheduleEval\.itemShouldPlay/, 'web player uses itemShouldPlay (window + daypart + enabled + play_when)');
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /itemShouldPlay|windowOf/, `${rel} must pass the play window`);
    assert.match(src, /isItemActiveNow\(|itemShouldPlay\(/, rel);
  }
});

test('Android native player carries playFrom/playUntil into ScheduleEval', () => {
  const ctrl = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt'), 'utf8');
  const zones = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/remotedisplay/player/player/ZoneManager.kt'), 'utf8');
  const evalKt = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/remotedisplay/player/player/ScheduleEval.kt'), 'utf8');
  assert.match(ctrl, /playFrom/);
  assert.match(ctrl, /ScheduleEval\.windowOf\(item\.playFrom/);
  assert.match(zones, /play_from/);
  assert.match(evalKt, /data class Window/);
  // Native Android now also evaluates the data-source condition (parity with web/Tizen/e-ink).
  assert.match(evalKt, /fun conditionOk/, 'Android ScheduleEval must evaluate play_when');
  assert.match(ctrl, /ScheduleEval\.conditionOk\(item\.playWhen/, 'Android scheduleAllows must apply the condition');
  assert.match(ctrl, /obj\.optJSONObject\("_ds"\)/, 'Android must parse the _ds data bag');
});

test('calendar peeks playlist items and does not write schedules rows for them', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/js/views/schedule.js'), 'utf8');
  assert.match(src, /hydratePlaylistItems/);
  assert.match(src, /schedule\.peek_items/);
  assert.doesNotMatch(src, /API\('\/schedules'.*play_from/);
  assert.match(src, /#\/playlists\/\$\{ev\.playlist_id\}/);
});

test('playlist editor writes play_from next to duration', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/js/views/playlists.js'), 'utf8');
  assert.match(src, /item-play-from/);
  assert.match(src, /datetime-local/);
  assert.match(src, /play_from/);
});

test('schema and snapshot carry play_from / play_until', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'server/routes/playlists.js'), 'utf8');
  assert.match(schema, /play_from\s+TEXT/);
  assert.match(schema, /play_until\s+TEXT/);
  assert.match(routes, /pi\.play_from/);
  assert.match(routes, /normalizePlayStamp/);
});

test('disabled items never fail open', () => {
  assert.equal(itemShouldPlay({ enabled: 0 }, '2026-06-12T00:00:00Z', 'Australia/Sydney'), false);
  assert.equal(itemShouldPlay({ enabled: 1 }, '2026-06-12T00:00:00Z', 'Australia/Sydney'), true);
});

test('play_when compares a data-source bag and fails open without one', () => {
  const when = { slug: 'weather', path: 'temp', op: 'gte', value: 70 };
  assert.equal(conditionOk(when, { temp: 80 }), true);
  assert.equal(conditionOk(when, { temp: 10 }), false);
  assert.equal(itemShouldPlay({ play_when: when }, '2026-06-12T00:00:00Z', 'UTC'), true); // no _ds
  assert.equal(itemShouldPlay({ play_when: when, _ds: { temp: 10 } }, '2026-06-12T00:00:00Z', 'UTC'), false);
});

test('play_when fails OPEN for every op when the data bag is missing (incl. truthy)', () => {
  // Regression: `truthy` used to be evaluated before the missing-bag guard, so !!undefined === false
  // blanked the item until the source first loaded. Every op must play when there is no bag.
  for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy']) {
    const when = { slug: 'weather', path: 'active', op, value: 1 };
    assert.equal(conditionOk(when, null), true, `${op} must fail open on null bag`);
    assert.equal(conditionOk(when, undefined), true, `${op} must fail open on undefined bag`);
  }
  // With a bag, truthy actually evaluates the field.
  assert.equal(conditionOk({ slug: 'x', path: 'on', op: 'truthy' }, { on: true }), true);
  assert.equal(conditionOk({ slug: 'x', path: 'on', op: 'truthy' }, { on: 0 }), false);
});

test('server and Tizen conditionOk are byte-identical (no drift)', () => {
  // The two eval modules must stay in lockstep; tizen-eval-drift covers the whole file, this pins
  // the condition function specifically after the fail-open reorder.
  const srv = fs.readFileSync(path.join(ROOT, 'server/lib/schedule-eval.js'), 'utf8');
  const tiz = fs.readFileSync(path.join(ROOT, 'tizen/js/schedule-eval.js'), 'utf8');
  const grab = (s) => s.slice(s.indexOf('function conditionOk'), s.indexOf('function conditionOk') + 600);
  assert.equal(grab(srv), grab(tiz), 'conditionOk drifted between server and Tizen');
});

test('selection bulk route and playlist editor checkboxes exist', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'server/routes/playlists.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'frontend/js/views/playlists.js'), 'utf8');
  assert.match(routes, /router\.post\('\/:id\/items\/selection'/);
  assert.match(routes, /SELECTION_ACTIONS/);
  assert.match(ui, /item-select/);
  assert.match(ui, /playlistSelectBar/);
  assert.match(ui, /action: 'paste'/);
  // The data-source condition is edited via a picker modal (data-source dropdown + op select),
  // not raw prompts.
  assert.match(ui, /editConditionModal/);
  assert.match(ui, /getDataSources\(\)/);
  assert.match(ui, /condType/);
});

test('players skip with itemShouldPlay and honour log_play / fit_mode', () => {
  const web = fs.readFileSync(path.join(ROOT, 'server/player/index.html'), 'utf8');
  const tizen = fs.readFileSync(path.join(ROOT, 'tizen/js/player.js'), 'utf8');
  const embedded = fs.readFileSync(path.join(ROOT, 'server/routes/embedded.js'), 'utf8');
  assert.match(web, /ScheduleEval\.itemShouldPlay/);
  assert.match(web, /shouldLogPlay/);
  assert.match(web, /itemFit/);
  assert.match(tizen, /ScheduleEval\.itemShouldPlay/);
  assert.match(tizen, /log_play === 0/);
  assert.match(embedded, /itemShouldPlay/);
});

