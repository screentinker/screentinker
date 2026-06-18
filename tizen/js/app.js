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
  var APP_VERSION_FALLBACK = '1.9.1'; // st:app-version — stamped by build-wgt.sh
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
    code: 'st_pairing_code'
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
    try { if (window.tizen && tizen.power) tizen.power.request('SCREEN', 'SCREEN_NORMAL'); } catch (e) {}
    try { if (window.webapis && webapis.appcommon) webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF); } catch (e) {}
  }

  // ---- networking ----
  var socket = null;
  var deviceId = get(LS.id);
  var deviceToken = get(LS.token);
  var serverUrl = get(LS.url);
  var heartbeatTimer = null;
  var beatCount = 0;
  var authenticated = false; // #118: true only between device:registered and disconnect/auth-error
  var streamTimer = null;    // #120: dashboard preview streaming interval

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

    var base = serverUrl.replace(/\/+$/, '');
    socket = io(base + '/device', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 10000
    });

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
      toast('Reconnecting…', true);
    });

    socket.on('device:registered', function (data) {
      deviceId = data.device_id; deviceToken = data.device_token;
      set(LS.id, deviceId); set(LS.token, deviceToken);
      authenticated = true; // #118: this socket may now send post-register events
      clearToast();         // #118: drop any stale "Not authenticated…" banner
      startHeartbeat();
      reportCapabilities(); // #125: surface the fleet-control backend to the dashboard
      if (data.status === 'provisioning') showPairing();
    });

    socket.on('device:paired', function () {
      del(LS.code); clearToast(); show(elStage);
    });

    socket.on('device:unpaired', function () {
      del(LS.id); del(LS.token); del(LS.code);
      deviceId = null; deviceToken = null;
      register(); // re-register fresh -> new pairing code
    });

    socket.on('device:auth-error', function (data) {
      // #118: NEVER sticky. A transient pre-register rejection must self-clear, not paint
      // a permanent strip over still-playing content. Stop the heartbeat so a rejected beat
      // can't sustain a reject -> auth-error loop.
      authenticated = false;
      stopHeartbeat();
      toast((data && data.error) ? data.error : 'Auth error', false);
      // Bad/stale token or fingerprint-reclaim block: drop creds and re-pair.
      del(LS.id); del(LS.token);
      deviceId = null; deviceToken = null;
      setTimeout(register, 3000);
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

    // ---- video wall sync (mirrors the web player) ----
    // Leader broadcasts position; followers align index + drift-correct their video.
    socket.on('wall:sync', function (d) { wallController.onSync(d); });
    socket.on('wall:sync-request', function (d) { wallController.onSyncRequest(d); });

    // #109: PiP overlay — a pushed floating layer above the playlist. The player
    // fetches the uri itself (same trust model as remote_url content).
    socket.on('device:pip-show', function (d) { pipOverlay.show(d); });
    socket.on('device:pip-clear', function (d) { pipOverlay.clear(d && d.pip_id); });
  }

  function register() {
    var msg = { device_info: deviceInfo(), fingerprint: fingerprint() };
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
      socket.emit('device:heartbeat', { device_id: deviceId, telemetry: telemetry() });
      // Every 4th beat (~60s) ask for a fresh playlist, matching the Android player.
      if ((++beatCount % 4) === 0) socket.emit('device:heartbeat', { device_id: deviceId, telemetry: telemetry() });
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ---- remote control + dashboard preview (#120 / #121) ----
  // Screen on/off uses a black overlay (a sideloaded web app can't power the panel
  // off cleanly), mirroring the web player.
  function showScreenOff() {
    if (document.getElementById('screenOffOverlay')) return;
    var o = document.createElement('div');
    o.id = 'screenOffOverlay';
    o.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999';
    document.body.appendChild(o);
  }
  function clearScreenOff() {
    var o = document.getElementById('screenOffOverlay');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }
  // #109: report PiP show/clear over the existing device:log channel (tag 'pip') so it
  // surfaces in the dashboard device log. Used as the PipOverlay log callback.
  function reportPip(level, msg) {
    try {
      if (socket && deviceId) socket.emit('device:log', { device_id: deviceId, tag: 'pip', level: level, message: msg });
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

  // ---- playback ----
  var player = new PlaylistPlayer(elStage, function () { return serverUrl.replace(/\/+$/, ''); });
  // Multi-zone layout renderer (matches the Android player). app.js picks the renderer
  // per playlist-update from payload.layout; the two never run at once.
  var zoneRenderer = new ZoneRenderer(elStage, function () { return serverUrl.replace(/\/+$/, ''); });
  // Video-wall sync (mirrors the web player). Drives the single-zone player as leader or
  // follower. canEmit gates wall emits on auth+connection so a pre-register tick can't
  // trip device:auth-error (same guard rationale as the heartbeat).
  var wallController = new WallController(
    elStage, player,
    function () { return socket; },
    function () { return deviceId; },
    function () { return authenticated && !!socket && socket.connected; }
  );
  // #109: PiP overlay layer. Renders into #pip (above #stage); never touches the
  // playlist. Reports show/clear over device:log (tag 'pip').
  var pipOverlay = new PipOverlay(elPip, { log: reportPip });

  // Rotate the playback stage in software for portrait / flipped signage. Tizen TVs
  // are fixed-landscape, so we rotate the CONTENT (not the panel). Values mirror the
  // dashboard: landscape / portrait / landscape-flipped / portrait-flipped.
  function applyOrientation(o) {
    // #109: apply the SAME transform to #stage AND #pip so the overlay's corner
    // positions track the visible CONTENT, not the physical panel, in every orientation.
    orientEl(elStage.style, o);
    if (elPip) orientEl(elPip.style, o);
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
      applyOrientation(payload.orientation || 'landscape');
      elStage.innerHTML = '<div class="card" style="position:relative"><h1>' +
        esc(payload.message || 'Display suspended') + '</h1><p class="sub">' +
        esc(payload.detail || '') + '</p></div>';
      show(elStage);
      return;
    }
    // If we have content + we're paired, make sure we're on the stage.
    if (elPairing.classList.contains('hidden') === false) show(elStage);
    else if (elStage.classList.contains('hidden')) show(elStage);

    if (payload.wall_config) {
      // Video wall: fullscreen content mapped into this screen's slice. No multi-zone,
      // and no orientation transform — the wall geometry owns the stage.
      zoneRenderer.clear();
      wallController.apply(payload.wall_config);
      player.setTimezone(payload.timezone || null);
      player.load(payload.assignments || []);
      return;
    }

    wallController.exit(); // leave wall mode if we were in it
    applyOrientation(payload.orientation || 'landscape');
    var layout = payload.layout;
    if (layout && layout.zones && layout.zones.length) {
      // Multi-zone layout (matches the Android player). Leave single-zone mode first.
      player.stop();
      zoneRenderer.setTimezone(payload.timezone || null); // #74/#75: effective tz
      zoneRenderer.render(layout, payload.assignments || []);
    } else {
      // Fullscreen single zone. Leave any previous zone layout first.
      zoneRenderer.clear();
      player.setTimezone(payload.timezone || null); // #74/#75: effective tz for schedule eval
      player.load(payload.assignments || []);
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
    del(LS.url); del(LS.id); del(LS.token); del(LS.code);
    deviceId = null; deviceToken = null; serverUrl = null;
    if (socket) { try { socket.disconnect(); } catch (e) {} }
    show(elSetup);
  });

  // TV remote BACK key (10009): from the stage/pairing screen, return to the
  // server prompt so the operator can always change the server; from setup, exit.
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009) { // Samsung RETURN / BACK
      if (!elSetup.classList.contains('hidden')) {
        try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
      } else {
        if (socket) { try { socket.disconnect(); } catch (x) {} }
        elUrl.value = serverUrl || '';
        elSetupStatus.textContent = ''; elSetupStatus.className = 'status';
        show(elSetup); elUrl.focus();
      }
    }
  });

  // ---- boot ----
  // Always reach the server prompt until the display is actually paired. Only a
  // fully provisioned device (has a saved device_id + token) goes straight to
  // playback; otherwise show the setup screen and ask for / confirm the server.
  keepAwake();
  if (serverUrl && deviceId && deviceToken) {
    show(elStage); connect();                       // paired — reconnect to playback
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
