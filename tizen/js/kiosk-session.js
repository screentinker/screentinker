/* Walk-up interactive web pages (#473) on the Tizen player — FRAMED, best effort.
 *
 * The reference is Android's kiosk/KioskSession.kt; the pure rules are window.KioskLogic
 * (js/kiosk-logic.js, a byte-identical copy of server/lib/kiosk-logic.js checked against
 * shared/kiosk-vectors.json). This file is the Tizen surface: one <iframe> with src = the widget's
 * start URL, owned by the player, mounted FRESH for every appearance of the item.
 *
 * ⚠️ WHY FRAMED AND NOT playback.web_interactive. A Tizen .wgt is itself a web page. The platform
 * has no controllable top-level browser for a web app: navigating the app document away unloads
 * this player, tizen.application launching the browser hands the visitor to an app we cannot
 * watch, time out or reset, and there is no <webview> element in the Tizen TV web API. That leaves
 * an iframe, and an iframe of another origin is opaque to us:
 *   - the navigation allowlist CANNOT be enforced: a cross-origin frame's location is unreadable
 *     and its navigations cannot be vetoed. (config.xml's <tizen:allow-navigation> is a static,
 *     package-wide list; narrowing it per widget is impossible and would break every other item.)
 *   - the wipe is PARTIAL: tizen.websetting.removeAllCookies() clears "all the cookies saved for
 *     the Web view in your Web application" — the app's single cookie jar, which is where a framed
 *     site's cookies live too — but no Tizen API clears the framed origin's localStorage,
 *     IndexedDB, cache or service workers, and the same-origin policy stops us doing it from here.
 *   - consent cookies cannot be kept BY NAME: a framed site's cookies are unreadable, and the only
 *     removal call is all-or-nothing. keep_consent is therefore unsupported here: every cookie is
 *     removed (the safe direction — keeping more would keep the visitor's login).
 * So capabilities.js declares playback.web_interactive_framed, never playback.web_interactive.
 *
 * ⚠️ ACTIVITY IN A CROSS-ORIGIN FRAME IS ONLY PARTLY VISIBLE, and a transparent capture layer that
 * eats touches is not acceptable (the page must get every touch). What we can see:
 *   - the FIRST tap into the frame: the frame takes focus, so this window blurs and
 *     document.activeElement becomes the iframe (both watched, the second by polling);
 *   - every main-frame navigation inside it: the iframe fires `load` (counts a page, keeps alive);
 *   - taps on our own Home button and "Still there?" overlay.
 * Further taps inside a page that never navigates are invisible. To see the next one, focus is
 * reclaimed after each navigation (the visitor's focused field is gone with the old page anyway).
 * Media playing inside the frame cannot be seen at all, so it does not keep a session alive here.
 * The consequence is benign: an engaged visitor on a single-page site may be asked "Still there?"
 * early, and one tap on the overlay resumes.
 */
