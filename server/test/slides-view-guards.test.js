'use strict';

/*
 * Source guards on the slide editor.
 *
 * ⚠️ THE BUG THESE EXIST FOR BIT TWICE, IN TWO TABS, AND WAS INVISIBLE TO EVERYTHING.
 *
 * A live-value handler that calls the full repaint replaces the innerHTML of the panel it lives
 * in — including the control the pointer is on. The slider is destroyed by its own first input
 * event, so it moves one step and stops; a colour picker closes the moment you pick a colour. The
 * panel renders correctly, the code reads correctly, and it cannot be used.
 *
 * It shipped in the Style tab, was fixed there, and was still present in the Motion tab because
 * that branch was never touched. Nothing caught it: a syntax check passes, and this project has no
 * DOM test runner.
 *
 * ⚠️ SOURCE ASSERTIONS RATHER THAN A DOM, DELIBERATELY. Driving the real view in jsdom does catch
 * this — it was proven against the pre-fix file, where both motion sliders fail a "does this
 * element survive its own input event" check — but jsdom is a large dependency to add for one
 * class of bug. These are cheap and they encode the rule. If frontend tests earn their keep later,
 * the DOM harness is the better tool and should replace this file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEW_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'slides.js');
const VIEW = fs.readFileSync(VIEW_PATH, 'utf8');

/* Strip comments so a rule cannot be satisfied — or broken — by prose. Both have happened here. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const CODE = code(VIEW);

test('⚠️ no live-value handler triggers a full repaint', () => {
  /*
   * `oninput` fires continuously while a control is being dragged or typed into. If its handler
   * reaches touch() — which calls paintAll() and rewrites the panel — the control is destroyed
   * under the pointer. touchValue() exists precisely to update everything EXCEPT the inspector.
   */
  const offenders = [];
  const re = /\.oninput\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(\{[\s\S]*?\n\s*\}|[^;\n]*)/g;
  let m;
  while ((m = re.exec(CODE))) {
    if (/\btouch\s*\(/.test(m[1]) && !/\btouchValue\s*\(/.test(m[1])) {
      offenders.push(m[0].slice(0, 90).replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(offenders, [],
    'an oninput handler calls touch(), which rebuilds the panel and destroys the control being '
    + 'dragged — use touchValue():\n' + offenders.join('\n'));
});

test('⚠️ the two update paths both exist and are distinct', () => {
  // If touchValue is ever collapsed back into touch, the guard above passes while the bug returns.
  assert.match(CODE, /function touch\s*\(/, 'touch() is gone');
  assert.match(CODE, /function touchValue\s*\(/, 'touchValue() is gone — the split that fixes this');
  const tv = CODE.slice(CODE.indexOf('function touchValue'));
  const body = tv.slice(0, tv.indexOf('\n}'));
  assert.ok(!/paintAll\s*\(/.test(body),
    'touchValue() calls paintAll(), so it repaints the inspector and is no different from touch()');
  assert.ok(/renderStage\s*\(/.test(body), 'touchValue() does not update the stage, so edits are invisible');
});

test('⚠️ every tab that edits values uses the slider+number pair, not a bare slider', () => {
  /*
   * A 290px panel gives a slider roughly 120px of travel. That is fine for finding a look and
   * useless for matching one — two slides needing the same margin cannot be said with a drag. Every
   * numeric control therefore has a typed input beside it, and they mirror each other.
   */
  for (const [tab, marker] of [['style', 'bindPair'], ['motion', 'bindMotion'], ['slide', 'bindSlidePair']]) {
    assert.match(CODE, new RegExp(`\\b${marker}\\b`), `the ${tab} tab lost its slider/number binding`);
  }
  // The helper that produced a bare slider with a static readout is gone, and must stay gone: every
  // one of its call sites wired it to touch().
  assert.ok(!/\bconst rng\s*=/.test(CODE), 'the old bare-slider helper is back');
});

test('⚠️ a typed number commits on change, never on input', () => {
  /*
   * On `input`, a half-typed "-" or "1." reads as 0 and yanks the element across the stage while
   * somebody is still typing. Every number box in here must be bound to `change`.
   */
  const numberBindings = CODE.match(/n\.on(input|change)\s*=/g) || [];
  assert.ok(numberBindings.length >= 3, 'the number boxes are not bound at all');
  assert.ok(!numberBindings.some((b) => b.includes('oninput')),
    'a number box commits on input, so a half-typed value moves the element');
});

test('the motion tab shows timing against the slide dwell', () => {
  // Delay and duration are meaningless in isolation: 0.8s is nothing on a ten-second slide and most
  // of a two-second one. An element that settles after the slide is replaced reads as text that
  // never arrives, and only the comparison can say so.
  assert.match(CODE, /function renderMiniTimeline\s*\(/, 'the motion timing view is gone');
  assert.match(CODE, /dwell_sec/, 'the timing view does not consult the dwell');
  assert.match(VIEW, /never finish/, 'nothing tells an operator when motion outlives its slide');
});

test('⚠️ the editor previews the same fonts and keyframes the server emits', () => {
  /*
   * A tool that shows something other than what ships is a liar about the one thing it is for. The
   * keyframe names and the font faces are therefore built from the server's own values — the
   * catalogue is fetched rather than duplicated, and the @keyframes names match slide-render.js.
   */
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'slide-render.js'), 'utf8');
  const serverKeyframes = [...renderer.matchAll(/@keyframes (st-[a-z-]+)/g)].map((m) => m[1]).sort();
  const editorKeyframes = [...VIEW.matchAll(/@keyframes (st-[a-z-]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(editorKeyframes, serverKeyframes,
    'the editor animates with different keyframes than the renderer emits');

  assert.match(CODE, /api\.get\('\/widgets\/slide-fonts'\)/,
    'the font list is hardcoded in the editor instead of fetched, so it will drift');
});
