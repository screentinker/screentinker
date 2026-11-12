'use strict';

/*
 * "Now serving" END TO END in headless Chrome, against a real server (lib/queue, docs/now-serving-queue.md):
 *
 *   a. a customer opens the QR link and gets number 1, staff press Next on the staff link, and the
 *      widget (in a zone-sized frame) and the customer page both show it; the widget keeps showing
 *      it, with only the stale dot, once the server is gone;
 *   b. the real web player playing the widget chimes once per called number and never again on the
 *      polls that follow (counted at the AudioContext), and stays silent with the staff switch off.
 *
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, sleep, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

let srv, browser;

before(async () => {
  if (SKIP) return;
  srv = await startServer('queue-e2e');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const staffKey = (q) => q.staff_path.split('#')[1];
async function staffPost(q, action, body) {
  const r = await fetch(`${srv.base}/api/public/queue/s/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Queue-Staff-Key': staffKey(q) }, body: JSON.stringify(body || {}),
  });
  return r.json();
}

describe('now serving, end to end', { skip: SKIP }, () => {
  test('a customer takes a number, staff press Next, and the widget shows it (and keeps it offline)', async () => {
    const q = await srv.api('POST', '/queues', { name: 'Pharmacy', timezone: 'Europe/Lisbon' });
    const w = await srv.api('POST', '/widgets', { widget_type: 'queue', name: 'Now serving', config: { queue_id: q.id } });
    const ctx = await browser.createBrowserContext();
    try {
      // The widget, framed at a typical side-zone size.
      const wp = await playerPage(ctx);
      await wp.setViewport({ width: 420, height: 180 });
      await wp.goto(`${srv.base}/api/widgets/${w.id}/render?device=e2e&rev=1`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await text(wp, '#num')) === '–', 8000), 'a dash before anyone is called');

      // The customer scans the QR code.
      const cp = await playerPage(ctx);
      await cp.setViewport({ width: 390, height: 800 });
      await cp.goto(srv.base + q.customer_path, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await text(cp, '#mine')) === '1', 10000), 'the customer got number 1');
      assert.match(await text(cp, '#status'), /You are next/);
      // Scanning again the same day keeps the number.
      await cp.reload({ waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await text(cp, '#mine')) === '1', 10000), 'same number after a second scan');

      // Staff press the big Next button on the shared tablet.
      const sp = await playerPage(ctx);
      await sp.setViewport({ width: 800, height: 1100 });
      await sp.goto(srv.base + q.staff_path, { waitUntil: 'domcontentloaded' });
      await sp.waitForSelector('#next:not([disabled])', { timeout: 10000 });
      await sp.click('#next');
      assert.ok(await waitFor(async () => (await text(sp, '#num')) === '1', 8000), 'the staff page shows 1');
      assert.match(await text(sp, '#log'), /Next: called 1/);

      assert.ok(await waitFor(async () => (await text(wp, '#num')) === '1', 10000), 'the widget shows the new number');
      assert.ok(await waitFor(async () => /your turn/i.test(await text(cp, '#status') || ''), 10000), 'the customer page says it is their turn');

      // The number fits its zone.
      const box = await wp.$eval('#num', (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
      assert.ok(box.l >= 0 && box.r <= 420 && box.t >= 0 && box.b <= 180, JSON.stringify(box));

      // Call a specific number: a second customer, then skip back to 1 and ahead to 2.
      // Same context = same localStorage = same number: a different browser is needed for a new one.
      const other = await browser.createBrowserContext();
      try {
        const op = await playerPage(other);
        await op.goto(srv.base + q.customer_path, { waitUntil: 'domcontentloaded' });
        assert.ok(await waitFor(async () => (await text(op, '#mine')) === '2', 10000), 'another phone gets 2');
        await sp.waitForSelector('#callNum', { timeout: 5000 });
        await sp.type('#callNum', '2');
        await sp.click('#callBtn');
        assert.ok(await waitFor(async () => (await text(wp, '#num')) === '2', 10000), 'calling 2 shows 2 on the widget');
        assert.ok(await waitFor(async () => /passed|been called/i.test(await text(cp, '#status') || ''), 10000), 'customer 1 is told their number has passed');
        assert.deepEqual(op.errors, []);
      } finally { await other.close(); }

      assert.deepEqual(wp.errors, [], 'the widget never threw');
      assert.deepEqual(cp.errors, [], 'the customer page never threw');
      assert.deepEqual(sp.errors, [], 'the staff page never threw');

      // The server goes away: the widget keeps the last number and only dims a dot.
      srv.stop();
      await sleep(24000);
      assert.equal(await text(wp, '#num'), '2', 'the last number is still shown');
      assert.equal(await wp.$eval('#dot', (el) => el.className), 'stale');
      assert.deepEqual(wp.errors, [], 'and nothing threw');
    } finally { await ctx.close(); }
    // The rest of the suite needs a server again.
    srv = await startServer('queue-e2e-2');
  });

  test('the web player chimes once per called number, never on the polls after, and not with the staff switch off', async () => {
    const q = await srv.api('POST', '/queues', { name: 'Desk', timezone: 'UTC' });
    const w = await srv.api('POST', '/widgets', { widget_type: 'queue', name: 'NS chime', config: { queue_id: q.id, chime: true, chime_volume: 50 } });
    const d = await srv.webPlayerDisplay('Lobby');
    const pl = await srv.api('POST', '/playlists', { name: 'Queue' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: w.id });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });
    for (let i = 0; i < 3; i++) await fetch(`${srv.base}/api/public/queue/c/${q.customer_path.split('/').pop()}/ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'e2e-client-' + i + '-xxxxxxxxxxxx' }) });

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      // Count tones where they are made: every chime is exactly two oscillators.
      await page.evaluateOnNewDocument(() => {
        window.__osc = 0;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { const orig = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc++; return orig.apply(this, arguments); }; }
      });
      await page.setViewport({ width: 640, height: 360 });
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}&autoplay_audio=1`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, `!!document.querySelector('iframe[src*="/api/widgets/${w.id}/render"]')`), 30000), 'the player shows the widget');
      const frame = await waitFor(() => page.frames().find((f) => f.url().includes(`/api/widgets/${w.id}/render`)), 10000);
      assert.ok(await waitFor(async () => (await frame.$eval('#num', (el) => el.textContent).catch(() => '')) === '–', 10000), 'the widget polled');
      await sleep(5000);
      assert.equal(await player(page, 'window.__osc'), 0, 'loading the widget never chimes');

      await staffPost(q, 'next');
      assert.ok(await waitFor(async () => (await player(page, 'window.__osc')) === 2, 12000), 'one chime for the call');
      await sleep(12000);   // three more polls
      assert.equal(await player(page, 'window.__osc'), 2, 'never repeated');

      await staffPost(q, 'sound', { on: false });
      await sleep(4500);
      await staffPost(q, 'next');
      assert.ok(await waitFor(async () => (await frame.$eval('#num', (el) => el.textContent).catch(() => '')) === '2', 10000));
      await sleep(5000);
      assert.equal(await player(page, 'window.__osc'), 2, 'the staff switch off keeps the screens silent');

      await staffPost(q, 'sound', { on: true });
      await sleep(4500);
      await staffPost(q, 'call', { number: 3 });
      assert.ok(await waitFor(async () => (await player(page, 'window.__osc')) === 4, 12000), 'on again: the next call chimes once');
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally { await ctx.close(); }
  });
});
