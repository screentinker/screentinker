'use strict';

/*
 * What search engines may index (Bing Webmaster Tools, 2026-11-23: pages with no title, no
 * description, no h1, thin content). One URL per page, and nothing indexed that is not a page:
 *   - www. redirects to APP_URL's host for published pages ONLY; screens, API and dashboard are left
 *     alone so a player set up with a www. address keeps working;
 *   - .md renditions, installers, and the dashboard shell are noindex;
 *   - guessed addresses 301 to the real page; a .html page that does not exist is a 404.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('./helpers/web-player-e2e');

let srv, port;
before(async () => { srv = await startServer('seo', { APP_URL: 'https://screentinker.com' }); port = new URL(srv.base).port; });
after(() => { if (srv) srv.stop(); });

function get(path, { host = '127.0.0.1', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, robots: res.headers['x-robots-tag'] }));
    });
    req.on('error', reject); req.end();
  });
}

test('www.: published pages redirect to the canonical host, with the query kept', async () => {
  const www = 'www.screentinker.com';
  assert.deepEqual(await get('/', { host: www }).then((r) => [r.status, r.location]), [301, 'https://screentinker.com/']);
  const guide = await get('/guides/what-is-digital-signage.html?ref=x', { host: www });
  assert.deepEqual([guide.status, guide.location], [301, 'https://screentinker.com/guides/what-is-digital-signage.html?ref=x']);
  assert.equal((await get('/guides/what-is-digital-signage.md', { host: www })).status, 301);
});

test('www.: screens, the API, the dashboard and downloads are never redirected', async () => {
  const www = 'www.screentinker.com';
  for (const p of ['/api/status', '/player', '/app', '/download', '/socket.io/?EIO=4&transport=polling']) {
    const r = await get(p, { host: www });
    assert.ok(!(r.status === 301 && /^https:\/\/screentinker\.com/.test(r.location || '')), `${p} stayed on www. (${r.status} ${r.location || ''})`);
  }
  assert.notEqual((await get('/', { host: www, method: 'POST' })).status, 301, 'only GET/HEAD');
  assert.equal((await get('/')).status, 200, 'the canonical host itself is served');
});

test('guessed addresses 301 to the real page', async () => {
  assert.deepEqual(await get('/downloads').then((r) => [r.status, r.location]), [301, '/download']);
  assert.deepEqual(await get('/guides.html').then((r) => [r.status, r.location]), [301, '/guides/']);
  assert.deepEqual(await get('/admin.html').then((r) => [r.status, r.location]), [301, '/app']);
});

test('not pages: noindex. Pages: no robots header', async () => {
  for (const p of ['/guides/what-is-digital-signage.md', '/index.md', '/download/pi', '/download/apk', '/index.html', '/app', '/some-old-deep-link']) {
    assert.equal((await get(p)).robots, 'noindex', p);
  }
  for (const p of ['/', '/download', '/guides/', '/guides/what-is-digital-signage.html', '/delete-account']) {
    const r = await get(p);
    assert.equal(r.robots, undefined, p);
  }
});

test('a .html page that does not exist is a 404, not the app shell', async () => {
  const r = await get('/no-such-page.html');
  assert.equal(r.status, 404);
  assert.equal(r.robots, undefined, 'the 404 page carries its own meta robots');
});
