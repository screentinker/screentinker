'use strict';

// #466 — a slow boot must not turn a present ffmpeg into "not found" for the life of the process.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mt = require('../lib/media-tools');

// A fake execFile: answers per binary with 'ok' | 'missing' | 'timeout' | 'error', counting calls.
function fakeExec(answers) {
  const calls = [];
  const fn = (bin, args, opts, cb) => {
    calls.push({ bin, timeout: opts.timeout });
    const a = typeof answers[bin] === 'function' ? answers[bin]() : answers[bin];
    if (a === 'ok') return cb(null);
    if (a === 'missing') return cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    if (a === 'timeout') return cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
    return cb(Object.assign(new Error('exit 1'), { code: 1 }));
  };
  fn.calls = calls;
  return fn;
}
const quietLog = () => { const lines = []; const push = (k) => (m) => lines.push(`${k} ${m}`); return { lines, log: push('log'), warn: push('warn'), error: push('error') }; };

afterEach(() => mt._setExecForTest(null));

test('a missing binary (ENOENT) is "missing", definite, and cached', async () => {
  const exec = fakeExec({ ffmpeg: 'missing', ffprobe: 'ok' });
  mt._setExecForTest(exec);
  const s = await mt.mediaToolStatus();
  assert.deepEqual([s.ffmpeg, s.ffprobe, s.conclusive, s.detail.ffmpeg], [false, true, true, 'missing']);
  await mt.mediaToolStatus();
  assert.equal(exec.calls.length, 2, 'definite answers are cached — no second probe');
});

test('a TIMEOUT is inconclusive and NOT cached: the next caller probes again and can succeed', async () => {
  let slow = true;
  const exec = fakeExec({ ffmpeg: () => (slow ? 'timeout' : 'ok'), ffprobe: 'ok' });
  mt._setExecForTest(exec);
  const first = await mt.mediaToolStatus();
  assert.equal(first.conclusive, false);
  assert.equal(first.detail.ffmpeg, 'timeout');
  assert.equal(first.ffmpeg, false);
  slow = false;
  const second = await mt.mediaToolStatus();
  assert.deepEqual([second.ffmpeg, second.ffprobe, second.conclusive], [true, true, true]);
  assert.equal(exec.calls.length, 4, 'the timed-out pair was probed again');
});

test('the probe allows 15 s, not 5', async () => {
  const exec = fakeExec({ ffmpeg: 'ok', ffprobe: 'ok' });
  mt._setExecForTest(exec);
  await mt.mediaToolStatus();
  assert.ok(exec.calls.every((c) => c.timeout === 15000));
});

test('startupCheck: a timeout is logged as a timeout (not "not found"), re-checked, and recovery re-runs the backfill', async () => {
  let slow = true;
  mt._setExecForTest(fakeExec({ ffmpeg: () => (slow ? 'timeout' : 'ok'), ffprobe: 'ok' }));
  const scheduled = [];
  const schedule = (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; };
  let recovered = 0;
  const L = quietLog();
  await mt.startupCheck({ onRecovered: () => recovered++, schedule, log: L });
  assert.ok(L.lines.some((l) => /did not answer within 15s/.test(l)), L.lines.join('\n'));
  assert.ok(!L.lines.some((l) => /not found on PATH/.test(l)), 'BUG: a timeout was reported as "not found"');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 30000);
  assert.equal(recovered, 0);
  slow = false;
  scheduled[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(recovered, 1, 'a re-check that finds the tools re-runs the thumbnail backfill');
  assert.ok(L.lines.some((l) => /answered on re-check 1/.test(l)));
});

test('startupCheck: a genuinely missing ffmpeg is reported once and never re-checked', async () => {
  mt._setExecForTest(fakeExec({ ffmpeg: 'missing', ffprobe: 'missing' }));
  const scheduled = [];
  const L = quietLog();
  await mt.startupCheck({ schedule: (fn, ms) => { scheduled.push(ms); return {}; }, log: L });
  assert.ok(L.lines.some((l) => /ffmpeg, ffprobe not found on PATH/.test(l)));
  assert.equal(scheduled.length, 0);
});

test('startupCheck: installed-but-broken is named as such', async () => {
  mt._setExecForTest(fakeExec({ ffmpeg: 'error', ffprobe: 'ok' }));
  const L = quietLog();
  await mt.startupCheck({ schedule: () => ({}), log: L });
  assert.ok(L.lines.some((l) => /ffmpeg is on PATH but failed to run/.test(l)), L.lines.join('\n'));
});
