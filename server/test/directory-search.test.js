'use strict';

// directory-search widget: references a directory-board by id and renders an
// interactive walk-up search page. Verifies the source board's entries are
// safely inlined for client-side filtering, that a missing/wrong source shows a
// friendly fallback (not a 500), and that entry/category text can't break out
// of the inlined <script> (it's set via textContent at runtime).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-dirsearch';

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
const fetchRender = async (id) => { const r = await fetch(`${base}/api/widgets/${id}/render`); return { status: r.status, html: await r.text() }; };

const BOARD = {
  title: 'Lincoln Warehouse',
  categories: [
    { name: 'First Floor', entries: [
      { identifier: '101', name: 'Acme Co', subtitle: 'Suite A', available: false },
      { identifier: '102', name: 'Available Unit', subtitle: '', available: true },
    ] },
    { name: 'Second Floor', entries: [
      { identifier: '201', name: 'Globex', subtitle: 'Logistics', available: false },
    ] },
  ],
};

test('directory-search renders a search page and inlines the source board entries', async () => {
  seed('board1', 'directory-board', BOARD);
  seed('search1', 'directory-search', { source_widget_id: 'board1', title: 'Find a Tenant', show_onscreen_keyboard: true });
  const { status, html } = await fetchRender('search1');
  assert.equal(status, 200);
  assert.ok(html.includes('id="q"'), 'has a search input');
  assert.ok(html.includes('id="results"'), 'has a results container');
  assert.ok(html.includes('Acme Co') && html.includes('Globex') && html.includes('101'), 'source entries embedded for client-side filtering');
  assert.ok(html.includes('Find a Tenant'), 'search title present');
});

test('show_onscreen_keyboard flag is carried into the page config', async () => {
  seed('search_kb_off', 'directory-search', { source_widget_id: 'board1', show_onscreen_keyboard: false });
  const { html } = await fetchRender('search_kb_off');
  assert.ok(html.includes('"show_onscreen_keyboard":false'), 'keyboard flag inlined (page hides the keyboard when false)');
});

test('the built-in keyboard suppresses the platform one', async () => {
  // The page autofocuses a real <input>, which on Android raises the system IME over the
  // bottom of the screen - covering the keyboard this widget draws itself. A panel showed
  // Gboard, complete with a mic key, and never showed its own keyboard.
  seed('search_kb_on', 'directory-search', { source_widget_id: 'board1', show_onscreen_keyboard: true });
  const { html } = await fetchRender('search_kb_on');
  assert.ok(/setAttribute\(\s*'inputmode'\s*,\s*'none'\s*\)/.test(html),
    'page tells the platform not to raise its own keyboard');

  // Only when we are drawing one. With the built-in keyboard off there is nothing to cover,
  // and the platform keyboard is the only way left to type.
  seed('search_kb_off2', 'directory-search', { source_widget_id: 'board1', show_onscreen_keyboard: false });
  const off = await fetchRender('search_kb_off2');
  assert.ok(off.html.includes('"show_onscreen_keyboard":false'), 'flag inlined as false');
  assert.ok(!/inputmode="none"/.test(off.html),
    'the input is not statically marked inputmode=none - suppression is gated on the flag at runtime');
});

test('missing source -> friendly fallback page, not a 500', async () => {
  seed('search_missing', 'directory-search', { source_widget_id: 'does-not-exist' });
  const { status, html } = await fetchRender('search_missing');
  assert.equal(status, 200);
  assert.ok(html.includes('Directory source not found'), 'friendly message shown instead of an error');
});

test('non-directory-board source -> friendly fallback page', async () => {
  seed('clockX', 'clock', {});
  seed('search_wrongtype', 'directory-search', { source_widget_id: 'clockX' });
  const { status, html } = await fetchRender('search_wrongtype');
  assert.equal(status, 200);
  assert.ok(html.includes('Directory source not found'), 'friendly message for a wrong source type');
});

