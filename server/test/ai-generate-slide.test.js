'use strict';

/*
 * Turning model output into a slide.
 *
 * ⚠️ THE MODEL IS AN UNTRUSTED, UNRELIABLE INPUT and both halves of that matter. Unreliable: it
 * will return forty elements, a negative size, an animation that does not exist, or text where a
 * number belongs, and the answer has to be a small valid slide rather than an error. Untrusted: its
 * output reaches a render path, so a slot named "../../x", a colour of `red;--x:url(javascript:)`
 * or an unbounded string must not survive contact.
 *
 * These drive the real sanitiser and then push its output through the RENDERER'S OWN normalizer,
 * because "the editor would accept this" and "the renderer will render this" are different claims
 * and only the second one reaches a screen.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-aislide-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const slideRender = require('../lib/slide-render');

/*
 * normalizeSlideSpec is module-private (the route is its only caller), so it is loaded the way the
 * repo's other source-level guards do it — by reading the file — rather than by exporting internals
 * purely for a test. The alternative is widening the module's surface to make it testable, which
 * changes the thing under test.
 */
const AI_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
function loadSanitiser() {
  const mod = require('../routes/ai.js');        // ensure it at least parses and mounts
  assert.ok(mod, 'routes/ai.js should export a router');
  // Re-evaluate just the pure helpers in a sandbox with the same dependencies the file uses.
  const vm = require('node:vm');
  const sandbox = { require, module: { exports: {} }, exports: {}, console, Object, Number, Array, String, Math, JSON };
  vm.createContext(sandbox);
  const pick = (name) => {
    const i = AI_SRC.indexOf(`function ${name}(`);
    assert.notEqual(i, -1, `${name}() is gone from routes/ai.js`);
    let depth = 0, j = AI_SRC.indexOf('{', i);
    for (let k = j; k < AI_SRC.length; k++) {
      if (AI_SRC[k] === '{') depth++;
      else if (AI_SRC[k] === '}') { depth--; if (depth === 0) return AI_SRC.slice(i, k + 1); }
    }
    throw new Error(`could not extract ${name}`);
  };
  const prelude = [
    "const SLIDE_RENDER = require('../lib/slide-render');",
    "const SLIDE_ANIMATIONS = Object.keys(SLIDE_RENDER.ANIMATIONS || {}).filter((a) => a !== 'none');",
    "const SLIDE_KINDS = Object.keys(SLIDE_RENDER.KINDS || {}).filter((k) => k !== 'image');",
    'const clampN = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };',
    "const hex = (c, d) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : d;",
    "const cleanText = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim().slice(0, 200);",
  ].join('\n');
  vm.runInContext(`${prelude}\n${pick('normalizeSlideSpec')}\nmodule.exports = { normalizeSlideSpec };`, sandbox,
    { filename: path.join(__dirname, '..', 'routes', 'ai.js') });
  return sandbox.module.exports.normalizeSlideSpec;
}
const normalizeSlideSpec = loadSanitiser();

/** Everything the route promises: sanitised, then accepted by the renderer. */
function through(raw) {
  const spec = normalizeSlideSpec(raw);
  const settled = slideRender.normalizeSlide(spec);
  return { spec, settled };
}

test('a sensible model answer becomes a slide, with words in fields and layout in elements', () => {
  const { spec, settled } = through({
    background: '#102030',
    elements: [
      { slot: 'title', kind: 'head', box: { x: 6, y: 10, w: 80 }, style: { color: '#FFEE00', size_cqw: 7, weight: 700, align: 'left' }, motion: { animation: 'fade', delay: 0.2, duration: 0.6 } },
      { slot: 'sub', kind: 'body', box: { x: 6, y: 30, w: 70 }, style: { size_cqw: 3 } },
      { slot: 'band', kind: 'box', box: { x: 0, y: 60, w: 100, h: 8 }, style: { color: '#FF0055', opacity: 0.8 } },
    ],
    fields: { title: 'Autumn Sale', sub: 'Up to 40% off in store' },
  });
  assert.equal(spec.template.background, '#102030');
  assert.equal(spec.template.elements.length, 3);
  // ⚠️ The separation that makes a slide editable later: words live in fields, keyed by slot.
  const slots = spec.template.elements.map((e) => e.slot);
  assert.equal(Object.keys(spec.fields).length, 2, 'only the TEXT elements should take a field');
  assert.ok(slots.includes(Object.keys(spec.fields)[0]));
  assert.equal(spec.fields[slots[0]], 'Autumn Sale');
  assert.equal(settled.elements.length, 3, 'the renderer accepted every element');
});

