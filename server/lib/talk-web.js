// #talk — web-player half of the voice intercom (the browser counterpart of Android's AudioTalker).
//
// Served to the browser player at /player/talk.js and exposed as window.STTalk. The player calls
// STTalk.start(...) on device:talk-start and STTalk.stop() on device:talk-stop. It speaks the SAME
// device-authenticated WebSocket + trickle-ICE proxy routes as the native player (the browser holds
// the device_token):
//   duplex:  talk/publish  (dst = uplink, our mic)   + talk/subscribe (src = downlink, operator mic)
//   listen:  talk/listen   (src = broadcast channel, one-way PA)         — no mic
//
// Browsers tolerate trickle fine; retry covers the mutual-subscribe race (a subscribe can precede
// the far side's producer). Fail-soft: any error just leaves no audio and never touches playback.
(function () {
  'use strict';

  var session = null; // { legs: [Leg], audioEl, onState }

  // Diagnostics only when the dashboard's "Debug logging" checkbox is on (window.__stTalkDebug,
  // set by the player's set_debug handler). Otherwise quiet — no console spam on a signage screen.
  function dbg(msg) { try { if (window.__stTalkDebug) console.log('[talk] ' + msg); } catch (_) {} }

  function wsBase(serverUrl) {
    var base = serverUrl && serverUrl.length ? serverUrl : (location.protocol + '//' + location.host);
    return base.replace(/\/+$/, '').replace(/^http/i, 'ws');
  }

  // One WebRTC audio direction over the WS+trickle proxy. direction 'sendonly' carries the mic;
  // 'recvonly' plays what it receives via onAudio(stream). Retries until connected or exhausted.
  function Leg(opts) {
    this.opts = opts;             // { wsUrl, direction, micStream?, iceServers, onAudio? }
    this.pc = null;
    this.ws = null;
    this.wsOpen = false;
    this.connected = false;
    this.disposed = false;
    this.attempt = 0;
    this.pending = [];
    this.delays = [800, 1200, 1800, 2400, 3000];
  }
  Leg.prototype.start = function () {
    if (this.disposed) return;
    this.attempt++;
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: this.opts.iceServers || [] });
    this.pc = pc;
    if (this.opts.direction === 'sendonly') {
      pc.addTransceiver(this.opts.micStream.getAudioTracks()[0], { direction: 'sendonly', streams: [this.opts.micStream] });
    } else {
      // Receive BOTH audio and video: the operator may be sending a webcam. Audio-only calls simply
      // never fire the video track.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = function (e) {
        try { self.opts.onTrack && self.opts.onTrack(e.track); } catch (_) {}
      };
    }
    pc.onicecandidate = function (e) {
      if (!e.candidate || !e.candidate.candidate) return;
      var m = JSON.stringify({ type: 'webrtc/candidate', value: e.candidate.candidate });
      if (self.wsOpen && self.ws) { try { self.ws.send(m); } catch (_) {} } else self.pending.push(m);
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'connected') {
        self.connected = true;
        dbg('leg connected (' + self.opts.direction + ')');
        // Inbound-audio heartbeat (debug only): shows sound arriving+decoding (energy>0) vs a
        // playback issue. Skipped entirely unless debug logging is on.
        if (self.opts.direction === 'recvonly' && (function () { try { return window.__stTalkDebug; } catch (_) { return false; } })()) {
          var n = 0;
          var iv = setInterval(function () {
            if (self.disposed || self.pc !== pc || n++ > 6) { clearInterval(iv); return; }
            pc.getStats(null).then(function (report) {
              var pkts = 0, energy = 0;
              report.forEach(function (r) { if (r.type === 'inbound-rtp' && r.kind === 'audio') { pkts = r.packetsReceived || 0; energy = r.totalAudioEnergy || 0; } });
              dbg('RECV audio: packets=' + pkts + ' totalAudioEnergy=' + energy);
            }).catch(function () {});
          }, 2000);
        }
      } else if (pc.connectionState === 'failed' && !self.disposed) { self.connected = false; self.retryLater(); }
    };
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () { self.openSignaling(pc, offer.sdp); });
    }).catch(function () { self.retryLater(); });
  };
  Leg.prototype.openSignaling = function (pc, offerSdp) {
    if (this.disposed || this.pc !== pc) return;
    var self = this;
    var ws;
    try { ws = new WebSocket(this.opts.wsUrl); } catch (_) { this.retryLater(); return; }
    this.ws = ws;
    ws.onopen = function () {
      if (self.disposed || self.pc !== pc) { try { ws.close(); } catch (_) {} return; }
      self.wsOpen = true;
      ws.send(JSON.stringify({ type: 'webrtc/offer', value: offerSdp }));
      for (var i = 0; i < self.pending.length; i++) { try { ws.send(self.pending[i]); } catch (_) {} }
      self.pending = [];
    };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'webrtc/answer') {
        if (self.disposed || self.pc !== pc) return;
        pc.setRemoteDescription({ type: 'answer', sdp: msg.value }).catch(function () {});
      } else if (msg.type === 'webrtc/candidate') {
        if (self.disposed || self.pc !== pc || !msg.value) return;
        pc.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(function () {});
      } else if (msg.type === 'error') {
        // go2rtc rejects a subscribe with no producer yet ("stream not found") — expected in the
        // mutual-subscribe race; retry until the far side is publishing.
        self.retryLater();
      }
    };
    ws.onerror = function () { if (!self.connected) self.retryLater(); };
    ws.onclose = function () { if (!self.connected && !self.disposed) self.retryLater(); };
  };
  Leg.prototype.retryLater = function () {
    if (this.connected || this.disposed) return;
    var self = this;
    this.closeAttempt();
    if (this.attempt > this.delays.length) return;   // give up quietly (one-way at worst)
    var d = this.delays[Math.min(this.attempt - 1, this.delays.length - 1)];
    setTimeout(function () { if (!self.connected && !self.disposed) self.start(); }, d);
  };
  Leg.prototype.closeAttempt = function () {
    this.wsOpen = false; this.pending = [];
    try { this.ws && this.ws.close(); } catch (_) {}
    try { this.pc && this.pc.close(); } catch (_) {}
    this.ws = null; this.pc = null;
  };
  Leg.prototype.dispose = function () {
    this.disposed = true; this.wsOpen = false; this.pending = [];
    try { this.ws && this.ws.close(); } catch (_) {}
    try { this.pc && this.pc.close(); } catch (_) {}
    this.ws = null; this.pc = null;
  };

  function ensureAudioEl() {
    var el = document.getElementById('st-talk-audio');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'st-talk-audio';
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.style.display = 'none';
      el.__stOverlay = true;   // exempt from base-audio ducking — this IS the announcement
      document.body.appendChild(el);
    }
    return el;
  }

  // Fullscreen <video> overlay for the operator's webcam (#talk video). Hidden until a video track
  // arrives. Its audio comes from the separate <audio> element, so this stays muted.
  function ensureVideoEl() {
    var el = document.getElementById('st-talk-video');
    if (!el) {
      el = document.createElement('video');
      el.id = 'st-talk-video';
      el.autoplay = true; el.muted = true;
      el.setAttribute('playsinline', '');
      el.__stOverlay = true;
      el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:2147483000;display:none';
      document.body.appendChild(el);
    }
    return el;
  }

  var STTalk = {
    isSupported: function () { return typeof RTCPeerConnection !== 'undefined'; },

    // opts: { deviceId, deviceToken, serverUrl, mode:'listen'|'duplex', scope?:{kind,id}, iceServers, onState }
    start: function (opts) {
      this.stop();
      if (!opts || !opts.deviceId || !opts.deviceToken || !this.isSupported()) return;
      var listen = opts.mode === 'listen';
      var base = wsBase(opts.serverUrl) + '/api/devices/' + encodeURIComponent(opts.deviceId);
      var tok = encodeURIComponent(opts.deviceToken);
      var ice = opts.iceServers || [];
      var onState = opts.onState || function () {};
      var audioEl = ensureAudioEl();
      var videoEl = ensureVideoEl();
      // Route each received track: audio always plays through the <audio> element; a video track
      // (the operator's webcam) takes over the screen fullscreen.
      var onTrack = function (track) {
        try {
          if (track.kind === 'video') {
            videoEl.srcObject = new MediaStream([track]);
            videoEl.style.display = '';
            var pv = videoEl.play(); if (pv && pv.catch) pv.catch(function () {});
            track.onended = function () { try { videoEl.style.display = 'none'; videoEl.srcObject = null; } catch (_) {} };
          } else {
            audioEl.srcObject = new MediaStream([track]);
            var pa = audioEl.play(); if (pa && pa.catch) pa.catch(function () { onState('autoplay_blocked'); });
          }
        } catch (_) {}
      };
      var legs = [];

      if (listen) {
        var sc = opts.scope || {};
        var q = '&scopeKind=' + encodeURIComponent(sc.kind || '') + '&scopeId=' + encodeURIComponent(sc.id || '');
        legs.push(new Leg({ wsUrl: base + '/talk/listen/ws?token=' + tok + q, direction: 'recvonly', iceServers: ice, onTrack: onTrack }));
        session = { legs: legs, audioEl: audioEl, videoEl: videoEl, onState: onState };
        legs[0].start();
        onState('listening');
        return;
      }

      // Per-device ONE-WAY (operator -> this device): subscribe the downlink only, no mic, no prompt.
      if (!opts.duplex) {
        var dnl = new Leg({ wsUrl: base + '/talk/subscribe/ws?token=' + tok, direction: 'recvonly', iceServers: ice, onTrack: onTrack });
        legs.push(dnl);
        session = { legs: legs, audioEl: audioEl, videoEl: videoEl, onState: onState };
        dnl.start();
        onState('receiving');
        return;
      }

      // Two-way: this device also sends its mic (audio only — a signage panel has no camera) and
      // receives the operator's mic + webcam. Falls back to listen-only if the mic is denied.
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(function (micStream) {
        var up = new Leg({ wsUrl: base + '/talk/publish/ws?token=' + tok, direction: 'sendonly', micStream: micStream, iceServers: ice });
        var dn = new Leg({ wsUrl: base + '/talk/subscribe/ws?token=' + tok, direction: 'recvonly', iceServers: ice, onTrack: onTrack });
        legs.push(up, dn);
        session = { legs: legs, audioEl: audioEl, videoEl: videoEl, micStream: micStream, onState: onState };
        up.start(); dn.start();
        onState('duplex');
      }).catch(function () {
        var dn = new Leg({ wsUrl: base + '/talk/subscribe/ws?token=' + tok, direction: 'recvonly', iceServers: ice, onTrack: onTrack });
        legs.push(dn);
        session = { legs: legs, audioEl: audioEl, videoEl: videoEl, onState: onState };
        dn.start();
        onState('listen_only_no_mic');
      });
    },

    stop: function () {
      if (!session) return;
      var s = session; session = null;
      try { s.legs.forEach(function (l) { l.dispose(); }); } catch (_) {}
      try { s.micStream && s.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      try { if (s.audioEl) { s.audioEl.srcObject = null; } } catch (_) {}
      try { if (s.videoEl) { s.videoEl.style.display = 'none'; s.videoEl.srcObject = null; } } catch (_) {}
      try { s.onState && s.onState('stopped'); } catch (_) {}
    },
  };

  window.STTalk = STTalk;
})();