test('XSS: entry/category text cannot break out of the inlined script', async () => {
  seed('board_xss', 'directory-board', {
    categories: [{
      name: '</script><script>window.__pwned=1</script>',
      entries: [{ identifier: '<img src=x onerror=alert(1)>', name: '"><b>bold</b>', subtitle: 'amp & lt < gt >', available: false }],
    }],
  });
  seed('search_xss', 'directory-search', { source_widget_id: 'board_xss' });
  const { status, html } = await fetchRender('search_xss');
  assert.equal(status, 200);
  assert.ok(!html.includes('</script><script>window.__pwned'), 'raw </script> breakout neutralized');
  assert.ok(html.includes('\\u003c/script>'), 'angle brackets escaped in the inlined JSON blob');
});

// ---- live sync: GET /:id/data.json feed the search page polls ----
const fetchData = async (id) => fetch(`${base}/api/widgets/${id}/data.json`);

test('data.json returns the source board categories, CORS-open for polling', async () => {
  const r = await fetchData('board1'); // seeded in the first test
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'readable from a null-origin sandboxed iframe');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.ok(Array.isArray(body.categories) && body.categories.length === 2, 'returns the categories array');
  assert.equal(body.categories[0].entries[0].name, 'Acme Co');
});

test('data.json 404s for a missing widget (poll keeps last-good data)', async () => {
  assert.equal((await fetchData('does-not-exist')).status, 404);
});

test('data.json 404s for a non-directory-board widget', async () => {
  assert.equal((await fetchData('clockX')).status, 404); // clockX seeded earlier
});

test('search page wires the live-sync poll to its source board', async () => {
  const { html } = await fetchRender('search1');
  assert.ok(html.includes('"source_widget_id":"board1"'), 'source board id inlined into the page');
  assert.ok(html.includes('/data.json'), 'page polls the data.json feed');
});

// The on-screen keyboard must be sized against the VIEWPORT, not in fixed px. A panel's CSS
// viewport is its resolution over its density, so a 1080p screen at 240dpi presents 1280x720 CSS
// px — where a keyboard laid out for 1920x1080 ate ~37% of the height instead of ~24%. The clamp()
// maxima are the ORIGINAL fixed values, so a 1080-tall viewport must stay pixel-identical.
test('the on-screen keyboard scales with the viewport instead of using fixed pixels', async () => {
  const bid = 'kb-board', sid = 'kb-search';
  seed(bid, 'directory-board', BOARD);
  seed(sid, 'directory-search', { source_widget_id: bid });
  const { status, html } = await fetchRender(sid);
  assert.equal(status, 200);

  /*
   * ⚠️ ASSERT THE RESOLVED SIZE, NOT `clamp()`.
   *
   * This used to require the literal `height:clamp(` in the .key rule. `clamp()` is Chromium 79,
   * so a webOS 4 panel (Chromium 53) cannot parse it and the keyboard fell back to whatever the
   * cascade left — which is the bug this test exists to prevent, on the panels least able to
   * report it. The same bounded scaling now comes from a media-query ladder: a px ceiling in the
   * base rule, a vh band in the middle, a px floor at the bottom.
   *
   * That ladder reproduces clamp(34px, 5.3vh, 56px) to within 0.45px anywhere between 200 and
   * 2600px of viewport height, and EXACTLY at the two heights this test was written for.
   * So the test resolves the cascade itself and checks the behaviour, which holds for clamp()
   * and for the ladder. Re-pinning the function name would silently break webOS 4 again.
   */
  const css = html.match(/<style[\s\S]*?<\/style>/g).join('\n');

  // Effective `.key` px value at a given viewport height: base rule first, then every
  // max-height block that still matches, in source order (later wins, as the cascade does).
  const effective = (prop, viewportH) => {
    const media = [...css.matchAll(/@media\s*\(max-height:\s*(\d+)px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    const mediaBodies = new Set(media.map((m) => m[2]));
    const base = [...css.matchAll(/\.key\s*\{([^}]*)\}/g)]
      .filter((m) => ![...mediaBodies].some((b) => b.includes(m[0])));
    const decls = [];
    for (const m of base) decls.push(m[1]);
    for (const [, capStr, body] of media) {
      if (viewportH > Number(capStr)) continue;
      const inner = body.match(/\.key\s*\{([^}]*)\}/);
      if (inner) decls.push(inner[1]);
    }
    let value = null;
    for (const d of decls) {
      const m = d.match(new RegExp(prop + ':\\s*([^;]+)'));
      if (m) value = m[1].trim();
    }
    assert.ok(value, `${prop} is declared for .key`);
    const clamp = value.match(/^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vh\s*,\s*([\d.]+)px\s*\)$/);
    if (clamp) {
      const [, lo, vh, hi] = clamp.map(Number);
      return Math.max(lo, Math.min(vh * viewportH / 100, hi));
    }
    if (/vh$/.test(value)) return parseFloat(value) * viewportH / 100;
    if (/px$/.test(value)) return parseFloat(value);
    assert.fail(`${prop} resolved to an unexpected unit: ${value}`);
  };

  // 1080-tall panels must be pixel-identical to before any of this existed.
  assert.equal(effective('height', 1080), 56, 'a 1080-tall viewport still renders 56px keys');
  assert.equal(effective('font-size', 1080), 24, 'a 1080-tall viewport still renders 24px key text');

  // The bug: a 1280x720 CSS viewport (1080p at 240dpi) had the keyboard eating ~37% of the height.
  assert.ok(effective('height', 720) < 56, 'a 720-tall viewport scales the keys down');
  assert.ok(Math.abs(effective('height', 720) - 38.16) < 1, 'and scales them to about 38px, not to the floor');

  // Bounded at both ends: tappable when very short, and it never grows past the ceiling.
  assert.ok(effective('height', 400) >= 30, 'keys stay tappable on a very short viewport');
  assert.equal(effective('height', 2160), 56, 'and never exceed the ceiling on a tall one');
});

