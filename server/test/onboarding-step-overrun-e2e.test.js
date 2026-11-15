'use strict';

/*
 * Onboarding: two ways of putting content on the screen that finish one after the other must not push
 * the wizard past its last step.
 *
 * Reported from a self-hosted install: the guide reached "It's live!", and "Go to Dashboard" did nothing.
 * The console showed renderStep "Cannot read properties of undefined (reading 'icon')" from placeItems,
 * then handleNext "(reading 'action')" on every click. Each way of filling the screen on the upload
 * step (an upload or "Use sample", a stock photo, "Show the same as another screen") advanced the
 * wizard with a bare currentStep++ when its async work finished. If a second one finished after the
 * first had already moved on, the step index ran past the end and the last step could never finish.
 *
 * Here "Use sample" is slowed down (its upload is held back) and "Show the same as" is pressed while it
 * is still running. Only one way of filling the screen runs at a time, so the second press is ignored:
 * the guide lands on its last step exactly once, and what the last step says is playing is what the
 * screen really has (a late sample used to replace the "Show the same as" choice behind its back).
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, like the other browser suites.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SKIP, sleep, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let srv, browser, page, lobbyId;
const errors = [];

before(async () => {
  if (SKIP) return;
  srv = await startServer('onboarding-overrun');
  // A published playlist with an item, so the upload step offers "Show the same as another screen".
  const item = await srv.upload(path.join(__dirname, '..', '..', 'frontend', 'assets', 'samples', 'welcome-screen.jpg'), 'image/jpeg');
  const pl = await srv.api('POST', '/playlists', { name: 'Lobby' });
  await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: item.id, duration_sec: 10 });
  await srv.api('POST', `/playlists/${pl.id}/publish`, {});
  lobbyId = pl.id;

  browser = await launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    // Hold the sample's upload back for a few seconds, so the other action finishes first.
    if (req.method() === 'POST' && /\/api\/content(\?|$)/.test(req.url())) {
      await sleep(4000);
    }
    req.continue().catch(() => {});
  });
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.removeItem('rd_onboarded'); }, srv.token);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
const heading = () => page.evaluate(() => (document.querySelector('h2') || {}).textContent || '');

test('two content actions on the upload step still end on a last step that finishes', { skip: SKIP, timeout: 120000 }, async () => {
  await page.goto(`${srv.base}/app#/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok(await waitFor(() => page.evaluate(() => !!document.getElementById('nextBtn')), 20000), 'the guide opens');

  // Welcome (and the import / download steps) -> the screen step; take the "no storage" path, which
  // makes a web player display.
  for (let i = 0; i < 6 && !(await page.evaluate(() => !!document.getElementById('onboardNoStorage'))); i++) {
    await click('#nextBtn');
    await sleep(800);
  }
  assert.ok(await waitFor(() => page.evaluate(() => !!document.getElementById('onboardNoStorage')), 10000), 'the screen step');
  await page.evaluate(() => { const b = document.getElementById('onboardNoStorage'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('#nextBtn');
  assert.ok(await waitFor(() => page.evaluate(() => !!document.getElementById('onboardUseSample')), 15000), 'the upload step');
  assert.ok(await waitFor(() => page.evaluate(() => {
    const s = document.getElementById('onboardSameAs'); return !!s && s.options.length > 0 && getComputedStyle(document.getElementById('onboardSameAsBlock')).display !== 'none';
  }), 10000), '"Show the same as" is offered');

  // Start the (slowed) sample, then pick the existing playlist while it is still uploading.
  await click('#onboardUseSample');
  await sleep(500);
  await click('#onboardSameAsBtn');

  // Let both finish.
  await sleep(9000);
  const stepErrors = errors.filter((m) => /reading '(icon|action)'/.test(m));
  assert.deepEqual(stepErrors, [], 'no step ran past the end');

  // The last step is showing (not clamped onto it from further along), and its button finishes the guide.
  assert.ok(await waitFor(() => page.evaluate(() => !!document.getElementById('onboardPlaylistPick')), 5000), 'the last step is showing');
  const lastHeading = await heading();
  assert.ok(lastHeading.length > 0, `the last step is drawn (heading "${lastHeading}")`);

  // The sample was pressed first, so it is what went on the screen, and the last step says so.
  const devices = await srv.api('GET', '/devices');
  const screen = (Array.isArray(devices) ? devices : devices.devices || []).find((d) => d.playlist_id);
  assert.ok(screen, 'the new screen has a playlist');
  assert.notEqual(screen.playlist_id, lobbyId, 'the ignored "Show the same as" press did not reach the screen');
  const shown = await page.evaluate(() => document.getElementById('onboardPlaylistPick').value);
  assert.equal(shown, screen.playlist_id, 'the last step preselects what the screen is really playing');

  await click('#nextBtn');
  const done = await waitFor(() => page.evaluate(() => !location.hash.startsWith('#/onboarding')), 15000);
  assert.ok(done, '"Go to Dashboard" leaves the guide');
  assert.deepEqual(errors.filter((m) => /reading '(icon|action)'/.test(m)), [], 'and nothing threw on the way out');
});
