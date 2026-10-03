/*
 * ScreenTinker webOS shell - device control through LG's SCAP library.
 *
 * Everything the web player cannot do from a page: reboot the panel, cut the display, install
 * the app's own update. SCAP (Signage Common Application Platform) is LG's JavaScript layer over
 * the panel's Luna services, shipped with the webOS Signage SDK and loaded by index.html from
 * vendor/. The classes it exposes are Cordova plugins: `Power`, `Storage`, `DeviceInfo`,
 * `Configuration`, either as globals or through cordova.require().
 *
 * Safe to load anywhere: with no SCAP present (a desktop browser, an unsigned build, the SDK
 * files missing) every method reports "unsupported" and capabilities() is empty, so the
 * dashboard hides the buttons rather than showing ones that cannot work. Nothing here throws.
 *
 * Verified against SCAP 1.2 method names (Power.executePowerCommand, Power.setDisplayMode,
 * Storage.copyFile, Storage.upgradeApplication, DeviceInfo.getPlatformInfo,
 * Configuration.restartApplication). NOT yet verified on hardware.
 */
(function (global) {
  'use strict';
  var TAG = 'st-webos';

  function log(msg) { try { console.log('[' + TAG + '] ' + msg); } catch (e) {} }

  // A SCAP class, however this SDK build exposes it, or null.
  function plugin(globalName, cordovaId) {
    try {
      if (typeof global[globalName] === 'function') return global[globalName];
      if (global.cordova && typeof global.cordova.require === 'function') {
        var m = global.cordova.require(cordovaId);
        if (typeof m === 'function') return m;
      }
    } catch (e) {}
    return null;
  }
  function Power() { return plugin('Power', 'cordova/plugin/power'); }
  function Storage() { return plugin('Storage', 'cordova/plugin/storage'); }
  function DeviceInfo() { return plugin('DeviceInfo', 'cordova/plugin/deviceInfo'); }
  function Configuration() { return plugin('Configuration', 'cordova/plugin/configuration'); }

  function errText(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    return (e.errorText || e.message || JSON.stringify(e));
  }

  // Promise-shaped wrapper over SCAP's (success, failure, options) convention.
  function call(Cls, method, options) {
    return new Promise(function (resolve, reject) {
      if (!Cls) return reject(new Error('unsupported'));
      var inst;
      try { inst = new Cls(); } catch (e) { return reject(new Error('unsupported: ' + errText(e))); }
      if (typeof inst[method] !== 'function') return reject(new Error('unsupported'));
      try {
        inst[method](function (r) { resolve(r); }, function (e) { reject(new Error(errText(e))); }, options || {});
      } catch (e) { reject(new Error(errText(e))); }
    });
  }

  // ---- platform identity: model, serial, firmware. Cached; a failure leaves it empty. ----
  var infoCache = null;
  function platformInfo() {
    if (infoCache) return Promise.resolve(infoCache);
    return call(DeviceInfo(), 'getPlatformInfo').then(function (r) {
      infoCache = {
        model: r && r.modelName || '',
        serial: r && r.serialNumber || '',
        firmware: r && r.firmwareVersion || '',
        sdk: r && r.sdkVersion || '',
      };
      return infoCache;
    }, function () { return { model: '', serial: '', firmware: '', sdk: '' }; });
  }

  // ---- the actions the dashboard can send, in the player's own vocabulary ----
  function reboot() { return call(Power(), 'executePowerCommand', { powerCommand: 'reboot' }); }
  function shutdown() { return call(Power(), 'executePowerCommand', { powerCommand: 'powerOff' }); }
  function screen(on) { return call(Power(), 'setDisplayMode', { displayMode: on ? 'Active' : 'Screen Off' }); }
  function restartApp() { return call(Configuration(), 'restartApplication'); }

  /*
   * Self-update: copy the IPK the server publishes into internal storage, then ask the panel
   * to upgrade the running app from it. SCAP's upgradeApplication installs from a fixed local
   * location, which is why the copy lands where it does; the exact path convention is the one
   * thing in this file that only a panel can confirm.
   */
  var UPDATE_PATH = 'file://internal/screentinker/ScreenTinker.ipk';
  function update(ipkUrl) {
    var S = Storage();
    if (!S || !ipkUrl) return Promise.reject(new Error('unsupported'));
    return call(S, 'mkdir', { path: 'file://internal/screentinker' }).catch(function () {})
      .then(function () { return call(S, 'removeFile', { file: UPDATE_PATH, recursive: false }).catch(function () {}); })
      .then(function () { return call(S, 'copyFile', { source: ipkUrl, destination: UPDATE_PATH, ftpOption: {}, httpOption: {} }); })
      .then(function () { return call(S, 'upgradeApplication', { to: 'local', recovery: false }); });
  }

  // What this shell can actually do right now, in the server's capability vocabulary
  // (frontend/js/views/device-detail.js gates its buttons on these exact names):
  // system.reboot covers reboot and shutdown, display.power the screen commands,
  // system.self_update the update command.
  function capabilities() {
    var caps = [];
    if (Power()) caps.push('system.reboot', 'display.power');
    if (Storage()) caps.push('system.self_update');
    return caps;
  }

  function run(action, payload) {
    switch (action) {
      case 'reboot': return reboot();
      case 'shutdown': return shutdown();
      case 'screen_off': return screen(false);
      case 'screen_on': return screen(true);
      case 'update': return update(payload && payload.url);
      case 'restart': return restartApp();
      /*
       * The weekly backlight schedule. ANDROID-FIRST: stored, not yet evaluated locally, and it
       * reports supported:false rather than pretending. The panel can already blank itself
       * (screen_off above), so the missing piece is the local clock, not the hardware — see the
       * longer note in tizen/js/device-control.js. The server does not send this to a player that
       * has not declared display.power_schedule, so in practice this branch is a safety net.
       */
      case 'set_power_schedule':
        try {
          var s = payload && payload.schedule ? JSON.stringify(payload.schedule) : '';
          if (s) { localStorage.setItem('st_power_schedule', s); }
          else { localStorage.removeItem('st_power_schedule'); }
        } catch (e) { /* storage unavailable — the schedule simply is not retained */ }
        return Promise.resolve({ ok: true, supported: false, action: 'set_power_schedule',
          note: 'stored; this player does not evaluate power windows locally yet (Android-first)' });
      default: return Promise.reject(new Error('unknown action: ' + action));
    }
  }

  global.STWebOS = {
    available: function () { return !!(Power() || Storage() || DeviceInfo() || Configuration()); },
    capabilities: capabilities,
    platformInfo: platformInfo,
    run: run,
    log: log,
  };
})(typeof window !== 'undefined' ? window : this);