test('a multi-column directory board keeps its gutters', async () => {
  /*
   * Regression guard. The Chrome 53 CSS sweep removed `gap:14px 36px` from `.entries` along with
   * every other `gap:`, and reconstructed only the ROW half as `.entry { margin-bottom }`. The
   * 36px COLUMN gutter had no replacement, so every 2/3/4-column and auto-fit board rendered with
   * its columns touching — on modern panels, not just the old ones the sweep was for.
   *
   * The removal also bought nothing: `display:grid` is Chromium 57, so on a Chrome 53 panel this
   * element is an inert block and the gap could never have applied there anyway.
   */
  const bid = 'cols-board', sid = 'cols-search';
  seed(bid, 'directory-board', BOARD);
  seed(sid, 'directory-search', { source_widget_id: bid });
  // the grid lives in the BOARD renderer, not the search keyboard page
  const { html } = await fetchRender(bid);
  const entries = html.match(/\.entries\s*\{[^}]*\}/);
  assert.ok(entries, '.entries rule is present');
  assert.match(entries[0], /gap:\s*[\d.]+px\s+[\d.]+px/,
    '.entries keeps a row AND column gutter — grid is Chromium 57, so this never reached a Chrome 53 panel');
  assert.match(html, /\.entries\[data-cols="[234]"\]/, 'and multi-column layouts still exist to need it');
});

test('the narrow breakpoint no longer pins the key size back to fixed pixels', async () => {
  const bid = 'kb2-board', sid = 'kb2-search';
  seed(bid, 'directory-board', BOARD);
  seed(sid, 'directory-search', { source_widget_id: bid });
  const { html } = await fetchRender(sid);
  const mq = html.match(/@media \(max-width:700px\)\s*\{[^}]*\}[^}]*\}/s);
  assert.ok(mq, 'the narrow breakpoint still exists');
  assert.ok(!/\.key\s*\{[^}]*height:\s*\d+px/.test(mq[0]),
    'the breakpoint must not re-pin .key to a fixed height and undo the clamp');
});
