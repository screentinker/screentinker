'use strict';

/*
 * The "Curbside" widget (widget type 'curbside'): the cars waiting at a curbside location, one line
 * each, as ORDER NUMBER + SPOT + STATUS ("Order 1234 · Spot 4 · On the way"). Never a name: there is
 * no name anywhere in curbside pickup, and the customer's note stays on the staff side.
 *
 * Built like the "Now serving" widget (lib/queue/widget.js), for the same reasons:
 *
 * ⚠️ IT RUNS ON EVERY PLAYER: ES5 and XMLHttpRequest only, no flex gap, no inset, no clamp(), and every
 * step wrapped so a failure leaves the last good picture on screen. The rows are a <table> sized by
 * script to the zone, which every engine back to Chrome 53 lays out the same.
 *
 * ⚠️ THE PAGE CARRIES NO STATE. A rev-pinned render is cached for a year, so the arrivals and the
 * location's labels (admin-editable, per location) come from /api/widgets/<id>/curbside.json. Every
 * value from it is put on the page with textContent, never as HTML. The only data in the HTML itself
 * is the escaped title and, for an uncached render, the first answer as JSON with <, > and & escaped.
 *
 * FAILS OPEN: a failed poll keeps the last list; after a while a small dot dims in the corner.
 *
 * THE CHIME reuses the "Now serving" path exactly (the same st-queue-chime message to the parent, the
 * same STQueueChime bridge on Android), so the player's mute rules and its 3 s gap apply. It is off
 * unless the widget's own switch is on, and plays once when a car is acknowledged, arrives, or both,
 * as chosen; never for what was already on the list when the page loaded.
 */

const { escapeHtml } = require('../widget-sanitize');
const texts = require('./texts');

const POLL_MS = 4000;
const STALE_MS = 20000;
const MAX_ROWS_CAP = 20;
const DEFAULT_MAX_ROWS = 8;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const colour = (v, d) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : d);
const CHIME_WHEN = new Set(['ack', 'arrive', 'both']);

/** The widget's own settings, cleaned. The labels are the location's (texts.js), not the widget's. */
function widgetConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const vol = Number(c.chime_volume);
  const rows = Number(c.max_rows);
  return {
    location_id: typeof c.location_id === 'string' ? c.location_id.slice(0, 64) : '',
    background: colour(c.background, '#0f172a'),
    color: colour(c.color, '#ffffff'),
    accent: colour(c.accent, '#4ade80'),
    max_rows: Number.isInteger(rows) ? Math.max(1, Math.min(MAX_ROWS_CAP, rows)) : DEFAULT_MAX_ROWS,
    chime: c.chime === true,
    chime_when: CHIME_WHEN.has(c.chime_when) ? c.chime_when : 'ack',
    chime_volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 60,
  };
}

/*
 * One poll's effect, as a pure ES5 function: inlined into the page with toString() and tested
 * directly (test/curbside-widget-logic.test.js).
 *
 *   view  { rows, labels, ackSeq, arriveSeq, rev, lastOk, primed }
 *   resp  the parsed answer, or null when the poll failed in any way
 *
 * Returns the next view plus `acked` / `arrived` (true when that counter moved since the last answer,
 * never on the first answer after load) and `stale`.
 */
function curbsideWidgetStep(view, resp, now, staleMs) {
  var out = { rows: view.rows, labels: view.labels, ackSeq: view.ackSeq, arriveSeq: view.arriveSeq, rev: view.rev,
    lastOk: view.lastOk, primed: view.primed, acked: false, arrived: false, stale: false };
  var ok = resp && typeof resp === 'object' && (resp.unchanged === true || Object.prototype.toString.call(resp.arrivals) === '[object Array]');
  if (!ok) {
    out.stale = !view.lastOk || (now - view.lastOk) > staleMs;
    return out;
  }
  out.lastOk = now;
  if (resp.unchanged === true) return out;
  out.rev = resp.rev;
  var rows = [];
  for (var i = 0; i < resp.arrivals.length; i++) {
    var a = resp.arrivals[i];
    if (!a || typeof a !== 'object') continue;
    rows.push({ order: String(a.order_ref == null ? '' : a.order_ref), spot: String(a.spot == null ? '' : a.spot), seen: a.status === 'seen' });
  }
  out.rows = rows;
  if (resp.labels && typeof resp.labels === 'object') out.labels = resp.labels;
  if (typeof resp.ack_seq === 'number') {
    if (view.primed && view.ackSeq !== null && resp.ack_seq > view.ackSeq) out.acked = true;
    out.ackSeq = resp.ack_seq;
  }
  if (typeof resp.arrive_seq === 'number') {
    if (view.primed && view.arriveSeq !== null && resp.arrive_seq > view.arriveSeq) out.arrived = true;
    out.arriveSeq = resp.arrive_seq;
  }
  out.primed = true;
  return out;
}

