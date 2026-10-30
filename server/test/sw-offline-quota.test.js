'use strict';

// The web player's offline cache on a panel with little storage (server/player/sw.js), driven like
// sw-content-prefetch.test.js: the REAL worker against a fake Cache API, here one with a byte quota.
//
// Found on an LG webOS customer panel (2026-10-30): with the network unplugged the video paused and
// the screen went black. The chunked prefetch used to JOIN its chunks into a second, whole copy, so
// a moment of every download needed twice the asset on disk. Past the panel's quota that join threw,
// the error was swallowed, and the asset was never cached, on every sweep, for ever. Playback ran
// from the network the whole time, so nothing looked wrong until the network went.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'lib', 'player-cache-policy.js');
const ASSET = 'http://s/uploads/content/clip.mp4?rev=100';

class QuotaError extends Error { constructor() { super('quota exceeded'); this.name = 'QuotaExceededError'; } }

/** Cache API over a Map, refusing a put that would take the stored bytes past [quota]. */
class QuotaCache {
  constructor(quota) { this.map = new Map(); this.sizes = new Map(); this.quota = quota; this.peak = 0; }
  #url(req) { return typeof req === 'string' ? req : req.url; }
  used() { let n = 0; for (const v of this.sizes.values()) n += v; return n; }
  async match(req) { const r = this.map.get(this.#url(req)); return r ? r.clone() : undefined; }
  async put(req, res) {
    const url = this.#url(req);
    const buf = Buffer.from(await res.clone().arrayBuffer());
    const after = this.used() - (this.sizes.get(url) || 0) + buf.length;
    if (after > this.quota) throw new QuotaError();
    this.map.set(url, new Response(buf, { status: res.status, headers: res.headers }));
    this.sizes.set(url, buf.length);
    this.peak = Math.max(this.peak, this.used());
  }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { this.sizes.delete(this.#url(req)); return this.map.delete(this.#url(req)); }
}

function origin(body, state = {}) {
  state.up = true; state.requests = 0;
  state.fetch = async (request) => {
    state.requests++;
    if (!state.up) throw new TypeError('Failed to fetch');
    const range = request.headers.get('Range');
    if (!range) return new Response(body, { status: 200, headers: { ETag: '"v1"', 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) } });
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]); const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
    return new Response(body.subarray(start, end + 1), {
      status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}`, ETag: '"v1"', 'Content-Type': 'video/mp4' },
    });
  };
  return state;
}

function load(net, quota) {
  const content = new QuotaCache(quota);
  const other = new QuotaCache(Infinity);
  const listeners = {};
  const sandbox = {
    caches: { open: async (n) => (n === 'rd-content-v1' ? content : other), keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: (req) => net.fetch(req),
    Response, Request, Headers, Blob, URL, MessageChannel, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, AbortController,
    location: { href: 'http://s/player/index.html' },
    navigator: { storage: { estimate: async () => ({ usage: content.used(), quota }) } },
    importScripts() { delete require.cache[require.resolve(POLICY_PATH)]; sandbox.self.PlayerCachePolicy = require(POLICY_PATH); },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {}, clients: { claim() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  sandbox.self.PlayerCachePolicy.CHUNK_BYTES = 100;
  /** What the media element gets for [url] with an optional Range, through the fetch handler. */
  async function play(url, range) {
    let p;
    const headers = new Headers(range ? { Range: range } : {});
    listeners.fetch({ request: new Request(url, { headers }), respondWith: (x) => { p = x; } });
    assert.ok(p, 'the worker answers content requests');
    return p;
  }
  function status(urls) {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => { ch.port1.close(); resolve(e.data); };
      listeners.message({ data: { type: 'st-cache-status', urls }, ports: [ch.port2] });
    });
  }
  return { sw: sandbox, content, play, status };
}

const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

test('THE BUG: an asset bigger than half the quota still caches (one copy, never two)', async () => {
  // 1000 bytes into a 1300-byte quota: the old join needed ~2000 at its peak and never finished.
  const { sw, content } = load(origin(body), 1300);
  for (let i = 0; i < 3; i++) await sw.ensureCached(ASSET);
  const asset = await sw.cachedAsset(content, ASSET);
  assert.ok(asset, 'the asset is cached');
  assert.deepEqual(Buffer.from(await asset.blob.arrayBuffer()), body);
  assert.ok(content.peak <= 1300 && content.peak < 2 * body.length, `peak storage ${content.peak} stays at one copy`);
});

test('network gone: the cached copy plays, whole and by range, byte for byte', async () => {
  const net = origin(body);
  const { sw, play } = load(net, 5000);
  await sw.ensureCached(ASSET);
  net.up = false;

  const whole = await play(ASSET);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-length'), '1000');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), body);

  // Ranges across a chunk boundary, open-ended and suffix: what a seeking video asks for.
  for (const [range, start, end] of [['bytes=150-349', 150, 349], ['bytes=900-', 900, 999], ['bytes=-50', 950, 999], ['bytes=0-0', 0, 0]]) {
    const r = await play(ASSET, range);
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/1000`, range);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), body.subarray(start, end + 1), range);
  }
});

