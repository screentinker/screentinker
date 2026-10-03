'use strict';

/*
 * Slide widgets — the template/record join, and the bounds on everything that reaches HTML.
 *
 * ⚠️ THE PROPERTY THE WHOLE FEATURE RESTS ON: editing a field must not touch the template. That is
 * what makes "come back in three months and change the number" possible, and it is the single
 * thing every other widget in this codebase gets wrong by baking content into config.html.
 *
 * ⚠️ AND THE ONE THAT KEEPS IT SAFE: normalizeSlide is TOTAL. The renderer interpolates every value
 * it is handed without re-checking, so the two are only correct as a pair — if normalize ever lets
 * something through, the renderer has no second line of defence. Hence the mutation-shaped tests
 * below, which feed it the values an editor would never send.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/slide-render');

const slide = (over = {}) => ({
  template: {
    background: '#101820',
    elements: [
      { slot: 'headline', kind: 'head', box: { x: 8, y: 30, w: 60 },
        style: { color: '#FFFFFF', font: 'sans', size_cqw: 7, weight: 700, align: 'left' },
        motion: { animation: 'slideU', delay: 0.25, duration: 0.6, easing: 'soft' } },
      { slot: 'sub', kind: 'body', box: { x: 8, y: 60, w: 50 },
        style: { color: '#A3AEC0', size_cqw: 3 }, motion: null },
    ],
    ...(over.template || {}),
  },
  fields: { headline: '42 days without a recordable incident', sub: 'Site record is 87.', ...(over.fields || {}) },
});

// ===== the join =====

test('the record supplies the words and the template supplies everything else', () => {
  const html = S.renderSlideHtml(slide());
  assert.match(html, /42 days without a recordable incident/);
  assert.match(html, /Site record is 87\./);
  assert.match(html, /animation-name:st-slide-u/);
  assert.match(html, /font-size:7cqw/);
});

test('⚠️ editing a field changes ONE string and leaves the layout byte-identical', () => {
  /*
   * The property the feature exists for. Rendering both and diffing everything EXCEPT the text is
   * the only way to assert it — a test that just checked the new words appear would pass just as
   * happily against a design that rebuilt the layout on every edit, which is the thing being
   * ruled out.
   */
  const before = S.renderSlideHtml(slide());
  const after = S.renderSlideHtml(slide({ fields: { headline: '43 days without a recordable incident' } }));

  const strip = (h) => h.replace(/>([^<]*)</g, '><');
  assert.equal(strip(before), strip(after), 'the layout moved when only a field changed');
  assert.match(after, /43 days/);
  assert.ok(!after.includes('42 days'), 'the old value survived the edit');
});

test('a slot with no value renders empty rather than printing its own name', () => {
  const s = slide();
  delete s.fields.sub;
  const html = S.renderSlideHtml(s);
  assert.ok(!html.includes('sub<'), 'the slot name leaked into the slide');
  assert.match(html, /class="e t"/);
});

// ===== bounds =====

test('⚠️ a headline cannot carry markup into the document', () => {
  const html = S.renderSlideHtml(slide({
    fields: { headline: '<img src=x onerror="alert(1)">', sub: '</div><script>alert(2)</script>' },
  }));
  assert.ok(!html.includes('<img src=x'), 'raw markup survived');
  assert.ok(!html.includes('<script>alert(2)'), 'a script tag survived');
  assert.match(html, /&lt;img src=x/);
});

