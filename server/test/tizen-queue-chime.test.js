'use strict';

// "Now serving" chime on the TIZEN player. The queue widget (server/lib/queue/widget.js) never makes
// a sound: once per called number it posts {type:'st-queue-chime', volume, widget_id} to its parent,
// and the player decides and plays. The rules are tizen/js/queue-chime.js (tested pure below); who
// may ask and what decides silence is player.js, run for real in a node:vm context with a small DOM
// shim (same harness idea as tizen-play-to-end.test.js). Reference: the web player's playQueueChime
// (server/player/index.html) and Android QueueChime.kt.
//
// What this cannot prove: that a real Tizen panel's Web Audio makes the sound. That needs a TV.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Q = require('../../tizen/js/queue-chime.js');
const ROOT = path.join(__dirname, '..', '..');
const TIZEN = path.join(ROOT, 'tizen', 'js');

// ------------------------------------------------------------------ the rules (pure)

test('only an object of type st-queue-chime is a chime request', () => {
  assert.equal(Q.isChimeMessage({ type: 'st-queue-chime', volume: 0.5 }), true);
  for (const bad of [null, undefined, 'st-queue-chime', JSON.stringify({ type: 'st-queue-chime' }), { type: 'screentinker:skip' }, {}]) {
    assert.equal(Q.isChimeMessage(bad), false, String(bad));
  }
});

test('level: widget volume 0..1 times the media volume; garbage falls back to 0.6; clamped', () => {
  assert.equal(Q.level(0.5, null), 0.5);
  assert.equal(Q.level(0.5, 0.5), 0.25);
  assert.equal(Q.level(2, null), 1);
  assert.equal(Q.level(-1, null), 0);
  assert.equal(Q.level('abc', null), 0.6);
  assert.equal(Q.level(undefined, null), 0.6);
  assert.equal(Q.level(1, 3), 1, 'media volume clamped');
  assert.equal(Q.level(1, 0), 0, 'media volume 0 silences');
});

test('silent: follower always; the live toggle wins over the item flag', () => {
  assert.equal(Q.silent({ follower: true, liveMuted: false, itemMuted: false }), true);
  assert.equal(Q.silent({ itemMuted: true }), true);
  assert.equal(Q.silent({ itemMuted: false }), false);
  assert.equal(Q.silent({ liveMuted: false, itemMuted: true }), false, 'operator un-muted live');
  assert.equal(Q.silent({ liveMuted: true, itemMuted: false }), true, 'operator muted live');
  assert.equal(Q.silent(null), false);
});

test('decide: muted, zero volume and the 3 s gap each refuse; only a played chime takes the gap', () => {
  const g = new Q.Gate();
  assert.equal(Q.decide({ silent: true, volume: 1, now: 1000, gate: g }).why, 'muted');
  assert.equal(Q.decide({ silent: false, volume: 0, now: 1000, gate: g }).why, 'volume');
  assert.equal(g.at, null, 'a refused request does not hold off the next one');
  const ok = Q.decide({ silent: false, volume: 0.8, mediaVolume: 0.5, now: 1000, gate: g });
  assert.deepEqual([ok.play, ok.level], [true, 0.4]);
  assert.equal(Q.decide({ silent: false, volume: 1, now: 1000 + Q.GAP_MS - 1, gate: g }).why, 'gap');
  assert.equal(Q.decide({ silent: false, volume: 1, now: 1000 + Q.GAP_MS, gate: g }).play, true);
});

function fakeCtx(state = 'running') {
  const log = { oscs: [], ramps: [], sets: [], resumed: 0 };
  const ctx = {
    state, currentTime: 10, destination: { dest: true },
    resume() { log.resumed++; ctx.state = 'running'; return Promise.resolve(); },
    createOscillator() {
      const o = { type: '', frequency: { value: 0 }, connect() {}, start(t) { o.startAt = t; }, stop(t) { o.stopAt = t; } };
      log.oscs.push(o); return o;
    },
    createGain() {
      return {
        gain: { setValueAtTime: (v, t) => log.sets.push([v, t]), exponentialRampToValueAtTime: (v, t) => log.ramps.push([v, t]) },
        connect() {},
      };
    },
  };
  return { ctx, log };
}

