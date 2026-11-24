'use strict';

/*
 * The Tizen player's live debug log (set_debug). Tizen never implemented the command: it fell through
 * to STDeviceControl, was answered "unknown command", and the dashboard's live panel stayed empty.
 * tizen/js/debug-log.js now keeps a ring buffer from boot and streams it, the same way the web player
 * does. These drive the real module with a fake page and fake timers.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TIZEN = path.join(__dirname, '..', '..', 'tizen');
const D = require(path.join(TIZEN, 'js', 'debug-log.js'));

function fakePage() {
  const handlers = {};
  const seen = [];
  return {
    seen,
    handlers,
    location: { href: 'file:///index.html' },
    screen: { width: 1920, height: 1080 },
    navigator: { userAgent: 'Tizen 4.0' },
    console: { log: (...a) => seen.push(a), warn: (...a) => seen.push(a), error: (...a) => seen.push(a) },
    addEventListener: (name, fn) => { handlers[name] = fn; },
  };
}

function rig(extra = {}) {
  const sent = [];
  let t = Date.now();   // push() stamps lines with the real clock
  const timers = [];
  const stream = D.createStream({
    send: (tag, level, message) => sent.push({ tag, level, message }),
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    platform: () => 'Tizen - screen 1920x1080',
    ...extra,
  });
  return { stream, sent, timers, advance: (ms) => { t += ms; } };
}

beforeEach(() => D._reset());

test('install records console lines, errors and rejections from boot, and keeps console working', () => {
  const win = fakePage();
  D.install(win);
  win.console.log('[sync] hello', { a: 1 });
  win.console.warn('careful');
  win.handlers.error({ message: 'boom', filename: 'js/app.js', lineno: 12, colno: 3, error: { stack: 'Error: boom\n  at x' } });
  win.handlers.unhandledrejection({ reason: new Error('nope') });
  const types = D.buffer().map((e) => e.type);
  assert.deepEqual(types, ['init', 'console.log', 'console.warn', 'error', 'rejection']);
  assert.equal(D.buffer()[1].message, '[sync] hello {"a":1}');
  assert.match(D.buffer()[3].message, /boom @js\/app\.js:12:3 \| Error: boom at x/);
  assert.equal(win.seen.length, 2, 'the real console still got both calls');
});

test('the buffer keeps only the last 200 lines', () => {
  for (let i = 0; i < 250; i++) D.push({ type: 'console.log', message: 'line ' + i });
  assert.equal(D.buffer().length, D.MAX_LOG);
  assert.equal(D.buffer()[0].message, 'line 50');
});

test('turning it on sends the platform line, replays the backlog with its age, then streams live', () => {
  D.push({ type: 'console.error', message: '[bundle] failed to unpack' });
  const r = rig();
  r.advance(4500);
  r.stream.set(true);
  assert.match(r.sent[0].message, /^Remote debug logging ON - Tizen - screen 1920x1080$/);
  assert.match(r.sent[1].message, /replaying 1 buffered line/);
  assert.deepEqual(r.sent[2], { tag: 'bundle', level: 'e', message: '(-4.5s) failed to unpack' });
  assert.match(r.sent[3].message, /end of backlog, now live/);
  D.push({ type: 'console.warn', message: 'no tag here' });
  assert.deepEqual(r.sent[4], { tag: 'player', level: 'w', message: 'no tag here' });
  // A second "on" while on (the dashboard re-sends on reconnect) does not replay again.
  r.stream.set(true);
  assert.equal(r.sent.length, 5);
});

test('nothing is sent while off, and the backlog replays only once', () => {
  const r = rig();
  D.push({ type: 'console.log', message: 'before' });
  assert.equal(r.sent.length, 0);
  r.stream.set(true);
  r.stream.set(false);
  assert.equal(r.sent.at(-1).message, 'Remote debug logging OFF');
  const n = r.sent.length;
  D.push({ type: 'console.log', message: 'while off' });
  assert.equal(r.sent.length, n, 'off means off');
  r.stream.set(true);
  const replay = r.sent.slice(n).find((l) => /replaying/.test(l.message));
  assert.match(replay.message, /replaying 1 buffered/, 'only the line logged while off is replayed');
});

test('live lines are capped at 40 a second and the drop is counted', () => {
  const r = rig();
  r.stream.set(true);
  const start = r.sent.length;
  for (let i = 0; i < 100; i++) D.push({ type: 'console.log', message: 'spam ' + i });
  assert.equal(r.sent.length - start, D.MAX_LINES_PER_SEC);
  r.advance(1000);
  D.push({ type: 'console.log', message: 'after' });
  const tail = r.sent.slice(-2);
  assert.deepEqual(tail[0], { tag: 'debug', level: 'w', message: '60 line(s) suppressed (rate limit)' });
  assert.equal(tail[1].message, 'after');
});

test('the stream turns itself off after 30 minutes', () => {
  const r = rig();
  r.stream.set(true);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, D.AUTO_OFF_MS);
  r.timers[0].fn();
  assert.equal(r.stream.isOn(), false);
  assert.match(r.sent.at(-1).message, /auto-disabled after 30 min/);
  // Turning it off by hand cancels the timer.
  r.stream.set(true);
  r.stream.set(false);
  assert.equal(r.timers.length, 1, 'only the fired one was ever left');
});

test('a send that throws never breaks the player', () => {
  const r = rig({ send: () => { throw new Error('socket gone'); } });
  assert.doesNotThrow(() => { r.stream.set(true); D.push({ type: 'console.log', message: 'x' }); });
});

test('the Tizen page loads debug-log.js before any other script', () => {
  const html = fs.readFileSync(path.join(TIZEN, 'index.html'), 'utf8');
  const first = /<script\s+src="([^"]+)"/.exec(html);
  assert.equal(first[1], 'js/debug-log.js');
});

test('app.js answers set_debug itself instead of passing it to STDeviceControl', () => {
  const src = fs.readFileSync(path.join(TIZEN, 'js', 'app.js'), 'utf8');
  const route = src.indexOf("if (type === 'set_debug')");
  const control = src.indexOf('STDeviceControl.run(type, payload)');
  assert.ok(route > 0 && control > 0 && route < control, 'set_debug is routed before the device-control fallthrough');
  assert.match(src, /STDebugLog\.createStream\(/);
});
