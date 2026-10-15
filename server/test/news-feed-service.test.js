'use strict';

/*
 * 3.0 news feeds — the server half (lib/news-feed/index.js, routes/news-feeds.js): fetching through
 * the SSRF guard, the shared cache and stale-on-error, the per-host budget, discovery, building a
 * feed from a page (robots.txt honoured), the signed screen-facing endpoints, the image proxy, and
 * the outbound ledger naming it all "news_feeds". Every request goes to a local fixture server.
 */

const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = path.join(os.tmpdir(), `st-news-feed-${process.pid}-${Date.now()}`);
process.env.JWT_SECRET = 'test-secret-news-feed';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const ledger = require('../lib/outbound-ledger');
const news = require('../lib/news-feed');

const FX = path.join(__dirname, 'fixtures', 'news-feed');
const fx = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(64, 7)]);

let origin, fixture, hits, seenUA;
let feedStatus = 200;
let robots = '';
let noFeeds = false;    // the site has no feed at any of the usual paths
let sitemapOn = false;  // /sitemap.xml exists
const routes = new Map();

before(async () => {
  fixture = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
    seenUA = req.headers['user-agent'];
    const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (noFeeds && require('../lib/news-feed/discover').COMMON_PATHS.includes(u.pathname)) return send(404, 'text/html', '<!doctype html><html>nope</html>');
    if (u.pathname === '/sitemap.xml' && !sitemapOn) return send(404, 'text/html', '<!doctype html><html>nope</html>');
    if (u.pathname === '/robots.txt') return robots === null ? send(404, 'text/plain', 'no') : send(200, 'text/plain', robots);
    if (u.pathname === '/rss.xml') return feedStatus === 200 ? send(200, 'application/rss+xml; charset=utf-8', fx('rss2-cdata.xml')) : send(feedStatus, 'text/plain', 'down');
    if (u.pathname === '/moved') { res.writeHead(301, { Location: '/rss.xml' }); return res.end(); }
    if (u.pathname === '/img/a.jpg') return send(200, 'image/jpeg', JPEG);
    if (u.pathname === '/img/fake.jpg') return send(200, 'image/jpeg', '<html>not an image</html>');
    const r = routes.get(u.pathname);
    if (r) return send(200, r.type, r.body());
    send(404, 'text/html', '<!doctype html><html><body>Not found</body></html>');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${fixture.address().port}`;

  routes.set('/site/', { type: 'text/html', body: () => `<!doctype html><html><head><title>Fixture News</title>
    <link rel="alternate" type="application/rss+xml" title="All news" href="/rss.xml">
    <link rel="alternate" type="application/rss+xml" title="Local news" href="${origin}/rss/category/local-news">
    </head><body>hi</body></html>` });
  routes.set('/blog/', { type: 'text/html', body: () => '<!doctype html><html><head><title>Blog</title></head><body>no link tags</body></html>' });
  routes.set('/feed', { type: 'application/atom+xml', body: () => fx('atom.xml') });
  routes.set('/crier/', { type: 'text/html; charset=utf-8', body: () => fx('page-jsonld.html').replaceAll('https://crier.example.test', origin) });
  routes.set('/gazette/', { type: 'text/html', body: () => fx('page-links.html').replaceAll('https://www.gazette.example.test', origin) });
  routes.set('/plain/', { type: 'text/html', body: () => '<!doctype html><html><head><title>Plain Times</title></head><body><p>No lists here</p></body></html>' });
  routes.set('/sitemap.xml', { type: 'application/xml', body: () => fx('news-sitemap.xml').replaceAll('https://plain.example.test', origin) });
  routes.set('/withimg/', { type: 'text/html', body: () => `<!doctype html><html><head></head><body>
    <script type="application/ld+json">{"@graph":[
      {"@type":"NewsArticle","headline":"Story with a picture one","url":"${origin}/s/1","image":"${origin}/img/a.jpg"},
      {"@type":"NewsArticle","headline":"Story with a picture two","url":"${origin}/s/2","image":"${origin}/img/fake.jpg"},
      {"@type":"NewsArticle","headline":"Story without a picture","url":"${origin}/s/3"}]}</script></body></html>` });
  routes.set('/s/3', { type: 'text/html', body: () => `<!doctype html><html><head><meta property="og:image" content="${origin}/img/a.jpg"></head><body>Article body that must never be read into the feed.</body></html>` });
  ledger.install({ db });
});

after(() => {
  ledger.uninstall();
  fixture.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) { /* */ }
});

beforeEach(() => {
  news._reset();
  hits = new Map();
  feedStatus = 200;
  robots = '';
  noFeeds = false;
  sitemapOn = false;
  process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';
  delete process.env.OUTBOUND_ALLOW_PRIVATE;
});

/* ───────────── reading and caching ───────────── */

test('reads a feed through the guard with the feed reader user agent; a second read is served from the cache', async () => {
  const a = await news.getFeed(`${origin}/rss.xml`);
  assert.equal(a.items.length, 3);
  assert.equal(a.items[0].title, 'City Weather: Rainy, chilly Thursday');
  assert.equal(a.stale, false);
  assert.match(seenUA, /^ScreenTinker-FeedReader\/1\.0 \(ScreenTinker feed reader; \+https:\/\/screentinker\.com\)$/);
  const b = await news.getFeed(`${origin}/rss.xml`);
  assert.equal(b.items.length, 3);
  assert.equal(hits.get('/rss.xml'), 1, 'one upstream read for both');
});

test('concurrent readers of one feed share one fetch', async () => {
  const all = await Promise.all(Array.from({ length: 8 }, () => news.getFeed(`${origin}/rss.xml`)));
  assert.ok(all.every((r) => r.items.length === 3));
  assert.equal(hits.get('/rss.xml'), 1);
});

test('after FRESH_MS the feed is read again', async () => {
  await news.getFeed(`${origin}/rss.xml`);
  news._age(`${origin}/rss.xml`, 'feed', news.FRESH_MS + 1000);
  await news.getFeed(`${origin}/rss.xml`);
  assert.equal(hits.get('/rss.xml'), 2);
});

test('stale on error: the source goes down, the last good items are served (marked stale) for up to a day', async () => {
  await news.getFeed(`${origin}/rss.xml`);
  feedStatus = 500;
  news._age(`${origin}/rss.xml`, 'feed', news.FRESH_MS + 1000);
  const s = await news.getFeed(`${origin}/rss.xml`);
  assert.equal(s.stale, true);
  assert.equal(s.items.length, 3);
  assert.equal(hits.get('/rss.xml'), 2);
  // Within the error backoff the source is not asked again.
  const s2 = await news.getFeed(`${origin}/rss.xml`);
  assert.equal(s2.stale, true);
  assert.equal(hits.get('/rss.xml'), 2, 'backing off after a failure');
  // Past a day the old items are too old to show.
  news._age(`${origin}/rss.xml`, 'feed', news.STALE_MAX_MS);
  await assert.rejects(news.getFeed(`${origin}/rss.xml`), (e) => e.code === 'status');
});

test('peek: what the cache holds, without waiting; nothing for an unknown feed and no fetch started', async () => {
  assert.equal(news.peek(`${origin}/rss.xml`), null);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hits.get('/rss.xml') || 0, 0, 'a render must not make the server reach out for an unknown feed');
  await news.getFeed(`${origin}/rss.xml`);
  assert.equal(news.peek(`${origin}/rss.xml`).items.length, 3);
});

test('a redirect is followed (and re-vetted); relative links resolve against where the feed really is', async () => {
  const f = await news.getFeed(`${origin}/moved`);
  assert.equal(f.items[1].image, `${origin}/uploads/scene.jpg`);
});

test('a web page given as a feed says so', async () => {
  await assert.rejects(news.getFeed(`${origin}/site/`), (e) => e.code === 'not-feed');
});

test('per-host budget: no number of callers makes this server read one site more than HOST_LIMIT times a minute', async () => {
  let refused = 0;
  for (let i = 0; i < news.HOST_LIMIT + 5; i++) {
    news._age(`${origin}/rss.xml`, 'feed', news.STALE_MAX_MS + 1);
    try {
      await news.fetchText(`${origin}/rss.xml`);
    } catch (e) { if (e.code === 'rate') refused++; }
  }
  assert.equal(hits.get('/rss.xml'), news.HOST_LIMIT);
  assert.equal(refused, 5);
});

/* ───────────── SSRF ───────────── */

test('⚠️ SSRF: a private address is refused unless the operator opened it; cloud metadata never', async () => {
  delete process.env.OUTBOUND_ALLOW_HOSTS;
  await assert.rejects(news.getFeed(`${origin}/rss.xml`), (e) => e.code === 'private' && /OUTBOUND_ALLOW_HOSTS/.test(e.message));
  await assert.rejects(news.discoverFeeds('http://localhost:1/'), (e) => e.code === 'private');
  assert.equal(hits.get('/rss.xml') || 0, 0, 'never connected');
  process.env.OUTBOUND_ALLOW_PRIVATE = '1';
  await assert.rejects(news.getFeed('http://169.254.169.254/latest/meta-data/'), (e) => e.code === 'private');
  await assert.rejects(news.getFeed('file:///etc/passwd'), (e) => e.code === 'bad-url');
  await assert.rejects(news.getFeed('http://user:pw@example.test/feed'), (e) => e.code === 'bad-url');
});

test('⚠️ SSRF: a public feed that redirects to a private address is refused at the hop', async () => {
  routes.set('/to-metadata', { type: 'text/plain', body: () => '' });
  const srv = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    process.env.OUTBOUND_ALLOW_PRIVATE = '1';
    await assert.rejects(news.getFeed(`http://127.0.0.1:${srv.address().port}/feed`), (e) => e.code === 'private');
  } finally { srv.close(); }
});

