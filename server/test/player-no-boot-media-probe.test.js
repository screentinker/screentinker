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
