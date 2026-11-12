/*
 * 3.0 screen share — the SHARER's half (docs/screen-share.md). Used by the dashboard
 * (components/screen-share.js) and by the meeting-room page (/share, js/share-page.js).
 *
 * The browser captures a screen, window or tab with getDisplayMedia() and sends it peer to peer to
 * the screen. The server only relays signalling over one WebSocket (/api/screen-share/ws), which this
 * opens with the single-use ticket the start/join call returned. The SCREEN makes the offer (recvonly
 * video + audio); this side answers with its tracks, so the page only ever reacts.
 *
 * No i18n here: callers turn the state names and end reasons into words.
 */

/** Why this browser cannot share its SCREEN, or null when it can. */
export function shareUnsupportedReason() {
  if (typeof window === 'undefined') return 'no_webrtc';
  if (!window.isSecureContext) return 'insecure';
  if (typeof RTCPeerConnection !== 'function') return 'no_webrtc';
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return 'no_display_media';
  return null;
}

/**
 * Why this browser cannot share its CAMERA, or null when it can. Phones (Android Chrome, iPhone
 * Safari) have getUserMedia where they have no getDisplayMedia, so a phone in the meeting room can
 * still show something: what its camera sees (a whiteboard, a page, a product).
 */
export function cameraUnsupportedReason() {
  if (typeof window === 'undefined') return 'no_webrtc';
  if (!window.isSecureContext) return 'insecure';
  if (typeof RTCPeerConnection !== 'function') return 'no_webrtc';
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return 'no_camera';
  return null;
}

/** A phone or tablet (where screen capture from the browser is not on offer). */
export function isMobileBrowser() {
  try {
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
      || !!(navigator.userAgentData && navigator.userAgentData.mobile)
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS reports a Mac
  } catch (_) { return false; }
}

/*
 * The link that opens the ScreenTinker Manager app's guest share for THIS server and code (Android).
 * An intent: URL, so Chrome opens the app when it is installed and the Play Store when it is not —
 * a self-hosted server's domain can never be a verified App Link. The app shows the server's host and
 * asks before anything is captured. Returns null for anything that is not a code.
 */
export const MANAGER_APP_ID = 'com.screentinker.manager';
export function managerAppLink(origin, rawCode) {
  const code = String(rawCode || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{8}$/.test(code) || !/^https?:\/\/[^/?#]+$/i.test(String(origin || ''))) return null;
  const store = `https://play.google.com/store/apps/details?id=${MANAGER_APP_ID}`;
  return `intent://share?server=${encodeURIComponent(origin)}&code=${code}`
    + `#Intent;scheme=screentinker;package=${MANAGER_APP_ID};S.browser_fallback_url=${encodeURIComponent(store)};end`;
}

export function isAndroid() {
  try { return /Android/i.test(navigator.userAgent || ''); } catch (_) { return false; }
}

/**
 * The phone's camera. facing: 'environment' (back, the default: point it at what you want to show)
 * or 'user' (front). MUST be called from a click (iOS Safari asks for permission on a gesture).
 * Resolves to a MediaStream, or rejects (NotAllowedError when they refuse).
 */
export async function pickCamera({ facing = 'environment', audio = false } = {}) {
  const video = { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: !!audio }); }
  catch (e) {
    // A laptop with one camera and no "environment" one, or a constraint the device refuses: any
    // camera will do rather than nothing.
    if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: !!audio });
    else throw e;
  }
  try { const v = stream.getVideoTracks()[0]; if (v && 'contentHint' in v) v.contentHint = 'motion'; } catch (_) { /* optional */ }
  return stream;
}

/**
 * Ask the person what to share. MUST be called straight from a click: browsers only open the picker
 * on a user gesture. Resolves to a MediaStream, or rejects (NotAllowedError when they cancel).
 */
export async function pickScreen({ audio = false } = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 30 } },
    audio: !!audio,
    // Chrome: offer the whole system's sound where it can (Windows, ChromeOS) and keep the sound
    // playing on the sharer's own computer too. Other browsers ignore these.
    ...(audio ? { systemAudio: 'include', suppressLocalAudioPlayback: false } : {}),
  });
  // Slides and documents are text: keep them sharp rather than smooth.
  try { const v = stream.getVideoTracks()[0]; if (v && 'contentHint' in v) v.contentHint = 'detail'; } catch (_) { /* optional */ }
  return stream;
}

/*
 * Sound was asked for but the browser captured none: Chrome shares sound only from a tab (or the whole
 * screen on Windows / ChromeOS), Firefox and Safari never do. The share goes on without it; callers
 * say so, so "Include sound" never fails silently.
 */
export function soundMissing(stream, wanted) {
  try { return !!wanted && !!stream && stream.getAudioTracks().length === 0; } catch (_) { return false; }
}

