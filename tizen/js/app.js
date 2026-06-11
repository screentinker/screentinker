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

  var APP_VERSION = '1.0.0';
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
    socket.on('disconnect', function () { toast('Reconnecting…', true); });

    socket.on('device:registered', function (data) {
      deviceId = data.device_id; deviceToken = data.device_token;
      set(LS.id, deviceId); set(LS.token, deviceToken);
      startHeartbeat();
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
      // Bad/stale token or fingerprint-reclaim block: drop creds and re-pair.
      toast((data && data.error) ? data.error : 'Auth error', true);
      del(LS.id); del(LS.token);
      deviceId = null; deviceToken = null;
      setTimeout(register, 3000);
    });

    socket.on('device:playlist-update', onPlaylist);

    // Optional remote commands the dashboard may send (best-effort)
    socket.on('device:reload', function () { location.reload(); });
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function () {
      if (!socket || !deviceId) return;
      socket.emit('device:heartbeat', { device_id: deviceId, telemetry: telemetry() });
      // Every 4th beat (~60s) ask for a fresh playlist, matching the Android player.
      if ((++beatCount % 4) === 0) socket.emit('device:heartbeat', { device_id: deviceId, telemetry: telemetry() });
    }, HEARTBEAT_MS);
  }

  // ---- playback ----
  var player = new PlaylistPlayer(elStage, function () { return serverUrl.replace(/\/+$/, ''); });

  // Rotate the playback stage in software for portrait / flipped signage. Tizen TVs
  // are fixed-landscape, so we rotate the CONTENT (not the panel). Values mirror the
  // dashboard: landscape / portrait / landscape-flipped / portrait-flipped.
  function applyOrientation(o) {
    var s = elStage;
    if (!o || o === 'landscape') {
      s.style.position = ''; s.style.top = ''; s.style.left = '';
      s.style.width = ''; s.style.height = ''; s.style.transform = ''; s.style.transformOrigin = '';
      return;
    }
    var deg = o === 'portrait' ? 90 : o === 'portrait-flipped' ? 270 : o === 'landscape-flipped' ? 180 : 0;
    var swap = (deg === 90 || deg === 270);
    s.style.position = 'absolute';
    s.style.top = '50%';
    s.style.left = '50%';
    s.style.width = swap ? '100vh' : '100vw';
    s.style.height = swap ? '100vw' : '100vh';
    s.style.transformOrigin = 'center center';
    s.style.transform = 'translate(-50%, -50%) rotate(' + deg + 'deg)';
  }

  function onPlaylist(payload) {
    if (!payload) return;
    applyOrientation(payload.orientation || 'landscape');
    if (payload.suspended) {
      player.stop();
      elStage.innerHTML = '<div class="card" style="position:relative"><h1>' +
        esc(payload.message || 'Display suspended') + '</h1><p class="sub">' +
        esc(payload.detail || '') + '</p></div>';
      show(elStage);
      return;
    }
    // If we have content + we're paired, make sure we're on the stage.
    if (elPairing.classList.contains('hidden') === false) show(elStage);
    else if (elStage.classList.contains('hidden')) show(elStage);
    player.setTimezone(payload.timezone || null); // #74/#75: effective tz for schedule eval
    player.load(payload.assignments || []);
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
