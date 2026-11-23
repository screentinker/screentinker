'use strict';

/*
 * The Curbside widget editor (frontend/js/components/curbside-widget-editor.js), run in Node with a
 * tiny fake DOM. Regression: saving before the location list has loaded must keep the widget's
 * location, not send '' and unlink it.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EDITOR = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'components', 'curbside-widget-editor.js')).href;

function fakeDocument() {
  const all = [];
  const node = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(), children: [], attrs: {}, dataset: {}, style: {}, checked: false, _text: '', _value: undefined,
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'value') this._value = String(v); if (k === 'checked') this.checked = true; },
      getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
      addEventListener() {},
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? fakeText(c) : c); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this.children = []; this._text = String(v); },
      // A <select>'s value is its selected option's; setting it selects the matching option.
      get value() {
        if (this.tagName === 'SELECT') {
          const opts = this.children.filter((c) => c.tagName === 'OPTION');
          const sel = opts.find((o) => o.selected) || opts[0];
          return sel ? sel.value : '';
        }
        if (this.tagName === 'OPTION') return this._value !== undefined ? this._value : this.textContent;
        return this._value !== undefined ? this._value : '';
      },
      set value(v) {
        if (this.tagName === 'SELECT') { for (const o of this.children) o.selected = o.value === String(v); return; }
        this._value = String(v);
      },
    };
    all.push(n);
    return n;
  };
  const fakeText = (s) => ({ textContent: s, tagName: '#text', children: [] });
  return {
    createElement: node,
    createTextNode: fakeText,
    getElementById: (id) => all.find((n) => n.id === id) || null,
    documentElement: { setAttribute() {} },
  };
}

let editor;
before(async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.document = fakeDocument();
  editor = await import(EDITOR);
});

test('saving while the location list is still loading keeps the widget\'s location', async () => {
  globalThis.document = fakeDocument();
  const box = document.createElement('div');
  // The list never arrives (a slow server): the person presses Save now.
  editor.mountCurbsideEditor(box, { location_id: 'loc-1', chime: true }, { get: () => new Promise(() => {}) });
  await new Promise((r) => setImmediate(r));
  const cfg = editor.readCurbsideConfig();
  assert.equal(cfg.location_id, 'loc-1');
  assert.equal(cfg.chime, true);
});

test('once the list loads, the saved location is selected; a new widget with one location gets it', async () => {
  globalThis.document = fakeDocument();
  const box = document.createElement('div');
  await editor.mountCurbsideEditor(box, { location_id: 'loc-2' }, { get: async () => [{ id: 'loc-1', name: 'A' }, { id: 'loc-2', name: '<b>B</b>' }] });
  assert.equal(editor.readCurbsideConfig().location_id, 'loc-2');
  const opt = document.getElementById('wCurbLoc').children.find((o) => o.value === 'loc-2');
  assert.equal(opt.textContent, '<b>B</b>', 'a location name is option text, never HTML');

  globalThis.document = fakeDocument();
  const box2 = document.createElement('div');
  await editor.mountCurbsideEditor(box2, {}, { get: async () => [{ id: 'only', name: 'Only' }] });
  assert.equal(editor.readCurbsideConfig().location_id, 'only');
});

test('a new widget saved before the list loads has no location (nothing to keep)', async () => {
  globalThis.document = fakeDocument();
  const box = document.createElement('div');
  editor.mountCurbsideEditor(box, {}, { get: () => new Promise(() => {}) });
  await new Promise((r) => setImmediate(r));
  assert.equal(editor.readCurbsideConfig().location_id, '');
});
