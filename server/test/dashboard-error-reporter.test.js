'use strict';

// frontend/js/error-reporter.js — the dashboard's client-error reporter.
//
// The gap it closes: the player has reported JS errors for a long time and the dashboard reported
// nothing, so all 201 rows in prod's player_debug_logs came from /player. A broken dashboard was
// invisible — #292's missing `esc` import left three dialogs dead for weeks behind a green suite.
//
// Driven in a real DOM-ish sandbox rather than asserted against the source text, so the handlers,
// the dedupe and (most importantly) the URL redaction are actually executed.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-dasherr-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'error-reporter.js'), 'utf8');

// Minimal browser surface: enough for the reporter, nothing more.
function sandbox({ reportingMeta = null, href = 'https://screentinker.com/app' } = {}) {
  const posts = [];
  const listeners = {};
  const timers = [];
  const url = new URL(href);
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    location: { origin: url.origin, pathname: url.pathname, hash: url.hash, href },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0' },
    screen: { width: 1920, height: 1080 },
    document: {
      querySelector: (sel) => (sel.includes('st-error-reporting') && reportingMeta !== null
        ? { getAttribute: () => reportingMeta } : null),
    },
    fetch: (endpoint, opts) => { posts.push({ endpoint, body: JSON.parse(opts.body), opts }); return Promise.resolve({ status: 204 }); },
    // A real timer is ASYNCHRONOUS, and that matters here: the reporter uses a truthy timer id as
    // its "a flush is already scheduled" flag and clears it inside flush(). A fake that runs the
    // callback synchronously re-assigns that id AFTER flush has cleared it, so the flag stays set
    // forever and every later error queues silently. Queue the callbacks and drain them instead.
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
    Date, JSON, String, Number, Object, Array, URL, console,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  const drain = () => { while (timers.length) timers.shift()(); };
  return {
    win, posts,
    // Dispatch the event, then let the debounce fire — the order a browser would.
    fire: (t, ev) => { (listeners[t] || []).forEach(fn => fn(ev)); drain(); },
  };
}

test('an uncaught error is captured and posted to the player-debug sink', () => {
  const s = sandbox();
  const err = new Error('esc is not defined');
  err.stack = 'ReferenceError: esc is not defined\n    at openDialog (app.js:120:5)';
  s.fire('error', { error: err, message: err.message, filename: 'https://x/app.js?v=2' });
  assert.equal(s.posts.length, 1, 'one report was sent');
  assert.equal(s.posts[0].endpoint, '/api/player-debug', 'reuses the existing sink');
  const b = s.posts[0].body;
  assert.equal(b.errors[0].message, 'esc is not defined');
  assert.match(b.errors[0].stack, /openDialog/);
  assert.equal(b.context.app, 'dashboard', 'distinguishable from player rows');
  assert.equal(b.deviceId, undefined, 'a dashboard session is not a screen');
});

test('an unhandled promise rejection is captured', () => {
  const s = sandbox();
  const r = new Error('boom');
  r.stack = 'Error: boom\n    at save (billing.js:9:1)';
  s.fire('unhandledrejection', { reason: r });
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].body.errors[0].kind, 'unhandledrejection');
});

test('⚠️ SECRETS ARE STRIPPED: the query string never leaves the browser', () => {
  // This endpoint is unauthenticated and its rows are readable by a platform admin. ?k= is a
  // single-use enrol key and ?reset= is a password-reset token; both live on this origin.
  const s = sandbox({ href: 'https://screentinker.com/app?reset=SECRET-TOKEN#/billing?k=ENROL-KEY' });
  s.fire('error', { error: new Error('x'), message: 'x' });
  const url = s.posts[0].body.url;
  assert.ok(!/SECRET-TOKEN/.test(url), 'reset token must not be reported');
  assert.ok(!/ENROL-KEY/.test(url), 'hash query params must not be reported either');
  assert.equal(url, 'https://screentinker.com/app#/billing', 'route is kept — that is what identifies the fault');
});

test('the same fault is reported once, not on every repeat', () => {
  const s = sandbox();
  const mk = () => { const e = new Error('same'); e.stack = 'Error: same\n    at f (a.js:1:1)'; return e; };
  for (let i = 0; i < 5; i++) s.fire('error', { error: mk(), message: 'same' });
  assert.equal(s.posts.length, 1, 'a render loop cannot flood the endpoint');
});

test('distinct faults are reported separately', () => {
  const s = sandbox();
  const a = new Error('one'); a.stack = 'Error: one\n    at f (a.js:1:1)';
  const b = new Error('two'); b.stack = 'Error: two\n    at g (b.js:2:2)';
  s.fire('error', { error: a, message: 'one' });
  s.fire('error', { error: b, message: 'two' });
  assert.equal(s.posts.length, 2);
});

test('a failed image/script load is NOT reported as an exception', () => {
  const s = sandbox();
  s.fire('error', { target: { tagName: 'IMG' }, message: 'load failed' });
  assert.deepEqual(s.posts, [], 'asset load failures would drown the real errors');
});

test('the kill switch turns it off entirely', () => {
  const s = sandbox({ reportingMeta: 'off' });
  assert.equal(s.win.__stErrorReporter.isEnabled(), false);
  s.fire('error', { error: new Error('x'), message: 'x' });
  assert.deepEqual(s.posts, [], 'PLAYER_DEBUG_REPORTING=off silences the dashboard too');
});

test('an absent meta means ON, matching the player default', () => {
  const s = sandbox({ reportingMeta: null });
  assert.equal(s.win.__stErrorReporter.isEnabled(), true);
});

test('the shell loads it BEFORE the app module, or early boot errors are missed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const reporter = html.indexOf('/js/error-reporter.js');
  const app = html.indexOf('/js/app.js');
  assert.ok(reporter > 0, 'the reporter is loaded by the shell');
  assert.ok(reporter < app, 'it must come before js/app.js');
  assert.ok(!/type="module"[^>]*error-reporter/.test(html), 'a module would be deferred past boot');
});

test('the /app route injects the kill-switch meta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /meta name="st-error-reporting"/, 'the flag reaches the page');
  assert.match(src, /PLAYER_DEBUG_REPORTING[\s\S]{0,200}st-error-reporting/,
    'and it is driven by the same env var as the player');
});
