'use strict';

/*
 * The bundled font set.
 *
 * ⚠️ TWO KINDS OF PROPERTY HERE, AND THE SECOND IS THE UNUSUAL ONE.
 *
 * The ordinary kind: a slide asks for a family and gets it, an unknown name resolves rather than
 * breaking, only the families actually used are emitted.
 *
 * The unusual kind: LICENCE OBLIGATIONS. These fonts are redistributed by every install — the
 * server ships the file to every player that renders a slide — and the SIL OFL permits that on
 * conditions, chief among them that the licence travels with the fonts. scripts/license-check.js
 * cannot help: it scans npm dependencies, and a .woff2 in server/fonts is invisible to it. So the
 * closest thing to a mechanical check is here, asserting every declared family has both its files
 * and its OFL text actually present on disk.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../lib/slide-fonts');
const { renderSlideHtml, normalizeSlide } = require('../lib/slide-render');

// ===== licence obligations =====

test('⚠️ every bundled family ships its files AND its OFL licence text', () => {
  const missing = [];
  for (const [id, f] of Object.entries(F.FAMILIES)) {
    for (const rel of [`${f.file}.woff2`, `${f.file}-ext.woff2`, f.ofl]) {
      const p = path.join(F.FONT_DIR, rel);
      if (!fs.existsSync(p)) { missing.push(`${id}: ${rel}`); continue; }
      if (fs.statSync(p).size === 0) missing.push(`${id}: ${rel} is empty`);
    }
  }
  assert.deepEqual(missing, [],
    'a family is declared without the bytes or the licence that must travel with them:\n' + missing.join('\n'));
});

test('⚠️ the shipped files really are woff2, not something renamed', () => {
  // A .woff2 that is actually a .ttf loads nowhere and fails silently to the fallback.
  for (const f of Object.values(F.FAMILIES)) {
    for (const rel of [`${f.file}.woff2`, `${f.file}-ext.woff2`]) {
      const head = fs.readFileSync(path.join(F.FONT_DIR, rel)).subarray(0, 4).toString('latin1');
      assert.equal(head, 'wOF2', `${rel} is not a woff2 (magic ${JSON.stringify(head)})`);
    }
  }
});

test('the OFL text is the actual licence, not a placeholder', () => {
  for (const f of Object.values(F.FAMILIES)) {
    const txt = fs.readFileSync(path.join(F.FONT_DIR, f.ofl), 'utf8');
    assert.match(txt, /SIL OPEN FONT LICENSE/i, `${f.ofl} does not contain the OFL`);
    assert.ok(txt.length > 3000, `${f.ofl} is suspiciously short`);
  }
});

// ===== resolution =====

test('⚠️ the legacy generic names still resolve — slides on real screens use them', () => {
  // Dropping these would silently reset every slide authored before the fonts shipped.
  assert.equal(F.resolveFamily('sans'), 'inter');
  assert.equal(F.resolveFamily('serif'), 'bitter');
  assert.equal(F.resolveFamily('mono'), 'jetbrains-mono');
  assert.equal(F.resolveFamily('condensed'), 'oswald');
});

test('resolveFamily is total — anything unknown lands on the default', () => {
  for (const bad of ['Impact', '', null, undefined, 42, {}, 'inter; }', '__proto__', 'constructor']) {
    assert.ok(Object.prototype.hasOwnProperty.call(F.FAMILIES, F.resolveFamily(bad)),
      `${JSON.stringify(bad)} resolved to something that is not a family`);
  }
});

test('a font stack always ends in a generic keyword', () => {
  // The named face may be missing on a panel mid-download; the generic is what stops the text
  // vanishing. Asserted for every family so a new one cannot be added without it.
  for (const id of Object.keys(F.FAMILIES)) {
    assert.match(F.fontStack(id), /,\s*(sans-serif|serif|monospace)$/);
  }
});

// ===== emission =====

test('⚠️ only the families a slide actually uses are emitted', () => {
  const css = F.fontFaceCss(['archivo', 'archivo', 'sans']);
  assert.equal((css.match(/@font-face/g) || []).length, 4, 'expected two families x two subsets');
  assert.match(css, /'Archivo'/);
  assert.match(css, /'Inter'/);
  assert.ok(!css.includes('Oswald'), 'an unused family was emitted');
});

test('each family emits both subsets with distinct unicode-ranges', () => {
  const css = F.fontFaceCss(['oswald']);
  assert.match(css, /oswald\.woff2/);
  assert.match(css, /oswald-ext\.woff2/);
  assert.ok(css.includes(F.RANGE_LATIN) && css.includes(F.RANGE_LATIN_EXT),
    'a subset shipped without the range it was cut against');
});

test('⚠️ the declared weight range matches the axis the file actually has', () => {
  // Declaring wider than the file clamps silently: a slide set in 900 renders at 800 and nothing
  // says why. These are the ranges the css2 API reported for the exact files downloaded.
  assert.deepEqual(F.FAMILIES.oswald.weights, [300, 700]);
  assert.deepEqual(F.FAMILIES['jetbrains-mono'].weights, [400, 700]);
  assert.deepEqual(F.FAMILIES.inter.weights, [400, 800]);
  const css = F.fontFaceCss(['oswald']);
  assert.match(css, /font-weight:300 700/);
});

test('font-display is swap — text must never be invisible on a wall', () => {
  assert.match(F.fontFaceCss(['inter']), /font-display:swap/);
});

// ===== the renderer end of it =====

test('a rendered slide carries @font-face for its fonts and uses the family', () => {
  const html = renderSlideHtml({
    template: { elements: [
      { slot: 'h', kind: 'head', box: { x: 5, y: 30, w: 60 }, style: { size_cqw: 7, font: 'archivo' } },
      { slot: 'b', kind: 'body', box: { x: 5, y: 60, w: 50 }, style: { size_cqw: 3, font: 'sans' } },
    ] },
    fields: { h: 'Kenosha Nord', b: 'Zürich' },
  });
  assert.match(html, /@font-face\{font-family:'Archivo'/);
  assert.match(html, /@font-face\{font-family:'Inter'/);
  assert.match(html, /font-family:'Archivo', sans-serif/);
  assert.match(html, /url\(\/fonts\/archivo\.woff2\)/);
  assert.match(html, /url\(\/fonts\/inter-ext\.woff2\)/);
});

test('⚠️ a decorative element pulls in no font at all', () => {
  // A rule or a panel has no text, so referencing a face for it would make a slide download a font
  // it cannot possibly show.
  const html = renderSlideHtml({
    template: { elements: [{ slot: 'r', kind: 'rule', box: { x: 5, y: 50, w: 20, h: 0.6 },
      style: { color: '#E9A33C' } }] }, fields: {},
  });
  assert.ok(!html.includes('@font-face'), 'a decorative-only slide requested a font');
});

test('⚠️ a slide storing an old generic name renders in the aliased family', () => {
  const html = renderSlideHtml({
    template: { elements: [{ slot: 'h', kind: 'head', box: {}, style: { size_cqw: 5, font: 'condensed' } }] },
    fields: { h: 'x' },
  });
  assert.match(html, /'Oswald'/);
  assert.ok(!html.includes('undefined'), 'an unresolved family reached the document');
});

test('normalizeSlide stores the resolved family, so the document self-heals on save', () => {
  const n = normalizeSlide({ template: { elements: [
    { slot: 'a', kind: 'body', box: {}, style: { font: 'mono' } },
    { slot: 'b', kind: 'body', box: {}, style: { font: 'Impact' } },
  ] } });
  assert.equal(n.elements[0].style.font, 'jetbrains-mono');
  assert.equal(n.elements[1].style.font, 'inter');
});

// ===== the catalogue the editor reads =====

test('the catalogue carries what the editor needs to match the renderer exactly', () => {
  // If the editor has to guess a generic or a filename, its preview drifts from what plays.
  for (const f of F.catalogue()) {
    for (const k of ['id', 'label', 'role', 'note', 'weights', 'file', 'css', 'stack']) {
      assert.ok(f[k] !== undefined, `catalogue entry ${f.id} is missing ${k}`);
    }
    assert.match(f.stack, /^(sans-serif|serif|monospace)$/);
  }
  assert.equal(F.catalogue().length, Object.keys(F.FAMILIES).length);
});
