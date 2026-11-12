'use strict';

/*
 * #845, the web player's side: an emergency / automation trigger outranks a screen share. The share
 * overlay (z-index 2147483100) and its "share your screen" QR draw above everything, including the
 * trigger layer, so while a trigger is on screen the player calls STScreenShare.suppress(true):
 * every share is hidden and silent (still connected), the QR is off, and both come back when the
 * trigger clears. The REAL receiver (lib/screen-share-player.js) runs here against a small DOM.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RECEIVER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screen-share-player.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const LEGACY = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');

function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, attrs: {}, id: '', textContent: '',
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, play() { return Promise.resolve(); }, clientWidth: 1920, clientHeight: 1080,
  };
  let css = '';
  Object.defineProperty(e.style, 'cssText', { get() { return css; }, set(v) { css = v; e.style.display = /display:\s*none/.test(v) ? 'none' : (/display:\s*flex/.test(v) ? 'flex' : e.style.display); } });
  return e;
}

function world() {
  const body = el('body');
  const byId = () => null;
  const document = {
    body, createElement: el,
    getElementById(id) { const walk = (n) => { if (n.id === id) return n; for (const c of n.children) { const f = walk(c); if (f) return f; } return null; }; return walk(body); },
  };
  class FakePC { addTransceiver() {} createOffer() { return new Promise(() => {}); } close() {} }
  class FakeWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const sandbox = {
    console: { log() {}, warn() {} }, document, setTimeout: () => 0, clearTimeout() {}, Date, JSON, Math, String, Number,
    RTCPeerConnection: FakePC, WebSocket: FakeWS, MediaStream: function () {}, location: { protocol: 'http:', host: 'x' },
    addEventListener() {}, innerWidth: 1920, innerHeight: 1080, byId,
  };
  FakePC.prototype.addTransceiver = function () {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RECEIVER, sandbox);
  return { SS: sandbox.STScreenShare, document };
}

const start = (SS, id) => SS.start({ deviceId: 'd', deviceToken: 't', sessionId: id, sharedBy: 'Pat', labels: {} });

test('suppress hides every share and silences it, keeps it connected, and brings it back as it was', () => {
  const { SS, document } = world();
  start(SS, 's1'); start(SS, 's2');
  const overlay = document.getElementById('st-share-overlay');
  assert.ok(overlay, 'the shares are on screen');
  const audios = overlay.children.map((t) => t.children[1]);
  assert.deepEqual(audios.map((a) => a.muted), [true, false], 'the newest presenter is heard');
  SS.suppress(true);
  assert.equal(overlay.style.visibility, 'hidden', 'the alert is not covered');
  assert.ok(audios.every((a) => a.muted), 'and no share sound plays over it');
  assert.equal(SS.count(), 2, 'both shares are still connected');
  assert.equal(SS.tilesOnScreen().length, 0, 'the remote view shows the alert too');
  SS.suppress(false);
  assert.equal(overlay.style.visibility, '');
  assert.deepEqual(audios.map((a) => a.muted), [true, false], 'the same presenter is heard again');
  assert.equal(SS.tilesOnScreen().length, 2);
});

test('the "share your screen" QR is off while suppressed and back after; a share started during the alert starts hidden', () => {
  const { SS, document } = world();
  SS.showCode({ code: 'ABCD-1234', url: '/share', qr: null }, {});
  const badge = document.getElementById('st-share-code');
  assert.equal(badge.style.display, 'flex');
  SS.suppress(true);
  assert.equal(badge.style.display, 'none', 'no QR over the alert');
  SS.showCode({ code: 'WXYZ-5678', url: '/share', qr: null }, {});
  assert.equal(badge.style.display, 'none', 'a fresh code during the alert stays hidden');
  start(SS, 's3');
  assert.equal(document.getElementById('st-share-overlay').style.visibility, 'hidden', 'a share that starts mid-alert is hidden');
  SS.suppress(false);
  assert.equal(badge.style.display, 'flex', 'the QR is back after the alert');
  assert.equal(document.getElementById('st-share-overlay').style.visibility, '');
});

test('the player drives it from the one trigger state sync, for every trigger (index.html and the legacy build)', () => {
  for (const [name, src] of [['index.html', HTML], ['legacy.html', LEGACY]]) {
    const at = src.indexOf('function triggerSyncAudio()');
    assert.ok(at > 0, name);
    const body = src.slice(at, src.indexOf('\n    }', at));
    assert.match(body, /STScreenShare\.suppress\(!!triggerActive\)/, name + ': suppress follows triggerActive');
  }
});
