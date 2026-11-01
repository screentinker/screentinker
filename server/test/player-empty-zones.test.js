'use strict';

/*
 * #666: in a multi-zone layout, a zone with nothing of its own stays EMPTY on the web player.
 *
 * renderZones() used to fill every empty zone with the current item (its `defaultItem`), so the same
 * content appeared in zones it was never assigned to. The Android, Tizen, native and Roku players
 * already left those zones blank. Zone-less items still go to the first zone with nothing of its own
 * (unchanged, so no existing screen moves its content), and the current item is used only when no
 * zone has anything at all, so a layout can never blank the whole screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** The real renderZones, lifted verbatim and run against fakes. Returns zone id -> item labels. */
function render(zones, playlist, defaultItem) {
  const start = PLAYER.indexOf('    function renderZones(container, defaultItem, prev) {');
  const end = PLAYER.indexOf('    // Render items[index] in a zone and schedule', start);
  assert.ok(start > 0 && end > start, 'renderZones is still in index.html');
  const shown = {};
  const env = {
    layout: { zones },
    playlist,
    config: { deviceId: 'test' },
    PREVIEW_MODE: false,
    previewBannerParts: {},
    renderPreviewBanner() {},
    clearZoneTimers() {},
    zoneReport() {},
    document: { createElement: () => ({ style: {} }) },
    showZoneItem(zone, div, items) { shown[zone.id] = items.map((i) => i.label); },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, PLAYER.slice(start, end) + '\nreturn renderZones;')(...names.map((n) => env[n]));
  fn({ appendChild() {} }, defaultItem);
  return shown;
}

const Z = (id, w, h, x = 0, y = 0) => ({ id, name: id, x_percent: x, y_percent: y, width_percent: w, height_percent: h });
const ZONES = [Z('main', 70, 100), Z('side', 30, 50, 70, 0), Z('ticker', 30, 50, 70, 50)];

test('a zone with nothing of its own stays empty: the current item is not copied into it', () => {
  const a = { label: 'A', zone_id: 'main', sort_order: 0 };
  const shown = render(ZONES, [a], a);
  assert.deepEqual(shown, { main: ['A'] }, 'only Main shows anything; Side and Ticker stay blank');
});

test('zone-less items still go to the first zone with nothing of its own (unchanged)', () => {
  const pl = [
    { label: 'M', zone_id: 'main', sort_order: 0 },
    { label: 'loose1', zone_id: null, sort_order: 1 },
    { label: 'loose2', zone_id: null, sort_order: 2 },
  ];
  assert.deepEqual(render(ZONES, pl, pl[0]), { main: ['M'], side: ['loose1', 'loose2'] }, 'Ticker stays blank');
});

test('an item for a zone this layout lacks still plays in the largest zone (unchanged)', () => {
  const pl = [{ label: 'stale', zone_id: 'gone', sort_order: 0 }, { label: 'T', zone_id: 'ticker', sort_order: 1 }];
  assert.deepEqual(render(ZONES, pl, pl[0]), { main: ['stale'], ticker: ['T'] });
});

test('when NO zone has anything, the current item is shown once so the screen is never all blank', () => {
  const placeholder = { label: 'default content' };
  assert.deepEqual(render(ZONES, [], placeholder), { main: ['default content'] });
  assert.deepEqual(render(ZONES, [], null), {}, 'and with nothing at all, nothing is drawn');
});
