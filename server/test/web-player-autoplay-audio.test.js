'use strict';

/*
 * #627 — `?autoplay_audio=1`: a kiosk browser that allows sound starts the player with sound.
 *
 * Kiosk shells such as Fully Kiosk Browser ("Autoplay Audio") lift the WebView's user-gesture rule,
 * but the player could not know, so it showed "Tap anywhere to start" and then carried on MUTED: an
 * unattended screen came back silent after every reboot until someone tapped it. The parameter is
 * opt-in, and the BROWSER has the last word: the player tries an unmuted play() and only skips the
 * tap screen when that resolves.
 *
 * ⚠️ THE STARTUP BUG THIS GUARDS. The first version of this (a local patch in the field) triggered
 * the tap synchronously from the overlay setup. That runs during the initial script pass and reached
 * connect() before `let` bindings further down the script had initialised: a ReferenceError (TDZ),
 * and the screen stayed offline. The same class of bug once bricked players on boot (see
 * player-boot-tdz.test.js). Two layers here: a source guard that the call is deferred, and a real
 * browser that would surface the ReferenceError as a page error and a player that never connects.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKIP, sleep, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const LEGACY = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');

describe('#627 source guards', () => {
  test('the automatic tap runs after the current task (setTimeout 0), never synchronously', () => {
    const at = PLAYER.indexOf('if (autoplayAudioRequested()) {');
    assert.ok(at > 0, 'the autoplay_audio branch moved or was renamed');
    const block = PLAYER.slice(at, PLAYER.indexOf('\n        }\n', at) + 10);
    assert.match(block, /^if \(autoplayAudioRequested\(\)\) \{\s*setTimeout\(\(\) => \{/,
      'the first thing the branch does must be to defer: anything synchronous here runs in the TDZ');
    assert.match(block, /\}, 0\);\s*\}$/, 'deferred with setTimeout(…, 0)');
    assert.match(block, /autoplayAudioAllowed\(/, 'and only after the browser has said sound is allowed');
    // The overlay's own handler is the one way in, so a tap and the automatic start cannot drift.
    assert.match(block, /tapOverlay\.onclick\(\)/);
  });

  test('the overlay tap is never invoked anywhere else in the boot script', () => {
    const calls = PLAYER.match(/tapOverlay\.onclick\(\)/g) || [];
    assert.equal(calls.length, 1, `expected exactly one programmatic tap, found ${calls.length}`);
  });

  test('the parameter is opt-in: only 1 or true turns it on', () => {
    const fn = PLAYER.slice(PLAYER.indexOf('function autoplayAudioRequested()'), PLAYER.indexOf('function autoplayAudioAllowed('));
    assert.match(fn, /get\('autoplay_audio'\)/);
    assert.match(fn, /v === '1' \|\| v === 'true'/);
  });

  test('a refused play() keeps the tap screen (no muted shortcut past it)', () => {
    const fn = PLAYER.slice(PLAYER.indexOf('function autoplayAudioAllowed('), PLAYER.indexOf('// Try to unmute and play the leader video.'));
    assert.match(fn, /p\.then\(\(\) => finish\(!el\.muted\), \(\) => finish\(false\)\)/, 'only a resolved, unmuted play() counts');
    assert.match(fn, /setTimeout\(\(\) => finish\(false\)/, 'a promise that never settles is a refusal');
    assert.match(fn, /policy !== 'allowed'/, "getAutoplayPolicy 'allowed-muted' is a refusal");
  });

  test('the legacy player was rebuilt with it', () => {
    assert.ok(LEGACY.includes('autoplay_audio'), 'run npm run build:legacy-player');
  });
});

describe('#627 in a real browser', { skip: SKIP }, () => {
  let srv;
  let allowing;    // a browser that allows sound without a gesture, like Fully Kiosk with Autoplay Audio on
  let refusing;    // an ordinary browser
  before(async () => {
    srv = await startServer('wp-audio');
    allowing = await launch(['--autoplay-policy=no-user-gesture-required']);
    refusing = await launch(['--autoplay-policy=document-user-activation-required']);
  });
  after(async () => {
    for (const b of [allowing, refusing]) { try { if (b) await b.close(); } catch { /* */ } }
    if (srv) srv.stop();
  });

  async function open(browser, query) {
    const d = await srv.webPlayerDisplay('Kiosk');
    const ctx = await browser.createBrowserContext();
    const page = await playerPage(ctx);
    await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}${query}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const overlayUp = (page) => player(page,
    "Array.from(document.body.children).some((el) => /Tap anywhere to start/.test(el.textContent || '') && el.style.zIndex === '2000')");

  test('allowed + ?autoplay_audio=1: no tap screen, starts with sound, connects, and never throws', async () => {
    const { ctx, page } = await open(allowing, '&autoplay_audio=1');
    try {
      // The overlay check alone can pass before the player script has run (no overlay yet), and a
      // slow runner then read userHasInteracted too early. Wait for the script first.
      assert.ok(await waitFor(async () => (await player(page, 'typeof userHasInteracted')) === 'boolean', 5000, 50), 'the player script runs');
      // Well inside the 5 s muted fallback, so this can only be the automatic start.
      const gone = await waitFor(async () => (await player(page, 'userHasInteracted')) === true
        && (await overlayUp(page)) === false, 3500, 100);
      assert.ok(gone, 'the tap screen should be skipped when the browser allows sound');
      assert.equal(await player(page, 'userHasInteracted'), true, 'audio is unlocked');
      assert.ok(await waitFor(() => player(page, '!!(socket && socket.connected)'), 10000), 'and the player connects');
      // A TDZ read during startup would be an uncaught ReferenceError right here.
      assert.deepEqual(page.errors, [], 'startup threw');
    } finally { await ctx.close(); }
  });

  test('allowed but WITHOUT the parameter: unchanged, the tap screen is shown', async () => {
    const { ctx, page } = await open(allowing, '');
    try {
      await sleep(2500);
      assert.equal(await overlayUp(page), true, 'opt-in only: a normal /player still shows the tap screen');
      assert.equal(await player(page, 'userHasInteracted'), false);
    } finally { await ctx.close(); }
  });

  test('refused + ?autoplay_audio=1: falls back to today\'s behaviour, muted after 5 s', async () => {
    const { ctx, page } = await open(refusing, '&autoplay_audio=1');
    try {
      await sleep(3000);
      assert.equal(await overlayUp(page), true, 'a browser that refuses sound keeps the tap screen');
      assert.ok(await waitFor(() => player(page, '!!(socket && socket.connected)'), 10000), 'and still connects (muted) on its own');
      assert.equal(await player(page, 'userHasInteracted'), false, 'without sound unlocked');
      assert.ok(page.logs.some((l) => /autoplay_audio=1, but this browser refused/.test(l)), 'and says why in the console');
      assert.deepEqual(page.errors, []);
    } finally { await ctx.close(); }
  });
});
