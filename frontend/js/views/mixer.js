/*
 * The vision mixer: run your screens like a live channel.
 *
 * Laid out as a production desk, left to right the way one is used:
 *
 *   PREVIEW  what you are about to put on air (the real player, rendering the chosen playlist)
 *   PROGRAM  what the first selected screen is showing right now (its own playlist, rendered)
 *   SOURCES  a bank of keys, one per playlist. Pressing one puts it in Preview. Nothing changes on
 *            any screen until TAKE.
 *   OUTPUTS  a bank of keys, one per screen, with its tally. Select the screens the next TAKE
 *            goes to; a group key selects its members.
 *   TAKE     puts Preview on the selected screens, now (POST /api/mixer/take). What was on
 *            Program drops into Preview, so TAKE again cuts back: the mixer's flip-flop.
 *   GRAPHICS lower third, crawl, bug and title card, keyed over the selected screens through the
 *            overlay the players already have (POST /api/pip), and CLEAR to take them off.
 *
 * Keys: 1 to 9 choose a source, Enter or Space takes, Escape clears graphics.
 * The server does the work and enforces the rules (routes/mixer.js); this is the desk.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

let state = null;            // { screens, groups, sources, graphics, streams }
let so = null;               // GET /api/stream-out: what streaming is possible here, and the outputs
let addingStream = false;
let section = 'desk';         // which page of the desk: desk (everything), audio, cameras, graphics, streams
const SECTIONS = ['desk', 'audio', 'cameras', 'graphics', 'streams'];
let cued = null;             // the scene waiting on TAKE, if one was recalled
// The transition TAKE uses, remembered in this browser: { type: cut|fade|flash|wipe, ms }.
let tx = (() => { try { const v = JSON.parse(localStorage.getItem('st_mixer_tx') || 'null'); if (v && typeof v.type === 'string' && Number(v.ms) >= 200) return { type: v.type, ms: Number(v.ms) }; } catch { /* default */ } return { type: 'cut', ms: 600 }; })();
const RATES = [300, 600, 1000, 2000];
const FIXED = ['programme', 'bed', 'mic', 'line', 'net', 'net2'];
/** The strips of one stream, in desk order: the fixed inputs, the console's channels, the master. */
const stripsOf = (s) => [...FIXED, ...Array.from({ length: (s.audio.mix.console && s.audio.mix.console.count) || 0 }, (_, i) => 'c' + (i + 1)), 'master'];
/** What a strip is called: a console channel by the name it was given, or its number. */
const stripName = (s, k) => (/^c\d+$/.test(k) ? (s.audio.mix[k].label || t('mixer.strip.channel', { n: k.slice(1) })) : t('mixer.strip.' + k));
let meterBusy = false;
// ── guests ───────────────────────────────────────────────────────────────────────────────────────
// The green room of each stream: who came in by its invite link, a still of each, who is on air.
let rooms = {};              // stream id -> { invite_url, layout, layouts, guests: [...] }
let roomsSig = '', guestTimer = null;
// Guests as moving picture on this desk: each guest's browser connects straight to this page
// (server/lib/mixer-guests.js, "the operator's own view"). The server only passes the descriptions.
const deskId = (() => { const b = new Uint8Array(12); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); })();
const guestLive = new Map();   // guest id -> { pc, seq, stream, sid }
const listening = new Set();   // guest ids the operator is listening to
/*
 * TALKBACK and MERGE: the control room's sound lines to the guests. Neither is an input of any
 * stream: what is said on them reaches ears, not air.
 *
 *   Talk    this desk's microphone to one guest. Only they hear it.
 *   Merge   a conversation: every guest of one stream hears this desk's microphone and each other,
 *           and this desk hears them all. Each guest is sent everyone but themselves.
 *
 * Both run on the connection this desk already has with each guest (its sound line is open both
 * ways from the start, silent until used), and the mixing is done here, in this page: the desk is
 * the hub. Closing the desk ends them.
 */