/*
 * Can this browser share sound from a screen at all? Firefox and Safari never hand getDisplayMedia a
 * sound track, whatever is ticked; Chromium browsers (Chrome, Edge, and Chrome on ChromeOS) can.
 */
export function screenSoundPossible(ua) {
  const u = String(ua === undefined ? ((typeof navigator !== 'undefined' && navigator.userAgent) || '') : ua);
  if (/Firefox\/|FxiOS\//.test(u)) return false;
  if (/Safari\//.test(u) && !/Chrome\/|Chromium\/|CriOS\/|Edg\//.test(u)) return false;
  return true;
}

/*
 * WHY there is no sound, as the i18n key of a message that says what to do about it. The browser
 * reports what was picked (displaySurface): a window never carries sound, a tab does unless the
 * picker's "Also share tab audio" was switched off, the entire screen only on Windows and ChromeOS
 * with "Also share system audio" on. A shared screen with no sound "sometimes" was nearly always the
 * picker, and a message that does not say which choice it was left people guessing.
 */
export function noSoundKey(stream, ua) {
  if (!screenSoundPossible(ua)) return 'screen_share.no_sound_browser';
  let surface = null;
  try { const v = stream && stream.getVideoTracks()[0]; surface = (v && v.getSettings && v.getSettings().displaySurface) || null; } catch (_) { surface = null; }
  if (surface === 'window') return 'screen_share.no_sound_window';
  if (surface === 'browser') return 'screen_share.no_sound_tab';
  if (surface === 'monitor') return 'screen_share.no_sound_screen';
  return 'screen_share.no_sound';
}

export function stopStream(stream) {
  try { stream && stream.getTracks().forEach((tr) => tr.stop()); } catch (_) { /* already stopped */ }
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path || '/api/screen-share/ws'}`;
}

/*
 * One share. states (onState): 'connecting' -> 'waiting_screen' -> 'negotiating' -> 'live'.
 * onEnded(reason) fires exactly once, whatever ended it; the capture is stopped by then.
 */
export class ScreenShareSender {
  // ownsStream=false: a MultiShareSender owns the capture (one stream, many legs) and stops it itself.
  // onControl(m): the server's share-level messages on this leg's socket (add_leg / leg_skipped), for
  // a MultiShareSender to act on.
  constructor({ ticket, wsPath, iceServers, stream, onState, onEnded, onControl, ownsStream = true }) {
    this.ticket = ticket;
    this.wsPath = wsPath;
    this.iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.stream = stream;
    this.onState = onState || (() => {});
    this.onEnded = onEnded || (() => {});
    this.onControl = onControl || null;
    this.ownsStream = ownsStream !== false;
    this.ws = null;
    this.pc = null;
    this.ended = false;
    this.pending = [];
  }

  start() {
    // The browser's own "Stop sharing" bar ends the video track: that is the person stopping.
    const v = this.ownsStream ? this.stream.getVideoTracks()[0] : null;
    if (v) v.addEventListener('ended', () => this.stop('stopped_by_sharer'));
    let ws;
    try { ws = new WebSocket(wsUrl(this.wsPath)); } catch (_) { this.finish('signalling_failed'); return; }
    this.ws = ws;
    this.onState('connecting');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket: this.ticket }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      this.onMessage(m);
    };
    ws.onclose = () => this.finish(this.lastReason || 'signalling_closed');
    ws.onerror = () => { /* onclose follows */ };
  }

  send(m) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(m)); } catch (_) { /* closing */ } }
  }

  async onMessage(m) {
    if (this.ended || !m) return;
    if (m.type === 'ready') this.onState('waiting_screen');
    else if (m.type === 'screen_joined') this.onState('negotiating');
    else if (m.type === 'screen_playing') this.onState('live');
    else if (m.type === 'ended') { this.lastReason = m.reason || 'ended'; this.finish(this.lastReason); }
    else if ((m.type === 'add_leg' || m.type === 'leg_skipped' || m.type === 'room' || m.type === 'room_refused') && this.onControl) { try { this.onControl(m, this); } catch (_) { /* caller's problem */ } }
    else if (m.type === 'webrtc/offer' && typeof m.value === 'string') await this.answer(m.value);
    else if (m.type === 'webrtc/candidate' && typeof m.value === 'string') {
      const c = { candidate: m.value };
      if (typeof m.mid === 'string') c.sdpMid = m.mid; else c.sdpMLineIndex = typeof m.mline === 'number' ? m.mline : 0;
      if (this.pc && this.pc.remoteDescription) this.pc.addIceCandidate(c).catch(() => {});
      else this.pending.push(c);
    }
  }

  async answer(sdp) {
    if (this.pc) return;
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: this.iceServers }); } catch (_) { this.fail(); return; }
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      this.send({ type: 'webrtc/candidate', value: e.candidate.candidate, mid: e.candidate.sdpMid, mline: e.candidate.sdpMLineIndex });
    };
    pc.onconnectionstatechange = () => {
      if (this.ended) return;
      if (pc.connectionState === 'connected') this.send({ type: 'state', value: 'connected' });
      else if (pc.connectionState === 'failed') this.fail();
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      // The screen offered one recvonly video and one recvonly audio transceiver: put our tracks on
      // them. A kind we do not have (no audio shared) is answered inactive.
      for (const tr of pc.getTransceivers()) {
        const kind = tr.receiver && tr.receiver.track && tr.receiver.track.kind;
        const track = kind === 'video' ? this.stream.getVideoTracks()[0] : kind === 'audio' ? this.stream.getAudioTracks()[0] : null;
        if (track) { await tr.sender.replaceTrack(track); tr.direction = 'sendonly'; }
        else tr.direction = 'inactive';
      }
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this.send({ type: 'webrtc/answer', value: pc.localDescription.sdp });
      for (const c of this.pending.splice(0)) pc.addIceCandidate(c).catch(() => {});
    } catch (_) { this.fail(); }
  }

  fail() {
    this.send({ type: 'state', value: 'failed' });
    this.finish('connection_failed');
  }

  // Swap what is being sent (the phone's other camera) without renegotiating.
  async replaceVideo(track) {
    if (!this.pc) return;
    for (const tr of this.pc.getTransceivers()) {
      const kind = tr.receiver && tr.receiver.track && tr.receiver.track.kind;
      if (kind === 'video' && tr.sender) { try { await tr.sender.replaceTrack(track); } catch (_) { /* this leg keeps the old picture */ } }
    }
  }

  stop(reason = 'stopped_by_sharer') {
    if (this.ended) return;
    this.send({ type: 'stop' });
    this.finish(reason);
  }

  finish(reason) {
    if (this.ended) return;
    this.ended = true;
    try { this.ws && this.ws.close(); } catch (_) { /* gone */ }
    try { this.pc && this.pc.close(); } catch (_) { /* gone */ }
    if (this.ownsStream) stopStream(this.stream);
    try { this.onEnded(reason); } catch (_) { /* caller's problem */ }
  }
}

/*
 * 3.0 multi share: ONE capture on several screens. One ScreenShareSender (its own ticket, signalling
 * socket and RTCPeerConnection) per screen, all fed the same tracks — the capture is never repeated.
 *
 *   legs: [{ ticket, ice_servers, device_id, screen_name }]   (POST /api/screen-share/shares, and the
 *         one-display start / guest join when the display has mirrors)
 *   onState({ state, live, active, total })   aggregate: 'live' once any screen plays
 *   onLegEnded({ deviceId, name }, reason)    one screen dropped out; the others carry on
 *   onLegAdded({ deviceId, name })            a screen joined mid-share (a display's mirror that
 *                                             connected while it was being shared to)
 *   onLegSkipped({ name, reason })            one could not join (the share is full, say)
 *   onRoom(room)                              several people present on one display: who is in the
 *                                             room ({ room, screen_name, presenters, you, first,
 *                                             can_control, slots }) — see roomAction()
 *   onEnded(reason)                           once, when the last screen ended or the person stopped
 */
export class MultiShareSender {
  constructor({ legs, wsPath, stream, onState, onLegEnded, onLegAdded, onLegSkipped, onRoom, onRoomRefused, onEnded }) {
    this.stream = stream;
    this.wsPath = wsPath;
    this.onState = onState || (() => {});
    this.onLegEnded = onLegEnded || (() => {});
    this.onLegAdded = onLegAdded || (() => {});
    this.onLegSkipped = onLegSkipped || (() => {});
    this.onRoom = onRoom || (() => {});
    this.onRoomRefused = onRoomRefused || (() => {});
    this.onEnded = onEnded || (() => {});
    // room id -> { state, sender }: the latest word on each display's room, and the leg it came on
    // (controls go back over that same socket, so the server knows which room they are about).
    this.rooms = new Map();
    this.ended = false;
    this.finished = false;
    this.started = false;
    this.legs = [];
    for (const l of legs || []) this.makeLeg(l);
  }

  // A guest's legs (POST /api/share/join) carry no device ids: they are told apart by session id.
  // A screen that comes back after a drop is a NEW leg (new session) under the same key.
  makeLeg(l) {
    const key = l.device_id || l.session_id;
    const leg = {
      deviceId: key, sessionId: l.session_id, name: l.screen_name || '', state: 'connecting', done: false, reason: null,
      sender: null,
    };
    leg.sender = new ScreenShareSender({
      ticket: l.ticket, wsPath: this.wsPath, iceServers: l.ice_servers, stream: this.stream, ownsStream: false,
      onState: (st) => this.legState(leg, st),
      onEnded: (reason) => this.legEnded(leg, reason),
      onControl: (m, from) => this.control(m, from),
    });
    this.legs.push(leg);
    return leg;
  }

  // The server's word on the share as a whole, from any leg's socket. It only ever ADDS a leg it
  // minted itself (a ticket for a screen the server chose); nothing here can name a screen.
  control(m, from) {
    if (this.ended || !m) return;
    if (m.type === 'room') {
      if (typeof m.room !== 'string' || !Array.isArray(m.presenters)) return;
      this.rooms.set(m.room, { state: m, sender: from });
      try { this.onRoom(m); } catch (_) { /* caller's problem */ }
      return;
    }
    if (m.type === 'room_refused') { try { this.onRoomRefused(m); } catch (_) { /* caller's problem */ } return; }
    if (m.type === 'add_leg') {
      const l = m.leg || {};
      if (typeof l.ticket !== 'string' || typeof l.session_id !== 'string') return;
      if (this.legs.some((x) => x.sessionId === l.session_id)) return;
      const leg = this.makeLeg(l);
      if (this.started) leg.sender.start();
      try { this.onLegAdded({ deviceId: leg.deviceId, name: leg.name }); } catch (_) { /* caller's problem */ }
      this.onState(this.summary());
    } else if (m.type === 'leg_skipped') {
      try { this.onLegSkipped({ name: String(m.screen_name || ''), reason: String(m.reason || '') }); } catch (_) { /* caller's problem */ }
    }
  }

  /*
   * Spotlight (target = a presenter id, or null for tiles again) or remove someone, in a room this
   * share is in. The server decides whether this presenter may (the first one, or a signed-in
   * editor); otherwise it answers room_refused.
   */
  roomAction(roomId, action, target) {
    const r = this.rooms.get(roomId);
    if (!r || !r.sender || r.sender.ended) return false;
    r.sender.send({ type: 'room', action, target: target == null ? null : String(target) });
    return true;
  }

  // The phone's other camera: every screen gets the new picture, and a screen added later too.
  async replaceVideo(stream) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || this.ended) return;
    const old = this.stream;
    this.stream = stream;
    // Sound stays the one already shared (a camera flip should not drop or double it).
    try { for (const a of old.getAudioTracks()) stream.addTrack(a); } catch (_) { /* video only */ }
    for (const l of this.legs) { l.sender.stream = stream; if (!l.done) await l.sender.replaceVideo(track); }
    try { for (const v of old.getVideoTracks()) v.stop(); } catch (_) { /* gone */ }
    track.addEventListener('ended', () => this.stop('stopped_by_sharer'));
  }

  leg(deviceId) { return this.legs.find((l) => l.deviceId === deviceId && !l.done) || this.legs.find((l) => l.deviceId === deviceId); }

  summary() {
    const active = this.legs.filter((l) => !l.done);
    const live = active.filter((l) => l.state === 'live').length;
    const state = live ? 'live' : active.some((l) => l.state === 'negotiating') ? 'negotiating' : 'connecting';
    return { state, live, active: active.length, total: this.legs.length };
  }

  start() {
    // The browser's own "Stop sharing" bar ends the capture: that stops every screen.
    const v = this.stream.getVideoTracks()[0];
    if (v) v.addEventListener('ended', () => this.stop('stopped_by_sharer'));
    this.started = true;
    for (const l of this.legs) l.sender.start();
    this.onState(this.summary());
  }

  legState(l, st) {
    if (!l || l.done || this.ended) return;
    l.state = st;
    this.onState(this.summary());
  }

  legEnded(l, reason) {
    if (!l || l.done) return;
    l.done = true; l.reason = reason;
    if (this.ended) return;
    if (this.legs.every((x) => x.done)) {
      // Every screen is gone. One reason for all of them is that reason; a mix is "the share ended".
      const reasons = new Set(this.legs.map((x) => x.reason));
      this.finish(reasons.size === 1 ? reason : 'sharer_left');
      return;
    }
    try { this.onLegEnded({ deviceId: l.deviceId, name: l.name }, reason); } catch (_) { /* caller's problem */ }
    this.onState(this.summary());
  }

  stop(reason = 'stopped_by_sharer') {
    if (this.ended) return;
    this.ended = true;
    for (const l of this.legs) { try { l.sender.stop(reason); } catch (_) { /* gone */ } }
    this.finish(reason);
  }

  finish(reason) {
    this.ended = true;
    stopStream(this.stream);
    if (this.finished) return;
    this.finished = true;
    try { this.onEnded(reason); } catch (_) { /* caller's problem */ }
  }
}
