'use strict';

/*
 * Esc on the web player used to be a public unpair button.
 *
 * It called confirm('Reset player and return to setup?') and, on OK, wiped the identity and
 * reloaded. Anyone who could reach a keyboard on a kiosk could unpair the display; the operator's
 * first sign of it was a screen asking for a pairing code. A confirm() dialog is not a permission
 * check — it establishes only that somebody meant to press the button, which is the thing that was
 * wrong.
 *
 * These tests cover the two halves that can be quietly wrong for months: WHO passes the gate, and
 * WHICH keys the wipe touches. Both are pure, which is the reason the logic was pulled out of the
 * keydown handler — a guard reachable only through a real browser and a real PIN is a guard nobody
 * checks. The DOM plumbing is pinned separately, at the bottom, by reading the source.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const G = require('../lib/unpair-gate');
const PLAYER = path.join(__dirname, '..', 'player', 'index.html');

/*
 * ⚠️ Source assertions read CODE, not prose. The comments in this codebase quote the code they
 * replaced — the Esc handler's own header names `confirm('Reset player…')` and explains why
 * showStatus() is wrong here — so a plain grep for either string finds the explanation and reports
 * the bug as still present. Asking "is this call still in the file" has to mean the call.
 *
 * Block comments go, and so do whole lines that are only a comment. Trailing `//` is deliberately
 * left alone: stripping from it to end-of-line would eat real code sitting after a `https://` inside
 * a string, of which this file has plenty.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/* ------------------------------------------------------------------ the gate */

test('the right PIN allows it', () => {
  assert.deepEqual(G.decide('123456', '123456'), { allow: true, reason: 'ok' });
  // Whitespace from a numeric keypad or a barcode wedge must not be the difference.
  assert.equal(G.decide('  123456 ', '123456').allow, true);
});

test('⚠️ NO PIN means NO unpairing — not "just confirm"', () => {
  /*
   * The single most important case in this file. If an absent PIN fell back to any weaker gate, the
   * old public-reset behaviour would be restored for exactly the screens least likely to have
   * anyone watching them — and silently, because a display that unpaired itself looks identical to
   * one that was never paired.
   */
  // ⚠️ 0, false and the string "null" included on purpose: String(known) turns each into a
  // non-empty string, i.e. a credential something could type. The same coercion trap already made
  // an Android panel with no trigger secret accept `ST1 null <token>`.
  for (const known of [null, undefined, '', 0, false, 'null', 'false', '0', '12', {}, []]) {
    const v = G.decide('123456', known);
    assert.equal(v.allow, false, 'known=' + JSON.stringify(known));
    assert.equal(v.reason, 'no_pin');
  }
  // Including when nothing at all was typed: still no_pin, so the message can name the real reason.
  assert.equal(G.decide('', null).reason, 'no_pin');
});

test('a wrong or empty PIN is refused, and the two are distinguishable', () => {
  assert.deepEqual(G.decide('000000', '123456'), { allow: false, reason: 'wrong' });
  assert.deepEqual(G.decide('', '123456'), { allow: false, reason: 'empty' });
  assert.deepEqual(G.decide('   ', '123456'), { allow: false, reason: 'empty' });
  assert.deepEqual(G.decide(null, '123456'), { allow: false, reason: 'empty' });
});

test('a prefix, a suffix and a superset of the PIN are all refused', () => {
  // The length check is what makes these cheap; the point of asserting them is that a future
  // "startsWith" or "includes" refactor fails here rather than in a shop.
  for (const given of ['12345', '1234567', '123456 7', '0123456']) {
    assert.equal(G.decide(given, '123456').allow, false, given);
  }
});

test('the compare is length-checked before it looks at content', () => {
  assert.equal(G.matches('1', '123456'), false);
  assert.equal(G.matches('123456', '123456'), true);
  // Non-strings cannot be coerced into a pass.
  for (const g of [123456, null, undefined, {}, ['123456']]) assert.equal(G.matches(g, '123456'), false);
  for (const k of [123456, null, undefined, {}]) assert.equal(G.matches('123456', k), false);
});

