'use strict';

/*
 * FIT_SCRIPT — the few lines every slide carries that make it the same composition on every panel.
 *
 * ⚠️ WHY THIS IS TESTED AGAINST A STUB DOM AND NOT A BROWSER. The script exists for two engines at
 * once: a modern one, where it letterboxes the stage; and an old Android WebView, where it is ALSO
 * the only thing that gives the type a size at all, because container query units shipped in Chrome
 * 105 and a 2021-era WebView drops `font-size:6.2cqw` as an invalid declaration. The second case is
 * the one that cannot be checked here — no browser on this machine is that old, and the emulator
 * that is stopped painting its WebView altogether. So what is pinned down is the arithmetic and the
 * parsing, run against a stub that behaves the way that engine does: the declaration never reached
 * the CSSOM, and the style ATTRIBUTE still holds the text the server wrote.
 *
 * If this passes and a panel still renders wrong, the fault is in the browser plumbing, not here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/slide-render');

/*
 * The smallest DOM the script actually touches. Deliberately NOT jsdom: the point is to model an
 * engine that REJECTED the cqw declarations, and a compliant DOM would accept them and prove
 * nothing. `style` here is a bag that records what was assigned, exactly like the real one, while
 * getAttribute('style') returns the untouched source text — which is the asymmetry the script
 * depends on.
 */
function stubDom(html, panelW, panelH) {
  const nodes = [];
  const tagRe = /<div class="e[^"]*"([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[1];
    const style = /style="([^"]*)"/.exec(attrs);
    nodes.push({ _style: style ? style[1] : '', style: {}, getAttribute: (n) => (n === 'style' ? style && style[1] : null) });
  }
  const stage = { style: {} };
  return {
    stage,
    nodes,
    window: {
      innerWidth: panelW,
      innerHeight: panelH,
      addEventListener() {},
    },
    document: {
      documentElement: { clientWidth: panelW, clientHeight: panelH },
      querySelector: (s) => (s === '.stage' ? stage : null),
      querySelectorAll: () => nodes,
    },
  };
}

/** Run the emitted script against the stub, the way the WebView would. */
function runFitter(html, panelW, panelH) {
  const env = stubDom(html, panelW, panelH);
  const src = html.slice(html.indexOf('<script>\n(function () {\n  var AW'));
  const body = src.slice(src.indexOf('(function'), src.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', body)(env.document, env.window);
  return env;
}

const deck = (aspect) => S.renderSlideHtml({
  template: {
    aspect,
    elements: [
      { kind: 'headline', slot: 'h', box: { x: 7, y: 20, w: 74, h: 30 }, style: { size_cqw: 6.2 } },
      { kind: 'box', box: { x: 10, y: 60, w: 30, h: 10 }, style: { radius_cqw: 2 } },
    ],
  },
  fields: { h: 'A real authoring surface' },
});

test('a 16:9 deck on a 2560x1800 panel is letterboxed, not stretched to the panel', () => {
  /*
   * The bug in one assertion. 2560x1800 is 1.42:1; a 16:9 slide given that whole box has its
   * `cover` background cropped a fifth off each side and its headline running past the edge. The
   * stage has to be the widest 16:9 box that fits, centred.
   */
  const env = runFitter(deck('16:9'), 2560, 1800);
  assert.equal(env.stage.style.width, '2560px', 'width is the panel’s, since the panel is narrower than 16:9');
  assert.equal(env.stage.style.height, '1440px', 'and the height follows the SHAPE, not the panel');
  assert.equal(env.stage.style.marginTop, '180px', 'centred: (1800 - 1440) / 2');
  assert.equal(env.stage.style.marginLeft, 'auto');
});

test('a 16:9 deck on an ultrawide panel letterboxes the other way', () => {
  const env = runFitter(deck('16:9'), 3440, 1440);
  assert.equal(env.stage.style.width, '2560px', 'width is capped by the height: 1440 * 16 / 9');
  assert.equal(env.stage.style.height, '1440px');
  assert.equal(env.stage.style.marginTop, '0px', 'nothing left over vertically');
});

test('a portrait deck keeps its own shape, not a rotated guess at 16:9', () => {
  const env = runFitter(deck('9:16'), 1080, 1920);
  assert.equal(env.stage.style.width, '1080px');
  assert.equal(env.stage.style.height, '1920px');
});

/*
 * ⚠️ THE HALF THAT MATTERS ON OLD HARDWARE. On Android WebView 91 every `font-size:Ncqw` is an
 * invalid declaration the engine throws away, so those panels have never rendered a slide at the
 * authored size — the oversized, clipped text that started this was the default font size being
 * boosted, not a layout bug. 1cqw is 1% of the stage's width by definition, so the conversion is
 * exact and the panel finally gets what the editor showed.
 */
test('cqw is converted to px against the fitted stage width', () => {
  const env = runFitter(deck('16:9'), 2560, 1800);
  const sized = env.nodes.filter((n) => n.style.fontSize || n.style.borderRadius);
  assert.ok(sized.length >= 2, 'both the type and the corner radius must be converted');

  // 6.2cqw of a 2560-wide stage.
  const font = env.nodes.find((n) => /font-size:6\.2cqw/.test(n._style));
  assert.equal(font.style.fontSize, `${6.2 / 100 * 2560}px`);

  // 2cqw of the same stage — radius resolves against WIDTH too, like the real unit.
  const box = env.nodes.find((n) => /border-radius:2cqw/.test(n._style));
  assert.equal(box.style.borderRadius, `${2 / 100 * 2560}px`);
});

test('the same slide on a smaller panel gets proportionally smaller type', () => {
  const big = runFitter(deck('16:9'), 2560, 1800);
  const small = runFitter(deck('16:9'), 1280, 900);
  const f = (env) => parseFloat(env.nodes.find((n) => /font-size:6\.2cqw/.test(n._style)).style.fontSize);
  assert.equal(f(big) / f(small), 2, 'half the panel, half the type — the composition is identical');
});

test('a panel that reports no size is left alone rather than collapsed to nothing', () => {
  // A WebView mid-teardown answers 0. Writing 0px there is a black screen.
  const env = runFitter(deck('16:9'), 0, 0);
  assert.equal(env.stage.style.width, undefined, 'nothing may be written from a zero measurement');
});

test('the fitter re-runs on resize, so a rotated panel re-letterboxes', () => {
  const html = deck('16:9');
  assert.match(html, /addEventListener\('resize'/, 'a rotation arrives as a resize and must re-fit');
});
