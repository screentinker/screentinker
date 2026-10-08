'use strict';

// What the worker does with the playlist message the player posts it — specifically the prune half.
//
// THE BUG: `pruneToPlaylist` deletes every content entry not in the keep-set, and the message
// handler ran it on an EMPTY keep-set. `assignments: []` is not a rare shape. buildPlaylistPayload()
// produces it for a device between playlists, for a playlist that has never been published, and —
// this is the one that hurts — inside `catch (e) { assignments = []; }` when a published_snapshot
// fails to JSON.parse. Any of those wiped every byte of media the panel had cached, which is only
// survivable while the uplink is up, i.e. exactly when the offline cache does not matter.
// Reproduced in a browser before the fix: three cached assets, one empty payload, cache emptied.
//
// Runs the SHIPPED worker (player/sw.js) against a fake Cache API, capturing the message listener
// it registers — the listener is the thing under test, so stubbing addEventListener away (as the
// prefetch tests do) would leave this path untested, which is how it shipped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'player', 'sw.js'), 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'lib', 'player-cache-policy.js');

const A = 'http://s/uploads/content/a.mp4?rev=1';
const B = 'http://s/uploads/content/b.png?rev=1';
const OLD = 'http://s/uploads/content/a.mp4?rev=0';

class FakeCache {
  constructor() { this.map = new Map(); }
  #url(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) { const r = this.map.get(this.#url(req)); return r ? r.clone() : undefined; }
  async put(req, res) { this.map.set(this.#url(req), res); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { return this.map.delete(this.#url(req)); }
}

function load() {
  const content = new FakeCache();
  const listeners = {};
  const sandbox = {
    caches: {
      open: async () => content,
      keys: async () => ['rd-content-v1'],
      delete: async () => true,
      match: async () => undefined,
    },
    // Any network use here would be a bug in the test, not the worker: prune touches no network.
    fetch: async () => { throw new Error('prune must not fetch'); },
    Response, Request, Blob, URL, console,
    location: { href: 'http://s/player/index.html' },
    navigator: {},
    importScripts() {
      delete require.cache[require.resolve(POLICY_PATH)];
      sandbox.self.PlayerCachePolicy = require(POLICY_PATH);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting() {},
    clients: { claim() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { sandbox, content, post: (data) => listeners.message.forEach((fn) => fn({ data })) };
}

const seed = async (content, urls) => {
  for (const u of urls) await content.put(u, new Response('x'));
};
const keys = (content) => [...content.map.keys()].sort();
// The worker chains prune onto its serialised prefetch queue, so give the microtasks a turn.
const settle = () => new Promise((r) => setTimeout(r, 20));

test('THE BUG: an empty playlist must NOT wipe the offline cache', async () => {
  const { content, post } = load();
  await seed(content, [A, B]);
  post({ type: 'st-cache-playlist', urls: [], prune: true });
  await settle();
  assert.deepEqual(keys(content), [A, B].sort(),
    'a payload with no assignments is indistinguishable from a payload that failed to build — it is not a delete instruction');
});

test('a real playlist still reclaims what it supersedes', async () => {
  // The guard must not cost the feature it guards: a replace writes a NEW random filename, so the
  // superseded copy lives at a different path and only the keep-set can find it.
  const { content, post } = load();
  await seed(content, [A, B, OLD]);
  post({ type: 'st-cache-playlist', urls: [A], prune: true });
  await settle();
  assert.deepEqual(keys(content), [A], 'everything the display no longer needs is dropped');
});

test('an in-flight transfer\'s bookkeeping survives a prune of its own asset', async () => {
  // The chunk keys are not in the keep-set (they carry __st_part), so deleting them on the URL test
  // alone would restart that download on every 60s sweep — a resume that never completes.
  const { content, post } = load();
  const chunk = A + '&__st_part=0';
  const meta = A + '&__st_part=meta';
  await seed(content, [B, chunk, meta]);
  post({ type: 'st-cache-playlist', urls: [A], prune: true });
  await settle();
  assert.deepEqual(keys(content), [chunk, meta].sort(), 'progress on a wanted asset is kept; B is not wanted');
});

test('prune:false never deletes, whatever the list says', async () => {
  const { content, post } = load();
  await seed(content, [A, B]);
  post({ type: 'st-cache-playlist', urls: [A], prune: false });
  await settle();
  assert.deepEqual(keys(content), [A, B].sort());
});

test('a message that is not ours is ignored', async () => {
  const { content, post } = load();
  await seed(content, [A, B]);
  for (const bad of [null, {}, { type: 'other', urls: [], prune: true },
    { type: 'st-cache-playlist', prune: true }, { type: 'st-cache-playlist', urls: 'all', prune: true }]) {
    post(bad);
  }
  await settle();
  assert.deepEqual(keys(content), [A, B].sort());
});

// Deleted on the dashboard (device:unpaired {reason: 'deleted'}): the page sends st-device-deleted
// with the trigger media to keep. Unlike st-cache-playlist, an empty keep list here DOES empty the
// cache — it comes only from an explicit operator delete, never from a payload.
test('a deleted display drops everything except its trigger media', async () => {
  const { content, post } = load();
  await seed(content, [A, B, OLD]);
  post({ type: 'st-device-deleted', keep: [B] });
  await settle();
  assert.deepEqual(keys(content), [B], 'trigger media (B) must survive the wipe');
});

test('a deleted display with no triggers ends up with an empty cache', async () => {
  const { content, post } = load();
  await seed(content, [A, B]);
  post({ type: 'st-device-deleted', keep: [] });
  await settle();
  assert.deepEqual(keys(content), []);
});

test('a malformed delete message deletes nothing', async () => {
  const { content, post } = load();
  await seed(content, [A, B]);
  post({ type: 'st-device-deleted' });
  post({ type: 'st-device-deleted', keep: 'all' });
  await settle();
  assert.deepEqual(keys(content), [A, B].sort());
});

test('the page sends the wipe only for reason deleted, keeping trigger media', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const h = page.slice(page.indexOf("socket.on('device:unpaired'"));
  const body = h.slice(0, h.indexOf('socket.on(', 10));
  assert.match(body, /data\.reason === 'deleted'\) dropCacheForDeletedDisplay\(\)/);
  const fn = page.slice(page.indexOf('function dropCacheForDeletedDisplay'));
  const fnBody = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.match(fnBody, /triggerItems\(triggers\)/);
  assert.match(fnBody, /type: 'st-device-deleted'/);
});
