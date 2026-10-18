'use strict';

/*
 * #660: web content is see-through unless a background colour was chosen.
 *
 * Two kinds of black covered whatever sat behind a widget:
 *  - the web player gave its full-screen widget and bundle iframes a #000 background "while they
 *    load" and never took it off, so a transparent widget was black full screen only;
 *  - RSS, cloud document and BI dashboard pages defaulted to black, and the dashboard's colour
 *    picker could not say "no colour", so it saved #000000 for clock and text too on first save.
 * A colour that was chosen is kept exactly as before.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const { backgroundColor } = require('../lib/safe-color');
const { renderWidgetHtml } = require('../routes/widgets');
const cloudDocs = require('../lib/cloud-docs');
const biWidget = require('../lib/bi/widget');

test('#660: backgroundColor is transparent unless a hex colour was chosen', () => {
  for (const v of [undefined, null, '', 'transparent', 'TRANSPARENT', 'red', '#12', 'red}</style>', 42]) {
    assert.equal(backgroundColor(v), 'transparent', `value ${JSON.stringify(v)}`);
  }
  assert.equal(backgroundColor('#112233'), '#112233');
  assert.equal(backgroundColor('#ABC'), '#abc');
  assert.equal(backgroundColor(' #000000 '), '#000000', 'a chosen black is still black');
});

test('#660: an RSS widget with no colour is see-through; a chosen colour is kept', () => {
  assert.match(renderWidgetHtml('rss', { url: 'https://example.com/feed' }), /body \{ background:transparent;/);
  assert.match(renderWidgetHtml('rss', { url: 'https://example.com/feed', background: '#123456' }), /body \{ background:#123456;/);
});

test('#660: clock and text stay see-through by default, and accept "transparent" as saved', () => {
  for (const type of ['clock', 'text']) {
    assert.match(renderWidgetHtml(type, {}), /background:transparent/, `${type} default`);
    assert.match(renderWidgetHtml(type, { background: 'transparent' }), /background:transparent/, `${type} saved as transparent`);
  }
});

test('#660: a cloud document with no colour is see-through; a chosen colour is kept', () => {
  const url = 'https://docs.google.com/presentation/d/e/2PACX-1vSomePublishedId_abcdEFGH/pub';
  assert.match(cloudDocs.renderCloudDoc({ url }), /html,body\{height:100%;overflow:hidden;background:transparent\}/);
  assert.match(cloudDocs.renderCloudDoc({ url, background: '#ffffff' }), /background:#ffffff\}/);
  assert.match(cloudDocs.renderCloudDoc({ url, background: 'transparent' }), /background:transparent\}/);
});

test('#660: a BI dashboard with no colour is see-through; a chosen colour is kept', () => {
  const pub = { provider: 'tableau', mode: 'public', public_url: 'https://public.tableau.com/views/Book/Sheet1' };
  assert.equal(biWidget.normaliseConfig(null, 'org1', pub).background, 'transparent');
  assert.equal(biWidget.normaliseConfig(null, 'org1', { ...pub, background: 'transparent' }).background, 'transparent');
  assert.equal(biWidget.normaliseConfig(null, 'org1', { ...pub, background: '#0a0b0c' }).background, '#0a0b0c');
  // The "choose a dashboard" message page is drawn on the same background.
  const { html } = biWidget.render(null, { id: 'w1' }, { provider: 'nope' });
  assert.match(html, /html,body\{margin:0;height:100%;overflow:hidden;background:transparent\}/);
});

test('#660: the web player gives full-screen widget and bundle frames no background of their own', () => {
  for (const file of ['index.html', 'legacy.html']) {
    const src = read('server', 'player', file);
    for (const fn of ['renderWidgetBuffered', 'renderBundleBuffered']) {
      const at = src.indexOf(`function ${fn}(`);
      assert.ok(at > 0, `${file}: ${fn} not found -- did it move?`);
      const body = src.slice(at, src.indexOf('const reveal', at));
      assert.ok(body.includes('iframe'), `${file}: ${fn} still builds an iframe`);
      assert.doesNotMatch(body, /iframe\.style\.background\s*=/, `${file}: ${fn} must not paint the frame`);
    }
  }
});

test('#660: YouTube letterboxes show the background behind them, on web, Android and native', () => {
  for (const file of ['index.html', 'legacy.html']) {
    const src = read('server', 'player', file);
    const at = src.indexOf('function createYoutubeEmbed(');
    assert.ok(at > 0, `${file}: createYoutubeEmbed not found`);
    const body = src.slice(at, at + 4000);
    assert.doesNotMatch(body, /background:#000/, `${file}: the YouTube wrapper is not black`);
  }
  const android = read('android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'util', 'WebViewSupport.kt');
  const native = read('native', 'screentinker_native', 'player', 'engine.py');
  for (const [name, src] of [['Android', android], ['native', native]]) {
    assert.equal((src.match(/html,body\{margin:0;padding:0;height:100%;background:transparent;overflow:hidden/g) || []).length, 2,
      `${name}: both YouTube wrappers (landscape and vertical) are see-through`);
  }
  const mpm = read('android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'player', 'MediaPlayerManager.kt');
  assert.doesNotMatch(mpm, /youtubeWebView\?\.apply \{[^}]*setBackgroundColor\(android\.graphics\.Color\.BLACK\)/,
    'the full-screen YouTube WebView is not painted black over the transparent page');
});

test('#660: the dashboard can save "transparent" instead of a colour picker\'s #000000', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const m = await import(pathToFileURL(path.join(ROOT, 'frontend', 'js', 'components', 'background-field.js')).href);

  for (const v of [undefined, null, '', 'transparent']) assert.equal(m.isTransparentBg(v), true, `${JSON.stringify(v)} is transparent`);
  assert.equal(m.isTransparentBg('#000000'), false, 'a saved black is a choice, kept as black');

  const unset = m.backgroundField('wBg', undefined);
  assert.match(unset, /id="wBgClear" data-bg-clear="wBg" checked/, 'a widget with no colour opens with Transparent ticked');
  assert.match(unset, /type="color" id="wBg" value="#000000"[^>]* disabled/, 'and the picker off');
  const black = m.backgroundField('wBg', '#000000');
  assert.doesNotMatch(black, /checked/, 'a chosen black opens with Transparent unticked');
  assert.doesNotMatch(m.backgroundField('wBg', '"><script>'), /<script>/, 'a stored value cannot break out of the markup');

  const root = (checked, value) => ({ querySelector: (sel) => (sel === '#wBgClear' ? { checked } : sel === '#wBg' ? { value } : null) });
  assert.equal(m.readBackground('wBg', root(true, '#123456')), 'transparent');
  assert.equal(m.readBackground('wBg', root(false, '#123456')), '#123456');

  // The dashboard's CSP is script-src 'self': an inline handler on the checkbox would never run.
  assert.doesNotMatch(read('frontend', 'js', 'components', 'background-field.js'), /\son[a-z]+="/);
  for (const f of [['views', 'widgets.js'], ['components', 'bi-dashboard-editor.js']]) {
    const src = read('frontend', 'js', ...f);
    assert.doesNotMatch(src, /type="color" id="(wBg|biBg)"/, `${f.join('/')} uses backgroundField, not a bare picker`);
    assert.doesNotMatch(src, /background: (val|v)\('(wBg|biBg)'\)/, `${f.join('/')} saves through readBackground`);
  }
});
