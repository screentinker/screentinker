'use strict';

/*
 * The Curbside widget's per-poll logic (lib/curbside/widget.js curbsideWidgetStep) and its inlined
 * page script, run in a VM with a tiny fake DOM. The same function text is inlined into the page, so
 * testing it here tests what every player runs. Pure: no server.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { curbsideWidgetStep, widgetConfig, renderCurbsideWidget, STALE_MS } = require('../lib/curbside/widget');
const texts = require('../lib/curbside/texts');

const fresh = () => ({ rows: [], labels: texts.widgetTexts({}), ackSeq: null, arriveSeq: null, rev: null, lastOk: 0, primed: false });
const ans = (arrivals, ack, arrive, extra = {}) => ({ rev: `${ack}.${arrive}`, name: 'Lot', ack_seq: ack, arrive_seq: arrive, labels: texts.widgetTexts({}), arrivals, ...extra });
const car = (order, spot, status = 'waiting') => ({ order_ref: order, spot, status });

test('the widget keeps the last list when the server is unreachable, and only dims a dot', () => {
  let v = curbsideWidgetStep(fresh(), ans([car('1', '4')], 0, 1), 1000, STALE_MS);
  assert.deepEqual(v.rows, [{ order: '1', spot: '4', seen: false }]);
  for (const bad of [null, undefined, 'oops', {}, { error: 'x' }, { arrivals: 'x' }]) {
    v = curbsideWidgetStep(v, bad, 2000, STALE_MS);
    assert.equal(v.rows.length, 1, `kept through ${JSON.stringify(bad)}`);
    assert.equal(v.acked || v.arrived, false);
  }
  assert.equal(v.stale, false);
  v = curbsideWidgetStep(v, null, 1000 + STALE_MS + 1, STALE_MS);
  assert.equal(v.stale, true);
  assert.equal(v.rows.length, 1);
  v = curbsideWidgetStep(v, { rev: '0.1', unchanged: true }, 1000 + STALE_MS + 2, STALE_MS);
  assert.equal(v.stale, false);
});

test('an acknowledgement and an arrival are each announced once, never on the first answer', () => {
  let v = curbsideWidgetStep(fresh(), ans([car('1', '4')], 3, 5), 0, STALE_MS);
  assert.equal(v.acked, false, 'a screen that reboots must not re-announce');
  assert.equal(v.arrived, false);
  v = curbsideWidgetStep(v, ans([car('1', '4'), car('2', '5')], 3, 6), 1, STALE_MS);
  assert.equal(v.arrived, true);
  assert.equal(v.acked, false);
  v = curbsideWidgetStep(v, ans([car('1', '4', 'seen'), car('2', '5')], 4, 6), 2, STALE_MS);
  assert.equal(v.acked, true);
  assert.equal(v.arrived, false);
  assert.equal(v.rows[0].seen, true);
  for (let i = 0; i < 10; i++) {
    v = curbsideWidgetStep(v, i % 2 ? ans([car('1', '4', 'seen'), car('2', '5')], 4, 6) : { rev: '4.6', unchanged: true }, 3 + i, STALE_MS);
    assert.equal(v.acked || v.arrived, false, 'never repeated');
  }
});

test('widget config: hex colours only, rows 1..20, chime off by default', () => {
  const c = widgetConfig({ background: 'red', color: '#fff', max_rows: 99, chime_when: 'bogus', chime_volume: 400 });
  assert.equal(c.background, '#0f172a');
  assert.equal(c.color, '#fff');
  assert.equal(c.max_rows, 20);
  assert.equal(c.chime, false);
  assert.equal(c.chime_when, 'ack');
  assert.equal(c.chime_volume, 100);
  assert.equal(widgetConfig({ max_rows: 0 }).max_rows, 1);
});

test('the inlined script is ES5 and parses on its own', () => {
  const html = renderCurbsideWidget({ widgetId: 'w1', origin: 'http://x', config: {} });
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotMatch(js.replace(/"labels":\{[^}]*\}/g, ''), /\b(const|let|class)\b|=>|`/);
  assert.doesNotThrow(() => new vm.Script(js));
});

/* A fake DOM just big enough for the page script. */
function fakeDom() {
  const byId = {};
  const node = (tag) => ({
    tag, textContent: '', className: '', style: {}, children: [], parentNode: null,
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
  });
  const doc = {
    getElementById: (id) => {
      if (!byId[id]) { byId[id] = node('div'); if (id === 'rows') byId[id].parentNode = node('table'); }
      return byId[id];
    },
    createElement: node,
    documentElement: { clientWidth: 640, clientHeight: 360 },
  };
  return { doc, byId };
}

