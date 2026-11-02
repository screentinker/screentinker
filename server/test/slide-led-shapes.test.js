'use strict';

/*
 * Slide shapes for LED strips and matrices: 8:1, 1:8, 16:1, 1:16, a custom W:H, and the LED grid the
 * editor draws over the canvas. The aspect goes into a CSS aspect-ratio in the editor and into the
 * renderer's fitter, so both sides hold it to the same rule: a preset, or two whole numbers 1-99.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const deck = require('../lib/slide-deck');

const EDITOR = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'slides.js'), 'utf8');

test('the LED presets are offered by the editor and kept by the server', () => {
  for (const a of ['8:1', '1:8', '16:1', '1:16', '4:1', '1:4']) {
    assert.ok(deck.ASPECTS.includes(a), `server keeps ${a}`);
    assert.ok(EDITOR.includes(`['${a}', '`), `editor offers ${a}`);
    assert.equal(deck.normalizeDeck({ aspect: a, slides: [] }).aspect, a);
  }
  // Every editor preset survives a save: a shape the server dropped would revert to 16:9 on save.
  const editorPresets = [...EDITOR.slice(EDITOR.indexOf('const ASPECT_CHOICES'), EDITOR.indexOf('const CUSTOM_ASPECT_RE'))
    .matchAll(/\['(\d+:\d+)', '/g)].map((m) => m[1]);
  assert.ok(editorPresets.length >= 17, editorPresets.join(','));
  for (const a of editorPresets) assert.ok(deck.ASPECTS.includes(a), `server keeps the editor preset ${a}`);
});

test('a custom shape is two whole numbers from 1 to 99, anything else is 16:9', () => {
  assert.equal(deck.normalizeAspect('64:8'), '64:8', 'not reduced: what was typed comes back');
  assert.equal(deck.normalizeAspect('99:1'), '99:1');
  assert.equal(deck.normalizeAspect('7:3'), '7:3');
  for (const bad of ['0:1', '1:0', '100:1', '1:100', '05:1', '1.5:1', '-4:1', '16/9', '16:9;background:red', 'x:y', '', null, undefined, 42]) {
    assert.equal(deck.normalizeAspect(bad), '16:9', String(bad));
  }
  assert.equal(deck.normalizeDeck({ aspect: '12:5', slides: [] }).aspect, '12:5');
});

test('the renderer and the accessibility check parse every shape the deck can hold', () => {
  const render = fs.readFileSync(path.join(__dirname, '..', 'lib', 'slide-render.js'), 'utf8');
  const re = new RegExp(/const ASPECT_RE = \/(.+)\/;/.exec(render)[1]);
  for (const a of [...deck.ASPECTS, '99:99', '64:8', '1:99']) assert.ok(re.test(a), `renderer takes ${a}`);
});

test('the LED grid is kept when it is a real LED size, and dropped otherwise', () => {
  assert.deepEqual(deck.normalizeDeck({ led_grid: { cols: 64, rows: 8 }, slides: [] }).led_grid, { cols: 64, rows: 8 });
  assert.deepEqual(deck.normalizeLedGrid({ cols: 512, rows: 32 }), { cols: 512, rows: 32 }, '16384 LEDs, the profile limit');
  assert.deepEqual(deck.normalizeLedGrid({ cols: 300, rows: 1 }), { cols: 300, rows: 1 }, 'a one-row strip');
  for (const bad of [null, 'x', {}, { cols: 0, rows: 8 }, { cols: 8, rows: 513 }, { cols: 512, rows: 33 }, { cols: 8.5, rows: 8 }, { cols: '64px', rows: 8 }]) {
    assert.equal(deck.normalizeLedGrid(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(deck.normalizeLedGrid({ cols: '64', rows: '8' }), { cols: 64, rows: 8 }, 'numeric strings are stored as numbers');
  // Extra keys never ride along into the stored deck.
  assert.deepEqual(deck.normalizeLedGrid({ cols: 32, rows: 8, style: 'x' }), { cols: 32, rows: 8 });
  // Saving twice changes nothing (the editor saves what it loaded).
  const once = deck.normalizeDeck({ aspect: '16:1', led_grid: { cols: 128, rows: 8 }, slides: [] });
  assert.deepEqual(deck.normalizeDeck(once), once);
});

test('the editor caps a tall canvas by height and draws the grid under the selection handles', () => {
  assert.match(EDITOR, /stage\.style\.width = `min\(100%, calc\(72vh \* \$\{aw\} \/ \$\{ah\}\)\)`/);
  assert.match(EDITOR, /paintLedGrid\(stage\);\s*\n\s*\/\/ Selection chrome goes on last/);
  assert.match(EDITOR, /pointer-events:none;z-index:4;/, 'the grid never takes a click, and sits below the overlay (z-index 5)');
  assert.match(EDITOR, /const LED_GRID_MAX_SIDE = 512;\s*\nconst LED_GRID_MAX_LEDS = 16384;/);
});

test('changing the shape starts the LED grid again for the new shape; matching a screen sets both', () => {
  const handler = EDITOR.slice(EDITOR.indexOf("querySelector('#aspectSel').addEventListener('change'"), EDITOR.indexOf("const onCustomAspect"));
  assert.match(handler, /if \(ledGrid\(\)\) state\.deck\.doc\.led_grid = suggestedLedGrid\(\);/);
  const match = EDITOR.slice(EDITOR.indexOf("querySelector('#ledMatch').addEventListener"), EDITOR.indexOf("querySelector('#ledMatch').addEventListener") + 900);
  assert.match(match, /led_grid = \{ cols: scr\.cols, rows: scr\.rows \}/);
  assert.match(match, /aspectForGrid\(scr\.cols, scr\.rows\)/);
});
