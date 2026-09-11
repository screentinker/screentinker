/*
 * Live video PUBLISHER for the web player (#go2rtc).
 *
 * The mirror image of frontend/js/lib/webrtc-viewer.js: the viewer PULLS a screen for the
 * dashboard; this PUSHES the player's own screen into go2rtc so the dashboard has something to
 * pull. It offers sendonly media to the device-authenticated publish route
 * (POST /api/devices/:id/live/publish?token=...), which proxies to go2rtc's dst= endpoint.
 *
 * Two hard promises, same as the viewer:
 *   1. NEVER load-bearing. Publishing is best-effort telemetry. Any failure (getDisplayMedia
 *      denied, no RTCPeerConnection, the route says 409/live-off, go2rtc silent) resolves to a
 *      stopped publisher and calls onState('stopped', reason). The player keeps rendering content
 *      exactly as before — nothing here can black out a screen.
 *   2. A GESTURE IS REQUIRED. Browsers only grant getDisplayMedia from a user activation, so
 *      start() must be called from a click/keydown/remote-key handler. The player wires a small
 *      "share this screen" affordance for that; unattended kiosks need a browser capture flag,
 *      which is why the Android MediaProjection publisher (no gesture, no picker) is the real
 *      publisher for signage and this one is the reference/opt-in path. See docs/live-video.md.
 *
 * The control core is a pure factory with injected I/O so Node can test the state machine without a
 * browser. The browser attaches window.STLivePublish wired to the real navigator/RTCPeerConnection.
 *
 * ⚠️ WRAPPED IN AN IIFE ON PURPOSE. This file is loaded into the web player as a classic
 * <script> (see server/player/index.html), which shares ONE global scope with every other player
 * script. A bare top-level `const API`/`function createPublisher` would leak into that scope and
 * collide — exactly what bit us: `const API` here vs `const API` in lib/trigger-resolve.js threw
 * "redeclaration of const API" and broke trigger loading on every web player. The IIFE keeps every
 * name private; only module.exports (Node) and window.STLivePublish(Core) (browser) escape it.
 */
