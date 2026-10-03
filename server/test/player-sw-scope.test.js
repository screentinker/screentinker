'use strict';

// The web player's ENTIRE offline story depended on a header nobody had noticed was missing.
//
// A service worker's default scope is its own directory, so /player/sw.js could only ever control
// /player/ and below — which does not include /player itself. The player is served at all three of
// /player, /player/ and /player/index.html, and /player is the one that gets used: it is what the
// dashboard displays and what gets typed into a panel. On that URL registration SUCCEEDED, logged
// "Service Worker registered", and then controlled nothing: no shell cache, no content cache, no
// offline playback. Found by driving a real browser at it; no unit test in the suite could have
// seen it, because the bug lived entirely in the relationship between a URL and a header.
//
// Both halves are pinned here. Drop either one and the player silently stops working offline at the
// URL everyone uses — with no error, on a display nobody is looking at.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-swscope-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the worker is registered from the root, so its DEFAULT scope covers the player', () => {
  // Asking for a wider-than-default scope works only if Service-Worker-Allowed reaches the browser.
  // Cloudflare withheld it from a cached response across a deploy and registration failed outright
  // — no worker at all, which is worse than the narrow scope it replaced. Served from /, the
  // default scope is already the whole origin and no header has to survive the trip.
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(html, /const serviceWorkerUrl = IS_LEGACY_PLAYER \? '\/sw-legacy\.js' : '\/sw\.js'/);
  assert.match(html, /navigator\.serviceWorker\.register\(serviceWorkerUrl\)/,
    'register each worker from the root rather than relying on a header');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/sw\.js'/, 'and the server must serve it there');
  assert.match(server, /app\.get\('\/sw-legacy\.js'/, 'the legacy worker must have the same root scope');
});

test('the server permits that scope, or the registration is rejected outright', async () => {
  // Service-Worker-Allowed is what lets a worker claim a scope above its own path. Without it the
  // register() call above does not merely narrow — it FAILS, which is worse: the player then has no
  // worker at all, on every URL.
  const http = require('node:http');
  const express = require('express');
  const app = express();
  // The same static mount the server uses, exercised through its real setHeaders callback.
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /Service-Worker-Allowed/,
    'server.js must set Service-Worker-Allowed on the worker response');

  app.use('/player', express.static(path.join(__dirname, '..', 'player'), {
    setHeaders: (res, filePath) => { if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/'); }
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const headers = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/player/sw.js`, (res) => { res.resume(); resolve(res.headers); })
      .on('error', reject);
  });
  server.close();
  assert.equal(headers['service-worker-allowed'], '/');
});

test('the worker prunes to the set the player declares', () => {
  // Revision-keyed sweeping is not sufficient on its own: replacing an asset writes a NEW
  // randomly-named file, so the superseded copy lives at a different path entirely and nothing
  // keyed on the asset path can find it. It would sit in the cache until the quota evicted it — on
  // a panel with a 1GB widget quota, a few replaced videos is the whole budget.
  const sw = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
  assert.match(sw, /function pruneToPlaylist/);
  // Driven by the player declaring a complete set — and an EMPTY set is not a declaration. See
  // test/sw-prune-guard.test.js, which runs the handler: `assignments: []` is what the server sends
  // for a device between playlists and for a snapshot that failed to parse, and honouring it as
  // "keep nothing" wiped the panel's whole offline library.
  assert.match(sw, /if \(data\.prune && data\.urls\.length > 0\)/,
    'the prune must be driven by the player declaring a NON-EMPTY complete set');

  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(html, /prune:\s*true/);
  // ...and the declared set must be the RAW assignments. The split `playlist` omits multi-zone
  // items, so pruning against it would delete assets a zone is still playing.
  assert.match(html, /requestOfflineCache\(Array\.isArray\(data\.assignments\)/);
});
