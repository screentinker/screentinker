// Walk-up interactive web pages (#473) for the WEB player — which is also the player inside the
// webOS shell and inside BrightSign's roHtmlWidget.
//
// The pure rules are NOT here: they are window.KioskLogic (server/lib/kiosk-logic.js, served as
// /player/kiosk-logic.js), checked against shared/kiosk-vectors.json like every other player.
// This file is the session ENGINE around them: the same state machine as Android's
// KioskSession.kt, driving one of two surfaces.
//
//   FRAMED  (every browser, webOS, a BrightSign whose host cannot do better)
//           The player is itself a web page, so the site can only be shown in an <iframe> the
//           player creates. Best effort, and honest about it: the player cannot see inside a
//           cross-origin frame, so it cannot enforce the domain allowlist, cannot wipe the site's
//           cookies or storage, and sees only some of the visitor's taps. Declares
//           playback.web_interactive_framed, never the full capability.
//   HOST    (BrightSign, when autorun.brs says it can)
//           The host opens a SECOND roHtmlWidget pointed at the site top-level, over the player,
//           with its own storage directory per session, and a script injected into every page it
//           loads reports touches, media, navigation and consent cookies back. The wipe and the
//           allowlist are real there, so it declares playback.web_interactive.
//
// Dependency-free UMD (window.KioskPlayer), assigned unconditionally so a BrightSign widget with
// nodejs_enabled (where `module` also exists) still gets the global.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KioskPlayer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAG = '[Kiosk]';
  var HOME_LABEL = '⌂  Home';
  var CARD_TOO_OLD = 'This page needs a newer web browser than this screen has.';
  var LOAD_TIMEOUT_MS = 20000;       // framed: no `load` at all within this = the page did not load
  var HOST_OPEN_TIMEOUT_MS = 4000;   // host must answer kiosk-open within this, or we frame instead
  var HOST_HELLO_TIMEOUT_MS = 15000; // ...and the injected page script must report in within this
  var TICK_MS = 500;
  var PERSIST_OPEN_MS = 10000;
  var QUEUE_CAP = 500;
  var BATCH = 50;
  var HELD_ERRORS_MAX = 10;
  var INJECT_CSS = '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    'input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Inline copies of four KioskLogic rules, for the script injected into the SITE's pages on
  // BrightSign (HOST mode). That script runs in a page that has no KioskLogic, so it carries its
  // own copy — serialised from these exact functions with Function#toString. Each one is tested
  // against shared/kiosk-vectors.json (server/test/web-player-kiosk.test.js), so they cannot drift
  // from the canonical rules any more than the Kotlin copy can. Self-contained on purpose: no
  // free variables, or the serialised copy would throw in the page.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  function kHostOf(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    var m = /^(https?):\/\/([^\/?#:@]+)(:\d+)?(?:[\/?#]|$)/i.exec(url.trim());
    if (!m) return null;
    var h = m[2].toLowerCase().replace(/\.+$/, '');
    return h || null;
  }
  function kIsAllowed(url, allowed) {
    if (url == null) return false;
    if (url === 'about:blank') return true;
    var host = kHostOf(url);
    if (!host) return false;
    for (var i = 0; i < (allowed || []).length; i++) {
      var d = allowed[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }
  function kSelectCookies(header, patterns) {
    if (typeof header !== 'string' || !header.trim() || !patterns || !patterns.length) return [];
    var out = [], seen = {};
    var parts = header.split(';');
    for (var j = 0; j < parts.length; j++) {
      var part = parts[j];
      var i = part.indexOf('=');
      if (i <= 0) continue;
      var name = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
      if (!name || seen[name]) continue;
      var hit = false;
      for (var k = 0; k < patterns.length; k++) {
        var p = patterns[k];
        if (p.charAt(p.length - 1) === '*' ? name.indexOf(p.slice(0, -1)) === 0 : name === p) { hit = true; break; }
      }
      if (!hit) continue;
      seen[name] = true;
      out.push([name, value]);
    }
    return out;
  }
  function kIsStartPage(current, start) {
    var norm = function (u) { return String(u).split('#')[0].replace(/\/+$/, '').toLowerCase(); };
    return current == null || current === 'about:blank' || norm(current) === norm(start);
  }

  /*
   * The script the BrightSign host injects (javascript_injection.document_creation) into EVERY
   * document the kiosk widget loads. It runs before the site's own scripts. Serialised with
   * toString(), so it must not reference anything outside its arguments.
   *
   *   C = { session, start, domains, homeButton, homeLabel, css, patterns, consent, evt }
   *   R = { hostOf, isAllowed, selectCookies, isStartPage }
   */
  function kioskPageScript(C, R) {
    var W = window, D = document;
    if (W.__stKioskDoc) return;
    try { Object.defineProperty(W, '__stKioskDoc', { value: true }); } catch (e) { W.__stKioskDoc = true; }
    var top = false;
    try { top = (W.top === W); } catch (e) { top = false; }

    // The BrightSign objects are needed for ONE thing — the message port back to the host — and the
    // widget only allows one BSMessagePort instance, so taking it first means the site cannot make
    // its own. Every other BS* global is removed before the site's scripts run: the site is a
    // third-party web page and has no business with the player's hardware objects.
    var Port = null;
    if (top) { try { if (typeof W.BSMessagePort === 'function') Port = new W.BSMessagePort(); } catch (e) { Port = null; } }
    try {
      var names = Object.getOwnPropertyNames(W);
      for (var ni = 0; ni < names.length; ni++) {
        if (!/^BS[A-Z]/.test(names[ni])) continue;
        try { delete W[names[ni]]; } catch (e) { /* non-configurable */ }
        try { if (W[names[ni]] !== undefined) Object.defineProperty(W, names[ni], { value: undefined, writable: false, configurable: false }); } catch (e) { /* tried */ }
      }
    } catch (e) { /* nothing to hide */ }

    var href = String(W.location.href);
    var last = 0;
    function post(o) {
      o.session = C.session;
      if (Port) { try { Port.PostBSMessage(o); } catch (e) { /* host gone */ } return; }
      // A subframe has no port: it hands activity to the top document, which forwards it.
      if (!top) { try { W.parent.postMessage({ __stKioskActivity: C.session, touch: o.touch || '', media: o.media || '' }, '*'); } catch (e) { /* ignore */ } }
    }
    function activity(kind) {
      var now = Date.now();
      if (kind === 'touch' && now - last < 1000) return;
      if (kind === 'touch') last = now;
      var o = { type: 'kiosk-activity' };
      o[kind] = '1';
      post(o);
    }
    var evs = ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'wheel'];
    for (var ei = 0; ei < evs.length; ei++) {
      try { W.addEventListener(evs[ei], function () { activity('touch'); }, true); } catch (e) { /* ignore */ }
    }
    // Media playing in the page keeps a session alive (it never starts one).
    try {
      W.setInterval(function () {
        try {
          var m = D.querySelectorAll('video,audio');
          for (var i = 0; i < m.length; i++) { if (!m[i].paused && !m[i].ended) { activity('media'); return; } }
        } catch (e) { /* ignore */ }
      }, 5000);
    } catch (e) { /* ignore */ }
    if (!top) return;   // the allowlist, the UI and the reporting are the top document's job

    W.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.__stKioskActivity !== C.session) return;
      if (d.media) activity('media'); else activity('touch');
    });

    // 1. The navigation allowlist, TOP-LEVEL only. A document outside it is reported and left.
    if (!R.isAllowed(href, C.domains)) {
      post({ type: 'kiosk-blocked', url: href });
      try { if (W.history.length > 1) W.history.back(); else W.location.replace(C.start); } catch (e) { /* host steps in */ }
      return;
    }
    // ...and the commonest ways off-site are stopped BEFORE the request is made.
    function blockedTarget(u) { return !/^javascript:/i.test(u) && !R.isAllowed(u, C.domains); }
    D.addEventListener('click', function (e) {
      var a = e.target;
      while (a && a.nodeType === 1 && !(a.tagName === 'A' && a.href)) a = a.parentNode;
      if (!a || a.nodeType !== 1) return;
      var u = String(a.href);
      if (a.hasAttribute('download') || blockedTarget(u)) {
        e.preventDefault(); e.stopPropagation();
        post({ type: 'kiosk-blocked', url: u, what: a.hasAttribute('download') ? 'download' : '' });
        return;
      }
      var t = (a.getAttribute('target') || '').toLowerCase();
      if (t && t !== '_self' && t !== '_top' && t !== '_parent') { e.preventDefault(); W.location.href = u; }   // popups load in place
    }, true);
    D.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || !f.action) return;
      if (blockedTarget(String(f.action))) { e.preventDefault(); e.stopPropagation(); post({ type: 'kiosk-blocked', url: String(f.action) }); return; }
      try { if (f.target && f.target !== '_self') f.target = '_self'; } catch (er) { /* ignore */ }
    }, true);
    try {
      W.open = function (u) {
        try {
          var abs = new URL(String(u || ''), W.location.href).href;
          if (R.isAllowed(abs, C.domains)) W.location.href = abs;
          else post({ type: 'kiosk-blocked', url: abs });
        } catch (e) { /* ignore */ }
        return null;
      };
    } catch (e) { /* ignore */ }

    // 2. Consent cookies kept from earlier sessions (BY NAME — the player selected them), restored
    //    into this fresh storage before the site's banner script reads document.cookie.
    try {
      var host = R.hostOf(href);
      for (var ci = 0; ci < (C.consent || []).length; ci++) {
        var c = C.consent[ci];   // [host, name, value]
        if (!host || !(host === c[0] || host.slice(-(c[0].length + 1)) === '.' + c[0])) continue;
        if ((' ' + D.cookie).indexOf(' ' + c[1] + '=') >= 0) continue;
        D.cookie = c[1] + '=' + c[2] + '; path=/; max-age=31536000' + (/^https:/i.test(href) ? '; secure' : '');
      }
    } catch (e) { /* cookies disabled */ }

    // 3. Navigation: one report per document, plus single-page-app history changes.
    var reload = '0';
    try { var nav = W.performance.getEntriesByType('navigation')[0]; if (nav && nav.type === 'reload') reload = '1'; } catch (e) { /* old engine */ }
    post({ type: 'kiosk-nav', url: href, reload: reload });
    try {
      var push = W.history.pushState;
      W.history.pushState = function () {
        var r = push.apply(this, arguments);
        try { post({ type: 'kiosk-nav', url: String(W.location.href), reload: '0' }); } catch (e) { /* ignore */ }
        return r;
      };
      W.addEventListener('popstate', function () { post({ type: 'kiosk-nav', url: String(W.location.href), reload: '0' }); });
    } catch (e) { /* ignore */ }

    // 4. Consent cookies as the visitor sets them, so the next session can restore them.
    var lastConsent = null;
    function grabConsent() {
      if (!C.patterns || !C.patterns.length) return;
      try {
        var sel = R.selectCookies(D.cookie, C.patterns), s = [];
        for (var i = 0; i < sel.length; i++) s.push(sel[i][0] + '=' + sel[i][1]);
        var joined = s.join('; ');
        if (joined && joined !== lastConsent) { lastConsent = joined; post({ type: 'kiosk-consent', host: R.hostOf(W.location.href) || '', cookies: joined }); }
      } catch (e) { /* ignore */ }
    }
    try { W.setInterval(grabConsent, 3000); W.addEventListener('pagehide', grabConsent); } catch (e) { /* ignore */ }

    // 5. UI the player cannot draw (its widget is underneath this one): the Home button and the
    //    "Still there?" overlay. Driven by a DOM event, which crosses JavaScript worlds.
    var ui = { home: null, overlay: null };
    function mount(el) { (D.body || D.documentElement).appendChild(el); }
    function showHome() {
      if (!C.homeButton || ui.home || R.isStartPage(W.location.href, C.start)) return;
      var b = D.createElement('div');
      b.textContent = C.homeLabel;
      b.setAttribute('style', 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483646;' +
        'padding:10px 18px;border-radius:28px;background:rgba(17,24,39,.75);color:#fff;font:18px sans-serif;cursor:pointer');
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        post({ type: 'kiosk-activity', touch: '1', home: '1' });
        W.location.href = C.start;
      }, true);
      ui.home = b;
      mount(b);
    }
    D.addEventListener(C.evt, function (e) {
      var d = (e && e.detail) || {};
      if (d.warn != null) {
        if (!ui.overlay) {
          var o = D.createElement('div');
          o.setAttribute('style', 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
            'display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-line;' +
            'background:rgba(0,0,0,.78);color:#fff;font:26px sans-serif');
          o.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); post({ type: 'kiosk-activity', touch: '1' }); }, true);
          ui.overlay = o;
          mount(o);
        }
        ui.overlay.textContent = String(d.warn);
      }
      if (d.resume && ui.overlay) { try { ui.overlay.parentNode.removeChild(ui.overlay); } catch (er) { /* gone */ } ui.overlay = null; }
    });

    function ready() {
      try { var s = D.createElement('style'); s.textContent = C.css; (D.head || D.documentElement).appendChild(s); } catch (e) { /* ignore */ }
      showHome();
      grabConsent();
      // HTTP status of THIS document (Chromium 109+). A 4xx/5xx start page is a failure, not content.
      try {
        var n = W.performance.getEntriesByType('navigation')[0];
        if (n && n.responseStatus >= 400) post({ type: 'kiosk-error', reason: 'http_error', url: href, detail: 'HTTP ' + n.responseStatus });
      } catch (e) { /* not reported by this engine */ }
    }
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', ready); else ready();
  }

  function b64(s) {
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') return Buffer.from(s, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(s)));
  }

  /** The injected page script as a source string, parameterised for one session. */
  function buildInjectSource(cfg, opts) {
    var o = opts || {};
    var C = {
      session: o.session || '',
      start: cfg.url,
      domains: cfg.allowedDomains || [],
      homeButton: cfg.homeButton !== false,
      homeLabel: HOME_LABEL,
      css: INJECT_CSS,
      patterns: o.patterns || [],
      consent: o.consent || [],
      evt: o.evt || 'st-kiosk',
    };
    return '(function(){' + kHostOf.toString() + '\n' + kIsAllowed.toString() + '\n' + kSelectCookies.toString() + '\n' +
      kIsStartPage.toString() + '\n(' + kioskPageScript.toString() + ')(' + JSON.stringify(C) +
      ',{hostOf:kHostOf,isAllowed:kIsAllowed,selectCookies:kSelectCookies,isStartPage:kIsStartPage});})();';
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Usage records: a bounded, persisted, ordered queue dropped only on the server's ack.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  function SessionQueue(storage, key, cap) {
    this.storage = storage || null;
    this.key = key;
    this.cap = cap || QUEUE_CAP;
    this.items = [];
    try {
      var raw = this.storage ? this.storage.getItem(key) : null;
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) this.add(arr[i], true);
    } catch (e) { this.items = []; /* unreadable: start empty rather than wedge */ }
  }
  SessionQueue.prototype.add = function (r, noSave) {
    if (!r || typeof r.id !== 'string' || !r.id) return;
    for (var i = 0; i < this.items.length; i++) if (this.items[i].id === r.id) return;
    this.items.push(r);
    while (this.items.length > this.cap) this.items.shift();
    if (!noSave) this.save();
  };
  SessionQueue.prototype.peek = function (n) { return this.items.slice(0, n || BATCH); };
  SessionQueue.prototype.ack = function (ids) {
    if (!ids || !ids.length) return;
    var drop = {};
    for (var i = 0; i < ids.length; i++) drop[ids[i]] = true;
    this.items = this.items.filter(function (r) { return !drop[r.id]; });
    this.save();
  };
  SessionQueue.prototype.size = function () { return this.items.length; };
  SessionQueue.prototype.save = function () {
    try { if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.items)); } catch (e) { /* quota */ }
  };

  /** Failure reports held while offline: newest kept, max 10, in memory only (like Android). */
  function ErrorHold(max) { this.max = max || HELD_ERRORS_MAX; this.items = []; }
  ErrorHold.prototype.add = function (reason, detail) {
    this.items.push([reason, (String(detail) + ' (while offline)').slice(0, 400)]);   // 400 INCLUDING the suffix
    while (this.items.length > this.max) this.items.shift();
  };
  ErrorHold.prototype.drain = function () { var a = this.items; this.items = []; return a; };

  function defaultUuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure context */ }
    var s = '', h = '0123456789abcdef';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; continue; }
      s += i === 14 ? '4' : h.charAt(Math.floor(Math.random() * 16));
    }
    return s;
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // The engine.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * env:
   *   logic      window.KioskLogic
   *   win, doc   the player's window/document
   *   container  () => element to mount into (the player stage)
   *   hold()     first touch: hold the playlist on this item
   *   release()  session over: apply parked updates and advance
   *   skip()     could not show the page and nobody was using it: advance now
   *   report(reason, detail)   a dashboard incident (already rate-limited here)
   *   sessionEnd(record)       one usage record per visitor session
   *   storage    localStorage-like (open-session recovery, consent cookies) or null
   *   keySuffix  per-output storage suffix
   *   log(level, msg)          'i' | 'w'
   *   host       optional BrightSign adapter {available, open(params)->Promise<bool>, close(wipe),
   *              event(detail), goto(url), onMessage(fn)}
   *   onHostBroken()           the host failed us once: re-declare capabilities
   *   now, uuid, ua, origin    injectable for tests
   */
  function create(env) {
    var L = env.logic;
    var win = env.win, doc = env.doc;
    var now = env.now || function () { return Date.now(); };
    var uuid = env.uuid || defaultUuid;
    var log = env.log || function () {};
    var store = env.storage || null;
    var sfx = env.keySuffix || '';
    var OPEN_KEY = 'st_kiosk_open' + sfx;
    var CONSENT_KEY = 'st_kiosk_consent' + sfx;
    var setT = env.setTimeout || function (f, ms) { return win.setTimeout(f, ms); };
    var clearT = env.clearTimeout || function (t) { win.clearTimeout(t); };
    var host = env.host || null;
    var hostBroken = false;
    var framedWarned = false;
    var errors = new L.ErrorThrottle();

    var s = null;   // the mount; null when nothing is showing

    function info(m) { log('i', TAG + ' ' + m); }
    function warn(m) { log('w', TAG + ' ' + m); }

    function hostUsable() { return !!(host && !hostBroken && host.available && host.available()); }

    function capability() { return hostUsable() ? 'playback.web_interactive' : 'playback.web_interactive_framed'; }

    function el(tag, css, text) {
      var e = doc.createElement(tag);
      if (css) e.style.cssText = css;
      if (text != null) e.textContent = text;
      return e;
    }
    function removeEl(e) { try { if (e && e.parentNode) e.parentNode.removeChild(e); } catch (x) { /* gone */ } }

    function isShowing() { return !!s; }
    function isShowingItem(key) { return !!s && s.key === key; }
    function sessionActive() { return !!(s && s.idle && s.idle.inSession()); }

    function show(key, cfg, widgetId) {
      if (isShowingItem(key)) return;          // same item re-issued (playlist refresh): keep the visitor's page
      hide();                                  // ends a previous session, if any
      s = {
        key: key, cfg: cfg, widgetId: widgetId || null,
        idle: new L.Idle(cfg.idleTimeoutSec * 1000, cfg.warnSec * 1000),
        touched: false, failing: false, sessionId: null, startMs: 0, pages: 0, lastPersist: 0,
        mode: null, wrap: null, iframe: null, overlay: null, home: null, card: null,
        loads: 0, homeNav: false, loadTimer: null, helloTimer: null, tick: null, uaArmed: false,
        token: uuid(), evt: 'st-kiosk-' + Math.floor(Math.random() * 1e9).toString(36), warned: false,
        blocks: [], lastWarnText: null,
      };
      var ua = env.ua != null ? env.ua : (win.navigator && win.navigator.userAgent);
      if (L.tooOld(ua, cfg.minWebView)) {
        warn('browser too old for ' + cfg.url + ' (Chrome ' + (L.chromeMajor(ua) || '?') + ', need ' + cfg.minWebView + ') — showing card');
        report('webview_too_old', cfg.url, 'Chrome ' + (L.chromeMajor(ua) || '?') + ', page needs ' + cfg.minWebView);
        showCard(CARD_TOO_OLD);
        return;
      }
      info('interactive page: ' + cfg.url + ' (idle ' + cfg.idleTimeoutSec + 's, domains ' + JSON.stringify(cfg.allowedDomains) +
        ', zoom ' + cfg.zoomPct + '%' + (cfg.keepConsent ? ', keeps consent cookies' : '') + ')');
      if (hostUsable()) mountHost(s); else mountFramed(s);
      var mine = s;
      var loop = function () {
        if (s !== mine) return;
        tick();
        mine.tick = setT(loop, TICK_MS);
      };
      mine.tick = setT(loop, TICK_MS);
    }

    /** Leave the item. Ends (and wipes) a visitor's session; the next one never sees it. */
    function hide(wipe, reason) {
      if (!s) return;
      var m = s;
      if (wipe === undefined) wipe = m.touched;
      finishSession(reason || 'interrupted');
      s = null;
      if (m.tick) clearT(m.tick);
      if (m.loadTimer) clearT(m.loadTimer);
      if (m.helloTimer) clearT(m.helloTimer);
      if (m.beat) clearT(m.beat);
      if (m.onBlur) { try { win.removeEventListener('blur', m.onBlur); } catch (x) { /* ignore */ } }
      removeEl(m.overlay); removeEl(m.home); removeEl(m.card);
      if (m.iframe) { try { m.iframe.src = 'about:blank'; } catch (x) { /* ignore */ } }
      removeEl(m.wrap);
      if (m.mode === 'host' && host) closeHost(m.token, !!wipe);
      if (m.mode === 'framed' && wipe) {
        // Honest: the frame is gone, the site's storage is not.
        warn('web storage NOT wiped — framed mode cannot clear a framed site\'s cookies or storage (the frame was removed)');
      }
      if (m.idle) m.idle.end();
    }

    function finishSession(reason) {
      if (!s || !s.sessionId) return;
      var start = s.startMs;
      var lastAct = Math.max(s.idle ? s.idle.lastActivity : start, start);
      var r = {
        id: s.sessionId, widget_id: s.widgetId, started_at: Math.floor(start / 1000),
        duration_sec: Math.max(1, Math.floor((lastAct - start) / 1000)), end_reason: reason, pages: Math.max(1, s.pages),
      };
      s.sessionId = null;
      clearOpen();
      info('session ended (' + reason + ') after ' + r.duration_sec + 's, ' + r.pages + ' page(s)');
      try { if (env.sessionEnd) env.sessionEnd(r); } catch (e) { /* never break playback */ }
    }

    function saveOpen() {
      if (!s || !s.sessionId || !store) return;
      var r = {
        id: s.sessionId, widget_id: s.widgetId, started_at: Math.floor(s.startMs / 1000),
        duration_sec: Math.max(1, Math.floor((s.idle.lastActivity - s.startMs) / 1000)), end_reason: 'interrupted', pages: Math.max(1, s.pages),
      };
      try { store.setItem(OPEN_KEY, JSON.stringify(r)); } catch (e) { /* quota */ }
    }
    function clearOpen() { try { if (store) store.removeItem(OPEN_KEY); } catch (e) { /* ignore */ } }

    /** App start: a session cut off by a crash or power cut still counts, as `interrupted`. */
    function recoverOpenSession() {
      if (!store) return null;
      var r = null;
      try { var raw = store.getItem(OPEN_KEY); r = raw ? JSON.parse(raw) : null; } catch (e) { r = null; }
      clearOpen();
      if (r && typeof r.id === 'string') {
        info('previous interactive session was not ended — counting it as interrupted');
        // A framed site's storage cannot be wiped from here; a BrightSign host wipes its kiosk
        // storage at boot on its own (autorun.brs KioskWipeAll).
        return r;
      }
      return null;
    }

    function activity(touch) {
      if (!s || !s.idle) return;
      var t = now();
      apply(touch ? s.idle.onTouch(t) : s.idle.keepAlive(t));
      if (s && s.sessionId && t - s.lastPersist >= PERSIST_OPEN_MS) { s.lastPersist = t; saveOpen(); }
    }

    function apply(a) {
      if (!s) return;
      if (a === 'started') {
        s.touched = true;
        s.sessionId = uuid();
        s.startMs = now();
        s.pages = 1;
        s.lastPersist = s.startMs;
        saveOpen();
        info('session started — playlist held');
        try { env.hold(); } catch (e) { /* ignore */ }
      } else if (a && typeof a === 'object' && a.warn != null) {
        if (!s.warned) { s.warned = true; info('idle — "Still there?" countdown ' + a.warn + 's'); }
        showOverlay(a.warn);
      } else if (a === 'resumed') {
        s.warned = false;
        hideOverlay();
      } else if (a === 'reset') {
        info('session idle — wiping and moving on');
        hide(true, 'idle');
        try { env.release(); } catch (e) { /* ignore */ }
      }
    }

    function tick() {
      if (!s || !s.idle) return;
      // FRAMED activity, part 1: the browser's user activation. A tap inside a cross-origin frame
      // is invisible to this page's event listeners, but Chromium (72+) propagates the frame's
      // transient user activation to its ancestors, so navigator.userActivation.isActive turns true
      // here for ~5 s after the visitor's last tap or key. Armed only once it has been seen false
      // after the mount, so a tap on the item BEFORE this page appeared cannot start a session.
      if (s.mode === 'framed' && s.iframe && sameOriginBreach(s)) return;
      if (s.mode === 'framed') {
        var uact = win.navigator && win.navigator.userActivation;
        if (uact) {
          if (!uact.isActive) s.uaArmed = true;
          else if (s.uaArmed) activity(true);
        }
      }
      if (!s) return;
      apply(s.idle.tick(now()));
    }

    function overlayText(n) { return 'Still there?\nTap to keep browsing — resetting in ' + n + 's'; }

    function showOverlay(n) {
      var text = overlayText(n);
      if (s.mode === 'host') {
        if (text !== s.lastWarnText) { s.lastWarnText = text; hostEvent({ warn: text }); }
        return;
      }
      if (!s.overlay) {
        var o = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:30;display:flex;align-items:center;' +
          'justify-content:center;text-align:center;white-space:pre-line;background:rgba(0,0,0,.78);color:#fff;' +
          'font:26px sans-serif;cursor:pointer;touch-action:manipulation');
        var tap = function (e) { try { e.preventDefault(); } catch (x) { /* ignore */ } activity(true); };
        o.addEventListener('pointerdown', tap);
        o.addEventListener('touchstart', tap);
        o.addEventListener('mousedown', tap);
        s.overlay = o;
        (s.wrap || env.container()).appendChild(o);
      }
      s.overlay.textContent = text;
    }
    function hideOverlay() {
      if (!s) return;
      if (s.mode === 'host') { s.lastWarnText = null; hostEvent({ resume: true }); return; }
      removeEl(s.overlay); s.overlay = null;
    }
    function hostEvent(detail) {
      if (!host) return;
      try { host.event('document.dispatchEvent(new CustomEvent(' + JSON.stringify(s.evt) + ',{detail:' + JSON.stringify(detail) + '}))'); } catch (e) { /* ignore */ }
    }

    function showCard(text) {
      var c = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
        'text-align:center;padding:5%;background:#111827;color:#fff;font:28px sans-serif', text);
      s.card = c;
      env.container().appendChild(c);
    }

    function report(reason, url, detail) {
      if (!errors.shouldReport(reason, url, now())) return;
      var where = L.hostOf(url) || url || '';
      try { if (env.report) env.report(reason, ((where ? where + ': ' : '') + detail).slice(0, 400)); } catch (e) { /* ignore */ }
    }

    /** The page failed. Nobody using it: skip it. Someone using it: end their session and release. */
    function fail(reason, url, why) {
      if (!s || s.failing) return;
      s.failing = true;
      var key = s.key;
      warn('interactive page unavailable (' + why + ')');
      report(reason, url, why);
      setT(function () {
        if (!s || s.key !== key) return;       // already replaced by another item
        var was = sessionActive();
        hide(s.touched, 'error');
        try { if (was) env.release(); else env.skip(); } catch (e) { /* ignore */ }
      }, 0);
    }

    // ── FRAMED ─────────────────────────────────────────────────────────────────────────────
    function sandboxFor(url, m) {
      /*
       * allow-scripts + allow-forms + allow-same-origin: the site keeps ITS OWN origin, so its
       * scripts, forms, cookies and storage work (an opaque `null` origin — the server's widget
       * render — breaks every one of them). Deliberately absent:
       *   allow-top-navigation(-by-user-activation)  the site must never replace the player
       *   allow-popups(-to-escape-sandbox)           no new windows: window.open/target=_blank do nothing
       *   allow-modals        alert()/confirm() would block the renderer this page shares with the
       *                       frame on platforms without site isolation, freezing the idle clock
       *   allow-downloads     no downloads on a public panel
       *   allow-pointer-lock / allow-presentation / allow-orientation-lock   no use here
       * A SAME-ORIGIN url (a page this server hosts) loses allow-same-origin too: scripts + same
       * origin together would let it reach into the player and read its device token.
       */
      var same = false;
      try { same = !!env.origin && new URL(url).origin === env.origin; } catch (e) { same = false; }
      // ...and so does any page whose allowlist covers the player's own host: the visitor could
      // otherwise be taken there inside the frame. (Residual risk, documented: a third-party
      // redirect to the player's origin is not prevented — see onFramedLoad, which closes such a
      // frame the moment it can see it — and needs attacker-controlled script ON that origin.)
      try { if (!same && env.origin && L.isAllowed(env.origin + '/', m && m.cfg ? m.cfg.allowedDomains : [])) same = true; } catch (e) { /* keep */ }
      return same ? 'allow-scripts allow-forms' : 'allow-scripts allow-forms allow-same-origin';
    }

    function mountFramed(m) {
      m.mode = 'framed';
      var cfg = m.cfg;
      if (!framedWarned) {
        framedWarned = true;
        warn('framed mode (best effort): the site runs in a frame inside the player, so its cookies and storage ' +
          'cannot be wiped, the domain allowlist cannot be enforced, and taps inside it are seen only through ' +
          'focus and user activation. Declaring playback.web_interactive_framed.');
      }
      var z = (cfg.zoomPct || 100) / 100;
      var wrap = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;background:#fff;z-index:5');
      var f = doc.createElement('iframe');
      // LAYOUT zoom, the same model as the server's passive render (routes/widgets.js renderWebpage):
      // the page lays out at size/zoom and is scaled back up to fill, so it reflows instead of
      // being magnified past the edge. The frame's innerWidth is therefore stage width / zoom.
      f.style.cssText = 'position:absolute;left:0;top:0;border:0;background:#fff;' +
        'width:' + (100 / z) + '%;height:' + (100 / z) + '%;transform:scale(' + z + ');transform-origin:0 0';
      f.setAttribute('sandbox', sandboxFor(cfg.url, m));
      f.setAttribute('allow', 'autoplay; fullscreen');   // no camera, microphone, geolocation, payment
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.setAttribute('data-st-kiosk', '1');
      f.addEventListener('load', function () { onFramedLoad(m); });
      // One more level of nesting than the player's `#playerContainer > div > iframe` rule, which
      // forces every stage iframe to 100% !important and would silently cancel the zoom.
      var box = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden');
      box.appendChild(f);
      wrap.appendChild(box);
      m.wrap = wrap;
      m.iframe = f;
      var mixed = false;
      try { mixed = /^https:/i.test(env.origin || '') && /^http:/i.test(cfg.url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(cfg.url); } catch (e) { mixed = false; }
      // src BEFORE the frame enters the document: a src-less frame first loads about:blank and
      // raises a `load` that would count as the visitor's first navigation.
      if (!mixed) f.src = cfg.url;
      env.container().appendChild(wrap);
      // FRAMED activity, part 2: the first tap into the frame moves focus there, which blurs this
      // window. Works on engines without navigator.userActivation, and gives the exact moment of the
      // first touch. (Later taps inside the same frame raise nothing here once it has focus.)
      m.onBlur = function () {
        setT(function () { if (s === m && doc.activeElement === f) activity(true); }, 0);
      };
      win.addEventListener('blur', m.onBlur);
      if (mixed) { fail('load_error', cfg.url, 'http page cannot be framed inside an https player (mixed content)'); return; }
      m.loadTimer = setT(function () {
        if (s === m && m.loads === 0) fail('load_error', cfg.url, 'no page load within ' + (LOAD_TIMEOUT_MS / 1000) + 's (unreachable, or refuses to be framed?)');
      }, LOAD_TIMEOUT_MS);
      probe(m);
    }

    /*
     * Evidence about a page the frame cannot report on. A frame raises `load` for an error page
     * too (DNS failure, refused connection, X-Frame-Options), so the frame alone proves nothing.
     *  - a CORS-readable response gives the real HTTP status (http_error on >= 400);
     *  - a no-cors fetch that REJECTS is a network failure: the page is unreachable (load_error).
     * A site without CORS answers the first with a TypeError and the second with an opaque
     * response — reachable, status unknown — and nothing is reported. Framing refusal
     * (X-Frame-Options / CSP frame-ancestors) is invisible to scripts: no API exposes it.
     */
    function probe(m) {
      var url = m.cfg.url;
      var f = win.fetch;
      if (typeof f !== 'function') return;
      var gone = function () { return s !== m; };
      try {
        f.call(win, url, { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' }).then(function (r) {
          if (gone()) return;
          if (r && r.status >= 400) fail('http_error', url, 'HTTP ' + r.status);
        }, function () {
          if (gone()) return;
          f.call(win, url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' }).then(function () { /* reachable */ }, function (e) {
            if (!gone()) fail('load_error', url, 'unreachable (' + ((e && e.message) || 'network error') + ')');
          });
        });
      } catch (e) { /* no fetch on this engine */ }
    }

    /*
     * The frame's document became readable from here, i.e. it is on the PLAYER's origin (a link or
     * redirect inside the site led there). With allow-scripts + allow-same-origin that page could
     * read the player's storage, device token included, so the frame is closed at once. Checked on
     * every load and on every tick.
     */
    function sameOriginBreach(m) {
      var href = null;
      try { href = String(m.iframe.contentWindow.location.href); } catch (e) { return false; }   // cross-origin: fine
      if (!href || href === 'about:blank') return false;
      try { m.iframe.src = 'about:blank'; } catch (e) { /* ignore */ }
      fail('load_error', m.cfg.url, 'the page navigated to the player\'s own origin — closed');
      return true;
    }

    function onFramedLoad(m) {
      if (s !== m) return;
      // about:blank (the frame's initial document, or our own teardown) is same-origin and readable;
      // the site itself is not. Only the site's loads count.
      if (sameOriginBreach(m)) return;
      try { if (String(m.iframe.contentWindow.location.href) === 'about:blank') return; } catch (e) { /* cross-origin: the site */ }
      m.loads++;
      if (m.loads === 1) {
        if (m.loadTimer) { clearT(m.loadTimer); m.loadTimer = null; }
        info('page loaded: ' + m.cfg.url);
        return;
      }
      // A later load is a navigation inside the frame. Its URL is not readable cross-origin, so it
      // counts as a page and (usually) as the visitor's doing — keepAlive, never a session start:
      // a page that refreshes itself must not hold the playlist.
      var fromHome = m.homeNav;
      m.homeNav = false;
      info('page loaded: (navigated inside the frame' + (fromHome ? ', home' : '') + ')');
      if (sessionActive()) m.pages++;
      activity(false);
      setHomeFramed(m, !fromHome);
    }

    function setHomeFramed(m, show) {
      if (!m.cfg.homeButton) return;
      if (!show) { if (m.home) m.home.style.display = 'none'; return; }
      if (!m.home) {
        var h = el('div', 'position:absolute;left:16px;bottom:16px;z-index:20;padding:10px 18px;border-radius:28px;' +
          'background:rgba(17,24,39,.75);color:#fff;font:18px sans-serif;cursor:pointer;user-select:none;touch-action:manipulation', HOME_LABEL);
        h.setAttribute('role', 'button');
        h.addEventListener('click', function () {
          if (s !== m) return;
          activity(true);
          info('home button — back to ' + m.cfg.url);
          m.homeNav = true;
          setHomeFramed(m, false);
          try { m.iframe.src = m.cfg.url; } catch (e) { /* ignore */ }
        });
        m.home = h;
        m.wrap.appendChild(h);
      }
      m.home.style.display = '';
      if (m.overlay) m.wrap.appendChild(m.overlay);   // the countdown stays on top of everything
    }

    // ── HOST (BrightSign top-level) ────────────────────────────────────────────────────────
    function consentFor(cfg, widgetId) {
      if (!cfg.keepConsent || !store) return [];
      var pats = L.keepPatterns(cfg), out = [];
      try {
        var all = JSON.parse(store.getItem(CONSENT_KEY) || '{}') || {};
        var mine = all[widgetId || '_'] || {};
        Object.keys(mine).forEach(function (h) {
          if (!L.isAllowed('https://' + h + '/', cfg.allowedDomains)) return;
          // Re-selected through the patterns here, so only consent cookies BY NAME can ever be restored.
          L.selectCookies(String(mine[h] || ''), pats).forEach(function (p) { out.push([h, p[0], p[1]]); });
        });
      } catch (e) { /* none */ }
      return out;
    }
    function saveConsent(m, hostName, cookies) {
      if (!m.cfg.keepConsent || !store || !hostName) return;
      if (!L.isAllowed('https://' + hostName + '/', m.cfg.allowedDomains)) return;
      var kept = L.selectCookies(String(cookies || ''), L.keepPatterns(m.cfg));
      try {
        var all = JSON.parse(store.getItem(CONSENT_KEY) || '{}') || {};
        var k = m.widgetId || '_';
        all[k] = all[k] || {};
        all[k][hostName] = kept.map(function (p) { return p[0] + '=' + p[1]; }).join('; ');
        store.setItem(CONSENT_KEY, JSON.stringify(all));
      } catch (e) { /* quota */ }
    }

    /*
     * kiosk-close can be lost (page->host messaging has been seen to drop on an XT245), and a lost
     * close leaves the site's widget over the player. So it is retried until the host answers
     * kiosk-closed for that session; the host also closes on its own when the keep-alive stops.
     */
    var closing = {};
    function closeHost(token, wipe) {
      closing[token] = 0;
      var attempt = function () {
        if (!(token in closing)) return;
        if (closing[token]++ >= 3) { delete closing[token]; warn('the host never confirmed closing the kiosk page (it closes itself when the keep-alive stops)'); return; }
        try { host.close(wipe, token); } catch (e) { /* host gone */ }
        setT(attempt, 2000);
      };
      attempt();
    }

    function hostFailed(m, why) {
      hostBroken = true;
      warn(why + ' — falling back to the framed mode for the rest of this run');
      closeHost(m.token, true);
      try { if (env.onHostBroken) env.onHostBroken(); } catch (e) { /* ignore */ }
      if (s === m) { m.mode = null; removeEl(m.wrap); m.wrap = null; mountFramed(m); }
    }

    function mountHost(m) {
      m.mode = 'host';
      var cfg = m.cfg;
      // A plain backdrop on the player's own stage: the kiosk widget paints above it.
      var wrap = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;background:#111827');
      wrap.setAttribute('data-st-kiosk', 'host');
      m.wrap = wrap;
      env.container().appendChild(wrap);
      var code = buildInjectSource(cfg, {
        session: m.token, evt: m.evt,
        patterns: L.keepPatterns(cfg), consent: consentFor(cfg, m.widgetId),
      });
      var opened = host.open({
        url: cfg.url,
        zoom: String((cfg.zoomPct || 100) / 100),
        inject: 'data:text/javascript;charset=utf-8;base64,' + b64(code),
        session: m.token,
      }, HOST_OPEN_TIMEOUT_MS);
      Promise.resolve(opened).then(function (ok) {
        if (s !== m || m.mode !== 'host') return;
        if (!ok) { hostFailed(m, 'the BrightSign host did not open the kiosk page'); return; }
        info('kiosk page opened top-level by the host (own storage, real wipe and allowlist)');
        // The host closes the kiosk widget by itself when this stops (player wedged, reloaded, or
        // its messages no longer arrive), so a dead player can never leave a site over the screen.
        var beat = function () {
          if (s !== m || m.mode !== 'host') return;
          try { if (host.keepAlive) host.keepAlive(m.token); } catch (e) { /* ignore */ }
          m.beat = setT(beat, 5000);
        };
        beat();
        // The injected page script must report in; a firmware that ignored javascript_injection would
        // show the site with no way to see a single touch — a session could never start.
        m.helloTimer = setT(function () {
          if (s === m && m.mode === 'host' && !m.hello) hostFailed(m, 'the kiosk page script never reported in (javascript_injection unsupported?)');
        }, HOST_HELLO_TIMEOUT_MS);
      });
    }

    function onHostMessage(d) {
      if (!d || typeof d.type !== 'string' || d.type.indexOf('kiosk-') !== 0) return;
      var m = s;
      if (!m || m.mode !== 'host' || d.session !== m.token) return;
      var t = d.type;
      if (t === 'kiosk-activity') {
        m.hello = true;
        if (d.home === '1') info('home button — back to ' + m.cfg.url);
        activity(d.touch === '1' || d.home === '1');
      } else if (t === 'kiosk-nav') {
        m.hello = true;
        if (m.helloTimer) { clearT(m.helloTimer); m.helloTimer = null; }
        var url = String(d.url || '');
        var h = L.hostOf(url);
        if (sessionActive() && d.reload !== '1' && url && url !== 'about:blank') m.pages++;
        if (h && L.isAllowed(url, m.cfg.allowedDomains)) info('page loaded: ' + url);
      } else if (t === 'kiosk-blocked') {
        warn('navigation blocked: ' + (d.what ? d.what + ' ' : '') + d.url);
        // An allowed page that keeps redirecting off-site would bounce forever: back to the start.
        var tn = now();
        m.blocks = m.blocks.filter(function (x) { return tn - x < 10000; });
        m.blocks.push(tn);
        if (m.blocks.length >= 3) { m.blocks = []; try { host.goto(m.cfg.url); } catch (e) { /* ignore */ } }
      } else if (t === 'kiosk-newwindow') {
        var nu = String(d.url || '');
        if (L.isAllowed(nu, m.cfg.allowedDomains)) { try { host.goto(nu); } catch (e) { /* ignore */ } }   // load in place
        else warn('navigation blocked: ' + nu);
      } else if (t === 'kiosk-error') {
        fail(d.reason === 'http_error' ? 'http_error' : 'load_error', d.url || m.cfg.url, String(d.detail || d.reason || 'error'));
      } else if (t === 'kiosk-consent') {
        saveConsent(m, String(d.host || ''), d.cookies);
      }
    }
    // kiosk-closed arrives after the mount is gone, so it is matched on its own.
    function onHostClosed(d) {
      if (!d || d.type !== 'kiosk-closed') return;
      var known = d.session && (d.session in closing);
      if (d.session) delete closing[d.session];
      if (known || !d.session) info(d.wiped === '1' ? 'web storage wiped' : 'kiosk page closed');
    }
    if (host && host.onMessage) {
      host.onMessage(function (d) {
        try { onHostMessage(d); onHostClosed(d); } catch (e) { /* never break playback */ }
      });
    }

    return {
      show: show, hide: hide, isShowing: isShowing, isShowingItem: isShowingItem, sessionActive: sessionActive,
      capability: capability, recoverOpenSession: recoverOpenSession,
      mode: function () { return s ? s.mode : null; },
      // test hooks
      _tick: tick, _activity: activity, _state: function () { return s; },
    };
  }

  return {
    create: create, SessionQueue: SessionQueue, ErrorHold: ErrorHold, buildInjectSource: buildInjectSource,
    kHostOf: kHostOf, kIsAllowed: kIsAllowed, kSelectCookies: kSelectCookies, kIsStartPage: kIsStartPage,
    kioskPageScript: kioskPageScript,
    CARD_TOO_OLD: CARD_TOO_OLD, HOME_LABEL: HOME_LABEL, BATCH: BATCH, QUEUE_CAP: QUEUE_CAP,
  };
});
