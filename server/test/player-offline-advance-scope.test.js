'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OfflinePlayQueue = require('../lib/offline-play-queue');
const HTML = fs.readFileSync(path.join(__dirname, '../player/index.html'), 'utf8');

function extract(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`Unbalanced function ${name}`);
}

// Run the shipped playback functions, preserving the queue's enclosing scope. Rendering and
// transport are fakes; the advancement callback and reporting code are the actual player code.
function player({ connected = false, preview = false, storageBroken = false, queueMissing = false } = {}) {
  const timers = new Map(), stored = new Map(), rendered = [], events = [];
  let id = 0;
  const scope = {
    OfflinePlayQueue, console: { log() {} },
    localStorage: {
      getItem: k => { if (storageBroken) throw new Error('storage unavailable'); return stored.get(k); },
      setItem: (k, v) => { if (storageBroken) throw new Error('storage unavailable'); stored.set(k, v); },
    },
    socket: { connected, emit: (...args) => events.push(args) }, config: { deviceId: 'test-pi' },
    playlist: [{ widget_id: 'welcome', duration_sec: 5 }, { content_id: 'slide-2', duration_sec: 8 }],
    currentIndex: 0, PREVIEW_MODE: preview, wallConfig: null, deferredRotation: false,
    advanceTimer: null, currentItemStartedAt: 0,
    hideStatus() {}, applySlideAudio() {}, shouldLogPlay: () => true,
    postPreviewState() {}, commitNextIndex: i => (i + 1) % 2, clearLookahead() {},
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: key => timers.delete(key), rendered,
  };
  if (queueMissing) delete scope.OfflinePlayQueue;   // offline-play-queue.js failed to load
  vm.createContext(scope);
  const queueStart = HTML.indexOf('let offlinePlayOpen = null;');
  const declarations = HTML.slice(queueStart, HTML.indexOf('function persistOfflinePlays()', queueStart));
  const queueCode = declarations + ['persistOfflinePlays', 'queueOfflinePlay', 'flushOfflinePlays'].map(extract).join('\n');
  const shared = queueStart < HTML.indexOf('function connect(serverUrl)');
  const initialization = shared ? `${queueCode}\nfunction connectQueue() {}` : `function connectQueue() { ${queueCode} }`;
  vm.runInContext(`${initialization}\n${['scheduleAdvance', 'playCurrentItem', 'nextItem'].map(extract).join('\n')}
    function renderContent(item) { rendered.push(currentIndex); scheduleAdvance(nextItem, item.duration_sec * 1000); }
  `, scope);
  return {
    scope, timers, rendered, stored, events,
    run: source => vm.runInContext(source, scope),
    advance() {
      const [key, timer] = [...timers.entries()][0] || [];
      assert.ok(timer, 'there is a next-slide timer');
      timers.delete(key);
      timer.fn();
    },
  };
}

test('offline queue is initialized in player scope before cached playlist boot', () => {
  const at = HTML.indexOf('let offlinePlayOpen = null;');
  assert.ok(at < HTML.indexOf('==================== Boot ===================='));
  assert.ok(at < HTML.indexOf('function connect(serverUrl)'));
});

test('cached welcome slide advances before a server connection and persists completed plays', () => {
  const p = player();
  p.run('playCurrentItem(); connectQueue();');
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0]);
  assert.equal(p.timers.size, 1);
  const plays = JSON.parse(p.stored.get('st_offline_plays'));
  assert.equal(plays.length, 2);
  assert.equal(plays[0].widget_id, 'welcome');
  assert.equal(plays[1].content_id, 'slide-2');
  assert.ok(plays.every(play => play.completed));
});

test('losing the connection during an online play does not stop advancement', () => {
  const p = player({ connected: true });
  p.run('connectQueue(); playCurrentItem();');
  p.advance();
  p.scope.socket.connected = false;
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0, 1]);
  assert.equal(p.timers.size, 1);
  assert.equal(JSON.parse(p.stored.get('st_offline_plays')).length, 1,
    'do not invent an offline start for the item that began online');
});

test('reconnecting does not replace the queue or strand an open offline play', () => {
  const p = player();
  p.run('connectQueue(); playCurrentItem();');
  p.advance();
  p.run('connectQueue();');
  p.advance();
  assert.equal(JSON.parse(p.stored.get('st_offline_plays')).length, 2);
});

test('online playback continues to emit start/end records', () => {
  const p = player({ connected: true });
  p.run('connectQueue(); playCurrentItem();');
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0]);
  assert.equal(p.events.filter(([, data]) => data.event === 'play_start').length, 3);
  assert.equal(p.events.filter(([, data]) => data.event === 'play_end').length, 2);
  assert.equal(p.stored.size, 0);
});

test('preview advances without generating proof-of-play records', () => {
  const p = player({ preview: true });
  p.run('playCurrentItem();');
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0]);
  assert.equal(p.stored.size, 0);
  assert.equal(p.events.length, 0);
});

test('unavailable storage cannot stop offline playback', () => {
  const p = player({ storageBroken: true });
  p.run('connectQueue(); playCurrentItem();');
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0]);
  assert.equal(p.timers.size, 1);
});

test('a missing offline-play-queue.js cannot stop the player: playback advances, reporting is skipped', () => {
  const p = player({ queueMissing: true });
  p.run('connectQueue(); playCurrentItem();');
  p.advance(); p.advance();
  assert.deepEqual(p.rendered, [0, 1, 0]);
  assert.equal(p.timers.size, 1);
  assert.equal(p.stored.size, 0, 'nothing queued without the queue');
  p.scope.socket.connected = true;
  p.run('flushOfflinePlays();');
  assert.equal(p.events.length, 0);
});
