// Player debug overlay. Renders a fixed top-40% overlay on the screen so a
// user on a TV (no devtools) can take a phone photo and send it to support.
//
// Activation:
//   - ?debug=1 in the URL (always shows on load)
//   - Keyboard sequence d-e-b-u-g typed within 5 seconds (toggle)
//   - Samsung remote red button, keyCode 403 (toggle)
//   - smart-TV UA (/Tizen|SMART-TV|WebOS|AFTS|AFTT|AFTM|BRAVIA/i) +
//     ?autodebug=1 (auto - lets us flip on via env config later)
//
// Freeze (so the overlay stops scrolling while a phone photo is taken):
//   - 'f' key (toggle)
//   - Samsung remote green button, keyCode 404 (toggle)
//   - Obvious "[F] FROZEN" yellow badge top-right when active
//
// ES5 syntax throughout to match section 1's compatibility floor. No
// template literals, no arrow functions, no const/let, no destructuring.
// Defensive try/catch wraps everything: this script must never be the
// reason the player won't boot.

(function () {
  try {
    var SMART_TV_RE = /Tizen|SMART-TV|WebOS|AFTS|AFTT|AFTM|BRAVIA/i;
    var KEY_LOG_MAX = 10;
    var LOG_VISIBLE = 30;
    var REFRESH_MS = 500;
    var SEQ_TARGET = 'debug';
    var SEQ_TTL_MS = 5000;

    var active = false;
    var frozen = false;
    var overlay = null;
    var refreshTimer = null;
    var keydownLog = []; // newest first; [{keyCode, key, t}, ...]
    var seq = '';
    var seqResetTimer = null;
    var bootT = nowMs();

    function nowMs() {
      try { return Date.now(); } catch (e) { return new Date().getTime(); }
    }

    // Manual URL param parse - URLSearchParams may not exist on Tizen 4 era WebKit.
    function getParam(name) {
      var qs = (location && location.search) || '';
      if (qs.charAt(0) === '?') qs = qs.substring(1);
      var parts = qs.split('&');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        var k = eq >= 0 ? parts[i].substring(0, eq) : parts[i];
        var v = eq >= 0 ? parts[i].substring(eq + 1) : '';
        try { k = decodeURIComponent(k); } catch (e) {}
        try { v = decodeURIComponent(v); } catch (e) {}
        if (k === name) return v;
      }
      return null;
    }

    function shouldAutoActivate() {
      if (getParam('debug') !== null) return true;
      if (getParam('autodebug') !== null && SMART_TV_RE.test((navigator && navigator.userAgent) || '')) return true;
      return false;
    }

    function esc(s) {
      s = String(s == null ? '' : s);
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Pad-right helper. Keeps log lines column-aligned even on monospace
    // fallback fonts. Using "[type        ] message" feels noisy at TV
    // viewing distance but the alignment makes scanning easier in a photo.
    function padRight(s, n) {
      s = String(s);
      while (s.length < n) s += ' ';
      return s;
    }

    // Read connection state. The player's main inline script declares
    // `socket` with `let` at script-top-level. By spec, classic-script
    // top-level let/const declarations live in the document's global
    // declarative environment record - accessible by bare name from other
    // classic scripts (NOT on `window`). This should work since our overlay
    // script is also classic and runs after the player's inline script via
    // `defer`. But: verify on a real player in browser (load with ?debug=1,
    // confirm the Conn line transitions unknown -> connected after the
    // socket establishes). If it stays "unknown" the fallback fix is one
    // line in the player's main script: `window.__playerState = { socket: socket }`
    // after `socket = io(...)`, and we read window.__playerState.socket here.
    function connectionState() {
      try {
        if (typeof socket !== 'undefined' && socket && typeof socket.connected === 'boolean') {
          return socket.connected ? 'connected' : 'disconnected';
        }
      } catch (e) {}
      // Belt-and-suspenders fallback if the cross-script bare reference
      // doesn't resolve on a given browser.
      try {
        if (window.__playerState && window.__playerState.socket && typeof window.__playerState.socket.connected === 'boolean') {
          return window.__playerState.socket.connected ? 'connected' : 'disconnected';
        }
      } catch (e) {}
      return 'unknown';
    }

    function buildHtml() {
      var ua = (navigator && navigator.userAgent) || '';
      var w = (window.innerWidth || 0) + 'x' + (window.innerHeight || 0);
      var sd = ((screen && screen.width) || 0) + 'x' + ((screen && screen.height) || 0);
      var uptime = Math.floor((nowMs() - bootT) / 1000) + 's';
      var conn = connectionState();

      var topHtml = ''
        + '<div style="font-size:22px;line-height:1.3;color:#fff;border-bottom:1px solid #444;padding-bottom:6px;margin-bottom:6px">'
        +   '<div>UA: ' + esc(ua.substring(0, 140)) + '</div>'
        +   '<div>Screen: ' + esc(sd) + '&nbsp;&nbsp;Viewport: ' + esc(w) + '&nbsp;&nbsp;Conn: ' + esc(conn) + '&nbsp;&nbsp;Uptime: ' + esc(uptime) + '</div>'
        +   '<div>URL: ' + esc((location.href || '').substring(0, 220)) + '</div>'
        + '</div>';

      var log = (window.__debugLog && window.__debugLog.length) ? window.__debugLog : [];
      var start = Math.max(0, log.length - LOG_VISIBLE);
      var slice = log.slice(start).reverse(); // newest at top

      var middleHtml = '<div style="font-size:18px;line-height:1.25;color:#fff;margin-bottom:6px">';
      for (var i = 0; i < slice.length; i++) {
        var e = slice[i] || {};
        var color = '#fff';
        var t = e.type || '?';
        if (t === 'error' || t === 'rejection' || t === 'console.error') color = '#f87171';
        else if (t === 'console.warn') color = '#fbbf24';
        else if (t === 'init' || t === 'timing') color = '#a3e635';
        var msg = (e.message || '');
        if (t === 'error' && e.source) msg = msg + ' @ ' + e.source + ':' + e.line;
        if (t === 'timing') msg = e.event + ' +' + e.sinceInit + 'ms';
        if (t === 'init') msg = 'ua=' + (e.ua || '').substring(0, 60) + ' screen=' + (e.sw || '?') + 'x' + (e.sh || '?');
        var line = '[' + padRight(t, 14) + '] ' + esc(String(msg).substring(0, 240));
        middleHtml += '<div style="color:' + color + '">' + line + '</div>';
      }
      if (slice.length === 0) middleHtml += '<div style="color:#94a3b8">(no entries yet)</div>';
      middleHtml += '</div>';

      var keysHtml = '<div style="font-size:18px;line-height:1.25;color:#cbd5e1;border-top:1px solid #444;padding-top:6px">';
      keysHtml += '<div style="color:#94a3b8;margin-bottom:2px">KEYS (last ' + keydownLog.length + ', newest first):</div>';
      for (var j = 0; j < keydownLog.length; j++) {
        var k = keydownLog[j];
        keysHtml += '<div>[' + esc(k.keyCode) + '] ' + esc(k.key || '(no key field)') + '</div>';
      }
      if (keydownLog.length === 0) keysHtml += '<div style="color:#64748b">(press any key to start logging)</div>';
      keysHtml += '</div>';

      var freezeBadge = frozen
        ? '<div style="position:absolute;top:8px;right:12px;background:#fbbf24;color:#000;font-weight:bold;font-size:24px;padding:6px 12px;border-radius:4px;font-family:monospace,monospace;letter-spacing:1px">[F] FROZEN</div>'
        : '<div style="position:absolute;top:8px;right:12px;background:#1f2937;color:#94a3b8;font-size:18px;padding:4px 10px;border-radius:4px;font-family:monospace,monospace;border:1px solid #374151">press F to freeze</div>';

      var helpLabel = '<div style="position:absolute;bottom:8px;right:12px;font-size:14px;color:#94a3b8;background:#0f172a;padding:4px 8px;border-radius:3px">Debug Overlay - take a photo and send to support</div>';

      return topHtml + middleHtml + keysHtml + freezeBadge + helpLabel;
    }

    function render() {
      if (!overlay || frozen) return;
      try { overlay.innerHTML = buildHtml(); } catch (e) {}
    }

    // Force a render bypassing the frozen gate. Used right after freeze
    // toggles so the [F] FROZEN badge actually updates on the screen.
    function forceRender() {
      if (!overlay) return;
      try { overlay.innerHTML = buildHtml(); } catch (e) {}
    }

    function activate() {
      if (active) return;
      active = true;
      try {
        overlay = document.createElement('div');
        overlay.id = '__player-debug-overlay';
        overlay.style.cssText = ''
          + 'position:fixed;top:0;left:0;width:100%;height:40%;'
          + 'background:rgba(0,0,0,0.85);color:#fff;'
          + 'font-family:Menlo,Consolas,Courier,monospace,monospace;'
          + 'font-size:18px;line-height:1.3;'
          + 'padding:12px 16px;box-sizing:border-box;'
          + 'z-index:2147483647;overflow:hidden;'
          + 'pointer-events:none;word-break:break-all;'
          + 'text-shadow:0 0 1px #000';
        document.body.appendChild(overlay);
        forceRender();
        refreshTimer = setInterval(render, REFRESH_MS);
      } catch (e) {}
    }

    function deactivate() {
      if (!active) return;
      active = false;
      frozen = false;
      try {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
      overlay = null;
      if (refreshTimer) { try { clearInterval(refreshTimer); } catch (e) {} refreshTimer = null; }
    }

    function toggle() { active ? deactivate() : activate(); }

    function toggleFreeze() {
      if (!active) return;
      frozen = !frozen;
      forceRender(); // bypass frozen gate so the badge updates immediately
    }

    function handleKeydown(ev) {
      try {
        var kc = ev.keyCode || ev.which || 0;
        var key = (ev.key || '');

        // Capture into keydown log (newest first)
        keydownLog.unshift({ keyCode: kc, key: key, t: nowMs() });
        if (keydownLog.length > KEY_LOG_MAX) keydownLog.length = KEY_LOG_MAX;

        // 'debug' sequence detection. Only ASCII letters contribute to the
        // sequence; arrow keys, space, etc. don't reset progress but don't
        // advance it either.
        var ch = (key + '').toLowerCase();
        if (ch.length === 1 && ch >= 'a' && ch <= 'z') {
          seq += ch;
          if (seq.length > SEQ_TARGET.length) seq = seq.substring(seq.length - SEQ_TARGET.length);
          if (seq === SEQ_TARGET) {
            toggle();
            seq = '';
          }
          if (seqResetTimer) clearTimeout(seqResetTimer);
          seqResetTimer = setTimeout(function () { seq = ''; }, SEQ_TTL_MS);
        }

        // Samsung remote red button (keyCode 403) - toggle overlay
        if (kc === 403) toggle();

        // 'f' key (only when overlay active) or Samsung remote green button
        // (keyCode 404) - toggle freeze
        if (active && (ch === 'f' || kc === 404)) toggleFreeze();
      } catch (e) {}
    }

    // Capture phase = true so we see keys even if the player adds its own
    // keydown handlers that call stopPropagation. The overlay's keys are
    // operator/diagnostic only - we don't want them blocked.
    try { document.addEventListener('keydown', handleKeydown, true); } catch (e) {}

    // Boot
    if (shouldAutoActivate()) {
      if (document.body) {
        activate();
      } else {
        try { document.addEventListener('DOMContentLoaded', activate); } catch (e) {}
      }
    }

    // ====================================================================
    // Section 4: error reporter
    // ====================================================================
    // Auto-posts captured errors to /api/player-debug. Runs independent of
    // the visible overlay (target population is smart TVs that may never
    // open the overlay). Triggered by:
    //   - A new error-ish entry pushed to __debugLog (debounced 5s, batched)
    //   - Page unload (navigator.sendBeacon with size cap)
    //
    // Gated by:
    //   - window.__playerConfig.debugReporting (server-injected from
    //     PLAYER_DEBUG_REPORTING env var; default true; kill switch for
    //     self-hosters)
    //   - UA allow-list (smart TV markers) and deny-list (modern desktop
    //     browsers - they have devtools, we don't need their telemetry)
    //   - 5-minute backoff after a 429 from the server

    var REPORT_ENDPOINT = '/api/player-debug';
    var DEBOUNCE_MS = 5000;
    var RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
    var BEACON_SIZE_CAP = 50000;   // leave headroom under the ~64KB beacon limit
    var BEACON_FALLBACK_ENTRIES = 30;
    var LOG_TAIL_FOR_REPORT = 50;

    var reportingEnabled = false;
    var pendingQueue = [];
    var debounceTimer = null;
    var nextRetryAt = 0;

    // ---- UA gating ----
    // Order: allow-list smart-TV markers first (always report - this is the
    // population we built for), then deny-list modern desktop browsers (they
    // have devtools, no telemetry needed), then default to report for
    // everything else (unknown UAs are the long tail of weird embedded
    // browsers we want to catch).
    function uaShouldReport(ua) {
      if (!ua) return true; // empty UA is suspicious enough to report
      if (SMART_TV_RE.test(ua)) return true;
      // Modern desktop deny-list. Note: SMART_TV_RE already matched and
      // returned above, so even if a Tizen UA contains "Chrome/108" (Tizen 7
      // is Chromium 108) it cannot be deny-listed here.
      var DESKTOP_RE = /Chrome\/1[0-9]{2}\.|Firefox\/1[0-9]{2}\.|Version\/(?:1[5-9]|2[0-9])\..*\sSafari\//;
      if (DESKTOP_RE.test(ua)) return false;
      return true;
    }

    // ---- Fingerprint ----
    // Two-pass djb2 (forward + reverse, different seeds) producing 16 hex
    // chars. Pure ES5, deterministic, collision-resistant enough for
    // grouping ("top N unique errors this week"). Not crypto.
    function hash16(s) {
      var pad = '00000000';
      var a = 5381;
      var b = 0x9e3779b1 | 0; // unrelated seed
      for (var i = 0; i < s.length; i++) a = ((a << 5) + a + s.charCodeAt(i)) | 0;
      for (var j = s.length - 1; j >= 0; j--) b = ((b << 5) + b + s.charCodeAt(j)) | 0;
      return (pad + (a >>> 0).toString(16)).slice(-8) + (pad + (b >>> 0).toString(16)).slice(-8);
    }

    // Hash inputs per spec:
    //   message (first 200 chars) + first stack frame's function name +
    //   filename (line/col stripped for line-drift stability).
    // For console-only entries or resource-load failures with no stack, fall
    // back to type + message.
    function fingerprintOf(entry) {
      if (!entry) return '';
      var msg = String(entry.message || '').substring(0, 200);
      var stackKey = '';
      var stack = entry.stack || '';
      if (stack) {
        var lines = String(stack).split('\n');
        for (var i = 0; i < lines.length; i++) {
          var trimmed = String(lines[i]).replace(/^\s+/, '');
          if (trimmed.indexOf('at ') === 0) {
            // Strip ":line:col" or ":line" suffix so the fingerprint is
            // stable across small refactors that move code by lines.
            stackKey = trimmed.substring(3).replace(/:\d+(?::\d+)?\)?\s*$/, '');
            break;
          }
        }
      }
      if (!stackKey) stackKey = String(entry.type || '');
      return hash16(msg + '|' + stackKey);
    }

    // ---- Device id / player state (best-effort, no PII) ----
    // Privacy rules from spec: do NOT capture input field values, pairing
    // codes (after pairing completes), or content URLs. We capture only
    // deviceId (a server-assigned UUID, harmless) and a coarse player state.
    function getDeviceId() {
      try {
        if (typeof config !== 'undefined' && config && config.deviceId) return config.deviceId;
      } catch (e) {}
      try {
        if (window.__playerState && window.__playerState.config && window.__playerState.config.deviceId) {
          return window.__playerState.config.deviceId;
        }
      } catch (e) {}
      return null;
    }

    function getPlayerState() {
      try {
        if (typeof isPlaying !== 'undefined') {
          if (isPlaying) return 'playing';
          if (typeof playlist !== 'undefined' && playlist && playlist.length === 0) return 'waiting';
          return 'idle';
        }
      } catch (e) {}
      return 'unknown';
    }

    // ---- Build report payload ----
    function buildPayload(triggerErrors) {
      var log = (window.__debugLog && window.__debugLog.length) ? window.__debugLog : [];
      var tailStart = Math.max(0, log.length - LOG_TAIL_FOR_REPORT);
      var fp = '';
      if (triggerErrors && triggerErrors.length) {
        try { fp = fingerprintOf(triggerErrors[0]); } catch (e) {}
      }
      return {
        deviceId: getDeviceId(),
        userAgent: (navigator && navigator.userAgent) || '',
        url: (location && location.href) || '',
        error_fingerprint: fp,
        errors: triggerErrors || [],
        context: {
          screenW: (screen && screen.width) || 0,
          screenH: (screen && screen.height) || 0,
          viewportW: window.innerWidth || 0,
          viewportH: window.innerHeight || 0,
          deviceId: getDeviceId(),
          playerState: getPlayerState(),
          logTail: log.slice(tailStart)
        }
      };
    }

    // ---- Send (regular fetch path) ----
    function sendReport(triggerErrors) {
      if (Date.now() < nextRetryAt) return; // in 429 backoff
      var payload;
      var body;
      try {
        payload = buildPayload(triggerErrors);
        body = JSON.stringify(payload);
      } catch (e) { return; }
      try {
        // keepalive lets the request survive page hide/navigation when the
        // browser supports it (modern). Doesn't replace sendBeacon for unload
        // but reduces the loss surface for in-flight POSTs.
        fetch(REPORT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).then(function (resp) {
          if (resp && resp.status === 429) {
            nextRetryAt = Date.now() + RATE_LIMIT_BACKOFF_MS;
          }
        }).catch(function () { /* silent - we are telemetry, not a feature */ });
      } catch (e) {}
    }

    // ---- Send (unload via beacon path) ----
    function sendBeaconReport(triggerErrors) {
      if (Date.now() < nextRetryAt) return;
      if (typeof navigator.sendBeacon !== 'function') {
        // Old browser without Beacon API. Best-effort: try keepalive fetch.
        sendReport(triggerErrors);
        return;
      }
      var payload, body, blob;
      try {
        payload = buildPayload(triggerErrors);
        body = JSON.stringify(payload);
      } catch (e) { return; }
      // Beacon caps around 64KB depending on browser. If we're over the
      // safe cap, trim the heaviest field (errors[] usually, then context.logTail).
      if (body.length > BEACON_SIZE_CAP) {
        try {
          if (payload.errors && payload.errors.length > BEACON_FALLBACK_ENTRIES) {
            payload.errors = payload.errors.slice(-BEACON_FALLBACK_ENTRIES);
          }
          if (payload.context && payload.context.logTail && payload.context.logTail.length > BEACON_FALLBACK_ENTRIES) {
            payload.context.logTail = payload.context.logTail.slice(-BEACON_FALLBACK_ENTRIES);
          }
          body = JSON.stringify(payload);
        } catch (e) { return; }
      }
      try {
        blob = new Blob([body], { type: 'application/json' });
        var ok = navigator.sendBeacon(REPORT_ENDPOINT, blob);
        if (!ok) {
          // Beacon refused (typically too-large payload). Retry once with
          // an aggressively-trimmed payload.
          try {
            payload.errors = (payload.errors || []).slice(-BEACON_FALLBACK_ENTRIES);
            payload.context = payload.context || {};
            payload.context.logTail = (payload.context.logTail || []).slice(-BEACON_FALLBACK_ENTRIES);
            navigator.sendBeacon(REPORT_ENDPOINT, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
          } catch (e) {}
        }
      } catch (e) {}
    }

    // ---- Queue + debounce ----
    function queueReport(entry) {
      if (!reportingEnabled) return;
      if (Date.now() < nextRetryAt) return;
      pendingQueue.push(entry);
      if (debounceTimer) return; // already armed
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        if (pendingQueue.length === 0) return;
        var batch = pendingQueue;
        pendingQueue = [];
        sendReport(batch);
      }, DEBOUNCE_MS);
    }

    function flushOnUnload() {
      if (!reportingEnabled) return;
      // Always send on unload, even with empty queue - the logTail context
      // is useful for understanding what happened before the page went away.
      var batch = pendingQueue.slice();
      pendingQueue = [];
      if (debounceTimer) { try { clearTimeout(debounceTimer); } catch (e) {} debounceTimer = null; }
      sendBeaconReport(batch);
    }

    // ---- Wire it up ----
    // Reporter activates if (a) PLAYER_DEBUG_REPORTING isn't off AND (b) the
    // UA passes the gating. Both checks happen here once at module init -
    // we re-evaluate nothing at runtime since UA and config are stable.
    try {
      var cfg = (window.__playerConfig && typeof window.__playerConfig.debugReporting === 'boolean')
        ? window.__playerConfig.debugReporting
        : true; // default on when no config injected (e.g. dev without the env var)
      var ua = (navigator && navigator.userAgent) || '';
      reportingEnabled = cfg && uaShouldReport(ua);

      if (reportingEnabled) {
        // Wrap __debugLog_push so we trigger the debounce on error-ish
        // entries pushed by section 1's inline trap. Non-error pushes
        // (init, timing, console.log) accumulate in __debugLog as context
        // but don't trigger a send.
        try {
          var origPush = window.__debugLog_push;
          if (typeof origPush === 'function') {
            window.__debugLog_push = function (entry) {
              origPush(entry);
              try {
                if (entry && (entry.type === 'error' || entry.type === 'rejection' || entry.type === 'console.error')) {
                  queueReport(entry);
                }
              } catch (e) {}
            };
          }
        } catch (e) {}

        // Catch errors that landed BEFORE this script wrapped __debugLog_push.
        // The inline trap captured them into __debugLog; if any are error-ish,
        // trigger an initial debounced send so they don't sit silently until
        // the next error or page unload.
        try {
          var log = window.__debugLog || [];
          for (var i = 0; i < log.length; i++) {
            var e = log[i];
            if (e && (e.type === 'error' || e.type === 'rejection' || e.type === 'console.error')) {
              queueReport(e);
              break; // one trigger is enough; debounce will batch
            }
          }
        } catch (e) {}

        // Unload handlers. pagehide is preferred on iOS Safari and
        // bfcache-aware browsers; beforeunload covers everything else.
        try { window.addEventListener('pagehide', flushOnUnload); } catch (e) {}
        try { window.addEventListener('beforeunload', flushOnUnload); } catch (e) {}
      }
    } catch (e) {}

    // Expose a manual control surface for support sessions ("paste this in the
    // address bar"). Browsers and TV WebViews vary on whether javascript:
    // URLs work, but where they do, support can ask the user to run
    // javascript:__playerDebug.activate() to open the overlay without the
    // user understanding query params.
    window.__playerDebug = {
      activate: activate,
      deactivate: deactivate,
      toggle: toggle,
      toggleFreeze: toggleFreeze,
      isActive: function () { return active; },
      isFrozen: function () { return frozen; },
      // Force a report now (manual control). Useful in support sessions:
      // "open the player, run __playerDebug.report(), I'll see it in the
      // admin view".
      report: function () { sendReport([]); },
      reportingEnabled: function () { return reportingEnabled; },
      _internal: { fingerprintOf: fingerprintOf, uaShouldReport: uaShouldReport, hash16: hash16 }
    };
  } catch (outerErr) {
    // If this whole script fails to parse or init, the player must still boot.
  }
})();
