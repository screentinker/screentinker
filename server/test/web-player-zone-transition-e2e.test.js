'use strict';

/*
 * #851: a Transition widget crossfades items inside a layout zone too, END TO END in headless Chrome.
 *
 * The server resolves transitions per zone and sends `transition` on zone items, but showZoneItem()
 * cleared the zone and mounted the next item, so adding a small clock zone to a layout turned the
 * content zone's crossfade into a hard cut. Now the next item is built in a layer over the outgoing
 * one, faded in, and the old content is removed after the fade. A zone with no Transition widget
 * keeps the hard cut.
 *
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { SKIP, waitFor, startServer, launch, playerPage } = require('./helpers/web-player-e2e');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-zone-fade-'));

/** A solid-colour 8x8 PNG, so every picture here has different bytes. */
function png(r, g, b) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(8).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('zone-fade');
  browser = await launch();
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function pic(name, rgb) {
  const f = path.join(TMP, `${name}.png`);
  fs.writeFileSync(f, png(...rgb));
  return srv.upload(f, 'image/png');
}

describe('web player: transitions inside layout zones (#851)', { skip: SKIP }, () => {
  test('the content zone crossfades, the zone without a Transition widget still hard-cuts', async () => {
    const L = await srv.api('POST', '/layouts', { name: 'Slides and clock', zones: [
      { name: 'Main', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 },
      { name: 'Corner', x_percent: 80, y_percent: 0, width_percent: 20, height_percent: 20 },
    ] });
    const zid = (n) => L.zones.find((z) => z.name === n).id;
    const [a, b, c, d2] = await Promise.all([
      pic('red', [255, 0, 0]), pic('green', [0, 255, 0]), pic('blue', [0, 0, 255]), pic('white', [255, 255, 255]),
    ]);
    const fade = await srv.api('POST', '/widgets', {
      widget_type: 'transition', name: 'Crossfade',
      config: { shaders: ['Crossfade'], durationMs: 1200, scope: 'all' },
    });
    const d = await srv.webPlayerDisplay('Kiosk');
    const pl = await srv.api('POST', '/playlists', { name: 'Kiosk' });
    const add = (body) => srv.api('POST', `/playlists/${pl.id}/items`, body);
    await add({ widget_id: fade.id, zone_id: zid('Main') });
    await add({ content_id: a.id, zone_id: zid('Main'), duration_sec: 3 });
    await add({ content_id: b.id, zone_id: zid('Main'), duration_sec: 3 });
    await add({ content_id: c.id, zone_id: zid('Corner'), duration_sec: 3 });
    await add({ content_id: d2.id, zone_id: zid('Corner'), duration_sec: 3 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('PUT', `/devices/${d.id}`, { layout_id: L.id });
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      const ids = { main: [a.filepath, b.filepath], corner: [c.filepath, d2.filepath] };   // image URLs carry the stored file name
      // Record each zone's state every 50 ms inside the page (a fade lasts 1.2 s, too short to poll
      // from here). On every document: the player reloads itself once after it pairs.
      await page.evaluateOnNewDocument((ids) => {
        window.__fade = { main: [], corner: [] };
        const zoneOf = (list) => [...document.querySelectorAll('#playerContainer > .zone')]
          .find((z) => [...z.querySelectorAll('img')].some((i) => list.some((id) => i.src.includes(id))));
        setInterval(() => {
          for (const k of ['main', 'corner']) {
            const z = zoneOf(ids[k]);
            if (!z) continue;
            const layers = [...z.children].filter((e) => e.classList.contains('zone-layer'));
            window.__fade[k].push({
              children: z.children.length,
              layers: layers.length,
              opacity: layers.map((l) => Number(getComputedStyle(l).opacity)),
            });
          }
        }, 50);
      }, ids);
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });

      // Two full rotations of the main zone (3 s each) is plenty.
      await new Promise((r) => setTimeout(r, 9000));
      const s = await page.evaluate(() => window.__fade);
      assert.ok(s.main.length > 50, `the main zone was sampled (${s.main.length})`);

      const overlap = s.main.filter((x) => x.layers >= 1 && x.children >= 2);
      assert.ok(overlap.length > 0, 'during a change the new layer sits over the outgoing content');
      const mid = s.main.filter((x) => x.opacity.some((o) => o > 0.05 && o < 0.95));
      assert.ok(mid.length > 0, `a layer was seen part way through its fade (${JSON.stringify(s.main.slice(-40))})`);
      assert.ok(s.main.some((x) => x.children === 1), 'after a fade only the new item is left in the zone');
      assert.ok(Math.max(...s.main.map((x) => x.children)) <= 3, 'old layers are cleaned up, never piled up');

      assert.ok(s.corner.length > 50, 'the corner zone was sampled');
      assert.ok(s.corner.every((x) => x.layers === 0), 'a zone with no Transition widget still hard-cuts');
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally { await ctx.close(); }
  });

  /*
   * The timing cases, driven straight through showZoneItem() in the real player page. A local
   * server accepts and never answers, so "content that has not loaded" is exact; the bundle fetch
   * is pointed at it by swapping config.serverUrl for the duration of the call.
   */
  test('first render, a layer left behind, and a bundle still loading do not fade the wrong thing in', async () => {
    const http = require('node:http');
    const sockets = new Set();
    const hang = http.createServer(() => { /* never answer */ });
    hang.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const hangBase = `http://127.0.0.1:${hang.address().port}`;
    const d = await srv.webPlayerDisplay('Bench');
    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      // The player reloads itself once after it pairs: wait for a document that stays up, connected.
      const settled = () => page.evaluate(() => {
        if (!window.__benchSince) window.__benchSince = Date.now();
        return typeof showZoneItem === 'function' && typeof socket !== 'undefined' && !!socket && socket.connected
          && Date.now() - window.__benchSince > 2000;
      }).catch(() => false);
      assert.ok(await waitFor(settled, 30000), 'player loaded and paired');

      const fast = (r, g, b) => 'data:image/png;base64,' + png(r, g, b).toString('base64');
      const res = await page.evaluate(async (red, green, base) => {
        // base: the server that never answers
        const T = { effects: [{ shader: 'Crossfade', params: {} }], durationMs: 300 };
        const zone = { id: 'bench', sort_order: 1 };
        const timers = {};
        const div = document.createElement('div');
        div.className = 'zone';
        div.style.cssText = 'left:0;top:0;width:200px;height:200px';
        document.body.appendChild(div);
        const show = (it) => showZoneItem(zone, div, [it], 0, timers);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const layers = () => [...div.querySelectorAll('.zone-layer')];
        const out = {};

        // 1. First render: nothing to fade from, so no layer (and no 2.5 s wait in the dark).
        show({ id: 'a', mime_type: 'image/png', remote_url: red, duration_sec: 60, transition: T });
        out.firstLayers = layers().length;
        out.firstImg = !!div.querySelector(':scope > img');

        // 2. The zone moves on while the next item is still loading: that layer must never show.
        show({ id: 'slow', mime_type: 'image/png', remote_url: base + '/__hang/slow.png', duration_sec: 60, transition: T });
        out.pendingAfterSlow = layers().length;
        show({ id: 'b', mime_type: 'image/png', remote_url: green, duration_sec: 60, transition: T });
        await wait(3200);   // past the 2.5 s reveal cap of the abandoned layer
        out.slowLeft = !!div.querySelector('img[src*="/__hang/"]');
        out.afterB = [...div.querySelectorAll('img')].map((i) => (i.src.includes('/__hang/') ? 'slow' : i.src === green ? 'green' : i.src === red ? 'red' : '?'));

        // 3. A bundle whose document is still being fetched: the iframe's about:blank load is not
        //    its content, so the layer waits (here, for the 2.5 s cap) instead of fading at once.
        const realServer = config.serverUrl;
        config.serverUrl = base;
        show({ id: 'bun', mime_type: 'application/vnd.screentinker.bundle+zip', content_id: 'hang', duration_sec: 60, transition: T });
        config.serverUrl = realServer;
        await wait(1000);
        const bl = layers().filter((l) => l.querySelector('iframe'));
        out.bundleLayers = bl.length;
        out.bundleOpacityAt1s = bl.length ? Number(getComputedStyle(bl[0]).opacity) : null;
        out.greenStillThereAt1s = [...div.querySelectorAll('img')].some((i) => i.src === green);
        return out;
      }, fast(255, 0, 0), fast(0, 255, 0), hangBase);

      assert.equal(res.firstLayers, 0, 'the first item of a zone is mounted directly, not faded in from black');
      assert.ok(res.firstImg, 'the first item is in the zone');
      assert.equal(res.pendingAfterSlow, 1, 'the slow item waits in a layer');
      assert.equal(res.slowLeft, false, 'the abandoned layer was dropped, not revealed later');
      assert.deepEqual(res.afterB, ['green'], 'only the current item is left');
      assert.equal(res.bundleLayers, 1, 'the bundle is built in a layer');
      assert.equal(res.bundleOpacityAt1s, 0, 'the about:blank load did not start the fade');
      assert.ok(res.greenStillThereAt1s, 'the outgoing picture stays up while the bundle loads');
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally {
      for (const so of sockets) so.destroy();
      await ctx.close();
      await new Promise((r) => hang.close(r));
    }
  });
});
