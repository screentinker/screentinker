// 3.0 screen share — the web player's RECEIVER (docs/screen-share.md). Served at
// /player/screen-share.js and exposed as window.STScreenShare.
//
// On device:screenshare-start the player calls STScreenShare.start(...). This opens the screen's
// signalling leg (WebSocket /api/devices/:id/screen-share/ws, authenticated by the device_token in
// the FIRST message so it never sits in a URL), OFFERS a recvonly video+audio peer connection, and
// shows whatever arrives fullscreen over the playlist with a small "Shared by <name>" badge. The
// server only relays the SDP/candidates to the sharer's browser; the media is peer to peer.
//
// Several presenters at once (remote.screen_share_tiles): up to MAX_TILES sessions are on screen
// together — one fills the screen, two sit side by side (stacked on a portrait screen), three or
// four make a 2x2 grid — each letterboxed in its tile with its own name label. The server's
// device:screenshare-layout ({spotlight, audio}) says which one, if any, fills the screen while the
// others stay connected but hidden, and whose sound plays: only ever one at a time.
//
// It also draws the meeting-room badge (STScreenShare.showCode) — the code a guest types on /share,
// with a QR for the same address. With nobody sharing it is the full badge; while people are
// sharing and a slot is still free (the server only sends a code then) it shrinks to a small card
// in the top-right corner so it does not cover the shares.
//
// Fail-soft like talk: anything that goes wrong tears that tile down, and the playlist, which never
// stopped underneath, is simply visible again once no tile is left.
(function () {
  'use strict';

  var MAX_TILES = 4;
  var sessions = {};    // id -> { id, pc, ws, tile, video, audio, wait, badge, timer, onState, stopped, startedAt }
  var order = [];       // session ids, oldest first
  var layoutState = { spotlight: null, audio: null };
  var codeState = null; // last code payload, so the badge can come back after a share
  var lastLabels = {};
  var overlayEl = null;
  // #845: an emergency/trigger overlay is on screen (the player calls suppress()). The shares stay
  // connected but are hidden and silent, and the "share your screen" QR is off, until it clears.
  // The server already ends shares and drops the code for alerts it knows about; this covers a
  // trigger fired at the screen itself (HTTP/UDP), which the server never hears of.
  var suppressed = false;

  function dbg(msg) { try { if (window.__stTalkDebug) console.log('[share] ' + msg); } catch (_) {} }

  function wsUrl(serverUrl, deviceId) {
    var base = serverUrl && serverUrl.length ? serverUrl : (location.protocol + '//' + location.host);
    return base.replace(/\/+$/, '').replace(/^http/i, 'ws') + '/api/devices/' + encodeURIComponent(deviceId) + '/screen-share/ws';
  }

  function fmt(s, vars) {
    return String(s || '').replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? String(vars[k]) : m; });
  }

  function count() { return order.length; }

  // ---------------------------------------------------------------- the overlay and its tiles
  function overlay() {
    if (overlayEl && overlayEl.parentNode) return overlayEl;
    var o = document.createElement('div');
    o.id = 'st-share-overlay';
    o.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:#000;z-index:2147483100;overflow:hidden';
    if (suppressed) o.style.visibility = 'hidden';
    document.body.appendChild(o);
    overlayEl = o;
    return o;
  }

  function buildTile(labels, sharedBy, guest, plain) {
    var t = document.createElement('div');
    t.className = 'st-share-tile';
    t.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid #000;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center';
    var v = document.createElement('video');
    v.className = 'st-share-video';
    v.autoplay = true; v.muted = true;   // muted = always allowed to autoplay; sound is the <audio> below
    v.setAttribute('playsinline', '');
    v.__stOverlay = true;                 // exempt from the player's base-media ducking
    v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
    var a = document.createElement('audio');
    a.autoplay = true; a.__stOverlay = true; a.style.display = 'none';
    a.muted = true;                       // relayout() unmutes the one presenter whose sound plays
    var wait = document.createElement('div');
    wait.className = 'st-share-wait';
    wait.style.cssText = 'position:absolute;color:#cbd5e1;font:500 2.2vw/1.4 system-ui,sans-serif;text-align:center;padding:0 1vw';
    wait.textContent = fmt(labels.connecting || 'Connecting to {name}…', { name: sharedBy });
    var badge = document.createElement('div');
    badge.className = 'st-share-badge';
    badge.style.cssText = 'position:absolute;left:1.2vw;bottom:1.2vw;padding:.45vw .9vw;border-radius:.5vw;background:rgba(15,23,42,.72);color:#fff;font:500 max(12px,1.05vw)/1.3 system-ui,sans-serif;max-width:80%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none';
    // textContent only: the name is whatever a guest typed.
    badge.textContent = fmt(labels.sharedBy || 'Shared by {name}', { name: sharedBy }) + (guest ? ' · ' + (labels.guest || 'guest') : '');
    // A stream output's picture (not a person's screen) is the programme itself: nothing is written over it.
    // (No words either: the dashboard's view of the screen draws the badge's text.)
    if (plain) { badge.style.display = 'none'; badge.textContent = ''; wait.style.display = 'none'; }
    t.appendChild(v); t.appendChild(a); t.appendChild(wait); t.appendChild(badge);
    overlay().appendChild(t);
    return { tile: t, video: v, audio: a, wait: wait, badge: badge };
  }

  /*
   * Tile rectangles, in fractions of the overlay, for n tiles: 1 full; 2 side by side, or stacked
   * when the screen is taller than wide; 3-4 a 2x2 grid (three: the third centred underneath).
   */
  function rects(n, portrait) {
    if (n <= 1) return [[0, 0, 1, 1]];
    if (n === 2) return portrait ? [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] : [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]];
    if (n === 3) return [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0.25, 0.5, 0.5, 0.5]];
    return [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
  }

  function visibleIds() {
    var spot = layoutState.spotlight;
    if (spot && sessions[spot]) return [spot];
    return order.slice(0, MAX_TILES);
  }

  // Whose sound plays: the server's choice when it names one of ours, else the newest session.
  function audioId() {
    if (layoutState.audio && sessions[layoutState.audio]) return layoutState.audio;
    return order.length ? order[order.length - 1] : null;
  }

  function relayout() {
    if (!order.length) return;
    var o = overlay();
    var w = o.clientWidth || window.innerWidth || 1;
    var h = o.clientHeight || window.innerHeight || 1;
    var vis = visibleIds();
    var rs = rects(vis.length, h > w);
    var sound = audioId();
    for (var i = 0; i < order.length; i++) {
      var s = sessions[order[i]];
      var at = vis.indexOf(s.id);
      // The first visible tile carries the ids the capture / Tizen card / older code look for.
      s.video.id = at === 0 ? 'st-share-video' : '';
      s.wait.id = at === 0 ? 'st-share-wait' : '';
      s.badge.id = at === 0 ? 'st-share-badge' : '';
      if (at < 0) { s.tile.style.display = 'none'; }
      else {
        var r = rs[at];
        s.tile.style.display = 'flex';
        s.tile.style.left = (r[0] * 100) + '%'; s.tile.style.top = (r[1] * 100) + '%';
        s.tile.style.width = (r[2] * 100) + '%'; s.tile.style.height = (r[3] * 100) + '%';
        // One tile: no frame, exactly as a single share always looked.
        s.tile.style.borderWidth = vis.length > 1 ? '2px' : '0';
      }
      try { s.audio.muted = suppressed || s.id !== sound; } catch (_) {}
    }
    try { paintCode(lastLabels); } catch (_) {}
  }

  try { window.addEventListener('resize', function () { try { relayout(); } catch (_) {} }); } catch (_) {}

  // ---------------------------------------------------------------- the meeting-room badge
  function codeBadge() {
    var el = document.getElementById('st-share-code');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'st-share-code';
    var img = document.createElement('img');
    img.alt = '';
    var txt = document.createElement('div');
    var t1 = document.createElement('div'); t1.style.cssText = 'font-weight:700;font-size:1.1em';
    var t2 = document.createElement('div'); t2.style.cssText = 'opacity:.85';
    var t3 = document.createElement('div'); t3.style.cssText = 'font:700 1.9em/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;margin-top:.2em';
    t3.setAttribute('data-share-code', '');
    txt.appendChild(t1); txt.appendChild(t2); txt.appendChild(t3);
    el.appendChild(img); el.appendChild(txt);
    el.__parts = { img: img, title: t1, hint: t2, code: t3 };
    document.body.appendChild(el);
    return el;
  }

  function paintCode(labels) {
    var el = codeBadge();
    if (!codeState || !codeState.code || suppressed) { el.style.display = 'none'; el.removeAttribute('data-compact'); return; }
    var parts = el.__parts;
    var img = parts.img;
    var compact = order.length > 0;
    // Full badge bottom-right with nobody sharing; a small card top-right above the tiles while
    // people share and a slot is free (the server sends no code when the screen is full).
    el.style.cssText = compact
      ? 'position:fixed;right:.8vw;top:.8vw;z-index:2147483200;display:flex;align-items:center;gap:.6vw;padding:.45vw .6vw;border-radius:.6vw;background:rgba(15,23,42,.86);color:#fff;font:500 max(10px,.75vw)/1.3 system-ui,sans-serif;pointer-events:none;box-shadow:0 .2vw .8vw rgba(0,0,0,.35)'
      : 'position:fixed;right:1.2vw;bottom:1.2vw;z-index:2147482900;display:flex;align-items:center;gap:.9vw;padding:.8vw 1vw;border-radius:.8vw;background:rgba(15,23,42,.82);color:#fff;font:500 max(12px,1vw)/1.35 system-ui,sans-serif;pointer-events:none;box-shadow:0 .3vw 1.2vw rgba(0,0,0,.35)';
    if (compact) el.setAttribute('data-compact', ''); else el.removeAttribute('data-compact');
    img.style.cssText = compact
      ? 'width:max(56px,4.2vw);height:max(56px,4.2vw);border-radius:.3vw;background:#fff'
      : 'width:max(84px,7vw);height:max(84px,7vw);border-radius:.3vw;background:#fff';
    // Only a data: PNG from our own server is used as the QR; anything else is ignored.
    if (codeState.qr && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(codeState.qr)) { img.src = codeState.qr; img.style.display = ''; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
    var shown = String(codeState.url || '/share').replace(/^https?:\/\//, '');
    parts.title.textContent = labels.codeTitle || 'Share your screen here';
    parts.hint.textContent = fmt(labels.codeHint || 'Go to {url} and enter', { url: shown });
    parts.code.textContent = String(codeState.code);
    el.style.display = 'flex';
  }

  // ---------------------------------------------------------------- the receiver
  function teardown(s, reason) {
    if (!s || s.stopped) return;
    s.stopped = true;
    delete sessions[s.id];
    var i = order.indexOf(s.id);
    if (i >= 0) order.splice(i, 1);
    try { clearTimeout(s.timer); } catch (_) {}
    try { clearTimeout(s.connectTimer); } catch (_) {}
    try { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'state', value: 'disconnected' })); } catch (_) {}
    try { s.ws && s.ws.close(); } catch (_) {}
    try { s.pc && s.pc.close(); } catch (_) {}
    try { s.video.srcObject = null; s.audio.srcObject = null; } catch (_) {}
    try { s.tile.parentNode && s.tile.parentNode.removeChild(s.tile); } catch (_) {}
    if (!order.length) {
      try { overlayEl && overlayEl.parentNode && overlayEl.parentNode.removeChild(overlayEl); } catch (_) {}
      overlayEl = null;
      layoutState = { spotlight: null, audio: null };
    } else {
      try { relayout(); } catch (_) {}
    }
    dbg('stopped: ' + (reason || ''));
    try { s.onState && s.onState('stopped', reason || null, s.id); } catch (_) {}
    try { paintCode(s.labels || lastLabels); } catch (_) {}
  }

  var STScreenShare = {
    MAX_TILES: MAX_TILES,
    // This receiver shows several shares at once (the player declares remote.screen_share_tiles).
    tiles: true,
    // addTransceiver is the line: Chromium < 69 (old signage WebViews, the legacy build's targets)
    // has RTCPeerConnection but cannot set up a recvonly receiver, so it must not claim the feature.
    isSupported: function () {
      return typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function' && typeof MediaStream === 'function'
        && !!(RTCPeerConnection.prototype && RTCPeerConnection.prototype.addTransceiver);
    },
    active: function () { return order.length > 0; },
    count: count,

    // opts: { deviceId, deviceToken, serverUrl, sessionId, sharedBy, guest, maxSeconds, iceServers, labels, onState }
    start: function (opts) {
      if (!opts || !opts.deviceId || !opts.deviceToken || !opts.sessionId) return;
      if (sessions[opts.sessionId]) return;
      var labels = opts.labels || {};
      lastLabels = labels;
      var onState = opts.onState || function () {};
      if (!this.isSupported()) { onState('unsupported', null, opts.sessionId); return; }
      // Never more than MAX_TILES: the oldest makes room (the server never sends more; this is the backstop).
      while (order.length >= MAX_TILES) teardown(sessions[order[0]], 'replaced');
      var ui = buildTile(labels, opts.sharedBy || '', !!opts.guest, opts.plain === true);
      var s = { id: opts.sessionId, tile: ui.tile, video: ui.video, audio: ui.audio, wait: ui.wait, badge: ui.badge, labels: labels, onState: onState, stopped: false, pending: [], startedAt: Date.now() };
      sessions[s.id] = s;
      order.push(s.id);
      relayout();

      var report = function (st) { try { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'state', value: st })); } catch (_) {} };
      // A local backstop for the server's own maximum: the screen goes back to its content even if
      // the stop message never arrives.
      var maxMs = Math.max(60, Math.min(8 * 3600, Number(opts.maxSeconds) || 3600)) * 1000 + 5000;
      s.timer = setTimeout(function () { teardown(s, 'max_duration'); }, maxMs);
      // Nothing playing 45s after we started: give up rather than hold a black tile.
      s.connectTimer = setTimeout(function () { if (!s.stopped && !s.playing) { report('failed'); teardown(s, 'timeout'); } }, 45000);

      var pc;
      try {
        pc = new RTCPeerConnection({ iceServers: opts.iceServers || [] });
        s.pc = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch (e) { onState('unsupported', null, s.id); teardown(s, 'unsupported'); return; }
      pc.ontrack = function (e) {
        if (s.stopped) return;
        var track = e.track;
        if (track.kind === 'video') {
          ui.video.srcObject = new MediaStream([track]);
          var pv = ui.video.play(); if (pv && pv.catch) pv.catch(function () {});
        } else if (track.kind === 'audio') {
          ui.audio.srcObject = new MediaStream([track]);
          var pa = ui.audio.play(); if (pa && pa.catch) pa.catch(function () { dbg('audio autoplay blocked'); });
        }
      };
      ui.video.addEventListener('playing', function () {
        if (s.stopped || s.playing) return;
        s.playing = true;
        try { ui.wait.style.display = 'none'; } catch (_) {}
        report('playing');
        onState('playing', null, s.id);
      });
      pc.onicecandidate = function (e) {
        if (!e.candidate || !e.candidate.candidate) return;
        var m = JSON.stringify({ type: 'webrtc/candidate', value: e.candidate.candidate, mid: e.candidate.sdpMid, mline: e.candidate.sdpMLineIndex });
        if (s.wsReady) { try { s.ws.send(m); } catch (_) {} } else s.pending.push(m);
      };
      pc.onconnectionstatechange = function () {
        if (s.stopped) return;
        dbg('pc ' + pc.connectionState);
        if (pc.connectionState === 'failed') { report('failed'); teardown(s, 'connection_failed'); }
      };

      var ws;
      try { ws = new WebSocket(wsUrl(opts.serverUrl, opts.deviceId)); } catch (e) { teardown(s, 'signalling_failed'); return; }
      s.ws = ws;
      ws.onopen = function () {
        if (s.stopped) { try { ws.close(); } catch (_) {} return; }
        ws.send(JSON.stringify({ type: 'auth', device_token: opts.deviceToken, session_id: opts.sessionId }));
      };
      ws.onmessage = function (ev) {
        if (s.stopped) return;
        var m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.type === 'ready') {
          pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer).then(function () {
              ws.send(JSON.stringify({ type: 'webrtc/offer', value: pc.localDescription.sdp }));
              s.wsReady = true;
              for (var i = 0; i < s.pending.length; i++) { try { ws.send(s.pending[i]); } catch (_) {} }
              s.pending = [];
            });
          }).catch(function () { report('failed'); teardown(s, 'offer_failed'); });
        } else if (m.type === 'webrtc/answer' && typeof m.value === 'string') {
          pc.setRemoteDescription({ type: 'answer', sdp: m.value }).catch(function () { report('failed'); teardown(s, 'answer_failed'); });
        } else if (m.type === 'webrtc/candidate' && typeof m.value === 'string') {
          var c = { candidate: m.value };
          if (typeof m.mid === 'string') c.sdpMid = m.mid; else c.sdpMLineIndex = typeof m.mline === 'number' ? m.mline : 0;
          pc.addIceCandidate(c).catch(function () {});
        } else if (m.type === 'ended') {
          teardown(s, m.reason || 'ended');
        }
      };
      ws.onclose = function () { if (!s.stopped) teardown(s, 'signalling_closed'); };
      ws.onerror = function () { /* onclose follows */ };
      onState('connecting', null, s.id);
    },

    // Stop a share on screen. With an id, only that session (a late stop for an old share must not
    // end a newer one); without, every share on screen (unpaired, reset).
    stop: function (sessionId, reason) {
      if (sessionId) { if (sessions[sessionId]) teardown(sessions[sessionId], reason || 'stopped'); return; }
      var all = order.slice();
      for (var i = 0; i < all.length; i++) teardown(sessions[all[i]], reason || 'stopped');
    },

    // device:screenshare-layout { spotlight, audio }: which session fills the screen (null: tiles),
    // and whose sound plays. Remembered, so a session that starts after it is laid out right too.
    layout: function (payload) {
      var p = payload || {};
      layoutState = {
        spotlight: typeof p.spotlight === 'string' ? p.spotlight : null,
        audio: typeof p.audio === 'string' ? p.audio : null,
      };
      try { relayout(); } catch (_) {}
    },

    // What is on screen, for the remote viewer's capture: the visible tiles, in fractions of the
    // screen, each with its video (if any frames yet), its label and its "connecting" line.
    tilesOnScreen: function () {
      if (suppressed) return [];   // #845: the remote view shows the alert, as the screen does
      var vis = visibleIds();
      var o = overlayEl;
      var portrait = !!(o && o.clientHeight > o.clientWidth);
      var rs = rects(vis.length, portrait);
      var out = [];
      for (var i = 0; i < vis.length; i++) {
        var s = sessions[vis[i]];
        if (!s) continue;
        out.push({
          x: rs[i][0], y: rs[i][1], w: rs[i][2], h: rs[i][3], video: s.video,
          label: String(s.badge.textContent || ''), waiting: s.playing ? '' : String(s.wait.textContent || ''),
        });
      }
      return out;
    },

    // #845: hide (true) or bring back (false) every share and the code, for an alert on screen.
    // Idempotent; sessions keep running underneath, so a share comes back intact afterwards.
    suppress: function (on) {
      on = !!on;
      if (on === suppressed) return;
      suppressed = on;
      try { if (overlayEl) overlayEl.style.visibility = on ? 'hidden' : ''; } catch (_) {}
      for (var i = 0; i < order.length; i++) { try { sessions[order[i]].audio.muted = true; } catch (_) {} }
      try { relayout(); } catch (_) {}
      try { paintCode(lastLabels); } catch (_) {}
    },
    suppressed: function () { return suppressed; },

    // The meeting-room code. payload: { code, url, qr } or { code: null } to hide it.
    showCode: function (payload, labels) {
      codeState = payload && payload.code ? { code: payload.code, url: payload.url, qr: payload.qr } : null;
      if (labels) lastLabels = labels;
      try { paintCode(labels || lastLabels); } catch (_) {}
    },
  };

  window.STScreenShare = STScreenShare;
})();
