'use strict';

/*
 * #314 — the server must not be the only one who knows it asked for a pause.
 *
 * `device:throttled` was emitted by three separate gates in the register handler and implemented by
 * NO player: not Android, not the web player (which BrightSign also runs), not Tizen. The server
 * asked the device to wait; the device reconnected on its own 1s timer and re-tripped the window it
 * was waiting out, while the screen sat on "Waiting for content" with its media already cached.
 *
 * An event with no listeners looks implemented from the server side and is exercised by tests, which
 * is exactly why it survived. These assertions read the player sources, because that is the only
 * place the other half of the contract exists.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const PLAYERS = [
  ['web player (also BrightSign)', ['server', 'player', 'index.html']],
  ['android', ['android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'service', 'WebSocketService.kt']],
];

test('the server still emits it, and says why', () => {
  const src = read('server', 'ws', 'deviceSocket.js');
  const emits = (src.match(/emit\('device:throttled'/g) || []).length;
  assert.ok(emits >= 3, `expected the three refusal gates to emit it, found ${emits}`);
  assert.match(src, /retry_after_ms/, 'the client can only wait if it is told how long');
});

for (const [name, file] of PLAYERS) {
  test(`${name} listens for device:throttled and waits`, () => {
    const src = read(...file);
    assert.match(src, /device:throttled/, `${name} ignores the throttle notice and reconnects into it`);
    assert.match(src, /retry_after_ms/, `${name} must use the server's number, not a guess of its own`);
  });
}

/*
 * ⚠️ CLAMPED AT BOTH ENDS. A missing or absurd retry_after must not strand a screen for hours, and
 * a zero must not turn the reconnect into a busy loop — which would recreate the storm the notice
 * exists to stop.
 */
test('both clamp the wait rather than trusting the number', () => {
  const web = read('server', 'player', 'index.html');
  assert.match(web, /Math\.min\(Math\.max\(/, 'the web player must clamp the wait');
  const android = read('android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player',
    'service', 'WebSocketService.kt');
  assert.match(android, /coerceIn\(/, 'android must clamp the wait');
});

/*
 * ⚠️ ANDROID MUST REGISTER IT THROUGH safeOn. markAlive is wired into safeOn, so a handler attached
 * straight to the socket would not refresh the liveness watchdog: the throttle notice would arrive
 * and still be counted as silence from the server, which is its own failure mode.
 */
test('android registers it through safeOn, so it also counts as liveness', () => {
  const src = read('android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player',
    'service', 'WebSocketService.kt');
  assert.match(src, /safeOn\("device:throttled"\)/,
    'registered outside safeOn, so the notice would not refresh the liveness timer');
});
