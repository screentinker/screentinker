'use strict';

// The Tizen setup screen with a remote and no keyboard: Down from the Server URL field reaches
// Connect, Up goes back, and the on-screen keyboard's Done connects. Before this, Connect needed a
// USB keyboard's Tab (reported on Tizen 5.0 signage with a faulty USB port).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'app.js'), 'utf8');

// Run the setup-screen key wiring against two fake elements.
function wire() {
  const start = APP.indexOf("  elUrl.addEventListener('keydown'");
  const end = APP.indexOf('  function doConnect()');
  assert.ok(start > 0 && end > start, 'setup key wiring found');
  const src = APP.slice(start, end);
  const el = (name) => ({ name, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
  const state = { focused: null, connects: 0 };
  const elUrl = el('url'), elConnect = el('connect');
  elUrl.focus = () => { state.focused = 'url'; };
  elConnect.focus = () => { state.focused = 'connect'; };
  const doConnect = () => { state.connects++; };
  new Function('elUrl', 'elConnect', 'doConnect', src)(elUrl, elConnect, doConnect);
  const press = (target, keyCode) => {
    let prevented = false;
    target.handlers.keydown({ keyCode, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { elUrl, elConnect, state, press };
}

test('Down in the URL field moves focus to Connect, and Up moves it back', () => {
  const w = wire();
  assert.equal(w.press(w.elUrl, 40), true, 'the caret does not take the key');
  assert.equal(w.state.focused, 'connect');
  assert.equal(w.press(w.elConnect, 38), true);
  assert.equal(w.state.focused, 'url');
  assert.equal(w.state.connects, 0, 'moving focus connects nothing');
});

test('Enter and the on-screen keyboard\'s Done (65376) both connect', () => {
  const w = wire();
  w.press(w.elUrl, 13);
  w.press(w.elUrl, 65376);
  assert.equal(w.state.connects, 2);
});

test('other keys in the field are left alone (Left/Right still move the caret)', () => {
  const w = wire();
  assert.equal(w.press(w.elUrl, 37), false);
  assert.equal(w.press(w.elUrl, 39), false);
  assert.equal(w.state.focused, null);
});

test('"Change server" lands focus in the URL field', () => {
  assert.match(APP, /show\(elSetup\); elUrl\.focus\(\);\s+\/\/ a remote has to land somewhere to type/);
});
