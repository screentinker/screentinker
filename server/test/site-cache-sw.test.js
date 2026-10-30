'use strict';

/*
 * 3.0 site cache, PLAYER side: the REAL service worker (player/sw.js) against a fake Cache API, a
 * fake origin and a fake LAN cache box. The worker is where the web player's whole site-cache
 * behaviour lives, so this is where "it never plays wrong bytes and it never goes dark" is proven:
 *
 *   - a verified copy from the box is kept and the origin is never asked
 *   - bytes that do not hash to the digest from the ORIGIN are thrown away; the origin's copy is used
 *   - a box that does not answer: the origin, and the box is skipped for a while (no timeout per file)
 *   - a box still downloading (503 warming) is waited for, so the site downloads once
 *   - no config (an old payload / no cache assigned) and an expired token: exactly the old path
 *   - a playback miss is filled from the box and sliced for a Range request
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'lib', 'player-cache-policy.js');

const ORIGIN = 'http://s';
const BOX = 'http://10.0.0.5:8088';
const PATHNAME = '/uploads/content/clip.png';
const ASSET = `${ORIGIN}${PATHNAME}?rev=7`;
const BODY = crypto.randomBytes(5000);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

class FakeCache {
  constructor() { this.map = new Map(); }
  #url(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) { const r = this.map.get(this.#url(req)); return r ? r.clone() : undefined; }
  async put(req, res) { this.map.set(this.#url(req), res); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { return this.map.delete(this.#url(req)); }
}

/**
 * box: 'ok' | 'lie' | 'down' | 'warming-then-ok' | '404'
 */