'use strict';
(function () {
  // createPublisher(deps) -> { start, stop, state }
  //   deps.getDisplayMedia()      -> Promise<MediaStream-like>  (tracks: [{kind, stop()}], getTracks())
  //   deps.createPeer(iceServers) -> RTCPeerConnection-like
  //   deps.postOffer(sdp)         -> Promise<{ ok, status, sdp }>  (the device-auth publish POST)
  //   deps.onState(state, reason) -> optional; state in idle|starting|live|stopped
  //   deps.iceGatherWaitMs        -> optional cap for non-trickle ICE (default 1500)
  function createPublisher(deps) {
    const iceGatherWaitMs = deps.iceGatherWaitMs != null ? deps.iceGatherWaitMs : 1500;
    let pc = null;
    let stream = null;
    let state = 'idle';
    let seq = 0;

    function setState(s, reason) { state = s; try { deps.onState && deps.onState(s, reason); } catch (_) {} }

    function teardown() {
      try { if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (pc) pc.close(); } catch (_) {}
      pc = null; stream = null;
    }

    function stop(reason) {
      seq++;                 // invalidate any in-flight start
      teardown();
      if (state !== 'stopped' && state !== 'idle') setState('stopped', reason || 'stopped');
      else state = 'stopped';
    }

    async function start(iceServers) {
      const mine = ++seq;
      if (typeof deps.createPeer !== 'function' || typeof deps.getDisplayMedia !== 'function') {
        setState('stopped', 'unsupported'); return false;
      }
      setState('starting');
      // Capture the screen. A denied prompt is the common case and is not an error worth shouting.
      try {
        stream = await deps.getDisplayMedia();
      } catch (_) {
        setState('stopped', 'capture_denied'); return false;
      }
      if (mine !== seq) { teardown(); return false; }          // stopped while prompting

      try {
        pc = deps.createPeer(iceServers || []);
        // The player only ever sends; it never wants media back.
        const tracks = (stream.getTracks ? stream.getTracks() : (stream.tracks || []));
        for (const track of tracks) {
          if (pc.addTrack) pc.addTrack(track, stream);
          else if (pc.addTransceiver) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        }
        // If the operator ends the OS share ("Stop sharing"), tear the whole thing down.
        const vids = tracks.filter((t) => t.kind === 'video');
        if (vids[0]) vids[0].onended = () => stop('share_ended');

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIce(pc, iceGatherWaitMs);
        if (mine !== seq) { teardown(); return false; }

        const sdp = (pc.localDescription && pc.localDescription.sdp) || (offer && offer.sdp);
        const res = await deps.postOffer(sdp);
        if (mine !== seq) { teardown(); return false; }
        if (!res || !res.ok || !res.sdp) { stop(res ? 'publish_' + res.status : 'publish_failed'); return false; }
        await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
        if (mine !== seq) { teardown(); return false; }
        setState('live');
        return true;
      } catch (_) {
        stop('exchange_error');
        return false;
      }
    }

    return { start, stop, get state() { return state; } };
  }

  // Non-trickle ICE: gather (bounded) so the single offer we POST carries the candidates. Resolves
  // early on 'complete', otherwise after the cap so a slow relay candidate never wedges publishing.
  function waitForIce(pc, capMs) {
    if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; try { pc.removeEventListener('icegatheringstatechange', check); } catch (_) {} clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      try { pc.addEventListener('icegatheringstatechange', check); } catch (_) {}
      const timer = setTimeout(finish, capMs);
    });
  }

  const EXPORTS = { createPublisher, waitForIce };

  // ⚠️ BOTH EXPORTS, UNCONDITIONALLY (see lib/trigger-resolve.js for why an if/else UMD is a bug on
  // a node-enabled BrightSign). Node tests require this; the browser gets window.STLivePublishCore.
  if (typeof module !== 'undefined' && module.exports) module.exports = EXPORTS;
  if (typeof window !== 'undefined') {
    window.STLivePublishCore = EXPORTS;

    // Browser convenience: a single-screen publisher wired to the real platform APIs and the
    // device-authenticated publish route. Call STLivePublish.start() FROM A USER GESTURE.
    window.STLivePublish = (function () {
      let pub = null;
      return {
        isSupported: function () {
          return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.RTCPeerConnection);
        },
        // opts: { deviceId, deviceToken, iceServers, onState }
        start: async function (opts) {
          opts = opts || {};
          if (!this.isSupported() || !opts.deviceId || !opts.deviceToken) return false;
          // Idempotent: a duplicate start request (e.g. the dashboard re-opening the tile on a
          // refresh) must NOT tear down an active share and force the operator to re-pick a screen.
          if (pub && (pub.state === 'live' || pub.state === 'starting')) return true;
          if (pub) pub.stop('restart');
          const base = (opts.serverUrl || '').replace(/\/+$/, '');
          const url = base + '/api/devices/' + encodeURIComponent(opts.deviceId) +
                      '/live/publish?token=' + encodeURIComponent(opts.deviceToken);
          pub = createPublisher({
            onState: opts.onState,
            getDisplayMedia: function () {
              return navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 15, max: 30 } },
                audio: false,
              });
            },
            createPeer: function (iceServers) { return new RTCPeerConnection({ iceServers: iceServers }); },
            postOffer: async function (sdp) {
              try {
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp });
                return { ok: r.ok, status: r.status, sdp: r.ok ? await r.text() : '' };
              } catch (_) { return { ok: false, status: 0, sdp: '' }; }
            },
          });
          return pub.start(opts.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]);
        },
        stop: function () { if (pub) { pub.stop('manual'); pub = null; } },
        get state() { return pub ? pub.state : 'idle'; },
      };
    })();
  }
})();
