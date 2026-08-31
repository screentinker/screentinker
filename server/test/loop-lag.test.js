'use strict';

// #142 step 2 — deterministic unit tests for the event-loop-lag band transitions.
// Pure function, no sockets/timing. Isolate the DB to a temp dir BEFORE requiring
// the module (requiring it pulls in db/database, which initialises a DB on load).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-lag-unit-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextBand } = require('../services/loop-lag');

// config defaults exercised here: elevated=100ms, critical=250ms, releaseSamples=5,
// deadband=0.5 -> release-below thresholds: elevated@50ms, critical@125ms.

/*
 * ⚠️ REWRITTEN FOR #307. These used to pass a single window's p99 and a calm counter, because that
 * is what the band read. It was the wrong instrument and the tests could not see it: every case
 * here was internally consistent while production sat at the wrong band for sixteen days.
 *
 * The band now reads the MEDIAN of the last N windows. `nextBand(cur, sustained, spike)` returns a
 * band; there is no calm counter, because a median is already the smoothing that counter was
 * imitating.
 */

test('UP moves on the sustained measure and can skip a level', () => {
  assert.equal(nextBand('normal', 50, 50), 'normal', 'below elevated stays normal');
  assert.equal(nextBand('normal', 100, 100), 'elevated', 'crossing elevated moves up');
  assert.equal(nextBand('normal', 250, 250), 'critical', 'sustained critical skips elevated');
  assert.equal(nextBand('elevated', 250, 250), 'critical');
});

test('⚠️ ONE outlier window cannot move the band', () => {
  /*
   * THE #307 DEFECT, stated directly. A sampling window is one second at 20ms resolution, so its
   * histogram holds ~49 records and its 99th percentile IS its maximum — measured on production,
   * `avg(max_ms - p99_ms) = 0.000` across an hour. The band was therefore decided by the worst
   * single 20ms bucket per second.
   */
  assert.equal(nextBand('normal', 22, 213), 'normal',
    'a 213ms spike on an otherwise idle box must not raise the band');
  assert.equal(nextBand('elevated', 20, 96), 'normal',
    'and a calm median must release even while single windows still spike');
});

test('⚠️ but a CATASTROPHIC window escalates immediately', () => {
  // A median that needs eight seconds to notice is the wrong instrument for a loop that has
  // actually stopped; the shed valve has to open during the incident, not after it.
  assert.equal(nextBand('normal', 20, 1000), 'critical', '4x critical in one window trips now');
  assert.equal(nextBand('normal', 20, 999), 'normal', 'just under the spike factor does not');
});

test('deadband holds the band against small fluctuations', () => {
  assert.equal(nextBand('elevated', 80, 80), 'elevated', 'between release(50) and up(100): hold');
  assert.equal(nextBand('critical', 200, 200), 'critical', 'between release(125) and up(250): hold');
});

test('DOWN steps one level at a time', () => {
  assert.equal(nextBand('critical', 20, 20), 'elevated', 'critical never jumps straight to normal');
  assert.equal(nextBand('elevated', 20, 20), 'normal');
});

test('⚠️ REPLAY: the real production distribution must read as normal', () => {
  /*
   * Sampled from prod's own event_loop_lag table over an hour on 2026-08-31, while it was reporting
   * `elevated` and had been for sixteen days: p50 pinned at the 20ms measurement floor, with 40% of
   * windows carrying one outlier above the 50ms release threshold. That server was healthy —
   * maintenance sweeps were finishing in 5ms.
   *
   * Under the old rule this shape could never release: it required five CONSECUTIVE windows with no
   * outlier, and two windows in five had one.
   */
  const windows = [];
  for (let i = 0; i < 60; i++) windows.push(i % 5 < 2 ? 60 + (i % 7) * 20 : 20.3);  // 40% spiking
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  let band = 'elevated';
  const recent = [];
  for (const w of windows) {
    recent.push(w);
    while (recent.length > 15) recent.shift();
    band = nextBand(band, median(recent), w);
  }
  assert.equal(band, 'normal', 'a healthy server with periodic single-window spikes must read normal');
});