test('not cached and offline is a 504, so the player skips the item instead of hanging', async () => {
  const net = origin(body);
  const { play } = load(net, 5000);
  net.up = false;
  const r = await play(ASSET, 'bytes=0-');
  assert.equal(r.status, 504);
});

test('a chunk the quota evicted: a miss (never a short file), and the next sweep fetches only that piece', async () => {
  const net = origin(body);
  const { sw, content, play } = load(net, 5000);
  await sw.ensureCached(ASSET);
  await content.delete(sw.PlayerCachePolicy.chunkKey(ASSET, 300));

  assert.equal(await sw.cachedAsset(content, ASSET), null, 'an incomplete copy is not served');
  net.up = false;
  assert.equal((await play(ASSET)).status, 504, 'offline, the gap is a miss and not a truncated video');

  net.up = true;
  const before = net.requests;
  await sw.ensureCached(ASSET);
  assert.equal(net.requests - before, 1, 'one request: the missing chunk');
  assert.deepEqual(Buffer.from(await (await sw.cachedAsset(content, ASSET)).blob.arrayBuffer()), body);
});

test('chunks carry Content-Length, so eviction frees what it counts', async () => {
  const { sw, content } = load(origin(body), 5000);
  await sw.ensureCached(ASSET);
  for (const [k, res] of content.map) {
    if (/__st_part=\d+$/.test(k)) assert.equal(res.headers.get('content-length'), String(content.sizes.get(k)), k);
  }
});

test('a transfer started by the previous worker (meta without a chunk size) still completes', async () => {
  const net = origin(body);
  const { sw, content } = load(net, 5000);
  const P = sw.PlayerCachePolicy;
  await content.put(P.chunkKey(ASSET, 'meta'), new Response(JSON.stringify({ total: 1000, validator: '"v1"', type: 'video/mp4' })));
  await content.put(P.chunkKey(ASSET, 0), new Response(body.subarray(0, 100)));
  await sw.ensureCached(ASSET);
  assert.deepEqual(Buffer.from(await (await sw.cachedAsset(content, ASSET)).blob.arrayBuffer()), body);
});

test('a whole entry from the old worker still plays (no re-download after the update)', async () => {
  const net = origin(body);
  const { content, play } = load(net, 5000);
  await content.put(ASSET, new Response(body, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' } }));
  net.up = false;
  const r = await play(ASSET, 'bytes=10-19');
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), body.subarray(10, 20));
});

test('status: ready, partial and the error that stopped the cache, for the page to report', async () => {
  const other = 'http://s/uploads/content/big.mp4?rev=1';
  const big = Buffer.alloc(3000, 1);
  const net = { requests: 0 };
  const small = origin(body); const large = origin(big);
  net.fetch = (req) => (req.url.startsWith(other.split('?')[0]) ? large.fetch(req) : small.fetch(req));
  const { sw, status } = load(net, 1600);

  await sw.ensureCached(ASSET);                       // fits
  await sw.ensureCached(other).catch((e) => sw.noteCacheError(e));   // 1000 + 3000 > 1600: stops part-way

  const s = await status([ASSET, other, ASSET, 'http://s/api/not-content']);
  assert.equal(s.wanted, 2, 'duplicates and non-content are not counted');
  assert.equal(s.ready, 1);
  assert.equal(s.ready_bytes, 1000);
  assert.equal(s.partial, 1);
  assert.ok(s.partial_bytes > 0 && s.partial_bytes < big.length);
  assert.equal(s.quota, 1600);
  assert.ok(s.usage > 0);
  assert.equal(s.error && s.error.name, 'QuotaExceededError');
});