test('⚠️ a colour is hex or it is the default — never an arbitrary CSS value', () => {
  for (const bad of ['red; background:url(http://x/)', 'url(javascript:alert(1))', '}#a{x:y', '#12', 'rgb(1,2,3)']) {
    const html = S.renderSlideHtml(slide({
      template: { background: bad, elements: [
        { slot: 'a', kind: 'body', box: { x: 0, y: 0, w: 10 }, style: { color: bad } }] },
    }));
    assert.ok(!html.includes(bad), `a non-hex colour reached the document: ${bad}`);
  }
  // ...and a legitimate one still lands, so the guard is not simply refusing everything.
  assert.match(S.renderSlideHtml(slide({ template: { background: '#ABCDEF', elements: [] } })),
    /background:#ABCDEF/);
});

test('⚠️ an unknown animation, easing or font falls back rather than being interpolated', () => {
  const html = S.renderSlideHtml({
    template: { elements: [{ slot: 'a', kind: 'body', box: { x: 0, y: 0, w: 10 },
      style: { font: 'Impact; }' }, motion: { animation: 'explode', easing: 'steps(9)' } }] },
    fields: { a: 'x' },
  });
  assert.ok(!html.includes('explode'), 'an unknown animation name was emitted');
  assert.ok(!html.includes('steps(9)'), 'an unknown easing was emitted');
  assert.ok(!html.includes('Impact'), 'an unknown font was emitted');
  /*
   * ⚠️ And asserted at the NORMALIZE step too. Checking only the document is vacuous: an
   * unrecognised key makes the FONTS lookup undefined, so the output says `font-family:undefined`
   * and the attacker's string is absent either way — the test passed with the guard deleted.
   * The guarantee is that normalize maps it to a real family, so that is what is asserted.
   */
  // 'inter' since the bundled families landed — the default is a real face now, not a generic.
  assert.equal(S.normalizeSlide({ template: { elements: [{ slot: 'a', kind: 'body',
    box: {}, style: { font: 'Impact; }' } }] } }).elements[0].style.font, 'inter');
  assert.ok(!html.includes('undefined'), 'an unresolved font reached the document');
  assert.ok(!/animation-name/.test(html), 'an unrecognised animation should mean NO animation, not a default one');
});

test('⚠️ numbers are clamped, so no value reaches CSS unbounded', () => {
  const n = S.normalizeSlide({ template: { elements: [{ slot: 'a', kind: 'body',
    box: { x: 1e9, y: -1e9, w: 0, h: -4 },
    style: { size_cqw: 9999, weight: 12345, opacity: 40, radius_cqw: 500 },
    motion: { animation: 'fade', delay: 1e6, duration: 0 } }] } });
  const e = n.elements[0];
  assert.equal(e.x, 150); assert.equal(e.y, -50);
  assert.equal(e.w, 0.5); assert.equal(e.h, 0.1);
  assert.equal(e.style.size, 40); assert.equal(e.style.weight, 900);
  assert.equal(e.style.opacity, 1); assert.equal(e.style.radius, 20);
  assert.equal(e.motion.delay, 30); assert.equal(e.motion.duration, 0.05);
});

test('⚠️ the element and field counts are capped', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ slot: `s${i}`, kind: 'body', box: {} }));
  const fields = {}; for (let i = 0; i < 500; i++) fields[`s${i}`] = 'x';
  const n = S.normalizeSlide({ template: { elements: many }, fields });
  assert.equal(n.elements.length, S.MAX_ELEMENTS);
  assert.equal(Object.keys(n.fields).length, S.MAX_FIELDS);
});

test('a field value is capped in length, and a non-string value is coerced or dropped', () => {
  const n = S.normalizeSlide({ template: { elements: [] },
    fields: { a: 'x'.repeat(9999), b: 42, c: null, d: { nope: 1 }, e: ['no'], 'bad slot': 'x' } });
  assert.equal(n.fields.a.length, S.MAX_FIELD_CHARS);
  assert.equal(n.fields.b, '42', 'a number typed into a field is a value');
  assert.equal(n.fields.c, '');
  assert.ok(!('d' in n.fields) && !('e' in n.fields), 'objects and arrays are not values');
  assert.ok(!('bad slot' in n.fields), 'an illegal slot name was accepted');
});

// ===== motion semantics =====

test('⚠️ a delayed element holds its FROM state, or the slide flashes its finished layout', () => {
  // animation-fill-mode:both is not a detail. Without it every element paints in place on frame
  // one and then jumps to its entrance when the delay elapses — the slide shows its answer, hides
  // it, then animates it in. Visible on any panel, and invisible in code review.
  const html = S.renderSlideHtml(slide());
  assert.match(html, /animation-fill-mode:both/);
});

