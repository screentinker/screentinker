'use strict';

/*
 * The "Now serving" widget's per-poll logic (lib/queue/widget.js queueWidgetStep). The same function
 * text is inlined into the page, so testing it here tests what every player runs. Pure: no server.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { queueWidgetStep, widgetConfig, renderQueueWidget, STALE_MS } = require('../lib/queue/widget');

const fresh = () => ({ number: 0, callSeq: null, rev: null, lastOk: 0, primed: false, sound: false });
const ans = (n, seq, extra = {}) => ({ rev: `1.${seq}`, now_serving: n, call_seq: seq, sound: true, ...extra });

test('the widget keeps the last number when the server is unreachable', () => {
  let v = queueWidgetStep(fresh(), ans(12, 3), 1000, STALE_MS);
  assert.equal(v.number, 12);
  for (const bad of [null, undefined, 'oops', {}, { error: 'x' }, { now_serving: 'NaN' }]) {
    v = queueWidgetStep(v, bad, 2000, STALE_MS);
    assert.equal(v.number, 12, `kept through ${JSON.stringify(bad)}`);
    assert.equal(v.chime, false);
  }
  assert.equal(v.stale, false, 'a short blip is not stale');
  v = queueWidgetStep(v, null, 1000 + STALE_MS + 1, STALE_MS);
  assert.equal(v.number, 12, 'still the last number after a long outage');
  assert.equal(v.stale, true, 'only the subtle stale flag changes');
  v = queueWidgetStep(v, { rev: '1.3', unchanged: true }, 1000 + STALE_MS + 2, STALE_MS);
  assert.equal(v.stale, false, 'recovers on the next good answer');
  assert.equal(v.number, 12);
});

test('a called number is announced once, never looped', () => {
  let v = queueWidgetStep(fresh(), ans(4, 10), 0, STALE_MS);
  assert.equal(v.chime, false, 'the first answer after load never chimes (a reboot must not re-announce)');
  v = queueWidgetStep(v, ans(5, 11), 1, STALE_MS);
  assert.equal(v.chime, true, 'Next chimes');
  let chimes = 0;
  for (let i = 0; i < 50; i++) {
    v = queueWidgetStep(v, i % 2 ? ans(5, 11) : { rev: '1.11', unchanged: true }, 2 + i, STALE_MS);
    if (v.chime) chimes++;
  }
  assert.equal(chimes, 0, 'the same call never chimes again, however many polls');
  v = queueWidgetStep(v, ans(5, 12), 100, STALE_MS);
  assert.equal(v.chime, true, 'calling the same number again (a recall) is a new call');
  v = queueWidgetStep(v, ans(0, 12), 101, STALE_MS);
  assert.equal(v.chime, false, 'start of day is not a call');
  v = queueWidgetStep(v, ans(1, 13, { sound: false }), 102, STALE_MS);
  assert.equal(v.chime, false, 'the staff sound switch off: silent');
  assert.equal(v.number, 1);
});

test('the chime is off unless the widget switches it on, and its volume is clamped', () => {
  assert.equal(widgetConfig({}).chime, false);
  assert.equal(widgetConfig({ chime: 'yes' }).chime, false);
  assert.equal(widgetConfig({ chime: true }).chime, true);
  assert.equal(widgetConfig({}).chime_volume, 60);
  assert.equal(widgetConfig({ chime_volume: 250 }).chime_volume, 100);
  assert.equal(widgetConfig({ chime_volume: -4 }).chime_volume, 0);
  // Without the widget's own switch the page never asks for a sound, whatever the queue says.
  const html = renderQueueWidget({ widgetId: 'w1', origin: 'http://x', config: { chime: false } });
  assert.match(html, /"chime":false/);
  assert.match(html, /if \(view\.chime && CFG\.chime\) chime\(\);/);
});

test('user-provided words and colours cannot break out of the page', () => {
  const html = renderQueueWidget({ widgetId: 'w1', origin: 'http://x', config: { label: '</style><script>alert(1)</script>', background: 'red;}</style><script>', accent: 'url(javascript:1)' } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /background:#0f172a/);
  assert.match(html, /&lt;\/style&gt;/);
});

test('the inlined script is ES5 and parses on its own', () => {
  const html = renderQueueWidget({ widgetId: 'w1', origin: 'http://x', config: {} });
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotMatch(js, /\b(const|let|class)\b|=>|`/);
  assert.doesNotThrow(() => new vm.Script(js));
});

/*
 * Android mounts the widget as the WebView's top-level page, so there is no parent to postMessage:
 * the page calls the STQueueChime bridge instead (android QueueChime.kt). In an iframe (the web
 * player) it posts to the parent and never touches a bridge.
 */
