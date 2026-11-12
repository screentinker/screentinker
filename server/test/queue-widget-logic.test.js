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
