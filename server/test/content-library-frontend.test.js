'use strict';

// The Content Library page's frontend rules, without a browser: the pure helpers are evaluated from
// the real module sources (imports stripped, the few they use stubbed), and the page-level rules are
// checked against the source, as the other dashboard guards do.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Run an ES module's source as a script: imports dropped, `export` keywords removed. */
function load(file, names, ctx = {}) {
  const src = read(file)
    .replace(/^import [\s\S]*?from '[^']+';\n/gm, '')
    .replace(/^export (const|function|async function|let) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '');
  const box = { module: {}, URL, console, ...ctx };
  vm.runInNewContext(`${src}\nmodule.exports = { ${names.join(', ')} };`, box);
  return box.module.exports;
}
const plain = (v) => JSON.parse(JSON.stringify(v));   // objects made in the vm realm
const tStub = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);

const add = load('components/library/add-content.js', ['youtubeId', 'liveKind', 'detectMediaType', 'treeOrder', 'UPLOAD_ACCEPT'], { t: tStub, esc: String });
const meta = load('components/library/content-meta.js', ['typeOf', 'statusOf', 'usageText', 'thumbOf', 'durationOf', 'dimensionsOf', 'formatDuration', 'isStoredFile'], { t: tStub });

test('YouTube: the form accepts exactly what the server accepts', () => {
  // routes/content.js extractYoutubeId, copied from the source so a change there fails here.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8');
  const body = route.slice(route.indexOf('function extractYoutubeId'), route.indexOf('\n}\n', route.indexOf('function extractYoutubeId')) + 2);
  const server = vm.runInNewContext(`${body}; extractYoutubeId`);
  const cases = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/abcdefghijk',
    'https://www.youtube.com/embed/abcdefghijk?start=3', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://vimeo.com/123', 'https://www.youtube.com/live/abcdefghijk', 'not a link', ''];
  for (const c of cases) assert.equal(add.youtubeId(c), server(c), c);
});

test('live stream: the inline check never refuses what the server accepts, nor the reverse', () => {
  const { classifyLiveUrl } = require('../lib/remote-url');
  const cases = ['http://10.0.0.5/live/stream.m3u8', 'https://cdn.example.com/a/index.m3u8?token=x', 'https://cdn.example.com/hls/channel1',
    'rtsp://user:pass@192.168.1.20:554/stream1', 'rtsp://cam.local/s', 'https://user:pw@cdn.example.com/x.m3u8',
    'https://example.com/video.mp4', 'ftp://x/y.m3u8', 'hello'];
  for (const c of cases) {
    const ok = !classifyLiveUrl(c).error;
    assert.equal(!!add.liveKind(c), ok, c);
  }
});

test('media URL: the type is detected from the extension, and only when the link says', () => {
  assert.equal(add.detectMediaType('https://example.com/a/b/Promo.MP4?x=1'), 'video/mp4');
  assert.equal(add.detectMediaType('https://example.com/poster.webp'), 'image/webp');
  assert.equal(add.detectMediaType('https://example.com/track.mp3'), 'audio/mpeg');
  assert.equal(add.detectMediaType('https://example.com/download?id=7'), null, 'no extension: the user is asked');
  assert.equal(add.detectMediaType('nonsense'), null);
});

test('the uploader is offered exactly what it takes: media, bundles and PDFs', () => {
  assert.equal(add.UPLOAD_ACCEPT, 'video/*,image/*,audio/*,.zip,.wgt,.pdf,application/pdf');
  const lib = read('views/content-library.js');
  assert.equal(lib.match(/id="fileInput"[^>]*accept="([^"]+)"/)[1], add.UPLOAD_ACCEPT, 'the page and the modal agree');
});

test('folders are listed in tree order with their depth, siblings by name', () => {
  const f = (id, name, parent_id = null) => ({ id, name, parent_id });
  const out = add.treeOrder([f('c', 'Campaigns'), f('l', 'Lobby'), f('a', 'Autumn 2026', 'c'), f('b', 'brand'), f('s', 'Spring', 'c'), f('x', 'Orphan', 'gone')]);
  assert.deepEqual(plain(out.map((o) => [o.name, o.depth])), [['brand', 0], ['Campaigns', 0], ['Autumn 2026', 1], ['Spring', 1], ['Lobby', 0], ['Orphan', 0]]);
});

