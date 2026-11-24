'use strict';

/*
 * Curbside widget layout in a real browser (3.2.6 emulator pass): a 17-character order number
 * ("ORD-2026-11-24-99", under the 20 allowed) showed as "Order ORD-20..." on a 1920x1080 TV and
 * "Order ORD-..." at 1280x720, with the row half empty: the order column was a fixed 38%. It now takes
 * whatever the spot and status do not need, and only ellipsizes when it truly does not fit.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, launch } = require('./helpers/web-player-e2e');
const { renderCurbsideWidget } = require('../lib/curbside/widget');
const texts = require('../lib/curbside/texts');

let browser;
before(async () => { if (!SKIP) browser = await launch(); });
after(async () => { if (browser) await browser.close(); });

const initial = (orders) => ({
  labels: texts.widgetTexts({}), rev: 1,
  arrivals: orders.map((o, i) => ({ order_ref: o, spot: String(i + 1), status: i ? 'seen' : 'waiting' })),
});

for (const [w, h] of [[1920, 1080], [1280, 720]]) {
  test(`a long order number is shown whole at ${w}x${h}`, { skip: SKIP }, async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: w, height: h });
      const html = renderCurbsideWidget({ widgetId: 'w1', origin: 'http://x', config: { location_id: 'l' }, initial: initial(['ORD-2026-11-24-99', '42']) });
      await page.setContent(html);
      await page.waitForSelector('td.o');
      const cells = await page.$$eval('td.o', (els) => els.map((e) => ({ text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })));
      assert.ok(cells.length >= 2, JSON.stringify(cells));
      for (const c of cells) assert.equal(c.clipped, false, `"${c.text}" is cut off`);
      // and the row still fits the screen
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal overflow');
    } finally { await page.close(); }
  });
}
