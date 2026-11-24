// Live remote debug log (`set_debug`) for the Tizen player.
//
// The dashboard's per-device "Debug logging" checkbox sends set_debug and opens a live panel. The
// Android and web players stream their log there; Tizen never implemented the command, so it fell
// through to STDeviceControl and was answered "unknown command", and the panel stayed empty. On a
// Samsung panel there is no console and no remote inspector in the field, so this panel is the only
// way to see what the player is doing.
//
// Same behaviour as the web player (server/player/index.html, "Live remote debug"):
//   - install() runs first in <head>, before every other script, and keeps the last 200 lines in a
//     ring buffer: console.log/warn/error, uncaught errors with file:line, unhandled rejections;
//   - turning the stream on sends a platform line, then REPLAYS that buffer (each line carrying its
//     real age), so the operator sees the failure that happened before they opened the screen;
//   - live lines are capped at 40 a second; over the cap they are counted, not queued;
//   - the stream turns itself off after 30 minutes (a closed laptop never sends "off");
//   - a "[tag] message" console line puts the tag in the panel's tag column.
//
// ES5, dependency-free UMD: Node (tests) + Tizen (window.STDebugLog). Must never be the reason the
// player does not boot, so everything that touches the page is wrapped. On the page it installs
// itself as it loads (tizen/index.html loads it first in <head>); under Node it waits to be called.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) { try { api.install(root); } catch (e) { /* boot anyway */ } }
  if (root) root.STDebugLog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_LOG = 200;
  var MAX_LINES_PER_SEC = 40;
  var AUTO_OFF_MS = 30 * 60 * 1000;
  var TAG_RE = /^\s*\[([a-zA-Z0-9\/_.-]{1,24})\]\s*/;

  function nowMs() { try { return Date.now(); } catch (e) { return new Date().getTime(); } }

  // ---- the ring buffer (fed from boot) ----
  var buffer = [];
  var subs = [];
  var notifying = false;

  function push(entry) {
    try {
      entry.t = nowMs();
      buffer.push(entry);
      if (buffer.length > MAX_LOG) buffer.splice(0, buffer.length - MAX_LOG);
    } catch (e) { /* the safety net must not crash */ }
    // push runs inside the console wrapper, so a subscriber that logs would recurse forever.
    if (notifying) return;
    notifying = true;
    try {
      for (var i = 0; i < subs.length; i++) { try { subs[i](entry); } catch (e) { /* next */ } }
    } finally { notifying = false; }
  }

  function stringify(args) {
    var msg = '';
    for (var j = 0; j < args.length; j++) {
      var part;
      try { part = typeof args[j] === 'string' ? args[j] : JSON.stringify(args[j]); } catch (e) { part = String(args[j]); }
      if (part === undefined) part = String(args[j]);
      msg += (j > 0 ? ' ' : '') + part;
    }
    if (msg.length > 1000) msg = msg.slice(0, 1000) + '...[trunc]';
    return msg;
  }

  var installed = false;
  function install(win) {
    if (installed || !win) return;
    installed = true;
    try {
      push({ type: 'init', message: 'page ' + ((win.location && win.location.href) || '?') +
        ' - screen ' + ((win.screen && win.screen.width) || '?') + 'x' + ((win.screen && win.screen.height) || '?') +
        ' - ' + ((win.navigator && win.navigator.userAgent) || '') });
    } catch (e) {}
    try {
      win.addEventListener('error', function (ev) {
        try {
          var src = ev.filename || (ev.target && ev.target.src) || '';
          var msg = ev.message || (ev.error && String(ev.error)) || 'error';
          if (src) msg += ' @' + src + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0);
          var stack = ev.error && ev.error.stack;
          if (stack) msg += ' | ' + String(stack).replace(/\s+/g, ' ').slice(0, 400);
          push({ type: 'error', message: msg });
        } catch (e) {}
      }, true);
      win.addEventListener('unhandledrejection', function (ev) {
        try {
          var r = ev.reason;
          var msg = (r && r.message) || String(r || 'rejection');
          if (r && r.stack) msg += ' | ' + String(r.stack).replace(/\s+/g, ' ').slice(0, 400);
          push({ type: 'rejection', message: msg });
        } catch (e) {}
      });
    } catch (e) {}
    var con = win.console;
    if (!con) return;
    var methods = ['log', 'warn', 'error'];
    for (var i = 0; i < methods.length; i++) {
      (function (m) {
        var orig = con[m];
        con[m] = function () {
          try { push({ type: 'console.' + m, message: stringify(Array.prototype.slice.call(arguments)) }); } catch (e) {}
          try { if (orig) return orig.apply(con, arguments); } catch (e) {}
        };
      })(methods[i]);
    }
  }

  // ---- mapping a buffered entry to a panel line ----
  function tagFor(entry) {
    var m = TAG_RE.exec(entry.message || '');
    if (m) return m[1];
    if (entry.type === 'error' || entry.type === 'rejection') return 'error';
    if (entry.type === 'init') return 'init';
    return 'player';
  }
  function levelFor(entry) {
    if (entry.type === 'console.error' || entry.type === 'error' || entry.type === 'rejection') return 'e';
    if (entry.type === 'console.warn') return 'w';
    return 'i';
  }
  function messageFor(entry) { return String(entry.message || entry.type || '').replace(TAG_RE, ''); }

  // ---- the stream ----
  // opts.send(tag, level, message) delivers one line (app.js: device:log on the current socket).
  // opts.platform() returns the line that opens the stream. Timers are injectable for tests.
  function createStream(opts) {
    var send = opts.send;
    var now = opts.now || nowMs;
    var setT = opts.setTimeout || setTimeout;
    var clearT = opts.clearTimeout || clearTimeout;
    var autoOffMs = opts.autoOffMs || AUTO_OFF_MS;
    var on = false, subscribed = false, offTimer = null;
    var windowAt = 0, windowCount = 0, suppressed = 0;

    function safeSend(tag, level, message) {
      try { send(String(tag).slice(0, 64), level, String(message == null ? '' : message).slice(0, 2000)); } catch (e) {}
    }

    function emitLine(tag, level, message) {
      if (!on) return;
      var t = now();
      if (t - windowAt >= 1000) {
        windowAt = t;
        var dropped = suppressed;
        windowCount = 0; suppressed = 0;
        if (dropped > 0) { windowCount++; safeSend('debug', 'w', dropped + ' line(s) suppressed (rate limit)'); }
      }
      if (windowCount >= MAX_LINES_PER_SEC) { suppressed++; return; }
      windowCount++;
      safeSend(tag, level, message);
    }

    function sink(entry) {
      if (!on || !entry || entry.__stSent) return;
      entry.__stSent = true;
      emitLine(tagFor(entry), levelFor(entry), messageFor(entry));
    }

    // Bypasses the per-second cap on purpose: it is one burst bounded by the buffer, and the history
    // is what the operator came for. The dashboard stamps arrival time, so each line carries its age.
    function flushBacklog() {
      var pending = [];
      for (var i = 0; i < buffer.length; i++) if (buffer[i] && !buffer[i].__stSent) pending.push(buffer[i]);
      safeSend('debug', 'i', '--- replaying ' + pending.length + ' buffered line(s) from before the stream opened ---');
      var t = now();
      for (var j = 0; j < pending.length; j++) {
        var e = pending[j];
        e.__stSent = true;
        var age = e.t ? '(-' + ((t - e.t) / 1000).toFixed(1) + 's) ' : '';
        safeSend(tagFor(e), levelFor(e), age + messageFor(e));
      }
      safeSend('debug', 'i', '--- end of backlog, now live ---');
    }

    function set(enabled) {
      if (offTimer) { clearT(offTimer); offTimer = null; }
      if (!enabled) {
        if (on) emitLine('debug', 'i', 'Remote debug logging OFF');
        on = false;
        return;
      }
      var wasOn = on;
      on = true;
      windowAt = 0; windowCount = 0; suppressed = 0;
      if (!subscribed) { subscribed = true; subs.push(sink); }
      if (!wasOn) {
        var p = '';
        try { p = opts.platform ? opts.platform() : ''; } catch (e) {}
        safeSend('debug', 'i', 'Remote debug logging ON' + (p ? ' - ' + p : ''));
        flushBacklog();
      }
      offTimer = setT(function () {
        offTimer = null;
        emitLine('debug', 'w', 'Remote debug logging auto-disabled after ' + Math.round(autoOffMs / 60000) + ' min');
        on = false;
      }, autoOffMs);
    }

    return { set: set, isOn: function () { return on; } };
  }

  // Test hook: drop the buffer and subscribers between cases.
  function _reset() { buffer.length = 0; subs.length = 0; installed = false; }

  return {
    MAX_LOG: MAX_LOG, MAX_LINES_PER_SEC: MAX_LINES_PER_SEC, AUTO_OFF_MS: AUTO_OFF_MS,
    install: install, push: push, createStream: createStream, buffer: function () { return buffer; }, _reset: _reset,
  };
});