function runWidget({ topLevel, bridge, initial, config }) {
  const html = renderCurbsideWidget({ widgetId: 'w1', origin: 'http://x', config: { location_id: 'l', ...config }, initial });
  const js = html.split('<script>')[1].split('</script>')[0];
  const xhrs = [];
  function XHR() { xhrs.push(this); }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const { doc, byId } = fakeDom();
  const posted = [];
  let tick = null;
  const win = { STQueueChime: bridge, innerWidth: 640, innerHeight: 360, addEventListener: () => {} };
  win.parent = topLevel ? win : { postMessage: (m) => posted.push(m) };
  Object.assign(win, {
    document: doc, location: { search: '?device=d1', protocol: 'http:' },
    XMLHttpRequest: XHR, setInterval: (fn) => { tick = fn; return 0; }, JSON, Date, String, Number, Math, Object, encodeURIComponent,
  });
  win.window = win;
  vm.runInNewContext(js, win);
  // Each answer goes to a fresh poll, as the interval would make one.
  const answer = (resp) => {
    if (xhrs[xhrs.length - 1].answered) tick();
    const x = xhrs[xhrs.length - 1];
    x.answered = true; x.readyState = 4; x.status = 200; x.responseText = JSON.stringify(resp); x.onreadystatechange();
  };
  const rowText = () => byId.rows.children.map((tr) => tr.children.map((td) => td.textContent).join(' | '));
  return { answer, xhrs, posted, byId, rowText };
}

test('the page shows ORDER + SPOT + status lines with the location labels, and the empty text', () => {
  const labels = { ...texts.widgetTexts({}), widget_seen: 'En camino', widget_empty: 'Nadie esperando' };
  const w = runWidget({ topLevel: false, initial: ans([], 0, 0, { labels }) });
  assert.equal(w.byId.empty.textContent, 'Nadie esperando');
  w.answer(ans([car('1234', '4', 'seen'), car('88', 'B2')], 1, 2, { labels }));
  assert.deepEqual(w.rowText(), ['Order 1234 | Spot 4 | En camino', 'Order 88 | Spot B2 | Waiting']);
  assert.equal(w.byId.empty.textContent, '');
  assert.match(w.byId.rows.parentNode.style.fontSize, /^\d+px$/, 'sized to the zone');
});

test('more cars than fit: the first N and a +more count', () => {
  const many = Array.from({ length: 5 }, (_, i) => car(String(100 + i), String(i + 1)));
  const w = runWidget({ topLevel: false, config: { max_rows: 3 } });
  w.answer(ans(many, 0, 5));
  assert.equal(w.rowText().length, 3);
  assert.equal(w.byId.more.textContent, '+2');
});

test('the chime: off by default; on, it asks the player once per acknowledgement (iframe) or calls the Android bridge (top level)', () => {
  const base = ans([car('1', '4')], 0, 1);
  const off = runWidget({ topLevel: false, initial: base });
  off.answer(ans([car('1', '4', 'seen')], 1, 1));
  assert.equal(off.posted.length, 0, 'the widget switch is off by default');

  const w = runWidget({ topLevel: false, initial: base, config: { chime: true, chime_volume: 40 } });
  w.answer(ans([car('1', '4'), car('2', '5')], 0, 2));
  assert.equal(w.posted.length, 0, 'an arrival does not chime when set to acknowledgements');
  w.answer(ans([car('1', '4', 'seen'), car('2', '5')], 1, 2));
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].type, 'st-queue-chime');
  assert.equal(w.posted[0].volume, 0.4);

  const both = runWidget({ topLevel: false, initial: base, config: { chime: true, chime_when: 'both' } });
  both.answer(ans([car('1', '4'), car('2', '5')], 0, 2));
  assert.equal(both.posted.length, 1, 'arrival chimes with "both"');

  const calls = [];
  const a = runWidget({ topLevel: true, bridge: { chime: (v) => calls.push(v) }, initial: base, config: { chime: true, chime_when: 'arrive', chime_volume: 50 } });
  a.answer(ans([car('1', '4'), car('2', '5')], 0, 2));
  assert.deepEqual(calls, ['0.5']);
  assert.equal(a.posted.length, 0);
});

test('a hostile order number or label is only ever text in the page', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const w = runWidget({ topLevel: false });
  w.answer(ans([car(evil, evil)], 0, 1, { labels: { ...texts.widgetTexts({}), widget_order: evil } }));
  assert.equal(w.rowText()[0], `${evil} ${evil} | Spot ${evil} | Waiting`, 'set as textContent, verbatim');
});
