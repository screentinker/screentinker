'use strict';

/*
 * #790 live field patch — the PLAYER half, asserted against player/index.html as text (the player
 * is a single-file SPA these tests read, not execute). The properties that keep it correct and safe:
 *   - it adopts the new widget_rev on matching items, so the playlist-update that follows does not
 *     reload what was just patched, and a later rotation uses the new rev;
 *   - it patches the live slide iframe(s) by postMessage and reloads only when nothing acks;
 *   - a failure never takes the player down.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const handler = (() => {
  const i = SRC.indexOf("socket.on('device:field-patch'");
  assert.ok(i >= 0, 'the player must handle device:field-patch');
  let p = SRC.indexOf('(', i); let depth = 0;
  for (let j = p; j < SRC.length; j++) { const c = SRC[j]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) return SRC.slice(i, j + 1); } }
  throw new Error('handler not balanced');
})();

test('adopts the new rev on matching items so the follow-up playlist-update is a no-op', () => {
  assert.match(handler, /it\.widget_rev\s*=\s*data\.rev/, 'the item rev is advanced to the pushed rev');
  assert.match(handler, /ids\.has\(it\.widget_id\)/, 'only items bound to the pushed widgets are touched');
});

test('patches the live iframe(s) and reloads only when nothing acks', () => {
  assert.match(handler, /postMessage\(\{ type: 'st-ds-patch'/, 'posts the patch to the slide agent');
  assert.match(handler, /st-ds-patch-ack/, 'listens for the agent ack');
  assert.match(handler, /if \(!acked\) \{ try \{ playCurrentItem\(\)/, 'falls back to a reload when no slide confirmed the patch');
});

test('does nothing visible when the matching widget is not currently on screen', () => {
  assert.match(handler, /if \(!currentOnScreen\) return/, 'off-screen items only get their rev updated for the next rotation');
});

test('a patch can never crash the player', () => {
  assert.match(handler, /catch \(e\) \{[^}]*player[^}]*\}/, 'the whole handler is wrapped so a bad message is swallowed');
});
