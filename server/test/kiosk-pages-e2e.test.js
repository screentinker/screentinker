'use strict';

/*
 * Kiosk pages in a real headless Chrome: the real web player showing a kiosk page through its
 * "Kiosk: ..." widget, and the real dashboard editor. What only shows up there:
 *   - "Open URL" did nothing on a screen (window.open inside the player's sandboxed frames);
 *   - a saved page never reached a screen already showing it;
 *   - typing the address before choosing Go to page left the button with no address;
 *   - the editor's 16:9 preview cut off the lower rows of buttons.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch, playerPage } = require('./helpers/web-player-e2e');

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('kiosk-pages');
  browser = await launch();
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

const frameOf = (page, part) => page.frames().find((f) => f.url().includes(part));
async function textIn(page, part, selector) {
  const f = frameOf(page, part);
  if (!f) return null;
  return f.evaluate((s) => { const el = document.querySelector(s); return el ? el.textContent : null; }, selector).catch(() => null);
}

describe('kiosk pages on a screen and in the editor', { skip: SKIP }, () => {
  test('Open URL opens inside the page with a way back, and a save reaches the screen', async () => {
    const wifi = await srv.api('POST', '/kiosk', { name: 'Wi-Fi', config: { title: 'Wi-Fi details', buttons: [] } });
    const home = await srv.api('POST', '/kiosk', { name: 'Home', config: { title: 'Welcome in', buttons: [
      { label: 'Wi-Fi site', icon: '📶', action: 'url', url: `${srv.base}/api/kiosk/${wifi.id}/render` },
    ] } });
    const d = await srv.webPlayerDisplay('Counter touchscreen');
    // What Add Content -> Kiosk makes.
    const w = await srv.api('POST', '/widgets', { widget_type: 'webpage', name: 'Kiosk: Home', config: { url: `/api/kiosk/${home.id}/render` } });
    const other = await srv.api('POST', '/widgets', { widget_type: 'clock', name: 'Clock', config: {} });
    const pl = await srv.api('POST', '/playlists', { name: 'Touchscreen' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: w.id, duration_sec: 43200 });
    await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: other.id, duration_sec: 10 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const ctx = await browser.createBrowserContext();
    const page = await playerPage(ctx);
    try {
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      const homePath = `/api/kiosk/${home.id}/render`;
      assert.equal(await waitFor(() => textIn(page, homePath, 'h1'), 30000), 'Welcome in', 'the kiosk page is on the screen');

      // Open URL: the address shows inside the page.
      const kf = frameOf(page, homePath);
      await kf.click('.kiosk-btn[data-action="url"]');
      const shown = await waitFor(() => kf.evaluate(() => getComputedStyle(document.getElementById('siteView')).display === 'flex'), 5000);
      assert.ok(shown, 'the site view opened');
      assert.equal(await waitFor(() => textIn(page, `/api/kiosk/${wifi.id}/render`, 'h1'), 15000), 'Wi-Fi details',
        'the address loaded inside the kiosk frame');
      // ... and Back returns to the buttons.
      await kf.click('#siteBack');
      assert.equal(await kf.evaluate(() => getComputedStyle(document.getElementById('siteView')).display), 'none');
      assert.equal(await kf.evaluate(() => document.getElementById('siteFrame').getAttribute('src')), 'about:blank');

      // The 12 h dwell keeps the page up (the clock never comes), and a save reaches the screen.
      await srv.api('PUT', `/kiosk/${home.id}`, { config: { title: 'Welcome back', buttons: [] } });
      assert.equal(await waitFor(async () => (await textIn(page, homePath, 'h1')) === 'Welcome back' ? 'Welcome back' : null, 30000),
        'Welcome back', 'the screen shows the saved page without a restart');
      assert.deepEqual(page.errors, []);
    } finally {
      await ctx.close();
    }
  });

  test('the editor: address before action, and a preview that shows every row', async () => {
    const buttons = Array.from({ length: 9 }, (_, i) => ({ label: `B${i + 1}`, sublabel: 'sub', icon: '⭐', action: '', url: '' }));
    const kp = await srv.api('POST', '/kiosk', { name: 'Editor page', config: { title: 'Nine buttons', buttons } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
      await page.goto(`${srv.base}/app#/kiosk/${kp.id}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#buttonList input[data-field="url"]', { timeout: 20000 });

      // Address first, action second: the address must end up where Go to page reads it.
      await page.type('#buttonList input[data-btn="0"][data-field="url"]', '/api/kiosk/x/render');
      await page.select('#buttonList select[data-btn="0"][data-field="action"]', 'page');
      // And the other way round: Go to page first, then Open URL.
      await page.select('#buttonList select[data-btn="1"][data-field="action"]', 'page');
      await page.type('#buttonList input[data-btn="1"][data-field="url"]', 'https://example.com');
      await page.select('#buttonList select[data-btn="1"][data-field="action"]', 'url');
      await page.click('#saveKioskBtn');
      const saved = await waitFor(async () => {
        const c = JSON.parse((await srv.api('GET', `/kiosk/${kp.id}`)).config);
        return c.buttons[0].action === 'page' && c.buttons[1].action === 'url' ? c : null;
      }, 10000);
      assert.ok(saved, 'saved');
      assert.equal(saved.buttons[0].page, '/api/kiosk/x/render');
      assert.equal(saved.buttons[1].url, 'https://example.com');
      assert.equal(saved.buttons[1].page, undefined);
      assert.equal(saved.siteBackLabel, 'Back', 'the Back bar label is saved in the editor language');

      // The preview lays out at 1920x1080 and is scaled into its box: the last row is inside it.
      // Saving reloads the preview, so a frame found too early can be the old one, detached a moment later
      // (CI caught exactly that: "Waiting for selector `.kiosk-btn` failed"). Keep re-finding the frame
      // until one actually has its buttons.
      const pf = await waitFor(async () => {
        for (const f of page.frames().filter((x) => x.url().includes(`/api/kiosk/${kp.id}/render`))) {
          try { if (await f.evaluate(() => document.querySelectorAll('.kiosk-btn').length > 0)) return f; } catch { /* detached */ }
        }
        return null;
      }, 15000);
      assert.ok(pf, 'the preview frame shows its buttons');
      const fit = await pf.evaluate(() => {
        const btns = [...document.querySelectorAll('.kiosk-btn')];
        return { last: btns[btns.length - 1].getBoundingClientRect().bottom, h: window.innerHeight, w: window.innerWidth };
      });
      assert.equal(fit.w, 1920);
      assert.ok(fit.last <= fit.h, `the last row (bottom ${fit.last}) fits the ${fit.h}px page`);
      const box = await page.evaluate(() => {
        const b = document.getElementById('kioskPreviewBox').getBoundingClientRect();
        const f = document.getElementById('kioskPreview').getBoundingClientRect();
        return { bw: b.width, bh: b.height, fw: f.width, fh: f.height };
      });
      assert.ok(Math.abs(box.fw - box.bw) <= 2 && box.fh <= box.bh + 2, `the scaled page fills the box (${JSON.stringify(box)})`);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});
