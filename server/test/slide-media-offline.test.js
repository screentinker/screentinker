'use strict';

/*
 * Slide media offline, the pieces (the whole path runs in test/slide-media-offline-e2e.test.js).
 *
 * Until this existed a slide's photos and clips streamed from the server every time: the payload did
 * not list them, every player's offline cache skipped widget items, and the web player's slide frame
 * (an opaque origin) cannot be answered by the service worker or load a blob: URL the player made.
 * Driven in Chrome before choosing the design: the worker saw none of the frame's requests (loaded by
 * URL or as srcdoc), a parent blob: URL was refused ("Not allowed to load local resource"), and Blobs
 * handed over postMessage, turned into the frame's OWN blob: URLs, played.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const R = require('../lib/slide-render');
const { slideContentIds, slideMediaFor } = require('../lib/slide-media');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function memDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE content (id TEXT PRIMARY KEY, filepath TEXT, remote_url TEXT, mime_type TEXT, workspace_id TEXT, created_at INTEGER, updated_at INTEGER)');
  const ins = db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,?)');
  ins.run('photo', 'p.png', null, 'image/png', 'ws-a', 100, 0);
  ins.run('clip', 'c.webm', null, 'video/webm', 'ws-a', 100, 250);
  ins.run('bg', 'bg.jpg', null, 'image/jpeg', 'ws-a', 100, 0);
  ins.run('remote', null, 'https://cdn.example/x.jpg', 'image/jpeg', 'ws-a', 100, 0);
  ins.run('theirs', 't.png', null, 'image/png', 'ws-b', 100, 0);
  ins.run('platform', 'plat.png', null, 'image/png', null, 100, 0);
  return db;
}
const slide = (elements, extra = {}) => ({ template: { elements, ...extra }, fields: {} });
const el = (kind, id) => ({ kind, slot: kind + id, content_id: id, box: {} });

/* ---------------------------------------------------------------- what a slide references ---- */

test('the refs are what the renderer resolves: photo, lettering, video, background photo and video', () => {
  const ids = slideContentIds(slide([el('image', 'a'), el('lettering', 'b'), el('video', 'c'), el('head', 'not-media'), el('image', 'a')],
    { background_content_id: 'bg', background_video_content_id: 'bgv' }));
  // 'video' elements count once the kind exists in the renderer (normalizeSlide reads anything else as text).
  assert.deepEqual(ids, ['bg', 'bgv', 'a', 'b', ...(R.KINDS.video ? ['c'] : [])], 'deduplicated, text elements ignored');
  assert.deepEqual(slideContentIds('not json at all'), []);
  assert.deepEqual(slideContentIds(null), []);
});

test('slideMediaFor: the fields players cache by, with the revision a replace changes', () => {
  const db = memDb();
  const out = slideMediaFor(db, JSON.stringify(slide([el('image', 'photo'), el('video', 'clip')], { background_content_id: 'bg' })), 'ws-a');
  assert.deepEqual(out, [
    { content_id: 'bg', filepath: 'bg.jpg', content_rev: 100, mime_type: 'image/jpeg' },
    { content_id: 'photo', filepath: 'p.png', content_rev: 100, mime_type: 'image/png' },
    ...(R.KINDS.video ? [{ content_id: 'clip', filepath: 'c.webm', content_rev: 250, mime_type: 'video/webm' }] : []),
  ]);
  // The revision a replace changes (updated_at), falling back to created_at for an untouched row.
  const bgv = slideMediaFor(db, slide([], { background_video_content_id: 'clip' }), 'ws-a');
  assert.deepEqual(bgv, [{ content_id: 'clip', filepath: 'c.webm', content_rev: 250, mime_type: 'video/webm' }]);
});

test('⚠️ slideMediaFor holds the renderer\'s workspace rule: never another tenant\'s file', () => {
  const db = memDb();
  const cfg = slide([el('image', 'photo'), el('image', 'theirs'), el('image', 'platform')]);
  assert.deepEqual(slideMediaFor(db, cfg, 'ws-a').map((m) => m.content_id), ['photo']);
  assert.deepEqual(slideMediaFor(db, cfg, null).map((m) => m.content_id), ['platform'], 'a platform template sees platform content only');
});