test('status is a real state of the row; expired wins, then a failing sync, then a pending draft', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(meta.statusOf({ is_active: 1 }).key, 'ready');
  assert.equal(meta.statusOf({ is_active: 1, has_draft: true }).key, 'review');
  assert.equal(meta.statusOf({ is_active: 1, has_draft: true, sync_problem: true }).key, 'attention');
  assert.equal(meta.statusOf({ is_active: 1, sync_problem: true, expires_at: now - 5 }).key, 'expired');
  assert.equal(meta.statusOf({ is_active: 0 }).key, 'expired');
  assert.equal(meta.statusOf({ is_active: 1 }).tone, 'ok');
});

test('"Unused" only when nothing references the item; otherwise the real playlist count', () => {
  assert.equal(meta.usageText({ usage: { playlists: 0, in_use: false } }), 'library.usage.unused');
  assert.equal(meta.usageText({ usage: { playlists: 0, in_use: true } }), 'library.usage.elsewhere', 'on a wall, not in a playlist: never "Unused"');
  assert.equal(meta.usageText({ usage: { playlists: 3, in_use: true } }), 'library.usage.playlists_other:{"count":3}');
  assert.equal(meta.usageText({ usage: { playlists: 1, in_use: true } }), 'library.usage.playlists_one:{"count":1}');
  assert.equal(meta.usageText({}), '', 'no usage data (an older remote node): say nothing');
});

test('no fake metadata: streams, inputs and holds have no duration, no file, and no <img>', () => {
  const hdmi = { id: 'h', mime_type: 'video/hdmi-in', remote_url: 'hdmi://1', duration_sec: 10 };
  const hls = { id: 's', mime_type: 'video/hls', remote_url: 'http://x/a.m3u8' };
  const hold = { id: 'o', mime_type: 'application/x-st-hold', remote_url: 'hold://freeze', duration_sec: 5 };
  for (const c of [hdmi, hls, hold]) {
    assert.equal(meta.thumbOf(c), null, c.mime_type);
    assert.equal(meta.durationOf(c), '', c.mime_type);
    assert.equal(meta.isStoredFile(c), false, c.mime_type);
  }
  assert.equal(meta.thumbOf({ id: 'r', mime_type: 'image/jpeg', remote_url: 'http://plain.example/a.jpg' }), null, 'an http image would be blocked by the CSP');
  assert.deepEqual(plain(meta.thumbOf({ id: 'v', mime_type: 'video/mp4', filepath: 'v.mp4', thumbnail_path: 't.jpg' })), { src: '/api/content/v/thumbnail', auth: true });
  assert.equal(meta.formatDuration(30), '00:30');
  assert.equal(meta.formatDuration(3725), '1:02:05');
  assert.equal(meta.durationOf({ mime_type: 'video/mp4', duration_sec: 222 }), '03:42');
  assert.equal(meta.dimensionsOf({ width: 1920, height: 1080 }), '1920 × 1080');
});

test('the inspector names every kind of reference the server reports', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'content-library.js'), 'utf8');
  const kinds = [...lib.slice(lib.indexOf('const elsewhere = {'), lib.indexOf('};', lib.indexOf('const elsewhere = {'))).matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(kinds.sort(), ['corporate', 'schedules', 'screens', 'slides', 'walls', 'widgets']);
  const en = read('i18n/en.js');
  for (const k of kinds) assert.ok(en.includes(`'library.inspector.elsewhere_${k}'`), k);
});

/* ---------------- the upload queue, with the uploader stubbed ---------------- */

function fakeDom() {
  const byId = new Map();
  const el = () => ({
    _html: '', className: '', id: '', dataset: {}, children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    setAttribute() {}, addEventListener() {}, remove() { byId.delete(this.id); },
    querySelector() { return null; }, contains() { return false },
  });
  const body = { appendChild(e) { byId.set(e.id, e); }, children: [] };
  return { document: { getElementById: (id) => byId.get(id) || null, createElement: el, body, activeElement: null }, byId };
}