test('an element with no motion carries no animation properties at all', () => {
  const html = S.renderSlideHtml(slide());
  const subLine = html.split('\n').find((l) => l.includes('#A3AEC0'));
  assert.ok(subLine, 'the un-animated element is missing');
  assert.ok(!subLine.includes('animation'), 'an un-animated element got animation CSS');
});

test('settleTime reports when the last element finishes arriving', () => {
  assert.equal(S.settleTime(S.normalizeSlide(slide())), 0.85);
  assert.equal(S.settleTime(S.normalizeSlide({ template: { elements: [] } })), 0,
    'a slide with no motion settles immediately');
});

// ===== images =====

test('an image renders a reference, never the bytes', () => {
  const html = S.renderSlideHtml({
    template: { elements: [{ slot: 'photo', kind: 'image', box: { x: 0, y: 0, w: 50, h: 50 },
      content_id: 'c-1' }] }, fields: {},
  }, { resolveImage: (id) => (id === 'c-1' ? '/uploads/content/abc.jpg' : null) });
  assert.match(html, /<img src="\/uploads\/content\/abc\.jpg"/);
  assert.ok(!html.includes('base64'), 'a slide must never inline image bytes');
});

test('an image whose content is gone degrades to a placeholder, not a hole', () => {
  const html = S.renderSlideHtml({
    template: { elements: [{ slot: 'photo', kind: 'image', box: {}, content_id: 'missing' }] }, fields: {},
  }, { resolveImage: () => null });
  assert.match(html, /class="ph"/);
  assert.ok(!html.includes('<img'), 'a broken image element was emitted');
});

test('⚠️ a resolver that returns a hostile URL still cannot break out of the attribute', () => {
  const html = S.renderSlideHtml({
    template: { elements: [{ slot: 'p', kind: 'image', box: {}, content_id: 'x' }] }, fields: {},
  }, { resolveImage: () => '" onerror="alert(1)' });
  assert.ok(!html.includes('onerror="alert(1)"'), 'the src attribute was escapable');
  assert.match(html, /&quot; onerror=/);
});

// ===== the degrade case =====

test('a player that ignores keyframes still gets a correctly laid-out slide', () => {
  // The reason motion is CSS and not a library: an unknown @keyframes leaves the element present
  // and positioned. There is no code path here where failing to animate means failing to render.
  const html = S.renderSlideHtml(slide());
  for (const need of ['left:8%', 'top:30%', 'width:60%', '42 days']) {
    assert.ok(html.includes(need), `${need} is not present independently of the animation`);
  }
});

test('cqw units require a sized container, and the stage RULE declares one', () => {
  /*
   * ⚠️ Asserted against the .stage rule, not against the document. The first version of this
   * matched /container-type:size/ anywhere — and the comment directly above that CSS says the
   * words "container-type:size", so deleting the declaration left the test passing. A mutation
   * run caught it. Without the declaration every cqw resolves against the VIEWPORT, so a slide
   * inside a zone renders at full-screen sizes and nothing in the markup looks wrong.
   */
  const html = S.renderSlideHtml(slide());
  const stageRule = (html.match(/\.stage\s*\{[^}]*\}/) || [''])[0];
  assert.ok(stageRule, 'no .stage rule was emitted at all');
  assert.match(stageRule, /container-type:\s*size/);
  assert.ok(!/font-size:[\d.]+px/.test(html), 'a px font-size would not scale across panels');
});

// ===== picture backgrounds =====

test('a background photo renders under the elements, from a content reference', () => {
  const html = S.renderSlideHtml({
    template: { background: '#101820', background_content_id: 'c1', elements: [
      { slot: 'h', kind: 'head', box: { x: 6, y: 40, w: 70 }, style: { size_cqw: 8 } }] },
    fields: { h: 'Over a photo' },
  }, { resolveImage: (id) => (id === 'c1' ? '/uploads/content/sky.jpg' : null) });

  assert.match(html, /<div class="bg" style="background-image:url\(\/uploads\/content\/sky\.jpg\)">/);
  // Order matters: the photo must be emitted BEFORE the elements or it paints over the words.
  assert.ok(html.indexOf('class="bg"') < html.indexOf('Over a photo'), 'the photo is painted over the text');
  assert.match(html, /background-size:cover/);
});

