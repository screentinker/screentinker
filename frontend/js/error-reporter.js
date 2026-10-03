/*
 * Dashboard client-error reporter.
 *
 * WHY THIS EXISTS. The player has reported its JavaScript errors for a long time
 * (player/debug-overlay.js -> /api/player-debug, fingerprinted, rate-limited) and the dashboard
 * reported nothing at all. Every one of the 201 rows in player_debug_logs on production came from
 * /player. So a customer hitting a broken dashboard was invisible: the audit log records that a
 * request happened, never that the page then threw. #292's missing `esc` import left three dialogs
 * dead for weeks, live on production, behind a green test suite — a ReferenceError in a click
 * handler that nothing anywhere was listening for. This is what listens for it.
 *
 * ⚠️ NOT a copy of the player's reporter, deliberately. That one DENY-LISTS modern desktop browsers
 * ("they have devtools, we don't need their telemetry") because for a signage player a desktop UA
 * means someone is previewing. For the dashboard, desktop IS the entire audience, so inheriting
 * that gate would report nothing. Same endpoint and same table; different population.
 *
 * ⚠️ PLAIN SCRIPT, NOT A MODULE, and loaded before js/app.js. A module is deferred, so it would
 * install its handlers after the app has already booted and thrown.
 *
 * Kill switch: <meta name="st-error-reporting" content="off">, injected by the /app route from
 * PLAYER_DEBUG_REPORTING. Absent means on, matching the player's default.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/player-debug';
  var MAX_PER_SESSION = 20;     // a render loop must not become a DoS on our own endpoint
  var DEBOUNCE_MS = 4000;       // batch a burst; an error usually arrives with friends
  var MAX_STACK = 4000;
  var BACKOFF_MS = 5 * 60 * 1000;

  var sent = 0;
  var seen = Object.create(null);   // fingerprint -> true, report each distinct fault once
  var queue = [];
  var timer = null;
  var nextRetryAt = 0;
  var enabled = true;

  try {
    var meta = document.querySelector('meta[name="st-error-reporting"]');
    if (meta && String(meta.getAttribute('content')).toLowerCase() === 'off') enabled = false;
  } catch (e) { /* absent meta means on */ }

  /*
   * The page identity, with secrets removed.
   *
   * ⚠️ NEVER send location.href raw. The query string carries single-use credentials on this origin
   * — ?k=<enrol key> and ?reset=<password-reset token> — and this endpoint is UNAUTHENTICATED and
   * world-readable to a platform admin. Path plus hash route is what identifies the broken screen;
   * the query string only leaks. Hash query params go too (#/x?token=…).
   */
  function safeUrl() {
    try {
      var hash = String(location.hash || '').split('?')[0];
      return location.origin + location.pathname + hash;
    } catch (e) { return null; }
  }

  // Group the same fault across sessions: type + message + first stack frame. Line/column are
  // deliberately excluded — they move with every build and would fragment one bug into many.
  function fingerprint(kind, message, stack) {
    var frame = String(stack || '').split('\n')[1] || '';
    var basis = kind + '|' + String(message || '').slice(0, 200) + '|' + frame.trim().slice(0, 120);
    var h = 0;
    for (var i = 0; i < basis.length; i++) { h = ((h << 5) - h + basis.charCodeAt(i)) | 0; }
    return 'dash-' + (h >>> 0).toString(16);
  }

  function record(kind, message, stack, extra) {
    if (!enabled || sent >= MAX_PER_SESSION) return;
    try {
      var fp = fingerprint(kind, message, stack);
      if (seen[fp]) return;
      seen[fp] = true;
      queue.push({
        kind: kind,
        message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, MAX_STACK),
        source: extra || null,
        at: new Date().toISOString(),
        fingerprint: fp
      });
      if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
    } catch (e) { /* the reporter must never become the error */ }
  }

  function flush() {
    timer = null;
    if (!enabled || !queue.length || Date.now() < nextRetryAt) { queue = []; return; }
    var batch = queue.splice(0, queue.length);
    sent += batch.length;
    var payload = {
      // no deviceId: this is a dashboard session, not a screen
      userAgent: String(navigator.userAgent || '').slice(0, 500),
      url: safeUrl(),
      error_fingerprint: batch[0].fingerprint,
      errors: batch,
      context: { app: 'dashboard', screen: (screen.width || 0) + 'x' + (screen.height || 0) }
    };
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true          // survives the navigation that a fatal error often triggers
      }).then(function (r) {
        // 429 means we are part of the noise. Stand down rather than add to it.
        if (r && r.status === 429) nextRetryAt = Date.now() + BACKOFF_MS;
      }).catch(function () { /* reporting is best-effort, never user-visible */ });
    } catch (e) { /* no fetch, no report */ }
  }

  if (enabled) {
    window.addEventListener('error', function (ev) {
      if (!ev) return;
      // A failed <img>/<script> load also fires 'error' but has no .error and targets an element.
      // Those are asset problems, not exceptions, and would drown the real ones.
      if (ev.target && ev.target !== window && ev.target.tagName) return;
      var err = ev.error;
      record('error', (err && err.message) || ev.message, err && err.stack,
        ev.filename ? String(ev.filename).split('?')[0] : null);
    }, true);

    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      record('unhandledrejection', (r && r.message) || String(r), r && r.stack, null);
    });
  }

  // Exposed for the app to report a handled-but-wrong condition, and for tests.
  window.__stErrorReporter = { record: record, flush: flush, isEnabled: function () { return enabled; } };
})();
