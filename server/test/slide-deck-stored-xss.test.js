'use strict';

/*
 * A saved deck may only contain values the RENDERER would accept.
 *
 * ⚠️ THE BUG THIS EXISTS FOR WAS STORED XSS, EDITOR → ADMIN. normalizeDeck kept `template` exactly
 * as it arrived, and the slide editor draws its filmstrip by interpolating a style string into an
 * innerHTML attribute (`<div style="…${styleFor(e)}">`). So a colour of `x" onmouseover="…` in a
 * saved deck closed the attribute and ran script in the DASHBOARD origin — where the session JWT
 * lives — for whoever opened that deck next. Any editor could write it; an admin would run it.
 *
 * ⚠️ AND IT WAS INVISIBLE BECAUSE THE WALL WAS NEVER AT RISK. routes/widgets.js re-normalises before
 * rendering, so every screen was fine and every server-side test was green; the only victim was the
 * person editing.
 *
 * The second half of these tests is the reason the fix is a round trip rather than "store what
 * normalizeSlide returns": that function is the RENDERER'S view and renames things on the way
 * (backgroundDim, backgroundContentId, contentId). Storing its output verbatim would have silently
 * thrown away the picture background an operator had set, because the editor reads snake_case.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-deckxss-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDeck } = require('../lib/slide-deck');

const deckWith = (template, fields) => normalizeDeck({
  slides: [{ name: 'S', dwell_sec: 10, template, fields }],
}).slides[0];

/* ================================================================= the attack */

