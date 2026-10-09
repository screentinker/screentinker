'use strict';

/*
 * The room display page (widget type 'room-display').
 *
 * One self-contained document. It fetches the room's state from /api/room-panel/<widget>/state every
 * 30 s, keeps the last good copy, and re-evaluates FREE/BUSY every second with the same function the
 * server uses (lib/rooms/freebusy.js, inlined below), so the sign flips on time with the network down.
 * Its clock is corrected by the server's (server_now), because a panel's own clock is often wrong.
 *
 * Touch actions appear only when the URL's FRAGMENT carries this panel's capability (#panel=…, put
 * there by a player that supports it — see lib/rooms/service.js panelToken). Without it the page is a
 * read-only sign, which is what every other player shows.
 *
 * Its own words are in the widget's language, or with "auto" the screen's (navigator.languages), so
 * one widget can serve rooms in two countries; see strings.js.
 *
 * Every string from the calendar is inserted as TEXT (textContent), never as HTML: meeting titles are
 * typed by anyone who can send an invitation.
 */

const { computeRoomState, dayBounds, midnightIn, dateIn } = require('./freebusy');
const { ROOM_PAGE_STRINGS, ROOM_PAGE_LANGUAGES } = require('./strings');

// Every language goes into the page; the screen picks one (see strings.js).
const STRINGS = ROOM_PAGE_STRINGS.en;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: escape what could close the element or start a comment.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

