'use strict';

/*
 * The "Now serving" widget (widget type 'queue'): one big number in whatever zone it is placed in.
 *
 * ⚠️ IT RUNS ON EVERY PLAYER, so its script is ES5 and XMLHttpRequest only (Tizen, webOS,
 * BrightSign and Chrome 53-era engines all render widgets), and every step is wrapped so that a
 * failure leaves the last good picture on screen.
 *
 * ⚠️ THE PAGE CARRIES NO STATE. A player caches a rev-pinned render for a year (routes/widgets.js),
 * so the number is never baked in: the page polls /api/widgets/<id>/queue.json, which answers with
 * just the number, a revision and the sound switch. The widget id is all it needs (exactly like a
 * room display's state); it never sees a staff or customer token.
 *
 * FAILS OPEN: an unreachable server, a 404, a 500 or a garbled answer keeps the last number shown.
 * After a while without an answer a small dot in the corner dims; nothing else changes. Before the
 * first answer it shows a dash, never an error.
 *
 * ⚠️ THE CHIME IS NOT PLAYED HERE. A widget that makes its own noise from inside its iframe sits
 * outside the player's mute decision (lib/media-mute.js: wall followers, the operator's remote mute,
 * the per-item flag, the autoplay gesture), which is why slides carry their audio as metadata and the
 * player owns the elements (lib/slide-render.js). So the page only ASKS: once per called number it
 * posts {type:'st-queue-chime'} to its parent, and a player that knows the message (the web player)
 * decides whether a sound may play and plays one short, non-looping chime. Anywhere else the message
 * is ignored and the widget is silent, which is the safe failure.
 */

const { escapeHtml } = require('../widget-sanitize');

const POLL_MS = 4000;
const STALE_MS = 20000;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const colour = (v, d) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : d);

/** The widget's own settings, cleaned. Volume is 0..100; the chime is off unless switched on. */
function widgetConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const vol = Number(c.chime_volume);
  return {
    queue_id: typeof c.queue_id === 'string' ? c.queue_id.slice(0, 64) : '',
    label: typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 60) : 'Now serving',
    background: colour(c.background, '#0f172a'),
    color: colour(c.color, '#ffffff'),
    accent: colour(c.accent, '#facc15'),
    chime: c.chime === true,
    chime_volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 60,
  };
}

/*
 * One poll's effect on what the widget shows, as a pure ES5 function: it is inlined into the page
 * with toString() and tested directly (test/queue-widget-logic.test.js).
 *
 *   view  { number, callSeq, rev, lastOk, primed, sound }
 *   resp  the parsed answer, or null when the poll failed in any way
 *   now   ms
 *
 * Returns the next view plus `chime` (true at most once per called number, and never for the first
 * answer after the page loads: a screen that reboots must not announce a number called an hour ago)
 * and `stale` (no good answer for a while).
 */
function queueWidgetStep(view, resp, now, staleMs) {
  var out = { number: view.number, callSeq: view.callSeq, rev: view.rev, lastOk: view.lastOk,
    primed: view.primed, sound: view.sound, chime: false, stale: false };
  var ok = resp && typeof resp === 'object' && (resp.unchanged === true || typeof resp.now_serving === 'number');
  if (!ok) {
    out.stale = !view.lastOk || (now - view.lastOk) > staleMs;
    return out;
  }
  out.lastOk = now;
  if (resp.unchanged === true) return out;
  out.rev = resp.rev;
  out.number = resp.now_serving > 0 ? Math.floor(resp.now_serving) : 0;
  out.sound = resp.sound === true;
  if (typeof resp.call_seq === 'number') {
    if (view.primed && resp.call_seq !== view.callSeq && out.number > 0 && out.sound) out.chime = true;
    out.callSeq = resp.call_seq;
  }
  out.primed = true;
  return out;
}

const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * The page. `widgetId` is null for the editor's preview, which shows a sample number and polls nothing.
 */
