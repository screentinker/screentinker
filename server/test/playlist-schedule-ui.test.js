'use strict';

/*
 * Three small dashboard fixes found while filming the user guides, tested out of the real source
 * (not a copy of it, which would pass forever):
 *  - the screen's Playlist tab names the main zone the way the playlist editor does, using the
 *    SAME rule as the server (lib/playlist-layout mainZone) and every player;
 *  - the calendar fills a block with the schedule's own Color when one was picked, and keeps the
 *    screen/group colour for the untouched default;
 *  - the playlist editor's name column keeps a minimum width, so the row controls wrap instead of
 *    hiding the item names on a 1280 px laptop.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEWS = path.join(__dirname, '..', '..', 'frontend', 'js', 'views');
const read = (f) => fs.readFileSync(path.join(VIEWS, f), 'utf8');

function extractFunction(src, header) {
  const i = src.indexOf(header);
  assert.notEqual(i, -1, `source no longer has: ${header}`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced braces');
}

test('Playlist tab: mainZoneOf picks the same zone as the server mainZone', () => {
  const src = read('device-detail.js');
  const ctx = {};
  vm.runInNewContext(extractFunction(src, 'function mainZoneOf(zones) {') + '\nthis.mainZoneOf = mainZoneOf;', ctx);
  const { mainZone } = require('../lib/playlist-layout');
  const cases = [
    [],
    [{ id: 'a', name: 'Main', is_main: 0, width_percent: 60, height_percent: 100 }, { id: 'b', name: 'Side', is_main: 0, width_percent: 40, height_percent: 100 }],
    [{ id: 'a', name: 'Big', is_main: 0, width_percent: 80, height_percent: 100 }, { id: 'b', name: 'Ticker', is_main: 1, width_percent: 20, height_percent: 100 }],
    [{ id: 'a', name: 'L', width_percent: 50, height_percent: 100 }, { id: 'b', name: 'R', width_percent: 50, height_percent: 100 }],
  ];
  for (const zones of cases) {
    const got = ctx.mainZoneOf(zones);
    const want = mainZone(zones);
    assert.equal(got ? got.id : null, want ? want.id : null, JSON.stringify(zones));
  }
  // ...and the empty choice and the item label use the editor's wording, not "No zone" / an id.
  assert.match(src, /select\.options\[0\]\.textContent = t\('layoutpl\.zone_main_auto', \{ name: main\.name \}\)/);
  assert.match(src, /el\.textContent = t\('device\.pl_item\.zone_label', \{ id: z\.name \}\)/);
});

test('calendar: a picked schedule Color fills the block; the default keeps the screen colour', () => {
  const src = read('schedule.js');
  const def = src.match(/const DEFAULT_SCHEDULE_COLOR = '([^']+)';/);
  assert.ok(def, 'DEFAULT_SCHEDULE_COLOR is defined');
  const line = src.match(/const ownColorOf = [^\n]+;/);
  assert.ok(line, 'ownColorOf is defined');
  const ctx = { DEFAULT_SCHEDULE_COLOR: def[1] };
  vm.runInNewContext(line[0] + '\nthis.ownColorOf = ownColorOf;', ctx);
  assert.equal(ctx.ownColorOf({ color: '#F59E0B' }), '#F59E0B');
  assert.equal(ctx.ownColorOf({ color: '#3B82F6' }), null, 'the default Color is not a choice');
  assert.equal(ctx.ownColorOf({ color: '#3b82f6' }), null, 'case-insensitive');
  assert.equal(ctx.ownColorOf({}), null);
  assert.match(src, /const colorOf = \(ev\) => ownColorOf\(ev\) \|\| targetColorOf\(ev\);/);
});

test('playlist editor: the item name column cannot be squeezed to nothing', () => {
  const src = read('playlists.js');
  const body = extractFunction(src, 'function renderItems(items) {');
  assert.match(body, /<div style="flex:1 1 160px;min-width:160px">/);
  assert.match(body, /flex-wrap:wrap;justify-content:flex-end/);
});