/* ───────────── discovery and built-from-page feeds ───────────── */

test('discover: a site\'s advertised feeds by title', async () => {
  const d = await news.discoverFeeds(`${origin}/site/`);
  assert.equal(d.title, 'Fixture News');
  assert.deepEqual(d.feeds.map((f) => [f.title, f.url]), [['All news', `${origin}/rss.xml`], ['Local news', `${origin}/rss/category/local-news`]]);
  assert.equal(d.page, null);
});

test('discover: a feed address answers with itself (and warms the cache)', async () => {
  const d = await news.discoverFeeds(`${origin}/rss.xml`);
  assert.equal(d.feeds.length, 1);
  assert.equal(d.feeds[0].title, 'Latest News | Channel 9 Test');
  assert.equal(d.feeds[0].item_count, 3);
  await news.getFeed(`${origin}/rss.xml`);
  assert.equal(hits.get('/rss.xml'), 1);
});

test('discover: no <link> tags → the usual paths are tried, and the first feed found is the answer', async () => {
  const d = await news.discoverFeeds(`${origin}/blog/`);
  assert.deepEqual(d.feeds.map((f) => f.url), [`${origin}/feed`]);
  assert.equal(d.feeds[0].format, 'atom');
  assert.equal(hits.get('/rss') || 0, 0, 'stopped at the first');
});

