// A small WHEP-style WebRTC viewer for a single screen's live stream.
//
// Reimplemented rather than vendoring go2rtc's video-rtc.js: that is Apache-2.0 and ScreenTinker
// is MIT, and the client we need is small. The signaling is one non-trickle SDP exchange, proxied
// through ScreenTinker (the browser never talks to go2rtc directly, never sees its URL or token):
//
//   GET  /api/devices/:id/live         -> { mode, signalPath, iceServers, fallback } (api.getDeviceLive)
//   POST <signalPath>  body=offer SDP  -> answer SDP
//
// The one hard promise: this NEVER breaks the tile. Any failure — live disabled, no sidecar, no
// publisher, ICE never connects, the browser lacks RTCPeerConnection — calls onFallback() so the
// caller shows the existing screenshot. A connect() resolves to 'webrtc' or 'snapshot'; it does
// not throw.
import { api, getAuthHeaders } from '../api.js';

const API_BASE = '/api';

export class LiveViewer {
  /**
   * @param {string} deviceId
   * @param {HTMLVideoElement} videoEl  where the stream is attached
   * @param {{ onFallback?: (reason:string)=>void, onConnected?: ()=>void, muted?: boolean }} opts
   */
  constructor(deviceId, videoEl, opts = {}) {
    this.deviceId = deviceId;
    this.video = videoEl;
    this.opts = opts;
    this.pc = null;
    this.mode = null;         // 'webrtc' | 'snapshot' | null(not started)
    this.stopped = false;
    this.connectSeq = 0;      // guards against a stale connect resolving after stop()/restart
  }

  async connect() {
    if (this.stopped) return 'snapshot';
    const seq = ++this.connectSeq;
    const fall = (reason) => {
      if (seq !== this.connectSeq) return 'snapshot';   // superseded
      this.mode = 'snapshot';
      this.opts.onFallback?.(reason);
      return 'snapshot';
    };
    if (typeof RTCPeerConnection === 'undefined') return fall('no_webrtc');

    let live;
    try { live = await api.getDeviceLive(this.deviceId); } catch (_) { return fall('descriptor_error'); }
    if (seq !== this.connectSeq || this.stopped) return 'snapshot';
    if (!live || live.mode !== 'webrtc' || !live.signalPath) return fall(live?.reason || 'not_webrtc');

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: live.iceServers || [] });
      this.pc = pc;
      // Receive-only: the dashboard watches, it never sends media.
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        if (seq !== this.connectSeq) return;
        if (this.video && e.streams && e.streams[0]) {
          this.video.srcObject = e.streams[0];
          this.video.muted = this.opts.muted !== false;   // autoplay needs muted; caller unmutes on click
          this.video.playsInline = true;
          this.video.play?.().catch(() => { /* a blocked autoplay is not a failure of the stream */ });
        }
      };
      // If ICE gives up, fall back rather than sit on a black frame.
      pc.oniceconnectionstatechange = () => {
        if (seq !== this.connectSeq) return;
        if (['failed', 'closed'].includes(pc.iceConnectionState) && this.mode !== 'snapshot') fall('ice_' + pc.iceConnectionState);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIce(pc, seq);                    // non-trickle: one exchange, so gather first
      if (seq !== this.connectSeq || this.stopped) { try { pc.close(); } catch (_) {} return 'snapshot'; }

      const res = await fetch(API_BASE.replace(/\/api$/, '') + live.signalPath, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
      if (!res.ok) { try { pc.close(); } catch (_) {} return fall('signal_' + res.status); }
      const answer = await res.text();
      if (seq !== this.connectSeq || this.stopped) { try { pc.close(); } catch (_) {} return 'snapshot'; }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      this.mode = 'webrtc';
      this.opts.onConnected?.();
      return 'webrtc';
    } catch (_) {
      try { pc && pc.close(); } catch (_e) {}
      return fall('exchange_error');
    }
  }

  // Wait for ICE gathering to finish (bounded), so the single proxied offer carries all candidates.
  _waitForIce(pc, seq) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      // Cap the wait: host/srflx candidates arrive fast; waiting for the full timeout on every
      // relay candidate would make the tile feel dead. 1.2s is enough for LAN + STUN.
      const timer = setTimeout(done, 1200);
      if (seq !== this.connectSeq) done();
    });
  }

  setMuted(muted) { if (this.video) this.video.muted = muted; }

  stop() {
    this.stopped = true;
    this.connectSeq++;   // invalidate any in-flight connect
    try { if (this.pc) this.pc.close(); } catch (_) {}
    this.pc = null;
    if (this.video) { try { this.video.srcObject = null; } catch (_) {} }
    this.mode = null;
  }
}

// Connect only while the tile is on screen; tear down when it scrolls away or the row collapses —
// the same discipline video-rtc.js uses, so a Devices page full of tiles holds at most a handful
// of live peers. Returns a disposer. onVisible/onHidden let the caller start/stop its viewer.
export function whenVisible(el, { onVisible, onHidden, threshold = 0.25 } = {}) {
  if (typeof IntersectionObserver === 'undefined') { onVisible?.(); return () => {}; }
  let shown = false;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const vis = e.isIntersecting && e.intersectionRatio >= threshold;
      if (vis && !shown) { shown = true; onVisible?.(); }
      else if (!vis && shown) { shown = false; onHidden?.(); }
    }
  }, { threshold: [0, threshold, 1] });
  io.observe(el);
  return () => { io.disconnect(); if (shown) onHidden?.(); };
}
