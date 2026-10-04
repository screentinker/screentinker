// Walk-up interactive web pages (#473): the pure rules, shared by every JS player.
//
// CONTRACT: the same behaviour as the Android player's KioskLogic.kt and the native player's
// logic/kiosk.py. All three are checked against shared/kiosk-vectors.json, so a rule changed in
// one place and not the others fails a test instead of drifting.
//
//   parse(widgetType, config)  -> null unless an interactive webpage widget with an http(s) URL
//   isAllowed(url, domains)    -> may the TOP-LEVEL page navigate here (subresources never filtered)
//   Idle(idleMs, warnMs)       -> the session clock: touch / keepAlive / tick, explicit timestamps
//   selectCookies(header, pats)-> the consent cookies a wipe may keep, BY NAME ONLY
//   ErrorThrottle(windowMs)    -> one dashboard incident per (reason, host) per window
//   isStartPage(url, start)    -> whether the Home button should show
//
// Dependency-free UMD: Node + browser/Tizen/BrightSign (window.KioskLogic). The browser global is
// set unconditionally, so a BrightSign widget with nodejs_enabled (where `module` also exists)
// still gets it.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KioskLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_IDLE_SEC = 60;
  var DEFAULT_WARN_SEC = 10;

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function intOr(v, d) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return isFinite(n) ? Math.trunc(n) : d;
  }
  function listOf(raw) {
    if (Array.isArray(raw)) return raw.map(function (x) { return typeof x === 'string' ? x : ''; });
    if (typeof raw === 'string') return raw.split(/[,\n ]/);
    return [];
  }

  var HOST_RE = /^(https?):\/\/([^\/?#:@]+)(:\d+)?(?:[\/?#]|$)/i;

  function hostOf(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    var m = HOST_RE.exec(url.trim());
    if (!m) return null;
    var h = m[2].toLowerCase().replace(/\.+$/, '');
    return h || null;
  }

  function normalizeDomain(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) { s = hostOf(s); if (!s) return null; }
    s = s.replace(/^\.+/, '').replace(/^\*+/, '').replace(/^\.+/, '').replace(/[.\/]+$/, '');
    if (!s || !/^[a-z0-9.-]+$/.test(s) || s.indexOf('.') < 0) return null;
    return s;
  }

  function isAllowed(url, allowed) {
    if (url == null) return false;
    if (url === 'about:blank') return true;
    var host = hostOf(url);
    if (!host) return false;
    for (var i = 0; i < (allowed || []).length; i++) {
      var d = allowed[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  /* Consent tools seen in the wild. Exact names, or a prefix ending in `*`. Same list as Kotlin. */
  var CONSENT_COOKIES = [
    'CookieConsent', 'CookieConsentBulkSetting-*',
    'OptanonConsent', 'OptanonAlertBoxClosed',
    'euconsent-v2', 'euconsent', 'addtl_consent', '__cmpcc*',
    'cookieyes-consent', 'CookieLawInfoConsent', 'cookielawinfo-checkbox-*', 'viewed_cookie_policy',
    'cmplz_*', 'complianz_*',
    'borlabs-cookie', 'BorlabsCookie',
    '_iub_cs-*',
    'didomi_token',
    'cookieconsent_status', 'cookieconsent_*',
    'moove_gdpr_popup', 'gdpr_consent*', 'cookie_consent*', 'cookie-consent*', 'cookies_accepted',
    'klaro', 'axeptio_cookies', 'axeptio_authorized_vendors', 'axeptio_all_vendors',
    'tarteaucitron', 'CONSENT', 'SOCS',
    'consentUUID', 'consentDate', '_cookie_consent*',
  ];

  function validPattern(p) { return typeof p === 'string' && /^[A-Za-z0-9_.-]+[*]?$/.test(p) && p !== '*'; }

  function cookieMatches(name, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      if (p.charAt(p.length - 1) === '*' ? name.indexOf(p.slice(0, -1)) === 0 : name === p) return true;
    }
    return false;
  }

  /** `a=1; b=2` -> [[name, value], ...] for the names the patterns keep. */
  function selectCookies(header, patterns) {
    if (typeof header !== 'string' || !header.trim() || !patterns || !patterns.length) return [];
    var out = [], seen = {};
    header.split(';').forEach(function (part) {
      var i = part.indexOf('=');
      if (i <= 0) return;
      var name = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
      if (!name || seen[name] || !cookieMatches(name, patterns)) return;
      seen[name] = true;
      out.push([name, value]);
    });
    return out;
  }

  /**
   * Null unless this is a webpage widget with `interactive: true` and a usable http(s) URL.
   * `config` is the widget_config as sent to players: a JSON string or an object.
   */
  function parse(widgetType, config) {
    if (widgetType !== 'webpage' || config == null) return null;
    var o = config;
    if (typeof o === 'string') { if (!o.trim()) return null; try { o = JSON.parse(o); } catch (e) { return null; } }
    if (!o || typeof o !== 'object' || o.interactive !== true) return null;
    var url = typeof o.url === 'string' ? o.url.trim() : '';
    var host = hostOf(url);
    if (!host) return null;
    var domains = [host];
    listOf(o.allowed_domains).forEach(function (d) {
      var n = normalizeDomain(d);
      if (n && domains.indexOf(n) < 0) domains.push(n);
    });
    var names = [];
    listOf(o.keep_cookie_names).forEach(function (n) {
      n = String(n).trim();
      if (validPattern(n) && names.indexOf(n) < 0 && names.length < 50) names.push(n);
    });
    var minWv = intOr(o.min_webview, 0);
    var zoom = intOr(o.zoom, 100);
    return {
      url: url,
      idleTimeoutSec: clamp(intOr(o.idle_timeout_sec, DEFAULT_IDLE_SEC), 15, 3600),
      warnSec: clamp(intOr(o.idle_warning_sec, DEFAULT_WARN_SEC), 0, 60),
      allowedDomains: domains,
      minWebView: minWv > 0 ? minWv : null,
      keepConsent: o.keep_consent === true,
      keepCookieNames: names,
      homeButton: o.home_button !== false,
      zoomPct: zoom <= 0 ? 100 : clamp(zoom, 25, 400),
    };
  }

  /** The cookie patterns a wipe may keep for this config ([] when keep_consent is off). */
  function keepPatterns(cfg) {
    if (!cfg || !cfg.keepConsent) return [];
    var out = CONSENT_COOKIES.slice();
    (cfg.keepCookieNames || []).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }

  function isStartPage(current, start) {
    function norm(u) { return String(u).split('#')[0].replace(/\/+$/, '').toLowerCase(); }
    return current == null || current === 'about:blank' || norm(current) === norm(start);
  }

  /** Chromium major from a user agent ("Chrome/83.0.4103.106" -> 83), or null. */
  function chromeMajor(ua) {
    var m = /Chrome\/(\d+)\./.exec(String(ua || ''));
    return m ? parseInt(m[1], 10) : null;
  }
  function tooOld(ua, min) {
    if (min == null) return false;
    var v = chromeMajor(ua);
    return v != null && v < min;
  }

  /*
   * The session clock. PASSIVE until the first touch; ACTIVE while touched or media plays; WARNING
   * during the "Still there?" countdown; RESET returns to PASSIVE. Media keeps a session alive but
   * never starts one. Actions: 'none' | 'started' | {warn: secondsLeft} | 'resumed' | 'reset'.
   */
  function Idle(idleMs, warnMs) {
    this.idleMs = idleMs; this.warnMs = warnMs;
    this.phase = 'passive'; this.lastActivity = 0;
  }
  Idle.prototype.inSession = function () { return this.phase !== 'passive'; };
  Idle.prototype.onTouch = function (now) {
    this.lastActivity = now;
    if (this.phase === 'passive') { this.phase = 'active'; return 'started'; }
    if (this.phase === 'warning') { this.phase = 'active'; return 'resumed'; }
    return 'none';
  };
  Idle.prototype.keepAlive = function (now) {
    if (this.phase === 'passive') return 'none';
    this.lastActivity = now;
    if (this.phase === 'warning') { this.phase = 'active'; return 'resumed'; }
    return 'none';
  };
  Idle.prototype.tick = function (now) {
    if (this.phase === 'passive') return 'none';
    var idle = now - this.lastActivity;
    if (idle >= this.idleMs + this.warnMs) { this.phase = 'passive'; return 'reset'; }
    if (idle >= this.idleMs) {
      this.phase = 'warning';
      return { warn: Math.max(1, Math.floor((this.idleMs + this.warnMs - idle + 999) / 1000)) };
    }
    return 'none';
  };
  Idle.prototype.end = function () { this.phase = 'passive'; };

  function ErrorThrottle(windowMs) { this.windowMs = windowMs == null ? 15 * 60000 : windowMs; this.last = {}; }
  ErrorThrottle.prototype.shouldReport = function (reason, url, now) {
    var key = reason + '|' + (hostOf(url) || '');
    var prev = this.last[key];
    if (prev != null && now - prev < this.windowMs) return false;
    this.last[key] = now;
    return true;
  };

  return {
    DEFAULT_IDLE_SEC: DEFAULT_IDLE_SEC, DEFAULT_WARN_SEC: DEFAULT_WARN_SEC,
    CONSENT_COOKIES: CONSENT_COOKIES,
    parse: parse, hostOf: hostOf, normalizeDomain: normalizeDomain, isAllowed: isAllowed,
    validPattern: validPattern, cookieMatches: cookieMatches, selectCookies: selectCookies, keepPatterns: keepPatterns,
    isStartPage: isStartPage, chromeMajor: chromeMajor, tooOld: tooOld,
    Idle: Idle, ErrorThrottle: ErrorThrottle,
  };
});