test('discover: a site with no feed at all offers headlines built from the page (JSON-LD)', async () => {
  noFeeds = true;
  {
    const d = await news.discoverFeeds(`${origin}/crier/`);
    assert.deepEqual(d.feeds, []);
    assert.equal(d.page.available, true);
    assert.equal(d.page.source, 'jsonld');
    assert.equal(d.page.title, 'The Town Crier');
    assert.equal(d.page.items[0].title, 'Library extends weekend hours');
    // The built feed is now cached for the widget to read.
    const f = await news.getFeed(`${origin}/crier/`, 'page');
    assert.equal(f.source, 'jsonld');
    assert.equal(hits.get('/crier/'), 2, 'discover read the page once to look for feeds, once to build');
  }
});

test('built from page: a Google News sitemap named in robots.txt when the page has no article list', async () => {
  sitemapOn = true;
  robots = `User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`;
  const f = await news.getFeed(`${origin}/plain/`, 'page');
  assert.equal(f.source, 'sitemap');
  assert.deepEqual(f.items.map((i) => i.title).slice(0, 2), ['Newest story: rail service & bus changes', 'Middle story on the new clinic']);
});

test('built from page: headline links as the last resort; never the article text', async () => {
  const f = await news.getFeed(`${origin}/gazette/`, 'page');
  assert.equal(f.source, 'links');
  assert.equal(f.items[0].title, 'New bakery opens on Main Street this weekend');
  assert.ok(f.items.every((i) => i.summary === ''));
});

test('built from page: an item with no picture borrows its page\'s og:image (top few only), and nothing else from it', async () => {
  const f = await news.getFeed(`${origin}/withimg/`, 'page');
  assert.equal(f.items[2].image, `${origin}/img/a.jpg`);
  assert.ok(!JSON.stringify(f).includes('Article body'), 'the article body is never read into the feed');
  assert.equal(hits.get('/s/3'), 1);
});

