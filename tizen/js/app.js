/* ScreenTinker — Tizen TV web player.
 * Speaks the same /device socket.io protocol as the Android player:
 *   emit  device:register {pairing_code | device_id+device_token, device_info, fingerprint}
 *   recv  device:registered {device_id, device_token, status}
 *   recv  device:paired {name}        -> go to playback
 *   recv  device:unpaired {reason}    -> clear creds, re-provision
 *   recv  device:auth-error {error}
 *   recv  device:playlist-update {assignments, layout, orientation, suspended?, message?, detail?}
 *   emit  device:heartbeat {device_id, telemetry}   every 15s
 */
(function () {
  'use strict';

  // #119: one source of truth for the player version. Resolve at runtime from the
  // packaged config.xml via the Tizen application API; fall back to a constant that
  // build-wgt.sh stamps from config.xml's version="" so the dashboard always shows the
  // version that is actually installed (never the old hardcoded '1.0.0').
  var APP_VERSION_FALLBACK = '2.2.1'; // st:app-version — stamped by build-wgt.sh
  var APP_VERSION = (function () {
    try {
      var v = tizen.application.getCurrentApplication().appInfo.version;
      if (v) return v;
    } catch (e) {}
    return APP_VERSION_FALLBACK;
  })();
  var HEARTBEAT_MS = 15000;
  var DEFAULT_DURATION = 10;
  var MIN_DURATION = 3;

  var LS = {
    url: 'st_server_url',
    id: 'st_device_id',
    token: 'st_device_token',
    fp: 'st_fingerprint',
    code: 'st_pairing_code',
    payload: 'st_payload_cache', // A2: last renderable playlist-update, replayed on cold-start/offline
    clock: 'st_clock_offset'     // #group-sync: cached server-clock offset (survives reboot/outage)
  };

  // ---- persistent state ----
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function fingerprint() {
    var fp = get(LS.fp);
    if (!fp) { fp = uuid().replace(/-/g, ''); set(LS.fp, fp); }
    return fp;
  }
  function pairingCode() {
    var c = get(LS.code);
    if (!c) { c = String(Math.floor(100000 + Math.random() * 900000)); set(LS.code, c); }
    return c;
  }

  // ---- DOM ----
  var elSetup = document.getElementById('setup');
  var elPairing = document.getElementById('pairing');
  var elStage = document.getElementById('stage');
  var elPip = document.getElementById('pip'); // #109: PiP overlay layer (above #stage)
  var elUrl = document.getElementById('serverUrl');
  var elConnect = document.getElementById('connectBtn');
  var elSetupStatus = document.getElementById('setupStatus');
  var elPairCode = document.getElementById('pairCode');
  var elPairStatus = document.getElementById('pairStatus');
  var elReset = document.getElementById('resetBtn');
  var elToast = document.getElementById('toast');

  function show(el) { [elSetup, elPairing, elStage].forEach(function (e) { e.classList.add('hidden'); }); el.classList.remove('hidden'); }
  var toastTimer = null;
  function toast(msg, sticky) {
    elToast.textContent = msg; elToast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(function () { elToast.classList.add('hidden'); }, 4000);
  }
  function clearToast() { if (toastTimer) clearTimeout(toastTimer); elToast.classList.add('hidden'); }

  // Keep the screen awake (best effort across Tizen APIs)
  function keepAwake() {
    // appcommon.setScreenSaver is the keep-awake on a Samsung TV (public level, no privilege).
    // tizen.power.request used to sit beside it; the Power API is not part of the TV web profile
    // and its privilege was never declared, so it only ever threw into the catch. Removed.
    try { if (window.webapis && webapis.appcommon) webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF); } catch (e) {}
  }

  // A5 — MONOTONIC clock for lifecycle time deltas (watchdog silence, resume hidden-duration), so an
  // NTP/RTC wall-clock step on a 24/7 TV can't false-fire (forward jump) or blind (backward jump) the
  // watchdog. Date.now() is kept ONLY where a real wall clock is needed (telemetry, cross-device wall sync).
  var mono = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  // FIX A — RE-ASSERT keep-awake on an interval. tizen.power.request / the screensaver-off
  // setting can be released when the TV backgrounds/suspends the app, and the player had no
  // way to re-suppress it (keepAwake was only called at boot/connect/command). ~30s is well
  // under any TV screensaver timeout and the calls are cheap best-effort no-ops. Cleared by
  // stopKeepAwake() on app teardown.
  var keepAwakeTimer = null;
  function startKeepAwake() {
    stopKeepAwake();
    keepAwake();
    keepAwakeTimer = setInterval(keepAwake, 30000);
  }
  function stopKeepAwake() { if (keepAwakeTimer) { clearInterval(keepAwakeTimer); keepAwakeTimer = null; } }

  // FIX B — VISIBILITY / RESUME handling. On a TV, a background/suspend can (a) release
  // keep-awake and (b) silently drop the socket, leaving it HALF-OPEN — socket.connected stays
  // true while the transport is dead, which socket.io CANNOT detect, so it won't auto-reconnect.
  //
  // Double-connect discipline (the one way this could reintroduce #148's duplicate socket):
  //   - DEFER to socket.io when the socket is already disconnected (socket.io owns that
  //     reconnect, and #118 re-registers on 'connect').
  //   - OWN a clean teardown-before-reopen (via connect(), which disconnects the old socket
  //     FIRST — cancelling any socket.io reconnect — then opens exactly ONE new socket) ONLY
  //     for the half-open case socket.io can't see.
  //   These are mutually-exclusive socket states (connected vs not), so a manual reconnect
  //   never races socket.io's auto-reconnect. We do NOT manually re-register (connect's 'connect'
  //   handler does, once). Half-open is inferred from how long the app was hidden — socket.connected
  //   alone is unreliable post-suspend and there is no server ack channel to actively probe
  //   without a server change (out of scope for this client-only build).
  var hiddenAtMs = 0;
  var SUSPEND_HIDE_MS = 3000; // hidden >= this ≈ an OS suspend that can half-open the socket

  // Pure decision, factored out so the double-connect logic is unit-testable:
  //   'reconnect' = half-open -> own teardown+reopen ; 'defer' = already down -> socket.io owns it ; 'noop'
  function resumeDecision(hasSocket, socketConnected, hiddenMs) {
    if (!hasSocket) return 'noop';
    if (!socketConnected) return 'defer';
    return (hiddenMs >= SUSPEND_HIDE_MS) ? 'reconnect' : 'noop';
  }
  // Samsung CO-MT-01: media must come back in the same state after Smart Hub / another app. The
  // platform pauses <video> and AVPlay on hide and nothing restarted them, so a looping video
  // resumed as a frozen frame. suspend()/resume() live in the player (they walk the shared #stage,
  // so zones are covered too); a media element that cannot simply play() again is re-mounted by
  // whichever renderer owns the stage.
  function replayCurrent() {
    if (stageOwner === 'zones') {
      var cp = get(LS.payload);
      if (cp) { try { onPlaylist(JSON.parse(cp)); } catch (e) {} }
    } else if (stageOwner === 'player') {
      player.playCurrent();
    }
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden' || document.hidden) {
      hiddenAtMs = mono(); // A5: monotonic
      try { player.suspend(); } catch (e) {}
      return;
    }
    keepAwake(); // re-assert immediately on resume
    try { player.resume(replayCurrent); } catch (e) { replayCurrent(); }
    var hiddenMs = hiddenAtMs ? (mono() - hiddenAtMs) : 0; // A5: monotonic hidden-duration
    hiddenAtMs = 0;
    var action = resumeDecision(!!socket, !!(socket && socket.connected), hiddenMs);
    if (action === 'reconnect') connect(); // teardown-before-reopen -> exactly one socket; #118 registers once
    // 'defer' -> socket.io auto-reconnects (re-registers on 'connect'); 'noop' -> healthy, do nothing
  }
  if (typeof window !== 'undefined') window.__stResumeDecision = resumeDecision; // test hook (inert in prod)

  // FIX B (hardened) — application-level LIVENESS WATCHDOG. The resume path above only fires on
  // visibilitychange, so a socket that goes half-open with NO visibility event (network drop, NAT
  // idle timeout, transport death while foregrounded) would never be caught: socket.connected stays
  // true on a dead socket and socket.io won't reconnect. The watchdog watches for server SILENCE.
  // The server sends an engine ping every ~15s (config.pingInterval) AND app events, so a healthy
  // socket refreshes lastServerMsgAt at least every ~15s (markAlive is wired into a central receive
  // path in connect(): socket.onAny + socket.io 'ping'). If the socket goes quiet past the liveness
  // window while we still believe we're connected + authenticated, it is half-open -> clean
  // teardown-before-reopen via connect() (exactly one socket; #118 re-registers once).
  //
  // Double-connect discipline: the watchdog fires ONLY while socket.connected===true (the half-open
  // state socket.io cannot see) — socket.io's own auto-reconnect only runs when socket.connected is
  // false, so the two never overlap. connect() is teardown-first, and it resets lastServerMsgAt, so
  // the watchdog and the resume fast-path can't double-fire a second reconnect. Client-only: uses
  // signals the server already sends; no server change.
  var lastServerMsgAt = 0;
  var livenessConfirmed = false;              // v4 degrade-safe: DON'T arm until a device:heartbeat-ack
  // v4 canonical anti-herd THRESHOLD: 45s ± up to 10s random jitter (was a fixed 35s), so a fleet
  // doesn't all declare half-open simultaneously under a shared cause (server load delaying acks
  // fleet-wide). Matches the APK's LivenessWatchdog.thresholdMs so the three clients behave
  // identically on the wire. Re-jittered per connect().
  var THRESHOLD_BASE_MS = 45000, THRESHOLD_JITTER_MS = 10000;
  function thresholdMs(rand) { return THRESHOLD_BASE_MS + Math.round((rand - 0.5) * 2 * THRESHOLD_JITTER_MS); }
  var livenessWindowMs = THRESHOLD_BASE_MS;
  var watchdogTimer = null;
  // v4: ANY inbound refreshes the SILENCE timestamp (so other server traffic keeps a healthy socket
  // alive) — but it does NOT arm. Arming gates on the ack specifically (see the device:heartbeat-ack
  // handler), so engine pings alone can't arm us against an ack-less server.
  function markAlive() { lastServerMsgAt = mono(); }         // A5 monotonic
  // Pure, unit-testable. Reconnect ONLY when a connected+authenticated socket whose liveness we have
  // ARMED (seen >=1 device:heartbeat-ack — v4 degrade-safe: a server that never app-acks never arms
  // us, so no false-fire even though engine pings keep flowing) has gone silent past the window.
  function watchdogShouldReconnect(hasSocket, connected, authed, confirmed, silentMs, windowMs) {
    return !!(hasSocket && connected && authed && confirmed && silentMs > windowMs);
  }
  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(function () {
      var silentMs = lastServerMsgAt ? (mono() - lastServerMsgAt) : 0; // A5 monotonic
      if (watchdogShouldReconnect(!!socket, !!(socket && socket.connected), authenticated, livenessConfirmed, silentMs, livenessWindowMs)) {
        connect(); // half-open backstop: teardown-first -> one socket, #118 re-registers once
      }
    }, 10000);
  }
  function stopWatchdog() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } }
  if (typeof window !== 'undefined') { window.__stWatchdogShouldReconnect = watchdogShouldReconnect; window.__stThresholdMs = thresholdMs; }

  // ---- networking ----
  var socket = null;
  var deviceId = get(LS.id);
  var deviceToken = get(LS.token);
  var serverUrl = get(LS.url);
  var heartbeatTimer = null;
  var beatCount = 0;
  var authenticated = false; // #118: true only between device:registered and disconnect/auth-error
  var streamTimer = null;    // #120: dashboard preview streaming interval
  // feat/offline-cause-log: connectivity-report state. Track in-session disconnects so a reconnect can
  // tell the server WHY it was gone (local link lost vs server/upstream unreachable). A browser can't
  // see SSID/RSSI, so we send only offline_ms + link_lost + cold_start:false.
  var disconnectedAtMono = 0;     // mono() at the first disconnect of the current gap (0 = not in a gap)
  var linkLostDuringGap = false;  // navigator went offline at any point during the gap

  // #group-sync clock discipline. Server is the time authority (heartbeat-ack). Cache a smoothed
  // offset so synced_now = Date.now() + clockOffsetMs keeps schedule sync aligned through an outage.
  var clockOffsetMs = (function () { var v = Number(get(LS.clock)); return isFinite(v) ? v : 0; })();
  var clockRttMs = null;
  function syncedNow() { return Date.now() + clockOffsetMs; }
  function ingestClockSample(serverMs, clientMs) {
    if (!serverMs || !clientMs) return;
    var t4 = Date.now(), rtt = Math.max(0, t4 - clientMs);
    if (rtt > 5000) return;                            // absurd RTT (GC/sleep stall) — don't poison offset
    var sample = serverMs - (clientMs + t4) / 2;       // NTP-style: offset = server - (t1+t4)/2
    if (clockRttMs === null || Math.abs(sample - clockOffsetMs) > 1000) clockOffsetMs = Math.round(sample);
    else clockOffsetMs = Math.round(clockOffsetMs * 0.8 + sample * 0.2);
    clockRttMs = Math.round(rtt);
    set(LS.clock, String(clockOffsetMs));
  }
  // Stream a group-sync diagnostic to the dashboard live-log (tag 'sync').
  function reportSync(level, msg) {
    try { if (socket && socket.connected && deviceId) socket.emit('device:log', { device_id: deviceId, tag: 'sync', level: level, message: msg }); } catch (e) {}
  }

  function deviceInfo() {
    return {
      android_version: 'Tizen ' + (tizenVersion() || ''),
      app_version: APP_VERSION,
      screen_width: window.screen ? screen.width : window.innerWidth,
      screen_height: window.screen ? screen.height : window.innerHeight
    };
  }
  function tizenVersion() {
    try { return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { return ''; }
  }

  function telemetry() {
    var t = { uptime_seconds: Math.floor(performance.now() / 1000) };
    // #74/#75: OS timezone + UTC clock (effective-tz resolution + skew indicator)
    try { t.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { t.timezone = null; }
    t.device_utc = Date.now();
    try {
      tizen.systeminfo.getPropertyValue('BATTERY', function (b) {
        t.battery_level = Math.round((b.level || 0) * 100);
        t.battery_charging = !!b.isCharging;
      });
    } catch (e) {}
    return t;
  }

  function connect() {
    if (!serverUrl) { show(elSetup); return; }
    keepAwake();
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    if (registerTimer) { clearTimeout(registerTimer); registerTimer = null; } // H4: a fresh connect supersedes any pending re-register

    var base = serverUrl.replace(/\/+$/, '');
    socket = io(base + '/device', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,      // v4 canonical: 1s start (was 2s)
      reconnectionDelayMax: 30000,  // v4 canonical: 30s cap, within the ~30-60s band (was 10s)
      randomizationFactor: 0.2,     // v4 canonical: ±20% jitter (was ±50%); exponential-double shape kept
      timeout: 20000                // cheap parity (GAP4c): match /player + APK; 10s prematurely errored slow TV WebKit / WS-blocked networks
    });

    // FIX B (hardened): central receive-path liveness. A fresh socket is assumed alive; then EVERY
    // inbound server message refreshes lastServerMsgAt — app events via onAny, and the engine ping
    // (~15s) via the manager 'ping'. This resets liveness so the watchdog / resume fast-path can't
    // double-fire, and feeds the watchdog's server-silence detection. (io() returns a fresh socket
    // per connect — verified — so these listeners don't accumulate.)
    lastServerMsgAt = mono();                 // A5 monotonic
    livenessConfirmed = false;                // v4 degrade-safe: DIS-arm until a heartbeat-ack re-arms
    livenessWindowMs = thresholdMs(Math.random()); // v4: fresh 45s ± up to 10s jitter for this connection
    socket.onAny(markAlive);                  // refresh SILENCE on any inbound (does not arm)
    socket.io.on('ping', markAlive);          // engine ping refreshes silence too (still does not arm)

    socket.on('connect', function () {
      // #118: a brand-new socket is not authenticated until device:registered. Reset the
      // flag and kill any heartbeat carried over from the previous socket, so a beat can't
      // fire on this fresh, unregistered connection (TV sleep/wake reconnects often).
      authenticated = false;
      stopHeartbeat();
      clearToast();
      register();
    });
    socket.on('connect_error', function (err) {
      if (!deviceId) {
        // Not provisioned yet — fall back to the server prompt so a bad/unreachable
        // URL can be corrected instead of leaving a blank screen.
        elUrl.value = serverUrl || '';
        elSetupStatus.textContent = 'Could not reach server: ' + (err && err.message ? err.message : 'error');
        elSetupStatus.className = 'status error';
        show(elSetup); elUrl.focus();
      } else {
        toast('Reconnecting…', true);
      }
    });
    socket.on('disconnect', function () {
      authenticated = false; // #118
      stopHeartbeat();        // #118: no beats on a dead socket
      // feat/offline-cause-log: open an offline gap so the next reconnect can report cause.
      if (!disconnectedAtMono) {
        disconnectedAtMono = mono();
        linkLostDuringGap = (typeof navigator !== 'undefined' && navigator.onLine === false);
      }
      toast('Reconnecting…', true);
    });

    socket.on('device:registered', function (data) {
      deviceId = data.device_id; deviceToken = data.device_token;
      set(LS.id, deviceId); set(LS.token, deviceToken);
      authenticated = true; // #118: this socket may now send post-register events
      clearToast();         // #118: drop any stale "Not authenticated…" banner
      flushOfflinePlays();  // #299: authenticated, so any offline backlog can be replayed
      // feat/offline-cause-log: reconnected after an in-session disconnect -> report the gap length +
      // whether the local link dropped. cold_start:false because the app SURVIVED the gap (a reboot
      // would have lost this in-process state). Browser has no SSID/RSSI to add.
      if (disconnectedAtMono) {
        try {
          socket.emit('device:connectivity-report', {
            device_id: deviceId,
            offline_ms: Math.max(0, Math.round(mono() - disconnectedAtMono)),
            link_lost: linkLostDuringGap,
            cold_start: false
          });
        } catch (e) {}
        disconnectedAtMono = 0; linkLostDuringGap = false;
      }
      startHeartbeat();
      reportCapabilities(); // #125: surface the fleet-control backend to the dashboard
      if (data.status === 'provisioning') showPairing();
    });

    // v4 degrade-safe ARM: the watchdog arms ONLY after the first app-level device:heartbeat-ack.
    // A server that sends engine pings but no app-ack (old/pre-contract server) never arms us, so the
    // watchdog can't false-fire — markAlive (onAny) still refreshed lastServerMsgAt for the silence
    // check, but ARMING is gated on the ack specifically.
    socket.on('device:heartbeat-ack', function (d) { livenessConfirmed = true; if (d) ingestClockSample(d.server_ms, d.client_ms); });

    socket.on('device:paired', function () {
      del(LS.code); clearToast(); show(elStage);
    });

    socket.on('device:unpaired', function () {
      del(LS.id); del(LS.token); del(LS.code); del(LS.payload);
      deviceId = null; deviceToken = null;
      // FIX F — back off 3s before re-registering, symmetric with the auth-error path below,
      // so a repeatedly-unpaired device (e.g. MDM re-pair churn) can't tight-loop
      // register -> unpaired -> register.
      scheduleRegister(3000);
    });

    socket.on('device:auth-error', function (data) {
      // #118: NEVER sticky. A transient pre-register rejection must self-clear, not paint
      // a permanent strip over still-playing content. Stop the heartbeat so a rejected beat
      // can't sustain a reject -> auth-error loop.
      authenticated = false;
      stopHeartbeat();
      toast((data && data.error) ? data.error : 'Auth error', false);
      // Bad/stale token or fingerprint-reclaim block: drop creds and re-pair.
      del(LS.id); del(LS.token); del(LS.payload); // A2: clear cached content when identity is lost
      deviceId = null; deviceToken = null;
      scheduleRegister(3000);
    });

    socket.on('device:playlist-update', onPlaylist);

    // ---- remote control from the dashboard (#120 / #121 / #125) ----
    // Mirror the web/Android player. The server emits device:command with the set in
    // server/routes/device-groups.js (ALLOWED_COMMANDS) plus 'refresh', and the
    // screenshot/remote events below. (The old device:reload listener was dead — the
    // server never emits it — so 'refresh' replaces it.)
    //
    // #125: reboot / screen power / shutdown now go through STDeviceControl, which
    // drives the real Samsung b2bcontrol/systemcontrol surface on a partner-signed
    // panel. Where that surface is absent (web / URL-Launcher / consumer TV), it
    // resolves { supported:false } and we fall back to the local black overlay for
    // screen_off so the command still does something visible.
    socket.on('device:command', function (data) {
      var type = (data && data.type) ? String(data.type).toLowerCase() : '';
      var payload = (data && data.payload) ? data.payload : null;
      if (!type) return;

      // "Wake" intents always clear any black overlay and re-assert screen-awake,
      // independent of (and in addition to) the panel API.
      if (type === 'screen_on' || type === 'launch') { clearScreenOff(); keepAwake(); }

      // Volume is handled here, not in STDeviceControl: it is not a Samsung fleet-control action
      // and it must work on EVERY build, not only a partner-signed panel. Previously it fell
      // through to STDeviceControl's default case and was answered "unknown command" — the
      // dashboard slider did nothing on Tizen at all.
      if (type === 'set_volume') { applyVolume(payload); return; }

      if (!window.STDeviceControl) { reportCmd('error', type, 'device-control unavailable'); return; }
      STDeviceControl.run(type, payload).then(function (res) {
        var note = res.note;
        // No real panel-power surface: keep the pre-#125 behaviour — a black overlay
        // (content keeps running behind it) — so screen_off isn't a silent no-op.
        if (type === 'screen_off' && res.supported === false) {
          showScreenOff();
          res = { ok: true, supported: true, reload: false };
          note = 'no panel API — black overlay fallback';
        }
        var level = res.ok ? 'info' : (res.supported === false ? 'warn' : 'error');
        reportCmd(level, type, note || (res.ok ? 'ok' : 'failed'));
        // Delay the reload so the log/result emit reaches the server first.
        if (res.reload) setTimeout(function () { location.reload(); }, 1200);
      });
    });

    // #120: dashboard preview — single shot and start/stop streaming.
    socket.on('device:screenshot-request', function () { captureAndSend(); });
    socket.on('device:remote-start', function () { startStreaming(); });
    socket.on('device:remote-stop', function () { stopStreaming(); });

    // Dashboard remote control (parity with the web player) — touch injection + D-pad/volume/mute keys
    // + real-time per-item mute. All wrapped so a malformed payload can never wedge the socket.
    socket.on('device:remote-touch', function (data) {
      try {
        if (!data) return;
        var x = (data.x || 0) * elStage.offsetWidth, y = (data.y || 0) * elStage.offsetHeight;
        var el = document.elementFromPoint(x, y);
        if (el && el.click) el.click();
      } catch (e) {}
    });
    socket.on('device:remote-key', function (data) {
      try {
        if (!data) return;
        var v = player.getCurrentVideo();
        var n = player.getItemCount();
        switch (data.keycode) {
          case 'KEYCODE_DPAD_RIGHT': player.advance(); break;
          case 'KEYCODE_DPAD_LEFT':  if (n > 0) player.gotoIndex((player.getIndex() - 1 + n) % n); break;
          case 'KEYCODE_DPAD_CENTER':
          case 'KEYCODE_ENTER':      if (v) { if (v.paused) v.play(); else v.pause(); } break;
          case 'KEYCODE_VOLUME_UP':  if (v && !player.isWallFollower()) { v.volume = Math.min(1, v.volume + 0.1); v.muted = false; } break;
          case 'KEYCODE_VOLUME_DOWN': if (v) { v.volume = Math.max(0, v.volume - 0.1); } break;
          case 'KEYCODE_MENU':       if (v && !(player.isWallFollower() && v.muted)) { v.muted = !v.muted; } break;
          case 'KEYCODE_HOME':       if (n > 0) player.gotoIndex(0); break;
          case 'KEYCODE_BACK':       toggleInfoOverlay(); break;
          case 'KEYCODE_POWER':      if (document.getElementById('screenOffOverlay')) clearScreenOff(); else showScreenOff(); break;
        }
      } catch (e) {}
    });
    // #129 real-time per-item mute — apply immediately if the toggled item is the one on screen now.
    socket.on('device:mute-changed', function (data) {
      try {
        var item = player.getCurrentItem();
        var v = player.getCurrentVideo();
        if (!data || !item || !data.content_id || item.content_id !== data.content_id) return;
        // `v` is null for a YouTube item — it is an iframe, not a <video> — so this handler did
        // nothing at all for the one content type people most often want muted.
        if (v) { v.muted = !!data.muted; return; }
        if (item.mime_type === 'video/youtube') player.setYouTubeMuted(!!data.muted);
      } catch (e) {}
    });

    // ---- video wall sync (mirrors the web player) ----
    // Leader broadcasts position; followers align index + drift-correct their video.
    socket.on('wall:sync', function (d) { wallController.onSync(d); });
    socket.on('wall:sync-request', function (d) { wallController.onSyncRequest(d); });
    // #group-sync: clock/schedule — no leader relay. Server only nudges an immediate re-align.
    socket.on('group:resync', function (d) {
      if (!groupSync.active()) return;
      if (d && d.group_id && d.group_id !== groupSync.groupId) return;
      reportSync('info', 'manual resync requested'); groupSync.tick();
    });

    // #109: PiP overlay — a pushed floating layer above the playlist. The player
    // fetches the uri itself (same trust model as remote_url content).
    socket.on('device:pip-show', function (d) { pipOverlay.show(d); });
    socket.on('device:pip-clear', function (d) { pipOverlay.clear(d && d.pip_id); });
  }

  function register() {
    var msg = { device_info: deviceInfo(), fingerprint: fingerprint() };
    // v4 client identity block — additive, canonical snake_case (same field shape as the APK, so the
    // server consumes one thing). Backward-compatible: an old server ignores unknown fields.
    msg.client_type = 'wgt';
    msg.client_version = APP_VERSION;             // config.xml version (stamped by build-wgt.sh)
    msg.platform = 'Tizen ' + (tizenVersion() || '');
    msg.contract_version = 'v4';
    // What this player can ACTUALLY do, probed at runtime (js/capabilities.js). The dashboard hides
    // every control we do not declare, so a Tizen panel stops showing buttons for things the
    // platform cannot honour. Omitted entirely if the module failed to load: the server then falls
    // back to its per-platform baseline, which is the right behaviour for an older .wgt and much
    // better than declaring an empty set, which would read as "supports nothing".
    try { if (window.STCapabilities) msg.capabilities = STCapabilities.detect(); } catch (e) {}
    if (deviceId && deviceToken) { msg.device_id = deviceId; msg.device_token = deviceToken; }
    else { msg.pairing_code = pairingCode(); }
    socket.emit('device:register', msg);
  }

  function showPairing() {
    elPairCode.textContent = pairingCode();
    show(elPairing);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      // #118: only beat on a socket that finished device:register, or the server's
      // requireDeviceAuth() rejects the beat with device:auth-error.
      if (!socket || !socket.connected || !deviceId || !authenticated) return;
      socket.emit('device:heartbeat', { device_id: deviceId, client_ms: Date.now(), telemetry: telemetry() });
      // FIX C — every 4th beat (~60s) ask for a fresh playlist by re-emitting device:register;
      // the server responds with a fresh device:playlist-update (deviceSocket.js). This was
      // previously a duplicate device:heartbeat (comment != code), so the .wgt had NO working
      // fallback refresh and relied entirely on server push. Matches the Android player.
      if ((++beatCount % 4) === 0) register();
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ---- remote control + dashboard preview (#120 / #121) ----
  // Screen on/off uses a black overlay (a sideloaded web app can't power the panel
  // off cleanly), mirroring the web player.
  // Volume, 0-100 from the dashboard.
  //
  // Prefers tizen.tvaudiocontrol — that is the TV's OWN volume, so it applies to whatever is
  // playing including AVPlay video, which lives on a hardware plane the media elements know
  // nothing about. Setting el.volume alone would leave portrait video at full blast.
  //
  // Falls back to the media elements where the TV profile is absent (URL-Launcher / browser
  // context), and remembers the level so items mounted LATER inherit it — media elements are
  // created per item, so a one-shot set would last only until the playlist advanced.
  var mediaVolume = null;   // 0..1, null = never set

  /*
   * ⚠️ THE WIRE FORMAT IS `level`, AND IT IS A 0..1 FRACTION.
   *
   * That is what the dashboard sends — `sendCommand(id, 'set_volume', { level: value / 100 })` in
   * frontend/js/views/device-detail.js — and what the Android player reads (`optDouble("level")`).
   * This handler looked for `value`/`volume` as a 0..100 percentage, so it matched nothing the
   * dashboard has ever sent: every slider move reported "no usable value in payload" and changed
   * nothing, while the panel declared audio.volume as a working capability.
   *
   * Both halves had to move together, and that is the trap. Accepting `level` while still treating
   * it as a percentage turns a request for 50% into 0.5% — inaudible, indistinguishable from broken,
   * and it would have looked exactly like a fix.
   */
  function applyVolume(payload) {
    var pct;
    if (payload && payload.level !== undefined && isFinite(Number(payload.level))) {
      pct = Number(payload.level) * 100;                 // the canonical wire form: a fraction
    } else if (payload && payload.value !== undefined) {
      pct = payload.value;                               // legacy/hand-issued: already a percentage
    } else if (payload) {
      pct = payload.volume;
    }
    var n = Number(pct);
    if (!isFinite(n)) { reportCmd('warn', 'set_volume', 'no usable value in payload'); return; }
    n = Math.max(0, Math.min(100, n));
    mediaVolume = n / 100;

    var tv = null;
    try { tv = window.STCapabilities ? STCapabilities.tvAudio() : null; } catch (e) {}
    if (tv) {
      try {
        tv.setVolume(Math.round(n));
        reportCmd('info', 'set_volume', 'TV volume set to ' + Math.round(n) + '% (tvaudiocontrol)');
        return;
      } catch (e) {
        // Fall through to the media elements rather than reporting success for nothing.
        reportCmd('warn', 'set_volume', 'tvaudiocontrol refused (' + (e && e.message ? e.message : e) + ') — using media volume');
      }
    }
    applyMediaVolume();
    reportCmd('info', 'set_volume', 'media volume set to ' + Math.round(n) + '%');
  }
  function applyMediaVolume() {
    if (mediaVolume === null) return;
    try {
      var els = document.querySelectorAll('video, audio');
      for (var i = 0; i < els.length; i++) {
        try { els[i].volume = mediaVolume; } catch (e) {}
      }
    } catch (e) {}
  }
  // Media elements are created per item across several render paths, so re-apply on every 'play'.
  // Captured, because media events do not bubble.
  try {
    document.addEventListener('play', function () { applyMediaVolume(); }, true);
  } catch (e) {}

  // Blanking has to reach the HARDWARE PLANE, not just the DOM.
  //
  // A z-index overlay covers the web layer only. Portrait/flipped video runs through AVPlay
  // (#170), which composites on a separate hardware plane the DOM cannot draw over — so on a
  // portrait panel the old overlay went up and the video kept playing straight through it. The
  // screen never went dark, which is the whole point of the command. Tearing the AVPlay session
  // down is what actually blanks it; the same trap bit the BrightSign port from the other side.
  //
  // Landscape <video> is paused too: cheap, and it stops audio continuing behind a black screen.
  function showScreenOff() {
    if (!document.getElementById('screenOffOverlay')) {
      var o = document.createElement('div');
      o.id = 'screenOffOverlay';
      o.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999';
      document.body.appendChild(o);
    }
    try { if (player && player.avActive && player.avStop) player.avStop(); } catch (e) {}
    try {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) { try { vids[i].pause(); } catch (e2) {} }
    } catch (e) {}
  }
  function clearScreenOff() {
    var o = document.getElementById('screenOffOverlay');
    // Not blanked: nothing to restore, and re-mounting would restart the current item for no reason.
    if (!o) return;
    if (o.parentNode) o.parentNode.removeChild(o);
    // A torn-down AVPlay session cannot be resumed, so re-mount the current item from scratch.
    // playCurrent(), not gotoIndex(): gotoIndex early-returns when the index has not changed, so it
    // would leave a blanked portrait panel dark after screen_on.
    try { if (player && player.playCurrent) player.playCurrent(); } catch (e) {}
  }
  // Diagnostic info overlay (parity with the web player). Toggled by the dashboard remote BACK key —
  // NOT the physical TV BACK (10009), which still exits to setup. A quick on-site troubleshooting panel.
  function toggleInfoOverlay() {
    var existing = document.getElementById('infoOverlay');
    if (existing) { if (existing.parentNode) existing.parentNode.removeChild(existing); return; }
    var item = (typeof player !== 'undefined' && player) ? player.getCurrentItem() : null;
    var o = document.createElement('div');
    o.id = 'infoOverlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.82);color:#e6e6e6;' +
      'font:16px/1.7 sans-serif;padding:6vh 6vw;box-sizing:border-box';
    function row(k, val) {
      return '<div><span style="color:#8ab4f8;display:inline-block;min-width:210px">' + k + '</span>' +
        (val == null || val === '' ? '—' : String(val)) + '</div>';
    }
    o.innerHTML = '<h2 style="margin:0 0 14px;color:#fff">ScreenTinker — Tizen Player</h2>' +
      row('Device ID', deviceId) +
      row('Server', serverUrl) +
      row('App version', APP_VERSION) +
      row('Connection', (socket && socket.connected) ? 'online' : 'offline') +
      row('Orientation', (player && player.orientation) || 'landscape') +
      row('Now playing', item ? (item.filename || item.widget_id || item.content_id) : 'idle') +
      row('Playlist position', player ? ((player.getIndex() + 1) + ' / ' + player.getItemCount()) : '—') +
      row('Screen', (screen.width + '×' + screen.height));
    document.body.appendChild(o);
  }
  // #109: report PiP show/clear over the existing device:log channel (tag 'pip') so it
  // surfaces in the dashboard device log. Used as the PipOverlay log callback.
  function reportPip(level, msg) {
    try {
      if (socket && deviceId) socket.emit('device:log', { device_id: deviceId, tag: 'pip', level: level, message: msg });
    } catch (e) {}
  }

  // feat/offline-cause-log: typed incident feed (device:event) — server inserts a device_events row.
  // Best-effort + auth-guarded (requireDeviceAuth rejects events on a pre-register socket).
  function emitDeviceEvent(type, reason, detail) {
    try {
      if (!socket || !socket.connected || !deviceId || !authenticated) return;
      var m = { device_id: deviceId, type: type };
      if (reason) m.reason = reason;
      if (detail) m.detail = detail;
      socket.emit('device:event', m);
    } catch (e) {}
  }

  // #125: report a command outcome to the dashboard. device:log surfaces live as
  // dashboard:device-log on the open device-detail screen; device:command-result is
  // a structured echo (harmless if the server doesn't handle it).
  function reportCmd(level, type, msg) {
    var message = '[' + type + '] ' + msg;
    try {
      if (socket && deviceId) {
        socket.emit('device:log', { device_id: deviceId, tag: 'command', level: level, message: message });
        socket.emit('device:command-result', { device_id: deviceId, type: type, level: level, message: msg });
      }
    } catch (e) {}
  }

  // #125: log the panel's control surface at startup so the dashboard shows whether
  // fleet control is actually wired (backend "none" on web / consumer TV / unsigned).
  function reportCapabilities() {
    try {
      var caps = (window.STDeviceControl && STDeviceControl.capabilities)
        ? STDeviceControl.capabilities() : { backend: 'none', reboot: false, panel: false };
      reportCmd('info', 'capabilities',
        'fleet control backend=' + caps.backend + ' reboot=' + caps.reboot + ' panel=' + caps.panel);
      // A3 observability: the keep-awake fix only actually holds the screen if these APIs resolve on the
      // TV's firmware/signing path. Surface their presence to the dashboard log so Bold can VERIFY on real
      // hardware whether keep-awake is real (vs a silent no-op) — the load-bearing check for the flap fix.
      var ka = 'keep-awake: setScreenSaver=' + !!(window.webapis && webapis.appcommon)
             + ' tizen.power=' + !!(window.tizen && tizen.power);
      reportCmd('info', 'keepawake', ka);
    } catch (e) {}
  }

  // #120: best-effort dashboard preview. The Tizen TV runtime decodes <video> onto a
  // hardware overlay plane and plays YouTube in a cross-origin <iframe>; neither can be
  // read back into a <canvas> (drawImage yields black / throws). So video/YouTube fall
  // back to a status card — the same shape as the web player's fallback — while images
  // (same-origin / CORS-ok) capture for real. This gives the dashboard a truthful frame
  // instead of a dead button.
  function captureAndSend() {
    if (!socket || !socket.connected || !deviceId || !authenticated) return;
    var canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 540;
    var ctx = canvas.getContext('2d');
    var captured = false;
    try {
      var img = elStage.querySelector('img');
      if (img && img.complete && img.naturalWidth > 0) {
        try { ctx.drawImage(img, 0, 0, 960, 540); captured = true; } catch (e) {}
      }
      if (!captured) {
        ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#3b82f6'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('ScreenTinker (Tizen)', 480, 235);
        ctx.fillStyle = '#94a3b8'; ctx.font = '16px sans-serif';
        ctx.fillText('Live preview unavailable for video / YouTube on Tizen', 480, 280);
        ctx.fillText(new Date().toLocaleTimeString(), 480, 312);
      }
    } catch (e) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 960, 540);
    }
    try {
      var base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
      if (base64 && base64.length > 100) {
        socket.emit('device:screenshot', { device_id: deviceId, image_b64: base64 });
      }
    } catch (e) {}
  }
  function startStreaming() { stopStreaming(); streamTimer = setInterval(captureAndSend, 1000); }
  function stopStreaming() { if (streamTimer) { clearInterval(streamTimer); streamTimer = null; } }

  // H4 (teardown hygiene): TRACK the register re-try so a reset/reconnect can cancel a pending late
  // register (Lens 2 found it untracked -> a stray register could fire on a fresh socket).
  var registerTimer = null;
  function scheduleRegister(delay) {
    if (registerTimer) clearTimeout(registerTimer);
    registerTimer = setTimeout(function () { registerTimer = null; register(); }, delay);
  }
  // H4: stop the per-SESSION timers/loops when leaving playback (reset / BACK-to-setup). Otherwise the
  // player loop keeps firing on the hidden stage and throws (serverUrl=null), heartbeat/stream keep
  // running, and a pending register can fire late. Keep-awake + the watchdog are LIFETIME timers
  // (guarded no-ops while off-session) and are intentionally left running. Idempotent.
  function teardownSession() {
    stopHeartbeat();
    stopStreaming();
    try { player.stop(); } catch (e) {}
    stageOwner = ''; // #162: stage cleared — next playlist must repaint
    if (registerTimer) { clearTimeout(registerTimer); registerTimer = null; }
    authenticated = false;
  }

  // ---- playback ----
  var player = new PlaylistPlayer(elStage, function () { return serverUrl.replace(/\/+$/, ''); }, function () { return deviceId || ''; });
  /* ===================== #299 offline proof-of-play =====================
   * Playback here is offline-native; reporting was not. A play that happened while the socket was
   * down was dropped at this hook and could never be recovered, so an outage left a permanent hole
   * in play_logs. Now it is kept and replayed with its REAL times once the socket returns.
   */
  var OFFLINE_PLAY_KEY = 'st_offline_plays';
  var offlinePlays = new OfflinePlayQueue();
  var offlinePlayOpen = null;
  var offlinePlayFlushing = false;
  try { offlinePlays.restore(get(OFFLINE_PLAY_KEY)); } catch (e) {}
  if (offlinePlays.size()) console.log('[play] offline backlog restored: ' + offlinePlays.size());

  function persistOfflinePlays() {
    // Storage failure must cost the backlog, never playback.
    try { set(OFFLINE_PLAY_KEY, offlinePlays.serialize()); } catch (e) {}
  }

  function flushOfflinePlays() {
    if (offlinePlayFlushing || !offlinePlays.size()) return;
    if (!socket || !socket.connected || !deviceId) return;
    var batch = offlinePlays.peekBatch();
    if (!batch.length) return;
    offlinePlayFlushing = true;
    try {
      socket.emit('device:play-event', { device_id: deviceId, event: 'play_offline', plays: batch });
    } catch (e) { offlinePlayFlushing = false; return; }
    /*
     * Cleared only after the server has had its say — dropping at send time would turn a flush
     * into a dead socket back into the same silent loss. A partly-rejected batch still clears, or
     * one unusable entry would wedge everything behind it.
     */
    setTimeout(function () {
      offlinePlays.ack(batch.map(function (p) { return p.client_event_id; }));
      persistOfflinePlays();
      offlinePlayFlushing = false;
      if (offlinePlays.size()) flushOfflinePlays();
    }, 4000);
    console.log('[play] flushed ' + batch.length + ' offline plays, ' + offlinePlays.size() + ' queued');
  }

  // Proof-of-play: forward the player's device:play-event to the server (populates play_logs / Reports).
  player.onPlayEvent = function (payload) {
    try {
      if (socket && socket.connected && deviceId) { socket.emit('device:play-event', payload); return; }
      /*
       * Offline. Remember the start; complete and queue it when the item is left. An end with no
       * matching start is discarded rather than given an invented start time — a fabricated
       * timestamp in a report is worse than a missing row.
       */
      if (!payload) return;
      if (payload.event === 'play_start') {
        offlinePlayOpen = {
          content_id: payload.content_id || null,
          widget_id: payload.widget_id || null,
          content_name: payload.content_name || null,
          started_at: Math.floor(Date.now() / 1000)
        };
      } else if (payload.event === 'play_end' && offlinePlayOpen) {
        var open = offlinePlayOpen; offlinePlayOpen = null;
        offlinePlays.add(OfflinePlayQueue.makePlay({
          client_event_id: OfflinePlayQueue.newId(),
          content_id: open.content_id,
          widget_id: open.widget_id,
          content_name: open.content_name,
          started_at: open.started_at,
          ended_at: Math.floor(Date.now() / 1000),
          completed: !!payload.completed
        }));
        persistOfflinePlays();
      }
    } catch (e) {}
  };
  // Multi-zone layout renderer (matches the Android player). app.js picks the renderer
  // per playlist-update from payload.layout; the two never run at once.
  var zoneRenderer = new ZoneRenderer(elStage, function () { return serverUrl.replace(/\/+$/, ''); }, function () { return deviceId || ''; });
  // #162: player and zoneRenderer SHARE the single #stage node. Track who currently owns it so we
  // only blank the OTHER renderer when actually switching modes — never on a same-mode unchanged
  // update, which (combined with each renderer's unchanged-sig short-circuit) used to leave the
  // stage blank. '' = neither (idle/suspended/cold start).
  var stageOwner = '';
  // Video-wall sync (mirrors the web player). Drives the single-zone player as leader or
  // follower. canEmit gates wall emits on auth+connection so a pre-register tick can't
  // trip device:auth-error (same guard rationale as the heartbeat).
  var wallController = new WallController(
    elStage, player,
    function () { return socket; },
    function () { return deviceId; },
    function () { return authenticated && !!socket && socket.connected; }
  );
  // #group-sync: clock/schedule group sync (no leader, offline-native). Separate from WallController.
  var groupSync = new GroupSyncController(player, function () { return clockOffsetMs; }, reportSync);
  // #109: PiP overlay layer. Renders into #pip (above #stage); never touches the
  // playlist. Reports show/clear over device:log (tag 'pip').
  var pipOverlay = new PipOverlay(elPip, { log: reportPip });

  // Rotate the playback stage in software for portrait / flipped signage. Tizen TVs
  // are fixed-landscape, so we rotate the CONTENT (not the panel). Values mirror the
  // dashboard: landscape / portrait / landscape-flipped / portrait-flipped.
  function mergeCustomShaders(map) {
    if (!map || typeof map !== 'object' || !window.__TRANSITION_SHADERS) return;
    for (var id in map) {
      if (Object.prototype.hasOwnProperty.call(map, id) && typeof map[id] === 'string') {
        window.__TRANSITION_SHADERS[id] = map[id];
      }
    }
  }
  function applyOrientation(o) {
    // #109: apply the SAME transform to #stage AND #pip so the overlay's corner
    // positions track the visible CONTENT, not the physical panel, in every orientation.
    orientEl(elStage.style, o);
    if (elPip) orientEl(elPip.style, o);
    // #170: the player needs the orientation so portrait/flipped VIDEO routes through AVPlay
    // (hardware-plane rotation) instead of the CSS-rotated <video> that Tizen blacks out.
    try { if (player && player.setOrientation) player.setOrientation(o); } catch (e) {}
  }
  function orientEl(s, o) {
    if (!o || o === 'landscape') {
      s.position = ''; s.top = ''; s.left = '';
      s.width = ''; s.height = ''; s.transform = ''; s.transformOrigin = '';
      return;
    }
    var deg = o === 'portrait' ? 90 : o === 'portrait-flipped' ? 270 : o === 'landscape-flipped' ? 180 : 0;
    var swap = (deg === 90 || deg === 270);
    s.position = 'absolute';
    s.top = '50%';
    s.left = '50%';
    s.width = swap ? '100vh' : '100vw';
    s.height = swap ? '100vw' : '100vh';
    s.transformOrigin = 'center center';
    s.transform = 'translate(-50%, -50%) rotate(' + deg + 'deg)';
  }

  function onPlaylist(payload) {
    if (!payload) return;
    if (payload.suspended) {
      player.stop();
      zoneRenderer.clear();
      wallController.exit();
      // #320: an operator's uploaded shaders ride in with the playlist, keyed by the ids the items
      // reference. Tizen resolves a shader from the same global the web player does, so merging is
      // the whole integration and the packaged .wgt needs no rebuild. Missing id -> hard cut, as before.
      mergeCustomShaders(payload.custom_shaders);
      applyOrientation(payload.orientation || 'landscape');
      elStage.innerHTML = '<div class="card" style="position:relative"><h1>' +
        esc(payload.message || 'Display suspended') + '</h1><p class="sub">' +
        esc(payload.detail || '') + '</p></div>';
      show(elStage);
      stageOwner = ''; // suspended card owns the stage; force a repaint when we resume
      return;
    }
    // A2: cache the last RENDERABLE payload so a reboot / WS-outage with no connectivity replays it
    // instead of showing the idle card. Only non-suspended payloads are cached.
    try { set(LS.payload, JSON.stringify(payload)); } catch (e) {}
    // ...and cache the CONTENT the payload points at, which is the half that was missing. A playlist
    // that survives an outage and media that does not just means the panel knows precisely what it
    // cannot show. Deferred off the render path: the sweep is synchronous and this call arrives
    // while the stage is being repainted.
    // (The doubled braces this block used to carry were a templating artifact, not syntax: `{{ }}`
    // parses as a block inside a block, so it ran correctly and read as a typo in eight places.)
    try {
      if (!window.__stMediaCache && window.MediaCache) window.__stMediaCache = window.MediaCache.create();
      var mc = window.__stMediaCache;
      if (mc && serverUrl) {
        var mcItems = payload.assignments || [];
        var mcBase = serverUrl.replace(/\/+$/, '');
        setTimeout(function () {
          mc.sync(mcItems, function (it) {
            return mcBase + '/api/content/' + it.content_id + '/file'
              + (it.content_rev ? '?rev=' + encodeURIComponent(it.content_rev) : '');
          });
        }, 2000);
      }
    } catch (e) { /* caching must never break the payload path */ }
    // If we have content + we're paired, make sure we're on the stage.
    if (elPairing.classList.contains('hidden') === false) show(elStage);
    else if (elStage.classList.contains('hidden')) show(elStage);

    // default/standby content: the server resolves the device's fallback image and sends it top-level
    // (null/absent when unset). Stash it on the player so the idle sinks (idle/nothingScheduled) can show
    // it INSTEAD of the "nothing scheduled" card. It is NOT a playlist item — it never enters assignments
    // or the sig, so it can't restart playback.
    player.defaultContent = payload.default_content || null;

    if (payload.wall_config) {
      // Video wall: fullscreen content mapped into this screen's slice. No multi-zone,
      // and no orientation transform — the wall geometry owns the stage. Wall renders via
      // the single-zone player, so it OWNS the stage like 'player'.
      // #162: only blank the zone renderer when switching away from it, and invalidate the
      // player's sig so it repaints (see the single-zone branch for the full rationale).
      if (stageOwner !== 'player') { zoneRenderer.clear(); player.invalidate(); }
      groupSync.exit();                 // wall and group are mutually exclusive
      player.setScheduleDriven(false);  // #157: wall gates on wallFollower, not scheduleDriven
      wallController.apply(payload.wall_config);
      player.setTimezone(payload.timezone || null);
      player.load(payload.assignments || [], payload.playback_order);
      stageOwner = 'player';
      return;
    }

    // #group-sync: not a wall — enter clock/schedule group sync if the payload carries a group_sync
    // block, else leave it. No leader/relay: the schedule tick drives index+position locally, so it
    // keeps running offline. Content renders through the normal path below (per-item mute honored).
    wallController.exit();   // never in wall mode here
    if (payload.group_sync) groupSync.apply(payload.group_sync.group_id);
    else groupSync.exit();
    // #157: group-sync advances via its own tick, so suppress the solo deferred-rotation there.
    player.setScheduleDriven(!!payload.group_sync);
    // #320: an operator's uploaded shaders ride in with the playlist, keyed by the ids the items
    // reference. Tizen resolves a shader from the same global the web player does, so merging is
    // the whole integration and the packaged .wgt needs no rebuild. Missing id -> hard cut, as before.
    mergeCustomShaders(payload.custom_shaders);
    applyOrientation(payload.orientation || 'landscape');
    var layout = payload.layout;
    if (layout && Array.isArray(layout.zones) && layout.zones.length) { // B3: non-array zones would throw in zoneRenderer
      // Multi-zone layout (matches the Android player). Leave single-zone mode first — but only
      // when we were actually in it, else stopping the player blanks the shared #stage and the
      // zone renderer's unchanged-sig guard then declines to repaint (#162).
      if (stageOwner !== 'zones') { player.stop(); zoneRenderer.invalidate(); }
      zoneRenderer.setTimezone(payload.timezone || null); // #74/#75: effective tz
      zoneRenderer.setPlaybackOrder(payload.playback_order || 'sequential');
      zoneRenderer.render(layout, payload.assignments || []);
      stageOwner = 'zones';
    } else {
      // Fullscreen single zone. player & zoneRenderer SHARE #stage. Blanking the zone renderer on
      // EVERY update and then hitting player.load()'s unchanged-sig `return` stranded the stage
      // blank — permanent for a single looping item (no advance timer to self-heal) and firing
      // ~every 60s on the heartbeat re-register (#162). Only blank the zone renderer when switching
      // away from it, and invalidate the player's sig so it repaints on the switch.
      if (stageOwner !== 'player') { zoneRenderer.clear(); player.invalidate(); }
      player.setTimezone(payload.timezone || null); // #74/#75: effective tz for schedule eval
      player.load(payload.assignments || [], payload.playback_order);
      stageOwner = 'player';
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---- setup screen wiring ----
  if (serverUrl) elUrl.value = serverUrl;
  elConnect.addEventListener('click', doConnect);
  elUrl.addEventListener('keydown', function (e) { if (e.keyCode === 13) doConnect(); });
  function doConnect() {
    var v = (elUrl.value || '').trim();
    if (!v) { elSetupStatus.textContent = 'Enter a server URL'; return; }
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    serverUrl = v; set(LS.url, serverUrl);
    elSetupStatus.className = 'status';
    elSetupStatus.textContent = 'Connecting…';
    connect();
  }
  elReset.addEventListener('click', function () {
    del(LS.url); del(LS.id); del(LS.token); del(LS.code); del(LS.payload);
    deviceId = null; deviceToken = null; serverUrl = null;
    if (socket) { try { socket.disconnect(); } catch (e) {} }
    teardownSession(); // H4: stop heartbeat/stream/player-loop + pending register (no dangling timers on setup)
    show(elSetup);
  });

  // TV remote RETURN key (10009).
  //
  // Samsung certification (CO-US-05, "Terminating Applications"): on the application's home page,
  // Return must exit — ideally after a confirmation popup. For a paired TV the playback stage IS
  // the home page (boot lands on it), and Return used to drop the operator onto the Server URL
  // form instead, which a QA tester reads as "Return does not exit". So: on the stage and the
  // pairing screen, Return opens a three-way popup (Exit / Change server / Cancel) that the D-pad
  // can drive; "Change server" is the old behaviour. On the setup screen — the first thing an
  // unpaired TV shows — Return exits directly, as before. The Exit key (10182) is deliberately
  // not handled anywhere: Samsung asks that it stay with the platform.
  function exitApp(reason) {
    stopKeepAwake(); stopWatchdog(); // FIX A/B: clear timers cleanly before the app exits
    sendExitSignal('clean_exit', reason); // exit-signal: operator-initiated exit = confident clean_exit
    try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
  }
  function backToServerPrompt() {
    if (socket) { try { socket.disconnect(); } catch (x) {} }
    teardownSession(); // H4: same clean teardown when BACK returns to setup
    elUrl.value = serverUrl || '';
    elSetupStatus.textContent = ''; elSetupStatus.className = 'status';
    show(elSetup); elUrl.focus();
  }
  var elExitDialog = document.getElementById('exitDialog');
  var exitButtons = Array.prototype.slice.call(elExitDialog.querySelectorAll('button'));
  var exitFocus = 0;
  function exitDialogOpen() { return !elExitDialog.classList.contains('hidden'); }
  function focusExitButton(i) {
    exitFocus = (i + exitButtons.length) % exitButtons.length;
    try { exitButtons[exitFocus].focus(); } catch (x) {}
  }
  function openExitDialog() { elExitDialog.classList.remove('hidden'); focusExitButton(0); }
  function closeExitDialog() { elExitDialog.classList.add('hidden'); }
  function exitDialogAction(action) {
    closeExitDialog();
    if (action === 'exit') exitApp('back_key');
    else if (action === 'server') backToServerPrompt();
  }
  exitButtons.forEach(function (b) {
    b.addEventListener('click', function () { exitDialogAction(b.getAttribute('data-action')); });
  });
  document.addEventListener('keydown', function (e) {
    if (exitDialogOpen()) {
      // The popup owns every key while it is up; nothing leaks to the stage or the URL field.
      if (e.keyCode === 10009) { closeExitDialog(); }
      else if (e.keyCode === 37 || e.keyCode === 38) { focusExitButton(exitFocus - 1); }
      else if (e.keyCode === 39 || e.keyCode === 40) { focusExitButton(exitFocus + 1); }
      else if (e.keyCode === 13) { exitDialogAction(exitButtons[exitFocus].getAttribute('data-action')); }
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.keyCode === 10009) { // Samsung RETURN / BACK
      if (!elSetup.classList.contains('hidden')) exitApp('back_key');
      else openExitDialog();
    }
  }, true);

  // ---- boot ----
  // Always reach the server prompt until the display is actually paired. Only a
  // fully provisioned device (has a saved device_id + token) goes straight to
  // playback; otherwise show the setup screen and ask for / confirm the server.
  startKeepAwake();                                          // FIX A: assert + re-assert keep-awake on an interval
  document.addEventListener('visibilitychange', onVisibility); // FIX B: suspend/resume fast-path
  startWatchdog();                                           // FIX B (hardened): server-silence liveness backstop

  // feat/offline-cause-log: display sleep / backgrounding proxy — screen off/on on a TV.
  document.addEventListener('visibilitychange', function () {
    emitDeviceEvent(document.hidden ? 'display_off' : 'display_on');
  });
  // feat/offline-cause-log: browser-side offline detection feeds link_lost on the next reconnect — if
  // navigator goes offline during a disconnect gap, the drop was the local link (Wi‑Fi/Ethernet).
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('offline', function () { if (disconnectedAtMono) linkLostDuringGap = true; });
  }

  // @exit-signal-slice:start — v4-exit-signal-phase3.test.js evals the lines between these markers.
  // Exit-signal contract v1 — best-effort last gasp. crashed: window.onerror / unhandledrejection.
  // clean_exit: operator BACK-key exit (below) + pagehide(persisted=false, a real unload not a bfcache
  // suspend). Sends over BOTH the live socket (reliable when still connected, e.g. BACK-key / in-app
  // crash) AND navigator.sendBeacon (reliable-on-unload — Chromium webview); the server dedups. Honesty:
  // only these two confident categories; uncertain -> nothing -> server infers 'silent'. A Tizen system/
  // launcher terminate fires NO hook here -> correctly falls to 'silent'. Idempotent (first wins).
  var __exitSent = false;
  function sendExitSignal(reason, detail) {
    try {
      if (__exitSent) return;
      if (reason !== 'crashed' && reason !== 'clean_exit') return;
      if (!deviceId || !deviceToken || !serverUrl) return;              // unpaired -> nothing to attribute
      __exitSent = true;
      var d = (typeof detail === 'string' && detail) ? detail.slice(0, 200) : undefined;
      if (socket && socket.connected) { try { socket.emit('device:exit', { device_id: deviceId, reason: reason, detail: d }); } catch (e) {} }
      if (navigator.sendBeacon) {
        var body = JSON.stringify({ device_id: deviceId, device_token: deviceToken, reason: reason, detail: d });
        navigator.sendBeacon(serverUrl.replace(/\/+$/, '') + '/api/device/exit', new Blob([body], { type: 'application/json' }));
      }
    } catch (e) { /* a dying app must never throw */ }
  }
  window.addEventListener('error', function (ev) {
    if (!ev) return;
    var isResourceError = ev.target && ev.target !== window && (ev.target.src || ev.target.href); // img/script load fail is NOT a crash
    if (isResourceError) return;
    sendExitSignal('crashed', (ev.error && ev.error.message) || ev.message || 'error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    sendExitSignal('crashed', (r && (r.message || String(r))) || 'unhandledrejection');
  });
  window.addEventListener('pagehide', function (ev) {
    if (ev && ev.persisted) return;   // bfcache suspend (may restore) — NOT a death; the watchdog owns it
    sendExitSignal('clean_exit', 'pagehide');
  });
  // @exit-signal-slice:end
  if (serverUrl && deviceId && deviceToken) {
    // A2: render cached content IMMEDIATELY so a cold-start/offline TV isn't blank while the socket
    // connects (or if it can't). The socket's fresh device:playlist-update replaces it on connect.
    show(elStage);
    var _cp = get(LS.payload);
    if (_cp) { try { onPlaylist(JSON.parse(_cp)); } catch (e) {} }
    connect();                                      // paired — reconnect to playback
  } else if (serverUrl) {
    show(elSetup); elUrl.value = serverUrl;          // server known, not paired — confirm + connect
    elSetupStatus.className = 'status';
    elSetupStatus.textContent = 'Connecting…';
    connect();
  } else {
    show(elSetup); elUrl.focus();                    // first run — ask for the server
  }

  // Expose for debugging
  window.__st = { connect: connect, reset: function () { elReset.click(); } };
})();