test('⚠️ a model slot never becomes our slot', () => {
  /*
   * Slots are keys into `fields` and into rendered ids. Regenerating them from a safe pattern
   * removes the whole question of what a model may put there — traversal, markup, duplicates.
   */
  const { spec } = through({
    elements: [
      { slot: '../../etc/passwd', kind: 'head', box: {} },
      { slot: '<script>x</script>', kind: 'body', box: {} },
      { slot: 'dup', kind: 'body', box: {} },
      { slot: 'dup', kind: 'body', box: {} },
    ],
    fields: { '../../etc/passwd': 'a', '<script>x</script>': 'b', dup: 'c' },
  });
  for (const e of spec.template.elements) {
    assert.match(e.slot, /^s\d+_[a-z]+$/, `unsafe slot survived: ${e.slot}`);
  }
  const slots = spec.template.elements.map((e) => e.slot);
  assert.equal(new Set(slots).size, slots.length, 'duplicate slots would collapse two elements into one field');
});

test('⚠️ text is stripped of markup and bounded', () => {
  const { spec } = through({
    elements: [{ slot: 't', kind: 'head', box: {} }],
    fields: { t: '<img src=x onerror=alert(1)>Hello' + 'y'.repeat(500) },
  });
  const val = Object.values(spec.fields)[0];
  assert.ok(!/[<>]/.test(val), 'markup survived into a field');
  assert.ok(val.length <= 200, `field was ${val.length} chars`);
  assert.match(val, /^Hello/);
});

test('⚠️ an animation the renderer does not implement is dropped, not passed through', () => {
  /*
   * Offering a model something the renderer cannot do produces a slide that validates, ships, and
   * animates nothing — and the editor shows the same nothing, so nobody ever notices.
   */
  const { spec, settled } = through({
    elements: [
      { slot: 'a', kind: 'head', box: {}, motion: { animation: 'backflip', delay: 1, duration: 1 } },
      { slot: 'b', kind: 'body', box: {}, motion: { animation: 'fade', delay: 0.1, duration: 0.4 } },
    ],
    fields: { a: 'x', b: 'y' },
  });
  assert.equal(spec.template.elements[0].motion, null, 'an unknown animation must not survive');
  assert.equal(spec.template.elements[1].motion.animation, 'fade');
  assert.ok(settled.elements.every((e) => e.motion === null || slideRender.ANIMATIONS[e.motion.animation]));
});

test('⚠️ image elements cannot be conjured — a model has no content_id to give', () => {
  const { spec } = through({
    elements: [{ slot: 'pic', kind: 'image', box: {}, content_id: 'made-up' }],
    fields: {},
  });
  assert.notEqual(spec.template.elements[0].kind, 'image',
    'an image element without a real upload renders as nothing at all');
});

test('nonsense numbers are clamped rather than rejected', () => {
  const { spec, settled } = through({
    background: 'not-a-colour',
    elements: [
      { slot: 'a', kind: 'head', box: { x: -900, y: 1e9, w: 0 }, style: { size_cqw: -5, weight: 4000, opacity: 12, align: 'diagonal' } },
      { slot: 'b', kind: 'body', box: { x: 'left', y: null, w: undefined }, style: { color: 'red; --x:url(javascript:1)' } },
    ],
    fields: { a: 'A', b: 'B' },
  });
  assert.equal(spec.template.background, '#0B1220', 'a bad colour falls back rather than reaching CSS');
  const a = spec.template.elements[0];
  assert.ok(a.box.x >= 0 && a.box.x <= 96, `x was ${a.box.x}`);
  assert.ok(a.style.size_cqw > 0 && a.style.size_cqw <= 30);
  assert.ok(a.style.weight >= 100 && a.style.weight <= 900);
  assert.ok(a.style.opacity >= 0 && a.style.opacity <= 1);
  assert.equal(a.style.align, 'left', 'an unknown alignment falls back');
  assert.equal(spec.template.elements[1].style.color, '#FFFFFF', 'a CSS-injection colour must not survive');
  assert.equal(settled.elements.length, 2, 'the renderer still accepts the clamped result');
});

test('a runaway element count is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ slot: `s${i}`, kind: 'body', box: {} }));
  const { spec, settled } = through({ elements: many, fields: {} });
  assert.ok(spec.template.elements.length <= 8, `got ${spec.template.elements.length} elements`);
  assert.ok(settled.elements.length <= slideRender.MAX_ELEMENTS);
});

test('an empty or junk answer produces no elements, so the route can refuse it', () => {
  assert.equal(normalizeSlideSpec(null).template.elements.length, 0);
  assert.equal(normalizeSlideSpec({}).template.elements.length, 0);
  assert.equal(normalizeSlideSpec({ elements: 'nope' }).template.elements.length, 0);
});

test('⚠️ the prompt offers only animations and kinds the renderer really has', () => {
  /*
   * A hand-typed list here would drift the moment an animation is added or renamed, and the
   * failure is silent on both sides. This asserts the prompt is built from the source of truth.
   */
  assert.match(AI_SRC, /const SLIDE_ANIMATIONS = Object\.keys\(SLIDE_RENDER\.ANIMATIONS/);
  assert.match(AI_SRC, /const SLIDE_KINDS = Object\.keys\(SLIDE_RENDER\.KINDS/);
  assert.match(AI_SRC, /SLIDE_ANIMATIONS\.join/, 'the prompt does not interpolate the real animation list');
  assert.ok(!/head\|body\|stat\|rule\|box/.test(AI_SRC), 'the kind list is hardcoded in the prompt again');
});
