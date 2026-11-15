'use strict';

/*
 * Queue page, "Show on a screen", END TO END in headless Chrome: the button makes the queue's Now
 * serving widget (or reuses the one already there) and adds it to the playlist picked, as a draft.
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch, playerPage } = require('./helpers/web-player-e2e');

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('queue-show');
  browser = await launch();
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

async function signedIn(ctx) {
  const page = await playerPage(ctx);
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
  return page;
}

describe('queue page: show on a screen', { skip: SKIP }, () => {
  test('makes the widget once and adds it to the chosen playlist', async () => {
    const q = await srv.api('POST', '/queues', { name: 'Pharmacy', timezone: 'UTC' });
    const pl = await srv.api('POST', '/playlists', { name: 'Lobby' });
    const ctx = await browser.createBrowserContext();
    try {
      const page = await signedIn(ctx);
      await page.goto(`${srv.base}/app#/queue`, { waitUntil: 'networkidle2' });
      const openDialog = async () => {
        await page.waitForSelector('[data-act="show"]', { timeout: 10000 });
        await page.click('[data-act="show"]');
        await page.waitForSelector('.corp-modal [data-f="pl"] option[value]:not([value=""])', { timeout: 10000 });
      };
      await openDialog();
      assert.match(await page.$eval('.corp-modal [data-f="state"]', (e) => e.textContent), /Made a Now serving widget/);
      await page.select('.corp-modal [data-f="pl"]', String(pl.id));
      await page.click('.corp-modal [data-f="add"]');
      assert.ok(await waitFor(async () => /Added to Lobby/.test(await page.$eval('.corp-modal [data-f="msg"]', (e) => e.textContent)), 8000));

      const widgets = (await srv.api('GET', '/widgets')).filter((w) => w.widget_type === 'queue');
      assert.equal(widgets.length, 1);
      const items = await srv.api('GET', `/playlists/${pl.id}/items`).catch(() => null)
        || (await srv.api('GET', `/playlists/${pl.id}`)).items;
      assert.ok(JSON.stringify(items).includes(widgets[0].id), 'the widget is in the playlist');

      // A second time reuses the same widget.
      await page.click('.corp-modal [data-corp-close-done]');
      await openDialog();
      assert.match(await page.$eval('.corp-modal [data-f="state"]', (e) => e.textContent), /already has a Now serving widget/);
      assert.equal((await srv.api('GET', '/widgets')).filter((w) => w.widget_type === 'queue').length, 1);
      assert.deepEqual(page.errors, []);
    } finally { await ctx.close(); }
  });
});
