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

test('#BS-guard: the hold is not gated on the plane probe or a transition', () => {
  // The dispatch gate must route EVERY solo video through the buffered hold — including
  // hardware-plane platforms (the fix's whole point) and plain transition-less clips. This is
  // deliberately the only text assertion left here: the gate is a renderContent fragment, too
  // entangled for the new-Function harness below, while the hold behaviour itself IS asserted
  // behaviourally. The probe still protects the wipe's `to` texture inside renderVideoBuffered.
  const at = PLAYER.indexOf('const isVideoBufferable');
  assert.ok(at > 0);
  const decl = PLAYER.slice(at, PLAYER.indexOf(';', at));
  assert.ok(!/_videoCompositingOk/.test(decl),
    'a plane probe on the gate sends BrightSign/Tizen back to the teardown-first legacy branch');
  assert.ok(!/transitionRuntimeReady\(\)/.test(decl),
    'a runtime requirement on the gate sends plain videos back to the black blink');
});

// ---------------------------------------------------------------- buffered-hold behaviour
//
// Run the REAL renderVideoBuffered (+ the real wireSoloVideoPlayback) against a fake element
// and a fake clock: "teardown is invoked exactly once, from the first-frame callback" as fact,
// not as a reading of the source. Outer mutable bindings are boxed (SEQ/BOX) because new
// Function parameters cannot see reassignment.

function harnessBuffered({ transition = null, planeOk = true, rvfc = true, interacted = true } = {}) {
  const calls = { teardown: 0, order: [], appended: [], mutedAtMount: null, skips: [], wipes: [] };
  const timers = new Map();
  let seq = 0;
  const SEQ = { v: 7 };
  const BOX = { cur: null, pend: -1 };
  const listeners = {};
  const video = {
    style: {}, children: [],
    muted: false, loop: false, paused: true, readyState: 0, videoWidth: 0, volume: 0,
    src: '',
    play() { calls.order.push('play'); this.paused = false; return Promise.resolve(); },
    pause() { calls.order.push('pause'); this.paused = true; },
    load() {},
    removeAttribute() {},
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    appendChild(c) { this.children.push(c); },
  };
  if (rvfc) video.requestVideoFrameCallback = (cb) => { video.__rvfc = cb; };
  const container = { style: {}, appendChild(c) { calls.appended.push(c); } };
  const outgoing = {
    onended: () => {}, onerror: () => {}, onloadeddata: () => {},
    paused: false,
    pause() { this.paused = true; calls.order.push('out-pause'); },
  };
  BOX.cur = outgoing;
  const trackStub = () => ({ addEventListener() {}, track: {} });
  const env = {
    document: {
      createElement: (tag) => (tag === 'video' ? video : trackStub()),
      getElementById: () => container,
    },
    mediaUrl: () => 'http://x/clip.mp4',
    currentTexturableFrame: () => 'FROM',
    isMediaReadable: () => true,
    stageGeometry: () => ({ w: 1920, h: 1080 }),
    fitToCanvas: () => 'TO',
    videoCompositingAvailable: () => planeOk,
    transitionRuntimeReady: () => true,
    runGlWipe: (from, to, t, ms, onStart, mount) => { calls.wipes.push([from, to]); video.__mount = mount; },
    teardownCurrentMedia: () => { calls.teardown++; SEQ.v++; },  // the real one invalidates in-flight warm-ups
    playlist: [{ id: 'a' }, { id: 'b' }],
    wallConfig: null,   // the gate excluded wall/group at dispatch; mount re-reads for mid-window flips
    groupSync: null,
    userHasInteracted: interacted,
    config: { serverUrl: 'http://x' },
    nextItem: () => {},
    mediaFailureSkip: (el, label) => calls.skips.push(label),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    console: { log() {}, warn() {}, error() {} },
    SEQ,
    BOX,
  };
  const names = Object.keys(env);
  const body = `${extract('wireSoloVideoPlayback')};${extract('attachSubtitleTrack')};` +
    extract('renderVideoBuffered')
      .replace(/\brenderSeq\b/g, 'SEQ.v')
      .replace(/\bcurrentVideoEl\b/g, 'BOX.cur')
      .replace(/\bpendingVideoSeq\b/g, 'BOX.pend') +
    '; return renderVideoBuffered;';
  const renderVideoBuffered = new Function(...names, body)(...names.map((k) => env[k]));
  const item = { mime_type: 'video/mp4', filename: 'clip.mp4', muted: false, transition };
  renderVideoBuffered(item);
  const fire = (ev) => { for (const fn of (listeners[ev] || [])) fn(); };
  const fireDue = (limit) => {
    for (const [id, t] of [...timers]) {
      if (t.ms <= limit) { timers.delete(id); t.fn(); }
    }
  };
  const present = async () => {
    video.readyState = 4; video.videoWidth = 1280;
    fire('loadeddata');
    await Promise.resolve();  // play().then(armFrame)
    await Promise.resolve();
  };
  return { calls, timers, SEQ, BOX, video, outgoing, container, listeners, fire, fireDue, present, item };
}

