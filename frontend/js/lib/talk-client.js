// #talk — the OPERATOR (dashboard) half of the two-way voice intercom.
//
// Mirror image of the device's AudioTalker. Two-way audio rides two one-directional Opus streams
// through go2rtc, so the operator runs two peer connections:
//   publish: operator mic -> device speaker  (POST offer to /talk/publish, go2rtc dst=downlink)
//   view:    device mic   -> operator speaker (POST offer to /talk/view,    go2rtc src=uplink)
// Both use the plain HTTP WHIP/WHEP exchange (one offer -> one answer, candidates gathered inline),
// which browsers handle fine — the same path the live viewer and web-player publisher use. The
// device side needs the WebSocket+trickle proxy because native libwebrtc drops inline candidates;
// browsers do not, so nothing fancy is needed here.
//
// start() resolves once both legs have exchanged SDP. Any failure rejects and the caller tears down.
// The device is told to join separately (socket dashboard:talk-start) by the caller.
import { getAuthHeaders } from '../api.js';

const API_BASE = '/api';

// Diagnostics only when live debug is enabled (localStorage st_live_debug !== '0'), matching the
// live viewer. Off by default so the dashboard console stays clean.
function talkDbg(...a) { try { if (localStorage.getItem('st_live_debug') === '1') console.log('[talk]', ...a); } catch (_) {} }

export class TalkClient {
  constructor(deviceId, opts = {}) {
    this.deviceId = deviceId;
    this.opts = opts;               // { onError, onConnected, duplex }
    this.duplex = !!opts.duplex;    // true = also subscribe the device's mic (2-way)
    this.pubPc = null;
    this.viewPc = null;
    this.micStream = null;
    this.audioEl = null;
    this.stopped = false;
  }

  async start() {
    // 1. Descriptor: where to signal + which ICE servers.
    const dRes = await fetch(`${API_BASE}/devices/${this.deviceId}/talk`, { headers: getAuthHeaders() });
    if (!dRes.ok) throw new Error(`talk descriptor ${dRes.status}`);
    const desc = await dRes.json();
    if (desc.mode !== 'webrtc') throw new Error(desc.reason || 'talk_unavailable');
    const ice = desc.iceServers || [];

    // 2. Operator mic + webcam (the click on the Talk button unlocks getUserMedia). Falls back to
    //    audio-only if there is no camera; the device shows the video fullscreen when present.
    this.micStream = await getTalkMedia(true);
    if (this.stopped) return;

    // 3. Publish our mic first (creates the downlink producer the device will attach to). This is
    //    the direction that must work — the operator talking TO the device.
    await this._exchange('pub', desc.publishPath, ice);
    if (!this.stopped) this.opts.onConnected?.();
    // 4. Two-way only: subscribe the device's mic. One-way Talk skips this entirely (a screen has no
    //    mic — the dashboard only offers 2-way for a device that declares remote.mic). Best-effort
    //    even so, so a device that goes quiet never collapses the operator->device direction.
    if (this.duplex) {
      this._subscribeWithRetry(desc.viewPath, ice).catch((e) => {
        talkDbg('no return audio from device:', e && e.message);
      });
    }
  }

