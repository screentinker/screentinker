'use strict';

/*
 * Uploaded fonts: sniffing, and the resolution rules a slide depends on.
 *
 * ⚠️ THE PROPERTY THAT MATTERS MOST IS THE FAILURE ONE. A slide referencing a font that has been
 * deleted must still render in something deliberate. The obvious implementation — emit the missing
 * family name and let the browser sort it out — leaves the text in whatever the platform picks,
 * differently on every panel, which is the exact defect the bundled set was introduced to end.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const FS = require('../lib/font-sniff');
const SF = require('../lib/slide-fonts');
const { renderSlideHtml, normalizeSlide } = require('../lib/slide-render');

const buf = (...bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);
const tag = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(64)]);

// ===== sniffing =====

test('every supported container is recognised by its magic', () => {
  assert.equal(FS.sniffFont(tag('wOF2')), 'woff2');
  assert.equal(FS.sniffFont(tag('wOFF')), 'woff');
  assert.equal(FS.sniffFont(tag('OTTO')), 'otf');
  assert.equal(FS.sniffFont(tag('true')), 'ttf');
  assert.equal(FS.sniffFont(buf(0x00, 0x01, 0x00, 0x00)), 'ttf');
});

test('⚠️ the NAME is never consulted — only the bytes', () => {
  // `brand.woff2` containing a ZIP is the case this exists to refuse.
  const zip = tag('PK');
  assert.equal(FS.sniffFont(zip), null);
  assert.throws(() => FS.validateFont(zip), /does not look like a font/);
});

test('⚠️ a TrueType Collection is refused by NAME, because the fix is different', () => {
  // A .ttc is a font — it just cannot be loaded by @font-face. "Not a font file" would send the
  // operator looking for the wrong thing.
  assert.throws(() => FS.sniffFont(tag('ttcf')), /TrueType Collection/);
  assert.throws(() => FS.sniffFont(tag('ttcf')), /export a single face/);
});

test('an empty or oversized file is refused with a number, not a shrug', () => {
  assert.throws(() => FS.validateFont(Buffer.alloc(0)), /empty/);
  const big = FS.MAX_FONT_BYTES + 1;
  assert.throws(() => FS.validateFont(tag('wOF2'), big), /MB/);
  // ...and says why the limit exists rather than just asserting it.
  assert.throws(() => FS.validateFont(tag('wOF2'), big), /every screen showing a slide/);
});

test('a valid font reports the format the CSS needs', () => {
  assert.equal(FS.validateFont(tag('OTTO')).css, 'opentype');
  assert.equal(FS.validateFont(buf(0x00, 0x01, 0x00, 0x00)).css, 'truetype');
  assert.equal(FS.validateFont(tag('wOF2')).ext, '.woff2');
});

// ===== the id namespace =====

test('⚠️ an uploaded id can never be mistaken for a bundled family, in either direction', () => {
  assert.ok(SF.isCustom('u:abc'));
  assert.ok(!SF.isCustom('inter'));
  assert.equal(SF.customId('u:abc'), 'abc');
  // A bundled resolver handed a custom id must not silently produce a family.
  assert.equal(SF.resolveFamily('u:abc'), SF.DEFAULT_FAMILY);
  // ...and no bundled key can start with the prefix, or the namespace would leak.
  for (const k of Object.keys(SF.FAMILIES)) assert.ok(!k.startsWith(SF.CUSTOM_PREFIX));
});

test('⚠️ normalizeSlide KEEPS a u: reference rather than resolving it away', () => {
  /*
   * normalize has no database, so it cannot know whether the upload still exists. Collapsing it to
   * the default here would silently rewrite the operator's font choice on every save — including
   * saves triggered by editing something else entirely.
   */
  const n = normalizeSlide({ template: { elements: [
    { slot: 'a', kind: 'body', box: {}, style: { font: 'u:abc' } }] } });
  assert.equal(n.elements[0].style.font, 'u:abc');
});

test('a u: reference is length-capped like every other stored string', () => {
  const n = normalizeSlide({ template: { elements: [
    { slot: 'a', kind: 'body', box: {}, style: { font: 'u:' + 'x'.repeat(500) } }] } });
  assert.ok(n.elements[0].style.font.length <= 80);
});

// ===== rendering =====

const slideUsing = (font) => ({
  template: { elements: [{ slot: 'h', kind: 'head', box: { x: 5, y: 30, w: 60 },
    style: { size_cqw: 7, font } }] },
  fields: { h: 'Brand' },
});
const FOUND = () => ({ css_family: 'stu_abc', filepath: 'abc.woff2', format: 'woff2' });

