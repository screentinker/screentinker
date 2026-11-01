'use strict';

/*
 * A disabled playlist item is kept but never published, so it never reaches the screen. The screen's
 * Playlist tab drew it like every other item, which made a screen showing one photo of nine look
 * broken with nothing on the page to explain it. These render the tab's own renderPlaylist() in a
 * sandbox and check a disabled item is marked and can be turned back on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const SRC = fs.readFileSync(path.join(FRONTEND, 'views', 'device-detail.js'), 'utf8');

function renderPlaylist() {
  const start = SRC.indexOf('function renderPlaylist(');
  assert.ok(start > 0, 'renderPlaylist() not found');
  const end = SRC.indexOf('\n}\n', start);
  const ctx = {
    t: (k) => `[${k}]`,
    tn: (k) => `[${k}]`,
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  };
  vm.runInNewContext(`${SRC.slice(start, end + 2)}\nthis.renderPlaylist = renderPlaylist;`, ctx);
  return ctx.renderPlaylist;
}

const item = (id, enabled) => ({ id, enabled, content_id: 'c' + id, filename: `photo-${id}.jpg`, mime_type: 'image/jpeg', duration_sec: 10, zone_id: null });

test('a disabled item is faded, badged and has an Enable button; an enabled one has none of that', () => {
  const html = renderPlaylist()([item(1, 0), item(2, 1)]);
  const rows = html.split(/(?=<div class="playlist-item(?: pl-item-disabled)?" data-assignment-id=)/).filter((r) => r.includes('data-assignment-id='));
  assert.equal(rows.length, 2);
  const [off, on] = rows;
  assert.match(off, /^<div class="playlist-item pl-item-disabled"/);
  assert.match(off, /opacity:0\.55/);
  assert.match(off, /class="pl-disabled-badge"[^>]*>\[device\.pl_item\.disabled\]</);
  assert.match(off, /data-enable-assignment="1"[^>]*>\[device\.pl_item\.enable\]</);
  assert.doesNotMatch(on, /pl-item-disabled|pl-disabled-badge|data-enable-assignment|opacity:0\.55/);
});

test('an item from an older server (no enabled field) is drawn as enabled', () => {
  const html = renderPlaylist()([{ ...item(3, undefined) }]);
  assert.doesNotMatch(html, /pl-disabled-badge|data-enable-assignment/);
});

test('the Enable button is wired to turn the item on for this screen', () => {
  assert.match(SRC, /querySelectorAll\('\[data-enable-assignment\]'\)/);
  assert.match(SRC, /api\.updateAssignment\(btn\.dataset\.enableAssignment, \{ enabled: true \}, device\.id\)/);
});

test('the strings exist in English', () => {
  const en = fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.js'), 'utf8');
  for (const k of ['device.pl_item.disabled', 'device.pl_item.disabled_tip', 'device.pl_item.enable', 'device.toast.item_enabled']) {
    assert.ok(en.includes(`'${k}':`), `${k} missing from en.js`);
  }
});