function runWidget({ topLevel, bridge }) {
  const html = renderQueueWidget({ widgetId: 'w1', origin: 'http://x', config: { queue_id: 'q', chime: true, chime_volume: 40 },
    initial: { now_serving: 3, call_seq: 5, rev: '1.9', sound: true } });
  const js = html.split('<script>')[1].split('</script>')[0];
  const xhrs = [];
  function XHR() { xhrs.push(this); }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const el = () => ({ textContent: '', className: '', offsetWidth: 0 });
  const els = {};
  const posted = [];
  const win = { STQueueChime: bridge };
  const parent = topLevel ? win : { postMessage: (m) => posted.push(m) };
  win.parent = parent;
  Object.assign(win, {
    document: { getElementById: (id) => (els[id] = els[id] || el()) },
    location: { search: '?device=d1', protocol: 'http:' },
    XMLHttpRequest: XHR, setInterval: () => 0, JSON, Date, String, Number, Math, encodeURIComponent,
  });
  win.window = win;
  vm.runInNewContext(js, win);
  const answer = (resp) => { const x = xhrs[xhrs.length - 1]; x.readyState = 4; x.status = 200; x.responseText = JSON.stringify(resp); x.onreadystatechange(); };
  return { answer, xhrs, posted, els };
}

test('on Android (top-level page) a called number reaches the STQueueChime bridge once', () => {
  const calls = [];
  const w = runWidget({ topLevel: true, bridge: { chime: (v) => calls.push(v) } });
  w.answer({ rev: '1.10', now_serving: 4, call_seq: 6, sound: true, waiting: 1 });
  assert.equal(w.els.num.textContent, '4');
  assert.deepEqual(calls, ['0.4'], 'one chime, with the widget volume as a string');
  assert.equal(w.posted.length, 0);
});

test('on Android the bridge is not called for the number the page was drawn with, or with sound off', () => {
  const calls = [];
  const w = runWidget({ topLevel: true, bridge: { chime: (v) => calls.push(v) } });
  w.answer({ rev: '1.9', now_serving: 3, call_seq: 5, sound: true, waiting: 0 });
  assert.equal(calls.length, 0, 'same call as drawn');
  const w2 = runWidget({ topLevel: true, bridge: { chime: (v) => calls.push(v) } });
  w2.answer({ rev: '1.10', now_serving: 4, call_seq: 6, sound: false, waiting: 0 });
  assert.equal(calls.length, 0, 'staff switch off');
});

test('in an iframe (web player) the page posts to its parent and never calls a bridge', () => {
  const calls = [];
  const w = runWidget({ topLevel: false, bridge: { chime: (v) => calls.push(v) } });
  w.answer({ rev: '1.10', now_serving: 4, call_seq: 6, sound: true, waiting: 0 });
  assert.equal(calls.length, 0);
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].type, 'st-queue-chime');
});

test('a top-level page with no bridge (any other player) stays silent and does not throw', () => {
  const w = runWidget({ topLevel: true, bridge: undefined });
  assert.doesNotThrow(() => w.answer({ rev: '1.10', now_serving: 4, call_seq: 6, sound: true, waiting: 0 }));
  assert.equal(w.els.num.textContent, '4');
});