test('an uploaded font renders with its own @font-face and its own family', () => {
  const html = renderSlideHtml(slideUsing('u:abc'), { resolveFont: FOUND });
  assert.match(html, /@font-face\{font-family:'stu_abc'/);
  assert.match(html, /url\(\/fonts\/u\/abc\.woff2\) format\('woff2'\)/);
  assert.match(html, /font-family:'stu_abc', sans-serif/);
});

test('⚠️ a DELETED font falls back to the default AND declares its face', () => {
  /*
   * The failure this file exists for. Falling back to 'Inter' without emitting Inter's @font-face
   * makes the fallback inert: the browser is asked for a family it has no rule for and lands on
   * the platform's own sans — different on Android, Tizen, BrightSign and a browser. Found by
   * reading the emitted HTML, not by reading the code.
   */
  const html = renderSlideHtml(slideUsing('u:gone'), { resolveFont: () => null });
  assert.match(html, /font-family:'Inter', sans-serif/);
  assert.match(html, /@font-face\{font-family:'Inter'/, 'the fallback family was never declared');
  assert.match(html, /url\(\/fonts\/inter\.woff2\)/);
});

test('with no resolver at all, a u: reference still renders readable text', () => {
  // Previews and tests construct the renderer without a database.
  const html = renderSlideHtml(slideUsing('u:abc'));
  assert.match(html, /@font-face\{font-family:'Inter'/);
  assert.match(html, /Brand/);
});

test('⚠️ a hostile css_family or filepath cannot break out of the rule', () => {
  const html = renderSlideHtml(slideUsing('u:abc'), {
    resolveFont: () => ({ css_family: 'x', filepath: "a.woff2') format('woff2');}body{display:none", format: 'woff2' }),
  });
  assert.ok(!html.includes('body{display:none'), 'a filepath escaped the url()');
  // The generated family never comes from user input, but the format is checked anyway.
  const h2 = renderSlideHtml(slideUsing('u:abc'), {
    resolveFont: () => ({ css_family: 'y', filepath: 'a.woff2', format: "woff2') format('x" }),
  });
  assert.ok(!h2.includes("format('x"), 'a format string escaped the rule');

  /*
   * ⚠️ INHERITED KEYS. `map[fmt] || 'woff2'` looks total and is not: `constructor` and `__proto__`
   * resolve through the prototype chain to truthy values, so the fallback never fires and the
   * Object constructor's source is interpolated into the CSS. A mutation run found this — a
   * character filter upstream was masking it, which made the sanitiser look like the guard.
   */
  for (const evil of ['constructor', '__proto__', 'toString', 'valueOf']) {
    const h = renderSlideHtml(slideUsing('u:abc'), {
      resolveFont: () => ({ css_family: 'z', filepath: 'a.woff2', format: evil }),
    });
    assert.match(h, /format\('woff2'\)/, `${evil} did not fall back to a real format`);
    assert.ok(!/native code|\[object Object\]|function Object/.test(h),
      `${evil} leaked a prototype value into the CSS`);
  }
});

test('several elements sharing one uploaded font resolve it once', () => {
  let calls = 0;
  renderSlideHtml({
    template: { elements: [
      { slot: 'a', kind: 'head', box: {}, style: { size_cqw: 5, font: 'u:abc' } },
      { slot: 'b', kind: 'body', box: {}, style: { size_cqw: 3, font: 'u:abc' } },
      { slot: 'c', kind: 'body', box: {}, style: { size_cqw: 3, font: 'u:abc' } },
    ] }, fields: {},
  }, { resolveFont: () => { calls++; return FOUND(); } });
  assert.equal(calls, 1, 'the font was looked up once per element');
});

test('mixing bundled and uploaded fonts emits both kinds of face', () => {
  const html = renderSlideHtml({
    template: { elements: [
      { slot: 'a', kind: 'head', box: {}, style: { size_cqw: 6, font: 'u:abc' } },
      { slot: 'b', kind: 'body', box: {}, style: { size_cqw: 3, font: 'oswald' } },
    ] }, fields: {},
  }, { resolveFont: FOUND });
  assert.match(html, /'stu_abc'/);
  assert.match(html, /'Oswald'/);
  assert.match(html, /url\(\/fonts\/oswald-ext\.woff2\)/);
});
