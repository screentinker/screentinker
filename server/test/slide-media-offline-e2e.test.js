'use strict';

/*
 * A slide's photos and clips play OFFLINE on the web player, end to end: a real server (spawned),
 * the real web player and its service worker in headless Chrome.
 *
 *   1. A slide with a photo element and a background video is published to a web-player display.
 *   2. The payload lists them (widget_media), the service worker pins both, and the slide page asks
 *      the player for them (online the network copies are already up, so nothing is swapped).
 *   3. The server is killed and the player reloaded: the slide's photo and its video come from the
 *      player's cache, handed to the slide frame as blobs.
 *
 * Before this, step 3 showed the slide's words over an empty box: nothing pinned a widget's media,
 * and the slide frame (an opaque origin) cannot be answered by the service worker directly.
 * Skips cleanly without Chrome / puppeteer-core, like the other browser suites.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

const CLIP = path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm');

// A small real PNG (solid colour, 64x36), written once.
function pngFile() {
  const w = 64, h = 36;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([220, 40, 40], y * (w * 3 + 1) + 1 + x * 3); }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-png-')), 'photo.png');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('slide-media');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

/** State of the slide frame's media, read from inside the frame. */
async function slideState(page) {
  const frame = page.frames().find((f) => /\/api\/widgets\/[^/]+\/render/.test(f.url()));
  if (!frame) return null;
  return frame.evaluate(() => {
    const img = document.querySelector('img[data-st-cid]');
    const vid = document.querySelector('video[data-st-cid]');
    return {
      img: img ? { w: img.naturalWidth, blob: img.src.indexOf('blob:') === 0 } : null,
      vid: vid ? { ready: vid.readyState, blob: vid.src.indexOf('blob:') === 0, playing: !vid.paused } : null,
    };
  }).catch(() => null);
}

describe('slide media offline (web player)', { skip: SKIP }, () => {
  test('a slide\'s photo and video are pinned, and play from the cache with the server gone', async () => {
    const d = await srv.webPlayerDisplay('Lobby');
    const photo = await srv.upload(pngFile(), 'image/png');
    const clip = await srv.upload(CLIP, 'video/webm');
    const w = await srv.api('POST', '/widgets', { widget_type: 'slide', name: 'Offer', config: { template: {
      background: '#102030', background_video_content_id: clip.id,
      elements: [
        { kind: 'image', slot: 'p', content_id: photo.id, box: { x: 5, y: 5, w: 40, h: 40 } },
        { kind: 'head', slot: 'h', box: { x: 5, y: 60, w: 90 }, style: { color: '#FFFFFF', size_cqw: 6 } },
      ] }, fields: { h: 'Offline offer' } } });
    const pl = await srv.api('POST', '/playlists', { name: 'Slides' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: w.id, duration_sec: 60 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const ctx = await browser.createBrowserContext();
    const page = await playerPage(ctx);
    try {
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, '!!(navigator.serviceWorker && navigator.serviceWorker.controller)'), 30000), 'the worker took control');
      await page.reload({ waitUntil: 'domcontentloaded' });

      // The payload carries the slide's media.
      assert.ok(await waitFor(() => player(page, 'slideMediaIndex.size === 2'), 30000),
        `widget_media did not reach the player; log:\n${page.logs.slice(-15).join('\n')}`);
      const listed = await player(page, 'Array.from(slideMediaIndex.keys()).sort()');
      assert.deepEqual(listed, [photo.id, clip.id].sort());

      // Both are pinned in the worker's content cache.
      const pinned = await waitFor(() => player(page, `caches.open('rd-content-v1').then((c) => c.keys()).then((k) => k.map((r) => r.url))`)
        .then((urls) => (urls && urls.some((u) => u.includes(photo.filepath)) && urls.some((u) => u.includes(clip.filepath)) ? urls : null)), 45000);
      assert.ok(pinned, 'the photo and the clip were cached');

      // Online: the slide shows them from the network; nothing needed swapping.
      const online = await waitFor(async () => { const s = await slideState(page); return s && s.img && s.img.w > 0 && s.vid && s.vid.ready >= 2 ? s : null; }, 30000);
      assert.ok(online, 'the slide shows its media online');

      // The server goes away. The player comes back from its own cache, and so must the slide's media.
      srv.stop();
      await new Promise((r) => setTimeout(r, 500));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const offline = await waitFor(async () => {
        const s = await slideState(page);
        return s && s.img && s.img.w > 0 && s.img.blob && s.vid && s.vid.ready >= 2 && s.vid.blob ? s : null;
      }, 45000);
      const diag = offline ? null : await player(page, `(async () => {
        const out = { idx: slideMediaIndex.size, ctrl: !!navigator.serviceWorker.controller, frames: document.querySelectorAll('iframe').length };
        try { const m = Array.from(slideMediaIndex.values())[0]; out.url = mediaUrl(m); const r = await fetch(mediaUrl(m), { headers: { 'X-ST-Cache-Only': '1' } }); out.status = r.status; } catch (e) { out.err = String(e); }
        out.keys = (await (await caches.open('rd-content-v1')).keys()).map((r) => r.url);
        return out; })()`);
      assert.ok(offline, `the slide's media did not come from the cache offline: ${JSON.stringify(await slideState(page))} diag=${JSON.stringify(diag)}\nlog:\n${page.logs.slice(-20).join('\n')}`);
      assert.ok(offline.vid.playing, 'the clip plays');
      assert.deepEqual(page.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });
});
