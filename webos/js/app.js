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
  var APP_VERSION_FALLBACK = '2.0.8';   // stamped from appinfo.json by build-ipk.sh
  var KEY_SERVER = 'st_server_url';
  var KEY_UPDATE_TRIED = 'st_update_tried';
  var BACK_KEY = 461;                    // webOS remote "Back"
  var UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var frame = null;
  var serverUrl = '';
  var packagedConfig = null;

  function log(m) { try { console.log('[st-shell] ' + m); } catch (e) {} }

  function normaliseUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
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
    return serverUrl + '/player?host=webos&v=' + encodeURIComponent(APP_VERSION_FALLBACK);
  }

  function supportsModernPlayer() {
    try { return Function('return ({ value: 1 })?.value ?? 0')() === 1; } catch (e) { return false; }
  }

  function mountPlayer() {
    // webOS 4.x uses the transpiled player directly.
    if (!supportsModernPlayer()) {
      window.location.replace(serverUrl + '/player/legacy');
      return;
    }
    var stage = $('stage');
    if (frame) { try { stage.removeChild(frame); } catch (e) {} frame = null; }
    frame = document.createElement('iframe');
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    frame.src = playerUrl();
    stage.appendChild(frame);
    $('setup').classList.add('hidden');
    log('player mounted: ' + frame.src);
  }

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
    if (action === 'update' && !p.url) p.url = serverUrl + '/webos/ScreenTinker.ipk';
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
    if (d.type === 'host:hello') announce();
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
    if (!serverUrl || !window.STWebOS || STWebOS.capabilities().indexOf('system.update') < 0) return;
    fetch(serverUrl + '/webos/version.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.version || !j.available) return;
        if (!newer(j.version, APP_VERSION_FALLBACK)) return;
        var tried = '';
        try { tried = localStorage.getItem(KEY_UPDATE_TRIED) || ''; } catch (e) {}
        if (tried === j.version) return;               // one attempt per published version
        try { localStorage.setItem(KEY_UPDATE_TRIED, j.version); } catch (e) {}
        log('update available: ' + j.version + ' (running ' + APP_VERSION_FALLBACK + ')');
        STWebOS.run('update', { url: serverUrl + '/webos/ScreenTinker.ipk' })
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

  function saveSetup() {
    var u = normaliseUrl($('server').value);
    if (!u) { $('setupError').textContent = 'Enter the server address.'; $('setupError').classList.remove('hidden'); return; }
    serverUrl = u;
    storeServer(u);
    mountPlayer();
    setTimeout(checkUpdate, 15000);
  }

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
    loadPackagedConfig().then(function (cfg) {
      serverUrl = normaliseUrl(storedServer() || (cfg && cfg.serverUrl) || '');
      if (serverUrl) { mountPlayer(); setTimeout(checkUpdate, 15000); setInterval(checkUpdate, UPDATE_CHECK_MS); }
      else showSetup(false);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
