'use strict';

// The display power schedule editor on a screen whose player cannot blank its display YET
// (components/power-schedule-editor.js). Reported on alpha: a healthy, device-owner Android 15 screen
// still on player 2.1.5-beta1 (display.power_schedule arrived in 2.1.6) showed every control disabled
// but looking live, under group wording ("some screens here… you can still save it") — so nothing
// responded. A schedule CAN be set there: the server accepts it and every playlist payload carries
// power_schedule, so it starts working when the screen updates. The editor now lets you, and says so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'components', 'power-schedule-editor.js'), 'utf8');
function load() {
  const src = SRC.replace(/^import [\s\S]*?from '[^']+';\n/gm, '').replace(/^export (const|function) /gm, '$1 ').replace(/^export \{[^}]*\};?$/gm, '');
  const box = { module: {}, t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) };
  vm.runInNewContext(`${src}\nmodule.exports = { renderPowerScheduleEditor };`, box);
  return box.module.exports.renderPowerScheduleEditor;
}
const render = load();

test('a supported screen gets the editor, with no note', () => {
  const html = render({ windows: [], enabled: true }, { supported: true });
  for (const id of ['powerAddWindow', 'powerSave', 'powerEnabled']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /power-preset/);
  assert.doesNotMatch(html, /power\.pending_device|power\.unsupported/);
  assert.doesNotMatch(html, /disabled/);
});

test('a screen that cannot blank yet can still be given a schedule, and is told when it starts working', () => {
  const html = render({ windows: [], enabled: true }, { supported: false, playerVersion: '2.1.5-beta1' });
  assert.match(html, /power\.pending_device_version:\{&quot;version&quot;:&quot;2\.1\.5-beta1&quot;\}/, 'names its player');
  assert.doesNotMatch(html, />power\.unsupported</, 'never the group wording');
  for (const id of ['powerAddWindow', 'powerSave', 'powerEnabled']) assert.match(html, new RegExp(`id="${id}"`), `${id} is there`);
  assert.match(html, /power-preset/);
  assert.doesNotMatch(html, /disabled/, 'nothing that looks live and does nothing');
});

test('without a known version the note still explains', () => {
  assert.match(render({ windows: [], enabled: true }, { supported: false }), />power\.pending_device</);
});

test('the server accepts the schedule and every payload carries it, so it applies once the player can', () => {
  const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'display-power-schedules.js'), 'utf8');
  const post = route.slice(route.indexOf("router.post('/'"), route.indexOf("router.put('/:id'"));
  assert.doesNotMatch(post, /supports\(/, 'saving is not refused for a screen that cannot run it yet');
  const socket = fs.readFileSync(path.join(ROOT, 'server', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(socket, /power_schedule: power_schedule \|\| null/, 'delivered on every payload, so a later update picks it up');
});

test('the device page passes the player version', () => {
  const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.equal((page.match(/playerVersion: device\.app_version \|\| null/g) || []).length, 2, 'both renders (load and redraw)');
});

/*
 * Reported from a Chromecast with Google TV on player 3.2.0: "cannot blank its display on a schedule
 * yet ... updates its player (2.1.6 or later on Android)" read as a contradiction, because 3.2.0 IS
 * later. The Android player declares display.power_schedule only with device owner, device admin or
 * its accessibility service (PlayerCapabilities.kt), so a new enough player is missing a permission.
 */
test('a new enough Android player is told it needs a permission, not an update', () => {
  const html = render({ windows: [], enabled: true }, { supported: false, playerVersion: '3.2.0', needsPermission: true });
  assert.match(html, /power\.needs_permission:\{&quot;version&quot;:&quot;3\.2\.0&quot;\}/);
  assert.doesNotMatch(html, /power\.pending_device/, 'never "update to 2.1.6" for a 3.2.0 player');
  for (const id of ['powerAddWindow', 'powerSave', 'powerEnabled']) assert.match(html, new RegExp(`id="${id}"`), `${id} is there`);
});

test('the device page decides "permission, not update" from the platform and version', () => {
  const page = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.equal((page.match(/needsPermission: powerNeedsPermission\(device\)/g) || []).length, 2, 'both renders (load and redraw)');
  const fn = page.match(/function powerNeedsPermission\(device\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'powerNeedsPermission found');
  const utils = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'utils.js'), 'utf8');
  const cmp = utils.match(/export function compareVersions\(a, b\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '');
  const decide = (device, android) => vm.runInNewContext(
    `${cmp}\nfunction isAndroidDevice() { return ${android}; }\n${fn[0]}\npowerNeedsPermission(device)`, { device });
  assert.equal(decide({ app_version: '3.2.0' }, true), true, '3.2.0 on Android: a permission');
  assert.equal(decide({ app_version: '2.1.6' }, true), true, 'the first version that has schedules');
  assert.equal(decide({ app_version: '2.1.5-beta1' }, true), false, 'older: still an update');
  assert.equal(decide({ app_version: '2.1.6-beta1' }, true), false, 'a beta sorts below its release');
  assert.equal(decide({ app_version: null }, true), false, 'unknown version: the generic note');
  assert.equal(decide({ app_version: '3.2.0' }, false), false, 'not Android: the existing wording');
});

test('the permission note names where to grant it, under the name the device shows', () => {
  const en = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const line = en.match(/'power\.needs_permission': '([^\n]*)',\n/);
  assert.ok(line, 'the key exists');
  assert.match(line[1], /Accessibility/);
  // The app is called RemoteDisplay on the device (android app_name), not ScreenTinker.
  const strings = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
  const appName = strings.match(/<string name="app_name">([^<]+)<\/string>/)[1];
  assert.ok(line[1].includes(appName), `names the service as ${appName}`);
});