test('play: 880 Hz for 0.35 s, then 660 Hz at 0.38 s for 0.5 s, ramp 0.0001 -> 0.5*v -> 0.0001, never looped', () => {
  const { ctx, log } = fakeCtx();
  Q.play(ctx, 0.8);
  assert.equal(log.oscs.length, 2);
  const t0 = 10.02;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.equal(log.oscs[0].frequency.value, 880); assert.equal(log.oscs[0].type, 'sine');
  assert.ok(near(log.oscs[0].startAt, t0)); assert.ok(near(log.oscs[0].stopAt, t0 + 0.35 + 0.05));
  assert.equal(log.oscs[1].frequency.value, 660);
  assert.ok(near(log.oscs[1].startAt, t0 + 0.38)); assert.ok(near(log.oscs[1].stopAt, t0 + 0.38 + 0.5 + 0.05));
  assert.ok(near(log.sets[0][0], 0.0001) && near(log.sets[0][1], t0));
  assert.ok(near(log.ramps[0][0], 0.4) && near(log.ramps[0][1], t0 + 0.02));
  assert.ok(near(log.ramps[1][0], 0.0001) && near(log.ramps[1][1], t0 + 0.35));
  assert.ok(near(log.ramps[3][1], t0 + 0.38 + 0.5));
  assert.ok(!log.oscs.some((o) => 'loop' in o), 'oscillators have no loop');
});

test('play: a suspended context is resumed first; one that will not run plays nothing', async () => {
  const a = fakeCtx('suspended');
  Q.play(a.ctx, 1);
  assert.equal(a.log.oscs.length, 0, 'nothing scheduled before the resume settles');
  await new Promise((r) => setImmediate(r));
  assert.equal(a.log.resumed, 1);
  assert.equal(a.log.oscs.length, 2);

  const b = fakeCtx('suspended');
  b.ctx.resume = () => Promise.reject(new Error('no'));
  Q.play(b.ctx, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.log.oscs.length, 0);

  const c = fakeCtx();
  Q.play(c.ctx, 0);
  assert.equal(c.log.oscs.length, 0, 'level 0 plays nothing');
});

// ------------------------------------------------------------------ the real player.js

function makeEl(tag) {
  const el = {
    tag, style: {}, attrs: {}, children: [], parentNode: null, _html: '', _src: '', contentWindow: null,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    // A browser discards a removed iframe's window: contentWindow becomes null.
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; if (c.tag === 'iframe') c.contentWindow = null; return c; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.tag === sel) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {}, pause() {}, play() { return Promise.resolve(); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      if (v === '') {
        const drop = (n) => n.children.forEach((c) => { c.parentNode = null; if (c.tag === 'iframe') c.contentWindow = null; drop(c); });
        drop(this); this.children = [];
      }
    },
  });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  if (tag === 'iframe') el.contentWindow = { postMessage() {} };
  return el;
}

function load() {
  const handlers = [];
  const ctxs = [];
  let now = 1000000;
  const FakeDate = { now: () => now };
  const sandbox = {
    console, JSON, Math, isFinite, Promise, Date: FakeDate,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
    addEventListener: (n, fn) => { if (n === 'message') handlers.push(fn); },
    removeEventListener() {},
    AudioContext: function () { const f = fakeCtx(); ctxs.push(f); return f.ctx; },
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null, querySelector: () => null, body: makeEl('body') };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['play-to-end.js', 'queue-chime.js', 'player.js']) {
    vm.runInContext(fs.readFileSync(path.join(TIZEN, f), 'utf8'), sandbox, { filename: f });
  }
  return {
    sb: sandbox, ctxs,
    send(source, data) { for (const h of handlers.slice()) h({ source, data }); },
    tick(ms) { now += ms; },
    played() { return ctxs.reduce((n, c) => n + c.log.oscs.length / 2, 0); },
  };
}

const widget = (extra = {}) => ({ id: 1, widget_id: 'q1', widget_type: 'queue', duration_sec: 10, ...extra });
const MSG = { type: 'st-queue-chime', volume: 0.6, widget_id: 'q1' };

function fullscreen(items, setup) {
  const h = load();
  const stage = makeEl('div');
  const player = new h.sb.PlaylistPlayer(stage, () => 'http://server');
  player._logPlay = () => {};
  if (setup) setup(player);
  player.items = items;
  player.index = 0;
  player.playCurrent();
  const frame = stage.children.find((c) => c.tag === 'iframe');
  return { ...h, stage, player, frame };
}

test('full screen: the widget frame the player mounted chimes; once per 3 s', () => {
  const f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })]);
  assert.ok(f.frame && /\/api\/widgets\/q1\/render/.test(f.frame.src), 'the widget is framed');
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 1);
  assert.equal(f.ctxs.length, 1);
  const ramp = f.ctxs[0].log.ramps[0][0];
  assert.ok(Math.abs(ramp - 0.5 * 0.6) < 1e-9, 'level = widget volume (no media volume set)');

  f.tick(2999); f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 1, 'within 3 s: no second chime');
  f.tick(1); f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 2, 'after 3 s it chimes again');
  assert.equal(f.ctxs.length, 1, 'one AudioContext, reused');
});

test('full screen: a message from anything but a mounted widget frame is ignored', () => {
  const f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })]);
  f.send({ stranger: true }, MSG);
  f.send(null, MSG);
  f.send(f.frame.contentWindow, { type: 'something-else' });
  f.send(f.frame.contentWindow, JSON.stringify(MSG));
  assert.equal(f.played(), 0);
});