/* --------------------------------------------------------------- what gets cleared */

test('⚠️ st_install_id is in the wipe list', () => {
  /*
   * Without it the next register presents the SAME per-install fingerprint, the server reclaims it
   * onto the row that was just unpaired, and the operator watches the screen come straight back as
   * the display they removed. Named on its own rather than checked as a count, so deleting it has
   * to delete this test.
   */
  assert.ok(G.storageKeys('').includes('st_install_id'));
});

test('every key the player writes is cleared, and each is named', () => {
  const keys = G.storageKeys('');
  for (const k of ['rd_web_player', 'rd_playlist_cache', 'rd_layout_cache',
                   'rd_trigger_cfg', 'rd_triggers_cache', 'st_install_id', 'st_group_sync']) {
    assert.ok(keys.includes(k), 'missing ' + k);
  }
});

test('⚠️ the suffix is applied, so screen 2 cannot unpair screen 1', () => {
  // A dual-output BrightSign runs two widgets against one origin and one localStorage. Clearing the
  // unsuffixed keys from the second output would unpair the first one, which is a fault report that
  // would never be traced back to a keypress on the other screen.
  const keys = G.storageKeys('_s2');
  assert.ok(keys.includes('rd_web_player_s2'));
  assert.ok(!keys.includes('rd_web_player'), 'screen 2 must not clear screen 1');
  assert.ok(keys.includes('st_install_id_s2'));
  // st_group_sync is deliberately unsuffixed: one clock per player process.
  assert.ok(keys.includes('st_group_sync'));
});

test('a missing suffix behaves as screen 1 rather than throwing', () => {
  for (const s of [undefined, null, '']) assert.ok(G.storageKeys(s).includes('rd_web_player'));
});

/* ------------------------------------------------------------------ the enrol key */

test('⚠️ ?k= is dropped, because it is an identity the wipe cannot reach', () => {
  // #313: the key is re-read from the URL on every load and sets paired=true, so a reload with it
  // still in place pairs straight back as the same display and never shows a pairing code — the
  // unpair would appear to have done nothing at all.
  assert.equal(G.urlWithoutEnrolKey('https://s.example/player?k=abc123'), 'https://s.example/player');
});

test('every OTHER parameter survives', () => {
  // ?screen=2 decides which physical output a BrightSign widget paints; dropping it collapses a
  // dual-output player onto one screen.
  const out = G.urlWithoutEnrolKey('https://s.example/player?screen=2&k=abc&debug=1');
  assert.ok(out.includes('screen=2'));
  assert.ok(out.includes('debug=1'));
  assert.ok(!out.includes('k=abc'));
});

test('no key means no reload-with-a-different-URL', () => {
  // null is the signal to take the ordinary restart path, which on BrightSign is a host rebuild
  // rather than a location.reload() the widget may not come back from.
  assert.equal(G.urlWithoutEnrolKey('https://s.example/player?screen=2'), null);
  assert.equal(G.urlWithoutEnrolKey('not a url'), null);
  assert.equal(G.urlWithoutEnrolKey(null), null);
});

/* --------------------------------------------- the wiring, which a unit test cannot see */