const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const SAMPLE = [
  { order: '1234', spot: '4', seen: true },
  { order: '1251', spot: '7', seen: false },
  { order: 'A-88', spot: '2', seen: false },
];

/**
 * The page. `widgetId` is null for the editor's preview, which shows sample rows and polls nothing.
 * `initial` (an uncached render only) is widgetState() of the location.
 */
function renderCurbsideWidget({ widgetId = null, origin = '', config = {}, initial = null } = {}) {
  const c = widgetConfig(config);
  const labels = initial && initial.labels ? initial.labels : texts.widgetTexts({});
  const cfg = {
    stateUrl: widgetId ? `/api/widgets/${encodeURIComponent(widgetId)}/curbside.json` : null,
    origin,
    widgetId,
    chime: c.chime,
    chimeWhen: c.chime_when,
    volume: c.chime_volume / 100,
    maxRows: c.max_rows,
    pollMs: POLL_MS,
    staleMs: STALE_MS,
    preview: !widgetId,
    labels,
    initial: initial && Array.isArray(initial.arrivals) ? initial : null,
  };
  // security-ok(server-html-interp): the colours are hex-checked by widgetConfig (HEX_RE) and the function text is this file's own code; every other value is escapeHtml or jsonForScript
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(labels.widget_heading)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:${c.background};color:${c.color};
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  #w{position:absolute;top:0;left:0;right:0;bottom:0;padding:3vmin 4vmin;box-sizing:border-box;overflow:hidden}
  #head{font-weight:700;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.92;margin-bottom:.35em}
  table{width:100%;border-collapse:collapse}
  td{padding:.18em .3em;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
  /* The order number takes all the room the spot and status do not need (a fixed 38% cut a 17-character
     order to "ORD-20..." with the row half empty). width:100% + max-width:0 lets it ellipsize, still,
     only when it truly does not fit. */
  td.o{width:100%;max-width:0;font-weight:800;font-variant-numeric:tabular-nums}
  td.s{width:1%}
  td.st{width:1%;text-align:right;opacity:.85}
  tr.seen td.st{color:${c.accent};opacity:1;font-weight:700}
  tr.seen td.o{color:${c.accent}}
  tr+tr td{border-top:1px solid rgba(127,127,127,.25)}
  #empty{opacity:.7;text-align:center;padding-top:1em}
  #more{opacity:.7;text-align:right}
  #dot{position:absolute;right:2vmin;bottom:2vmin;width:2vmin;height:2vmin;border-radius:50%;background:${c.color};opacity:0}
  #dot.stale{opacity:.35}
</style></head>
<body><div id="w"><div id="head">${escapeHtml(labels.widget_heading)}</div><table><tbody id="rows"></tbody></table><div id="empty"></div><div id="more"></div></div><div id="dot"></div>
<script>
${curbsideWidgetStep.toString()}
(function () {
  var CFG = ${jsonForScript(cfg)};
  var view = { rows: [], labels: CFG.labels, ackSeq: null, arriveSeq: null, rev: null, lastOk: 0, primed: false };
  var headEl = document.getElementById('head');
  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty');
  var moreEl = document.getElementById('more');
  var dotEl = document.getElementById('dot');
  var drawn = '';
  function lab(k) { var l = view.labels || {}; return typeof l[k] === 'string' ? l[k] : (CFG.labels[k] || ''); }
  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
  function cell(cls, text) { var td = document.createElement('td'); td.className = cls; td.textContent = text; return td; }
  function size() {
    // Font sizes from the zone: the heading and every row fit the height, and a line fits the width.
    var w = window.innerWidth || document.documentElement.clientWidth || 320;
    var h = window.innerHeight || document.documentElement.clientHeight || 180;
    var n = Math.max(3, Math.min(view.rows.length, CFG.maxRows) + (view.rows.length > CFG.maxRows ? 1 : 0));
    var px = Math.floor(Math.min((h * 0.9) / (n * 1.45 + 1.9), w / 21));
    px = Math.max(10, px);
    rowsEl.parentNode.style.fontSize = px + 'px';
    // w / 21 is a guess at a line's length. Measure the real rows: a long order number ("ORD-2026-11-24-99",
    // 17 of the 20 allowed) did not fit at 1920x1080 and was cut to "ORD-20...". Shrink just enough for
    // the widest row, never below 10px; what still does not fit is ellipsized by the stylesheet.
    var table = rowsEl.parentNode, avail = table.clientWidth, trs = rowsEl.getElementsByTagName('tr'), worst = 1;
    for (var r = 0; r < trs.length; r++) {
      var tds = trs[r].getElementsByTagName('td'), need = 0;
      for (var c = 0; c < tds.length; c++) need += tds[c].scrollWidth;
      if (avail > 0 && need > avail) worst = Math.min(worst, avail / need);
    }
    if (worst < 1) { px = Math.max(10, Math.floor(px * worst * 0.97)); table.style.fontSize = px + 'px'; }
    emptyEl.style.fontSize = px + 'px';
    moreEl.style.fontSize = Math.max(9, Math.floor(px * 0.75)) + 'px';
    headEl.style.fontSize = Math.max(10, Math.floor(px * 1.15)) + 'px';
  }
  function paint() {
    try {
      setText(headEl, lab('widget_heading'));
      var key = JSON.stringify([view.rows, view.labels]);
      if (key !== drawn) {
        drawn = key;
        while (rowsEl.firstChild) rowsEl.removeChild(rowsEl.firstChild);
        var shown = Math.min(view.rows.length, CFG.maxRows);
        for (var i = 0; i < shown; i++) {
          var r = view.rows[i];
          var tr = document.createElement('tr');
          if (r.seen) tr.className = 'seen';
          tr.appendChild(cell('o', lab('widget_order') + ' ' + r.order));
          tr.appendChild(cell('s', lab('widget_spot') + ' ' + r.spot));
          tr.appendChild(cell('st', r.seen ? lab('widget_seen') : lab('widget_waiting')));
          rowsEl.appendChild(tr);
        }
        setText(emptyEl, view.rows.length ? '' : lab('widget_empty'));
        setText(moreEl, view.rows.length > shown ? '+' + (view.rows.length - shown) : '');
        size();
      }
      dotEl.className = view.stale ? 'stale' : '';
    } catch (e) { /* keep whatever is on screen */ }
  }
  function chime() {
    // Ask the player; it owns the sound (lib/queue/widget.js explains why). Same message as Now serving.
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'st-queue-chime', volume: CFG.volume, widget_id: CFG.widgetId }, '*'); } catch (e) { /* no player */ }
    try { if (window.parent === window && window.STQueueChime && typeof window.STQueueChime.chime === 'function') window.STQueueChime.chime(String(CFG.volume)); } catch (e) { /* no bridge */ }
  }
  try { window.addEventListener('resize', function () { try { size(); } catch (e) { /* cosmetic */ } }); } catch (e) { /* old engine */ }
  if (CFG.preview) { view.rows = ${jsonForScript(SAMPLE)}; paint(); return; }
  if (CFG.initial) {
    // Primed: a change after this page was drawn may chime, what it was drawn with does not.
    var first = curbsideWidgetStep(view, CFG.initial, new Date().getTime(), CFG.staleMs);
    view = first;
  }
  paint();
  var device = (/[?&]device=([^&#]+)/.exec(location.search || '') || [])[1] || '';
  var base = /^https?:$/.test(location.protocol) ? '' : String(CFG.origin || '');
  var inFlight = false;
  function apply(resp) {
    var next;
    try { next = curbsideWidgetStep(view, resp, new Date().getTime(), CFG.staleMs); } catch (e) { return; }
    view = next;
    paint();
    var want = (CFG.chimeWhen !== 'arrive' && view.acked) || (CFG.chimeWhen !== 'ack' && view.arrived);
    if (want && CFG.chime) chime();
  }
  function poll() {
    if (inFlight) return;
    inFlight = true;
    var xhr;
    try {
      xhr = new XMLHttpRequest();
      var url = base + CFG.stateUrl + '?device=' + device + (view.rev ? '&rev=' + encodeURIComponent(view.rev) : '') + '&t=' + new Date().getTime();
      xhr.open('GET', url, true);
      xhr.timeout = 8000;
    } catch (e) { inFlight = false; apply(null); return; }
    var finished = false;
    function finish(resp) { if (finished) return; finished = true; inFlight = false; apply(resp); }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200) { finish(null); return; }
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      finish(j);
    };
    xhr.onerror = function () { finish(null); };
    xhr.ontimeout = function () { finish(null); };
    try { xhr.send(); } catch (e) { finish(null); }
  }
  poll();
  setInterval(poll, CFG.pollMs);
})();
</script></body></html>`;
}

// Same policy as the Now serving widget: opaque-origin sandbox, inline only, polls this server.
const { renderCsp } = require('../queue/widget');

module.exports = { renderCurbsideWidget, renderCsp, widgetConfig, curbsideWidgetStep, POLL_MS, STALE_MS, MAX_ROWS_CAP };
