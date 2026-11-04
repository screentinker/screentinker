'use strict';

/*
 * The web player's shell cache on a cold boot without a working network (server/player/sw.js),
 * driven like sw-offline-quota.test.js: the REAL worker against a fake Cache API and a fake network.
 *
 * The shell (/player, its scripts, socket.io.js) is network-first with the cache as the fallback,
 * and the fallback only ever ran when fetch() REJECTED. With the cable out that is immediate. With
 * the link up and the WAN down — a router that answers and an uplink that does not, the usual way
 * a site loses its internet — fetch() sits in the TCP handshake for as long as the TV's network
 * stack allows, a minute or more, and for all of that time the panel shows nothing, or the
 * browser's own "check network connection" page. The worker now gives the network a bounded wait
 * and serves the cached shell when it has one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'lib', 'player-cache-policy.js');

class MapCache {
  constructor() { this.map = new Map(); }
  #url(req) { return typeof req === 'string' ? req : req.url; }
  async match(req, opts) {
    const url = this.#url(req);
    const hit = this.map.get(url);
    if (hit) return hit.clone();
    if (opts && opts.ignoreSearch) {
      const bare = url.split('?')[0];
      for (const [k, v] of this.map) if (k.split('?')[0] === bare) return v.clone();
    }
    return undefined;
  }
  async put(req, res) { this.map.set(this.#url(req), res.clone()); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { return this.map.delete(this.#url(req)); }
}

function load(fetchImpl) {
  const shell = new MapCache();
  const listeners = {};
  // A controllable clock: the worker's setTimeout runs on it, so the 8s wait costs the test nothing.
  const timers = [];
  const clock = {
    setTimeout(fn, ms) { const t = { fn, at: clock.now + ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    now: 0,
    async advance(ms) {
      clock.now += ms;
      for (const t of timers.splice(0)) { if (!t.cleared && t.at <= clock.now) t.fn(); else timers.push(t); }
      await new Promise((r) => setImmediate(r));
    },
  };
  const sandbox = {
    caches: { open: async () => shell, keys: async () => [], delete: async () => true, match: (r, o) => shell.match(r, o) },
    fetch: (req) => fetchImpl(req),
    Response, Request, Headers, Blob, URL, MessageChannel, console: { log() {}, warn() {}, error() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, AbortController,
    location: { href: 'http://s/player/index.html' },
    navigator: { storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) } },
    importScripts() { delete require.cache[require.resolve(POLICY_PATH)]; sandbox.self.PlayerCachePolicy = require(POLICY_PATH); },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {}, clients: { claim() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  function request(url) {
    let p;
    listeners.fetch({ request: new Request(url), respondWith: (x) => { p = x; } });
    assert.ok(p, 'the worker answers shell requests');
    return p;
  }
  return { sw: sandbox, shell, request, clock };
}

const PLAYER = 'http://s/player?host=webos&v=3.1.2';
const SCRIPT = 'http://s/player/kiosk-player.js';

/* A network that answers, then one that never answers (link up, WAN down), then one that is gone. */
function network() {
  const state = { mode: 'up', calls: 0, pending: [] };
  state.fetch = (req) => {
    state.calls++;
    if (state.mode === 'up') return Promise.resolve(new Response('<html>shell</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    if (state.mode === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise((resolve, reject) => state.pending.push({ resolve, reject, url: req.url }));   // 'silent'
  };
  return state;
}

test('online: the shell comes from the network and is cached for next time', async () => {
  const net = network();
  const { request, shell } = load(net.fetch);
  const r = await request(PLAYER);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<html>shell</html>');
  await new Promise((x) => setImmediate(x));
  assert.ok(await shell.match(PLAYER), 'cached');
});

test('cable out: fetch fails at once and the cached shell is served', async () => {
  const net = network();
  const { request } = load(net.fetch);
  await request(PLAYER); await new Promise((x) => setImmediate(x));
  net.mode = 'down';
  const r = await request(PLAYER);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<html>shell</html>');
});

test('THE BUG: link up, WAN down — the cached shell is served after the wait, not after the TCP timeout', async () => {
  const net = network();
  const { request, clock } = load(net.fetch);
  await request(PLAYER); await new Promise((x) => setImmediate(x));
  net.mode = 'silent';
  let settled = null;
  const p = request(PLAYER).then((r) => { settled = r; return r; });
  await clock.advance(7000);
  assert.equal(settled, null, 'still giving the network its chance at 7s');
  await clock.advance(1500);
  assert.ok(settled, 'served at the 8s mark');
  assert.equal(settled.status, 200);
  assert.equal(await (await p).text(), '<html>shell</html>');
  assert.equal(net.pending.length, 1, 'the network request was not abandoned');
  // A late answer from the network still lands in the cache for the next load, and nothing throws.
  net.pending[0].resolve(new Response('<html>newer shell</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  for (let i = 0; i < 5; i++) await new Promise((x) => setImmediate(x));
  net.mode = 'down';
  assert.equal(await (await request(PLAYER)).text(), '<html>newer shell</html>', 'the late answer refreshed the cache');
});

test('link up, WAN down, nothing cached: the worker waits the network out rather than answering 503 at 8s', async () => {
  const net = network();
  net.mode = 'silent';
  const { request, clock } = load(net.fetch);
  let settled = null;
  const p = request(SCRIPT).then((r) => { settled = r; return r; });
  await clock.advance(9000);
  assert.equal(settled, null, 'no copy to fall back on, so the network is still the only route');
  net.pending[0].resolve(new Response('js', { status: 200, headers: { 'Content-Type': 'text/javascript' } }));
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'js');
});

test('cable out and nothing cached: 503, so the page knows rather than hangs', async () => {
  const net = network();
  net.mode = 'down';
  const { request } = load(net.fetch);
  const r = await request(SCRIPT);
  assert.equal(r.status, 503);
});

test('the query string does not defeat the fallback (a panel URL carries ?host= or ?link=)', async () => {
  const net = network();
  const { request } = load(net.fetch);
  await request('http://s/player?host=webos&v=3.1.1'); await new Promise((x) => setImmediate(x));
  net.mode = 'down';
  const r = await request('http://s/player?host=webos&v=3.1.2');
  assert.equal(r.status, 200, 'a shell cached under the previous app version still boots this one');
});