test('hold: dispatch mounts nothing — teardown runs once, from the first frame', async () => {
  // The bug being fixed: the legacy branch tore down BEFORE the clip loaded (black blink).
  const h = harnessBuffered();
  assert.equal(h.calls.teardown, 0, 'dispatch must hold the old frame, not tear it down');
  assert.equal(h.calls.appended.length, 0, 'nothing mounts before the first frame');
  assert.equal(h.BOX.pend, 7, 'the pending-mount sentinel is armed for the health check');

  await h.present();
  assert.equal(h.calls.teardown, 0, 'loadeddata alone still mounts nothing — only a presented frame does');
  h.video.__rvfc();
  assert.equal(h.calls.teardown, 1, 'teardown runs exactly once, from the first-frame callback');
  assert.deepEqual(h.calls.appended, [h.video], 'the warmed clip (not a fresh element) is what mounts');
  assert.ok(h.BOX.pend !== h.SEQ.v, 'mount clears the pending sentinel via the teardown bump');
});

test('hold: mount pauses before it plays, so the document play hook runs', async () => {
  // A still-playing element fires no 'play' event on play(): the screen-off hold, alarm-mute
  // and mediaVolume hook would be skipped and the mount forces volume 1.0.
  const h = harnessBuffered();
  await h.present();
  h.video.__rvfc();
  assert.deepEqual(h.calls.order, ['out-pause', 'play', 'pause', 'play'],
    'outgoing yields its decoder, then warm-play, then pause-before-mount, then the play that fires the hook');
  assert.equal(h.video.muted, false, 'real (un)mute policy applies at mount, not the warm-play mute');
  assert.equal(h.video.volume, 1.0);
});

test('hold: the outgoing clip is disarmed at dispatch and yields its decoder', async () => {
  const h = harnessBuffered();
  assert.equal(h.outgoing.onended, null, 'a natural ended mid-window must not skip past the incoming clip');
  assert.equal(h.outgoing.onerror, null);
  assert.equal(h.outgoing.paused, true, 'no wipe needs its frame: pause it for single-decoder boxes');
  await h.present();
  h.video.__rvfc();
  assert.equal(h.calls.teardown, 1);
});

test('hold: a superseded warm-up that fails must not cut the new item short', async () => {
  const h = harnessBuffered();
  h.SEQ.v++;  // a newer dispatch took over (renderContent bump)
  h.fire('error');
  assert.deepEqual(h.calls.skips, [], 'mediaFailureSkip would scheduleAdvance(3000) against the NEW item');
  assert.equal(h.calls.teardown, 0, 'the orphan is abandoned, never mounted');
});

test('hold: without rVFC the short timer still releases the hold', async () => {
  // A detached element may never PRESENT (no compositor layer) — rVFC then never fires and the
  // full 800ms watchdog would be the release. The 150ms fallback mounts a decoding element instead.
  const h = harnessBuffered({ rvfc: false });
  await h.present();
  assert.equal(h.calls.teardown, 0);
  h.fireDue(150);
  assert.equal(h.calls.teardown, 1, 'fallback mounts; the 800ms watchdog stays only for slow loads');
  assert.deepEqual(h.calls.appended, [h.video]);
});

test('plane: no wipe from a transparent texture, but the hold still runs', async () => {
  // BrightSign/Tizen: the warm-play snapshot comes back transparent, so the wipe must not run —
  // and the clip must STILL hold-then-mount instead of falling back to the blinking legacy branch.
  const h = harnessBuffered({ transition: { effects: ['fade'], durationMs: 300 }, planeOk: false });
  await h.present();
  h.video.__rvfc();
  assert.deepEqual(h.calls.wipes, [], 'no wipe fades in from nothing');
  assert.equal(h.calls.teardown, 1, 'plain hard-cut hold, on the first frame');
  assert.deepEqual(h.calls.appended, [h.video]);
});

test('wipe: a texturable platform still wipes from the outgoing into the incoming frame', async () => {
  const h = harnessBuffered({ transition: { effects: ['fade'], durationMs: 300 }, planeOk: true });
  assert.equal(h.outgoing.paused, false, 'the wipe needs the outgoing frame: it keeps playing behind the GL overlay');
  await h.present();
  h.video.__rvfc();
  assert.deepEqual(h.calls.wipes, [['FROM', 'TO']], 'wipe runs from the held frame into the snapshot');
  assert.equal(h.calls.teardown, 0, 'nothing mounts until the wipe completes');
  h.video.__mount();
  assert.equal(h.calls.teardown, 1, 'then the warmed clip mounts exactly once');
});

test('#BS-guard: undetermined is treated as available, so a fresh player is not crippled', () => {
  // The probe needs a playing video; the first item on a cold start has not run one. Defaulting to
  // "unavailable" would disable video transitions everywhere until a video happened to play.
  const fn = extract('videoCompositingAvailable');
  assert.match(fn, /return true/, 'an undecided probe must not latch off');
  assert.match(fn, /_videoCompositingOk !== null/, 'the platform answer must be cached once known');
});