function renderQueueWidget({ widgetId = null, origin = '', config = {}, initial = null } = {}) {
  const c = widgetConfig(config);
  const cfg = {
    stateUrl: widgetId ? `/api/widgets/${encodeURIComponent(widgetId)}/queue.json` : null,
    origin,
    widgetId,
    chime: c.chime,
    volume: c.chime_volume / 100,
    pollMs: POLL_MS,
    staleMs: STALE_MS,
    preview: !widgetId,
    // Only for a render nobody caches (no ?rev=): a raster snapshot or a direct open shows the
    // number on its first paint instead of a dash until the first poll.
    initial: initial && typeof initial.now_serving === 'number'
      ? { number: initial.now_serving, callSeq: initial.call_seq, rev: initial.rev, sound: initial.sound === true } : null,
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.label)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:${c.background};color:${c.color};
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  #w{position:absolute;top:0;left:0;right:0;bottom:0;display:-webkit-box;display:-webkit-flex;display:flex;
    -webkit-box-orient:vertical;-webkit-flex-direction:column;flex-direction:column;
    -webkit-box-align:center;-webkit-align-items:center;align-items:center;
    -webkit-box-pack:center;-webkit-justify-content:center;justify-content:center;text-align:center}
  #label{font-size:11vmin;font-weight:600;letter-spacing:.02em;opacity:.9;padding:0 4vmin;line-height:1.1;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:96%}
  #num{font-size:52vmin;font-weight:800;line-height:1;color:${c.accent};font-variant-numeric:tabular-nums;margin-top:1vmin}
  #num.flash{-webkit-animation:pop .9s ease-out 1;animation:pop .9s ease-out 1}
  @-webkit-keyframes pop{0%{-webkit-transform:scale(1.18)}100%{-webkit-transform:scale(1)}}
  @keyframes pop{0%{transform:scale(1.18)}100%{transform:scale(1)}}
  #dot{position:absolute;right:2vmin;bottom:2vmin;width:2vmin;height:2vmin;border-radius:50%;background:${c.color};opacity:0}
  #dot.stale{opacity:.35}
</style></head>
<body><div id="w"><div id="label">${escapeHtml(c.label)}</div><div id="num">&#8211;</div></div><div id="dot"></div>
<script>
${queueWidgetStep.toString()}
(function () {
  var CFG = ${jsonForScript(cfg)};
  var view = { number: 0, callSeq: null, rev: null, lastOk: 0, primed: false, sound: false };
  var numEl = document.getElementById('num');
  var dotEl = document.getElementById('dot');
  function paint(v) {
    try {
      var text = v.number > 0 ? String(v.number) : '\\u2013';
      if (numEl.textContent !== text) numEl.textContent = text;
      dotEl.className = v.stale ? 'stale' : '';
    } catch (e) { /* keep whatever is on screen */ }
  }
  function flash() {
    try { numEl.className = ''; void numEl.offsetWidth; numEl.className = 'flash'; } catch (e) { /* cosmetic */ }
  }
  function chime() {
    // Ask the player; it owns the sound (see lib/queue/widget.js). One message per called number.
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'st-queue-chime', volume: CFG.volume, widget_id: CFG.widgetId }, '*'); } catch (e) { /* no player */ }
  }
  if (CFG.preview) { view.number = 42; paint(view); return; }
  if (CFG.initial) {
    // Primed: a call that happens after this page was drawn chimes, the one it was drawn with does not.
    view = { number: CFG.initial.number, callSeq: CFG.initial.callSeq, rev: CFG.initial.rev, lastOk: new Date().getTime(), primed: true, sound: CFG.initial.sound };
    paint(view);
  }
  var device = (/[?&]device=([^&#]+)/.exec(location.search || '') || [])[1] || '';
  var base = /^https?:$/.test(location.protocol) ? '' : String(CFG.origin || '');
  var inFlight = false;
  function apply(resp) {
    var next;
    try { next = queueWidgetStep(view, resp, new Date().getTime(), CFG.staleMs); } catch (e) { return; }
    var changed = next.number !== view.number;
    view = next;
    paint(view);
    if (changed && view.primed) flash();
    if (view.chime && CFG.chime) chime();
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
    var done = false;
    function finish(resp) { if (done) return; done = true; inFlight = false; apply(resp); }
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

function renderCsp(origin) {
  const o = /^https?:\/\/[^\s;'"]+$/.test(String(origin || '')) ? ` ${origin}` : '';
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'${o}; sandbox allow-scripts`;
}

module.exports = { renderQueueWidget, renderCsp, widgetConfig, queueWidgetStep, POLL_MS, STALE_MS };