test('⚠️ the background is no-repeat, so a logo/SVG background never tiles down the stage', () => {
  /*
   * Field report: a branded background (a "VIEW" wordmark dropped in as the slide background) showed
   * a column of ~7 repeated marks down one edge, intermittently, resetting on each 30s slide reload.
   * Cause: `.bg` set background-size:cover but not background-repeat, so the CSS default `repeat`
   * tiled any image whose intrinsic size cover could not resolve (an SVG, or a raster before its
   * dimensions loaded — the per-reload iframe rebuild reopened that window every cycle). cover never
   * wants tiling; the rule must pin it off.
   */
  const html = S.renderSlideHtml({
    template: { background_content_id: 'c1', elements: [] }, fields: {},
  }, { resolveImage: () => '/uploads/content/logo.svg' });
  const bg = html.match(/\.bg \{[^}]*\}/);
  assert.ok(bg, '.bg rule present');
  assert.match(bg[0], /background-repeat:\s*no-repeat/, 'the background must not tile');
});

test('⚠️ the dim is a scrim BETWEEN the photo and the text, not a filter on either', () => {
  /*
   * The readability problem this exists for: an operator's photo is whatever they had, its contrast
   * varies across the frame, and white text over a bright sky is unreadable from the far side of a
   * lobby. Dimming the photo itself would need image editing; dimming the text would ruin it.
   */
  const html = S.renderSlideHtml({
    template: { background_content_id: 'c1', background_dim: 0.45, elements: [
      { slot: 'h', kind: 'head', box: {}, style: { size_cqw: 8 } }] },
    fields: { h: 'Legible' },
  }, { resolveImage: () => '/x.jpg' });

  assert.match(html, /<div class="scrim" style="background:rgba\(0,0,0,0\.45\)">/);
  assert.ok(html.indexOf('class="bg"') < html.indexOf('class="scrim"'), 'the scrim is under the photo');
  assert.ok(html.indexOf('class="scrim"') < html.indexOf('Legible'), 'the scrim covers the text');
});

test('no dim means no scrim element at all', () => {
  const html = S.renderSlideHtml({
    template: { background_content_id: 'c1', background_dim: 0, elements: [] }, fields: {},
  }, { resolveImage: () => '/x.jpg' });
  assert.ok(!html.includes('class="scrim"'));
});

test('⚠️ a background photo that will not resolve leaves the COLOUR, not a broken layer', () => {
  // The colour is what shows while the photo downloads and what stays if it never arrives — which
  // on a signage panel with a slow link is the case that actually happens.
  const html = S.renderSlideHtml({
    template: { background: '#123456', background_content_id: 'gone', background_dim: 0.5, elements: [] },
    fields: {},
  }, { resolveImage: () => null });
  assert.ok(!html.includes('class="bg"'), 'an empty background layer was emitted');
  assert.ok(!html.includes('class="scrim"'), 'a scrim was emitted with nothing to dim');
  assert.match(html, /background:#123456/);
});

test('⚠️ a background url cannot end the declaration and append its own', () => {
  /*
   * escapeHtml is not enough in a CSS context — it escapes the five HTML characters and none of
   * `; ( ) '`. A mutation run caught this: the value below rendered as
   * `url(https://x/a.jpg);position:fixed;width:300vw;height:300vh)`, i.e. real extra declarations
   * on somebody else's element.
   *
   * ⚠️ And it is REACHABLE, which is why it is fixed rather than noted: resolveImage returns
   * content.remote_url for remote content, and that is a URL an operator types.
   */
  for (const evil of [
    'https://x/a.jpg);position:fixed;width:300vw;height:300vh',
    "a.jpg');}body{display:none",
    'a.jpg) , url(https://evil/track.png',
  ]) {
    const html = S.renderSlideHtml({
      template: { background_content_id: 'c1', elements: [] }, fields: {},
    }, { resolveImage: () => evil });
    const rule = html.match(/<div class="bg"[^>]*>/)[0];
    const style = rule.match(/style="([^"]*)"/)[1];
    /*
     * ⚠️ Asserted on the RAW declaration, not on a decoded copy. The first version of this test
     * stripped %XX before looking and then flagged its own encoding as a leak — a browser parsing a
     * style attribute does no such decoding, so %3b is an inert three-character token and not a
     * statement separator.
     */
    assert.ok(!style.includes(';'), `a declaration separator survived: ${style}`);
    assert.equal((style.match(/\)/g) || []).length, 1, `the url() was closed early: ${style}`);
    assert.match(style, /^background-image:url\(/);
  }

  // ...and an ordinary URL still works, so the encoding is not simply destroying everything.
  const ok = S.renderSlideHtml({ template: { background_content_id: 'c1', elements: [] }, fields: {} },
    { resolveImage: () => '/uploads/content/a%20b.jpg' });
  assert.match(ok, /url\(\/uploads\/content\/a%2520b\.jpg\)|url\(\/uploads\/content\/a%20b\.jpg\)/);
});