test('⚠️ robots.txt: a page the site disallows for us is not read', async () => {
  robots = 'User-agent: ScreenTinker-FeedReader\nDisallow: /crier/\n';
  await assert.rejects(news.getFeed(`${origin}/crier/`, 'page'), (e) => e.code === 'robots');
  assert.equal(hits.get('/crier/') || 0, 0);
  robots = null; // 404: no rules
  news._reset();
  const f = await news.getFeed(`${origin}/crier/`, 'page');
  assert.ok(f.items.length >= 3);
});

/* ───────────── ledger ───────────── */

test('⚠️ trust ledger: feed reads are recorded under news_feeds, host only', async () => {
  ledger.flush();
  db.prepare('DELETE FROM outbound_ledger').run();
  await news.getFeed(`${origin}/rss.xml?token=SECRET`);
  await news.discoverFeeds(`${origin}/site/`);
  ledger.flush();
  const rows = db.prepare('SELECT * FROM outbound_ledger').all();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.feature, 'news_feeds', JSON.stringify(r));
    assert.equal(r.category, 'data');
    assert.equal(r.host, `127.0.0.1:${fixture.address().port}`);
  }
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

/* ───────────── signed endpoints ───────────── */

function appFor(role = 'workspace_editor') {
  const app = express();
  app.use(express.json());
  const r = require('../routes/news-feeds');
  app.get('/api/news-feeds/items', r.itemsHandler);
  app.get('/api/news-feeds/image', r.imageHandler);
  app.use('/api/news-feeds', (req, res, next) => { req.user = { id: 'u1' }; req.workspaceId = 'ws1'; req.workspaceRole = role; next(); }, r);
  return app;
}
async function withApp(role, fn) {
  const srv = appFor(role).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('items endpoint: unsigned or tampered → 403; signed → items, CORS-open, pictures via this server only', async () => {
  await withApp('workspace_editor', async (base) => {
    const feed = `${origin}/withimg/`;
    let r = await fetch(`${base}/api/news-feeds/items?m=page&u=${encodeURIComponent(feed)}&s=nope`);
    assert.equal(r.status, 403);
    const signedPath = news.itemsPath(feed, 'page');
    r = await fetch(base + signedPath.replace('m=page', 'm=feed'));
    assert.equal(r.status, 403, 'the signature covers the mode');
    r = await fetch(base + signedPath.replace(encodeURIComponent(feed), encodeURIComponent(`${origin}/rss.xml`)));
    assert.equal(r.status, 403, 'and the URL');
    r = await fetch(`${base}${signedPath}&n=2`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const body = await r.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].title, 'Story with a picture one');
    assert.match(body.items[0].image, /^\/api\/news-feeds\/image\?u=/);
    assert.ok(!JSON.stringify(body.items.map((i) => i.image)).includes(origin), 'the publisher\'s picture URL is not handed to a screen');

    // The picture through the proxy: a real image is served, sniffed type and CORP for an opaque page.
    let img = await fetch(base + body.items[0].image);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
    // HTML claiming to be a JPEG is never served.
    img = await fetch(base + body.items[1].image);
    assert.equal(img.status, 404);
    // An unsigned picture URL is refused before anything is fetched.
    const before = hits.get('/img/a.jpg');
    img = await fetch(`${base}/api/news-feeds/image?u=${encodeURIComponent(`${origin}/img/a.jpg?x=1`)}&s=forged`);
    assert.equal(img.status, 403);
    assert.equal(hits.get('/img/a.jpg'), before);
  });
});

test('items endpoint: a source that is down with nothing cached answers 502 with an empty items list', async () => {
  feedStatus = 503;
  await withApp('workspace_editor', async (base) => {
    const r = await fetch(base + news.itemsPath(`${origin}/rss.xml`, 'feed'));
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.deepEqual(b.items, []);
    assert.equal(b.code, 'status');
  });
});