function renderRoomDisplay({ widgetId, origin, config = {}, initial = null }) {
  const cfg = {
    stateUrl: `${origin}/api/room-panel/${encodeURIComponent(widgetId)}/state`,
    actionUrl: `${origin}/api/room-panel/${encodeURIComponent(widgetId)}/action`,
    seenUrl: `${origin}/api/room-panel/${encodeURIComponent(widgetId)}/seen`,
    locale: LOCALE_RE.test(String(config.locale || '')) ? config.locale : null,
    layout: ['portrait', 'landscape'].includes(config.layout) ? config.layout : 'auto',
    showSchedule: config.show_schedule !== false,
    language: ROOM_PAGE_LANGUAGES.includes(config.language) ? config.language : null,
    strings: ROOM_PAGE_STRINGS,
    initial,
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Room</title>
<style>
  :root { --free:#0d6b37; --busy:#a3221b; --pending:#9a5800; --ink:#fff; --panel:#111418; --muted:#a9b1bb; --line:#2a3038; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--panel); color:var(--ink); font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; overflow:hidden; }
  #app { display:flex; height:100vh; width:100vw; }
  .status { flex:3 1 0; display:flex; flex-direction:column; justify-content:space-between; padding:5vmin; min-width:0; transition:background .4s; }
  .status.free { background:var(--free); } .status.busy { background:var(--busy); } .status.pending { background:var(--pending); }
  .name { font-size:5.2vmin; font-weight:600; letter-spacing:.01em; overflow-wrap:anywhere; }
  .state { display:flex; align-items:center; gap:3vmin; margin-top:2vmin; }
  .state svg { width:13vmin; height:13vmin; flex:none; }
  .word { font-size:12vmin; font-weight:800; line-height:1; }
  .detail { font-size:4.4vmin; margin-top:2.5vmin; font-weight:500; }
  .meeting { font-size:4vmin; margin-top:2vmin; opacity:.95; overflow-wrap:anywhere; }
  .meeting .who { opacity:.85; font-size:3.4vmin; margin-top:.8vmin; }
  .actions { display:flex; flex-wrap:wrap; gap:2vmin; margin-top:3vmin; }
  button { font:inherit; font-size:4vmin; font-weight:700; padding:2.2vmin 3.4vmin; border-radius:1.6vmin; border:.4vmin solid rgba(255,255,255,.9); background:rgba(0,0,0,.18); color:#fff; min-height:9vmin; cursor:pointer; }
  button:active { background:rgba(0,0,0,.4); } button[disabled] { opacity:.5; }
  .note { font-size:3.2vmin; margin-top:2vmin; min-height:4vmin; }
  .schedule { flex:2 1 0; padding:5vmin 4vmin; border-left:.3vmin solid var(--line); overflow:hidden; min-width:0; }
  .schedule h2 { margin:0 0 2.5vmin; font-size:4.4vmin; color:var(--muted); font-weight:600; }
  .ev { display:flex; gap:2.5vmin; padding:1.8vmin 0; border-bottom:.2vmin solid var(--line); font-size:3.5vmin; }
  .ev .t { flex:none; width:22vmin; color:var(--muted); font-variant-numeric:tabular-nums; }
  .ev .s { overflow-wrap:anywhere; min-width:0; }
  .ev.now .t, .ev.now .s { color:#fff; font-weight:700; }
  .empty { color:var(--muted); font-size:3.6vmin; }
  .offline { font-size:2.8vmin; color:var(--muted); margin-top:2vmin; }
  .nextfree { font-size:3.4vmin; margin-top:3vmin; color:var(--muted); }
  @media (orientation: portrait) { #app.auto { flex-direction:column; } #app.auto .schedule { border-left:0; border-top:.3vmin solid var(--line); } }
  #app.portrait { flex-direction:column; } #app.portrait .schedule { border-left:0; border-top:.3vmin solid var(--line); }
  #app.noschedule .schedule { display:none; }
</style></head>
<body><div id="app" class="${esc(cfg.layout)}${cfg.showSchedule ? '' : ' noschedule'}">
  <section class="status" id="status">
    <div>
      <div class="name" id="name"></div>
      <div class="state"><span id="icon"></span><span class="word" id="word"></span></div>
      <div class="detail" id="detail"></div>
      <div class="meeting" id="meeting"></div>
    </div>
    <div>
      <div class="actions" id="actions"></div>
      <div class="note" id="note"></div>
      <div class="offline" id="offline"></div>
    </div>
  </section>
  <section class="schedule"><h2 id="todayh"></h2><div id="list"></div><div class="nextfree" id="nextfree"></div></section>
</div>
<script>
${computeRoomState.toString()}
${midnightIn.toString()}
${dateIn.toString()}
${dayBounds.toString()}
(function () {
  var CFG = ${jsonForScript(cfg)};
  // The widget's language, else its locale's, else the screen's own, else English. Missing words
  // fall back to English one by one.
  var LANG = (function () {
    var want = [CFG.language, CFG.locale];
    try { want = want.concat(navigator.languages || [navigator.language]); } catch (e) {}
    for (var i = 0; i < want.length; i++) {
      var c = String(want[i] || '').toLowerCase().split(/[-_]/)[0];
      if (c && CFG.strings[c]) return c;
    }
    return 'en';
  })();
  var S = {};
  for (var k in CFG.strings.en) S[k] = CFG.strings[LANG][k] || CFG.strings.en[k];
  document.documentElement.lang = LANG;
  var TIME_LOCALE = CFG.locale || (CFG.language ? LANG : undefined);
  // The server's refusals are English; a code it sends is answered in the panel's own language.
  var REFUSALS = { 'busy': 'err_busy', 'too-short': 'err_too_short', 'not-current': 'err_not_current', 'not-panel': 'err_not_panel', 'booking-off': 'err_booking_off', 'read-only': 'err_booking_off' };
  function refusal(status, j) {
    var code = j && j.code;
    if (code && REFUSALS[code]) return S[REFUSALS[code]];
    if (status === 429) return S.err_limited;
    if (status === 502) return S.err_calendar;
    if (LANG === 'en' && j && j.error) return j.error;
    return S.failed;
  }
  var m = /(?:^|[#&])panel=([^&]+)/.exec(location.hash || '');
  var PANEL = m ? decodeURIComponent(m[1]) : null;
  var q = /[?&]device=([^&]+)/.exec(location.search || '');
  var DEVICE = q ? decodeURIComponent(q[1]) : null;
  var state = CFG.initial, skew = 0, lastOk = 0, busyAction = false, noteTimer = null, lastKey = '';
  if (state && state.server_now) skew = state.server_now - Date.now();
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (s, v) { return s.replace(/\\{(\\w)\\}/g, function (_, k) { return v[k]; }); };
  var now = function () { return Date.now() + skew; };
  function time(ms) {
    try { return new Intl.DateTimeFormat(TIME_LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: (state && state.room.timezone) || 'UTC' }).format(new Date(ms)); }
    catch (e) { return new Date(ms).toISOString().slice(11, 16); }
  }
  var ICONS = {
    free: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>',
    busy: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7 12h10"/></svg>',
    pending: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/></svg>'
  };
  function label(e) { return e.panel ? S.booked_here : (e.title || (e.private ? S.private_meeting : S.reserved)); }
  function note(text) {
    $('note').textContent = text || '';
    if (noteTimer) clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(function () { $('note').textContent = ''; }, 6000);
  }
  function button(text, fn) {
    var b = document.createElement('button');
    b.textContent = text;
    b.disabled = busyAction;
    b.addEventListener('click', fn);
    return b;
  }
  function act(body) {
    if (busyAction || !PANEL) return;
    busyAction = true; note(S.working); paint(true);
    body.device = DEVICE; body.panel = PANEL;
    fetch(CFG.actionUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (res) {
        busyAction = false;
        if (res.j && res.j.state) accept(res.j.state);
        note(res.ok ? '' : refusal(res.status, res.j));
        paint(true);
      })
      .catch(function () { busyAction = false; note(S.unreachable); paint(true); });
  }
  function accept(s) { state = s; skew = s.server_now - Date.now(); lastOk = Date.now(); }
  function poll() {
    fetch(CFG.stateUrl + (DEVICE ? '?device=' + encodeURIComponent(DEVICE) : ''), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (s) { accept(s); paint(true); })
      .catch(function () { paint(true); });
  }
  // "This screen is showing the room, with working buttons": the no-show release waits for it
  // (lib/rooms/service.js panelPresent). Only with the capability; a read-only sign says nothing.
  function seen() {
    if (!PANEL || !DEVICE) return;
    try { fetch(CFG.seenUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ device: DEVICE, panel: PANEL }), cache: 'no-store' }).catch(function () {}); } catch (e) {}
  }
  function paint(force) {
    if (!state || !state.room) {
      $('name').textContent = ''; $('word').textContent = ''; $('detail').textContent = S.no_room;
      return;
    }
    var t = now();
    var st = computeRoomState(state.events || [], t);
    var opts = state.options || {};
    var cur = st.current;
    var rel = opts.release_min > 0 ? opts.release_min * 60000 : 0;
    var needsCheckin = !!(rel && cur && !cur.allDay && !cur.checked_in && t < cur.start + rel);
    var kind = st.busy ? (needsCheckin ? 'pending' : 'busy') : 'free';
    var day = dayBounds(state.room.timezone || 'UTC', t);
    var key = [kind, cur && cur.id, st.freeUntil, st.busyUntil, Math.floor(t / 60000), busyAction, (state.events || []).length, state.fetched_at, lastOk > 0].join('|');
    if (!force && key === lastKey) return;
    lastKey = key;

    $('status').className = 'status ' + kind;
    $('name').textContent = state.room.name;
    $('icon').innerHTML = ICONS[kind];
    $('word').textContent = kind === 'free' ? S.available : (kind === 'pending' ? S.checkin : S.busy);
    if (st.busy) {
      var left = Math.max(1, Math.ceil((cur.end - t) / 60000));
      $('detail').textContent = fmt(S.until, { t: time(st.busyUntil) }) + ' · ' + fmt(S.left, { n: left });
      $('meeting').innerHTML = '';
      var title = document.createElement('div'); title.textContent = label(cur); $('meeting').appendChild(title);
      if (cur.organiser) { var who = document.createElement('div'); who.className = 'who'; who.textContent = cur.organiser; $('meeting').appendChild(who); }
    } else {
      $('detail').textContent = st.freeUntil && st.freeUntil < day.end ? fmt(S.free_until, { t: time(st.freeUntil) }) : S.free_all_day;
      $('meeting').textContent = st.next && st.next.start < day.end ? fmt(S.next, { t: time(st.next.start) }) + ' — ' + label(st.next) : '';
    }

    var a = $('actions'); a.innerHTML = '';
    if (PANEL && opts.booking) {
      if (!st.busy) {
        var gap = st.freeUntil ? st.freeUntil - t : Infinity;
        var fits = (opts.book_minutes || []).filter(function (n) { return n * 60000 <= gap; });
        fits.forEach(function (n) { a.appendChild(button(fmt(S.book, { n: n }), function () { act({ action: 'book', minutes: n }); })); });
        if (!fits.length && gap >= 5 * 60000) a.appendChild(button(fmt(S.book_until, { t: time(st.freeUntil) }), function () { act({ action: 'book', minutes: 0 }); }));
      } else {
        if (needsCheckin) a.appendChild(button(S.check_in, function () { act({ action: 'checkin', event_id: cur.id }); }));
        if (cur.panel || opts.end_any) a.appendChild(button(S.end, function () { act({ action: 'end', event_id: cur.id }); }));
      }
    }
    if (needsCheckin && !busyAction && !$('note').textContent) $('note').textContent = fmt(S.release_at, { t: time(cur.start + rel) });

    // Saved schedule: the server says its copy is old (the calendar is unreachable), or this screen
    // has not reached the server for three minutes (lastOk), or never has and the copy it was
    // rendered with is that old.
    var age = lastOk ? Date.now() - lastOk : (state.fetched_at ? t - state.fetched_at : Infinity);
    $('offline').textContent = state.stale || age > 3 * 60000 ? S.offline : '';

    $('todayh').textContent = S.today;
    var list = $('list'); list.innerHTML = '';
    var today = (st.upcoming || []).filter(function (e) { return e.start < day.end; }).slice(0, 8);
    if (!today.length) { var em = document.createElement('div'); em.className = 'empty'; em.textContent = S.no_more; list.appendChild(em); }
    today.forEach(function (e) {
      var row = document.createElement('div'); row.className = 'ev' + (cur && e.id === cur.id ? ' now' : '');
      var tt = document.createElement('div'); tt.className = 't'; tt.textContent = e.allDay ? S.all_day : time(e.start) + '–' + time(e.end);
      var ss = document.createElement('div'); ss.className = 's'; ss.textContent = label(e);
      row.appendChild(tt); row.appendChild(ss); list.appendChild(row);
    });
    $('nextfree').textContent = st.busy && st.busyUntil < day.end ? fmt(S.next_free, { t: time(st.busyUntil) }) : '';
  }
  paint(true);
  poll();
  setInterval(poll, 30000);
  seen();
  setInterval(seen, 60000);
  setInterval(function () { paint(false); }, 1000);
})();
</script></body></html>`;
}

module.exports = { renderRoomDisplay, STRINGS };
