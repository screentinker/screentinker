/* ScreenTinker — Tizen/Samsung fleet control (#125).
 *
 * Wraps the two Samsung panel-control surfaces behind one Promise-based API so the
 * player can act on device:command (reboot / screen_off / screen_on / shutdown /
 * update / launch) at parity with the Android player.
 *
 * Surfaces, newest first:
 *   - Tizen 6.5/7  webapis.systemcontrol.*   — synchronous, throws on error
 *   - SSSP/Tizen 4 b2bapis.b2bcontrol.*      — async onSuccess/onError callbacks
 * Both are normalised to Promises. Each surface is re-probed on every call because
 * the platform can inject these objects late (after the page's first script pass).
 *
 * IMPORTANT: these B2B/system APIs only take effect on a Samsung panel running a
 * .wgt signed with a Samsung *Partner* distributor cert (see config.xml + README).
 * On the unsigned dev build, the URL-Launcher/web build, or a consumer TV, the
 * surfaces are absent and run() resolves { supported:false } — never throws.
 *
 * Exposes: window.STDeviceControl = { run, capabilities, backend }.
 */
(function () {
  'use strict';

  var TAG = 'STDeviceControl';
  function log(msg) { try { console.log('[' + TAG + '] ' + msg); } catch (e) {} }

  // ---- surface probes (fresh each call; APIs can be injected late) ----
  function sysctl() {
    try { return (window.webapis && webapis.systemcontrol) ? webapis.systemcontrol : null; }
    catch (e) { return null; }
  }
  function b2b() {
    try { return (window.b2bapis && b2bapis.b2bcontrol) ? b2bapis.b2bcontrol : null; }
    catch (e) { return null; }
  }

  // Active backend, newest first; 'none' on web / consumer TV / unsigned build.
  function backend() {
    if (sysctl()) return 'systemcontrol';
    if (b2b()) return 'b2bcontrol';
    return 'none';
  }

  function errMsg(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || e.name || (e.code != null ? ('code ' + e.code) : 'error');
  }

  // Is `method` present on either surface (systemcontrol checked first)?
  function methodExists(method) {
    var sc = sysctl(); if (sc && typeof sc[method] === 'function') return true;
    var bb = b2b(); if (bb && typeof bb[method] === 'function') return true;
    return false;
  }

  // Call `method` with `args` on whichever surface exposes it, normalised to a
  // Promise. systemcontrol is synchronous (resolve on return / reject on throw);
  // b2bcontrol appends (onSuccess, onError) callbacks.
  function call(method, args) {
    args = args || [];
    return new Promise(function (resolve, reject) {
      var sc = sysctl();
      if (sc && typeof sc[method] === 'function') {
        try { resolve(sc[method].apply(sc, args)); }
        catch (e) { reject(e); }
        return;
      }
      var bb = b2b();
      if (bb && typeof bb[method] === 'function') {
        try {
          bb[method].apply(bb, args.concat([
            function (res) { resolve(res); },
            function (err) { reject(err); }
          ]));
        } catch (e) { reject(e); }
        return;
      }
      reject(new Error('method ' + method + ' not available on backend ' + backend()));
    });
  }

  // Panel power across firmware variants. setPanelMute is the modern surface
  // (mute ON == backlight OFF — inverted vs `on`); older firmware exposes
  // setDisplayPanel / setPanelStatus instead. Picks the first method that EXISTS
  // (a present-but-failing method is a real error, surfaced as-is); if none of
  // them exist the returned promise rejects with { unsupported:true }.
  function panelPower(on) {
    var candidates = [
      ['setPanelMute', [on ? 'OFF' : 'ON']],
      ['setDisplayPanel', [!!on]],
      ['setPanelStatus', [!!on]]
    ];
    for (var i = 0; i < candidates.length; i++) {
      var method = candidates[i][0];
      if (methodExists(method)) {
        return call(method, candidates[i][1]).then((function (m) {
          return function (res) { return { method: m, result: res }; };
        })(method));
      }
    }
    return Promise.reject({ unsupported: true });
  }

  // Uniform result shape — run() always resolves to one of these.
  function result(o) {
    return {
      ok: !!o.ok,
      supported: o.supported !== false,
      action: o.action || null,
      note: o.note || null,
      reload: !!o.reload
    };
  }

  function panelUnsupportedOr(e, action, unsupportedNote) {
    if (e && e.unsupported) {
      return result({ ok: false, supported: false, action: action,
        note: unsupportedNote || ('no panel-power API on this surface (' + backend() + ')') });
    }
    return result({ ok: false, action: action, note: action + ' failed: ' + errMsg(e) });
  }

  // run(type, payload): lowercases type, NEVER rejects, always resolves to a result.
  function run(type, payload) {
    type = String(type || '').toLowerCase();
    try {
      switch (type) {
        case 'reboot':
          if (!methodExists('rebootDevice')) {
            log('reboot: no rebootDevice on backend ' + backend());
            return Promise.resolve(result({ ok: false, supported: false, action: 'reboot',
              note: 'no reboot API on this surface (' + backend() + ')' }));
          }
          return call('rebootDevice', [])
            .then(function () { return result({ ok: true, action: 'reboot', note: 'rebootDevice() issued' }); })
            .catch(function (e) { return result({ ok: false, action: 'reboot', note: 'rebootDevice failed: ' + errMsg(e) }); });

        case 'screen_off':
          return panelPower(false)
            .then(function (r) { return result({ ok: true, action: 'screen_off', note: 'panel backlight off via ' + r.method }); })
            .catch(function (e) { return panelUnsupportedOr(e, 'screen_off'); });

        case 'screen_on':
          return panelPower(true)
            .then(function (r) { return result({ ok: true, action: 'screen_on', note: 'panel backlight on via ' + r.method }); })
            .catch(function (e) { return panelUnsupportedOr(e, 'screen_on'); });

        case 'shutdown':
          // SSSP/Tizen web APIs have no true power-off; the closest honest action is
          // muting the panel (backlight off). Report that it's not a real shutdown.
          return panelPower(false)
            .then(function (r) { return result({ ok: true, action: 'shutdown',
              note: 'no true power-off on SSSP web API — panel backlight off via ' + r.method }); })
            .catch(function (e) { return panelUnsupportedOr(e, 'shutdown',
              'no true power-off on SSSP web API and no panel-mute surface available'); });

        case 'update':
          // No in-app OTA for a sideloaded / URL-Launcher build; reloading re-pulls
          // the latest URL-Launcher content (app.js performs the reload).
          return Promise.resolve(result({ ok: true, action: 'update', reload: true,
            note: 'reloading to re-pull URL-Launcher content (no in-app OTA)' }));

        case 'launch':
          // Already the foreground app — nothing to launch.
          log('launch: no-op (already foreground)');
          return Promise.resolve(result({ ok: true, action: 'launch', note: 'already foreground (no-op)' }));

        case 'reload':
        case 'refresh':
          return Promise.resolve(result({ ok: true, action: type, reload: true, note: 'reload requested' }));

        default:
          log('unknown command: ' + type);
          return Promise.resolve(result({ ok: false, supported: false, action: type, note: 'unknown command' }));
      }
    } catch (e) {
      return Promise.resolve(result({ ok: false, action: type, note: 'exception: ' + errMsg(e) }));
    }
  }

  // Snapshot for a startup log: which surface, and whether reboot/panel are present.
  function capabilities() {
    return {
      backend: backend(),
      reboot: methodExists('rebootDevice'),
      panel: methodExists('setPanelMute') || methodExists('setDisplayPanel') || methodExists('setPanelStatus')
    };
  }

  window.STDeviceControl = { run: run, capabilities: capabilities, backend: backend };
  log('loaded (backend=' + backend() + ')');
})();
