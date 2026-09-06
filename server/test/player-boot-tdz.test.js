'use strict';

/*
 * THE BRICK: a `let` read during boot, before its declaration had executed.
 *
 * Found the hard way on 2026-08-07 — a BrightSign XT245 on shipped 1.9.32 went dark and STAYED
 * dark across reboots. The exit beacon said:
 *
 *     crashed: Cannot access '_videoCompositingOk' before initialization @ player:3730:12
 *
 * Boot restores the CACHED playlist and renders item 0 immediately, from a call site ~2300 lines
 * above where `_videoCompositingOk` was declared. When that item was a video carrying a transition,
 * `isVideoBufferable` read the binding while it was still in the temporal dead zone. A TDZ read is
 * a *throw*, not a `null` — so the player died during boot.
 *
 * And because the offending playlist came from the device's OWN localStorage cache, it never
 * stayed up long enough to receive a corrected one. Every boot re-read the same poisoned cache and
 * died the same way: a permanent brick, recoverable only by clearing device storage. Rebooting the
 * player — the one remedy an operator has — did nothing.
 *
 * Nothing about this is BrightSign-specific. Any web-based player could hit it.
 *
 * The fix is placement, so the test is about placement: anything boot can reach must be declared
 * before boot runs. A guard rather than a repro, because reproducing it needs a whole page
 * lifecycle — and a guard is what stops it coming back when someone tidies the declaration back
 * down next to its function, which is exactly where it looked like it belonged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', '..', 'server/player/index.html'), 'utf8');

const lineOf = (needle) => PLAYER.slice(0, PLAYER.indexOf(needle)).split('\n').length;

test('the compositing cache is declared before the Boot section, not beside its function', () => {
  const decl = PLAYER.indexOf('let _videoCompositingOk = null;');
  const boot = PLAYER.indexOf('==================== Boot ====================');
  assert.ok(decl > 0, '_videoCompositingOk declaration not found');
  assert.ok(boot > 0, 'Boot section marker not found');
  assert.ok(
    decl < boot,
    `declared at line ${lineOf('let _videoCompositingOk = null;')} but Boot starts at line ` +
    `${lineOf('==================== Boot ====================')} — boot renders the cached playlist ` +
    'and would read this binding in its temporal dead zone, bricking the player on every boot',
  );
});

test('it is declared exactly once — a second `let` would shadow nothing and throw again', () => {
  const n = (PLAYER.match(/let _videoCompositingOk\b/g) || []).length;
  assert.equal(n, 1, `expected one declaration, found ${n}`);
});

test('every CODE read of it happens after the declaration', () => {
  // Comments must not count: this file documents the bug by name, both here and at the old
  // declaration site, and those mentions sit above the declaration by design.
  const stripped = PLAYER
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))   // block comments -> spaces, offsets preserved
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => ' '.repeat(m.length)); // line comments (not "://" in URLs)
  const decl = stripped.indexOf('let _videoCompositingOk = null;');
  assert.ok(decl > 0, 'declaration not found in stripped source');
  const early = [];
  const re = /_videoCompositingOk/g;
  let m;
  while ((m = re.exec(stripped))) if (m.index < decl) early.push(m.index);
  assert.equal(early.length, 0,
    `${early.length} code read(s) precede the declaration — each one is a temporal-dead-zone throw`);
});

test('the boot path really does render a cached item before the probe is consumed', () => {
  // Documents WHY the ordering matters, so a future reader can see the hazard is structural and
  // not a style preference. If this ever stops being true the guard above is merely harmless.
  // The probe moved OFF the dispatch gate (it excluded plane platforms from the hold) INTO
  // onFirstFrame — still consumed at runtime, after boot, and still only for video: the gate's
  // mime short-circuit is what kept image-first playlists alive, and the declaration must stay
  // hoisted above boot all the same.
  const restore = PLAYER.indexOf('const cachedPlaylist = loadPlaylistCache();');
  const consumer = PLAYER.indexOf('function videoCompositingAvailable(v)');
  assert.ok(restore > 0 && consumer > 0);
  assert.ok(
    restore < consumer,
    'boot restores and renders the cached playlist before the probe is consumed in source order — ' +
    'which is the whole reason the declaration must be hoisted above boot',
  );
  // And the hold is still reached only for video, which is why an image-first playlist survived it.
  const gateAt = PLAYER.indexOf('const isVideoBufferable');
  const decl = PLAYER.slice(gateAt, PLAYER.indexOf(';', gateAt));
  assert.match(decl, /mime_type\.startsWith\('video\/'\)/,
    'the short-circuit on video mime is what kept image-first playlists alive');
});
