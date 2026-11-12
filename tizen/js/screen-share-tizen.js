/* ScreenTinker — 3.0 screen share on Samsung Tizen (docs/screen-share.md).
 *
 * The receiver is NOT re-implemented here: js/screen-share.js is a byte-identical copy of the web
 * player's server/lib/screen-share-player.js (build-wgt.sh re-copies it; a test holds the copy), so
 * this panel speaks exactly the protocol, draws exactly the overlay, badge and meeting-room code the
 * web player does. This file is only the Tizen glue: when to claim the capability, the three socket
 * events, getting the content out of the way (including the AVPlay hardware plane), and what the
 * remote viewer is shown.
 *
 * ⚠️ VERSION GATE. Samsung's web engine specification lists WebRTC as supported from Tizen 10.0
 * (2026 models, Chromium M130); Tizen 9.0 (M120) is "partially" supported and older engines not at all
 * (developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html, and the
 * Signage page of the same name). A feature probe alone is not enough on a TV — an engine can expose
 * RTCPeerConnection and still fail to decode into a visible <video> — so the claim needs BOTH the
 * probe and Tizen >= MIN_TIZEN. A screen that claims a share and then shows nothing is a guest
 * presenting to a blank TV.
 *
 * ⚠️ REMOTE VIEWER. Tizen decodes <video> onto a hardware plane that a canvas cannot read back (see
 * captureAndSend in app.js), and a WebRTC <video> is no exception, so while a share is up the
 * dashboard gets an honest card naming the sharer instead of the paused playlist.
 */
(function () {
  'use strict';

  var MIN_TIZEN = 10;

  function major(v) {
    var m = /^\s*(\d+)/.exec(String(v == null ? '' : v));
    return m ? parseInt(m[1], 10) : 0;
  }

  function platformVersion() {
    try { return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { return ''; }
  }

  /** Claim remote.screen_share? [version] defaults to the running platform's. */
  function supported(version) {
    var SS = window.STScreenShare;
    var rtc = !!(SS && typeof SS.isSupported === 'function' && SS.isSupported());
    return rtc && major(version === undefined ? platformVersion() : version) >= MIN_TIZEN;
  }

  function overlayUp() {
    var o = document.getElementById('st-share-overlay');
    return !!(o && o.parentNode);
  }

  /*
   * o: { creds() -> {deviceId, deviceToken, serverUrl} | null, pause(), resume(), log(level, msg) }
   * pause/resume are app.js's: the AVPlay plane composites ABOVE the DOM, so a portrait video would
   * play straight through the share's overlay unless its session is torn down (the screen-off lesson).
   */
  function wire(socket, o) {
    var paused = false;
    function release() { if (paused) { paused = false; try { o.resume(); } catch (e) {} } }
    socket.on('device:screenshare-start', function (data) {
      var SS = window.STScreenShare;
      if (!SS || !data || typeof data.session_id !== 'string') return;
      var c = null;
      try { c = o.creds(); } catch (e) { c = null; }
      if (!c || !c.deviceId || !c.deviceToken) return;
      try {
        if (!paused) { paused = true; o.pause(); }
        SS.start({
          deviceId: c.deviceId,
          deviceToken: c.deviceToken,
          serverUrl: c.serverUrl || '',
          sessionId: data.session_id,
          sharedBy: typeof data.shared_by === 'string' ? data.shared_by : '',
          guest: !!data.guest,
          plain: data.plain === true,
          maxSeconds: data.max_seconds,
          iceServers: Object.prototype.toString.call(data.ice_servers) === '[object Array]' ? data.ice_servers : [],
          labels: {},
          onState: function (st, reason) {
            try { o.log('info', 'share ' + st + (reason ? ' (' + reason + ')' : '')); } catch (e) {}
            // Only when nothing is on screen any more: a replaced share reports "stopped" after
            // its successor has started.
            if ((st === 'stopped' || st === 'unsupported') && !SS.active()) release();
          },
        });
      } catch (e) { release(); }   // a share never breaks playback
    });
    socket.on('device:screenshare-stop', function (data) {
      try { window.STScreenShare && window.STScreenShare.stop(data && data.session_id, data && data.reason); } catch (e) {}
    });
    socket.on('device:screenshare-code', function (data) {
      try { window.STScreenShare && window.STScreenShare.showCode(data, {}); } catch (e) {}
    });
  }

  /*
   * The remote viewer's frame while a share is on screen: true when it drew one. Text only — the
   * name is drawn with fillText, never parsed.
   */
  function drawCard(ctx, W, H) {
    if (!overlayUp()) return false;
    var badge = document.getElementById('st-share-badge');
    var who = badge ? String(badge.textContent || '') : '';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 28px sans-serif';
    ctx.fillText('A screen share is on screen', W / 2, H / 2 - 24);
    ctx.fillStyle = '#94a3b8'; ctx.font = '18px sans-serif';
    ctx.fillText('It can’t be captured on this TV.', W / 2, H / 2 + 12);
    if (who) { ctx.fillStyle = '#cbd5e1'; ctx.fillText(who, W / 2, H / 2 + 48, W - 40); }
    return true;
  }

  window.STShareTizen = { MIN_TIZEN: MIN_TIZEN, major: major, supported: supported, wire: wire, drawCard: drawCard, overlayUp: overlayUp };
})();
