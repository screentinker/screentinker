'use strict';

/*
 * #632 follow-up — the ways a published change can fail to reach a long-running web player, in a
 * real headless Chrome against a real server.
 *
 *   a. Behind a reverse proxy that does not pass WebSocket upgrades, the player must fall back to
 *      long-polling and still receive a publish. It did not: engine.io-client only tries the next
 *      transport when `tryAllTransports` is set, so the player retried ws:// forever and never
 *      connected at all.
 *
 * Skips cleanly without Chrome or puppeteer-core, like the other browser suites.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');
const { freePort } = require('./helpers/free-port');

const CLIP = path.join(__dirname, 'fixtures', 'media', 'clip-3s.webm');

let srv, browser, proxy, proxyBase, upgradesRefused = 0;
before(async () => {
  if (SKIP) return;
  srv = await startServer('wp-paths');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
  // Passes plain HTTP through and drops every Upgrade request, as a proxy without
  // `proxy_set_header Upgrade` does.
  const target = new URL(srv.base);
  proxy = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* */ } });
    req.pipe(up);
  });
  proxy.on('upgrade', (req, sock) => { upgradesRefused++; sock.destroy(); });
  const port = await freePort();
  await new Promise((r) => proxy.listen(port, '127.0.0.1', r));
  proxyBase = `http://127.0.0.1:${port}`;
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (proxy) { proxy.closeAllConnections?.(); proxy.close(); }
  if (srv) srv.stop();
});

async function playlistOn(deviceId, contentIds) {
  const pl = await srv.api('POST', '/playlists', { name: 'P ' + Date.now() });
  for (const id of contentIds) await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: id, duration_sec: 5 });
  await srv.api('POST', `/playlists/${pl.id}/publish`);
  await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: deviceId });
  return pl;
}

describe('#632 a published change reaches a long-running web player', { skip: SKIP }, () => {
  test('a. behind a proxy that refuses WebSocket, the player falls back to polling and gets a publish', { timeout: 120000 }, async () => {
    const d = await srv.webPlayerDisplay('Behind a proxy');
    const clip = await srv.upload(CLIP, 'video/webm');
    const clock = await srv.api('POST', '/widgets', { widget_type: 'clock', name: 'Clock', config: {} });
    const pl = await playlistOn(d.id, [clip.id]);

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      await page.goto(`${proxyBase}/player?k=${encodeURIComponent(d.key)}`, { waitUntil: 'domcontentloaded' });
      const up = await waitFor(() => player(page, 'socket && socket.connected && playlist.length === 1 && socket.io.engine.transport.name'), 45000);
      assert.equal(up, 'polling', `the player never connected through the proxy (upgrades refused: ${upgradesRefused})`);
      assert.ok(upgradesRefused > 0, 'precondition: the proxy really refused a WebSocket');

      await srv.api('POST', `/playlists/${pl.id}/items`, { widget_id: clock.id, duration_sec: 5 });
      await srv.api('POST', `/playlists/${pl.id}/publish`);
      assert.ok(await waitFor(() => player(page, 'playlist.length === 2'), 20000), 'the publish never reached the player over polling');
      assert.deepEqual(page.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });
});