const liveOf = (gid) => { const c = guestLive.get(gid); return c && c.pc.connectionState === 'connected' && c.stream.getVideoTracks().length ? c : null; };
let guestIce = [];
let closeArmed = null, closeTimer = null;   // the stream whose "Close the green room" has been pressed once
const liveFails = new Map();                // guest id -> how many times this desk's connection to them has failed
let rtc = null;                             // what this browser can do for a direct connection: { host, srflx, relay } once checked
const liveAsked = new Map();                // guest id -> when this desk last asked them for a new offer
const talking = new Set();     // guest ids the operator is talking to, one to one
const merged = new Set();      // stream ids whose green room is in a conversation
let talkMic = null, hub = null, hubMic = null, routing = Promise.resolve();
function route() {
  routing = routing.then(async () => {
    const wanted = talking.size > 0 || merged.size > 0;
    if (!wanted && !hub) return;
    hub = hub || new (window.AudioContext || window.webkitAudioContext)();
    if (hub.state === 'suspended') await hub.resume().catch(() => {});
    if (wanted && !talkMic) {
      talkMic = await navigator.mediaDevices.getUserMedia({ audio: { ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      hubMic = hub.createMediaStreamSource(talkMic);
    }
    for (const [gid, c] of guestLive) {
      if (!c.talk) continue;
      c.dest = c.dest || hub.createMediaStreamDestination();
      if (!c.src && c.stream.getAudioTracks().length) { try { c.src = hub.createMediaStreamSource(c.stream); } catch { /* no sound from them */ } }
      for (const node of c.ins || []) { try { node.disconnect(c.dest); } catch { /* was not connected */ } }
      c.ins = [];
      const inRoom = merged.has(c.sid);
      if (hubMic && (talking.has(gid) || inRoom)) c.ins.push(hubMic);
      if (inRoom) for (const [oid, o] of guestLive) if (oid !== gid && o.sid === c.sid && o.src) c.ins.push(o.src);      // everyone but themselves
      for (const node of c.ins) node.connect(c.dest);
      const track = c.ins.length ? c.dest.stream.getAudioTracks()[0] : null;
      if (c.sent !== track) { c.sent = track; try { await c.talk.replaceTrack(track); } catch { /* the connection is gone */ } }
    }
    // Nobody is being talked to: the microphone is let go (and its light goes out).
    if (!wanted && talkMic) { try { hubMic.disconnect(); } catch { /* gone */ } talkMic.getTracks().forEach((tr) => tr.stop()); talkMic = null; hubMic = null; }
  }).catch((err) => { talking.clear(); merged.clear(); showToast(err && err.name === 'NotAllowedError' ? t('mixer.guest_talk_mic') : (err && err.message) || String(err), 'error'); });
  return routing;
}
async function talkSet(gid, on) {
  const c = guestLive.get(gid);
  if (!c || !c.talk) throw new Error(t('mixer.guest_talk_none'));
  if (on) talking.add(gid); else talking.delete(gid);
  await route();
}
function liveDrop(gid) {
  const c = guestLive.get(gid); if (c) { try { c.pc.close(); } catch { /* gone */ } } guestLive.delete(gid);
  if (talking.delete(gid) || merged.size) route();
}
async function liveAnswer(sid, g) {
  liveDrop(g.id);
  const c = { pc: new RTCPeerConnection({ iceServers: guestIce, bundlePolicy: 'max-bundle' }), seq: g.leg_seq, stream: new MediaStream(), sid };
  guestLive.set(g.id, c);
  const said = (body) => call(`/stream-out/${encodeURIComponent(sid)}/guests/${encodeURIComponent(g.id)}/desk`, { method: 'POST', body: JSON.stringify({ desk: deskId, ...body }) }).catch(() => {});
  c.pc.ontrack = (e) => { c.stream.addTrack(e.track); };
  c.pc.onconnectionstatechange = () => {
    if (guestLive.get(g.id) !== c) return;
    if (c.pc.connectionState === 'failed') { liveFails.set(g.id, (liveFails.get(g.id) || 0) + 1); liveDrop(g.id); said({ again: true }); rtcCheck(); }
    if (c.pc.connectionState === 'connected') liveFails.delete(g.id);
    if (c.pc.connectionState === 'connected' && merged.has(sid)) route();      // someone new joins the conversation
    guestsRefresh(true);
  };
  try {
    await c.pc.setRemoteDescription({ type: 'offer', sdp: g.leg_offer });
    // The sound line of this connection is opened both ways, silent until Talk is pressed: no new offer is needed then.
    const line = c.pc.getTransceivers().find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === 'audio');
    if (line) { try { line.direction = 'sendrecv'; c.talk = line.sender; } catch { /* listen only */ } }
    await c.pc.setLocalDescription(await c.pc.createAnswer());
    await new Promise((resolve) => {
      if (c.pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 3000);
      c.pc.addEventListener('icegatheringstatechange', () => { if (c.pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
    if (guestLive.get(g.id) === c) await said({ seq: c.seq, answer: c.pc.localDescription.sdp });
  } catch { if (guestLive.get(g.id) === c) { liveDrop(g.id); said({ again: true }); } }
}
/**
 * What this browser offers for a direct connection, found out once: its own addresses, its address as
 * the internet sees it, and a relay. A browser set to hide them all (some VPN and privacy settings)
 * can show no guest live, and neither can a screen opened in it.
 */
function rtcCheck() {
  if (rtc || !window.RTCPeerConnection) return;
  rtc = { pending: true };
  (async () => {
    const found = { host: 0, srflx: 0, relay: 0 };
    try {
      const pc = new RTCPeerConnection({ iceServers: guestIce });
      pc.onicecandidate = (e) => { const m = e.candidate && / typ (host|srflx|prflx|relay)/.exec(e.candidate.candidate); if (m) found[m[1] === 'prflx' ? 'srflx' : m[1]] += 1; };
      pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 4000));
      pc.close();
    } catch { /* nothing found */ }
    rtc = found; guestsRefresh(true);
  })();
}
/** In words, why a guest is not live on this desk (or '' when they are). */
function deskLink(g) {
  if (liveOf(g.id)) return '';
  if (!window.RTCPeerConnection) return t('mixer.guest_link.no_webrtc');
  if (rtc && !rtc.pending && !rtc.host && !rtc.srflx && !rtc.relay) return t('mixer.guest_link.blocked');
  if ((liveFails.get(g.id) || 0) >= 2) return t(rtc && !rtc.pending && !rtc.relay ? 'mixer.guest_link.failed_no_relay' : 'mixer.guest_link.failed');
  return t(g.leg_seq || guestLive.has(g.id) ? 'mixer.guest_link.connecting' : 'mixer.guest_link.waiting');
}
/** Answer every guest that offers this desk a picture; let go of those who have left or offered anew. */
function liveSync() {
  const here = new Map();
  for (const [sid, r] of Object.entries(rooms)) for (const g of r.guests) here.set(g.id, [sid, g]);
  for (const gid of [...guestLive.keys()]) if (!here.has(gid)) { liveDrop(gid); listening.delete(gid); }
  if (!window.RTCPeerConnection) return;
  for (const [sid, g] of here.values()) {
    const c = guestLive.get(g.id);
    if (g.leg_offer && (!c || c.seq !== g.leg_seq)) liveAnswer(sid, g);
    else if (c && g.leg_seq && c.seq !== g.leg_seq) liveDrop(g.id);
    else if (!c && g.leg_seq && !g.leg_offer && Date.now() - (liveAsked.get(g.id) || 0) > 5000) {
      // The guest's offer to this desk was answered by a page that is gone (this one, before a reload): ask for a new one.
      liveAsked.set(g.id, Date.now());
      call(`/stream-out/${encodeURIComponent(sid)}/guests/${encodeURIComponent(g.id)}/desk`, { method: 'POST', body: JSON.stringify({ desk: deskId, again: true }) }).catch(() => {});
    }
  }
}
/** Put the live pictures into the places drawn for them. A place is drawn again often; the connection is not. */
/*
 * The green key, as the stream's renderer applies it to a cut-out guest (server/player/index.html,
 * guestKeyStart: the same rule and the same numbers), so the Program monitor shows them the way the
 * stream does. Draws `video` into `canvas` for as long as the canvas is in the page.
 */
const KEY_FS = `precision mediump float; varying vec2 uv; uniform sampler2D t;
  void main(){ vec4 c = texture2D(t, uv); float m = max(c.r, c.b); float g = c.g - m;
    float a = 1.0 - smoothstep(0.08, 0.28, g); c.g -= max(g, 0.0) * 0.85; gl_FragColor = vec4(c.rgb * a, a); }`;
function keyOnto(video, canvas) {
  let gl = null; try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch { /* none */ }
  if (!gl) return false;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, KEY_FS)); gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const draw = () => {
    if (!canvas.isConnected) return;
    try {
      if (video.videoWidth && video.readyState >= 2) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; gl.viewport(0, 0, canvas.width, canvas.height); }
        canvas.style.objectFit = video.videoHeight > video.videoWidth ? 'contain' : 'cover';
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    } catch { /* a frame that was not ready */ }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw); else requestAnimationFrame(draw);
  };
  draw();
  return true;
}
function liveAttach(root) {
  if (!root) return;
  root.querySelectorAll('video[data-gvid]').forEach((v) => {
    const c = liveOf(v.dataset.gvid); if (!c) return;
    v.muted = v.dataset.sound !== '1' || !(listening.has(v.dataset.gvid) || merged.has(c.sid));
    if (v.srcObject !== c.stream) {
      // On the Program monitor, as in the stream: an upright picture is shown whole, a wide one fills its box.
      if (v.closest('.mx-guest-tile')) { const fit = () => { v.style.objectFit = v.videoHeight > v.videoWidth ? 'contain' : 'cover'; }; v.addEventListener('loadedmetadata', fit); v.addEventListener('resize', fit); }
      v.srcObject = c.stream;
      // A cut-out guest: the picture goes through the key onto the canvas beside it, and the video itself is not shown.
      const cv = v.dataset.key === '1' ? v.parentElement.querySelector('canvas') : null;
      if (cv && keyOnto(v, cv)) v.parentElement.classList.add('is-keyed');
    }
    v.play().catch(() => {});
  });
}
function guestsHtml() {
  if (!so || !so.available || !streams().length) return '';
  return `<h3>${esc(t('mixer.guests'))}</h3>
    ${streams().map((s) => { const r = rooms[s.id], url = r && r.invite_url ? window.location.origin + r.invite_url : ''; return `
      <div class="mx-room">
        <div class="mx-group-name"><span class="mx-lamp mx-lamp-${streamTally(s)}"></span>${esc(s.name)}
          ${url ? `<span class="mx-room-keys">${(r.layouts || []).map((l) => `<button type="button" class="mx-key mx-key-sm${r.layout === l ? ' is-on' : ''}" data-glayout="${esc(s.id)}" data-layout="${esc(l)}" aria-pressed="${r.layout === l}">${esc(t('mixer.guest_layout.' + l))}</button>`).join('')}</span>` : ''}
          ${url && r.guests.length ? `<button type="button" class="btn btn-sm ${merged.has(s.id) ? 'mx-golive' : 'btn-secondary'}" data-gmerge="${esc(s.id)}" aria-pressed="${merged.has(s.id)}" ${r.guests.some((g) => liveOf(g.id)) ? '' : 'disabled'} title="${esc(t('mixer.guest_merge_tip'))}">${esc(t(merged.has(s.id) ? 'mixer.guest_merged' : 'mixer.guest_merge'))}</button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm mx-meters-on" data-ginvite="${esc(s.id)}">${esc(t(url ? 'mixer.guest_copy' : 'mixer.guest_invite'))}</button>
          ${url ? `<button type="button" class="btn btn-secondary btn-sm" data-grevoke="${esc(s.id)}">${esc(t(closeArmed === s.id ? 'mixer.guest_close_sure' : 'mixer.guest_close'))}</button>` : ''}</div>
        ${url ? `<input class="input mx-room-link" readonly value="${esc(url)}" aria-label="${esc(t('mixer.guest_link'))}" data-glink>
          ${s.status.state === 'off' ? `<p class="mx-note mx-room-off">${esc(t('mixer.guest_need_standby'))} <button type="button" class="btn btn-secondary btn-sm" data-gstandby="${esc(s.id)}">${esc(t('mixer.standby'))}</button></p>` : ''}
          ${r.guests.length ? `<div class="mx-guest-list">${r.guests.map((g) => `
            <div class="mx-guest${g.on_air ? ' is-air' : ''}">
              <div class="mx-guest-pic">${liveOf(g.id) ? `<video data-gvid="${esc(g.id)}" data-sound="1" autoplay muted playsinline></video>` : g.thumb ? `<img data-gthumb="${esc(g.id)}" src="${esc(g.thumb)}" alt="">` : `<span>${esc(t('mixer.guest_state.' + (s.status.state === 'off' ? 'waiting' : g.state === 'connected' ? 'connected' : 'connecting')))}</span>`}${g.on_air ? `<b>${esc(t('mixer.guest_on_air'))}</b>` : ''}${s.status.state !== 'off' && g.state !== 'connected' ? `<i class="mx-guest-badge">${esc(t('mixer.guest_state.connecting'))}</i>` : ''}</div>
              <div class="mx-guest-name" title="${esc(g.name)}">${esc(g.name)}</div>
              ${deskLink(g) ? `<div class="mx-guest-link">${esc(deskLink(g))}</div>` : ''}
              <label class="mx-guest-level" title="${esc(t('mixer.guest_level_tip'))}"><span>${esc(t('mixer.guest_level'))}</span><input type="range" min="0" max="100" step="1" value="${Math.round((g.level == null ? 1 : g.level) * 100)}" data-glevel="${esc(s.id)}" data-gid="${esc(g.id)}" aria-label="${esc(t('mixer.guest_level_for', { name: g.name }))}"><output>${Math.round((g.level == null ? 1 : g.level) * 100)}%</output></label>
              <div class="mx-guest-keys"><button type="button" class="btn btn-sm ${g.on_air ? 'btn-secondary' : 'mx-golive'}" data-gair="${esc(s.id)}" data-gid="${esc(g.id)}" data-on="${g.on_air ? 0 : 1}" ${(s.status.state === 'off' || g.state !== 'connected') && !g.on_air ? `disabled title="${esc(t('mixer.guest_not_connected'))}"` : ''}>${esc(t(g.on_air ? 'mixer.guest_off' : 'mixer.guest_put_on'))}</button>
                <button type="button" class="btn btn-secondary btn-sm${listening.has(g.id) || merged.has(s.id) ? ' is-on' : ''}" data-glisten="${esc(g.id)}" aria-pressed="${listening.has(g.id) || merged.has(s.id)}" ${merged.has(s.id) || !liveOf(g.id) ? 'disabled' : ''} title="${esc(liveOf(g.id) ? t('mixer.guest_listen_tip') : deskLink(g))}">${esc(t(listening.has(g.id) || merged.has(s.id) ? 'mixer.guest_listening' : 'mixer.guest_listen'))}</button>
                <button type="button" class="btn btn-sm ${talking.has(g.id) || merged.has(s.id) ? 'mx-golive' : 'btn-secondary'}" data-gtalk="${esc(g.id)}" aria-pressed="${talking.has(g.id) || merged.has(s.id)}" ${merged.has(s.id) || !(liveOf(g.id) && guestLive.get(g.id).talk) ? 'disabled' : ''} title="${esc(liveOf(g.id) ? t('mixer.guest_talk_tip') : deskLink(g))}">${esc(t(talking.has(g.id) || merged.has(s.id) ? 'mixer.guest_talking' : 'mixer.guest_talk'))}</button>
                <button type="button" class="btn btn-secondary btn-sm${g.cut ? ' is-on' : ''}" data-gcut="${esc(s.id)}" data-gid="${esc(g.id)}" data-on="${g.cut ? 0 : 1}" aria-pressed="${!!g.cut}" title="${esc(t(g.green ? 'mixer.guest_cut_tip_green' : 'mixer.guest_cut_tip'))}">${esc(t(g.cut ? 'mixer.guest_cut_on' : 'mixer.guest_cut'))}</button>
                <button type="button" class="btn btn-secondary btn-sm" data-gdel="${esc(s.id)}" data-gid="${esc(g.id)}">${esc(t('mixer.guest_remove'))}</button></div>
            </div>`).join('')}</div>` : `<p class="mx-note">${esc(t('mixer.guest_none'))}</p>`}` : ''}
      </div>`; }).join('')}
    <p class="mx-note">${esc(t('mixer.guest_note'))}</p>`;
}
async function guestsRefresh(force) {
  let r; try { r = await call(`/stream-out/guests?desk=${deskId}`); } catch { return; }      // only the request failing is passed over: the next poll asks again
  rooms = r.rooms || {}; guestIce = r.ice_servers || [];
  liveSync();
  // A guest who has been here a while and is still not live on this desk: find out what this browser can do.
  if (Object.values(rooms).some((r) => r.guests.some((g) => !liveOf(g.id) && Date.now() - g.joined_at > 8000))) rtcCheck();
  // What is drawn: a guest shown live does not need drawing again each time their still is renewed.
  // The panel is drawn again only when what it is made of changes. A renewed still is put into the
  // picture that is already there: drawing the panel again every two seconds would take the key
  // from under the operator's finger, and the keyboard's place with it.
  const el = document.getElementById('mxGuests');
  const stills = new Map(Object.values(rooms).flatMap((r) => r.guests.filter((g) => g.thumb).map((g) => [g.id, g.thumb])));
  document.querySelectorAll('img[data-gthumb]').forEach((img) => { const src = stills.get(img.dataset.gthumb); if (src && img.getAttribute('src') !== src) img.setAttribute('src', src); });
  const sig = JSON.stringify([closeArmed, [...merged], Object.entries(rooms).map(([sid, r]) => [sid, r.invite_url, r.layout, r.guests.map((g) => [g.id, g.name, g.on_air, g.state, liveOf(g.id) ? 'live' : !!g.thumb, listening.has(g.id), talking.has(g.id), g.cut, g.green, deskLink(g), g.level])])]) + streams().map((s) => s.status.state).join();
  if (sig === roomsSig && !force) return;
  roomsSig = sig;
  guestLayer();
  if (!el) return;
  el.innerHTML = guestsHtml(); guestsBind(el); liveAttach(el);
}
function guestsBind(el) {
  const act = (sel, fn) => el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(b); } catch (err) { showToast(err.message, 'error'); }
    guestsRefresh(true);
  }));
  act('[data-ginvite]', async (b) => {
    const r = await call(`/stream-out/${encodeURIComponent(b.dataset.ginvite)}/guests/invite`, { method: 'POST' });
    const url = window.location.origin + r.invite_url;
    try { await navigator.clipboard.writeText(url); showToast(t('mixer.toast.guest_copied'), 'success'); } catch { showToast(t('mixer.toast.guest_link_ready'), 'info'); }
  });
  act('[data-grevoke]', async (b) => {
    const sid = b.dataset.grevoke;
    // Twice to close: the first press arms the key (for a few seconds), the second closes the room.
    if (closeArmed !== sid) { closeArmed = sid; clearTimeout(closeTimer); closeTimer = setTimeout(() => { closeArmed = null; guestsRefresh(true); }, 6000); showToast(t('mixer.guest_close_warn'), 'info'); return; }
    closeArmed = null; clearTimeout(closeTimer);
    await call(`/stream-out/${encodeURIComponent(sid)}/guests/invite`, { method: 'DELETE' });
  });
  el.querySelectorAll('[data-glisten]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.glisten; if (listening.has(id)) listening.delete(id); else listening.add(id); guestsRefresh(true); }));
  act('[data-gmerge]', (b) => { const sid = b.dataset.gmerge; if (merged.has(sid)) merged.delete(sid); else merged.add(sid); return route(); });
  act('[data-gtalk]', (b) => talkSet(b.dataset.gtalk, !talking.has(b.dataset.gtalk)));
  act('[data-gstandby]', async (b) => {
    const sid = b.dataset.gstandby, s = streams().find((x) => x.id === sid);
    const r = await call(`/stream-out/${encodeURIComponent(sid)}/start`, { method: 'POST', body: JSON.stringify({ standby: true }) });
    if (s && r.status) s.status = { ...s.status, ...r.status };
    showToast(t('mixer.toast.standby'), 'success');
  });
  act('[data-glayout]', (b) => call(`/stream-out/${encodeURIComponent(b.dataset.glayout)}/guests/layout`, { method: 'POST', body: JSON.stringify({ layout: b.dataset.layout }) }));
  act('[data-gair]', (b) => call(`/stream-out/${encodeURIComponent(b.dataset.gair)}/guests/${encodeURIComponent(b.dataset.gid)}`, { method: 'POST', body: JSON.stringify({ on_air: b.dataset.on === '1' }) }));
  // A guest's volume: the number follows the fader as it moves, and the stream takes it when the fader is let go
  // (the panel is not drawn again under a fader that is being held).
  el.querySelectorAll('[data-glevel]').forEach((r) => {
    r.addEventListener('input', () => { r.nextElementSibling.textContent = r.value + '%'; });
    r.addEventListener('change', async () => {
      try { await call(`/stream-out/${encodeURIComponent(r.dataset.glevel)}/guests/${encodeURIComponent(r.dataset.gid)}`, { method: 'POST', body: JSON.stringify({ level: Number(r.value) / 100 }) }); } catch (err) { showToast(err.message, 'error'); }
      guestsRefresh(true);
    });
  });
  act('[data-gcut]', (b) => call(`/stream-out/${encodeURIComponent(b.dataset.gcut)}/guests/${encodeURIComponent(b.dataset.gid)}`, { method: 'POST', body: JSON.stringify({ cut: b.dataset.on === '1' }) }));
  act('[data-gdel]', (b) => call(`/stream-out/${encodeURIComponent(b.dataset.gdel)}/guests/${encodeURIComponent(b.dataset.gid)}`, { method: 'DELETE' }));
  el.querySelectorAll('[data-glink]').forEach((i) => i.addEventListener('focus', () => i.select()));
}
// This computer's microphone, open into one stream: { sid, rec, media }. The browser records it
// and the pieces are sent up in order, one request at a time.
let mic = null;
// Which of this computer's inputs the Desk mic uses (a USB console shows up here too), remembered in this browser.
let micDevices = [];
let micDeviceId = (() => { try { return localStorage.getItem('st_mixer_mic') || ''; } catch { return ''; } })();
async function micList() {
  try { micDevices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId); } catch { micDevices = []; }
  if (micDeviceId && !micDevices.some((d) => d.deviceId === micDeviceId)) micDeviceId = '';
}
function micStop() {
  if (!mic) return;
  const m = mic; mic = null;
  try { m.rec.stop(); } catch { /* already */ }
  m.media.getTracks().forEach((tr) => tr.stop());
  call(`/stream-out/${encodeURIComponent(m.sid)}/mic`, { method: 'POST', body: JSON.stringify({ stop: true }) }).catch(() => {});
}
async function micStart(sid) {
  micStop();
  if (!navigator.mediaDevices || !window.MediaRecorder || !MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error(t('mixer.mic_unsupported'));
  // Asking for it is what makes the browser show its "allow microphone" prompt. Its own processing
  // is off: the desk has a noise floor control, a gate and a compressor of its own.
  const media = await navigator.mediaDevices.getUserMedia({ audio: { ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}), channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  await micList();                                          // the devices have names once the browser has said yes
  const rec = new MediaRecorder(media, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
  const me = { sid, rec, media }; mic = me;
  let first = true, chain = Promise.resolve(), misses = 0;
  rec.ondataavailable = (e) => {
    if (mic !== me || !e.data || !e.data.size) return;
    const isFirst = first; first = false;
    chain = chain.then(async () => {
      if (mic !== me) return;
      const bytes = new Uint8Array(await e.data.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      try { await call(`/stream-out/${encodeURIComponent(sid)}/mic`, { method: 'POST', body: JSON.stringify({ chunk: btoa(bin), first: isFirst }) }); misses = 0; }
      catch (err) { if (++misses >= 3 && mic === me) { micStop(); showToast(err.message, 'error'); } }
    });
  };
  media.getTracks().forEach((tr) => tr.addEventListener('ended', () => { if (mic === me) micStop(); }));
  rec.start(250);
}
const onAirGfx = new Map();  // output id -> { uri, position, w, h }: the graphic this desk keyed over it
/** The graphic over the Program monitor's output, as the output shows it: the same page, in the same box. */
function gfxLayer(root, pgm) {
  const screen = document.getElementById('mxPgmScreen'); if (!screen) return;
  const g = pgm ? (onAirGfx.has(pgm.id) ? onAirGfx.get(pgm.id) : (pgm.graphic_on || null)) : null;
  const had = screen.querySelector('.mx-gfx-layer'), key = g ? JSON.stringify(g) : '';
  if (had && had.dataset.key === key) return;             // already showing it: do not restart its animation
  if (had) had.remove();
  if (!g) return;
  const f = document.createElement('iframe');
  f.className = 'mx-gfx-layer mx-gfx-' + String(g.position).replace(/[^a-z-]/g, ''); f.dataset.key = key;
  f.setAttribute('sandbox', ''); f.setAttribute('tabindex', '-1'); f.setAttribute('aria-hidden', 'true'); f.setAttribute('allowtransparency', 'true');
  f.style.width = (g.w * 100) + '%'; f.style.height = (g.h * 100) + '%';
  f.src = g.uri;
  screen.appendChild(f);
}
// Where on-air guests sit in the picture, in percent: the same boxes the stream's renderer uses (player/index.html guestRects).
function guestRects(layout, n) {
  if (layout === 'grid') {
    if (n === 1) return [[0, 0, 100, 100]];
    if (n === 2) return [[0, 0, 50, 100], [50, 0, 50, 100]];
    return Array.from({ length: n }, (_, i) => [(i % 2) * 50 + (n === 3 && i === 2 ? 25 : 0), Math.floor(i / 2) * 50, 50, 50]);
  }
  if (layout === 'side') return Array.from({ length: n }, (_, i) => [60, i * (100 / n), 40, 100 / n]);
  const h = Math.min(24, (94 - 2 * (n - 1)) / n);      // four in a column still fit the height
  return Array.from({ length: n }, (_, i) => [100 - 2 - h, 100 - 3 - (i + 1) * h - i * 2, h, h]);
}
/** The on-air guests of the stream on the Program monitor, where the stream shows them. Stills, renewed every two seconds: the moving picture is in the stream itself. */
function guestLayer() {
  const screen = document.getElementById('mxPgmScreen'); if (!screen) return;
  const pgm = onProgram(), room = pgm && isStream(pgm) ? rooms[pgm.id] : null;
  const air = room ? room.guests.filter((g) => g.on_air) : [];
  let layer = screen.querySelector('.mx-guest-layer');
  if (!air.length) { if (layer) layer.remove(); return; }
  if (!layer) { layer = document.createElement('div'); layer.className = 'mx-guest-layer'; layer.setAttribute('aria-hidden', 'true'); screen.appendChild(layer); }
  const rects = guestRects(room.layout, air.length);
  // Drawn again only when who is shown, or how, changes: a live picture must not restart every two seconds.
  const key = JSON.stringify([room.layout, air.map((g) => [g.id, g.name, liveOf(g.id) ? 'live' : !!g.thumb, g.cut])]);
  if (layer.dataset.key !== key) {
    layer.dataset.key = key;
    layer.innerHTML = air.map((g, i) => `<div class="mx-guest-tile" style="left:${rects[i][0]}%;top:${rects[i][1]}%;width:${rects[i][2]}%;height:${rects[i][3]}%">${liveOf(g.id) ? `<video data-gvid="${esc(g.id)}" ${g.cut ? 'data-key="1"' : ''} autoplay muted playsinline></video>${g.cut ? '<canvas></canvas>' : ''}` : g.thumb ? `<img data-gthumb="${esc(g.id)}" src="${esc(g.thumb)}" alt="">` : ''}<span>${esc(g.name)}</span></div>`).join('');
  }
  liveAttach(layer);
}
let procOpen = null;         // the strip whose processing is open on the desk: { sid, strip }
/** Whether a strip's processing does anything: its EQ key is lit when it does. */
const shaped = (st) => !!(st.hpf || st.lpf || st.trim || st.inv || st.pan || st.gate || st.comp || (st.cmp && st.cmp.on) || st.deess || st.chorus || st.fx || st.dly || st.duck || st.denoise || (st.eq && (st.eq.low || st.eq.lomid || st.eq.mid || st.eq.high)));
const sizeOf = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB');
/** A meter's height for a peak of 0..1: a dB scale from -60 to 0, as a desk's meter reads. */
const meterPct = (v) => (v > 0.001 ? Math.round(Math.max(0, Math.min(1, (20 * Math.log10(v) + 60) / 60)) * 100) : 0);
/** How a control's value reads on the desk, by what kind of control it is. */
function fmt(ctl, v) {
  v = Number(v);
  if (ctl === 'pan') return Math.abs(v) < 0.02 ? t('mixer.pan_c') : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
  if (ctl === 'lpf') return v > 20000 || v <= 0 ? t('mixer.audio_off') : (v / 1000).toFixed(1) + ' kHz';
  if (/_f$/.test(ctl)) return v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz';
  if (/_q$/.test(ctl)) return 'Q ' + v.toFixed(1);
  if (ctl === 'cmp.ratio') return v.toFixed(1) + ':1';
  if (ctl === 'cmp.att' || ctl === 'cmp.rel' || ctl === 'fx.delay_ms') return Math.round(v) + ' ms';
  if (ctl === 'trim' || ctl === 'cmp.thr' || ctl === 'cmp.gain' || /^eq\.(low|lomid|mid|high)$/.test(ctl)) return (v > 0 ? '+' : '') + v + ' dB';
  if (ctl === 'fx.decay' || ctl === 'fx.delay_fb') return Math.round(v * 100) + '%';
  return v ? Math.round(v * 100) + '%' : t('mixer.audio_off');
}
const knob = (s, strip, ctl, label, value, min, max, step) => `<label class="mx-knob">${esc(label)}<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-proc="${esc(s.id)}" data-strip="${strip}" data-ctl="${ctl}"><output>${esc(fmt(ctl, value))}</output></label>`;
const tick = (s, strip, ctl, label, on) => `<label class="mx-knob mx-knob-check"><input type="checkbox" ${on ? 'checked' : ''} data-proc="${esc(s.id)}" data-strip="${strip}" data-ctl="${ctl}"> ${esc(label)}</label>`;
const sect = (title, body) => `<div class="mx-proc-sect"><h5>${esc(title)}</h5><div class="mx-knobs">${body}</div></div>`;
/** A strip with every control at neutral: what "Set flat" sends. */
const FLAT = { trim: 0, inv: false, pan: 0, hpf: false, hpf_f: 80, lpf: 0, eq: { low: 0, lomid: 0, mid: 0, high: 0, low_f: 120, lomid_f: 400, lomid_q: 1, mid_f: 1200, mid_q: 0.9, high_f: 8000 }, gate: 0, comp: 0, cmp: { on: false, thr: -20, ratio: 3, att: 8, rel: 200, gain: 0 }, deess: 0, chorus: 0, fx: 0, dly: 0, duck: 0, denoise: 0 };
/** The processing of one strip: what a console channel has between its input and its fader. */
function procPanel(s, strip) {
  const st = s.audio.mix[strip], master = strip === 'master', fx = s.audio.mix.fx, k = (...a) => knob(s, strip, ...a);
  const band = (...knobs) => `<div class="mx-band">${knobs.join('')}</div>`;
  const eq = `<div class="mx-proc-sect"><h5>${esc(t('mixer.sect_eq'))}</h5><div class="mx-bands">
      ${band(k('eq.low', t('mixer.audio_eq_low'), st.eq.low, -12, 12, 1), k('eq.low_f', t('mixer.at_freq'), st.eq.low_f, 40, 400, 10))}
      ${band(k('eq.lomid', t('mixer.audio_eq_lomid'), st.eq.lomid, -12, 12, 1), k('eq.lomid_f', t('mixer.at_freq'), st.eq.lomid_f, 100, 2000, 50), k('eq.lomid_q', t('mixer.width'), st.eq.lomid_q, 0.3, 6, 0.1))}
      ${band(k('eq.mid', t('mixer.audio_eq_mid'), st.eq.mid, -12, 12, 1), k('eq.mid_f', t('mixer.at_freq'), st.eq.mid_f, 400, 8000, 100), k('eq.mid_q', t('mixer.width'), st.eq.mid_q, 0.3, 6, 0.1))}
      ${band(k('eq.high', t('mixer.audio_eq_high'), st.eq.high, -12, 12, 1), k('eq.high_f', t('mixer.at_freq'), st.eq.high_f, 2000, 16000, 500))}
    </div></div>`;
  const comp = `${k('comp', t('mixer.audio_comp'), st.comp, 0, 1, 0.05)}
      ${tick(s, strip, 'cmp.on', t('mixer.cmp_manual'), st.cmp.on)}
      ${st.cmp.on ? `${k('cmp.thr', t('mixer.cmp_thr'), st.cmp.thr, -60, 0, 1)}${k('cmp.ratio', t('mixer.cmp_ratio'), st.cmp.ratio, 1, 20, 0.5)}${k('cmp.att', t('mixer.cmp_att'), st.cmp.att, 0.1, 100, 0.1)}${k('cmp.rel', t('mixer.cmp_rel'), st.cmp.rel, 10, 2000, 10)}${k('cmp.gain', t('mixer.cmp_gain'), st.cmp.gain, 0, 24, 0.5)}` : ''}`;
  return `<div class="mx-proc" role="group" aria-label="${esc(stripName(s, strip))}">
    <div class="mx-proc-title">${esc(t('mixer.audio_proc_of', { strip: stripName(s, strip) }))}<button type="button" class="btn btn-secondary btn-sm" data-procreset="${esc(s.id)}" data-strip="${strip}">${esc(t('mixer.audio_flat'))}</button></div>
    ${master ? `${eq}${sect(t('mixer.sect_dyn'), comp)}${sect(t('mixer.sect_fx_returns'), `
      ${k('fx.decay', t('mixer.audio_room'), fx.decay, 0, 1, 0.05)}${k('fx.delay_ms', t('mixer.delay_time'), fx.delay_ms, 50, 1500, 10)}${k('fx.delay_fb', t('mixer.delay_fb'), fx.delay_fb, 0, 0.9, 0.05)}`)}` : `
    ${sect(t('mixer.sect_input'), `
      ${/^c\d+$/.test(strip) ? `<label class="mx-knob mx-knob-name">${esc(t('mixer.channel_name'))}<input class="input" maxlength="24" value="${esc(st.label || '')}" placeholder="${esc(t('mixer.strip.channel', { n: strip.slice(1) }))}" data-chname="${esc(s.id)}" data-strip="${strip}"></label>` : ''}
      ${k('trim', t('mixer.trim'), st.trim, -20, 40, 1)}${k('pan', t('mixer.pan'), st.pan, -1, 1, 0.05)}
      ${tick(s, strip, 'inv', t('mixer.invert'), st.inv)}
      ${tick(s, strip, 'hpf', t('mixer.audio_hpf_on'), st.hpf)}${k('hpf_f', t('mixer.at_freq'), st.hpf_f, 20, 400, 10)}
      ${k('lpf', t('mixer.lpf'), st.lpf > 0 ? st.lpf : 20500, 1000, 20500, 500)}
      ${k('denoise', t('mixer.audio_denoise'), st.denoise, 0, 1, 0.05)}
      <span class="mx-knob mx-noise">${esc(t(st.noise ? 'mixer.audio_noise_learned' : 'mixer.audio_noise_auto'))}
        <span class="mx-noise-keys"><button type="button" class="btn btn-secondary btn-sm" data-learn="${esc(s.id)}" data-strip="${strip}" ${s.status.state === 'live' || s.status.state === 'standby' ? '' : 'disabled'} title="${esc(t('mixer.audio_noise_learn_tip'))}">${esc(t('mixer.audio_noise_learn'))}</button>
        ${st.noise ? `<button type="button" class="btn btn-secondary btn-sm" data-forget="${esc(s.id)}" data-strip="${strip}">${esc(t('mixer.audio_noise_forget'))}</button>` : ''}</span></span>`)}
    ${eq}
    ${sect(t('mixer.sect_dyn'), `${k('gate', t('mixer.audio_gate'), st.gate, 0, 1, 0.05)}${k('deess', t('mixer.deess'), st.deess, 0, 1, 0.05)}${k('duck', t('mixer.duck'), st.duck, 0, 1, 0.05)}${comp}`)}
    ${sect(t('mixer.sect_fx'), `${k('fx', t('mixer.audio_reverb'), st.fx, 0, 1, 0.05)}${k('dly', t('mixer.delay_send'), st.dly, 0, 1, 0.05)}${k('chorus', t('mixer.chorus'), st.chorus, 0, 1, 0.05)}`)}`}
    <p class="mx-note">${esc(t(master ? 'mixer.audio_proc_master_note' : 'mixer.audio_proc_note'))}</p>
  </div>`;
}
let savingScene = false;
let cam = null;              // the camera being steered: { id, presets, last: { preset, name } | null }
let camSpeed = 0.5;
let holdTimer = null;
let meterTimer = null;
// ── audio bars on the Preview and Program monitors ───────────────────────────────────────────────
// Measured here, in this browser, from the monitor's own player: each video or audio element it
// is playing is tapped (captureStream) into an analyser. Nothing is routed to the speakers by
// this, and a monitor that plays muted still shows its level: the bar says what the source
// carries, not what this computer is playing out loud.
let monTimer = null, actx = null;
const taps = new WeakMap();  // media element -> { ms, an } | null (cannot be tapped)
const monHeld = { mxPvwScreen: 0, mxPgmScreen: 0 };
const monBuf = new Float32Array(1024);
function tapOf(m) {
  let tp = taps.get(m);
  if (tp === null) return null;
  try {
    if (!tp) {
      if (m.readyState < 2) return null;
      const ms = m.captureStream ? m.captureStream() : (m.mozCaptureStream ? m.mozCaptureStream() : null);
      if (!ms) { taps.set(m, null); return null; }
      tp = { ms, an: null }; taps.set(m, tp);
    }
    if (!tp.an) {
      if (!tp.ms.getAudioTracks().length) return null;       // no sound track (yet)
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      tp.an = actx.createAnalyser(); tp.an.fftSize = 1024;
      actx.createMediaStreamSource(tp.ms).connect(tp.an);
    }
    return tp.an;
  } catch { taps.set(m, null); return null; }
}
function monitorLevels() {
  for (const id of Object.keys(monHeld)) {
    const screen = document.getElementById(id); if (!screen) continue;
    const bar = screen.parentNode.querySelector('.mx-mon-meter i'); if (!bar) continue;
    let peak = 0, any = false, doc = null;
    const f = screen.querySelector('iframe.mx-frame');
    try { doc = f && f.contentDocument; } catch { doc = null; }
    if (doc) for (const m of doc.querySelectorAll('video, audio')) {
      const an = tapOf(m); if (!an) continue;
      any = true;
      if (m.paused) continue;
      an.getFloatTimeDomainData(monBuf);
      for (let i = 0; i < monBuf.length; i++) { const v = monBuf[i] < 0 ? -monBuf[i] : monBuf[i]; if (v > peak) peak = v; }
    }
    monHeld[id] = Math.max(peak, monHeld[id] * 0.8);
    bar.parentNode.classList.toggle('has-audio', any);
    bar.style.height = meterPct(monHeld[id]) + '%';
  }
}
// An AudioContext only runs after the person has done something on the page; any click on the desk is that.
const wakeAudio = () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); };
const volumes = new Map();   // screen id -> { level 0..100, muted } as last set from this desk
let pvw = null;              // playlist id in Preview
let outputs = new Set();     // selected screen ids
let onKey = null;
let refreshTimer = null;
let alive = false;

const call = (path, opts) => api.desk(path, opts);

let pgmFx = null;            // the transition the Program monitor should show for the take just made
const playlistFeed = (id, tag) => ({ page: `/player?preview=1&playlist=${encodeURIComponent(id)}&orientation=landscape`,
  feed: `/api/playlists/${encodeURIComponent(id)}/preview-payload?orientation=landscape`, key: `${tag}:${id}` });
/** Shows `src` in a monitor. A monitor that is already running is switched in place, with the
 *  take's transition when there is one; it is only (re)loaded when it has no player yet. */
function monitor(el, src, emptyText, fx) {
  let f = el.querySelector('iframe.mx-frame');
  if (!src) { el.innerHTML = `<div class="mx-empty">${esc(emptyText)}</div>`; el.dataset.key = ''; return; }
  if (el.dataset.key === src.key && f) return;
  el.dataset.key = src.key;
  if (f && f.dataset.ready === '1') {
    try { f.contentWindow.postMessage({ source: 'screentinker-preview', action: 'load', url: src.feed, take_fx: fx || null }, window.location.origin); return; } catch { /* reload it instead */ }
  }
  el.innerHTML = '';
  f = document.createElement('iframe');
  f.className = 'mx-frame'; f.title = ''; f.tabIndex = -1;
  f.addEventListener('load', () => { f.dataset.ready = '1'; });
  f.src = src.page;
  el.appendChild(f);
}
const streams = () => (so && so.outputs) || [];
const firstOutput = () => (state ? (state.screens.find((s) => outputs.has(s.id)) || streams().find((s) => outputs.has(s.id))) : null);
const isStream = (o) => !!o && streams().includes(o);
/**
 * What the Program monitor shows: what is really live on the first selected output. A screen that is
 * showing a stream's picture is live with that stream (its programme, graphics and guests), not
 * with the playlist it would otherwise play.
 */
const onProgram = () => { const o = firstOutput(); return (o && !isStream(o) && followOf(o.id)) || o; };
/** The stream whose picture a screen is showing, if any. */
const followOf = (deviceId) => streams().find((s) => (s.on_screens || []).some((x) => x.id === deviceId)) || null;
const streamTally = (s) => (s.status.state === 'live' ? 'air' : s.status.state === 'off' ? 'idle' : 'standby');
async function load() {
  const [m, s] = await Promise.all([call('/mixer'), call('/stream-out').catch(() => null)]);
  so = s; return m;
}
const sourceName = (id) => { const s = state && state.sources.find((x) => x.id === id); return s ? s.name : ''; };

function tallyOf(s) {
  if (s.status === 'online') return 'air';
  return s.status === 'offline' ? 'off' : 'standby';
}

const cuedScene = () => (cued && state.scenes.find((s) => s.id === cued)) || null;
const DIRS = [[-1, 1, '↖'], [0, 1, '↑'], [1, 1, '↗'], [-1, 0, '←'], null, [1, 0, '→'], [-1, -1, '↙'], [0, -1, '↓'], [1, -1, '↘']];

function draw(root) {
  const pgm = onProgram();
  const scene = cuedScene();
  const selScreens = state.screens.filter((s) => outputs.has(s.id));
  // The monitors are built ONCE and switched in place (the preview player is told to load the new
  // source): rebuilding them on every key press reloaded both pictures, which read as the screen
  // resetting. Everything else on the desk is redrawn freely.
  if (!root.querySelector('#mxPvwScreen')) {
    root.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('mixer.title'))}</h1><div class="subtitle">${esc(t('mixer.subtitle'))}</div></div>
    </div>
    <div class="mx">
      <section class="mx-monitors">
        <div class="mx-mon mx-pvw"><div class="mx-mon-label" id="mxPvwLabel"></div><div class="mx-screen" id="mxPvwScreen"></div><div class="mx-mon-meter" aria-hidden="true"><i></i></div></div>
        <div class="mx-take-col" id="mxTakeCol"></div>
        <div class="mx-mon mx-pgm"><div class="mx-mon-label" id="mxPgmLabel"></div><div class="mx-screen" id="mxPgmScreen"></div><div class="mx-mon-meter" aria-hidden="true"><i></i></div></div>
      </section>
      <div class="mx-rest" id="mxRest"></div>
    </div>`;
  }
  root.querySelector('.mx').dataset.section = section;
  root.querySelector('.page-header h1').textContent = t('mixer.section.' + section);
  root.querySelector('#mxPvwLabel').innerHTML = `<span class="mx-lamp mx-lamp-pvw"></span>${esc(t('mixer.preview'))}<b>${esc(pvw ? sourceName(pvw) : t('mixer.nothing_selected'))}</b>`;
  root.querySelector('#mxPgmLabel').innerHTML = `<span class="mx-lamp mx-lamp-pgm"></span>${esc(t('mixer.program'))}<b>${esc(pgm ? `${pgm.name}${pgm.playlist_name ? ': ' + pgm.playlist_name : ''}` : t('mixer.nothing_selected'))}</b>`;
  root.querySelector('#mxTakeCol').innerHTML = `
          <button type="button" class="btn mx-take" id="mxTake" ${(pvw || scene) && outputs.size ? '' : 'disabled'}>${esc(t('mixer.take'))}</button>
          <div class="mx-tx" role="radiogroup" aria-label="${esc(t('mixer.transition'))}">
            ${(state.transitions || ['cut']).map((k) => `<button type="button" role="radio" class="mx-tx-key${tx.type === k ? ' is-on' : ''}" aria-checked="${tx.type === k}" data-tx="${esc(k)}">${esc(t(`mixer.tx.${k}`))}</button>`).join('')}
          </div>
          <label class="mx-tx-rate${tx.type === 'cut' ? ' is-off' : ''}">${esc(t('mixer.tx_rate'))}
            <select class="input" id="mxTxRate" ${tx.type === 'cut' ? 'disabled' : ''}>${RATES.map((r) => `<option value="${r}"${r === tx.ms ? ' selected' : ''}>${(r / 1000).toFixed(1)} s</option>`).join('')}</select></label>
          <div class="mx-take-hint">${esc(outputs.size ? t('mixer.to_n_screens', { n: outputs.size }) : t('mixer.pick_output'))}${scene ? `<br><b>${esc(t('mixer.scene_cued', { name: scene.name }))}</b>` : ''}</div>`;
  monitor(root.querySelector('#mxPvwScreen'), pvw ? playlistFeed(pvw, 'p') : null, t('mixer.pick_source'));
  monitor(root.querySelector('#mxPgmScreen'), !pgm ? null : isStream(pgm) ? (pgm.playlist_id ? playlistFeed(pgm.playlist_id, 's:' + pgm.id) : null)
    : { page: `/player?preview=1&device=${encodeURIComponent(pgm.id)}`, feed: `/api/devices/${encodeURIComponent(pgm.id)}/preview-payload`, key: `d:${pgm.id}:${pgm.playlist_id || ''}` },
  pgm && isStream(pgm) ? t('mixer.stream_no_source') : t('mixer.pick_output'), pgmFx);
  pgmFx = null;
  gfxLayer(root, pgm);
  guestLayer();
  // The guests panel is part of what is drawn just below: its keys are bound once that is in the page.
  queueMicrotask(() => { const gel = document.getElementById('mxGuests'); if (gel) { guestsBind(gel); liveAttach(gel); } });
  root.querySelector('#mxRest').innerHTML = `
      <section class="mx-bank mx-scenes">
        <h3>${esc(t('mixer.scenes'))}<span class="mx-bank-actions"><button type="button" class="btn btn-secondary btn-sm" id="mxSaveScene">${esc(t('mixer.scene_save'))}</button></span></h3>
        ${savingScene ? `<form class="mx-stream-form" id="mxSceneForm">
          <label>${esc(t('mixer.scene_name'))}<input class="input" name="name" maxlength="60" required placeholder="${esc(t('mixer.scene_name_ph'))}"></label>
          <label>${esc(t('mixer.scene_source'))}<input class="input" value="${esc(pvw ? sourceName(pvw) : t('mixer.scene_no_source'))}" disabled></label>
          <label>${esc(t('mixer.scene_graphic'))}<select class="input" name="gfx"><option value="">${esc(t('mixer.scene_no_graphic'))}</option>${state.graphics.map((g) => `<option value="${esc(g.kind)}">${esc(t(`mixer.gfx.${g.kind}`))}</option>`).join('')}</select></label>
          ${cam && cam.last ? `<label class="mx-check"><input type="checkbox" name="cam" checked> ${esc(t('mixer.scene_camera', { camera: (state.cameras.find((c) => c.id === cam.id) || {}).name || '', preset: cam.last.name }))}</label>` : ''}
          <div class="mx-stream-form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(t('mixer.scene_save_do'))}</button><button type="button" class="btn btn-secondary btn-sm" id="mxSceneCancel">${esc(t('common.cancel'))}</button></div>
        </form>` : ''}
        <div class="mx-keys">
          ${state.scenes.length ? state.scenes.map((s) => `
            <div class="mx-scene-wrap"><button type="button" class="mx-key mx-scene${s.id === cued ? ' is-pvw' : ''}" data-scene="${esc(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc([s.playlist_id ? sourceName(s.playlist_id) : '', s.graphic ? t(`mixer.gfx.${s.graphic.kind}`) : '', s.cameras.length ? t('mixer.scene_n_cameras', { n: s.cameras.length }) : ''].filter(Boolean).join(', '))}</span>
            </button><button type="button" class="mx-scene-del" data-scene-del="${esc(s.id)}" aria-label="${esc(t('mixer.scene_delete', { name: s.name }))}" title="${esc(t('mixer.scene_delete', { name: s.name }))}">×</button></div>`).join('') : (savingScene ? '' : `<p class="mx-note mx-note-top">${esc(t('mixer.scene_none'))}</p>`)}
        </div>
      </section>

      <section class="mx-bank mx-audio">
        <h3>${esc(t('mixer.audio'))}</h3>
        ${selScreens.length || streams().length ? `<div class="mx-console">
          ${streams().map((s) => { const mix = s.audio.mix, pk = s.status.audio_peaks || {}, live = s.status.inputs_live || []; return `
            <div class="mx-group">
              <div class="mx-group-name"><span class="mx-lamp mx-lamp-${streamTally(s)}"></span>${esc(s.name)}${s.status.state === 'off' && so.available ? `<button type="button" class="btn btn-secondary btn-sm mx-meters-on" data-standby="${esc(s.id)}" title="${esc(t('mixer.standby_tip'))}">${esc(t('mixer.meters_on'))}</button>` : `<span class="mx-group-state">${esc(t('mixer.stream_state.' + s.status.state))}</span>`}${s.status.limiting > 0.5 ? `<span class="mx-limiting">${esc(t('mixer.audio_limiting', { db: s.status.limiting }))}</span>` : ''}</div>
              <div class="mx-strips">${stripsOf(s).map((k) => { const off = (/^c\d+$/.test(k) && !live.includes('console')) || (k === 'programme' && !so.programme_audio) || (k === 'mic' && !(mic && mic.sid === s.id)) || (k === 'line' && !mix.line.device) || ((k === 'net' || k === 'net2') && !mix[k].url); const open = procOpen && procOpen.sid === s.id && procOpen.strip === k; return `
                <div class="mx-strip${mix[k].muted ? ' is-muted' : ''}${k === 'master' ? ' mx-strip-master' : ''}${off ? ' is-off' : ''}">
                  <span class="mx-strip-name">${esc(stripName(s, k))}</span>
                  <div class="mx-meter" aria-hidden="true"><i data-meter="${esc(s.id)}:${k}" style="height:${meterPct(pk[k] || 0)}%"></i></div>
                  <input type="range" class="mx-fader" min="0" max="${Math.round((so.max_level || 1.5) * 100)}" value="${Math.round(mix[k].level * 100)}" data-svol="${esc(s.id)}" data-strip="${k}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name + ', ' + stripName(s, k) }))}">
                  <span class="mx-strip-val">${mix[k].muted ? esc(t('mixer.audio_muted')) : Math.round(mix[k].level * 100) + '%'}</span>
                  <button type="button" class="mx-mute${mix[k].muted ? ' is-on' : ''}" data-smute="${esc(s.id)}" data-strip="${k}" aria-pressed="${mix[k].muted}">${esc(t('mixer.audio_mute'))}</button>
                  <button type="button" class="mx-mute mx-proc-open${open ? ' is-open' : ''}${shaped(mix[k]) ? ' is-shaped' : ''}" data-procopen="${esc(s.id)}" data-strip="${k}" aria-expanded="${open}">${esc(t('mixer.audio_eq'))}</button>
                </div>`; }).join('')}
              </div>
              ${procOpen && procOpen.sid === s.id ? procPanel(s, procOpen.strip) : ''}
              <div class="mx-group-src">
                <label>${esc(t('mixer.strip.mic'))}<button type="button" class="btn btn-secondary btn-sm mx-mic${mic && mic.sid === s.id ? ' is-on' : ''}" data-mic="${esc(s.id)}" aria-pressed="${!!(mic && mic.sid === s.id)}">${esc(t(mic && mic.sid === s.id ? 'mixer.mic_stop' : 'mixer.mic_start'))}</button>
                  ${micDevices.length > 1 ? `<select class="input mx-bed" data-micdev aria-label="${esc(t('mixer.mic_device'))}">${micDevices.map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === micDeviceId ? ' selected' : ''}>${esc(d.label || t('mixer.mic_default'))}</option>`).join('')}</select>` : ''}</label>
                <label>${esc(t('mixer.console'))}<select class="input mx-bed" data-console="${esc(s.id)}"><option value="">${esc(t('mixer.audio_none_opt'))}</option>${(so.line_inputs || []).map((x) => `<option value="${esc(x.device)}"${x.device === mix.console.device ? ' selected' : ''}>${esc(x.name)} (${x.channels} ch)</option>`).join('')}</select>
                  ${mix.console.device ? `<span class="mx-console-n">${esc(t('mixer.console_channels'))} <input class="input" type="number" min="0" max="${Math.min(mix.console.channels, so.max_channels || 32)}" value="${mix.console.count}" data-consolen="${esc(s.id)}"></span>` : ((so.line_inputs || []).length ? '' : `<span class="mx-note">${esc(t('mixer.console_none'))}</span>`)}</label>
                <label>${esc(t('mixer.audio_bed'))}<select class="input mx-bed" data-bed="${esc(s.id)}"><option value="">${esc(t('mixer.audio_none_opt'))}</option>${(so.audio_sources || []).map((x) => `<option value="${esc(x.id)}"${x.id === s.audio.content_id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
                <label>${esc(t('mixer.audio_line'))}<select class="input mx-bed" data-line="${esc(s.id)}"><option value="">${esc(t('mixer.audio_none_opt'))}</option>${(so.line_inputs || []).map((x) => `<option value="${esc(x.device)}"${x.device === mix.line.device ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
                ${['net', 'net2'].map((n) => `<label>${esc(t('mixer.strip.' + n))}${live.includes(n) ? ` <span class="mx-live">${esc(t('mixer.audio_connected'))}</span>` : ''}<input class="input mx-bed" data-net="${esc(s.id)}" data-strip="${n}" value="${esc(mix[n].url || '')}" placeholder="srt://  rtsp://  rtp://  udp://" spellcheck="false" autocomplete="off"></label>`).join('')}
              </div>
            </div>`; }).join('')}
          ${selScreens.length ? `<div class="mx-group">
            <div class="mx-group-name">${esc(t('mixer.audio_screens'))}</div>
            <div class="mx-strips">${selScreens.slice(0, 12).map((s) => { const v = volumes.get(s.id) || { level: 100, muted: false }; return `
              <div class="mx-strip${v.muted ? ' is-muted' : ''}"><span class="mx-strip-name" title="${esc(s.name)}">${esc(s.name)}</span>
                <input type="range" class="mx-fader" min="0" max="100" value="${v.level}" data-vol="${esc(s.id)}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name }))}">
                <span class="mx-strip-val">${v.muted ? esc(t('mixer.audio_muted')) : v.level + '%'}</span>
                <button type="button" class="mx-mute${v.muted ? ' is-on' : ''}" data-mute="${esc(s.id)}" aria-pressed="${v.muted}">${esc(t('mixer.audio_mute'))}</button></div>`; }).join('')}
            </div>
          </div>` : ''}
        </div>
        <p class="mx-note">${esc(t(so && so.available && !so.programme_audio && streams().length ? 'mixer.audio_note_no_programme' : 'mixer.audio_note'))}</p>` : `<p class="mx-note mx-note-top">${esc(t('mixer.audio_none'))}</p>`}
      </section>

      <section class="mx-bank mx-sources">
        <h3>${esc(t('mixer.sources'))}</h3>
        <div class="mx-keys">
          ${state.sources.length ? state.sources.map((s, i) => `
            <button type="button" class="mx-key mx-src${s.id === pvw ? ' is-pvw' : ''}${pgm && pgm.playlist_id === s.id ? ' is-pgm' : ''}" data-src="${esc(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-n">${i < 9 ? i + 1 : ''}</span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(t('mixer.n_items', { n: s.items }))}</span>
            </button>`).join('') : `<p class="mx-note">${esc(t('mixer.no_sources'))}</p>`}
        </div>
      </section>

      <section class="mx-bank mx-outputs">
        <h3>${esc(t('mixer.outputs'))}
          <span class="mx-bank-actions">
            ${(() => { const p = screenPlan(); return p.lead && p.ids.length ? `<button type="button" class="btn btn-sm mx-golive" id="mxOnScreens" title="${esc(t('mixer.on_screens_tip'))}">${esc(t('mixer.on_screens_go', { name: p.lead.name, n: p.ids.length }))}</button>` : p.off ? `<span class="mx-note mx-room-off">${esc(t('mixer.on_screens_need'))}</span>` : ''; })()}
            <button type="button" class="btn btn-secondary btn-sm" id="mxAll">${esc(t('mixer.all'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" id="mxNone">${esc(t('mixer.none'))}</button>
            ${state.groups.filter((g) => g.device_ids.length).map((g) => `<button type="button" class="btn btn-secondary btn-sm" data-group="${esc(g.id)}">${esc(g.name)}</button>`).join('')}
          </span>
        </h3>
        <div class="mx-keys">
          ${state.screens.length ? state.screens.map((s) => `
            <button type="button" class="mx-key mx-out mx-tally-${tallyOf(s)}${outputs.has(s.id) ? ' is-on' : ''}" data-out="${esc(s.id)}" aria-pressed="${outputs.has(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-tally"></span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(followOf(s.id) ? t('mixer.screen_shows_stream', { name: followOf(s.id).name }) : (s.playlist_name || t('mixer.no_playlist')))}</span>
            </button>`).join('') : (streams().length ? '' : `<p class="mx-note">${esc(t('mixer.no_screens'))}</p>`)}
          ${streams().map((s) => `
            <button type="button" class="mx-key mx-out mx-stream mx-tally-${streamTally(s)}${outputs.has(s.id) ? ' is-on' : ''}" data-out="${esc(s.id)}" aria-pressed="${outputs.has(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-tally"></span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(s.kind_label)}: ${esc(s.playlist_name || t('mixer.no_playlist'))}</span>
            </button>`).join('')}
        </div>
      </section>

      <section class="mx-bank mx-guests" id="mxGuests">${guestsHtml()}</section>

      ${so ? `<section class="mx-bank mx-streams">
        <h3>${esc(t('mixer.streams'))}${so.available ? `<span class="mx-bank-actions"><button type="button" class="btn btn-secondary btn-sm" id="mxAddStream">${esc(t('mixer.stream_add'))}</button></span>` : ''}</h3>
        ${!so.available ? `<p class="mx-note mx-note-top">${esc(t('mixer.stream_unavailable.' + so.reason))}</p>` : `
          ${streams().length ? `<div class="mx-stream-list">${streams().map((s) => `
            <div class="mx-stream-row" data-stream-row="${esc(s.id)}">
              <span class="mx-lamp mx-lamp-${streamTally(s)}"></span>
              <div class="mx-stream-what"><b>${esc(s.name)}</b><span>${esc(s.kind_label)}${s.url ? ' · ' + esc(s.url) : ''} · ${s.height}p${s.fps} · ${s.bitrate_k} kbps</span>
                ${s.status.error || s.status.last_error ? `<span class="mx-stream-err">${esc(s.status.error || s.status.last_error)}</span>` : ''}</div>
              ${s.status.recording ? `<span class="mx-rec" title="${esc(s.status.recording)}">${esc(t('mixer.rec_on'))}</span>` : (s.status.record_skipped ? `<span class="mx-stream-err">${esc(t('mixer.rec_skipped'))}</span>` : '')}
              ${s.file_only ? '' : `<label class="mx-rec-check"><input type="checkbox" data-record="${esc(s.id)}" ${s.record ? 'checked' : ''} ${s.status.state === 'off' ? '' : 'disabled'}> ${esc(t('mixer.rec_also'))}</label>`}
              ${(s.on_screens || []).length ? `<button type="button" class="btn btn-secondary btn-sm" data-unscreen="${esc(s.id)}" title="${esc((s.on_screens || []).map((x) => x.name).join(', '))}">${esc(t('mixer.release_screens', { n: s.on_screens.length }))}</button>` : ''}
              <span class="mx-stream-state">${esc(t('mixer.stream_state.' + s.status.state))}</span>
              ${s.status.state === 'off'
                ? `<button type="button" class="btn btn-secondary btn-sm" data-standby="${esc(s.id)}" title="${esc(t('mixer.standby_tip'))}">${esc(t('mixer.standby'))}</button><button type="button" class="btn btn-sm mx-golive" data-go="${esc(s.id)}">${esc(t(s.file_only ? 'mixer.rec_start' : 'mixer.stream_go'))}</button><button type="button" class="btn btn-secondary btn-sm" data-del="${esc(s.id)}">${esc(t('common.delete'))}</button>`
                : s.status.state === 'standby' ? `<button type="button" class="btn btn-sm mx-golive" data-go="${esc(s.id)}">${esc(t(s.file_only ? 'mixer.rec_start' : 'mixer.stream_go'))}</button><button type="button" class="btn btn-secondary btn-sm" data-stop="${esc(s.id)}">${esc(t('mixer.stream_stop'))}</button>`
                : `<button type="button" class="btn btn-secondary btn-sm" data-stop="${esc(s.id)}">${esc(t('mixer.stream_stop'))}</button>`}
            </div>`).join('')}</div>` : (addingStream ? '' : `<p class="mx-note mx-note-top">${esc(t('mixer.stream_none'))}</p>`)}
          ${addingStream ? `<form class="mx-stream-form" id="mxStreamForm">
            <label>${esc(t('mixer.stream_name'))}<input class="input" name="name" maxlength="80" required placeholder="${esc(t('mixer.stream_name_ph'))}"></label>
            <label>${esc(t('mixer.stream_to'))}<select class="input" name="kind">${so.kinds.map((k) => `<option value="${esc(k.kind)}" data-url="${k.needs_url ? 1 : 0}" data-file="${k.file ? 1 : 0}">${esc(k.label)}</option>`).join('')}</select></label>
            <label class="mx-stream-url" hidden>${esc(t('mixer.stream_url'))}<input class="input" name="url" maxlength="500" placeholder="rtmp://"></label>
            <label class="mx-stream-key">${esc(t('mixer.stream_key'))}<input class="input" name="key" type="password" autocomplete="off" maxlength="600"></label>
            <label>${esc(t('mixer.stream_size'))}<select class="input" name="size">${so.sizes.map((z) => `<option value="${z.width}x${z.height}">${z.height}p</option>`).join('')}</select></label>
            <label class="mx-rec-check mx-stream-rec"><input type="checkbox" name="record"> ${esc(t('mixer.rec_also'))}</label>
            <div class="mx-stream-form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(t('mixer.stream_save'))}</button><button type="button" class="btn btn-secondary btn-sm" id="mxStreamCancel">${esc(t('common.cancel'))}</button></div>
          </form>` : ''}
          ${(so.recordings || []).length ? `<h4 class="mx-sub">${esc(t('mixer.recordings'))}</h4><div class="mx-stream-list">${so.recordings.map((r) => `
            <div class="mx-stream-row">
              <span class="mx-lamp mx-lamp-${r.recording ? 'air' : 'idle'}"></span>
              <div class="mx-stream-what"><b>${esc(r.name)}</b><span>${esc(new Date(r.at).toLocaleString())} · ${esc(sizeOf(r.bytes))}</span></div>
              ${r.recording ? `<span class="mx-rec">${esc(t('mixer.rec_on'))}</span>` : `<button type="button" class="btn btn-secondary btn-sm" data-recget="${esc(r.name)}">${esc(t('mixer.rec_download'))}</button><button type="button" class="btn btn-secondary btn-sm" data-recdel="${esc(r.name)}">${esc(t('common.delete'))}</button>`}
            </div>`).join('')}</div>` : ''}
          <p class="mx-note">${esc(t('mixer.stream_note', { max: so.max }))}</p>
          ${so.ffmpeg && so.ffmpeg.licence && so.ffmpeg.licence !== 'lgpl' ? `<p class="mx-note mx-licence" role="note"><b>${esc(t('mixer.licence.title'))}</b> ${esc(t('mixer.licence.' + so.ffmpeg.licence, { version: so.ffmpeg.version || '' }))}</p>`
            : `<p class="mx-note">${esc(t('mixer.licence.lgpl'))}</p>`}`}
      </section>` : ''}

      <section class="mx-bank mx-gfx">
        <h3>${esc(t('mixer.graphics'))}</h3>
        <div class="mx-gfx-row">
          <label>${esc(t('mixer.gfx_line1'))}<input class="input" id="mxA" maxlength="120" value="${esc(sessionStorage.getItem('mx_a') || '')}" placeholder="${esc(t('mixer.gfx_line1_ph'))}"></label>
          <label>${esc(t('mixer.gfx_line2'))}<input class="input" id="mxB" maxlength="200" value="${esc(sessionStorage.getItem('mx_b') || '')}" placeholder="${esc(t('mixer.gfx_line2_ph'))}"></label>
          <label class="mx-gfx-colour">${esc(t('mixer.gfx_colour'))}<input type="color" id="mxC" value="${esc(sessionStorage.getItem('mx_c') || '#ff2a1f')}"></label>
        </div>
        <div class="mx-keys">
          ${state.graphics.map((g) => `<button type="button" class="mx-key mx-gfx-key" data-gfx="${esc(g.kind)}"><span class="mx-key-name">${esc(t(`mixer.gfx.${g.kind}`))}</span><span class="mx-key-sub">${esc(t(`mixer.gfx.${g.kind}.sub`))}</span></button>`).join('')}
          <button type="button" class="mx-key mx-gfx-clear" id="mxClear"><span class="mx-key-name">${esc(t('mixer.gfx_clear'))}</span><span class="mx-key-sub">Esc</span></button>
        </div>
        <p class="mx-note">${esc(t('mixer.gfx_note'))}</p>
      </section>

      <div class="mx-pair">
      <section class="mx-bank mx-cams">
        <h3>${esc(t('mixer.cameras'))}</h3>
        ${state.cameras.length ? `
          <div class="mx-keys">${state.cameras.map((c) => `<button type="button" class="mx-key${cam && cam.id === c.id ? ' is-on mx-out' : ''}" data-cam="${esc(c.id)}"><span class="mx-key-name">${esc(c.name)}</span></button>`).join('')}</div>
          ${cam ? `<div class="mx-cam-desk">
            <div class="mx-pad" role="group" aria-label="${esc(t('mixer.cam_move'))}">${DIRS.map((d) => (d
              ? `<button type="button" class="mx-pad-key" data-pan="${d[0]}" data-tilt="${d[1]}" aria-label="${esc(t('mixer.cam_move'))} ${d[2]}">${d[2]}</button>`
              : `<button type="button" class="mx-pad-key mx-pad-home" id="mxCamHome">${esc(t('mixer.cam_home'))}</button>`)).join('')}</div>
            <div class="mx-cam-side">
              <div class="mx-zoom"><button type="button" class="mx-pad-key" data-zoom="1">${esc(t('mixer.cam_zoom_in'))}</button><button type="button" class="mx-pad-key" data-zoom="-1">${esc(t('mixer.cam_zoom_out'))}</button></div>
              <label class="mx-speed">${esc(t('mixer.cam_speed'))}<input type="range" id="mxCamSpeed" min="10" max="100" step="5" value="${Math.round(camSpeed * 100)}"></label>
            </div>
            <div class="mx-presets"><span class="mx-presets-label">${esc(t('mixer.cam_presets'))}</span>
              ${cam.presets === null ? `<span class="mx-note">${esc(t('common.loading'))}</span>` : cam.presets.length ? cam.presets.map((p) => `<button type="button" class="mx-key mx-preset${cam.last && cam.last.preset === p.token ? ' is-pvw' : ''}" data-preset="${esc(p.token)}" data-preset-name="${esc(p.name || p.token)}"><span class="mx-key-name">${esc(p.name || p.token)}</span></button>`).join('') : `<span class="mx-note">${esc(t('mixer.cam_no_presets'))}</span>`}
            </div>
          </div>` : `<p class="mx-note">${esc(t('mixer.cam_pick'))}</p>`}` : `<p class="mx-note mx-note-top">${esc(t('mixer.cam_none'))}</p>`}
      </section>

      </div>
`;
  bind(root);
}

async function take(root) {
  const scene = cuedScene();
  if ((!pvw && !scene) || !outputs.size) return;
  if (!pvw) { await applyScene(root, scene); cued = null; if (alive) draw(root); return; }
  // What is on Program now (a screen showing a stream is live with the stream's source, not its own playlist).
  const before = onProgram();
  const cutBackTo = before && before.playlist_id && before.playlist_id !== pvw ? before.playlist_id : null;
  const btn = root.querySelector('#mxTake');
  if (btn) btn.disabled = true;
  try {
    const streamIds = streams().filter((s) => outputs.has(s.id)).map((s) => s.id);
    let screenIds = [...outputs].filter((id) => !streamIds.includes(id));
    // Screens selected together with a running stream show that stream's picture (programme, graphics,
    // guests, as composed), over whatever they play, instead of taking the source themselves.
    const lead = streams().find((s) => outputs.has(s.id) && s.status.state !== 'off');
    let followed = null;
    // A screen that cannot show a stream's picture (an older player, offline) takes the source itself, as before.
    if (lead && screenIds.length) { followed = await streamToScreens(lead, screenIds); if (followed) screenIds = followed.skipped.map((x) => x.device_id); }
    const r = await call('/mixer/take', { method: 'POST', body: JSON.stringify({ device_ids: screenIds, stream_ids: streamIds, playlist_id: pvw,
      transition: { type: tx.type, ms: tx.ms, color: (root.querySelector('#mxC') || {}).value || undefined } }) });
    for (const tk of r.streams || []) { const s = streams().find((x) => x.id === tk.stream_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    const n = (r.taken || []).length + (r.streams || []).length, skipped = (r.skipped || []).length;
    showToast(skipped ? t('mixer.toast.taken_skipped', { n, name: r.playlist.name, skipped }) : t('mixer.toast.taken', { n, name: r.playlist.name }), n ? 'success' : 'warning');
    for (const tk of r.taken || []) { const s = state.screens.find((x) => x.id === tk.device_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    // Flip-flop: what was on Program is now in Preview, one key press from going back.
    if (tx.type !== 'cut') pgmFx = { type: tx.type, ms: tx.ms, color: (root.querySelector('#mxC') || {}).value };
    if (cutBackTo && state.sources.some((s) => s.id === cutBackTo)) pvw = cutBackTo;
    if (scene) { await applyScene(root, scene); cued = null; }
  } catch (err) { showToast(err.message, 'error'); }
  if (alive) draw(root);
}

/**
 * Puts a running stream's picture (programme, graphics, guests) on screens. Says, screen by screen,
 * which could not take it and why. Resolves with the server's { shown, skipped, waiting } (waiting: screens that follow it and get it once they can), or null when it refused.
 */
async function streamToScreens(lead, ids) {
  try {
    const r = await call(`/stream-out/${encodeURIComponent(lead.id)}/screens`, { method: 'POST', body: JSON.stringify({ device_ids: ids }) });
    lead.on_screens = [...(lead.on_screens || []).filter((x) => !r.shown.some((y) => y.device_id === x.id)), ...r.shown.map((x) => ({ id: x.device_id, name: x.name, live: false }))];
    const why = (list) => list.map((x) => `${x.name || '?'} (${t('mixer.screen_skip.' + x.reason)})`).join(', ');
    r.waiting = r.waiting || [];
    if (r.skipped.length) showToast(t('mixer.toast.on_screens_skipped', { n: r.shown.length, why: why([...r.skipped, ...r.waiting]) }), 'warning');
    else if (r.waiting.length) showToast(t('mixer.toast.on_screens_waiting', { n: r.shown.length, why: why(r.waiting) }), 'info');
    else showToast(t('mixer.toast.on_screens', { n: r.shown.length, name: lead.name }), 'success');
    return r;
  } catch (err) { showToast(err.message, 'error'); return null; }
}
/** The stream that the selected screens would show, and those screens: a running stream selected together with screens. */
function screenPlan() {
  const lead = streams().find((s) => outputs.has(s.id) && s.status.state !== 'off');
  const ids = state ? state.screens.filter((s) => outputs.has(s.id) && !(lead && (lead.on_screens || []).some((x) => x.id === s.id))).map((s) => s.id) : [];
  const off = !lead && streams().some((s) => outputs.has(s.id)) && ids.length > 0;
  return { lead, ids, off };
}

/** The rest of a scene, once its source is on air: its graphic (or none) and its camera positions. */
async function applyScene(root, scene) {
  if (scene.graphic) await key(root, scene.graphic.kind, scene.graphic); else await clearGfx(true);
  await Promise.all(scene.cameras.map((c) => call(`/onvif/cameras/${encodeURIComponent(c.camera_id)}/ptz`, { method: 'POST', body: JSON.stringify({ action: 'preset', preset: c.preset }) })
    .catch((err) => showToast(t('mixer.toast.cam_failed', { error: err.message }), 'warning'))));
}

async function key(root, kind, given) {
  if (!outputs.size) { showToast(t('mixer.pick_output'), 'info'); return; }
  const a = given ? given.a : root.querySelector('#mxA').value.trim();
  const b = given ? given.b : root.querySelector('#mxB').value.trim();
  const accent = given ? given.accent : root.querySelector('#mxC').value;
  if (!a) { showToast(t('mixer.gfx_need_text'), 'info'); root.querySelector('#mxA').focus(); return; }
  if (kind === 'countdown' && !/^(\d{1,4}|\d{1,5}s|\d{1,3}:[0-5]\d|\d:[0-5]\d:[0-5]\d)$/i.test(a)) { showToast(t('mixer.gfx_need_time'), 'info'); root.querySelector('#mxA').focus(); return; }
  const g = state.graphics.find((x) => x.kind === kind);
  const W = 1920, H = 1080;
  const uri = `${window.location.origin}/gfx/${encodeURIComponent(kind)}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&accent=${encodeURIComponent(accent)}`;
  let ok = 0, failed = 0;
  await Promise.all([...outputs].map(async (id) => {
    try {
      if (streams().some((s) => s.id === id)) await call(`/stream-out/${encodeURIComponent(id)}/gfx`, { method: 'POST', body: JSON.stringify({ kind, a, b, accent }) });
      else await call('/pip', { method: 'POST', body: JSON.stringify({ device_id: id, type: 'web', uri, position: g.box.position, keyed: true,
        width: Math.round(W * g.box.w), height: Math.round(H * g.box.h), duration: 0, opacity: 1, border_radius: 0 }) });
      onAirGfx.set(id, { uri: uri.replace(window.location.origin, ''), position: g.box.position, w: g.box.w, h: g.box.h, n: Date.now() });
      ok++;
    } catch { failed++; }
  }));
  showToast(failed ? t('mixer.toast.gfx_partial', { ok, failed }) : t('mixer.toast.gfx_on', { n: ok }), failed ? 'warning' : 'success');
  gfxLayer(root, onProgram());
}

async function clearGfx(quiet) {
  if (!outputs.size) return;
  await Promise.all([...outputs].map((id) => (streams().some((s) => s.id === id)
    ? call(`/stream-out/${encodeURIComponent(id)}/gfx/clear`, { method: 'POST' })
    : call('/pip/clear', { method: 'POST', body: JSON.stringify({ device_id: id }) })).catch(() => null)));
  for (const id of outputs) onAirGfx.set(id, null);
  gfxLayer(null, onProgram());
  if (quiet !== true) showToast(t('mixer.toast.gfx_off'), 'info');
}

// ── cameras ──────────────────────────────────────────────────────────────────────────────────────
const ptz = (body) => call(`/onvif/cameras/${encodeURIComponent(cam.id)}/ptz`, { method: 'POST', body: JSON.stringify(body) });
/** Move while a key is held. The camera stops itself a second after the last order, so a lost
 *  "stop" cannot leave it turning; while held, the order is repeated before that second is up. */
function holdMove(vec) {
  releaseMove(false);
  const send = () => ptz({ action: 'move', pan: vec.pan * camSpeed, tilt: vec.tilt * camSpeed, zoom: vec.zoom * camSpeed, timeout: 1 }).catch((err) => { releaseMove(false); showToast(err.message, 'error'); });
  send(); holdTimer = setInterval(send, 700);
}
function releaseMove(stop = true) {
  if (!holdTimer) return;
  clearInterval(holdTimer); holdTimer = null;
  if (stop && cam) ptz({ action: 'stop' }).catch(() => {});
}

function bind(root) {
  root.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { pvw = b.dataset.src; cued = null; draw(root); }));
  // Scenes: recall one into Preview (TAKE puts it on air), save the desk as one, remove one.
  root.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => {
    const s = state.scenes.find((x) => x.id === b.dataset.scene); if (!s) return;
    cued = s.id;
    if (s.playlist_id && state.sources.some((x) => x.id === s.playlist_id)) pvw = s.playlist_id;
    if (s.graphic) { try { sessionStorage.setItem('mx_a', s.graphic.a); sessionStorage.setItem('mx_b', s.graphic.b || ''); sessionStorage.setItem('mx_c', s.graphic.accent); } catch { /* */ } }
    draw(root);
  }));
  root.querySelectorAll('[data-scene-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await call(`/mixer/scenes/${encodeURIComponent(b.dataset.sceneDel)}`, { method: 'DELETE' }); state.scenes = state.scenes.filter((s) => s.id !== b.dataset.sceneDel); if (cued === b.dataset.sceneDel) cued = null; }
    catch (err) { showToast(err.message, 'error'); }
    draw(root);
  }));
  const saveScene = root.querySelector('#mxSaveScene'); if (saveScene) saveScene.addEventListener('click', () => { savingScene = true; draw(root); const f = root.querySelector('#mxSceneForm [name=name]'); if (f) f.focus(); });
  const sceneForm = root.querySelector('#mxSceneForm');
  if (sceneForm) {
    root.querySelector('#mxSceneCancel').addEventListener('click', () => { savingScene = false; draw(root); });
    sceneForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(sceneForm), kind = f.get('gfx');
      const a = root.querySelector('#mxA').value.trim();
      if (kind && !a) { showToast(t('mixer.gfx_need_text'), 'info'); return; }
      try {
        const made = await call('/mixer/scenes', { method: 'POST', body: JSON.stringify({
          name: f.get('name'), playlist_id: pvw,
          graphic: kind ? { kind, a, b: root.querySelector('#mxB').value.trim(), accent: root.querySelector('#mxC').value } : null,
          cameras: f.get('cam') && cam && cam.last ? [{ camera_id: cam.id, preset: cam.last.preset, preset_name: cam.last.name }] : [],
        }) });
        state.scenes.push(made); savingScene = false; showToast(t('mixer.toast.scene_saved', { name: made.name }), 'success'); draw(root);
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
  // Cameras: choose one, steer it while a key is held, recall its presets.
  root.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', async () => {
    releaseMove();
    cam = { id: b.dataset.cam, presets: null, last: null }; draw(root);
    const mine = cam;
    try { mine.presets = (await call(`/onvif/cameras/${encodeURIComponent(mine.id)}/presets`)).presets || []; }
    catch (err) { mine.presets = []; showToast(err.message, 'error'); }
    if (alive && cam === mine) draw(root);
  }));
  root.querySelectorAll('.mx-pad-key[data-pan], .mx-pad-key[data-zoom]').forEach((b) => {
    const vec = { pan: Number(b.dataset.pan || 0), tilt: Number(b.dataset.tilt || 0), zoom: Number(b.dataset.zoom || 0) };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } holdMove(vec); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => releaseMove());
    b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); holdMove(vec); } });
    b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.stopPropagation(); releaseMove(); } });
    b.addEventListener('blur', () => releaseMove());
  });
  const home = root.querySelector('#mxCamHome'); if (home) home.addEventListener('click', () => ptz({ action: 'home' }).catch((err) => showToast(err.message, 'error')));
  const speed = root.querySelector('#mxCamSpeed'); if (speed) speed.addEventListener('input', () => { camSpeed = Number(speed.value) / 100; });
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', async () => {
    try { await ptz({ action: 'preset', preset: b.dataset.preset }); cam.last = { preset: b.dataset.preset, name: b.dataset.presetName }; draw(root); }
    catch (err) { showToast(err.message, 'error'); }
  }));
  // Audio: a screen's volume is sent when the fader is let go; a stream's fader is live.
  const setVol = async (id, v) => {
    volumes.set(id, v);
    try { await call(`/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: JSON.stringify({ type: 'set_volume', payload: { level: v.muted ? 0 : v.level / 100 } }) }); }
    catch (err) { showToast(err.message, 'error'); }
  };
  root.querySelectorAll('[data-vol]').forEach((el) => el.addEventListener('change', async () => { await setVol(el.dataset.vol, { level: Number(el.value), muted: false }); draw(root); }));
  root.querySelectorAll('[data-mute]').forEach((b) => b.addEventListener('click', async () => { const v = volumes.get(b.dataset.mute) || { level: 100, muted: false }; await setVol(b.dataset.mute, { level: v.level, muted: !v.muted }); draw(root); }));
  const streamAudio = async (id, body) => {
    try { const now = await call(`/stream-out/${encodeURIComponent(id)}/audio`, { method: 'POST', body: JSON.stringify(body) }); const i = streams().findIndex((s) => s.id === id); if (i >= 0) so.outputs[i] = now; }
    catch (err) { showToast(err.message, 'error'); }
  };
  root.querySelectorAll('[data-svol]').forEach((el) => {
    let busy = false;
    const send = () => streamAudio(el.dataset.svol, { strip: el.dataset.strip, level: Number(el.value) / 100 });
    el.addEventListener('input', async () => { if (busy) return; busy = true; await send(); busy = false; });
    el.addEventListener('change', async () => { await send(); draw(root); });
  });
  root.querySelectorAll('[data-smute]').forEach((b) => b.addEventListener('click', async () => { const s = streams().find((x) => x.id === b.dataset.smute), k = b.dataset.strip; await streamAudio(s.id, { strip: k, muted: !s.audio.mix[k].muted }); draw(root); }));
  root.querySelectorAll('[data-line]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.line, { line_device: el.value || null }); draw(root); }));
  // A strip's processing: open its panel, turn its controls, set it flat.
  root.querySelectorAll('[data-procopen]').forEach((b) => b.addEventListener('click', () => {
    const same = procOpen && procOpen.sid === b.dataset.procopen && procOpen.strip === b.dataset.strip;
    procOpen = same ? null : { sid: b.dataset.procopen, strip: b.dataset.strip }; draw(root);
  }));
  root.querySelectorAll('[data-proc]').forEach((el) => el.addEventListener('change', async () => {
    const ctl = el.dataset.ctl; let v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (ctl === 'lpf' && v > 20000) v = 0;                 // the top of its travel is "off"
    const [group, key] = ctl.includes('.') ? ctl.split('.') : [null, ctl];
    const body = group === 'fx' ? { fx: { [key]: v } } : { strips: [{ strip: el.dataset.strip, ...(group ? { [group]: { [key]: v } } : { [key]: v }) }] };
    await streamAudio(el.dataset.proc, body); draw(root);
  }));
  root.querySelectorAll('[data-proc][type=range]').forEach((el) => el.addEventListener('input', () => { const o = el.parentNode.querySelector('output'); if (o) o.textContent = fmt(el.dataset.ctl, el.value); }));
  root.querySelectorAll('[data-procreset]').forEach((b) => b.addEventListener('click', async () => {
    const strip = b.dataset.strip;
    await streamAudio(b.dataset.procreset, strip === 'master' ? { strips: [{ strip, eq: FLAT.eq, comp: 0, cmp: FLAT.cmp }] } : { strips: [{ strip, ...FLAT }] }); draw(root);
  }));
  root.querySelectorAll('[data-mic]').forEach((b) => b.addEventListener('click', async () => {
    const sid = b.dataset.mic;
    if (mic && mic.sid === sid) { micStop(); draw(root); return; }
    b.disabled = true;
    try {
      // A microphone needs the stream's mix to be running: standby does that without sending anything.
      const s = streams().find((x) => x.id === sid);
      if (s && s.status.state === 'off') { const r = await call(`/stream-out/${encodeURIComponent(sid)}/start`, { method: 'POST', body: JSON.stringify({ standby: true }) }); s.status = { ...s.status, ...r.status }; }
      await micStart(sid);
      showToast(t('mixer.toast.mic_on'), 'success');
    } catch (err) { showToast(err && err.name === 'NotAllowedError' ? t('mixer.mic_denied') : (err.message || String(err)), 'error'); }
    try { so = await call('/stream-out'); } catch { /* keep */ }
    draw(root);
  }));
  root.querySelectorAll('[data-micdev]').forEach((el) => el.addEventListener('change', async () => {
    micDeviceId = el.value; try { localStorage.setItem('st_mixer_mic', micDeviceId); } catch { /* not kept */ }
    if (mic) { const sid = mic.sid; try { await micStart(sid); } catch (err) { showToast(err.message || String(err), 'error'); } }   // reopen on the new device
    draw(root);
  }));
  root.querySelectorAll('[data-console]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.console, { console_device: el.value || null }); draw(root); }));
  root.querySelectorAll('[data-consolen]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.consolen, { console_count: Math.max(0, parseInt(el.value, 10) || 0) }); draw(root); }));
  root.querySelectorAll('[data-chname]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.chname, { strips: [{ strip: el.dataset.strip, label: el.value.trim() }] }); draw(root); }));
  root.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = t('mixer.audio_noise_learning');
    await streamAudio(b.dataset.learn, { learn_noise: b.dataset.strip }); draw(root);
  }));
  root.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', async () => { await streamAudio(b.dataset.forget, { forget_noise: b.dataset.strip }); draw(root); }));
  root.querySelectorAll('[data-net]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.net, { [el.dataset.strip + '_url']: el.value.trim() || null }); draw(root); }));
  root.querySelectorAll('[data-bed]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.bed, { content_id: el.value || null }); draw(root); }));
  root.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.out; if (outputs.has(id)) outputs.delete(id); else outputs.add(id); draw(root);
  }));
  root.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    const g = state.groups.find((x) => x.id === b.dataset.group); if (!g) return;
    outputs = new Set(g.device_ids.filter((id) => state.screens.some((s) => s.id === id))); draw(root);
  }));
  const all = root.querySelector('#mxAll'); if (all) all.addEventListener('click', () => { outputs = new Set(state.screens.map((s) => s.id)); draw(root); });
  // Streams: add a destination, go live, stop, remove.
  const redo = async () => { try { so = await call('/stream-out'); } catch { /* keep */ } if (alive) draw(root); };
  const act = (sel, attr, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(b.dataset[attr]); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  act('[data-standby]', 'standby', async (id) => { await call(`/stream-out/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify({ standby: true }) }); showToast(t('mixer.toast.standby'), 'success'); });
  act('[data-go]', 'go', async (id) => { await call(`/stream-out/${encodeURIComponent(id)}/start`, { method: 'POST' }); showToast(t('mixer.toast.stream_starting'), 'success'); });
  act('[data-unscreen]', 'unscreen', async (id) => { const r = await call(`/stream-out/${encodeURIComponent(id)}/screens`, { method: 'DELETE' }); showToast(t('mixer.toast.screens_released', { n: r.released }), 'success'); });
  act('[data-stop]', 'stop', (id) => call(`/stream-out/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
  act('[data-del]', 'del', async (id) => { await call(`/stream-out/${encodeURIComponent(id)}`, { method: 'DELETE' }); outputs.delete(id); });
  root.querySelectorAll('[data-record]').forEach((el) => el.addEventListener('change', async () => {
    try { await call(`/stream-out/${encodeURIComponent(el.dataset.record)}`, { method: 'PUT', body: JSON.stringify({ record: el.checked }) }); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  root.querySelectorAll('[data-recget]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const { url } = await call(`/stream-out/recordings/${encodeURIComponent(b.dataset.recget)}/link`, { method: 'POST' });
      const a = document.createElement('a'); a.href = url; a.download = b.dataset.recget; document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { showToast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-recdel]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = t('mixer.rec_delete_sure'); return; }   // second press deletes
    try { await call(`/stream-out/recordings/${encodeURIComponent(b.dataset.recdel)}`, { method: 'DELETE' }); showToast(t('mixer.toast.rec_deleted'), 'info'); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  const add = root.querySelector('#mxAddStream'); if (add) add.addEventListener('click', () => { addingStream = true; draw(root); const f = root.querySelector('#mxStreamForm [name=name]'); if (f) f.focus(); });
  const form = root.querySelector('#mxStreamForm');
  if (form) {
    const kindSel = form.querySelector('[name=kind]'), urlRow = form.querySelector('.mx-stream-url');
    const sync = () => {
      const o = kindSel.selectedOptions[0].dataset;
      urlRow.hidden = o.url !== '1';
      form.querySelector('.mx-stream-key').hidden = o.file === '1'; form.querySelector('.mx-stream-rec').hidden = o.file === '1';
    };
    kindSel.addEventListener('change', sync); sync();
    root.querySelector('#mxStreamCancel').addEventListener('click', () => { addingStream = false; draw(root); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form); const [width, height] = String(f.get('size')).split('x').map(Number);
      try {
        const made = await call('/stream-out', { method: 'POST', body: JSON.stringify({ name: f.get('name'), kind: f.get('kind'), url: f.get('url'), key: f.get('key'), width, height, record: f.get('record') === 'on' }) });
        addingStream = false; outputs.add(made.id);
        showToast(t('mixer.toast.stream_added'), 'success'); redo();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
  const ons = root.querySelector('#mxOnScreens'); if (ons) ons.addEventListener('click', async () => { ons.disabled = true; const p = screenPlan(); if (p.lead && p.ids.length) await streamToScreens(p.lead, p.ids); if (alive) draw(root); });
  const none = root.querySelector('#mxNone'); if (none) none.addEventListener('click', () => { outputs = new Set(); draw(root); });
  const tk = root.querySelector('#mxTake'); if (tk) tk.addEventListener('click', () => take(root));
  const keepTx = () => { try { localStorage.setItem('st_mixer_tx', JSON.stringify(tx)); } catch { /* this page only */ } };
  root.querySelectorAll('[data-tx]').forEach((b) => b.addEventListener('click', () => { tx = { ...tx, type: b.dataset.tx }; keepTx(); draw(root); }));
  const rate = root.querySelector('#mxTxRate'); if (rate) rate.addEventListener('change', () => { tx = { ...tx, ms: Number(rate.value) }; keepTx(); });
  root.querySelectorAll('[data-gfx]').forEach((b) => b.addEventListener('click', () => key(root, b.dataset.gfx)));
  const cl = root.querySelector('#mxClear'); if (cl) cl.addEventListener('click', clearGfx);
  for (const [id, k] of [['mxA', 'mx_a'], ['mxB', 'mx_b'], ['mxC', 'mx_c']]) {
    const el = root.querySelector('#' + id); if (el) el.addEventListener('input', () => { try { sessionStorage.setItem(k, el.value); } catch { /* */ } });
  }
}

export async function render(container, which) {
  alive = true;
  section = SECTIONS.includes(which) ? which : 'desk';
  container.innerHTML = `<div class="empty-state"><h3>${esc(t('common.loading'))}</h3></div>`;
  try { state = await load(); } catch (err) {
    container.innerHTML = `<div class="empty-state"><h3>${esc(t('mixer.title'))}</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!alive) return;
  outputs = new Set([...outputs].filter((id) => state.screens.some((s) => s.id === id) || streams().some((s) => s.id === id)));
  if (pvw && !state.sources.some((s) => s.id === pvw)) pvw = null;
  draw(container);

  onKey = (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) { const s = state.sources[Number(e.key) - 1]; if (s) { pvw = s.id; draw(container); e.preventDefault(); } }
    else if (e.key === 'Enter' || e.key === ' ') { if (tag !== 'BUTTON') { e.preventDefault(); take(container); } }
    else if (e.key === 'Escape') clearGfx();
  };
  document.addEventListener('keydown', onKey);
  // Tally follows the room: refresh which screens are up without redrawing the monitors.
  refreshTimer = setInterval(async () => {
    if (!alive || document.hidden) return;
    try {
      const sig = () => JSON.stringify([state.screens.map((s) => [s.id, s.status, s.playlist_id]), state.sources.length, streams().map((s) => [s.id, s.status.state, s.status.error, s.playlist_id])]);
      const before = sig();
      if (container.querySelector('#mxStreamForm, #mxSceneForm') || holdTimer || (document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-net], [data-proc], [data-chname], [data-consolen], .mx-fader'))) return;      // someone is typing or steering: leave the desk alone
      state = await load();
      if (sig() !== before && alive) draw(container);
    } catch { /* keep the desk as it is */ }
  }, 10000);
  // Level meters of running streams (live or on standby), moved in place five times a second (no redraw).
  guestsRefresh(true); let hiddenTicks = 0;
  // Also while the tab is in the background (the operator watching the output in another tab): a desk that
  // stops asking is forgotten by the server, and its guests' live pictures and Talk lines with it.
  guestTimer = setInterval(() => { if (!alive) return; if (document.hidden && ++hiddenTicks % 3) return; guestsRefresh(false); }, 1000);
  monTimer = setInterval(() => { if (alive && !document.hidden) monitorLevels(); }, 100);
  document.addEventListener('pointerdown', wakeAudio);
  meterTimer = setInterval(async () => {
    if (!alive || document.hidden || meterBusy || !streams().some((s) => s.status.state !== 'off')) return;
    meterBusy = true;
    try {
      const { levels } = await call('/stream-out/levels');
      for (const s of streams()) {
        const l = levels[s.id], pk = l ? l.peaks : {};
        for (const k of stripsOf(s)) { const bar = container.querySelector(`[data-meter="${CSS.escape(s.id + ':' + k)}"]`); if (bar) bar.style.height = meterPct(pk[k] || 0) + '%'; }
        s.status = { ...s.status, audio_peaks: pk };
      }
    } catch { /* next time */ }
    meterBusy = false;
  }, 200);
}

export function cleanup() {
  alive = false;
  // Moving between the desk's own pages (Mixer, Audio, Graphics) must not close an open microphone;
  // leaving the desk does.
  setTimeout(() => { if (!alive) micStop(); }, 800);
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  clearInterval(refreshTimer); refreshTimer = null;
  clearInterval(meterTimer); meterTimer = null;
  clearInterval(guestTimer); guestTimer = null;
  // Moving between the desk's own pages keeps the guests' pictures; leaving the desk lets them go.
  setTimeout(() => { if (!alive) { talking.clear(); merged.clear(); for (const gid of [...guestLive.keys()]) liveDrop(gid); listening.clear(); route(); } }, 800);
  clearInterval(monTimer); monTimer = null; document.removeEventListener('pointerdown', wakeAudio);
  releaseMove();
}