test('⚠️ REPLAY: sustained pressure still reads critical, and recovers when it lifts', () => {
  // Bold's #307: the band SHOULD have been critical during the backup, and should have come back
  // afterwards. The complaint was never that it rose — it was that it never fell.
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const recent = [];
  let band = 'normal';
  const step = (w) => {
    recent.push(w);
    while (recent.length > 15) recent.shift();
    band = nextBand(band, median(recent), w);
  };
  for (let i = 0; i < 30; i++) step(600 + (i % 5) * 700);       // the backup window
  assert.equal(band, 'critical', 'sustained multi-hundred-ms lag is genuinely critical');
  for (let i = 0; i < 40; i++) step(i % 6 === 0 ? 180 : 21);    // I/O gone, occasional blip
  assert.equal(band, 'normal', 'and it must recover once the pressure lifts — the actual bug');
});


/* ============ the band's INPUT, not just its transition rule ============ */

/*
 * ⚠️ THESE EXIST BECAUSE THE TRANSITION TESTS ABOVE CANNOT FAIL FOR THE RIGHT REASON.
 *
 * They compute a median themselves and hand it to nextBand, so they prove the RULE. They say
 * nothing about whether sample() feeds it that number — and that gap is exactly #307: every
 * transition case passed, correctly, while production sat at the wrong band for sixteen days
 * because the caller was passing one window's p99. Mutating the call site left all of them green.
 */

const LL = require('../services/loop-lag');
const CFG = require('../config');

test('⚠️ the band input is the MEDIAN of recent windows, not the latest or the worst', () => {
  LL._recentP99.length = 0;
  for (const v of [20, 20, 20, 900, 20, 20, 20]) LL._pushP99(v);
  assert.equal(LL._sustainedP99(), 20, 'one 900ms window must not move the median');
  assert.notEqual(LL._sustainedP99(), 900, 'the input must not be the maximum');
  assert.notEqual(LL._sustainedP99(), 20.0001, 'sanity');
});

test('the window is bounded, so old pressure ages out', () => {
  LL._recentP99.length = 0;
  for (let i = 0; i < CFG.lagBandWindowSamples * 3; i++) LL._pushP99(800);
  assert.equal(LL._recentP99.length, CFG.lagBandWindowSamples, 'the window must not grow');
  for (let i = 0; i < CFG.lagBandWindowSamples; i++) LL._pushP99(20);
  assert.equal(LL._sustainedP99(), 20, 'a full window of calm must fully replace the pressure');
});

test('⚠️ sample() passes the SUSTAINED value to the band, not the window p99', () => {
  /*
   * A source-level guard, because the alternative is standing up the real histogram and timers. It
   * is narrow on purpose: it pins the one call whose argument was the entire bug.
   */
  const src = require('fs').readFileSync(require.resolve('../services/loop-lag.js'), 'utf8');
  assert.match(src, /const sustained = sustainedP99\(\);/, 'sample() must compute the sustained value');
  assert.match(src, /band = nextBand\(band, sustained, snap\.p99_ms\)/,
    'the band must be decided on `sustained`, with the raw window only as the spike input');
  assert.ok(!/nextBand\(band, snap\.p99_ms, snap\.p99_ms\)/.test(src), 'the one-window form must not return');
});

test('the sustained value is published, so a snapshot explains its own band', () => {
  // Bold read `p99_ms: 92` beside `band: critical` and concluded the band was wedged. Anyone
  // reading a status page must be able to see the number the band was actually decided on.
  const src = require('fs').readFileSync(require.resolve('../services/loop-lag.js'), 'utf8');
  assert.match(src, /sustained_p99_ms: sustained/);
  assert.ok('sustained_p99_ms' in LL.getLag(), 'and it must be present before the first sample');
});