test('remote content is listed with its URL (the player fetches it itself; nothing to pin)', () => {
  const out = slideMediaFor(memDb(), slide([el('image', 'remote')]), 'ws-a');
  assert.equal(out.length, 1);
  assert.equal(out[0].remote_url, 'https://cdn.example/x.jpg');
});

/* ---------------------------------------------------------------- the payload ---------------- */

test('refreshWidgetRevs stamps widget_media on slide items, live, and strips it from anything else', () => {
  const src = read('ws/deviceSocket.js');
  const fn = src.slice(src.indexOf('function refreshWidgetRevs('), src.indexOf('\n}\n', src.indexOf('function refreshWidgetRevs(')));
  assert.match(fn, /if \(facts\.widget_type === 'slide'\) a\.widget_media = require\('\.\.\/lib\/slide-media'\)\.slideMediaFor\(db, facts\.config, facts\.workspace_id\);/);
  assert.match(fn, /else if \(a\.widget_media\) delete a\.widget_media;/);
});

test('the site cache manifest includes a slide\'s media, so the LAN box mirrors it too', () => {
  const { contentIdsInPayload } = require('../lib/site-cache/origin');
  const ids = contentIdsInPayload({ assignments: [
    { content_id: 'v1' },
    { widget_id: 'w1', widget_media: [{ content_id: 'photo', filepath: 'p.png' }, { content_id: 'remote', remote_url: 'https://x' }] },
  ] });
  assert.deepEqual([...ids].sort(), ['photo', 'v1']);
});

/* ---------------------------------------------------------------- the slide page ------------- */

const render = (template, resolve) => R.renderSlideHtml({ template, fields: {} }, { resolveImage: resolve || ((id) => `/uploads/content/${id}.bin`) });
const mediaScript = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('st-slide-media'));

test('local media is marked with its content id; remote media is not (it cannot be cached)', () => {
  const html = render({ background_content_id: 'bg', elements: [el('image', 'p'), el('lettering', 'l'), el('image', 'r')] },
    (id) => (id === 'r' ? 'https://cdn/x.png' : `/uploads/content/${id}.png`));
  assert.match(html, /<div class="bg" data-st-cid="bg" style=/);
  assert.match(html, /<img data-st-cid="p" src="\/uploads\/content\/p\.png"/);
  assert.match(html, /<img class="fit" data-st-cid="l" src=/);
  assert.match(html, /<img src="https:\/\/cdn\/x\.png"/);
  assert.match(render({ elements: [el('video', 'clip')] }), /<video data-st-cid="clip" autoplay muted loop/, 'a video element too');
  const bgv = render({ background_video_content_id: 'v', elements: [] });
  assert.match(bgv, /<video class="bg" data-st-cid="v" autoplay muted loop/);
});

test('the request script ships only when something is marked', () => {
  assert.ok(mediaScript(render({ elements: [el('image', 'p')] })));
  assert.equal(mediaScript(render({ elements: [{ kind: 'head', slot: 'h', box: {} }] })), undefined);
  assert.equal(mediaScript(render({ elements: [el('image', 'r')] }, () => 'https://cdn/x.png')), undefined);
});

test('⚠️ the request script PARSES, and is ES5 (old Android WebViews render slides too)', () => {
  // A lost backslash once turned its regex into a syntax error: the script silently did nothing and
  // every offline slide stayed blank. Parse the script exactly as it is served.
  const s = mediaScript(render({ elements: [el('image', 'p')] }));
  assert.doesNotThrow(() => new vm.Script(s), 'the served script must parse');
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(s), 'no arrows, let/const or template literals');
});

