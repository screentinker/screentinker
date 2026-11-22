'use strict';

/*
 * 3.0 site cache, end to end: a real origin server (spawned), a real cache node (in this process, so
 * its hit counter can be read), and the real web player in headless Chrome.
 *
 *   1. An admin creates a site cache and assigns the screen to it through the API.
 *   2. The box pre-warms from the origin; the player declares net.site_cache, gets the address and a
 *      token in its payload, and its service worker pulls the media from the box — the box's hit
 *      counter moves and the screen is playing. The box reports its status to the dashboard API.
 *   3. The box is stopped and the player's own cache wiped: the screen still plays, from the origin.
 *
 * Skips cleanly without Chrome / puppeteer-core, like the other browser suites.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');
const { freePort } = require('./helpers/free-port');
const { SiteCacheNode } = require('../lib/site-cache/node');

const CLIP = path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm');

let srv, browser, node, boxPort, dir;
before(async () => {
  if (SKIP) return;
  srv = await startServer('site-cache');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
  boxPort = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scbox-'));
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  try { if (node) await node.stop(); } catch { /* */ }
  if (srv) srv.stop();
});

// Resolves once read() has returned the same value for `quietMs` (a counter that stopped moving).
async function settled(read, quietMs) {
  let last = read();
  let since = Date.now();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const v = read();
    if (v !== last) { last = v; since = Date.now(); } else if (Date.now() - since >= quietMs) return;
  }
}

const playing = 'playlist.length === 1 && !!currentVideoEl && !currentVideoEl.paused && currentVideoEl.readyState >= 2';

describe('site cache: media comes from the LAN box, and still plays without it', { skip: SKIP }, () => {
  test('the box serves the screen; with the box gone the screen plays from the origin', async () => {
    const d = await srv.webPlayerDisplay('Lobby');
    const clip = await srv.upload(CLIP, 'video/webm');
    const pl = await srv.api('POST', '/playlists', { name: 'Clip' });
    await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: clip.id });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });

    const created = await srv.api('POST', '/site-caches', { name: 'Campus', lan_url: `http://127.0.0.1:${boxPort}` });
    assert.match(created.setup.token, /^stcn_/);
    await srv.api('PUT', `/site-caches/${created.id}/assignments`, { device_ids: [d.id] });

    node = new SiteCacheNode({
      origin: srv.base, token: created.setup.token, port: boxPort, host: '127.0.0.1', dir,
      maxBytes: 0, minFreeBytes: 0, pollSeconds: 2,
    }, { log: () => {} });
    await node.start();

    const ctx = await browser.createBrowserContext();
    const swlog = [];
    ctx.on('targetcreated', async (t) => { if (t.type() === 'service_worker') { try { const w = await t.worker(); w.on('console', (m) => swlog.push(m.text())); } catch (e) { swlog.push('ERR ' + e.message); } } });
    const page = await playerPage(ctx);
    try {
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      // Capabilities are declared at register, and on a first ever load the worker is not in control
      // yet (offline.cache has the same rule). Any later load — here a reload — declares net.site_cache.
      assert.ok(await waitFor(() => player(page, '!!(navigator.serviceWorker && navigator.serviceWorker.controller)'), 30000), 'the worker took control');
      assert.equal(node.stats.hits, 0, 'nothing from the box before the player declared it can verify');
      await page.reload({ waitUntil: 'domcontentloaded' });
      // This load declares net.site_cache, so its payload brings the box's address and a token, which
      // the player keeps (it survives a reboot with the WAN down).
      assert.ok(await waitFor(() => player(page, '!!(siteCacheCfg && siteCacheCfg.token)'), 30000), 'the payload carried the site cache');
      /*
       * ⚠️ LET THE FIRST FILL FINISH BEFORE EMPTYING THE CACHE. Prefetch is single-flight per URL
       * (sw.js `prefetching`), and the worker outlives a reload. On a slow runner it was still pulling
       * the clip (from the origin or, now that it has the config, from the box) when the cache was
       * deleted: the reload's prefetch for the same URL was skipped as already in flight, and the
       * in-flight one wrote into the deleted cache. Nothing asked the box again, and this failed on
       * main CI 2026-11-22 (hits=2 misses=0). Wait until the clip is held and the box has gone quiet.
       */
      assert.ok(await waitFor(() => player(page, `caches.open('rd-content-v1').then((c) => c.keys()).then((k) => k.length >= 1)`), 60000), 'the first fill finished');
      await settled(() => node.stats.hits, 1500);
      // Start this screen's cache empty, as a screen meeting new media would, so what happens next
      // is the site-cache path.
      await page.evaluate(() => caches.delete('rd-content-v1'));
      const hitsAt = node.stats.hits;
      await page.reload({ waitUntil: 'domcontentloaded' });
      const hit = await waitFor(() => node.stats.hits > hitsAt, 60000);
      assert.ok(hit, `the box was never asked for the clip (hits=${node.stats.hits}, misses=${node.stats.misses}, error=${node.lastError}); player log:\n${page.logs.slice(-15).join('\n')}\nSW:\n${swlog.join('\n')}`);
      assert.ok(node.stats.bytes_served >= fs.statSync(CLIP).size, 'the whole clip came from the box');
      assert.ok(await waitFor(() => player(page, playing), 30000), 'the screen is playing');
      const fromBox = await player(page, `caches.open('rd-content-v1').then((c) => c.keys()).then((k) => k.length)`);
      assert.ok(fromBox >= 1, 'the clip is in the player\'s offline cache');

      // The box reported to the dashboard: online, a hit, bytes served.
      const reported = await waitFor(async () => {
        const list = await srv.api('GET', '/site-caches');
        const row = list.find((x) => x.id === created.id);
        return row && row.online && row.hits >= 1 && row.bytes_served > 0 ? row : null;
      }, 20000);
      assert.ok(reported, 'the dashboard shows the box online with its hits');
      assert.equal(reported.files_held, 1);

      // The box goes away, and the player forgets everything it held: it must still play.
      await node.stop();
      const hitsBefore = node.stats.hits;
      await page.evaluate(() => caches.delete('rd-content-v1'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => player(page, playing), 45000),
        `the screen did not play with the box down; player log:\n${page.logs.slice(-15).join('\n')}`);
      assert.equal(node.stats.hits, hitsBefore, 'nothing could have come from the stopped box');
      assert.deepEqual(page.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });
});
