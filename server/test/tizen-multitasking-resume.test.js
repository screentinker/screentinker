'use strict';

// Samsung certification CO-MT-01: "When the application resumes, media playback resumes in the
// same state." The platform pauses <video> and the AVPlay session when the app is hidden (Smart
// Hub, source change) and nothing restarted them — a single looping video came back as a frozen
// frame, which is the exact test a Samsung QA tester runs. These pin PlaylistPlayer.suspend() /
// resume() through the same vm + DOM-shim harness as pip-overlay.test.js (no jsdom in the repo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl(tag) {
  const el = {
    tag, style: {}, className: '', attrs: {}, children: [], _html: '', _src: '', paused: true, ended: false,
    played: 0, pauses: 0, rejectPlay: false,
    appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) { return this.children.find((c) => c.tag === sel) || null; },
    querySelectorAll(sel) { const tags = sel.split(',').map((s) => s.trim()); return this.children.filter((c) => tags.includes(c.tag)); },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    load() {},
    pause() { this.paused = true; this.pauses++; },
    play() {
      this.played++;
      if (this.rejectPlay) return Promise.reject(new Error('NotAllowedError'));
      this.paused = false; return Promise.resolve();
    },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; if (v === '') this.children = []; } });
  Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
  return el;
}

function load(webapis) {
  const sandbox = {
    console, Date,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null };
  sandbox.window = sandbox;
  if (webapis) sandbox.webapis = webapis;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'player.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'player.js' });
  return sandbox;
}

test('a looping <video> paused by the platform on hide is played again on show', async () => {
  const sb = load();
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  const v = makeEl('video'); v.paused = false; stage.appendChild(v);   // "playing", as the platform sees it

  player.suspend();
  assert.equal(v.paused, true, 'hide: paused');
  assert.equal(v.pauses, 1);

  let replayed = 0;
  player.resume(() => { replayed++; });
  await Promise.resolve();
  assert.equal(v.played, 1, 'show: play() called on the element we paused');
  assert.equal(v.paused, false);
  assert.equal(replayed, 0, 'no re-mount needed when play() succeeds');
});

test('an element that was already paused before hiding is left alone on show', async () => {
  const sb = load();
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  const v = makeEl('video'); v.paused = true; stage.appendChild(v);
  player.suspend();
  assert.equal(v.pauses, 0);
  player.resume(() => {});
  await Promise.resolve();
  assert.equal(v.played, 0, 'we only resume what we paused');
});

test('a video that ended while hidden, or whose play() is refused, is re-mounted via onReplay', async () => {
  const sb = load();
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  const ended = makeEl('video'); ended.paused = false; stage.appendChild(ended);
  player.suspend();
  ended.ended = true;
  let replayed = 0;
  player.resume(() => { replayed++; });
  assert.equal(replayed, 1, 'ended -> re-mount');

  const stage2 = makeEl('div');
  const p2 = new sb.PlaylistPlayer(stage2, () => 'http://server');
  const refused = makeEl('video'); refused.paused = false; refused.rejectPlay = true; stage2.appendChild(refused);
  p2.suspend();
  let replayed2 = 0;
  p2.resume(() => { replayed2++; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(replayed2, 1, 'play() rejected -> re-mount');
});

test('an AVPlay session is suspended and restored through the Samsung API, not <video>', () => {
  const calls = [];
  const sb = load({ avplay: { suspend() { calls.push('suspend'); }, restore() { calls.push('restore'); } } });
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  player.avActive = true;
  player.suspend();
  let replayed = 0;
  player.resume(() => { replayed++; });
  assert.deepEqual(calls, ['suspend', 'restore']);
  assert.equal(replayed, 0);
});

test('a failed AVPlay restore falls back to re-mounting the item', () => {
  const sb = load({ avplay: { suspend() {}, restore() { throw new Error('InvalidStateError'); } } });
  const player = new sb.PlaylistPlayer(makeEl('div'), () => 'http://server');
  player.avActive = true;
  player.suspend();
  let replayed = 0;
  player.resume(() => { replayed++; });
  assert.equal(replayed, 1);
});

test('resume() without a prior suspend() is a no-op', () => {
  const sb = load();
  const stage = makeEl('div');
  const player = new sb.PlaylistPlayer(stage, () => 'http://server');
  const v = makeEl('video'); v.paused = false; stage.appendChild(v);
  let replayed = 0;
  player.resume(() => { replayed++; });
  assert.equal(v.played, 0);
  assert.equal(replayed, 0);
});
