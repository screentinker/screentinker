'use strict';

/*
 * Curbside pickup END TO END in headless Chrome, against a real server (lib/curbside,
 * docs/curbside-pickup.md):
 *
 *   a. a customer opens a spot's QR link, types an order number and a note and taps "I'm here"; the
 *      staff page lists the car (spot, order, note, minutes); "We got you" turns the customer page
 *      to the acknowledged message and the widget (in a zone-sized frame) to "On the way"; a second
 *      phone at the same spot is told it is taken; Done shows the done message and empties the list;
 *      the widget keeps its last list, with only the stale dot, once the server is gone;
 *   b. a customer cancels, and the admin's own words (set in the dashboard API) reach the page;
 *   c. the real web player playing the widget chimes once when a car is acknowledged, never again
 *      on the polls that follow (counted at the AudioContext).
 *
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, sleep, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

let srv, browser;

before(async () => {
  if (SKIP) return;
  srv = await startServer('curbside-e2e');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && !el.closest('[hidden]')).catch(() => false);
const staffKey = (l) => l.staff_path.split('#')[1];
async function staffCall(l, method, action, body) {
  const r = await fetch(`${srv.base}/api/public/curbside/s/${action}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Curbside-Staff-Key': staffKey(l) }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

describe('curbside pickup, end to end', { skip: SKIP }, () => {
  test('check in, staff acknowledge, the customer page and the widget update, spot taken, done (and offline)', async () => {
    const l = await srv.api('POST', '/curbside', { name: 'Main St Pizza', timezone: 'America/Chicago', spots_count: 6 });
    const w = await srv.api('POST', '/widgets', { widget_type: 'curbside', name: 'Curbside', config: { location_id: l.id } });
    const ctx = await browser.createBrowserContext();
    try {
      const wp = await playerPage(ctx);
      await wp.setViewport({ width: 480, height: 270 });
      await wp.goto(`${srv.base}/api/widgets/${w.id}/render?device=e2e&rev=1`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await text(wp, '#empty')) === 'No cars waiting', 8000), 'the empty text before any car');

      // The customer scans the QR code on spot 4.
      const cp = await playerPage(ctx);
      await cp.setViewport({ width: 390, height: 800 });
      await cp.goto(`${srv.base}${l.customer_path}?spot=4`, { waitUntil: 'domcontentloaded' });
      await cp.waitForSelector('#form:not([hidden])', { timeout: 10000 });
      assert.equal(await text(cp, '#spot'), '4');
      assert.equal(await text(cp, '#heading'), 'Curbside pickup');
      await cp.type('#order', '1234');
      await cp.type('#note', 'red van');
      await cp.click('#submit');
      assert.ok(await waitFor(async () => /We know you are here.*spot 4/.test(await text(cp, '#status') || ''), 10000), 'waiting message with the spot');
      // Opening the page again on the same phone shows the same check-in.
      await cp.reload({ waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => /1234/.test(await text(cp, '#orderLine') || ''), 10000), 'the same check-in after a reload');
      assert.equal(await visible(cp, '#form'), false);

      // The staff page lists the car.
      const sp = await playerPage(ctx);
      await sp.setViewport({ width: 800, height: 1100 });
      await sp.goto(srv.base + l.staff_path, { waitUntil: 'domcontentloaded' });
      await sp.waitForSelector('.cs-car .cs-ack', { timeout: 10000 });
      const row = await text(sp, '.cs-car');
      assert.match(row, /Spot\s*4/);
      assert.match(row, /1234/);
      assert.match(row, /red van/);
      assert.match(row, /Just arrived|min/);
      assert.ok(await waitFor(async () => /Order 1234/.test(await text(wp, '#rows') || ''), 10000), 'the widget lists the car');
      assert.match(await text(wp, '#rows'), /Spot 4.*Waiting/);

      // A second phone at the same spot.
      const other = await browser.createBrowserContext();
      try {
        const op = await playerPage(other);
        await op.goto(`${srv.base}${l.customer_path}?spot=4`, { waitUntil: 'domcontentloaded' });
        assert.ok(await waitFor(async () => /already checked in at this spot/.test(await text(op, '#msg') || ''), 10000), 'this spot is taken');
        assert.equal(await op.$eval('#submit', (b) => b.disabled), true);
        assert.deepEqual(op.errors, []);
      } finally { await other.close(); }

      // Staff press "We got you".
      await sp.click('.cs-car .cs-ack');
      assert.ok(await waitFor(async () => /On the way/.test(await text(sp, '.cs-car') || ''), 8000), 'staff page shows it acknowledged');
      assert.ok(await waitFor(async () => /We got you/.test(await text(cp, '#status') || ''), 10000), 'the customer page says we got you');
      assert.ok(await waitFor(async () => /Order 1234.*Spot 4.*On the way/.test(await text(wp, '#rows') || ''), 10000), 'the widget says on the way');
      const box = await wp.$eval('#rows', (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
      assert.ok(box.l >= 0 && box.r <= 480 && box.t >= 0 && box.b <= 270, JSON.stringify(box));

      // Done.
      await sp.click('.cs-car .cs-done');
      assert.ok(await waitFor(async () => /No cars waiting/.test(await text(sp, '#list') || ''), 8000));
      assert.ok(await waitFor(async () => /All done/.test(await text(cp, '#status') || ''), 10000), 'the customer page says done');
      assert.ok(await waitFor(async () => (await text(wp, '#empty')) === 'No cars waiting', 10000), 'the widget is empty again');

      assert.deepEqual(wp.errors, [], 'the widget never threw');
      assert.deepEqual(cp.errors, [], 'the customer page never threw');
      assert.deepEqual(sp.errors, [], 'the staff page never threw');

      // One more car, then the server goes away: the widget keeps its list and only dims a dot.
      await fetch(`${srv.base}/api/public/curbside/c/${l.customer_path.split('/').pop()}/checkin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Curbside-Client': 'e2e-offline-client-xxxx' }, body: JSON.stringify({ spot: '2', order_ref: '555' }),
      });
      assert.ok(await waitFor(async () => /Order 555/.test(await text(wp, '#rows') || ''), 10000));
      srv.stop();
      await sleep(24000);
      assert.match(await text(wp, '#rows'), /Order 555/, 'the last list is still shown');
      assert.equal(await wp.$eval('#dot', (el) => el.className), 'stale');
      assert.deepEqual(wp.errors, []);
    } finally { await ctx.close(); }
    srv = await startServer('curbside-e2e-2');
  });

  test('the customer cancels, and the admin\'s own words reach the page as text', async () => {
    const l = await srv.api('POST', '/curbside', { name: 'Lot', timezone: 'UTC', spots: 'A1, A2' });
    await srv.api('PUT', `/curbside/${l.id}`, { texts: { heading: 'Recogida <b>rápida</b>', button: 'Ya llegué', waiting: 'Te esperamos en {spot} (pedido {order})' } });
    const ctx = await browser.createBrowserContext();
    try {
      const cp = await playerPage(ctx);
      await cp.goto(`${srv.base}${l.customer_path}?spot=a2`, { waitUntil: 'domcontentloaded' });
      await cp.waitForSelector('#form:not([hidden])', { timeout: 10000 });
      assert.equal(await text(cp, '#heading'), 'Recogida <b>rápida</b>', 'shown as text, never as HTML');
      assert.equal(await cp.$eval('#heading', (el) => el.children.length), 0);
      assert.equal(await text(cp, '#submit'), 'Ya llegué');
      assert.equal(await text(cp, '#spot'), 'A2');
      await cp.type('#order', 'A-77');
      await cp.click('#submit');
      assert.ok(await waitFor(async () => (await text(cp, '#status')) === 'Te esperamos en A2 (pedido A-77)', 10000));
      cp.on('dialog', (d) => d.accept());
      await cp.click('#cancel');
      assert.ok(await waitFor(async () => /cancelled/.test(await text(cp, '#status') || ''), 10000), 'cancelled');
      const st = await staffCall(l, 'GET', 'state');
      assert.equal(st.arrivals.length, 0, 'the car left the staff list');
      // Check in again from the same phone.
      await cp.click('#again');
      await cp.waitForSelector('#form:not([hidden])', { timeout: 5000 });
      assert.deepEqual(cp.errors, []);

      // The dashboard lists the car (built from DOM nodes) and Done from there reaches the phone.
      await cp.type('#order', 'B-9');
      await cp.click('#submit');
      assert.ok(await waitFor(async () => /pedido B-9/.test(await text(cp, '#status') || ''), 10000));
      const dp = await playerPage(ctx);
      await dp.setViewport({ width: 1280, height: 1000 });
      await dp.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
      await dp.evaluate((tk) => { localStorage.setItem('token', tk); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
      await dp.goto(`${srv.base}/app#/curbside`, { waitUntil: 'domcontentloaded' });
      await dp.waitForSelector(`.corp-card[data-id="${l.id}"] .cs-car .cs-done`, { timeout: 15000 });
      assert.match(await text(dp, `.corp-card[data-id="${l.id}"] h3`), /^Lot$/);
      assert.match(await text(dp, `.corp-card[data-id="${l.id}"] .cs-car`), /B-9/);
      await dp.click(`.corp-card[data-id="${l.id}"] .cs-car .cs-done`);
      assert.ok(await waitFor(async () => /All done/.test(await text(cp, '#status') || ''), 10000), 'Done from the dashboard reaches the phone');
      assert.deepEqual(dp.errors, [], 'the dashboard view never threw');
    } finally { await ctx.close(); }
  });

  test('the web player chimes once when a car is acknowledged, and never again on the polls after', async () => {
    const l = await srv.api('POST', '/curbside', { name: 'Chime lot', timezone: 'UTC', spots_count: 4 });
    const w = await srv.api('POST', '/widgets', { widget_type: 'curbside', name: 'CS chime', config: { location_id: l.id, chime: true, chime_volume: 50 } });
    const d = await srv.webPlayerDisplay('Lobby');
    const pl = await srv.api('POST', '/playlists', { name: 'Curbside' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: w.id });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });
    const tok = l.customer_path.split('/').pop();
    await fetch(`${srv.base}/api/public/curbside/c/${tok}/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Curbside-Client': 'e2e-chime-client-xxxxx' }, body: JSON.stringify({ spot: '1', order_ref: '42' }) });

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      await page.evaluateOnNewDocument(() => {
        window.__osc = 0;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { const orig = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc++; return orig.apply(this, arguments); }; }
      });
      await page.setViewport({ width: 640, height: 360 });
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}&autoplay_audio=1`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, `!!document.querySelector('iframe[src*="/api/widgets/${w.id}/render"]')`), 30000), 'the player shows the widget');
      const frame = await waitFor(() => page.frames().find((f) => f.url().includes(`/api/widgets/${w.id}/render`)), 10000);
      assert.ok(await waitFor(async () => /Order 42/.test(await frame.$eval('#rows', (el) => el.textContent).catch(() => '')), 10000), 'the widget polled');
      await sleep(5000);
      assert.equal(await player(page, 'window.__osc'), 0, 'the car already listed never chimes');
      const st = await staffCall(l, 'GET', 'state');
      await staffCall(l, 'POST', 'ack', { id: st.arrivals[0].id });
      assert.ok(await waitFor(async () => (await player(page, 'window.__osc')) === 2, 12000), 'one chime for the acknowledgement');
      await sleep(12000);
      assert.equal(await player(page, 'window.__osc'), 2, 'never repeated');
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally { await ctx.close(); }
  });
});
