'use strict';

/*
 * #790: a slide in a layout zone whose data source changed went BLANK until the new slide loaded.
 * refreshZoneWidget builds the new frame hidden on top of the old one and swaps on 'load', like the
 * fullscreen renderWidgetBuffered. The real function, lifted from player/index.html, against a
 * small fake DOM.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), style: {}, attrs: {}, children: [], parentNode: null, listeners: {}, src: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
    fire(k) { (this.listeners[k] || []).forEach((fn) => fn()); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    remove() { if (this.parentNode) { const p = this.parentNode; p.children = p.children.filter((x) => x !== this); } this.parentNode = null; },
  };
  return e;
}

function load() {
  const start = PLAYER.indexOf('    function refreshZoneWidget(div, a) {');
  const end = PLAYER.indexOf('    function renderZones(container, defaultItem, prev) {', start);
  assert.ok(start > 0 && end > start, 'refreshZoneWidget is still in index.html, just above renderZones');
  const timers = [];
  const env = {
    document: { createElement: el },
    config: { serverUrl: 'https://s', deviceId: 'dev 1' },
    widgetSandboxAttr: () => 'allow-scripts',
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, PLAYER.slice(start, end) + '\nreturn refreshZoneWidget;')(...names.map((n) => env[n]));
  return { refresh: fn, timers };
}

function zoneShowing() {
  const div = el('div');
  div.__stYtToken = 4;
  const old = div.appendChild(el('iframe'));
  old.src = 'old';
  return { div, old };
}
const item = (rev) => ({ widget_id: 'w1', widget_rev: rev });

test('the old slide stays up until the new one has loaded, then is replaced', () => {
  const { refresh } = load();
  const { div, old } = zoneShowing();
  refresh(div, item(7));
  assert.equal(div.children.length, 2, 'both frames while the new one loads');
  const fresh = div.children[1];
  assert.equal(fresh.style.visibility, 'hidden');
  assert.equal(fresh.style.position, 'absolute', 'on top of the old one, not below it in flow');
  assert.match(fresh.src, /\/api\/widgets\/w1\/render\?device=dev%201&rev=7$/);
  assert.equal(fresh.attrs.sandbox, 'allow-scripts');
  assert.equal(old.parentNode, div, 'the old slide is still showing');

  fresh.fire('load');
  assert.deepEqual(div.children, [fresh], 'old removed on load');
  assert.equal(fresh.style.visibility, 'visible');
  assert.equal(fresh.style.position, '', 'back in normal flow, sized by the .zone iframe rule');
  assert.equal(div.__stItem.widget_rev, 7);
  assert.equal(div.__stWidgetSwap, null);
});

test('if the zone moved on while it loaded, the late frame is dropped, not revealed over the next item', () => {
  const { refresh } = load();
  const { div, old } = zoneShowing();
  refresh(div, item(8));
  const fresh = div.children[1];
  div.__stYtToken += 1;                     // showZoneItem ran: a different item is up now
  fresh.fire('load');
  assert.equal(fresh.parentNode, null, 'dropped');
  assert.deepEqual(div.children, [old], 'whatever the zone shows now is untouched');
});

test('a load that never comes keeps the old slide and removes the hidden frame', () => {
  const { refresh, timers } = load();
  const { div, old } = zoneShowing();
  refresh(div, item(9));
  const fresh = div.children[1];
  assert.equal(timers.length, 1);
  timers[0].fn();                           // timeout
  assert.deepEqual(div.children, [old]);
  assert.equal(div.__stWidgetSwap, null);
  fresh.fire('load');                       // a late load after the timeout does nothing
  assert.deepEqual(div.children, [old]);
});

test('two refreshes in a row: only the newest frame is ever revealed', () => {
  const { refresh, timers } = load();
  const { div, old } = zoneShowing();
  refresh(div, item(10));
  const first = div.children[1];
  refresh(div, item(11));
  const second = div.children[div.children.length - 1];
  assert.equal(first.parentNode, null, 'the superseded frame is removed');
  assert.ok(timers[0].cleared, 'and its timer cleared');
  first.fire('load');
  assert.equal(old.parentNode, div, 'a superseded load reveals nothing');
  second.fire('load');
  assert.deepEqual(div.children, [second]);
  assert.equal(div.__stItem.widget_rev, 11);
});

test('showZoneItem forgets a pending swap and records what it shows (renderZones relies on both)', () => {
  const start = PLAYER.indexOf('    function showZoneItem(zone, div, items, index, timers = zoneTimers) {');
  assert.ok(start > 0, 'showZoneItem is still in index.html');
  const body = PLAYER.slice(start, PLAYER.indexOf('\n    }\n', start));
  assert.match(body, /if \(div\.__stWidgetSwap\) \{ clearTimeout\(div\.__stWidgetSwap\.timer\); div\.__stWidgetSwap = null; \}/);
  assert.match(body, /div\.__stIdx = null; div\.__stItem = null;/);
  assert.match(body, /div\.__stIdx = index % items\.length;[^\n]*\n\s*div\.__stItem = a;/);
  const nullAt = body.indexOf('div.__stIdx = null');
  const emptyAt = body.indexOf('showZoneEmpty(');
  assert.ok(nullAt > 0 && nullAt < emptyAt, 'cleared BEFORE the empty-zone exit, so an empty zone is never refreshed into');
});
