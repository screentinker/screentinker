'use strict';

/*
 * #657 on Tizen: a layout zone paints no fill, whatever its saved background_color (every zone is
 * saved with "#000000" unless someone changes it). Painted, a full-screen zone holding a transparent
 * PNG covered every zone beneath it in black. The web player and Android paint none; wall zones keep
 * their colour (tizen-wall-zones.test.js). Same vm + DOM-shim harness as tizen-bundle-skip.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TIZEN = path.join(__dirname, '..', '..', 'tizen', 'js');

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
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, Date, JSON, Math, isFinite,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.document = { createElement: (tag) => makeEl(tag), getElementById: () => null, querySelector: () => null };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['bundle-skip.js', 'player.js']) vm.runInContext(fs.readFileSync(path.join(TIZEN, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

test('layout zones paint no background, so a transparent overlay zone shows the zones beneath', () => {
  const sb = load();
  const stage = makeEl('div');
  const zr = new sb.ZoneRenderer(stage, () => 'http://server', () => 'dev1');
  zr.render({ zones: [
    { id: 'main', x_percent: 0, y_percent: 0, width_percent: 80, height_percent: 100, z_index: 0, background_color: '#000000' },
    { id: 'frame', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, z_index: 5, background_color: '#ff0000' },
  ] }, [
    { id: 1, content_id: 'a', mime_type: 'image/jpeg', filename: 'a.jpg', duration_sec: 10, zone_id: 'main' },
    { id: 2, content_id: 'f', mime_type: 'image/png', filename: 'frame.png', duration_sec: 10, zone_id: 'frame' },
  ]);
  const zones = stage.children.filter((c) => c.tag === 'div');
  assert.equal(zones.length, 2);
  for (const z of zones) assert.equal(z.style.background, undefined, `zone z=${z.style.zIndex} paints no fill`);
});