function load({ box = 'ok' } = {}) {
  const stores = new Map();
  const open = async (name) => { if (!stores.has(name)) stores.set(name, new FakeCache()); return stores.get(name); };
  const log = { origin: 0, box: 0, boxAuth: [] };
  let warmLeft = 1;
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(BOX)) {
      log.box++;
      const h = init.headers || {};
      log.boxAuth.push(h.Authorization || (typeof h.get === 'function' ? h.get('Authorization') : null));
      if (box === 'down') throw new TypeError('Failed to fetch');
      if (box === '404') return new Response('{}', { status: 404 });
      if (box === 'warming-then-ok' && warmLeft-- > 0) return new Response('{}', { status: 503, headers: { 'Retry-After': '2' } });
      const bytes = box === 'lie' ? Buffer.from(BODY).fill(7, 0, 10) : BODY;
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    log.origin++;
    const req = typeof input === 'string' ? new Request(input, init) : input;
    const range = req.headers.get('Range');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]); const end = m[2] === '' ? BODY.length - 1 : Math.min(Number(m[2]), BODY.length - 1);
      return new Response(BODY.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${BODY.length}`, ETag: '"o1"', 'Content-Type': 'image/png' } });
    }
    return new Response(BODY, { status: 200, headers: { ETag: '"o1"', 'Content-Type': 'image/png', 'Content-Length': String(BODY.length) } });
  };
  const listeners = {};
  const sandbox = {
    caches: { open, keys: async () => [...stores.keys()], delete: async () => true, match: async () => undefined },
    fetch: fetchImpl,
    Response, Request, Headers, Blob, URL, console: { log() {}, warn() {}, error() {} },
    AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto,
    location: { href: `${ORIGIN}/player/index.html` },
    navigator: {},
    importScripts() { delete require.cache[require.resolve(POLICY_PATH)]; sandbox.self.PlayerCachePolicy = require(POLICY_PATH); },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {},
    clients: { claim() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  const post = (data) => listeners.message({ data });
  const content = () => open('rd-content-v1');
  return { sandbox, post, log, content, listeners };
}

const config = (over = {}) => ({ url: BOX, token: 'stc1.t', expires_at: Math.floor(Date.now() / 1000) + 3600, files: { [PATHNAME]: { sha256: SHA, size: BODY.length } }, ...over });
// What playback would get: a whole entry or a completed chunked copy (sw.js cachedAsset).
async function stored(env) {
  const asset = await env.sandbox.cachedAsset(await env.content(), ASSET);
  return asset ? Buffer.from(await asset.blob.arrayBuffer()) : null;
}

test('a verified copy from the box is kept, with the screen token, and the origin is never asked', async () => {
  const env = load({ box: 'ok' });
  env.post({ type: 'st-site-cache', config: config() });
  await env.sandbox.ensureCached(ASSET);
  assert.deepEqual(await stored(env), BODY);
  assert.equal(env.log.origin, 0, 'no WAN download');
  assert.equal(env.log.boxAuth[0], 'Bearer stc1.t');
});

test('INTEGRITY: bytes that do not match the origin\'s digest are discarded and the origin is used', async () => {
  const env = load({ box: 'lie' });
  env.post({ type: 'st-site-cache', config: config() });
  await env.sandbox.ensureCached(ASSET);
  assert.equal(env.log.box, 1);
  assert.ok(env.log.origin >= 1, 'fell back to the origin');
  assert.deepEqual(await stored(env), BODY, 'what is kept is the true asset, not the box\'s');
});

test('a box that does not answer: origin now, and the box is skipped for a while rather than timed out per file', async () => {
  const env = load({ box: 'down' });
  env.post({ type: 'st-site-cache', config: config() });
  await env.sandbox.ensureCached(ASSET);
  assert.deepEqual(await stored(env), BODY);
  assert.ok(env.log.origin >= 1);
  await (await env.content()).delete(ASSET);
  await env.sandbox.ensureCached(ASSET);
  assert.equal(env.log.box, 1, 'the second asset did not try the dead box again');
});

test('a box still downloading is waited for, so the site makes one WAN download', async () => {
  const env = load({ box: 'warming-then-ok' });
  env.post({ type: 'st-site-cache', config: config() });
  await env.sandbox.ensureCached(ASSET);
  assert.equal(env.log.box, 2, 'asked, waited, asked again');
  assert.equal(env.log.origin, 0);
  assert.deepEqual(await stored(env), BODY);
});

test('CAPABILITY / ASSIGNMENT GATING: no config, an expired token, or an unknown path is exactly the old path', async () => {
  for (const cfg of [null, config({ expires_at: Math.floor(Date.now() / 1000) - 10 }), config({ files: {} })]) {
    const env = load({ box: 'ok' });
    if (cfg !== null) env.post({ type: 'st-site-cache', config: cfg });
    await env.sandbox.ensureCached(ASSET);
    assert.equal(env.log.box, 0, 'the box was never contacted');
    assert.deepEqual(await stored(env), BODY);
  }
  const env = load({ box: 'ok' });
  env.post({ type: 'st-site-cache', config: config({ url: 'javascript:alert(1)' }) });
  await env.sandbox.ensureCached(ASSET);
  assert.equal(env.log.box, 0, 'a malformed address is ignored');
});

test('a playback miss is filled from the box and a Range request is sliced from it', async () => {
  const env = load({ box: 'ok' });
  env.post({ type: 'st-site-cache', config: config() });
  const r = await env.sandbox.handleContent(new Request(ASSET, { headers: { Range: 'bytes=100-199' } }));
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY.subarray(100, 200));
  assert.equal(env.log.origin, 0);
  assert.deepEqual(await stored(env), BODY);
});

test('the config survives a worker restart (persisted), and clearing it clears it', async () => {
  const env = load({ box: 'ok' });
  env.post({ type: 'st-site-cache', config: config() });
  await new Promise((r) => setTimeout(r, 10));
  const saved = await (await env.sandbox.caches.open('rd-site-cache-v1')).match('/__st_site_cache__');
  assert.ok(saved, 'persisted');
  env.post({ type: 'st-site-cache', config: null });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await (await env.sandbox.caches.open('rd-site-cache-v1')).match('/__st_site_cache__'), undefined);
});
