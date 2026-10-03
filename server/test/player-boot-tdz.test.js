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

/*
 * ═══ THE SAME BRICK, A SECOND TIME — 2026-09-25 ═══
 *
 * Reported from a real player against alpha:
 *
 *     Uncaught ReferenceError: can't access lexical declaration 'playOrderState'
 *                              before initialization
 *       peekNextIndex → renderContent → playCurrentItem → startPlaybackAt → boot
 *
 * Identical mechanism, different binding. `playbackOrder`, `playOrderState` and `zoneOrderState`
 * were declared beside nextActiveIndex(), three thousand lines below the cold-start branch that
 * restores a cached playlist and renders item 0 during the initial script pass.
 *
 * ⚠️ WHY THE GUARD ABOVE DID NOT CATCH IT. That one names _videoCompositingOk. This is a different
 * binding on a different path: only the WIDGET branch of renderContent() calls peekNextIndex(), so
 * it fires only when the first cached item is a widget. An image or a video first item never
 * reaches it. A guard that names one binding protects one binding — hence the list below.
 *
 * ⚠️ AND IT COST THE CONNECTION, which is what makes this a brick and not a log line.
 * startPlaybackAt(0) was unguarded, so the throw escaped into the boot script and connect() — a
 * few lines further down, in the same block — never ran. The player sat on a stale cache, 404ing
 * for content the server no longer had, unreachable until someone cleared its storage. Rebooting,
 * the one remedy an operator has, changed nothing.
 */
test('every binding the boot render can reach is declared before the Boot section', () => {
  const boot = PLAYER.indexOf('==================== Boot ====================');
  assert.ok(boot > 0, 'Boot section marker not found');
  /*
   * Boot restores a cached playlist and renders item 0 synchronously. That call graph —
   * startPlaybackAt -> playCurrentItem -> renderContent -> (renderWidgetBuffered | peekNextIndex |
   * the wipe path) — may touch any of these. Each one is a brick if it moves below Boot.
   */
  for (const decl of [
    'let _videoCompositingOk = null;',
    "let playbackOrder = 'sequential';",
    'let playOrderState = {};',
    'const zoneOrderState = {};',
  ]) {
    const at = PLAYER.indexOf(decl);
    assert.ok(at > 0, `declaration not found: ${decl}`);
    assert.ok(at < boot,
      `${decl} is declared at line ${lineOf(decl)}, AFTER the Boot section at line ` +
      `${lineOf('==================== Boot ====================')}. Boot renders the cached ` +
      'playlist during the initial script pass, so reading this is a TDZ throw, and the throw ' +
      'takes connect() with it.');
  }
});

test('⚠️ the cold-start render is guarded, so a bad cache cannot cost the connection', () => {
  /*
   * Placement is the fix; this is the seatbelt. Rendering from cache is an optimisation — whatever
   * goes wrong inside it, the player must still reach connect(), because a player that connects can
   * be sent a correct playlist and a player that does not is a site visit.
   */
  const i = PLAYER.indexOf('startPlaybackAt(0);');
  assert.ok(i > 0, 'the cold-start render call moved');
  const window = PLAYER.slice(Math.max(0, i - 700), i + 400);
  assert.match(window, /try \{\s*\n\s*startPlaybackAt\(0\);/,
    'startPlaybackAt(0) must be inside a try — an uncaught throw here skips connect()');
  assert.match(window, /catch \(e\)/, 'and the catch must exist');
  // And the connection really is downstream of it, which is why the guard matters.
  const connectAt = PLAYER.indexOf('connect(config.serverUrl);', i);
  assert.ok(connectAt > i, 'connect() should follow the cold-start render in the boot block');
});
