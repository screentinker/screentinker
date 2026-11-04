'use strict';

// Verifies the public widget render endpoint sanitizes config that gets inlined
// into <style>/CSS (clock/weather/rss/social) and isolates the text widget's
// raw HTML in a sandboxed, null-origin iframe.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-widget-xss';

const db = new Database(':memory:');
db.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT);`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const widgetsRouter = require('../routes/widgets');
const app = express();
app.use('/api/widgets', widgetsRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const seed = (id, type, config, workspaceId = 'ws1') => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, type, JSON.stringify(config), workspaceId);
const render = async (id, query = '') => (await fetch(`${base}/api/widgets/${id}/render${query}`)).text();

const CSS_BREAKOUT = 'red}</style><script>document.title="pwned"</script><style>{';

test('clock widget: malicious background/color/font_size cannot break out of <style>', async () => {
  seed('clock1', 'clock', { background: CSS_BREAKOUT, color: CSS_BREAKOUT, font_size: '64px}</style><script>x</script>' });
  const html = await render('clock1');
  assert.ok(!html.includes('</style><script>document.title'), 'CSS breakout payload must be rejected');
  assert.ok(html.includes('background:transparent'), 'invalid background falls back to default');
  assert.ok(/font-size:64px/.test(html), 'invalid font_size falls back to numeric default');
});

test('rss widget: scroll_speed/max_items coerced to numbers (no injection)', async () => {
  seed('rss1', 'rss', { scroll_speed: '30s}</style><script>y</script>', max_items: '10);evil(' , background: CSS_BREAKOUT });
  const html = await render('rss1');
  assert.ok(!html.includes('</style><script>y'), 'scroll_speed cannot inject');
  assert.ok(!html.includes('evil('), 'max_items cannot inject into the script');
  assert.ok(html.includes('background:transparent'), 'invalid background -> default (see-through, #660)');
});

test('text widget: raw HTML is isolated in a null-origin sandboxed iframe', async () => {
  seed('text1', 'text', { html: '<script>parent.localStorage.token</script>', css: 'body{}' });
  const html = await render('text1');
  assert.ok(html.includes('<iframe sandbox="allow-scripts"'), 'user HTML wrapped in sandboxed iframe');
  assert.ok(!/<body[^>]*>\s*<script>parent\.localStorage/.test(html), 'raw script must not sit in the top-level (same-origin) document');
  assert.ok(html.includes('&lt;script&gt;parent.localStorage'), 'user script is escaped into srcdoc, runs only in the sandboxed frame');
});

test('SSSP3 text widget is a safe static fallback because cached nested frames do not paint', async () => {
  seed('text-sssp3', 'text', { html: '<h1 onclick="steal()">Legacy &amp; panel</h1><script>parent.localStorage.token</script ><img src=x onerror="steal()">', css: 'body{background:url(https://evil.test)}' });
  const html = await render('text-sssp3', '?compat=sssp1228');
  assert.ok(html.includes('<div id="st-legacy-text">Legacy &amp; panel</div>'), 'readable copy remains');
  assert.ok(!html.includes('srcdoc='), 'the unsupported SSSP3 path is absent');
  assert.ok(!html.includes('src="data:'), 'the file-cache-incompatible data navigation is absent');
  assert.ok(!html.includes('<iframe'), 'the firmware-incompatible nested document is absent');
  assert.ok(!html.includes('parent.localStorage') && !html.includes('steal()'), 'active author content is removed');
  assert.ok(!html.includes('evil.test'), 'author CSS is not copied into the local wrapper');
});

test('valid color/gradient backgrounds are preserved', async () => {
  seed('clock2', 'clock', { background: 'linear-gradient(45deg, #ff0000, #00ff00)', color: '#3B82F6' });
  const html = await render('clock2');
  assert.ok(html.includes('linear-gradient(45deg, #ff0000, #00ff00)'), 'legit gradient preserved');
  assert.ok(html.includes('color:#3B82F6'), 'legit hex color preserved');
});

test('webpage kiosk URLs use the serving origin instead of the dashboard localhost', async () => {
  const kioskPath = '/api/kiosk/11111111-1111-4111-8111-111111111111/render';
  seed('webpage1', 'webpage', { url: 'http://localhost:3001' + kioskPath });
  const html = await render('webpage1');
  assert.match(html, new RegExp(`src="${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${kioskPath}"`));
  assert.doesNotMatch(html, /localhost:3001/, 'a display must not resolve the dashboard machine as itself');
});

test('webpage kiosk URLs remain usable without a request origin', () => {
  const kioskPath = '/api/kiosk/11111111-1111-4111-8111-111111111111/render?preview=1';
  const relative = widgetsRouter.renderWidgetHtml('webpage', { url: kioskPath });
  const legacy = widgetsRouter.renderWidgetHtml('webpage', { url: 'http://localhost:3001' + kioskPath });
  assert.ok(relative.includes(`src="${kioskPath}"`));
  assert.ok(legacy.includes(`src="${kioskPath}"`));
  assert.doesNotMatch(relative + legacy, /about:blank|localhost:3001/);
});

// A widget config field that is a JSON ARRAY/OBJECT (never normalized for non-slide widgets) used to
// slip past escapeHtml, which returned non-strings unchanged; the surrounding template then
// string-coerced it, unescaped. escapeHtml now String()-coerces first.
test('social widget: an ARRAY config field cannot inject markup (non-string escape bypass)', async () => {
  seed('social1', 'social', { platform: ['<img src=x onerror=alert(document.domain)>'], query: '#ok' });
  const html = await render('social1');
  assert.ok(!/<img src=x onerror=/.test(html), 'array value must not reach the document as raw markup');
  // The social wall (lib/social/widget.js) no longer prints the old placeholder's platform/query
  // fields at all: a legacy config renders the "choose a feed" page, and the payload goes nowhere.
  assert.ok(!html.includes('onerror'), 'the legacy field is not rendered in any form');
  assert.match(html, /Choose a social feed/);
});

test('rss widget: an ARRAY feed_url cannot break out of the JS string (non-string escape bypass)', async () => {
  seed('rss2', 'rss', { feed_url: ["');alert(document.domain);//"] });
  const html = await render('rss2');
  assert.ok(!html.includes("');alert(document.domain)"), 'unescaped quote must not break the JS string context');
  // 3.0 news feeds: the feed address is no longer written into the page at all. The page gets a
  // signed /api/news-feeds/items path built from a URL that parses, and a non-string is no URL.
  assert.ok(!html.includes('alert('), 'the payload is not in the page in any form');
  assert.match(html, /"url":""/, 'no feed to read');
});

test('rss widget: a feed URL with quotes and markup reaches the page only as an encoded, signed path', async () => {
  seed('rss3', 'rss', { feed_url: 'https://example.com/feed?x=\'</script><script>alert(1)</script>' });
  const html = await render('rss3');
  assert.ok(!/<script>alert\(1\)/.test(html), 'no markup breakout');
  assert.ok(!html.includes("x='"), 'no raw quote from the URL');
  // In the page's JSON block, so `&` is written \u0026.
  assert.match(html, /\/api\/news-feeds\/items\?m=feed\\u0026u=https%3A%2F%2Fexample\.com%2Ffeed/);
  assert.ok(!html.includes('rss2json'), 'no third-party converter');
});

test('SSSP3 directory and menu widgets use static legacy pages instead of unsupported grid/animation layout', async () => {
  seed('dir-sssp3', 'directory-board', {
    title: 'Reception directory', categories: [{ name: 'Front desk', entries: [{ identifier: '101', name: 'Ada', subtitle: 'Support', available: true }] }],
  });
  seed('menu-sssp3', 'menu-board', {
    title: 'Cafe menu', sections: [{ name: 'Drinks', items: [{ name: 'Coffee', price: '40 EGP', description: 'Freshly prepared' }] }],
  });
  const directory = await render('dir-sssp3', '?compat=sssp1228');
  const menu = await render('menu-sssp3', '?compat=sssp1228');
  assert.match(directory, /Reception directory/);
  assert.match(directory, /Ada/);
  assert.doesNotMatch(directory, /dir-pan|display:grid/);
  assert.match(menu, /Cafe menu/);
  assert.match(menu, /Coffee/);
  assert.doesNotMatch(menu, /<template id="src">/);
});


test("SSSP3 directory search cannot read another workspace's source widget", async () => {
  seed('directory-ws2', 'directory-board', {
    title: 'Workspace two directory', categories: [{ name: 'Private', entries: [{ identifier: '2', name: 'Not visible', available: true }] }],
  }, 'ws2');
  seed('search-ws1', 'directory-search', { source_widget_id: 'directory-ws2', title: 'Reception search' }, 'ws1');
  const html = await render('search-ws1', '?compat=sssp1228');
  assert.match(html, /Directory source not found/);
  assert.doesNotMatch(html, /Workspace two directory|Not visible/);
});

test('SSSP3 directory search can use a source widget from its own workspace', async () => {
  seed('directory-ws1', 'directory-board', {
    title: 'Workspace one directory', categories: [{ name: 'Reception', entries: [{ identifier: '1', name: 'Visible', available: true }] }],
  }, 'ws1');
  seed('search-own-ws1', 'directory-search', { source_widget_id: 'directory-ws1', title: 'Reception search' }, 'ws1');
  const html = await render('search-own-ws1', '?compat=sssp1228');
  assert.match(html, /Visible/);
});

test('SSSP3 RSS has a deterministic static fallback instead of relying on legacy animation APIs', async () => {
  seed('rss-sssp3', 'rss', { feed_url: 'https://feeds.example.test/news.xml', layout: 'ticker' });
  const html = widgetsRouter.renderWidgetHtml('rss', { feed_url: 'https://feeds.example.test/news.xml' }, { legacyDataFrame: true });
  assert.match(html, /Waiting for feed data/);
  assert.doesNotMatch(html, /strip\.animate|<script>/);
});

test('SSSP3 room display is a display-only static snapshot, not a nested live panel', () => {
  const html = widgetsRouter.renderLegacyRoomDisplay(
    { background: '#123456' },
    { room: { name: 'Reception room', timezone: 'Africa/Cairo' }, server_now: Date.UTC(2026, 10, 2, 10, 0), events: [
      { start: Date.UTC(2026, 10, 2, 9, 30), end: Date.UTC(2026, 10, 2, 10, 30), title: 'Design review' },
    ] }
  );
  assert.match(html, /Reception room/);
  assert.match(html, /BUSY/);
  assert.match(html, /Design review/);
  assert.doesNotMatch(html, /<script|<iframe|fetch\(/, 'the SSSP3 cache never needs a nested live panel');
});

test('SSSP3 social wall is a static approved-post snapshot, not a live animated frame', () => {
  const html = widgetsRouter.renderLegacySocial(
    { id: 'social1', workspace_id: 'ws1' },
    { title: 'Reception updates', background: '#123456' },
    { configured: true, posts: [{ a: 'ScreenTinker Cairo', h: '@screentinker', n: 'instagram', t: 'Welcome to the lobby.' }] }
  );
  assert.match(html, /Reception updates/);
  assert.match(html, /ScreenTinker Cairo/);
  assert.match(html, /Welcome to the lobby/);
  assert.doesNotMatch(html, /<script|<iframe|fetch\(|animate\(/, 'the cache stores only the approved display snapshot');
});


test('SSSP3 webpage wrappers pass compatibility mode only to same-server widget pages', () => {
  const url = 'http://screen.test/api/widgets/11111111-1111-4111-8111-111111111111/render?rev=3';
  const html = widgetsRouter.renderWidgetHtml('webpage', { url }, { origin: 'http://screen.test', legacyDataFrame: true });
  assert.match(html, /compat=sssp1228/);
  const external = widgetsRouter.renderWidgetHtml('webpage', { url: 'https://example.test/page' }, { origin: 'http://screen.test', legacyDataFrame: true });
  assert.doesNotMatch(external, /compat=sssp1228/);
});


test('SSSP3 webpages inline same-workspace ScreenTinker widgets instead of using an unpainted nested frame', async () => {
  seed('11111111-1111-4111-8111-111111111111', 'directory-board', { title: 'Linked directory', categories: [{ name: 'Desk', entries: [{ identifier: '1', name: 'Ada', available: true }] }] });
  seed('22222222-2222-4222-8222-222222222222', 'webpage', { url: `${base}/api/widgets/11111111-1111-4111-8111-111111111111/render` });
  const html = await render('22222222-2222-4222-8222-222222222222', '?compat=sssp1228');
  assert.match(html, /Linked directory/);
  assert.match(html, /Ada/);
  assert.doesNotMatch(html, /<iframe/);
});


test('weather snapshot data remains data when a provider returns a script terminator', () => {
  const payload = { current_condition: [{ temp_C: '27', weatherDesc: [{ value: '</script><script>globalThis.pwned=1</script>' }] }] };
  const literal = widgetsRouter.scriptJson(payload);
  assert.doesNotMatch(literal, /<\/script><script>globalThis\.pwned/, 'provider text cannot end the renderer script');
  assert.match(literal, /\\u003c\/script>/, 'the dangerous character is escaped in the JavaScript literal');
  assert.doesNotMatch(literal, /[\u2028\u2029]/, 'line separators are escaped too');
});

test('SSSP3 weather snapshots share a bounded server cache instead of fetching once per panel render', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  widgetsRouter.legacyWeatherCache.clear();
  global.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ current_condition: [{ temp_C: '27' }] }) };
  };
  try {
    const url = 'https://wttr.in/Cairo?format=j1';
    const [first, second] = await Promise.all([widgetsRouter.legacyWeatherSnapshot(url), widgetsRouter.legacyWeatherSnapshot(url)]);
    assert.equal(calls, 1, 'concurrent panel renders share the pending upstream request');
    assert.deepEqual(first, second);
    await widgetsRouter.legacyWeatherSnapshot(url);
    assert.equal(calls, 1, 'a completed snapshot is reused during its TTL');
  } finally {
    global.fetch = originalFetch;
    widgetsRouter.legacyWeatherCache.clear();
  }
});
