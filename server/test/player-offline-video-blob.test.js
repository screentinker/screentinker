'use strict';

/*
 * Offline video on legacy panels (webOS / Tizen-era Chromium, e.g. Chrome 79).
 *
 * On those browsers a <video src=remoteURL> request bypasses the service worker, so the SW cache can
 * neither see nor serve the clip and it fails offline (verified on a real panel: "worker saw 0 cached
 * / 0 network requests", MEDIA_ELEMENT_ERROR offline). A blob: URL built from the SW-cached bytes
 * plays offline there. These tests pin that path: the eligibility gate, the cache-only resolve with
 * its streaming fallback, the blob lifecycle, and that the solo-video mount actually uses it - in both
 * the modern and the chrome53 legacy bundle.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLAYER = path.join(__dirname, '..', 'player');
const INDEX = fs.readFileSync(path.join(PLAYER, 'index.html'), 'utf8');
const LEGACY = fs.readFileSync(path.join(PLAYER, 'legacy.html'), 'utf8');

// Pull a top-level `function <name>(...) { ... }` out of the page by matching balanced braces.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `source must define ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// Build a sandbox holding blobVideoEligible + resolveVideoSrc with the page globals they close over
// stubbed, so their real logic runs. mediaUrl is a tiny stand-in matching the page contract.
function sandbox({ hasController = true, fetchImpl } = {}) {
  const ctx = {
    navigator: { serviceWorker: hasController ? { controller: {} } : null },
    BLOB_VIDEO_MAX_BYTES: 128 * 1024 * 1024,
    config: { serverUrl: 'https://srv' },
    URL: { createObjectURL: (b) => 'blob:' + (b && b.size), revokeObjectURL() {} },
    fetch: fetchImpl || (async () => ({ ok: false })),
    Promise,
    Number,
    console,
  };
  ctx.mediaUrl = function (it) { return it && it.remote_url ? it.remote_url : 'https://srv/uploads/content/' + (it && it.filepath); };
  vm.createContext(ctx);
  vm.runInContext(extractFn(INDEX, 'blobVideoEligible') + '\n' + extractFn(INDEX, 'resolveVideoSrc'), ctx);
  return ctx;
}

const vid = (over = {}) => ({ content_id: 'c1', filepath: 'c1.mp4', mime_type: 'video/mp4', file_size: 1024, ...over });

test('eligibility: a local, cached-size video with a controlling SW is eligible', () => {
  const ctx = sandbox();
  assert.equal(ctx.blobVideoEligible(vid()), true);
});

test('eligibility: remote, youtube, hls, non-video, and oversize clips are NOT eligible (they stream)', () => {
  const ctx = sandbox();
  assert.equal(ctx.blobVideoEligible(vid({ remote_url: 'https://cdn/x.mp4' })), false, 'remote streams');
  assert.equal(ctx.blobVideoEligible(vid({ mime_type: 'video/youtube' })), false, 'youtube');
  assert.equal(ctx.blobVideoEligible(vid({ mime_type: 'video/hls' })), false, 'hls');
  assert.equal(ctx.blobVideoEligible(vid({ mime_type: 'image/png' })), false, 'not a video');
  assert.equal(ctx.blobVideoEligible(vid({ file_size: 200 * 1024 * 1024 })), false, 'over the memory cap');
});

test('eligibility: no service-worker controller means no cache to answer, so stream', () => {
  const ctx = sandbox({ hasController: false });
  assert.equal(ctx.blobVideoEligible(vid()), false);
});

test('resolve: a cache HIT yields a blob: src; the request is cache-only', async () => {
  let sawHeader = null;
  const ctx = sandbox({
    fetchImpl: async (url, opts) => { sawHeader = opts && opts.headers && opts.headers['X-ST-Cache-Only']; return { ok: true, blob: async () => ({ size: 2048 }) }; },
  });
  const res = await ctx.resolveVideoSrc(vid());
  assert.equal(res.blob, true);
  assert.match(res.url, /^blob:/);
  assert.equal(sawHeader, '1', 'only what the cache already holds is used');
});

test('resolve: a cache MISS (504) streams from the plain URL, never throws', async () => {
  const ctx = sandbox({ fetchImpl: async () => ({ ok: false }) });
  const res = await ctx.resolveVideoSrc(vid());
  assert.equal(res.blob, false);
  assert.equal(res.url, 'https://srv/uploads/content/c1.mp4');
});

test('resolve: a fetch error falls back to streaming, never rejects', async () => {
  const ctx = sandbox({ fetchImpl: async () => { throw new Error('offline and uncached'); } });
  const res = await ctx.resolveVideoSrc(vid());
  assert.equal(res.blob, false);
  assert.equal(res.url, 'https://srv/uploads/content/c1.mp4');
});

test('resolve: an oversize cached blob is dropped (revoked-by-GC) and streamed instead', async () => {
  const ctx = sandbox({ fetchImpl: async () => ({ ok: true, blob: async () => ({ size: 200 * 1024 * 1024 }) }) });
  const res = await ctx.resolveVideoSrc(vid({ file_size: 0 })); // size unknown up front, caught after read
  assert.equal(res.blob, false);
});

for (const [name, src] of [['index.html', INDEX], ['legacy.html', LEGACY]]) {
  test(`${name}: the solo-video mount resolves through resolveVideoSrc and frees the blob on teardown`, () => {
    const fn = extractFn(src, 'renderVideoBuffered');
    assert.match(fn, /resolveVideoSrc\(item\)/, 'the solo video src goes through the cache-aware resolver');
    assert.match(fn, /revokeBlobOnEmptied\(video,\s*res\.url\)/, 'a blob src is registered for revoke');
    // The watchdog is armed INSIDE the resolve callback, so the cache lookup is not counted against it.
    assert.ok(src.indexOf('function revokeBlobOnEmptied') >= 0, 'the revoke-on-emptied helper ships in this bundle');
  });
}