test('the script swaps only what has not loaded, only on a reply from its parent', () => {
  // Run it against a fake frame: one photo that failed, one that loaded, a video with no data yet.
  const s = mediaScript(render({ elements: [el('image', 'gone'), el('image', 'ok'), el('video', 'v')] }));
  const mk = (tag, cid, state) => ({ tagName: tag, src: '/uploads/content/' + cid, style: {}, getAttribute: () => cid, ...state });
  const els = [mk('IMG', 'gone', { complete: true, naturalWidth: 0 }), mk('IMG', 'ok', { complete: true, naturalWidth: 64 }),
    mk('VIDEO', 'v', { readyState: 0, play: () => ({ catch() {} }) })];
  let listener; const posted = [];
  const parent = { postMessage: (m) => posted.push(m) };
  const win = { parent, postMessage() {}, addEventListener: (t, fn) => { if (t === 'message') listener = fn; } };
  const timers = [];
  vm.runInNewContext(s, {
    window: win, document: { querySelectorAll: () => els }, URL: { createObjectURL: (b) => 'blob:' + b.name },
    Image: function () { return { complete: false, naturalWidth: 0 }; }, setTimeout: (f, ms) => timers.push(ms),
  });
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'st-slide-media', ids: ['gone', 'v'] }, 'asks only for what is missing');
  assert.deepEqual([...timers], [1500], 'and will ask again');

  listener({ source: { not: 'parent' }, data: { type: 'st-slide-media-reply', files: { gone: { name: 'x' } } } });
  assert.equal(els[0].src, '/uploads/content/gone', 'a reply from anyone but the parent is ignored');

  listener({ source: parent, data: { type: 'st-slide-media-reply', files: { gone: { name: 'g' }, ok: { name: 'o' }, v: { name: 'vv' } } } });
  assert.equal(els[0].src, 'blob:g', 'the failed photo is swapped');
  assert.equal(els[1].src, '/uploads/content/ok', 'a photo that loaded from the network is left alone');
  assert.equal(els[2].src, 'blob:vv', 'the video with no data is swapped');
});

test('a top-level slide (Android, native: they serve the URLs from their own caches) asks nobody', () => {
  const s = mediaScript(render({ elements: [el('image', 'p')] }));
  const win = { postMessage() {}, addEventListener() { throw new Error('listened'); } };
  win.parent = win;
  assert.doesNotThrow(() => vm.runInNewContext(s, { window: win, document: { querySelectorAll() { throw new Error('queried'); } } }));
});

test('⚠️ the render epoch moved, so screens holding the old slide page fetch the new one', () => {
  assert.ok(require('../lib/widget-render-epoch') >= 3);
});

/* ---------------------------------------------------------------- the web player ------------- */

test('the worker answers X-ST-Cache-Only with a quick 504 on a miss, never a download', () => {
  const sw = read('player/sw.js');
  const h = sw.slice(sw.indexOf('async function handleContent('));
  const miss = h.indexOf("if (request.headers.get('x-st-cache-only')) return new Response(null, { status: 504");
  assert.ok(miss > 0, 'the cache-only branch exists');
  assert.ok(miss < h.indexOf('siteCacheFetch(') && miss < h.indexOf('await fetch(request)'), 'before the site cache and the network');
  assert.ok(miss > h.indexOf('respondFromBlob(cached'), 'after a hit is served');
});

test('the player pins widget_media, indexes it at a cold start, and answers only its own frames', () => {
  const p = read('player/index.html');
  assert.match(p, /const slideMedia = indexSlideMedia\(all\);\s*const urls = all\.concat\(slideMedia\)/);
  assert.match(p, /playlist = cachedPlaylist;\s*try \{ indexSlideMedia\(cachedPlaylist\); \}/);
  assert.match(p, /var slideMediaIndex = new Map\(\);/, 'var, not let: no TDZ on a boot path');
  const h = p.slice(p.indexOf("if (!d || d.type !== 'st-slide-media'"));
  assert.match(h, /f\.contentWindow === ev\.source/, 'a frame this page mounted');
  assert.match(p, /fetch\(mediaUrl\(m\), \{ headers: \{ 'X-ST-Cache-Only': '1' \}/);
  // And each slide's page is warmed with the iframe's exact URL.
  assert.match(p, /it\.widget_type !== 'slide'[\s\S]{0,200}\/api\/widgets\/\$\{it\.widget_id\}\/render\?device=\$\{encodeURIComponent\(config\.deviceId\|\|''\)\}&rev=\$\{it\.widget_rev\|\|0\}/);
  // legacy.html is a build of index.html: it must carry the same handler.
  assert.ok(read('player/legacy.html').includes('st-slide-media-reply'));
});