test('full screen: the item\'s mute, a wall follower and a muted media volume keep it silent', () => {
  let f = fullscreen([widget({ muted: 1 }), widget({ id: 2, widget_id: 'q2' })]);
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 0, 'item muted');

  f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })], (p) => { p.wallFollower = true; });
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 0, 'wall follower');

  f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })]);
  f.sb.__stChimeMediaVolume = () => 0;
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 0, 'media volume 0');
  f.sb.__stChimeMediaVolume = () => 0.5;
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 1);
  assert.ok(Math.abs(f.ctxs[0].log.ramps[0][0] - 0.5 * 0.6 * 0.5) < 1e-9, 'scaled by the media volume');

  f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })]);
  f.send(f.frame.contentWindow, { ...MSG, volume: 0 });
  assert.equal(f.played(), 0, 'volume 0 plays nothing');
});

test('full screen: the operator\'s live mute (device:mute-changed) silences it, and un-muting restores it', () => {
  const f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2' })]);
  f.sb.stNoteLiveMute({ content_id: null, widget_id: 'q1', muted: true });
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 0);
  f.sb.stNoteLiveMute({ content_id: null, widget_id: 'q1', muted: false });
  f.send(f.frame.contentWindow, MSG);
  assert.equal(f.played(), 1);
});

test('full screen: once the playlist has moved on, the outgoing frame no longer chimes', () => {
  const f = fullscreen([widget(), widget({ id: 2, widget_id: 'q2', widget_type: 'clock' })]);
  const old = f.frame;
  f.player.index = 1;
  f.player.playCurrent();
  f.send(old.contentWindow, MSG);   // still mounted during the anti-flash swap
  assert.equal(f.played(), 0);
});

test('zones: a zone widget frame chimes; its item mute silences it; a cleared zone does not', () => {
  const h = load();
  const zr = new h.sb.ZoneRenderer(makeEl('div'), () => 'http://server');
  const zoneEl = makeEl('div');
  zr.showItem({ id: 'z1', el: zoneEl }, [widget({ zone_id: 'z1' })], 0);
  const frame = zoneEl.children.find((c) => c.tag === 'iframe');
  assert.ok(frame, 'the widget is framed in the zone');
  const win = frame.contentWindow;
  h.send(win, MSG);
  assert.equal(h.played(), 1);

  zoneEl.innerHTML = '';             // the zone moved on / was cleared: the frame's window is gone
  h.tick(5000);
  h.send(win, MSG);
  assert.equal(h.played(), 1);

  const z2 = makeEl('div');
  zr.showItem({ id: 'z2', el: z2 }, [widget({ zone_id: 'z2', muted: 1 })], 0);
  h.send(z2.children.find((c) => c.tag === 'iframe').contentWindow, MSG);
  assert.equal(h.played(), 1, 'muted zone item');
});

test('wall zones: only the panel that voices the zone chimes', () => {
  for (const [audioZones, want] of [[['a'], 1], [[], 0]]) {
    const h = load();
    const stage = makeEl('div');
    const wz = new h.sb.WallZoneRenderer(stage, () => 'http://srv', () => 'dev1', () => 5000);
    const layout = { id: 'L', zones: [{ id: 'a', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 0 }] };
    wz.render(layout, [widget({ zone_id: 'a', sort_order: 0 })], {
      wall_id: 'w1', canvas_layout: true, screen_rect: { x: 0, y: 0, w: 1920, h: 1080 },
      player_rect: { x: 0, y: 0, w: 1920, h: 1080 }, audio_zones: audioZones,
    });
    const frame = stage.querySelectorAll('iframe')[0];
    assert.ok(frame, 'the widget is framed in the wall zone');
    h.send(frame.contentWindow, MSG);
    assert.equal(h.played(), want, 'audio_zones=' + JSON.stringify(audioZones));
  }
});

test('packaging: index.html loads queue-chime.js before player.js; app.js wires the live mute and volume', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tizen', 'index.html'), 'utf8');
  const a = html.indexOf('js/queue-chime.js'), b = html.indexOf('js/player.js');
  assert.ok(a > 0 && a < b);
  const app = fs.readFileSync(path.join(TIZEN, 'app.js'), 'utf8');
  assert.match(app, /stNoteLiveMute\(data\)/);
  assert.match(app, /window\.__stChimeMediaVolume = function/);
});

test('ES5: no arrow functions, let/const, template literals or classes in queue-chime.js', () => {
  // No ES parser is installed in server/ (acorn lives only in samsung-sssp3's devDependencies), so
  // this is a token check on the source with comments removed. The vm runs above execute the code.
  const src = fs.readFileSync(path.join(TIZEN, 'queue-chime.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'])\/\/.*$/gm, '$1');
  for (const [re, what] of [[/=>/, 'arrow'], [/\b(let|const|class)\s/, 'let/const/class'], [/`/, 'template literal']]) {
    assert.doesNotMatch(src, re, what);
  }
});
