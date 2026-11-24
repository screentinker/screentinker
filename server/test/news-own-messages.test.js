'use strict';

/*
 * The news widget's OWN MESSAGES (Discord request: "add free text for temporary notifications like
 * 'elevator out of service'"). Free text lines shown before the feed's headlines, or alone when no
 * feed is chosen, each with an optional `until` after which it is not shown: not by the server's
 * render, and not by a screen already playing it (the page drops it on its own clock).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { SKIP, launch } = require('./helpers/web-player-e2e');
const { renderWidgetHtml, ownMessages } = require('../routes/widgets');
const { freePort } = require('./helpers/free-port');

const cfgOf = (html) => JSON.parse(/<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html)[1]);
const HOUR = 3600 * 1000;

test('own messages: cleaned, capped, and expired ones left out of the render', () => {
  const now = Date.now();
  const list = [
    { text: '  Elevator   out\nof service  ', until: now + HOUR },
    { text: 'Gone already', until: now - 1000 },
    { text: '' }, null, 'not an object', { text: 42 },
    { text: 'Forever', until: null },
    { text: 'x'.repeat(500) },
  ];
  assert.deepEqual(ownMessages(list, { now }).map((m) => m.text.slice(0, 20)), ['Elevator out of serv', 'Forever', 'x'.repeat(20)]);
  assert.equal(ownMessages(list, { now })[2].text.length, 300);
  assert.equal(ownMessages(list, { now, keepExpired: true }).length, 4, 'the editor still gets the expired one back');
  assert.equal(ownMessages(Array.from({ length: 30 }, (_, i) => ({ text: 'm' + i }))).length, 20);
  assert.deepEqual(ownMessages('nope'), []);

  const cfg = cfgOf(renderWidgetHtml('rss', { messages: list }));
  assert.deepEqual(cfg.own.map((m) => m.t), ['Elevator out of service', 'Forever', 'x'.repeat(300)]);
  assert.equal(cfg.url, '', 'no feed chosen');
});

test('own message text is data: it cannot break out of the page', () => {
  const html = renderWidgetHtml('rss', { messages: [{ text: '</script><img src=x onerror=alert(1)>' }] });
  assert.ok(!html.includes('<img src=x'), 'escaped inside the JSON block');
  const legacy = renderWidgetHtml('rss', { messages: [{ text: '<b>Lift</b> closed' }] }, { legacyDataFrame: true });
  assert.match(legacy, /&lt;b&gt;Lift&lt;\/b&gt; closed/, 'the legacy page shows it, escaped');
});

let browser;
before(async () => { if (!SKIP) browser = await launch(); });
after(async () => { if (browser) await browser.close(); });

// Speeds the page's 15 s expiry check up, so a test can watch a message expire.
const FAST_TIMERS = () => {
  const si = window.setInterval;
  window.setInterval = (fn, ms) => si(fn, ms === 15000 ? 100 : ms);
};

test('a ticker with only own messages scrolls them, and an expired one drops off on the screen', { skip: SKIP }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(FAST_TIMERS);
    await page.setViewport({ width: 1280, height: 120 });
    const html = renderWidgetHtml('rss', { layout: 'ticker', messages: [
      { text: 'Elevator out of service', until: Date.now() + 1500 },
      { text: 'Lobby doors close at 9pm' },
    ] });
    // A navigation (not setContent) so the timer hook above runs before the page's script.
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const titles = () => page.$$eval('.ticker .title', (els) => els.map((e) => e.textContent));
    assert.deepEqual(await titles(), ['Elevator out of service', 'Lobby doors close at 9pm']);
    await page.waitForFunction(() => document.querySelectorAll('.ticker .title').length === 1, { timeout: 5000 });
    assert.deepEqual(await titles(), ['Lobby doors close at 9pm']);
  } finally { await page.close(); }
});

test('headlines look: own messages come first, then the feed', { skip: SKIP }, async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 720 });
    // With a feed chosen; the page cannot reach it here, so it keeps the seeded items.
    const html = renderWidgetHtml('rss', { layout: 'headlines', feed_url: 'https://news.example.com/rss.xml', messages: [{ text: 'Fire drill at 2pm' }] }, {
      seed: false,
    });
    // Seed the page with feed items, the way a server that already holds the feed does.
    const seeded = html.replace('"seed":null', '"seed":[{"title":"Feed story one"},{"title":"Feed story two"}]');
    await page.setContent(seeded);
    const cards = await page.$$eval('.hl .t', (els) => els.map((e) => e.textContent));
    assert.deepEqual(cards, ['Fire drill at 2pm', 'Feed story one', 'Feed story two']);
    assert.equal(await page.$eval('.hl.on .t', (e) => e.textContent), 'Fire drill at 2pm');
  } finally { await page.close(); }
});

test('nothing at all still says so', { skip: SKIP }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(renderWidgetHtml('rss', {}));
    assert.equal(await page.$eval('.msg', (e) => e.textContent), 'No feed chosen');
  } finally { await page.close(); }
});

test('saving a news widget cleans its messages (API)', async () => {
  const DATA_DIR = path.join(os.tmpdir(), 'st-ownmsg-' + crypto.randomBytes(4).toString('hex'));
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, 'server booted');
    const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `o${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Passw0rd123', name: 'o' }) })).json();
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const created = await (await fetch(BASE + '/api/widgets', { method: 'POST', headers: H,
      body: JSON.stringify({ widget_type: 'rss', name: 'Notices', config: { messages: [{ text: '  Lift   closed ', until: 1 }, { text: '' }] } }) })).json();
    assert.deepEqual(JSON.parse(created.config).messages, [{ text: 'Lift closed', until: 1 }], 'expired kept for the editor, blanks dropped');
    const put = await (await fetch(BASE + '/api/widgets/' + created.id, { method: 'PUT', headers: H,
      body: JSON.stringify({ config: { messages: Array.from({ length: 25 }, (_, i) => ({ text: 'n' + i })) } }) })).json();
    assert.equal(JSON.parse(put.config).messages.length, 20);
    const page = await (await fetch(BASE + '/api/widgets/' + created.id + '/render')).text();
    assert.equal(cfgOf(page).own.length, 20);
  } finally { proc.kill('SIGKILL'); fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
});
