'use strict';

/*
 * Two bugs meet in this file, and the second only becomes reachable once the first is fixed.
 *
 * 1. The transition runtime never loaded on BrightSign. `transitionRuntimeReady()` is a presence
 *    check on three globals and touches no WebGL at all — so "transitions don't work on BrightSign"
 *    was never a GPU story. A BrightSign roHtmlWidget runs with `nodejs_enabled: true`, which puts
 *    Node's `module` into classic-script scope, so every UMD module that exported with an `else`
 *    took the CommonJS branch and never assigned its browser global.
 *
 * 2. Once the runtime DOES load there, video transitions would run against blank textures. On a
 *    hardware video plane `drawImage(video)` succeeds, throws nothing, and paints a fully
 *    TRANSPARENT frame — so the wipe fades from nothing, behind a video plane that is still lit.
 *    Fixing (1) without (2) is therefore a REGRESSION: visibly worse than today's hard cut.
 *
 * The guard already existed for screenshots (`videoFrameIsCapturable`, an ALPHA probe) and simply
 * was not wired into the transition path, which asked `isMediaReadable()` — a CORS question, i.e.
 * "am I allowed to read this", not "did any pixels arrive".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PLAYER = read('server/player/index.html');

// ---------------------------------------------------------------- UMD export shape

// Every module a browser is meant to see must assign its global UNCONDITIONALLY. An `else` against
// a `module`/`module.exports` test is the bug: it is invisible everywhere except a page with Node
// integration, where it silently removes the global and every consumer falls back.
const BROWSER_SHARED_MODULES = [
  ['shared/Transitions/params.js', 'TransitionParams'],
  ['shared/Transitions/renderer.js', 'TransitionRenderer'],
  ['server/lib/schedule-eval.js', 'ScheduleEval'],
  ['server/lib/player-media-health.js', 'PlayerMediaHealth'],
  ['server/lib/media-mute.js', 'MediaMute'],
  ['server/lib/orientation-style.js', 'OrientationStyle'],
  ['server/lib/wall-geometry.js', 'WallGeometry'],
  ['tizen/js/transitions.js', 'TransitionParams'],
];

for (const [file, globalName] of BROWSER_SHARED_MODULES) {
  test(`#BS-UMD: ${file} exports ${globalName} without an else`, () => {
    const src = read(file);
    // The exact hazard: a CommonJS test whose ELSE branch is the only path to the browser global.
    const elseHazard = /module\.exports[^\n]*\n?\s*(\}\s*)?else\b/.test(src)
      || /if\s*\(\s*typeof module[^)]*\)\s*module\.exports[^\n]*\n\s*else\b/.test(src);
    assert.equal(elseHazard, false,
      `${file} exports its browser global from an else branch — invisible except under Node ` +
      `integration (BrightSign), where the global silently never appears`);
    assert.ok(
      new RegExp(`(self|root|window)\\.${globalName}\\s*=`).test(src),
      `${file} must assign ${globalName} for browsers`,
    );
  });
}

test('#BS-UMD: the runtime check is a plain global presence test, so a missing global IS the outage', () => {
  // Documents WHY the export shape matters this much: nothing here touches WebGL, so a module-format
  // problem and a GPU problem are indistinguishable from the outside.
  const fn = PLAYER.slice(PLAYER.indexOf('function transitionRuntimeReady()'));
  const body = fn.slice(0, fn.indexOf('}') + 1);
  assert.match(body, /window\.TransitionRenderer/);
  assert.match(body, /window\.TransitionParams/);
  assert.match(body, /window\.__TRANSITION_SHADERS/);
  assert.ok(!/getContext|webgl/i.test(body), 'this check must not be mistaken for a WebGL probe');
});

// ---------------------------------------------------------------- hardware-plane guard

// Extract a function body out of index.html by brace matching — the established pattern in this
// suite (see player-capture-hardware-plane.test.js).
function extract(name) {
  const at = PLAYER.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found`);
  let i = PLAYER.indexOf('{', at), depth = 0, end = i;
  for (; end < PLAYER.length; end++) {
    if (PLAYER[end] === '{') depth++;
    else if (PLAYER[end] === '}' && --depth === 0) { end++; break; }
  }
  return PLAYER.slice(at, end);
}

// A canvas whose pixels we control, so "video produced nothing" is expressible.
function fakeCanvas(alpha) {
  return {
    width: 0, height: 0,
    getContext: () => ({
      drawImage() { /* succeeds and paints nothing, exactly like a hardware plane */ },
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(0).map((_, i) => (i % 4 === 3 ? alpha : 0)) }),
    }),
  };
}

function runCapturable(alpha) {
  const src = extract('videoFrameIsCapturable');
  const fn = new Function('document', `${src}; return videoFrameIsCapturable;`)({
    createElement: () => fakeCanvas(alpha),
  });
  return fn({ readyState: 4, videoWidth: 1920 });
}

test('#BS-guard: a transparent frame means the pixels never arrived', () => {
  assert.equal(runCapturable(0), false, 'alpha 0 across the probe is a hardware plane, not a video');
});

test('#BS-guard: a genuine fade-to-black is still a captured frame', () => {
  // The biconditional that makes the probe honest: black pixels are opaque, so a legitimately dark
  // frame must NOT be mistaken for "nothing arrived" — otherwise every fade would hard-cut.
  assert.equal(runCapturable(255), true, 'opaque black is a real frame');
});

test('#BS-guard: the transition path consults capturability, not just CORS', () => {
  const fn = extract('currentTexturableFrame');
  assert.match(fn, /videoCompositingAvailable/,
    'the outgoing frame must be gated on whether pixels actually arrive');
  // isMediaReadable answers a different question and must not be the only gate on the video branch.
  const videoBranch = fn.slice(fn.indexOf("querySelector('video')"));
  assert.ok(videoBranch.indexOf('videoCompositingAvailable') < videoBranch.indexOf('isMediaReadable'),
    'the capturability guard must run BEFORE the CORS check short-circuits the branch');
});

test('#BS-guard: an incoming video is not wiped in from a texture it cannot supply', () => {
  const at = PLAYER.indexOf('const isVideoBufferable');
  assert.ok(at > 0);
  const decl = PLAYER.slice(at, PLAYER.indexOf(';', at));
  assert.match(decl, /_videoCompositingOk !== false/,
    'image→video would otherwise fade in from a transparent texture');
  // Plain solo videos also route through the buffered path (first-frame hold, no wipe), so the
  // gate itself must NOT require a transition runtime — the wipe decision inside
  // renderVideoBuffered does that instead. Assert both halves of that split.
  assert.ok(!/transitionRuntimeReady\(\)/.test(decl),
    'the gate holds the old frame for every solo video; requiring a runtime here would ' +
    'send plain videos back to the teardown-first legacy branch (black blink on every boundary)');
  const wipe = extract('renderVideoBuffered');
  assert.match(wipe, /transitionRuntimeReady\(\)/,
    'the wipe itself still requires the runtime — a hold is not a transition');
});

test('#BS-guard: undetermined is treated as available, so a fresh player is not crippled', () => {
  // The probe needs a playing video; the first item on a cold start has not run one. Defaulting to
  // "unavailable" would disable video transitions everywhere until a video happened to play.
  const fn = extract('videoCompositingAvailable');
  assert.match(fn, /return true/, 'an undecided probe must not latch off');
  assert.match(fn, /_videoCompositingOk !== null/, 'the platform answer must be cached once known');
});
