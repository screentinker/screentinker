'use strict';

/*
 * #649 on Tizen: a bundle's screentinker:skip, in the real tizen/js/player.js under the same vm +
 * DOM-shim harness as tizen-play-to-end.test.js. The rules are js/bundle-skip.js (a copy of
 * server/lib/bundle-skip.js, held to the shared vectors in bundle-skip.test.js); this pins who may
 * ask, what a skip does to the playlist and to proof of play, and that a zone moves alone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const TIZEN = path.join(ROOT, 'tizen', 'js');
const BUNDLE = 'application/vnd.screentinker.bundle+zip';

function makeEl(tag) {
  const el = {
    tag, style: {}, attrs: {}, children: [], _html: '', _src: '', contentWindow: null,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    querySelector(sel) { return this.children.find((c) => c.tag === sel) || null; },
    querySelectorAll(sel) { return this.children.filter((c) => c.tag === sel); },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() {}, play() { return Promise.resolve(); },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (v === '') this.children = []; } });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  if (tag === 'iframe') el.contentWindow = { postMessage() {} };
  return el;
}

function load() {
  const timers = [];
  const handlers = [];
  const logs = [];
  const sandbox = {
    console: { log: (m) => logs.push(String(m)), warn() {}, error() {} }, Date, JSON, Math, isFinite,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
    addEventListener: (n, fn) => { if (n === 'message') handlers.push(fn); }, removeEventListener() {},
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null, querySelector: () => null };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['bundle-skip.js', 'player.js']) vm.runInContext(fs.readFileSync(path.join(TIZEN, f), 'utf8'), sandbox, { filename: f });
  const send = (source, data) => { for (const h of handlers.slice()) h({ source, data }); };
  return { sb: sandbox, timers, send, logs };
}

const bundle = (id, extra = {}) => ({ id, content_id: 'c' + id, content_rev: 1, mime_type: BUNDLE, filename: `tile${id}.zip`, duration_sec: 30, ...extra });
const SKIP = (reason) => ({ type: 'screentinker:skip', reason });

function fullscreen(items, setup) {
  const h = load();
  const stage = makeEl('div');
  const player = new h.sb.PlaylistPlayer(stage, () => 'http://server', () => 'dev1');
  const events = [];
  player.onPlayEvent = (p) => events.push(p);
  if (setup) setup(player);
  player.items = items;
  player.index = 0;
  player.playCurrent();
  const frame = () => stage.children.filter((c) => c.tag === 'iframe').slice(-1)[0];
  return { ...h, stage, player, events, frame };
}

test('a skip moves the playlist on at once and retracts the play it opened', () => {
  const f = fullscreen([bundle(1), bundle(2)]);
  const first = f.frame();
  assert.equal(first.attrs.sandbox, 'allow-scripts');
  f.send(first.contentWindow, SKIP('offline\n now'));
  assert.equal(f.player.index, 1, 'advanced');
  assert.deepEqual(f.events.map((e) => [e.event, e.content_id, !!e.skipped, e.completed]), [
    ['play_start', 'c1', false, undefined],
    ['play_end', 'c1', true, false],
    ['play_start', 'c2', false, undefined],
  ], 'the start was retracted, and no completed play_end was sent for it');
  assert.ok(f.logs.some((l) => l === '[bundle] skipped "tile1.zip" — offline now'), f.logs.join('\n'));
  // The skipped item's own advance timer is gone: only the new item's 30 s one is live.
  assert.equal(f.timers.filter((t) => t.live && t.ms === 30000).length, 1);
});

test('only the bundle on screen is heard: another source, or the replaced frame, changes nothing', () => {
  const f = fullscreen([bundle(1), bundle(2), bundle(3)]);
  const first = f.frame();
  f.send({ some: 'other window' }, SKIP());
  f.send(null, SKIP());
  assert.equal(f.player.index, 0, 'a message from elsewhere is ignored');
  f.send(first.contentWindow, { type: 'screentinker:next' });
  f.send(first.contentWindow, 'screentinker:skip');
  assert.equal(f.player.index, 0, 'and so is anything that is not the skip message');
  f.send(first.contentWindow, SKIP());
  assert.equal(f.player.index, 1);
  f.send(first.contentWindow, SKIP());
  assert.equal(f.player.index, 1, 'the replaced bundle cannot skip the one after it');
});

test('once per item per pass; a normal end opens the next pass', () => {
  const f = fullscreen([bundle(1), bundle(2)]);
  f.send(f.frame().contentWindow, SKIP());
  assert.equal(f.player.index, 1);
  f.send(f.frame().contentWindow, SKIP());
  assert.equal(f.player.index, 0, 'B skipped too');
  f.send(f.frame().contentWindow, SKIP());
  assert.equal(f.player.index, 0, 'A again, in the same pass: ignored, it plays its duration');
  assert.ok(f.logs.some((l) => /skip ignored for "tile1\.zip": it already skipped this pass/.test(l)));
  // A's duration runs out (a real run), which ends the pass.
  const now = Date.now; Date.now = () => now() + 30000;
  try { f.timers.filter((t) => t.live && t.ms === 30000).slice(-1)[0].fn(); } finally { Date.now = now; }
  assert.equal(f.player.index, 1);
  f.send(f.frame().contentWindow, SKIP());
  assert.equal(f.player.index, 0, 'a new pass: B may skip again');
});

test('a one-item playlist, a wall follower, a synced group and a wall never skip', () => {
  for (const [items, setup, why] of [
    [[bundle(1)], null, 'nothing else to play'],
    [[bundle(1), bundle(2)], (p) => { p.wallFollower = true; }, 'shared clock'],
    [[bundle(1), bundle(2)], (p) => { p.scheduleDriven = true; }, 'shared clock'],
    [[bundle(1), bundle(2)], (p) => { p.wallActive = () => true; }, 'shared clock'],
  ]) {
    const f = fullscreen(items, setup);
    f.send(f.frame().contentWindow, SKIP());
    f.send(f.frame().contentWindow, SKIP());
    assert.equal(f.player.index, 0, why);
    assert.equal(f.logs.filter((l) => l.includes('skip ignored') && l.includes(why)).length, 1, `logged once: ${why}`);
    assert.ok(!f.events.some((e) => e.skipped), 'nothing retracted');
  }
});

test('in zones a skip moves only its own zone', () => {
  const h = load();
  const zr = new h.sb.ZoneRenderer(makeEl('div'), () => 'http://server');
  const left = { id: 'zl', name: 'Left', el: makeEl('div') };
  const right = { id: 'zr', name: 'Right', el: makeEl('div') };
  const shown = [];
  const real = zr.showItem.bind(zr);
  zr.showItem = (z, l, i) => { shown.push([z.id, i]); return real(z, l, i); };
  zr.showItem(left, [bundle(1, { zone_id: 'zl' }), bundle(2, { zone_id: 'zl' })], 0);
  zr.showItem(right, [bundle(3, { zone_id: 'zr' }), bundle(4, { zone_id: 'zr' })], 0);
  const lf = left.el.children.find((c) => c.tag === 'iframe');
  assert.equal(lf.attrs.sandbox, 'allow-scripts');
  h.send(lf.contentWindow, SKIP('empty'));
  assert.deepEqual(shown, [['zl', 0], ['zr', 0], ['zl', 1]], 'the left zone moved, the right did not');
  assert.ok(h.logs.some((l) => l === '[bundle] skipped "tile1.zip" in zone "Left" — empty'));
  h.send(lf.contentWindow, SKIP());
  assert.equal(shown.length, 3, 'the left zone\'s old bundle is no longer heard');
});

test('app.js: offline, a skipped play is dropped instead of queued', () => {
  const src = fs.readFileSync(path.join(TIZEN, 'app.js'), 'utf8');
  assert.match(src, /payload\.event === 'play_end' && payload\.skipped === true\) \{ offlinePlayOpen = null; return; \}/);
  const html = fs.readFileSync(path.join(ROOT, 'tizen', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/bundle-skip.js') > 0 && html.indexOf('js/bundle-skip.js') < html.indexOf('js/player.js'), 'loaded before player.js');
  assert.match(fs.readFileSync(path.join(ROOT, 'tizen', 'build-wgt.sh'), 'utf8'), /cp \.\.\/server\/lib\/bundle-skip\.js js\/bundle-skip\.js/);
});