test('⚠️ confirm() is gone from the Escape path', () => {
  const html = codeOnly(fs.readFileSync(PLAYER, 'utf8'));
  assert.ok(!/confirm\(/.test(html), 'a confirm() is back in the player');
  // And Esc opens the PIN prompt rather than doing anything itself.
  assert.match(html, /if \(e\.key === 'Escape'\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*openPinPrompt\(\);/);
});

test('the player loads the gate and refuses if it is absent', () => {
  const html = fs.readFileSync(PLAYER, 'utf8');
  assert.match(html, /<script src="\/player\/unpair-gate\.js"><\/script>/);
  // ⚠️ No inline fallback compare. A second copy of a permission check is how two versions of it
  // start disagreeing, and the one in the HTML is the one no test would run.
  assert.match(html, /\{ allow: false, reason: 'no_gate' \}/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/player\/unpair-gate\.js'/, 'and the server must serve it');
});

test('⚠️ the PIN-less case does nothing VISIBLE', () => {
  const html = codeOnly(fs.readFileSync(PLAYER, 'utf8'));
  const fn = html.slice(html.indexOf('function openPinPrompt'), html.indexOf('function submitPin'));
  assert.ok(fn.includes('!known'), 'the no-PIN branch moved');
  // showStatus() paints a FULL-SCREEN overlay. Using it here would blank a playing sign for anyone
  // who leaned on Esc, which is a worse outcome than the reset this replaces.
  assert.ok(!/showStatus/.test(fn), 'the no-PIN branch must not cover the screen');
});

test('a wrong PIN does not enter repair mode or restart anything', () => {
  const html = codeOnly(fs.readFileSync(PLAYER, 'utf8'));
  const fn = html.slice(html.indexOf('function submitPin'), html.indexOf('function unpairThisPlayer'));
  for (const forbidden of ['enterRepairMode', 'restartPlayer', 'location.reload', 'removeItem']) {
    assert.ok(!fn.includes(forbidden), 'submitPin must not ' + forbidden + ' on a wrong PIN');
  }
});

test('⚠️ the server is told BEFORE the credentials are thrown away', () => {
  const html = codeOnly(fs.readFileSync(PLAYER, 'utf8'));
  const fn = html.slice(html.indexOf('function unpairThisPlayer'), html.indexOf('==================== Keyboard shortcuts'));
  const emitAt = fn.indexOf("socket.emit('device:self-unpair'");
  const wipeAt = fn.indexOf('UnpairGate.storageKeys');
  assert.ok(emitAt > -1, 'the self-unpair event is not sent');
  assert.ok(wipeAt > emitAt, 'the wipe must come after the emit — afterwards there is no token to prove it with');
  // The prompt closes itself, or somebody who walks away leaves a PIN box over a running sign.
  assert.match(html, /function armPinIdleClose/);
});

test('the server event is authenticated and does not delete the screen', () => {
  const ws = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8'));
  // Through dispatch(), which requires the device token and no-ops a mismatched device_id.
  assert.match(ws, /socket\.on\('device:self-unpair'/);
  const bind = ws.slice(ws.indexOf("socket.on('device:self-unpair'"));
  assert.match(bind.slice(0, 400), /dispatch\('self-unpair', data\)/);
  // ⚠️ And a replica may not relay it: unpairing is not "reporting", and a scoped write grant must
  // not quietly become "unpair any screen in these workspaces".
  assert.match(bind.slice(0, 400), /if \(viaEdge\)/, 'a replica must not be able to relay a self-unpair');
  assert.match(ws, /const NOT_RELAYABLE = Object\.freeze\(\['self-unpair'\]\)/);
  const fn = ws.slice(ws.indexOf("'self-unpair'(deviceId"), ws.indexOf("'exit'(deviceId"));
  assert.ok(!/DELETE FROM devices/.test(fn), 'the device row must survive — assignments and history hang off it');
  assert.match(fn, /user_id = NULL/, 'unpaired means user_id NULL');
  assert.match(fn, /device_token = NULL/, 'the discarded credential must stop working');
  assert.match(fn, /DELETE FROM device_fingerprints WHERE device_id = \?/);
  // workspace_id stays, so the screen does not vanish from the operator's fleet page.
  assert.ok(!/workspace_id = NULL/.test(fn), 'clearing the workspace would hide the screen from its owner');
});

test('the player captures the PIN, and an absent field does not erase it', () => {
  const html = fs.readFileSync(PLAYER, 'utf8');
  /*
   * ⚠️ The server omits settings_pin on some register paths, and there is no "remove the PIN"
   * feature — so absent means "this sender did not include it", never "there is no PIN". An
   * unconditional assignment would erase a known-good PIN on the next reconnect and turn Esc into a
   * permanent no-op that looks exactly like the feature being broken.
   */
  assert.match(html, /if \(data && data\.settings_pin\) config\.settingsPin = String\(data\.settings_pin\);/);
  // And a dashboard rotation reaches the screen Esc is gated on.
  assert.match(html, /socket\.on\('device:settings-pin'/);
});