(function (root) {
  'use strict';

  var K = root.KioskLogic;
  var LS_QUEUE = 'st_kiosk_sessions';
  var LS_OPEN = 'st_kiosk_open_session';
  var LS_DIRTY = 'st_kiosk_dirty';
  var HOME_LABEL = '⌂  Home';
  var CARD_TOO_OLD = 'This page needs a newer web browser than this screen has.';
  var LOAD_TIMEOUT_MS = 30000;
  var WIPE_TIMEOUT_MS = 5000;      // a removeAllCookies that never calls back must not wedge the screen
  var FOCUS_GRACE_MS = 1500;       // engines without navigator.userActivation: focus this soon after a load is not a tap

  /*
   * ⚠️ removeAllCookies() IS ASYNCHRONOUS. Nothing may load a page — the next visitor's, or the same
   * start URL again on a one-item playlist — until it has called back: the first request would carry
   * the previous visitor's cookie, and a Set-Cookie in the reply could put their login straight back.
   * One wipe at a time, shared by every session and by the boot-time recovery; whenWiped() queues work
   * behind it. A wipe that never answers gives up after WIPE_TIMEOUT_MS (logged, dirty flag left set
   * so the next start tries again) rather than leave the panel dark.
   */
  var wipeState = { busy: false, waiters: [] };
  function whenWiped(fn) { if (wipeState.busy) wipeState.waiters.push(fn); else fn(); }
  var UNKNOWN_PAGE = 'about:unknown-framed-page';   // a page we know we left the start page for

  /* Samsung's published TV web engine table (developer.samsung.com/smarttv/develop/specifications/
   * web-engine-specifications.html). Tizen's UA has no "Chrome/NN" token on older firmware, so the
   * shared chromeMajor() alone would read every such panel as "unknown" and never show the card. */
  var TIZEN_CHROMIUM = { '3.0': 47, '4.0': 56, '5.0': 63, '5.5': 69, '6.0': 76, '6.5': 85, '7.0': 94, '8.0': 108, '9.0': 120, '10.0': 130 };
  function engineMajor(ua) {
    var c = K ? K.chromeMajor(ua) : null;
    if (c != null) return c;
    var m = /Tizen (\d+\.\d+)/.exec(String(ua || ''));
    if (!m) return null;
    if (TIZEN_CHROMIUM[m[1]]) return TIZEN_CHROMIUM[m[1]];
    return parseFloat(m[1]) < 3 ? 0 : null;           // 2.x is WebKit: older than any Chromium floor
  }

  function uuid() {
    try { if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function safeStorage(s) {
    return {
      get: function (k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { if (s) s.setItem(k, v); } catch (e) {} },
      del: function (k) { try { if (s) s.removeItem(k); } catch (e) {} }
    };
  }

  /* ---------------- usage records: the persisted queue (same rules as KioskSessionLog.kt) -------- */
  function SessionQueue(cap) { this.cap = cap || SessionQueue.MAX; this.items = []; }
  SessionQueue.MAX = 500;
  SessionQueue.BATCH = 50;
  SessionQueue.prototype.size = function () { return this.items.length; };
  SessionQueue.prototype.add = function (r) {
    if (!r || typeof r.id !== 'string' || !r.id) return;
    for (var i = 0; i < this.items.length; i++) if (this.items[i].id === r.id) return;   // dedupe by id
    this.items.push(r);
    while (this.items.length > this.cap) this.items.shift();                             // drop oldest
  };
  SessionQueue.prototype.peek = function (n) { return this.items.slice(0, n || SessionQueue.BATCH); };
  SessionQueue.prototype.ack = function (ids) {
    if (!ids || !ids.length) return;
    var set = {};
    for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
    this.items = this.items.filter(function (r) { return !set[r.id]; });
  };
  SessionQueue.prototype.serialize = function () { try { return JSON.stringify(this.items); } catch (e) { return '[]'; } };
  SessionQueue.prototype.restore = function (text) {
    this.items = [];
    if (!text) return;
    try {
      var a = JSON.parse(text);
      if (!Array.isArray(a)) return;
      for (var i = 0; i < a.length; i++) if (a[i] && typeof a[i] === 'object') this.add(a[i]);
    } catch (e) { this.items = []; }                  // unreadable: start empty rather than wedge the boot
  };

  /*
   * The socket side: usage batches with ack, and web_error incidents held while offline.
   * opts: { storage, getSocket(), getDeviceId(), canSend(), setTimeout, clearTimeout, log(level,msg) }
   */
  function KioskOutbox(opts) {
    this.o = opts;
    this.store = safeStorage(opts.storage);
    this.queue = new SessionQueue();
    this.queue.restore(this.store.get(LS_QUEUE));
    this.inFlight = false;
    this._retry = null;
    this.pendingErrors = [];
  }
  KioskOutbox.prototype._st = function () { return this.o.setTimeout || root.setTimeout; };
  KioskOutbox.prototype._ct = function () { return this.o.clearTimeout || root.clearTimeout; };
  KioskOutbox.prototype.persist = function () { this.store.set(LS_QUEUE, this.queue.serialize()); };
  KioskOutbox.prototype.addSession = function (r) { this.queue.add(r); this.persist(); this.flush(); };
  KioskOutbox.prototype.flush = function () {
    if (this.inFlight || !this.o.canSend()) return;
    var batch = this.queue.peek(SessionQueue.BATCH);
    if (!batch.length) return;
    var s = this.o.getSocket();
    if (!s) return;
    this.inFlight = true;
    try { s.emit('device:kiosk-sessions', { device_id: this.o.getDeviceId(), sessions: batch }); }
    catch (e) { this.inFlight = false; return; }
    var self = this;
    // No ack in 30 s (old server, dropped packet): allow a retry. Records stay queued until named.
    if (this._retry) this._ct()(this._retry);
    this._retry = this._st()(function () { self._retry = null; self.inFlight = false; }, 30000);
  };
  KioskOutbox.prototype.onAck = function (data) {
    var ids = (data && Array.isArray(data.ids)) ? data.ids.filter(function (x) { return typeof x === 'string'; }) : [];
    this.queue.ack(ids);
    this.persist();
    this.inFlight = false;
    if (this._retry) { this._ct()(this._retry); this._retry = null; }
    if (ids.length && this.queue.size()) this.flush();
  };
  KioskOutbox.prototype.onRegistered = function () {
    this.inFlight = false;
    if (this._retry) { this._ct()(this._retry); this._retry = null; }
    this.flush();
    var list = this.pendingErrors; this.pendingErrors = [];
    for (var i = 0; i < list.length; i++) this._emitError(list[i][0], list[i][1]);
  };
  KioskOutbox.prototype._emitError = function (reason, detail) {
    var s = this.o.getSocket();
    try { s.emit('device:event', { device_id: this.o.getDeviceId(), type: 'web_error', reason: reason, detail: detail }); } catch (e) {}
  };
  /** Already throttled by the session (ErrorThrottle, 15 min per reason+host). */
  KioskOutbox.prototype.reportError = function (reason, detail) {
    var d = String(detail == null ? '' : detail).slice(0, 400);
    if (this.o.canSend() && this.o.getSocket()) { this._emitError(reason, d); return; }
    this.pendingErrors.push([reason, (d + ' (while offline)').slice(0, 400)]);
    while (this.pendingErrors.length > 10) this.pendingErrors.shift();
  };

  /* ---------------- the session ----------------
   * opts: { container, document, window, storage, now(), setTimeout, clearTimeout, setInterval,
   *         clearInterval, log(level,msg), onHold, onRelease, onSkip, onError(reason,detail),
   *         onSessionEnd(record), websetting() -> tizen.websetting|null, fetch, userAgent(),
   *         userActivation() -> navigator.userActivation|null }
   */
  function KioskSession(opts) {
    this.o = opts || {};
    this.doc = this.o.document || root.document;
    this.win = this.o.window || root;
    this.store = safeStorage(this.o.storage !== undefined ? this.o.storage : root.localStorage);
    this.errors = new K.ErrorThrottle();
    this._reset();
  }
  KioskSession.CARD_TOO_OLD = CARD_TOO_OLD;
  KioskSession.engineMajor = engineMajor;

  KioskSession.prototype._reset = function () {
    this.wrap = null; this.frame = null; this.home = null; this.overlay = null; this.card = null;
    this.cfg = null; this.idle = null; this.key = null; this.widgetId = null;
    this.touchedThisMount = false; this.failing = false;
    this.sessionId = null; this.sessionStartMs = 0; this.pages = 0; this.lastPersistMs = 0;
    this.loads = 0; this.lastLoadAt = 0; this.current = null; this.focusInside = false;
    this.waitingForWipe = false; this._loggedScriptFocus = false;
    this.tickTimer = null; this.loadTimer = null; this.mountSeq = (this.mountSeq || 0) + 1;
  };
  KioskSession.prototype._now = function () { return this.o.now ? this.o.now() : Date.now(); };
  KioskSession.prototype._st = function (f, ms) { return (this.o.setTimeout || root.setTimeout)(f, ms); };
  KioskSession.prototype._ct = function (t) { if (t) (this.o.clearTimeout || root.clearTimeout)(t); };
  KioskSession.prototype._si = function (f, ms) { return (this.o.setInterval || root.setInterval)(f, ms); };
  KioskSession.prototype._ci = function (t) { if (t) (this.o.clearInterval || root.clearInterval)(t); };
  KioskSession.prototype._log = function (level, msg) {
    try { if (this.o.log) this.o.log(level, msg); else if (root.console) root.console.log('[Kiosk] ' + msg); } catch (e) {}
  };

  /** True while a visitor is using the page. Read by the capture/remote paths (privacy). */
  KioskSession.prototype.sessionActive = function () { return !!(this.idle && this.idle.inSession()); };
  KioskSession.prototype.isShowing = function () { return !!(this.frame || this.card); };
  KioskSession.prototype.isShowingItem = function (key) { return this.isShowing() && this.key === key; };

  KioskSession.prototype.show = function (key, cfg, widgetId) {
    if (this.isShowingItem(key)) return;          // same item re-issued (playlist refresh): keep the visitor's page
    this.hide();                                  // wipes only if a visitor used the previous page
    this.key = key; this.cfg = cfg; this.widgetId = widgetId || null;
    this.idle = new K.Idle(cfg.idleTimeoutSec * 1000, cfg.warnSec * 1000);
    var ua = this.o.userAgent ? this.o.userAgent() : (root.navigator && root.navigator.userAgent);
    var v = engineMajor(ua);
    if (cfg.minWebView != null && v != null && v < cfg.minWebView) {
      this._log('warn', 'web engine too old for ' + cfg.url + ' (Chromium ' + v + ', need ' + cfg.minWebView + ') — showing card');
      this._report('webview_too_old', cfg.url, 'Chromium ' + v + ', page needs ' + cfg.minWebView);
      this._showCard(CARD_TOO_OLD);
      return;
    }
    // Never load a page while a wipe is still running (see wipeState). The placeholder makes
    // isShowingItem(key) true meanwhile, so a re-render does not queue a second mount.
    var self = this, seq = this.mountSeq;
    if (wipeState.busy) {
      this._showCard('');
      this.card.style.background = '#000';
      this.waitingForWipe = true;
    }
    whenWiped(function () {
      if (self.mountSeq !== seq) return;          // replaced or hidden while we waited
      if (self.waitingForWipe) { self._remove(self.card); self.card = null; self.waitingForWipe = false; }
      self._mount(cfg);
    });
  };

  KioskSession.prototype._mount = function (cfg) {
    var self = this, doc = this.doc, seq = this.mountSeq;
    var wrap = doc.createElement('div');
    wrap.className = 'kiosk-wrap';
    wrap.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;background:#fff;z-index:1';
    var f = doc.createElement('iframe');
    f.setAttribute('frameborder', '0');
    /* No allow-top-navigation (a frame-busting site would otherwise unload the player), no
     * allow-popups (window.open / target=_blank are blocked — "load in place or block"), no
     * allow-downloads (honoured from Chromium 83, i.e. Tizen 7+). allow-same-origin keeps the
     * SITE's own origin so its cookies, logins and baskets work; it grants nothing over this app. */
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    f.setAttribute('allow', 'autoplay; encrypted-media');
    f.style.cssText = KioskSession.zoomCss(cfg.zoomPct);
    f.addEventListener('load', function () { if (self.mountSeq === seq) self._onLoad(); });
    wrap.appendChild(f);
    this.wrap = wrap; this.frame = f; this.current = cfg.url;
    f.src = cfg.url;
    this.o.container.appendChild(wrap);
    this._log('info', 'interactive page: ' + cfg.url + ' (idle ' + cfg.idleTimeoutSec + 's, domains [' + cfg.allowedDomains.join(', ') +
      '], zoom ' + cfg.zoomPct + '%, framed — allowlist and storage wipe are best effort on Tizen)');
    if (cfg.keepConsent) this._log('warn', 'keep consent cookies is unsupported on Tizen (a framed site\'s cookies cannot be read by name) — every cookie is removed at reset');

    // The activation state is read IN the blur handler: that is the moment focus moved, and a tap's
    // transient activation is live then (see _gesture).
    this._onBlur = function () {
      var g = self._gesture();
      self._st(function () { if (self.mountSeq === seq) self._pollFocus(g); }, 0);
    };
    try { this.win.addEventListener('blur', this._onBlur); } catch (e) {}
    this.tickTimer = this._si(function () { self._tick(); }, 500);
    this.loadTimer = this._st(function () {
      if (self.mountSeq === seq && self.loads === 0) self._fail('load_error', cfg.url, 'load error: no response in ' + (LOAD_TIMEOUT_MS / 1000) + 's');
    }, LOAD_TIMEOUT_MS);

    // A cross-origin frame fires `load` for its own error page too, so a dead link would look
    // healthy. A no-cors probe rejects ONLY on a network failure (DNS, TLS, refused) and resolves
    // opaquely for any HTTP status — so it can name load_error, never http_error.
    // (Not navigator.onLine: it reads false on a box with only a LAN/loopback route, which would skip a
    // page that loads fine. A real outage rejects the probe below anyway.)
    var fetchFn = this.o.fetch !== undefined ? this.o.fetch : (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (fetchFn) {
      try {
        fetchFn(cfg.url, { mode: 'no-cors', credentials: 'omit', redirect: 'follow' }).then(function () {}, function (e) {
          if (self.mountSeq === seq) self._fail('load_error', cfg.url, 'load error: ' + ((e && e.message) || 'network'));
        });
      } catch (e) {}
    }
  };

  /** The server's passive render (routes/widgets.js renderWebpage): lay out at 100/zoom %, scale back. */
  KioskSession.zoomCss = function (zoomPct) {
    var z = (zoomPct || 100) / 100;
    var inv = 100 / (zoomPct || 100) * 100;
    return 'position:absolute;top:0;left:0;border:0;width:' + inv + '%;height:' + inv + '%;' +
      'transform:scale(' + z + ');-webkit-transform:scale(' + z + ');transform-origin:0 0;-webkit-transform-origin:0 0';
  };

  KioskSession.prototype._readHref = function () {
    try { var h = this.frame.contentWindow.location.href; return typeof h === 'string' ? h : null; } catch (e) { return null; }
  };

  KioskSession.prototype._onLoad = function () {
    var cfg = this.cfg; if (!cfg) return;
    this.loads++;
    this.lastLoadAt = this._now();
    if (this.loadTimer) { this._ct(this.loadTimer); this.loadTimer = null; }
    var href = this._readHref();                  // readable only when the page is same-origin with us
    if (href && href !== 'about:blank' && !K.isAllowed(href, cfg.allowedDomains)) {
      // The one case the allowlist CAN be applied: a page we are able to read.
      this._log('warn', 'navigation blocked: ' + href);
      try { this.frame.src = cfg.url; } catch (e) {}
      this.current = cfg.url;
      return;
    }
    if (this.loads === 1) this.current = cfg.url;
    else {
      this.current = href || (this._homePending ? cfg.url : UNKNOWN_PAGE);
      if (this.sessionActive() && !this._homePending) this.pages++;
      this._activity(false);                      // a navigation is use: keeps alive, never starts a session
    }
    this._homePending = false;
    this._log('info', 'page loaded: ' + (href || (this.loads === 1 ? cfg.url : '(cross-origin page)')));
    this._injectCss();
    this._reclaimFocus();
    this._updateHome();
  };

  /* Android's INJECT, when the page is readable (same-origin). A cross-origin page cannot be
   * styled from here, so its text selection / long-press menu stay as the site set them. */
  KioskSession.prototype._injectCss = function () {
    try {
      var d = this.frame.contentDocument;
      if (!d) return;
      var s = d.createElement('style');
      s.textContent = '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
      (d.head || d.documentElement).appendChild(s);
    } catch (e) {}
  };

  KioskSession.prototype._reclaimFocus = function () {
    try {
      if (this.doc.activeElement === this.frame) { this.frame.blur(); if (this.win.focus) this.win.focus(); }
    } catch (e) {}
    this.focusInside = false;
  };

  /*
   * Was the focus that just moved into the frame a VISITOR'S tap? A page can take focus by script
   * (a search box focus(), a chat widget) — that is not a person, and must not start a session (fake
   * usage record, held playlist, blank screenshots on every appearance).
   *   - navigator.userActivation (Chromium 72+, i.e. Tizen 6.0+): a tap inside a cross-origin frame
   *     activates its ancestors too (User Activation v2), so the parent's isActive is true for a real
   *     tap and false for a scripted focus(). Measured in Chromium: scripted focus -> blur with
   *     isActive false; tap -> isActive true. (Cross-origin `autofocus` is blocked by Chromium anyway.)
   *   - older engines (Tizen 3.0-5.5): no such signal; focus arriving within FOCUS_GRACE_MS of a frame
   *     load is treated as the page's own. A page that focuses itself LATER still starts a session
   *     there — a known limit of those engines.
   * Rejected focus is handed back to the player so the visitor's real first tap is still seen.
   */
  KioskSession.prototype._gesture = function () {
    var ua = this.o.userActivation ? this.o.userActivation() : (root.navigator && root.navigator.userActivation);
    if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
    return !(this.lastLoadAt && this._now() - this.lastLoadAt < FOCUS_GRACE_MS);
  };

  KioskSession.prototype._pollFocus = function (gesture) {
    if (!this.frame) return;
    var inside = false;
    try { inside = this.doc.activeElement === this.frame; } catch (e) {}
    if (inside && !this.focusInside) {
      var g = (typeof gesture === 'boolean') ? gesture : this._gesture();
      if (!g) {
        if (!this._loggedScriptFocus) { this._loggedScriptFocus = true; this._log('info', 'page took focus without a tap — not a session'); }
        this._reclaimFocus();
        return;
      }
      this.focusInside = true; this._activity(true);
    }
    else if (!inside) this.focusInside = false;
  };

  KioskSession.prototype._tick = function () {
    if (!this.idle) return;
    this._pollFocus();
    if (!this.idle) return;
    this._apply(this.idle.tick(this._now()));
  };

  KioskSession.prototype._activity = function (touch) {
    var k = this.idle; if (!k) return;
    var now = this._now();
    this._apply(touch ? k.onTouch(now) : k.keepAlive(now));
    if (this.sessionId && now - this.lastPersistMs >= 10000) { this.lastPersistMs = now; this._saveOpen(); }
  };
  /** A tap the player saw directly (Home, overlay). */
  KioskSession.prototype.touch = function () { this._activity(true); };

  KioskSession.prototype._record = function (reason) {
    var start = this.sessionStartMs;
    var last = Math.max((this.idle && this.idle.lastActivity) || start, start);
    return {
      id: this.sessionId, widget_id: this.widgetId,
      started_at: Math.floor(start / 1000),
      duration_sec: Math.max(1, Math.floor((last - start) / 1000)),
      end_reason: reason, pages: Math.max(1, this.pages)
    };
  };
  KioskSession.prototype._saveOpen = function () {
    if (!this.sessionId) return;
    try { this.store.set(LS_OPEN, JSON.stringify(this._record('interrupted'))); } catch (e) {}
  };

  KioskSession.prototype._apply = function (a) {
    if (a === 'started') {
      this.touchedThisMount = true;
      // wipe_site_data off: nothing will be wiped, so a power cut must not wipe at the next start either.
      if (!this.cfg || this.cfg.wipeSiteData !== false) this.store.set(LS_DIRTY, '1');
      this.sessionId = uuid();
      this.sessionStartMs = this._now();
      this.pages = 1;
      this.lastPersistMs = this.sessionStartMs;
      this._saveOpen();
      this._log('info', 'session started — playlist held');
      try { if (this.o.onHold) this.o.onHold(); } catch (e) {}
    } else if (a && typeof a === 'object' && a.warn != null) {
      if (!this.overlay) this._log('info', 'idle — "Still there?" countdown ' + a.warn + 's');
      this._showOverlay(a.warn);
    } else if (a === 'resumed') {
      this._remove(this.overlay); this.overlay = null;
    } else if (a === 'reset') {
      this._log('info', 'session idle — wiping and moving on');
      var o = this.o;
      this.hide(true, 'idle', function () { try { if (o.onRelease) o.onRelease(); } catch (e) {} });
    }
  };

  KioskSession.prototype._showOverlay = function (secondsLeft) {
    var self = this;
    if (!this.overlay) {
      var o = this.doc.createElement('div');
      o.className = 'kiosk-still-there';
      o.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:4;display:flex;align-items:center;' +
        'justify-content:center;text-align:center;white-space:pre-line;background:rgba(0,0,0,0.78);color:#fff;' +
        'font:600 40px/1.4 sans-serif;padding:0 8%;box-sizing:border-box';
      var tap = function (e) { try { if (e && e.preventDefault) e.preventDefault(); } catch (x) {} self.touch(); };
      o.addEventListener('click', tap);
      o.addEventListener('touchstart', tap);
      o.addEventListener('mousedown', tap);
      (this.wrap || this.o.container).appendChild(o);
      this.overlay = o;
    }
    this.overlay.textContent = 'Still there?\nTap to keep browsing — resetting in ' + secondsLeft + 's';
  };

  KioskSession.prototype._updateHome = function () {
    var cfg = this.cfg; if (!cfg || !cfg.homeButton || !this.wrap) return;
    var show = !!this.frame && !K.isStartPage(this.current, cfg.url);
    if (!show) { if (this.home) this.home.style.display = 'none'; return; }
    if (!this.home) {
      var self = this;
      var h = this.doc.createElement('div');
      h.className = 'kiosk-home';
      h.textContent = HOME_LABEL;
      h.style.cssText = 'position:absolute;left:24px;bottom:24px;z-index:3;padding:14px 26px;border-radius:40px;' +
        'background:rgba(17,24,39,0.75);color:#fff;font:600 26px/1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.35);cursor:pointer';
      h.addEventListener('click', function () {
        if (!self.cfg) return;
        self.touch();
        self._log('info', 'home button — back to ' + self.cfg.url);
        self._homePending = true;
        try { self.frame.src = self.cfg.url; } catch (e) {}
        self.current = self.cfg.url;
        self._updateHome();
      });
      this.wrap.appendChild(h);
      this.home = h;
    }
    this.home.style.display = '';
  };

  KioskSession.prototype._showCard = function (text) {
    var c = this.doc.createElement('div');
    c.className = 'kiosk-card';
    c.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'text-align:center;background:#111827;color:#fff;font:600 36px/1.4 sans-serif;padding:0 8%;box-sizing:border-box';
    c.textContent = text;
    this.o.container.appendChild(c);
    this.card = c;
  };

  KioskSession.prototype._report = function (reason, url, detail) {
    if (!this.errors.shouldReport(reason, url, this._now())) return;
    var where = K.hostOf(url) || url || '';
    try { if (this.o.onError) this.o.onError(reason, ((where ? where + ': ' : '') + detail).slice(0, 400)); } catch (e) {}
  };

  /** The page failed. Nobody using it: skip it. Someone using it: end their session. */
  KioskSession.prototype._fail = function (reason, url, why) {
    if (this.failing) return;
    this.failing = true;
    var key = this.key, self = this;
    this._log('warn', 'interactive page unavailable (' + why + ')');
    this._report(reason, url, why);
    this._st(function () {
      if (self.key !== key) return;               // already replaced by another item
      var wasSession = self.sessionActive(), o = self.o;
      self.hide(self.touchedThisMount, 'error', function () {
        try { if (wasSession) { if (o.onRelease) o.onRelease(); } else if (o.onSkip) o.onSkip(); } catch (e) {}
      });
    }, 0);
  };

  KioskSession.prototype._finishSession = function (reason) {
    if (!this.sessionId) return;
    var r = this._record(reason);
    this.sessionId = null; this.sessionStartMs = 0;
    this.store.del(LS_OPEN);
    this._log('info', 'session ended (' + reason + ') after ' + r.duration_sec + 's, ' + r.pages + ' page(s)');
    try { if (this.o.onSessionEnd) this.o.onSessionEnd(r); } catch (e) {}
  };

  KioskSession.prototype._remove = function (el) {
    try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
  };

  /** Leave the item. Wipes when a visitor used it, so the next one never sees their session. */
  KioskSession.prototype.hide = function (wipe, reason, afterWipe) {
    if (wipe === undefined || wipe === null) wipe = this.touchedThisMount;
    this._ci(this.tickTimer); this._ct(this.loadTimer);
    try { if (this._onBlur) this.win.removeEventListener('blur', this._onBlur); } catch (e) {}
    this._onBlur = null;
    this._finishSession(reason || 'interrupted');
    if (this.frame) { try { this.frame.src = 'about:blank'; } catch (e) {} }
    this._remove(this.overlay); this._remove(this.home); this._remove(this.card); this._remove(this.wrap);
    var cfg = this.cfg;
    if (this.idle) this.idle.end();
    this._reset();
    if (wipe) this.wipe(cfg);
    // The release/skip that follows a session runs only once its cookies are gone (wipeState).
    if (afterWipe) whenWiped(afterWipe);
  };

  /*
   * What Tizen lets a web app wipe: the app's whole cookie jar, which is where a framed site's
   * cookies are kept. Not reachable: the framed origin's localStorage, IndexedDB, cache, service
   * workers, HTTP auth, form data — no Tizen API, and the same-origin policy forbids it from here.
   * keep_consent cannot be honoured by name (see the header) so nothing is kept.
   */
  KioskSession.prototype.wipe = function (cfg) {
    var store = this.store;
    if (cfg && cfg.wipeSiteData === false) { this._log('info', 'session reset (cookies kept: wipe_site_data off)'); return; }
    KioskSession.wipeCookies(this.o.websetting ? this.o.websetting() : null, this._log.bind(this), cfg && cfg.keepConsent,
      function (ok) { if (ok) store.set(LS_DIRTY, '0'); },      // dirty stays set on failure: the next start retries
      this.o.setTimeout, this.o.clearTimeout);
  };
  /** done(ok) runs exactly once: on the platform's callback, on an error, or after WIPE_TIMEOUT_MS. */
  KioskSession.wipeCookies = function (ws, log, keepConsent, done, setT, clearT) {
    var say = function (l, m) { try { log(l, m); } catch (e) {} };
    var st = setT || root.setTimeout, ct = clearT || root.clearTimeout;
    wipeState.busy = true;
    var finished = false, timer = null;
    var finish = function (ok) {
      if (finished) return; finished = true;
      if (timer) ct(timer);
      try { if (done) done(ok); } catch (e) {}
      wipeState.busy = false;
      var w = wipeState.waiters; wipeState.waiters = [];
      for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
    };
    if (!(ws && typeof ws.removeAllCookies === 'function')) {
      say('warn', 'cookie wipe unavailable (no tizen.websetting) — nothing could be wiped');
      finish(false); return;
    }
    timer = st(function () { timer = null; say('warn', 'cookie wipe did not answer in ' + (WIPE_TIMEOUT_MS / 1000) + 's — moving on, will retry at next start'); finish(false); }, WIPE_TIMEOUT_MS);
    try {
      ws.removeAllCookies(function () {
        say('info', 'web storage wiped (cookies; the framed site\'s local storage and cache cannot be cleared on Tizen)');
        if (keepConsent) say('info', 'kept 0 consent cookie(s): [] (unsupported on Tizen)');
        finish(true);
      }, function (e) { say('warn', 'cookie wipe failed: ' + ((e && (e.message || e.name)) || e)); finish(false); });
    } catch (e) { say('warn', 'cookie wipe failed: ' + ((e && e.message) || e)); finish(false); }
  };
  KioskSession.whenWiped = whenWiped;
  KioskSession.wipeBusy = function () { return wipeState.busy; };

  /** App start: a session cut off by a crash/power cut counts (interrupted) and is wiped. */
  KioskSession.recover = function (storage, outbox, ws, log) {
    var st = safeStorage(storage);
    try {
      var raw = st.get(LS_OPEN);
      if (raw) { var r = JSON.parse(raw); if (r && r.id && outbox) { r.end_reason = 'interrupted'; outbox.addSession(r); } }
    } catch (e) {}
    st.del(LS_OPEN);
    if (st.get(LS_DIRTY) === '1') {
      try { log('info', 'previous interactive session was not ended — wiping'); } catch (e) {}
      KioskSession.wipeCookies(ws, log, false, function (ok) { if (ok) st.set(LS_DIRTY, '0'); });
    }
  };

  root.KioskSession = KioskSession;
  root.KioskOutbox = KioskOutbox;
  root.KioskSessionQueue = SessionQueue;
})(typeof self !== 'undefined' ? self : this);