test('the dim is clamped, so it can never hide the slide outright', () => {
  const n = S.normalizeSlide({ template: { background_content_id: 'c', background_dim: 40, elements: [] } });
  assert.equal(n.backgroundDim, 1);
  assert.equal(S.normalizeSlide({ template: { background_dim: -5, elements: [] } }).backgroundDim, 0);
});

/*
 * ⚠️ THE SHAPE IS CARRIED, AND THE RENDERER DOES NOT YET USE IT.
 *
 * Positions are % and sizes are cqw, both against the stage — so the stage's aspect IS the
 * composition, and handed the panel's own box a 16:9 deck on a 2560x1800 screen becomes a different
 * slide: the `cover` background crops ~20% off each side, headlines run past the edges, the eyebrow
 * sits off-screen. Reproduced on an Android panel.
 *
 * ⚠️ AND THE OBVIOUS CSS FIX IS THE ONE THAT MUST NOT SHIP. Letterboxing the stage with
 * `width:min(100cqw, calc(100cqh * W / H))` is correct on a modern engine and was verified as such
 * — and on Android WebView 91 (what a lot of signage hardware still runs, and what this was found
 * on) it painted the FIRST slide of a deck and then went black for every one after it. Tried three
 * ways: a flex wrapper, an absolutely-positioned wrapper, and containment moved onto the body with
 * no wrapper at all. All three black; the unchanged document renders every slide. @supports does
 * not save it either, because WebView 91 has no container queries, so the guard is simply false and
 * the panel is left on a rule that was already wrong for it.
 *
 * So the deck's shape is stamped onto every published slide and normalised here, ready — but the
 * renderer keeps the full-box stage until the sizing stops depending on container queries at all
 * (a fixed design canvas plus a scale transform, which fixes cqw on those panels too). Publishing
 * it now means every deck published from today already carries the shape when that lands.
 */
test('the deck’s shape is carried on the slide, defaulting to what those decks were laid out in', () => {
  assert.equal(S.normalizeSlide({ template: { elements: [] } }).aspect, '16:9');
  assert.equal(S.normalizeSlide({ template: { aspect: 'wide', elements: [] } }).aspect, '16:9');
  assert.equal(S.normalizeSlide({ template: { aspect: '9:16', elements: [] } }).aspect, '9:16');
});

/*
 * ⚠️ AND THE STAGE STAYS A PLAIN FULL BOX UNTIL THEN. This is the regression test for the black
 * panel above: body’s direct child is the stage, with no wrapper element, and no container unit
 * appears in its sizing. Every variant that broke WebView 91 violated one of these two lines.
 */
test('the stage is body’s direct child and sized without container units', () => {
  const html = S.renderSlideHtml({ template: { aspect: '16:9', elements: [] }, fields: {} });
  assert.match(html, /<body><div class="stage">/, 'no wrapper may sit between body and the stage');
  assert.ok(!/class="frame"/.test(html), 'and no frame element may come back');

  const stage = html.slice(html.indexOf('.stage {'), html.indexOf('}', html.indexOf('.stage {')) + 1);
  assert.match(stage, /width:100%/);
  assert.match(stage, /height:100%/);
  assert.ok(!/cq[wh]/.test(stage), `the stage’s own size must not use container units: ${stage}`);
});
