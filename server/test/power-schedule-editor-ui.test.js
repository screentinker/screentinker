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
