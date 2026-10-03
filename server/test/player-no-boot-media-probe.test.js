'use strict';

/*
 * ⚠️ THE PLAYER MUST NOT TOUCH navigator.mediaDevices BEFORE PAIRING.
 *
 * `register()` used to call `detectMic()`, which calls `enumerateDevices()`. `register()` runs before
 * a screen is paired, so on a fresh Raspberry Pi kiosk the browser's media-permission prompt appeared
 * ON TOP OF THE PAIRING CODE — the first screen a new customer ever sees. A permission dialog there
 * reads as "this thing wants my camera", which is the worst possible first impression for a product
 * whose pitch is that it is the honest one. Reported from a production install by Watterott electronic,
 * September 2026.
 *
 * The cost is stated rather than hidden: nothing sets `window.__stHasMic`, so `remote.mic` is never
 * declared and the dashboard's 2-way Talk control does not appear. One-way Talk / PA is unaffected.
 * This is a deliberate trade until the probe can be deferred to a point where a prompt is expected.
 *
 * Asserted at the source level because the failure only shows on real hardware, on first boot, once —
 * the conditions least likely to be reproduced by anyone reviewing a diff.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYERS = ['index.html', 'legacy.html'];

/* Comments quote the removed call to explain why it went; an absence assertion must not read them. */
function codeOf(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'player', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('detectMic is never CALLED in either player build', () => {
  for (const file of PLAYERS) {
    const code = codeOf(file).replace(/function detectMic\s*\([^)]*\)/g, '');
    const hit = code.match(/(^|[^.\w])detectMic\s*\(/m);
    assert.equal(hit, null,
      `${file} calls detectMic() — that prompts for media permission over the pairing code`);
  }
});

test('the function is still DEFINED, so restoring it is one line', () => {
  // Deleting it would make this a piece of archaeology the next time somebody wants 2-way Talk.
  for (const file of PLAYERS) {
    assert.match(codeOf(file), /function detectMic\s*\(/, `${file} lost the function entirely`);
  }
});

test('nothing else reaches for media devices on the boot path', () => {
  /*
   * The specific call was one symptom. Any enumerateDevices/getUserMedia on the path a player walks
   * before an operator has asked for anything produces the same dialog over the same screen — so the
   * rule is about the boot path, not about one function name.
   */
  for (const file of PLAYERS) {
    const code = codeOf(file);
    // Everything from the start of the file to the end of register(): the pre-pairing path.
    const at = code.indexOf('function register(');
    assert.notEqual(at, -1, `${file} has no register()`);
    const registerBody = code.slice(at, at + 3000);
    assert.ok(!/mediaDevices/.test(registerBody),
      `${file}: register() reaches navigator.mediaDevices, which prompts before pairing`);
  }
});

test('the capability check no longer claims the flag is set at startup', () => {
  // A comment that describes behaviour the code stopped having is how the next person reintroduces it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const at = src.indexOf("caps.push('remote.mic')");
  assert.notEqual(at, -1, 'the mic capability should still be declared from the flag');
  const near = src.slice(Math.max(0, at - 700), at);
  assert.ok(!/Detected async at startup/.test(near),
    'the comment still claims a startup probe that no longer runs');
  assert.match(near, /NOTHING SETS THIS FLAG AT PRESENT/,
    'the comment should say the flag is currently never set, and why');
});

/* ───────────── the capability is now proven by use, not declared in advance ───────────── */

test('⚠️ two-way talk is no longer gated on a declared remote.mic', () => {
  /*
   * It was, and the declaration came from the startup probe above. With that probe gone nothing
   * declares the capability, so the old gate would refuse 2-way on every screen in the world — the
   * feature would be dead rather than deferred.
   *
   * The player asks for the microphone when the operator clicks 2-way (the one moment a permission
   * dialog is expected, because a human just asked for it) and falls back to a one-way session if
   * there is none. A screen with no mic gets a working one-way session rather than a refusal.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'dashboardSocket.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const at = code.indexOf("socket.on('dashboard:talk-start'");
  assert.notEqual(at, -1);
  const handler = code.slice(at, at + 1400);
  assert.ok(!/capabilityRefused\([^)]*'remote\.mic'/.test(handler),
    'duplex is gated on a capability nothing declares any more, so 2-way can never start');
  // remote.talk still gates it — this loosened one condition, it did not open the door.
  assert.match(handler, /capabilityRefused\(device_id, 'remote\.talk', ack\)/);
});

test('the dashboard offers 2-way on remote.talk, not on remote.mic', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  const btn = view.slice(view.indexOf('start2wayBtn') - 200, view.indexOf('start2wayBtn') + 60);
  assert.match(btn, /can\('remote\.talk'\)/);
  assert.ok(!/can\('remote\.mic'\)/.test(view), 'nothing should still branch on the dead capability');
});

test('a screen with no microphone tells the operator instead of failing silently', () => {
  /*
   * The duplex path already fell back to `listen_only_no_mic`, and that fallback was SILENT: an
   * operator clicked 2-way, got a one-way session, and could not tell it from a screen that simply
   * was not talking back. If the capability is proven by using it, the result of using it has to come
   * back.
   */
  for (const file of PLAYERS) {
    assert.match(codeOf(file), /device:talk-state/, `${file} does not report its talk state`);
  }

  // Relayed workspace-scoped, and authenticated like every other player event: a forged device_id in
  // the payload must not let one screen speak as another.
  const dev = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const at = dev.indexOf("socket.on('device:talk-state'");
  assert.notEqual(at, -1, 'the server does not relay talk state');
  const handler = dev.slice(at, at + 1200);
  assert.match(handler, /requireDeviceAuth\(\)/);
  assert.match(handler, /claimed !== currentDeviceId/);
  assert.match(handler, /emitToDeviceWorkspace\(/, 'must be workspace-scoped, not a platform broadcast');
  // ⚠️ Not a dispatch(): this writes nothing, so it is not a second writer on a replica.
  assert.ok(!/dispatch\('talk-state'/.test(handler));

  // And the dashboard acts on it.
  const bridge = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'socket.js'), 'utf8');
  assert.match(bridge, /dashboard:talk-state/);
  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(view, /listen_only_no_mic/);
  assert.match(view, /device\.talk\.no_mic/);
  // The listener is dropped when the session ends, or a later session inherits a stale toast.
  assert.ok((view.match(/disarmNoMicNotice\(\)/g) || []).length >= 3,
    'the no-mic listener must be dropped on every path that ends a session');

  const en = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  assert.match(en, /'device\.talk\.no_mic':/, 'the string must exist or the toast is blank');
});
