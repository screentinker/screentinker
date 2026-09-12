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
// publisher, ICE never connects, OR the media plane connects but no frames ever arrive — calls
// onFallback() so the caller shows the existing screenshot. A connect() resolves to 'webrtc' or
// 'snapshot'; it does not throw.
//
// DEBUGGING: every step logs to the console under the "[live]" prefix, so a black tile can be
// diagnosed from DevTools without a rebuild. On by default; silence with
// `localStorage.setItem('st_live_debug','0')` (and re-enable with '1' or removing the key). The
// most useful line is the selected ICE candidate pair logged on connect and on a no-frames
// timeout: if the remote candidate is 127.0.0.1 and your browser is not on the go2rtc host, that
// is why the picture is black — go2rtc is advertising a loopback candidate you cannot reach.
import { api, getAuthHeaders } from '../api.js';

const API_BASE = '/api';
const NO_FRAME_TIMEOUT_MS = 6000;   // connected but silent this long -> fall back to the snapshot

function debugEnabled() {
  try { return localStorage.getItem('st_live_debug') !== '0'; } catch (_) { return true; }
}
function dbg(...args) { if (debugEnabled()) { try { console.log('[live]', ...args); } catch (_) {} } }
function dwarn(...args) { if (debugEnabled()) { try { console.warn('[live]', ...args); } catch (_) {} } }

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
    this._frameTimer = null;  // no-frames watchdog interval
  }

  async connect() {
    if (this.stopped) return 'snapshot';
    const seq = ++this.connectSeq;
    const tag = `dev=${this.deviceId}`;
    dbg('connect start', tag);
    const fall = (reason) => {
      if (seq !== this.connectSeq) return 'snapshot';   // superseded
      dbg('fallback to snapshot:', reason, tag);
      this._clearFrameWatch();
      this.mode = 'snapshot';
      this.opts.onFallback?.(reason);
      return 'snapshot';
    };
    if (typeof RTCPeerConnection === 'undefined') return fall('no_webrtc');

    let live;
    try { live = await api.getDeviceLive(this.deviceId); } catch (e) { dwarn('descriptor error', e?.message); return fall('descriptor_error'); }
    if (seq !== this.connectSeq || this.stopped) return 'snapshot';
    dbg('descriptor:', JSON.stringify({ mode: live?.mode, reason: live?.reason, ice: (live?.iceServers || []).map((s) => s.urls) }));
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
        dbg('ontrack', e.track?.kind, tag);
        if (this.video && e.streams && e.streams[0]) {
          this.video.srcObject = e.streams[0];
          this.video.muted = this.opts.muted !== false;   // autoplay needs muted; caller unmutes on click
          this.video.playsInline = true;
          this.video.play?.().catch((err) => { dbg('autoplay blocked (not a stream failure):', err?.name); });
        }
      };
      pc.onicegatheringstatechange = () => { if (seq === this.connectSeq) dbg('ice gathering:', pc.iceGatheringState); };
      // Log EVERY ICE transition (checking/connected/completed/disconnected/failed/closed), and fall
      // back when it gives up rather than sit on a black frame.
      pc.oniceconnectionstatechange = () => {
        if (seq !== this.connectSeq) return;
        dbg('ice connection:', pc.iceConnectionState, tag);
        if (['failed', 'closed'].includes(pc.iceConnectionState) && this.mode !== 'snapshot') fall('ice_' + pc.iceConnectionState);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIce(pc, seq);                    // non-trickle: one exchange, so gather first
      if (seq !== this.connectSeq || this.stopped) { try { pc.close(); } catch (_) {} return 'snapshot'; }

      const url = API_BASE.replace(/\/api$/, '') + live.signalPath;
      dbg('POST offer ->', live.signalPath);
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
      dbg('signaling status:', res.status);
      if (!res.ok) { try { pc.close(); } catch (_) {} return fall('signal_' + res.status); }
      const answer = await res.text();
      if (seq !== this.connectSeq || this.stopped) { try { pc.close(); } catch (_) {} return 'snapshot'; }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      dbg('remote description set; awaiting media');
      this.mode = 'webrtc';
      this.opts.onConnected?.();
      this._startFrameWatch(pc, seq, fall);
      return 'webrtc';
    } catch (e) {
      dwarn('exchange error:', e?.message);
      try { pc && pc.close(); } catch (_e) {}
      return fall('exchange_error');
    }
  }

  // The black-tile guard. Signaling can succeed (LIVE badge shows) while media never arrives —
  // classically because go2rtc handed out an ICE candidate the browser cannot reach (a loopback
  // 127.0.0.1 candidate when the browser is not on the go2rtc host). Poll for decoded frames; the
  // moment any arrive we are truly live. If none arrive within the timeout, log the selected
  // candidate pair (so the cause is visible) and fall back to the snapshot instead of sitting black.
  _startFrameWatch(pc, seq, fall) {
    this._clearFrameWatch();
    const started = Date.now();
    let last = 0;
    this._frameTimer = setInterval(async () => {
      if (seq !== this.connectSeq || this.stopped) { this._clearFrameWatch(); return; }
      let frames = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesDecoded || 0; });
      } catch (_) { return; }
      if (frames > 0) {
        if (last === 0) dbg('media flowing: frames decoding', tagFrames(frames));
        last = frames;
        this._clearFrameWatch();   // truly live; stop polling
        return;
      }
      if (Date.now() - started >= NO_FRAME_TIMEOUT_MS) {
        this._logSelectedCandidate(pc);
        dwarn(`no video frames after ${NO_FRAME_TIMEOUT_MS}ms - falling back to snapshot. ` +
              'If the remote candidate above is 127.0.0.1 and this browser is not on the go2rtc host, ' +
              'go2rtc is advertising an unreachable loopback candidate (set webrtc.candidates to the reachable IP).');
        this._clearFrameWatch();
        fall('no_frames');
      }
    }, 1000);
  }

  async _logSelectedCandidate(pc) {
    if (!debugEnabled()) return;
    try {
      const stats = await pc.getStats();
      const pairs = {}; const local = {}; const remote = {};
      stats.forEach((s) => {
        if (s.type === 'candidate-pair') pairs[s.id] = s;
        else if (s.type === 'local-candidate') local[s.id] = s;
        else if (s.type === 'remote-candidate') remote[s.id] = s;
      });
      const sel = Object.values(pairs).find((p) => p.selected || p.state === 'succeeded') || Object.values(pairs)[0];
      if (!sel) { dbg('no ICE candidate pair yet (still checking) - a reachability problem, not a media one'); return; }
      const l = local[sel.localCandidateId] || {}; const r = remote[sel.remoteCandidateId] || {};
      dbg('selected ICE pair:', `state=${sel.state}`,
          `local=${l.address || l.ip || '?'}:${l.port || '?'}/${l.candidateType || '?'}`,
          `remote=${r.address || r.ip || '?'}:${r.port || '?'}/${r.candidateType || '?'}`);
    } catch (_) { /* stats not available */ }
  }

  _clearFrameWatch() { if (this._frameTimer) { clearInterval(this._frameTimer); this._frameTimer = null; } }

  // Wait for ICE gathering to finish (bounded), so the single proxied offer carries all candidates.
  _waitForIce(pc, seq) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    const cands = [];
    return new Promise((resolve) => {
      const onCand = (e) => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        pc.removeEventListener('icecandidate', onCand);
        clearTimeout(timer);
        dbg('ICE gathering done,', cands.length, 'local candidate(s):',
            cands.map((c) => { const m = /typ (\w+)/.exec(c); return m ? m[1] : c; }).join(','));
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icecandidate', onCand);
      pc.addEventListener('icegatheringstatechange', check);
      // Cap the wait: host/srflx candidates arrive fast; waiting for the full timeout on every
      // relay candidate would make the tile feel dead. 1.2s is enough for LAN + STUN.
      const timer = setTimeout(done, 1200);
      if (seq !== this.connectSeq) done();
    });
  }

  setMuted(muted) { if (this.video) this.video.muted = muted; }

  stop() {
    dbg('stop', `dev=${this.deviceId}`);
    this.stopped = true;
    this.connectSeq++;   // invalidate any in-flight connect
    this._clearFrameWatch();
    try { if (this.pc) this.pc.close(); } catch (_) {}
    this.pc = null;
    if (this.video) { try { this.video.srcObject = null; } catch (_) {} }
    this.mode = null;
  }
}

function tagFrames(n) { return `(${n} decoded)`; }

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