  async _subscribeWithRetry(path, ice) {
    const delays = [700, 1000, 1500, 2000, 2500];   // ~7.7s total, covers the device's cold start
    for (let i = 0; ; i++) {
      if (this.stopped) return;
      try { await this._exchange('sub', path, ice); return; }
      catch (e) {
        if (i >= delays.length) throw e;             // give up -> caller shows "failed", one-way at worst
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }

  // One SDP exchange. dir 'pub' adds the mic (sendonly); 'sub' is recvonly and its remote track is
  // played through a hidden <audio> element.
  async _exchange(dir, path, ice) {
    // Close any prior PC for this role (a subscribe retry leaves the failed one behind).
    if (dir === 'pub') { try { this.pubPc?.close(); } catch (_) {} } else { try { this.viewPc?.close(); } catch (_) {} }
    const pc = new RTCPeerConnection({ iceServers: ice });
    if (dir === 'pub') { this.pubPc = pc; } else { this.viewPc = pc; }

    if (dir === 'pub') {
      // Operator -> device: publish mic AND (if present) webcam.
      this.micStream.getTracks().forEach((track) => pc.addTransceiver(track, { direction: 'sendonly', streams: [this.micStream] }));
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        // Play the device's audio. A hidden, autoplaying <audio> is enough; the click that started
        // the intercom satisfies autoplay policy.
        if (!this.audioEl) {
          this.audioEl = document.createElement('audio');
          this.audioEl.autoplay = true;
          this.audioEl.style.display = 'none';
          document.body.appendChild(this.audioEl);
        }
        // go2rtc's forwarded track often has no stream association, so e.streams[0] is undefined —
        // build a stream from the track itself, or nothing plays.
        this.audioEl.srcObject = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
        this.audioEl.play?.().catch(() => {});
      };
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitForIce(pc);
    if (this.stopped) { try { pc.close(); } catch (_) {} return; }

    // path is the descriptor's publishPath/viewPath — an absolute /api/... route on this origin.
    const res = await fetch(path, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`talk ${dir} signaling ${res.status}`);
    const answer = await res.text();
    if (this.stopped) { try { pc.close(); } catch (_) {} return; }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  _waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(t); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      const t = setTimeout(done, 1200);   // host/srflx arrive fast; don't wait on every relay candidate
    });
  }

  setMuted(muted) {
    try { this.micStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; }); } catch (_) {}
  }

  stop() {
    this.stopped = true;
    try { this.pubPc?.close(); } catch (_) {}
    try { this.viewPc?.close(); } catch (_) {}
    try { this.micStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl.remove(); } } catch (_) {}
    this.pubPc = null; this.viewPc = null; this.micStream = null; this.audioEl = null;
  }
}

// #talk broadcast — the OPERATOR half of a one-way group/workspace PA. Publish-only: the mic goes
// to one shared go2rtc channel and every device in scope subscribes to it (server-side). There is
// no return audio (a whole group's mics would be noise). `descriptorPath` is /api/device-groups/:id/talk
// or /api/workspaces/:id/talk — it returns { mode, publishPath, iceServers }.
export class BroadcastTalkClient {
  constructor(descriptorPath, opts = {}) {
    this.descriptorPath = descriptorPath;
    this.opts = opts;
    this.pc = null;
    this.micStream = null;
    this.stopped = false;
  }

  async start() {
    const dRes = await fetch(this.descriptorPath, { headers: getAuthHeaders() });
    if (!dRes.ok) throw new Error(`talk descriptor ${dRes.status}`);
    const desc = await dRes.json();
    if (desc.mode !== 'webrtc') throw new Error(desc.reason || 'talk_unavailable');

    // #talk video: capture webcam + mic. If there's no camera / it's denied, fall back to audio-only
    // so a PA still works. The device shows the video fullscreen; audio-only just plays the voice.
    this.micStream = await getTalkMedia(true);
    if (this.stopped) return;

    const pc = new RTCPeerConnection({ iceServers: desc.iceServers || [] });
    this.pc = pc;
    this.micStream.getTracks().forEach((tr) => pc.addTransceiver(tr, { direction: 'sendonly', streams: [this.micStream] }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    if (this.stopped) { try { pc.close(); } catch (_) {} return; }

    const res = await fetch(desc.publishPath, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`talk publish ${res.status}`);
    const answer = await res.text();
    if (this.stopped) { try { pc.close(); } catch (_) {} return; }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    if (!this.stopped) this.opts.onConnected?.();
  }

  setMuted(muted) {
    try { this.micStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; }); } catch (_) {}
  }

  stop() {
    this.stopped = true;
    try { this.pc?.close(); } catch (_) {}
    try { this.micStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this.pc = null; this.micStream = null;
  }
}

// Capture the operator's mic (+ webcam when wantVideo). AEC/NS/AGC on the mic. Falls back to
// audio-only if the camera is missing or denied, so a voice-only PA still works.
async function getTalkMedia(wantVideo) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (wantVideo) {
    try { return await navigator.mediaDevices.getUserMedia({ audio, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }); }
    catch (_) { /* no camera / denied -> voice only */ }
  }
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(t); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    const t = setTimeout(done, 1200);
  });
}
