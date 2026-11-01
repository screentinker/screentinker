'use strict';

/*
 * A playlist update re-renders only the zones whose items changed (web player).
 *
 * Every zone used to be torn down and rebuilt on any change. A weather widget's data refresh bumps
 * its rev every few minutes, so a camera or video in another zone went black each time (seen on a
 * Pi 5 and an Android frame, every 16 minutes). renderZones now takes the previous zone state: an
 * unchanged zone keeps its div and keeps playing, a changed zone re-renders in its own div, and a
 * zone left with nothing is cleared.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function fakeDiv() {
  const div = {
    style: {}, parentNode: null, removed: false,
    querySelectorAll: () => [],
    remove() { this.removed = true; this.parentNode = null; },
  };
  return div;
}

/** The real renderZones (plus its signature helpers), lifted verbatim and run against fakes. */
function harness(zones) {
  const start = PLAYER.indexOf('    function renderZones(container, defaultItem, prev) {');
  const end = PLAYER.indexOf('    // Render items[index] in a zone and schedule', start);
  assert.ok(start > 0 && end > start, 'renderZones(container, defaultItem, prev) is still in index.html');
  const shows = [];
  const container = { children: [], appendChild(d) { d.parentNode = this; this.children.push(d); } };
  const env = {
    layout: { id: 'L', zones },
    playlist: [],
    config: { deviceId: 'test' },
    PREVIEW_MODE: false,
    previewBannerParts: {},
    renderPreviewBanner() {},
    clearZoneTimers() { shows.push('clear-all'); },
    zoneTimers: {},
    zoneReport() {},
    document: { createElement: () => fakeDiv() },
    showZoneItem(zone, div, items) { shows.push(zone.id + ':' + items.map((i) => i.label).join(',')); div.zoneId = zone.id; },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, PLAYER.slice(start, end) + '\nreturn renderZones;')(...names.map((n) => env[n]));
  return {
    shows, container,
    render(playlist, prev) { env.playlist.splice(0, env.playlist.length, ...playlist); shows.length = 0; return fn(container, playlist[0], prev); },
  };
}

const Z = (id, w, h, x = 0, y = 0) => ({ id, name: id, x_percent: x, y_percent: y, width_percent: w, height_percent: h });
const ZONES = [Z('main', 75, 100), Z('side', 25, 100, 75, 0)];
const cam = { label: 'cam', content_id: 'cam', mime_type: 'video/rtsp', remote_url: 'rtsps://10.0.0.2/x', zone_id: 'main', sort_order: 0 };
const weather = (rev) => ({ label: 'weather@' + rev, widget_id: 'w', widget_rev: rev, zone_id: 'side', sort_order: 0 });

test('a weather refresh re-renders only the weather zone; the camera zone is left playing', () => {
  const h = harness(ZONES);
  const first = h.render([cam, weather(1)]);
  assert.deepEqual(h.shows, ['clear-all', 'main:cam', 'side:weather@1']);
  const mainDiv = first.zones.main.div;

  const second = h.render([cam, weather(2)], first);
  assert.deepEqual(h.shows, ['side:weather@2'], 'no clear-all, and main is not re-shown');
  assert.equal(second.zones.main.div, mainDiv, 'the camera keeps its div');
  assert.equal(second.zones.side.div, first.zones.side.div, 'a changed zone re-renders in its own div');
  assert.equal(h.container.children.length, 2, 'no extra zone divs were created');
});

test('an unchanged payload re-renders nothing', () => {
  const h = harness(ZONES);
  const first = h.render([cam, weather(1)]);
  h.render([cam, weather(1)], first);
  assert.deepEqual(h.shows, []);
});

test('a dwell edit re-renders that zone only, so the new timing applies', () => {
  const h = harness(ZONES);
  const first = h.render([cam, weather(1)]);
  h.render([cam, Object.assign(weather(1), { duration_sec: 45 })], first);
  assert.deepEqual(h.shows, ['side:weather@1']);
});

test('a zone left with nothing is cleared, and a zone that gains items is built', () => {
  const h = harness([...ZONES, Z('ticker', 25, 20, 75, 80)]);
  const first = h.render([cam, weather(1)]);
  const sideDiv = first.zones.side.div;
  const ticker = { label: 'news', widget_id: 'n', widget_rev: 1, zone_id: 'ticker', sort_order: 0 };
  const second = h.render([cam, ticker], first);
  assert.deepEqual(h.shows, ['ticker:news']);
  assert.ok(sideDiv.removed, 'the emptied side zone is removed');
  assert.ok(!second.zones.side && second.zones.ticker && second.zones.main === first.zones.main);
});

test('without a previous state every zone is built from scratch (first render, layout change)', () => {
  const h = harness(ZONES);
  h.render([cam, weather(1)]);
  h.render([cam, weather(1)]);
  assert.deepEqual(h.shows, ['clear-all', 'main:cam', 'side:weather@1']);
});

test('renderContent takes the incremental path only for the same layout, before any teardown', () => {
  const i = PLAYER.indexOf('if (isZones && zoneState && zoneState.key === zoneLayoutKey(layout))');
  const t = PLAYER.indexOf('teardownCurrentMedia();', i);
  assert.ok(i > 0 && t > i, 'the zone update runs before teardownCurrentMedia');
  assert.match(PLAYER.slice(i, t), /zoneState = renderZones\(stage, item, zoneState\)/);
  const td = PLAYER.indexOf('function teardownCurrentMedia(keep) {');
  assert.ok(/zoneState = null;/.test(PLAYER.slice(td, td + 3000)), 'a full teardown drops the zone state');
});
