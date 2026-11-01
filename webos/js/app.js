/*
 * ScreenTinker webOS shell.
 *
 * The web player (/player on the ScreenTinker server) does the playing. This app gives it what
 * a page in a browser cannot have on an LG signage panel: an installed launcher that starts on
 * boot, a place to enter the server address with the remote, and a bridge to the panel's power
 * and update services (js/device-control.js). The player runs in an iframe; the two talk over
 * postMessage, and only what the panel can genuinely do is announced to the player, which
 * declares exactly that to the server.
 *
 * Protocol (player -> shell): { source:'screentinker-player', type:'host:hello' }
 *                             { source:'screentinker-player', type:'host:command', action, payload }
 *          (shell -> player): { source:'screentinker-host', type:'host:ready', platform, capabilities, info }
 *                             { source:'screentinker-host', type:'host:result', action, ok, error }
 */
(function () {
  'use strict';
  var APP_VERSION_FALLBACK = '3.1.1';   // stamped from appinfo.json by build-ipk.sh
  // The file this build is published as, and so the one it updates itself from. build-ipk.sh
  // stamps it: ScreenTinker.ipk, or com.lg.app.signage.ipk for the Local application mode build.
  var IPK_FILE = 'ScreenTinker.ipk';
  var KEY_SERVER = 'st_server_url';
  var KEY_UPDATE_TRIED = 'st_update_tried';
  var BACK_KEY = 461;                    // webOS remote "Back"
  var UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
  // Baked default so a fresh panel plays with nothing typed. A value entered on the remote, or
  // shipped in config.json, still wins over it (see boot). Hard-coded to the hosted service.
  var DEFAULT_SERVER = 'https://screentinker.com';
  // The player posts host:hello within a second or two of loading in the frame. If it has not by
  // the time below, the load stalled or failed: no network yet at boot or wake-from-standby, LG's
  // native "CHECK NETWORK CONNECTION (-106)" overlay, or a blank frame on the shell's black
  // background. Remount and keep trying, backing off to the cap, so a panel heals itself instead
  // of sitting dark until a human presses RETRY. host:hello is reliable here because the player
  // only skips it when it is the TOP-LEVEL window; in our iframe it always sends.
  var PLAYER_HELLO_MS = 25000;           // grace for the first/each mount to come up
  var RETRY_MAX_MS = 60000;              // cap on the growing wait between remounts

  var $ = function (id) { return document.getElementById(id); };
  var frame = null;
  var serverUrl = '';
  var packagedConfig = null;
  var playerReady = false;               // flipped by host:hello from the player in the frame
  var helloTimer = null;                 // watchdog: remounts the frame if host:hello never comes
  var helloWait = PLAYER_HELLO_MS;       // grows each failed mount, reset when the player comes up

  function log(m) { try { console.log('[st-shell] ' + m); } catch (e) {} }

  // The server address typed on the remote ends up as the player iframe's src. Rebuilt behind a
  // LITERAL scheme, never kept as typed, so it can only ever be an http(s) URL: a typed
  // "javascript:…" becomes the harmless host name "javascript" instead of script in the app's origin.
  function normaliseUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    var m = /^(https?):\/\/(.*)$/i.exec(u);
    var scheme = m && m[1].toLowerCase() === 'https' ? 'https://' : 'http://';
    var rest = (m ? m[2] : u).replace(/\/+$/, '');
    // Parse as a URL and return a value DERIVED from it, only behind a positive
    // http(s) protocol guard, so a javascript:/data: URI typed into the server
    // field or planted in localStorage can never reach iframe.src. Returning the
    // URL-derived string (not the raw input) is what makes this an actual
    // sanitizer on the value that flows to the sink (#833, js/xss-through-dom).
    try {
      var p = new URL(scheme + rest);
      if (p.protocol === 'http:' || p.protocol === 'https:') {
        return (p.origin + p.pathname).replace(/\/+$/, '');
      }
    } catch (e) { /* fall through to '' */ }
    return '';
  }

  // A config.json next to the app wins over nothing, and a value typed on the remote wins over
  // it: fleets deployed from an SI server ship the address in the package; a single panel is
  // typed in once.
  function loadPackagedConfig() {
    return fetch('config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { packagedConfig = j || null; return packagedConfig; })
      .catch(function () { packagedConfig = null; return null; });
  }

  function storedServer() { try { return localStorage.getItem(KEY_SERVER) || ''; } catch (e) { return ''; } }
  function storeServer(u) { try { localStorage.setItem(KEY_SERVER, u); } catch (e) {} }

  // ---------------------------------------------------------------- the player frame
  function playerUrl() {
    var path = supportsModernPlayer() ? '/player' : '/player/legacy';
    return serverUrl + path + '?host=webos&v=' + encodeURIComponent(APP_VERSION_FALLBACK);
  }

  function supportsModernPlayer() {
    try { return Function('return ({ value: 1 })?.value ?? 0')() === 1; } catch (e) { return false; }
  }

  function supportsLegacyPlayer() {
    try { return Function('const value = `ok`; return (() => value)()')() === 'ok'; } catch (e) { return false; }
  }

  function mountPlayer() {
    var stage = $('stage');
    if (frame) { try { stage.removeChild(frame); } catch (e) {} frame = null; }
    playerReady = false;
    frame = document.createElement('iframe');
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    frame.src = playerUrl();
    stage.appendChild(frame);
    $('setup').classList.add('hidden');
    showStatus();            // anything but a black screen while the frame loads
    armHelloWatchdog();      // retry the mount if the player never reports in
    log('player mounted: ' + frame.src);
  }

  // The player reached the server and started. Stop the watchdog and clear the connecting screen.
  function markPlayerReady() {
    playerReady = true;
    helloWait = PLAYER_HELLO_MS;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    hideStatus();
  }

  function armHelloWatchdog() {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(function () {
      helloTimer = null;
      if (playerReady) return;
      log('player did not report in ' + helloWait + 'ms; remounting');
      showStatus('Reconnecting to the server…');
      helloWait = Math.min(Math.round(helloWait * 1.5), RETRY_MAX_MS);
      mountPlayer();         // reschedules its own watchdog
    }, helloWait);
  }

  function showStatus(msg) {
    var s = $('status'); if (!s) return;
    var m = $('statusMsg'); if (m) m.textContent = msg || 'Connecting to the server…';
    var h = $('statusHint'); if (h) h.textContent = String(serverUrl || '').replace(/^https?:\/\//, '');
    s.classList.remove('hidden');
  }
  function hideStatus() { var s = $('status'); if (s) s.classList.add('hidden'); }

  // ---------------------------------------------------------------- the bridge
  function post(msg) {
    if (!frame || !frame.contentWindow) return;
    msg.source = 'screentinker-host';
    try { frame.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  function announce() {
    var caps = (window.STWebOS && STWebOS.capabilities()) || [];
    var infoP = (window.STWebOS && STWebOS.platformInfo()) || Promise.resolve({});
    infoP.then(function (info) {
      post({ type: 'host:ready', platform: 'webos', version: APP_VERSION_FALLBACK, capabilities: caps, info: info || {} });
      log('announced caps=' + caps.join(',') + ' model=' + (info && info.model));
    });
  }

  function onCommand(action, payload) {
    if (!window.STWebOS) return post({ type: 'host:result', action: action, ok: false, error: 'unsupported' });
    var p = payload || {};
    if (action === 'update' && !p.url) p.url = serverUrl + '/webos/' + IPK_FILE;
    STWebOS.run(action, p).then(function () {
      post({ type: 'host:result', action: action, ok: true });
    }, function (e) {
      post({ type: 'host:result', action: action, ok: false, error: (e && e.message) || String(e) });
      log(action + ' failed: ' + ((e && e.message) || e));
    });
  }

  window.addEventListener('message', function (ev) {
    if (!frame || ev.source !== frame.contentWindow) return;   // only our own player
    var d = ev.data;
    if (!d || d.source !== 'screentinker-player') return;
    if (d.type === 'host:hello') { markPlayerReady(); announce(); }
    else if (d.type === 'host:command' && typeof d.action === 'string') onCommand(d.action, d.payload);
  });

  // ---------------------------------------------------------------- self-update
  // Ask the server what it publishes; install when it is newer than us, once per version.
  function newer(a, b) {
    var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
  }
  function checkUpdate() {
    // 'system.self_update' is what device-control.js announces. This used to ask for system.update,
    // which nothing announces, so a panel never updated itself on its own.
    if (!serverUrl || !window.STWebOS || STWebOS.capabilities().indexOf('system.self_update') < 0) return;
    fetch(serverUrl + '/webos/version.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.version || !j.available) return;
        // A server that predates `files` only publishes ScreenTinker.ipk.
        if (j.files ? !j.files[IPK_FILE] : IPK_FILE !== 'ScreenTinker.ipk') return;
        if (!newer(j.version, APP_VERSION_FALLBACK)) return;
        var tried = '';
        try { tried = localStorage.getItem(KEY_UPDATE_TRIED) || ''; } catch (e) {}
        if (tried === j.version) return;               // one attempt per published version
        try { localStorage.setItem(KEY_UPDATE_TRIED, j.version); } catch (e) {}
        log('update available: ' + j.version + ' (running ' + APP_VERSION_FALLBACK + ')');
        STWebOS.run('update', { url: serverUrl + '/webos/' + IPK_FILE })
          .then(function () { log('update installed'); }, function (e) { log('update failed: ' + (e && e.message)); });
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- setup screen
  function showSetup(allowCancel) {
    $('server').value = serverUrl || (packagedConfig && packagedConfig.serverUrl) || '';
    $('setupError').classList.add('hidden');
    $('cancel').classList.toggle('hidden', !allowCancel);
    $('setup').classList.remove('hidden');
    var infoP = (window.STWebOS && STWebOS.platformInfo()) || Promise.resolve({});
    infoP.then(function (info) {
      var bits = ['App v' + APP_VERSION_FALLBACK];
      if (info && info.model) bits.push(info.model);
      if (info && info.serial) bits.push('S/N ' + info.serial);
      if (info && info.firmware) bits.push('webOS ' + info.firmware);
      if (!(window.STWebOS && STWebOS.available())) bits.push('no SCAP: power and update controls unavailable');
      $('info').textContent = bits.join(' · ');
    });
    setTimeout(function () { $('server').focus(); }, 50);
  }

  function showUnsupported() {
    showSetup(false);
    $('server').disabled = true;
    $('save').disabled = true;
    $('setupError').textContent = 'This TV browser is too old for ScreenTinker. webOS 4 or newer is required.';
    $('setupError').classList.remove('hidden');
  }

  function saveSetup() {
    var u = normaliseUrl($('server').value);
    if (!u) { $('setupError').textContent = 'Enter the server address.'; $('setupError').classList.remove('hidden'); return; }
    serverUrl = u;
    storeServer(u);
    mountPlayer();
    setTimeout(checkUpdate, 15000);
  }

  // When the panel's link finally comes up (the common boot/standby-wake race), remount at once
  // instead of waiting out the watchdog. Only when the player is not already up, so a working
  // player is never disturbed by a network blip.
  window.addEventListener('online', function () {
    if (playerReady || !serverUrl) return;
    log('network online; remounting player now');
    helloWait = PLAYER_HELLO_MS;
    mountPlayer();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.keyCode === BACK_KEY || ev.key === 'GoBack') {
      ev.preventDefault();
      if ($('setup').classList.contains('hidden')) showSetup(!!serverUrl);
      else if (serverUrl) { $('setup').classList.add('hidden'); }
    }
  });

  // ---------------------------------------------------------------- boot
  function boot() {
    $('save').addEventListener('click', saveSetup);
    $('cancel').addEventListener('click', function () { $('setup').classList.add('hidden'); });
    $('server').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.keyCode === 13) saveSetup(); });
    if (!supportsLegacyPlayer()) { showUnsupported(); return; }
    loadPackagedConfig().then(function (cfg) {
      serverUrl = normaliseUrl(storedServer() || (cfg && cfg.serverUrl) || DEFAULT_SERVER);
      if (serverUrl) { mountPlayer(); setTimeout(checkUpdate, 15000); setInterval(checkUpdate, UPDATE_CHECK_MS); }
      else showSetup(false);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
