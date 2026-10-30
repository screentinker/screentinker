'use strict';

// Drives the REAL service worker (server/player/sw.js) against a fake Cache API and a deliberately
// bad link. The policy tests cover the arithmetic; this covers the orchestration around it, which is
// where a resumed download actually gets corrupted: appending the wrong chunk, publishing a
// half-assembled asset, or serving a bookkeeping entry as if it were a video.
//
// It matters that this runs the shipped file rather than a copy — the worker cannot be exercised on
// a device without deploying to one, and "the chunks assemble correctly" is not something you want
// to discover from a panel showing a corrupt video.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'lib', 'player-cache-policy.js');

const ASSET = 'http://s/uploads/content/clip.mp4?rev=100';

/** Cache API over a Map. Keys are URLs, exactly as the real one behaves for our uses. */
class FakeCache {
  constructor() { this.map = new Map(); }
  #url(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) { const r = this.map.get(this.#url(req)); return r ? r.clone() : undefined; }
  async put(req, res) { this.map.set(this.#url(req), res); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { return this.map.delete(this.#url(req)); }
}

/**
 * A server for one asset. `failEvery` drops the connection on every Nth request (0 = never), which
 * is what a marginal link looks like from the client's side.
 */
function makeServer(body, { etag = '"v1"', failEvery = 0, rangeSupport = true } = {}) {
  const state = { body, etag, failEvery, rangeSupport, requests: 0, ranged: [] };
  state.fetch = async (request) => {
    state.requests++;
    if (state.failEvery && state.requests % state.failEvery === 0) throw new Error('network dropped');

    const range = request.headers.get('Range');
    const ifRange = request.headers.get('If-Range');
    if (!range || !state.rangeSupport) {
      return new Response(state.body, { status: 200, headers: { ETag: state.etag, 'Content-Type': 'video/mp4' } });
    }
    // If-Range with a stale validator: the server must send the WHOLE asset, not a tail. This is
    // the mechanism that stops a resume splicing two different files together.
    if (ifRange && ifRange !== state.etag) {
      return new Response(state.body, { status: 200, headers: { ETag: state.etag, 'Content-Type': 'video/mp4' } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    if (start >= state.body.length) {
      return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${state.body.length}` } });
    }
    const end = m[2] === '' ? state.body.length - 1 : Math.min(Number(m[2]), state.body.length - 1);
    state.ranged.push([start, end]);
    return new Response(state.body.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${state.body.length}`,
        ETag: state.etag,
        'Content-Type': 'video/mp4'
      }
    });
  };
  return state;
}

let sandbox, caches, server;

function load(srv, chunkBytes) {
  server = srv;
  const contentCache = new FakeCache();
  const shellCache = new FakeCache();
  caches = {
    open: async (name) => (name === 'rd-content-v1' ? contentCache : shellCache),
    keys: async () => ['rd-content-v1'],
    delete: async () => true,
    match: async () => undefined,
    _content: contentCache
  };

  sandbox = {
    caches,
    fetch: (req) => server.fetch(req),
    Response, Request, Blob, URL, console,
    location: { href: 'http://s/player/index.html' },
    navigator: {},
    importScripts() {
      // The worker importScripts()es the same policy module the Node tests require, so both sides
      // are provably the same rules rather than two implementations that agree today.
      delete require.cache[require.resolve(POLICY_PATH)];
      sandbox.self.PlayerCachePolicy = require(POLICY_PATH);
    },
    addEventListener() {},
    skipWaiting() {},
    clients: { claim() {} }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  // A 4MB production chunk would make these tests move 100MB around; the logic is size-agnostic.
  if (chunkBytes) sandbox.self.PlayerCachePolicy.CHUNK_BYTES = chunkBytes;
  return sandbox;
}

const bytes = (n, fill) => Buffer.alloc(n, fill);
// What playback would get: a whole entry or a completed chunked copy (sw.js cachedAsset).
async function cachedBody(url = ASSET) {
  const asset = await sandbox.cachedAsset(caches._content, url);
  return asset ? Buffer.from(await asset.blob.arrayBuffer()) : null;
}
const internalKeys = () => [...caches._content.map.keys()].filter((k) => k.includes('__st_part'));

beforeEach(() => { sandbox = null; });

test('THE BUG: a link that drops every other request still assembles a byte-perfect asset', async () => {
  // Each call gets a chunk or two and dies. Without accumulation this is an infinite loop that
  // caches nothing — the panel keeps an empty cache and goes dark the moment the uplink does.
  const body = bytes(1000, 0x41);
  const sw = load(makeServer(body, { failEvery: 2 }), 100);

  for (let pass = 0; pass < 40 && !(await cachedBody()); pass++) {
    try { await sw.ensureCached(ASSET); } catch (e) { /* the link, not the worker */ }
  }

  const got = await cachedBody();
  assert.ok(got, 'the asset must eventually be cached');
  assert.deepEqual(got, body, 'reassembled bytes must be identical to the original');
});

test('the full entry appears only when whole — a fragment is never published', async () => {
  // The invariant that protects playback: a cache hit is always a complete asset. Publishing early
  // would hand a media element a truncated file that it cannot report as "incomplete", only as
  // broken.
  const body = bytes(1000, 0x42);
  const sw = load(makeServer(body, { failEvery: 3 }), 100);

  for (let pass = 0; pass < 40; pass++) {
    try { await sw.ensureCached(ASSET); } catch (e) { /* */ }
    const partial = await cachedBody();
    if (partial) { assert.equal(partial.length, body.length, 'a published entry must be the whole asset'); break; }
    assert.ok(internalKeys().length >= 0);
  }
  assert.deepEqual(await cachedBody(), body);
});

test('a finished transfer is its chunks plus a marker, never a second joined copy', async () => {
  // Joining the chunks into one entry needed twice the asset on disk at once; an LG webOS panel's
  // quota could not hold that, so the join failed on every sweep and nothing was ever cached (NCH).
  const body = bytes(500, 0x43);
  const sw = load(makeServer(body), 100);
  await sw.ensureCached(ASSET);
  assert.deepEqual(await cachedBody(), body);
  assert.equal(caches._content.map.has(ASSET), false, 'no whole entry beside the chunks');
  assert.ok(internalKeys().some((k) => k.endsWith('__st_part=done')), 'the copy is marked complete');
  let chunkBytes = 0;
  for (const [k, res] of caches._content.map) if (/__st_part=\d+$/.test(k)) chunkBytes += (await res.clone().arrayBuffer()).byteLength;
  assert.equal(chunkBytes, body.length, 'exactly one copy of the bytes is stored');
});

test('an already-cached asset costs no requests at all', async () => {
  // The prefetch runs on every playlist sweep. Re-fetching a cached asset each time would be a
  // constant drain on the link least able to afford it.
  const srv = makeServer(bytes(500, 0x44));
  const sw = load(srv, 100);
  await sw.ensureCached(ASSET);
  const after = srv.requests;
  await sw.ensureCached(ASSET);
  assert.equal(srv.requests, after, 'a second pass over a cached asset must not touch the network');
});

test('an asset replaced mid-transfer is NOT spliced — the chunks are discarded', async () => {
  // The corruption this whole design exists to prevent: appending the tail of the new asset to the
  // head of the old one yields a file of exactly the right length that is wrong throughout, and it
  // would pass every completeness check we have.
  const v1 = bytes(1000, 0x61);
  const v2 = bytes(1000, 0x62);
  const srv = makeServer(v1, { failEvery: 3 });
  const sw = load(srv, 100);

  try { await sw.ensureCached(ASSET); } catch (e) { /* */ }
  assert.ok(internalKeys().length > 0, 'expected partial progress to exist before the swap');

  srv.body = v2; srv.etag = '"v2"'; srv.failEvery = 0;

  // The first pass after the swap gets a 200 from If-Range and must throw the v1 chunks away
  // rather than continue on top of them; the next rebuilds from scratch.
  await sw.ensureCached(ASSET);
  for (let pass = 0; pass < 10 && !(await cachedBody()); pass++) await sw.ensureCached(ASSET);

  const got = await cachedBody();
  assert.ok(got, 'the replaced asset must still end up cached');
  assert.deepEqual(got, v2, 'the cached asset must be all-v2, with no v1 bytes spliced in');
  assert.ok(!got.includes(0x61), 'not one byte of the superseded asset may survive');
});

test('a superseded revision is swept rather than left to fill the quota', async () => {
  // Replacing an asset changes the revision in the URL, which is what makes the new bytes a miss.
  // Without the sweep the old copy sits there until the quota evicts it — on a 1GB panel budget a
  // handful of replaced videos is the whole cache.
  const oldUrl = 'http://s/uploads/content/clip.mp4?rev=100';
  const newUrl = 'http://s/uploads/content/clip.mp4?rev=200';
  const sw = load(makeServer(bytes(300, 0x45)), 100);

  await sw.ensureCached(oldUrl);
  assert.ok(await cachedBody(oldUrl));

  server.body = bytes(300, 0x46); server.etag = '"v2"';
  await sw.ensureCached(newUrl);

  assert.ok(await cachedBody(newUrl), 'the new revision is cached');
  assert.equal(await cachedBody(oldUrl), null, 'the superseded revision is gone');
});

test('a server with no range support still caches the asset whole', async () => {
  // Not every deployment sits behind something that honours Range. Falling back to a plain store is
  // the pre-existing behaviour and remains correct — just not resumable.
  const body = bytes(600, 0x47);
  const sw = load(makeServer(body, { rangeSupport: false }), 100);
  await sw.ensureCached(ASSET);
  assert.deepEqual(await cachedBody(), body);
});

test('a chunked transfer asks for each range exactly once, in order', async () => {
  const sw = load(makeServer(bytes(1000, 0x48)), 250);
  await sw.ensureCached(ASSET);
  const starts = server.ranged.map((r) => r[0]);
  assert.deepEqual(starts, [0, 250, 500, 750], 'no gaps, no repeats, no overlap');
});
