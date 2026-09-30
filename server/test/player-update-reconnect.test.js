'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const HTML = fs.readFileSync(path.join(__dirname, '../player/index.html'), 'utf8');
const start = HTML.indexOf('// ==================== Auto-reload on code update');
const end = HTML.indexOf('// ==================== Video Wall', start);
const SOURCE = HTML.slice(start, end);

// Exercise the shipped version-check section with a controllable transport and interval.
function player() {
  let response = { hash: 'old-build', version: '2.3.0' }, fail = false, poll;
  const restarts = [], timers = new Map(), storage = new Map();
  let id = 0;
  const scope = {
    config: { serverUrl: 'http://test' }, PLAYER_VERSION: '2.3.0',
    console: { log() {}, warn() {} },
    fetch: async () => { if (fail) throw new Error('offline'); return { json: async () => response }; },
    setInterval: (fn, ms) => { assert.equal(ms, 30000); poll = fn; timers.set(++id, fn); return id; },
    clearInterval: key => timers.delete(key), restartPlayer: reason => restarts.push(reason),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    restarts, timers, storage,
    async connect() { scope.startVersionCheck(); await settle(); },
    async tick() { poll(); await settle(); },
    response: value => { response = value; }, offline: value => { fail = value; },
    hash: () => vm.runInContext('knownServerHash', scope),
  };
}

test('first connection establishes a baseline without reloading', async () => {
  const p = player(); await p.connect();
  assert.equal(p.hash(), 'old-build');
  assert.deepEqual(p.restarts, []);
});

test('reconnect after a same-version deployment reloads the running player', async () => {
  const p = player(); await p.connect();
  p.response({ hash: 'new-build', version: '2.3.0' });
  await p.connect();
  assert.deepEqual(p.restarts, ['server code updated']);
  assert.equal(p.hash(), 'old-build', 'do not adopt code the page has not loaded');
  assert.equal(p.timers.size, 1, 'reconnect replaces the old poll timer');
});

test('ordinary reconnect to unchanged code does not reload', async () => {
  const p = player(); await p.connect(); await p.connect(); await p.tick();
  assert.deepEqual(p.restarts, []);
  assert.equal(p.timers.size, 1);
});

test('code changes detected by a regular poll still reload', async () => {
  const p = player(); await p.connect();
  p.response({ hash: 'new-build', version: '2.3.0' }); await p.tick();
  assert.deepEqual(p.restarts, ['server code updated']);
});

test('a failed reconnect fetch preserves the baseline for the next poll', async () => {
  const p = player(); await p.connect(); p.offline(true); await p.connect();
  assert.equal(p.hash(), 'old-build');
  p.offline(false); p.response({ hash: 'new-build', version: '2.3.0' }); await p.tick();
  assert.deepEqual(p.restarts, ['server code updated']);
});

test('a poll can establish the baseline if the first fetch failed', async () => {
  const p = player(); p.offline(true); await p.connect(); p.offline(false); await p.tick();
  assert.equal(p.hash(), 'old-build');
  assert.deepEqual(p.restarts, []);
  p.response({ hash: 'new-build', version: '2.3.0' }); await p.tick();
  assert.deepEqual(p.restarts, ['server code updated']);
});

test('empty or malformed hashes never erase the baseline or cause a reload', async () => {
  const p = player(); await p.connect();
  for (const hash of ['', null, undefined, 123]) {
    p.response({ hash, version: '2.3.0' }); await p.connect(); await p.tick();
    assert.equal(p.hash(), 'old-build');
  }
  assert.deepEqual(p.restarts, []);
});

test('release-version mismatch still uses the throttled self-heal', async () => {
  const p = player(); p.response({ hash: 'old-build', version: '2.3.1' });
  await p.connect(); await p.connect();
  assert.deepEqual(p.restarts, ['version mismatch self-heal']);
  assert.ok(p.storage.get('st_selfheal_at'));
});
