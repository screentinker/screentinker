'use strict';

/*
 * The room display page's words (lib/rooms/strings.js): every language says everything English
 * says, with the same placeholders, and the widget's language setting is an allowlist.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROOM_PAGE_STRINGS, ROOM_PAGE_LANGUAGES } = require('../lib/rooms/strings');
const { renderRoomDisplay } = require('../lib/rooms/render');

const holes = (s) => (String(s).match(/\{\w\}/g) || []).sort().join(',');

test('every language has every key, non-empty, with the same placeholders as English', () => {
  const en = ROOM_PAGE_STRINGS.en;
  for (const lang of ROOM_PAGE_LANGUAGES) {
    const L = ROOM_PAGE_STRINGS[lang];
    assert.deepEqual(Object.keys(L).sort(), Object.keys(en).sort(), `${lang}: same keys as en`);
    for (const k of Object.keys(en)) {
      assert.ok(typeof L[k] === 'string' && L[k].trim(), `${lang}.${k} is empty`);
      assert.equal(holes(L[k]), holes(en[k]), `${lang}.${k} placeholders`);
    }
  }
});

test('the dashboard offers exactly the languages the page has', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/components/room-display-editor.js'), 'utf8');
  const offered = [...src.match(/PAGE_LANGUAGES = \[([\s\S]*?)\];/)[1].matchAll(/\['(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(offered.sort(), [...ROOM_PAGE_LANGUAGES].sort());
});

test('the page carries a known language or none, never whatever the config says', () => {
  const cfgOf = (config) => {
    const html = renderRoomDisplay({ widgetId: 'w1', origin: 'http://server', config });
    return JSON.parse(/var CFG = (\{.*?\});\n/.exec(html)[1]);
  };
  assert.equal(cfgOf({ language: 'de' }).language, 'de');
  assert.equal(cfgOf({}).language, null, 'auto: the screen decides');
  assert.equal(cfgOf({ language: '"></script><script>alert(1)//' }).language, null);
  assert.equal(cfgOf({ language: 'constructor' }).language, null);
  assert.deepEqual(Object.keys(cfgOf({}).strings).sort(), [...ROOM_PAGE_LANGUAGES].sort());
});