test('dashboard API: discover and preview for editors; a view-only member is refused before any read', async () => {
  await withApp('workspace_editor', async (base) => {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let r = await post('/api/news-feeds/discover', { url: `${origin}/site/` });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).feeds.length, 2);
    r = await post('/api/news-feeds/preview', { url: `${origin}/rss.xml`, mode: 'feed' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).items[0].title, 'City Weather: Rainy, chilly Thursday');
    r = await post('/api/news-feeds/discover', { url: '' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'bad-url');
  });
  hits = new Map();
  await withApp('workspace_viewer', async (base) => {
    const r = await fetch(`${base}/api/news-feeds/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${origin}/site/` }) });
    assert.equal(r.status, 403);
    assert.equal(hits.size, 0);
  });
});

test('3.0.1 dashboard preview: pictures come through this server\'s signed image proxy, never the publisher\'s (http) URL', async () => {
  // The dashboard's CSP allows only https: images from elsewhere, so an http feed's pictures drawn
  // straight from the publisher were broken images in "Find feeds". The fixture IS plain http.
  noFeeds = true;
  await withApp('workspace_editor', async (base) => {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const check = async (items, what) => {
      const withPic = items.filter((i) => i.image);
      assert.ok(withPic.length >= 1, `${what}: some items have pictures`);
      for (const it of withPic) {
        assert.match(it.image, /^\/api\/news-feeds\/image\?u=[^&]+&s=[\w-]+$/, `${what}: ${it.image}`);
        assert.ok(!it.image.startsWith('http'), `${what}: a same-origin address, which img-src 'self' allows`);
      }
      // The address works: the real picture comes back through the proxy.
      const first = withPic.find((i) => decodeURIComponent(i.image).includes('/img/a.jpg'));
      const img = await fetch(base + first.image);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
    };

    let r = await post('/api/news-feeds/discover', { url: `${origin}/withimg/` });
    assert.equal(r.status, 200);
    const found = await r.json();
    assert.equal(found.page.available, true);
    await check(found.page.items, 'discover (built from the page)');

    r = await post('/api/news-feeds/preview', { url: `${origin}/withimg/`, mode: 'page' });
    assert.equal(r.status, 200);
    const prev = await r.json();
    await check(prev.items, 'preview');
    assert.ok(!JSON.stringify(prev.items.map((i) => i.image)).includes(origin), 'no publisher picture URL reaches the editor\'s browser');
  });
  // The shared cache keeps the publisher's URL (screens get their own signed paths from it).
  assert.ok(news.peek(`${origin}/withimg/`, 'page').items.some((i) => i.image === `${origin}/img/a.jpg`));
});

/* ───────────── rendering ───────────── */

test('the news widget page reads its signed items path and is seeded from the cache; text widgets lose rss2json', async () => {
  const { renderWidgetHtml } = require('../routes/widgets');
  await news.getFeed(`${origin}/rss.xml`);
  const html = renderWidgetHtml('rss', { feed_url: `${origin}/rss.xml`, max_items: 2 });
  assert.ok(!/rss2json/.test(html));
  assert.ok(html.includes('City Weather: Rainy, chilly Thursday'), 'seeded with the cached headlines');
  assert.ok(!html.includes('School board votes'), 'only max_items of them');
  const m = /"url":"([^"]+)"/.exec(html);
  const path = m[1].replace(/\\u0026/g, '&');
  const u = new URL(path, 'http://x');
  assert.equal(u.pathname, '/api/news-feeds/items');
  assert.equal(news.verifyFeed(u.searchParams.get('u'), u.searchParams.get('m'), u.searchParams.get('s')), true);
  assert.equal(u.searchParams.get('n'), '2');

  const legacy = renderWidgetHtml('text', { html: `<div id="t0"></div><script>fetch('https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`${origin}/rss.xml`)}').then(r=>r.json()).then(d=>{document.getElementById('t0').textContent=d.items.map(i=>i.title).join(' • ')})</script>` });
  assert.ok(!/rss2json/.test(legacy), 'the old designer ticker no longer calls a third party');
  assert.match(legacy, /\/api\/news-feeds\/items\?m=feed&amp;u=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Frss\.xml&amp;s=[A-Za-z0-9_-]{32}/);
  const fresh = renderWidgetHtml('text', { html: `<script>fetch('/api/news-feeds/items?m=feed&u=${encodeURIComponent(`${origin}/rss.xml`)}')</script>` });
  assert.match(fresh, /&amp;s=[A-Za-z0-9_-]{32}/, 'the designer\'s unsigned path is signed at render');
});
