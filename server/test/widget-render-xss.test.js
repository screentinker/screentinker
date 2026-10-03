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

const seed = (id, type, config) => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, type, JSON.stringify(config), 'ws1');
const render = async (id) => (await fetch(`${base}/api/widgets/${id}/render`)).text();

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
  assert.ok(html.includes('background:#000'), 'invalid background -> default');
});

test('text widget: raw HTML is isolated in a null-origin sandboxed iframe', async () => {
  seed('text1', 'text', { html: '<script>parent.localStorage.token</script>', css: 'body{}' });
  const html = await render('text1');
  assert.ok(html.includes('<iframe sandbox="allow-scripts"'), 'user HTML wrapped in sandboxed iframe');
  assert.ok(!/<body[^>]*>\s*<script>parent\.localStorage/.test(html), 'raw script must not sit in the top-level (same-origin) document');
  assert.ok(html.includes('&lt;script&gt;parent.localStorage'), 'user script is escaped into srcdoc, runs only in the sandboxed frame');
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
  assert.ok(html.includes('&lt;img src=x onerror='), 'it must land as escaped characters instead');
});

test('rss widget: an ARRAY feed_url cannot break out of the JS string (non-string escape bypass)', async () => {
  seed('rss2', 'rss', { feed_url: ["');alert(document.domain);//"] });
  const html = await render('rss2');
  assert.ok(!html.includes("');alert(document.domain)"), 'unescaped quote must not break the JS string context');
  assert.ok(html.includes('&#39;'), 'the quote is escaped, so the payload is inert data');
});
