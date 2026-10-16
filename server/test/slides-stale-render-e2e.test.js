'use strict';
/*
 * The Slides page's render() paints the page, then awaits content, fonts and the deck list before
 * drawing the list into #deckArea. Leave the page (or have it re-rendered) during those awaits and
 * the earlier render used to resume and write into an #deckArea that no longer existed:
 * "Cannot set properties of null (setting 'innerHTML')". It surfaced as a timing flake in
 * slides-drag-e2e on a loaded CI runner. Hold the deck list back, leave the page meanwhile, then
 * release it: the stale render must step aside quietly.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, sleep, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let srv, browser, page;
const errors = [];

before(async () => {
  if (SKIP) return;
  srv = await startServer('slides-stale');
  browser = await launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('rd_onboarded', '1');
  }, srv.token);
  await srv.api('POST', '/slide-decks', { name: 'Race deck', doc: { aspect: '16:9', slides: [] } }).catch(() => {});
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

test('leaving the Slides page while its deck list is loading throws nothing', { skip: SKIP }, async () => {
  let held = 0;
  const release = [];
  // Every interception call is guarded: a request can still arrive after interception is switched
  // off below, and continue() on it would reject ("Request Interception is not enabled!").
  let intercepting = true;
  const go = (req) => { if (intercepting) req.continue().catch(() => {}); };
  const onRequest = (req) => {
    if (/\/api\/slide-decks(\?|$)/.test(req.url()) && req.method() === 'GET') {
      held++;
      release.push(() => go(req));
    } else go(req);
  };
  await page.setRequestInterception(true);
  page.on('request', onRequest);

  await page.goto(`${srv.base}/app#/slides`, { waitUntil: 'domcontentloaded' });
  assert.ok(await waitFor(() => held > 0, 15000, 50), 'the deck list request was made');
  // Another view takes the container while the Slides render is still waiting.
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  assert.ok(await waitFor(() => page.evaluate(() => !document.getElementById('deckArea')), 10000, 50),
    'the Slides page was replaced');
  for (const releaseOne of release.splice(0)) releaseOne();
  await sleep(1500);
  page.off('request', onRequest);
  intercepting = false;
  await page.setRequestInterception(false);

  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => !!document.getElementById('deckArea')), false,
    'the stale render did not paint the deck list over the page now showing');
});