test('⚠️ a colour that would break out of a style attribute cannot be stored', () => {
  const out = deckWith({
    elements: [{ slot: 't', kind: 'head', box: { x: 1, y: 1, w: 50 },
      style: { color: 'x" onmouseover="alert(document.cookie)' } }],
  }, { t: 'hi' });
  const stored = out.template.elements[0].style.color;
  assert.equal(stored, '#FFFFFF', `a non-hex colour must not survive a save, got ${JSON.stringify(stored)}`);
  assert.ok(!/["'<>]/.test(stored), 'the stored colour still contains attribute-breaking characters');
});

test('⚠️ every value the editor puts in a style attribute is bounded', () => {
  /*
   * styleFor() interpolates colour, opacity, radius, size, weight, align, font and the box numbers.
   * Any one of them reaching an attribute unbounded is the same hole, so all of them are checked
   * rather than only the one that was exploited.
   */
  const out = deckWith({
    background: 'red;background:url(javascript:alert(1))',
    elements: [{
      slot: 't', kind: 'body',
      box: { x: '1;a', y: {}, w: 'NaN', h: [] },
      style: {
        color: 'javascript:alert(1)', opacity: '0.5"', radius_cqw: '9;x',
        size_cqw: 'big', weight: '700"', align: 'center;x',
      },
    }],
  }, { t: 'hi' });
  const e = out.template.elements[0];
  assert.equal(out.template.background, '#000000');
  assert.equal(e.style.color, '#FFFFFF');
  for (const [k, v] of Object.entries({ x: e.box.x, y: e.box.y, w: e.box.w,
    opacity: e.style.opacity, radius: e.style.radius_cqw, size: e.style.size_cqw, weight: e.style.weight })) {
    assert.equal(typeof v, 'number', `${k} should be a number, got ${JSON.stringify(v)}`);
    assert.ok(Number.isFinite(v), `${k} is not finite`);
  }
  assert.ok(['left', 'center', 'right'].includes(e.style.align), `align survived as ${e.style.align}`);
});

test('⚠️ an unknown kind or animation cannot be stored either', () => {
  const out = deckWith({
    elements: [
      { slot: 'a', kind: '<script>', box: {}, motion: { animation: 'evil', delay: 1, duration: 1 } },
      { slot: 'b', kind: 'body', box: {}, motion: { animation: 'fade', delay: 0.1, duration: 0.3 } },
    ],
  }, { a: 'x', b: 'y' });
  assert.equal(out.template.elements[0].kind, 'body', 'an unknown kind must fall back, not persist');
  assert.equal(out.template.elements[0].motion, null, 'an unknown animation must not persist');
  assert.equal(out.template.elements[1].motion.animation, 'fade');
});

/* ================================================================= what must NOT be lost */

test('⚠️ a picture background survives the save, in the shape the editor reads', () => {
  /*
   * The regression the round trip exists to prevent. normalizeSlide returns backgroundContentId /
   * backgroundDim; the document and the editor use background_content_id / background_dim. Storing
   * the renderer's shape verbatim would drop the operator's photo on the next save, silently.
   */
  const out = deckWith({
    background: '#112233',
    background_content_id: 'c0ffee',
    background_dim: 0.45,
    elements: [{ slot: 't', kind: 'head', box: { x: 4, y: 6, w: 70 }, style: { color: '#FF0088' } }],
  }, { t: 'Autumn' });

  assert.equal(out.template.background, '#112233');
  assert.equal(out.template.background_content_id, 'c0ffee', 'the photo reference was lost');
  assert.equal(out.template.background_dim, 0.45, 'the scrim was lost');
  assert.equal(out.template.elements[0].style.color, '#FF0088', 'a legitimate colour must survive');
});

test('a picture ELEMENT keeps its content_id in snake_case', () => {
  const out = deckWith({
    elements: [{ slot: 'p', kind: 'image', box: { x: 0, y: 0, w: 40, h: 40 }, content_id: 'abc123' }],
  }, {});
  assert.equal(out.template.elements[0].content_id, 'abc123');
});

test('a full slide round-trips unchanged when it was already valid', () => {
  // Saving must be idempotent: a deck saved twice should not drift.
  const template = {
    background: '#0B1220',
    background_content_id: null,
    background_dim: 0,
    elements: [{
      slot: 'title', kind: 'head',
      box: { x: 5, y: 10, w: 80 },
      content_id: null,
      style: { color: '#FFFFFF', font: 'inter', size_cqw: 6, weight: 700, align: 'left', radius_cqw: 0, opacity: 1 },
      motion: { animation: 'slide-up', delay: 0.2, duration: 0.6, easing: 'ease-out' },
    }],
  };
  const once = deckWith(template, { title: 'Hello' });
  const twice = deckWith(once.template, once.fields);
  assert.deepEqual(twice.template, once.template, 'a second save changed a valid slide');
  assert.deepEqual(twice.fields, once.fields);
});

test('words are kept only for slots that survived', () => {
  const out = deckWith({ elements: [{ slot: 'keep', kind: 'body', box: {} }] },
    { keep: 'stays', ghost: 'points at nothing' });
  assert.equal(out.fields.keep, 'stays');
  assert.ok(!('ghost' in out.fields), 'a field with no element should not persist');
});

test('normalizeDeck is still total — junk in never throws', () => {
  for (const t of [null, undefined, 'string', 42, [], { elements: 'nope' }, { elements: [null, 7, []] }]) {
    assert.doesNotThrow(() => deckWith(t, null), `threw on ${JSON.stringify(t)}`);
  }
});

/* ============ the deck's authoring shape ============ */

/*
 * ⚠️ normalizeDeck RETURNS A NEW OBJECT, so anything not named in it is dropped on every save.
 * That is exactly how background_content_id was once lost, and a deck quietly reverting to
 * landscape on each save would be the same bug wearing a different hat.
 */

test('⚠️ a portrait deck stays portrait across a save', () => {
  const out = normalizeDeck({ aspect: '9:16', slides: [{ name: 'S', template: {}, fields: {} }] });
  assert.equal(out.aspect, '9:16');
});

test('a deck with no shape defaults to landscape', () => {
  assert.equal(normalizeDeck({ slides: [] }).aspect, '16:9');
  assert.equal(normalizeDeck({}).aspect, '16:9');
});

test('⚠️ an arbitrary shape is refused', () => {
  /*
   * This value goes straight into a CSS aspect-ratio in the editor, so a free-form string is both a
   * rendering accident and an injection point.
   */
  for (const bad of ['9/16; background:url(x)', '"><script>', 'auto', '', null, 42, {}]) {
    assert.equal(normalizeDeck({ aspect: bad, slides: [] }).aspect, '16:9', `accepted ${JSON.stringify(bad)}`);
  }
});

test('every offered shape survives', () => {
  for (const a of ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '5:3']) {
    assert.equal(normalizeDeck({ aspect: a, slides: [] }).aspect, a);
  }
});