test('upload queue: a failed file is that file’s problem — the rest still upload, into the destination', async () => {
  const calls = [];
  const { document } = fakeDom();
  const q = load('components/library/upload-queue.js', ['enqueue', 'onUploaded', 'activeCount', 'setPdfImporter'], {
    document, t: tStub, esc: String, setTimeout, clearTimeout, AbortController,
    isPdf: (f) => /\.pdf$/.test(f.name),
    confirmDialog: async () => true,
    uploadFileResumable: async (file, o) => {
      calls.push([file.name, o.folderId]);
      o.onProgress(file.size / 2, file.size);
      o.onProgress(file.size, file.size);   // every byte sent: processing
      if (file.name === 'bad.png') throw new Error('Unsupported file type');
      return { id: 'id-' + file.name };
    },
  });
  const done = [];
  q.onUploaded(({ created }) => done.push(created.id));
  q.enqueue([{ name: 'a.png', size: 10 }, { name: 'bad.png', size: 10 }, { name: 'c.mp4', size: 10 }], { folderId: 'f1', folderLabel: 'Lobby' });
  for (let i = 0; i < 50 && q.activeCount(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => c[0]), ['a.png', 'bad.png', 'c.mp4'], 'one at a time, in order, none skipped');
  assert.ok(calls.every((c) => c[1] === 'f1'), 'every file goes to the destination');
  assert.deepEqual(done, ['id-a.png', 'id-c.mp4']);
});

test('upload queue: "processing" is a state of its own, between the last byte and the new row', () => {
  const src = read('components/library/upload-queue.js');
  assert.match(src, /if \(total && sent >= total\) it\.state = 'processing'/);
  assert.match(src, /uploadFileResumable\(it\.file/, 'per file, not uploadFilesResumable (which stops at the first failure)');
  assert.doesNotMatch(src, /import \{[^}]*uploadFilesResumable|await uploadFilesResumable\(/);
});

/* ---------------- page rules, from the source ---------------- */

test('cards and rows carry no Edit or red Delete button: those live in the overflow menu', () => {
  const lib = read('views/content-library.js');
  const cards = lib.slice(lib.indexOf('function gridHtml()'), lib.indexOf('function wireResults('));
  assert.doesNotMatch(cards, /btn-danger|data-delete-content|data-edit-content/);
  assert.match(cards, /\$\{moreBtn\(c\)\}/, 'an overflow menu per card');
  assert.match(cards, /<td class="lib-col-actions">\$\{moreBtn\(c\)\}/, 'and per row');
  assert.match(lib, /const moreBtn = [^\n]*aria-haspopup="menu" aria-expanded="false" aria-label="\$\{esc\(t\('library\.actions_for'/);
  assert.match(lib, /const checkbox = [^\n]*aria-label="\$\{esc\(t\('library\.select_item'/, 'every checkbox has an accessible name');
  assert.match(lib, /label: t\('library\.menu\.delete'\), danger: true/);
});

test('the modal is a real dialog: labelled, Escape, focus kept inside, background inert, focus returned', () => {
  const d = read('components/library/dialog.js');
  assert.match(d, /role="dialog" aria-modal="true" aria-labelledby="\$\{id\}-title"/);
  assert.match(d, /e\.key === 'Escape'/);
  assert.match(d, /e\.key !== 'Tab'/);
  assert.match(d, /el\.inert = true/);
  assert.match(d, /opener\.focus\(\)/);
});

test('Canva appears only where it can work, and Connect only where the OAuth flow exists', () => {
  const a = read('components/library/add-content.js');
  assert.match(a, /c\.configured \|\| c\.can_manage \|\| c\.config_error/);
  assert.match(a, /else if \(c\.configured\) action = .*canva-connect/);
  assert.match(a, /api\.post\('\/canva\/connect'/);
});

test('no invented sources: every tile posts to a route the server has', () => {
  const a = read('components/library/add-content.js');
  const tiles = [...a.slice(a.indexOf('function sources()'), a.indexOf('function destFooter()')).matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ['url', 'youtube', 'doc', 'stream', 'hdmi', 'canva']);
  for (const call of ['api.addRemoteContent(', 'api.addYoutubeContent(', "api.post('/widgets'", 'api.addHlsContent(', 'opts.onOpenCanva(', 'opts.onOpenCloudFolders(']) {
    assert.ok(a.includes(call), call);
  }
  assert.doesNotMatch(a, /drive\.google|dropbox|vimeo/i);
});

test('the view preference is stored the way the dashboard stores its other view settings', () => {
  const lib = read('views/content-library.js');
  assert.match(lib, /const VIEW_KEY = 'st\.library\.view'/);
  assert.match(lib, /try \{ localStorage\.setItem\(VIEW_KEY, v\); \} catch/);
});

test('hold stays: the playlist editor adds it as a step, reusing one hold row per mode', () => {
  const pl = read('views/playlists.js');
  assert.match(pl, /id="addHoldBtn"/);
  assert.match(pl, /rows\.find\(\(c\) => c\.remote_url === `hold:\/\/\$\{mode\}`\)/);
  assert.match(pl, /api\.addPlaylistItem\(playlistId, \{ content_id: hold\.id, duration_sec: secs \}\)/);
});
