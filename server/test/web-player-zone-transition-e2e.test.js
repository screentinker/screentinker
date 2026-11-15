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
});
