/*
 * The guest's page of a broadcast (server/lib/mixer-guests.js): /guest/<token>.
 *
 * Camera and microphone are opened here and shown back to the guest. Join sends the studio an
 * offer of a direct connection carrying both; the studio's renderer answers it. From then on
 * the page asks, once a second, how things stand: still connected, backstage or on air.
 *
 * Whenever the studio has no connection for this guest (it was started after they joined, it was
 * restarted, the network dropped), the page simply offers again. When the server no longer knows
 * the guest at all (it restarted, or the phone slept for minutes), the page joins again with the
 * same name. The guest does nothing. Only being removed by the studio, or the invite being closed,
 * ends the visit.
 */
const token = location.pathname.split('/').filter(Boolean).pop();
const api = `/api/stream-guest/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);
const say = (text, error) => { $('gsMsg').textContent = text || ''; $('gsMsg').classList.toggle('error', !!error); };

let media = null;            // the camera and microphone
let me = null;               // { guest_id, key } once joined
let pc = null, offering = false, ice = [], fails = 0, lostAt = 0;
let actx = null, analyser = null, lock = null;
const pick = { cam: '', mic: '' };
// "Remove my background" (guest-cutout.js): the running cut-out, and whether the guest wants it.
let cut = null, cutWanted = false, cutBusy = false;
const want = { mic: true, cam: true };       // what the guest has switched on, kept across a change of device
let myName = '';
try { $('gsName').value = localStorage.getItem('st_guest_name') || ''; } catch { /* not kept */ }

async function post(path, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store', signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'The studio did not answer.'), { status: r.status });
    return j;
  } finally { clearTimeout(timer); }
}

/** Why the camera or microphone did not open, in words a guest can act on. */
function mediaError(e) {
  if (!window.isSecureContext) return 'This page was opened without https, so the browser will not allow a camera or microphone. Ask the studio for an https link.';
  if (e && e.name === 'NotAllowedError') return 'The browser did not allow the camera and microphone. Allow them for this page (the padlock or camera icon in the address bar), then try again.';
  if (e && (e.name === 'NotReadableError' || e.name === 'AbortError')) return 'Another app is using the camera or microphone. Close it (a video call, the camera app), then try again.';
  if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return 'No camera or microphone was found on this device.';
  return 'The camera or microphone could not be opened: ' + ((e && e.message) || 'unknown reason');
}

const closeConn = (conn) => { if (conn) { try { conn.close(); } catch { /* gone */ } } };
/** What is sent: the microphone, and the camera's picture or (background removed) the person on green. */
const sendTracks = () => (media ? [...media.getAudioTracks(), ...(cut ? [cut.track] : media.getVideoTracks())] : []);
/** Puts what is sent now into every connection that is already up, and into the guest's own preview. */
function resend() {
  for (const conn of conns()) for (const s of conn.getSenders()) { const t = sendTracks().find((x) => s.track && x.kind === s.track.kind); if (t && s.track !== t) s.replaceTrack(t).catch(() => {}); }
  if (media) $('gsVideo').srcObject = cut ? new MediaStream([cut.track]) : media;
}
/** Turns the cut-out on or off to match the switch, on the camera that is open now. */
async function cutSync() {
  if (cutBusy) return; cutBusy = true;
  try {
    if (cut) { const old = cut; cut = null; resend(); old.stop(); }
    const cam = media && media.getVideoTracks()[0];
    if (cutWanted && cam) {
      $('gsCutNote').textContent = 'Getting background removal ready...';
      const { startCutout } = await import('./guest-cutout.js');
      cut = await startCutout(cam);
      resend(); $('gsCutNote').textContent = '';
    } else $('gsCutNote').textContent = cutWanted ? 'There is no camera picture to remove a background from.' : '';
  } catch (e) { cutWanted = false; $('gsCut').checked = false; $('gsCutNote').textContent = 'Background removal did not start on this device: ' + ((e && e.message) || 'unknown reason'); }
  cutBusy = false;
}
/** The connections that carry this guest's picture and sound: to the studio, and to each desk. */
const conns = () => [pc, ...[...legs.values()].map((l) => l.pc)].filter(Boolean);

async function openMedia() {
  const v = { ...(pick.cam ? { deviceId: { exact: pick.cam } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  const a = { ...(pick.mic ? { deviceId: { exact: pick.mic } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  // Many phones cannot open a second camera while the first is held: let go of the picture first.
  if (media) media.getVideoTracks().forEach((t) => { t.onended = null; t.stop(); });
  let next;
  try { next = await navigator.mediaDevices.getUserMedia({ video: v, audio: a }); }
  catch (first) {
    // No camera (or it is busy): come in with sound only. No microphone: with the picture only.
    try { next = await navigator.mediaDevices.getUserMedia({ audio: a }); say('No camera could be opened, so you will join with sound only.'); }
    catch { try { next = await navigator.mediaDevices.getUserMedia({ video: v }); say('No microphone could be opened, so you will join without sound.'); } catch { throw first; } }
  }
  const old = media; media = next;
  for (const t of media.getAudioTracks()) t.enabled = want.mic;
  for (const t of media.getVideoTracks()) t.enabled = want.cam;
  // A device that goes away (unplugged, a headset that died, a phone call) is opened again, whichever is there now.
  for (const t of media.getTracks()) t.onended = () => { if (media !== next) return; pick.cam = ''; pick.mic = ''; say('Your camera or microphone stopped. Opening it again...'); openMedia().catch((e) => say(mediaError(e), true)); };
  $('gsVideo').srcObject = media;
  if (old) old.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  // Mirrored like a mirror for a camera that faces the guest, the right way round for one that faces away.
  const facing = (media.getVideoTracks()[0] || { getSettings: () => ({}) }).getSettings().facingMode;
  $('gsView').classList.toggle('is-mirror', facing !== 'environment');
  // The level bar under the picture.
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    if (media.getAudioTracks().length) actx.createMediaStreamSource(media).connect(analyser);
  } catch { analyser = null; }
  // The devices have names once the browser has said yes.
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const fill = (sel, kind, current) => {
    sel.innerHTML = '';
    for (const d of devs.filter((x) => x.kind === kind)) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (kind === 'videoinput' ? 'Camera' : 'Microphone'); if (d.deviceId === current) o.selected = true; sel.appendChild(o); }
  };
  fill($('gsCam'), 'videoinput', (media.getVideoTracks()[0] || { getSettings: () => ({}) }).getSettings().deviceId);
  fill($('gsMic'), 'audioinput', (media.getAudioTracks()[0] || { getSettings: () => ({}) }).getSettings().deviceId);
  // Already connected: the new camera or microphone replaces the old one in place (the cut-out starts again on the new camera).
  if (cut || cutWanted) await cutSync(); else resend();
}

const buf = new Float32Array(1024);
setInterval(() => {
  let peak = 0;
  if (analyser && media && media.getAudioTracks().some((t) => t.enabled)) { analyser.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }
  const pct = peak > 0.001 ? Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60)) * 100 : 0;
  $('gsLevel').style.width = pct + '%';
}, 100);
// The level bar needs the page to have been touched once (the browser's rule for sound).
document.addEventListener('pointerdown', () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); }, { passive: true });

/**
 * Waits until the connection has its network candidates. The offer is sent once, whole, so a
 * candidate that arrives later is never used: when a relay is configured, wait for a relay
 * candidate (a slow mobile network takes a while to get one), up to a longer limit.
 */
function gathered(conn) {
  const relay = ice.some((s) => [].concat(s.urls || []).some((u) => /^turns?:/i.test(u)));
  return new Promise((resolve) => {
    if (conn.iceGatheringState === 'complete') return resolve();
    let soft = null;
    const done = () => { clearTimeout(hard); clearTimeout(soft); resolve(); };
    const hard = setTimeout(done, relay ? 7000 : 3000);
    if (relay) conn.addEventListener('icecandidate', (e) => { if (e.candidate && / typ relay /.test(e.candidate.candidate) && !soft) soft = setTimeout(done, 400); });
    conn.addEventListener('icegatheringstatechange', () => { if (conn.iceGatheringState === 'complete') done(); });
  });
}

/** Offer the studio a connection carrying the camera and the microphone, complete with its candidates. */
async function offer() {
  if (offering || !me || !media) return;
  offering = true;
  closeConn(pc);
  const conn = pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  conn.seq = -1;             // the number the server gives this offer: an answer to any other number is not for this connection
  try {
    for (const t of sendTracks()) conn.addTrack(t, media);
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      if (conn.connectionState === 'connected') { fails = 0; lostAt = 0; }
      if (conn.connectionState === 'disconnected') lostAt = lostAt || Date.now();
      if (conn.connectionState === 'failed' || conn.connectionState === 'closed') { fails += 1; closeConn(conn); pc = null; }
    };
    await conn.setLocalDescription(await conn.createOffer());
    await gathered(conn);
    if (!me || pc !== conn) throw new Error('superseded');
    const st = await post('/offer', { ...me, sdp: conn.localDescription.sdp });
    conn.seq = st.seq;
  } catch (e) { if (pc === conn) { closeConn(conn); pc = null; } }
  offering = false;
}

/*
 * The operator's own view: one more connection to each open desk, with a smaller picture, so the
 * person running the show sees and can hear this guest live, whether or not the stream is running.
 */
const legs = new Map();      // desk id -> { pc, seq, busy }
function dropLeg(id) { const l = legs.get(id); if (l) { closeConn(l.pc); if (l.audio) { l.audio.srcObject = null; } } legs.delete(id); talkback(); }
/** Says so while the studio is talking to this guest. */
function talkback() { const on = [...legs.values()].some((l) => l.heard); $('gsTalk').hidden = !on; }
/** Whether sound is arriving from a desk right now: the studio pressed Talk. Counted, because a line that goes quiet does not say so. */
async function hearCheck() {
  for (const leg of legs.values()) {
    if (!leg.rx) continue;
    try {
      let n = 0; (await leg.rx.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') n = r.packetsReceived || 0; });
      leg.heard = leg.packets !== undefined && n - leg.packets > 5; leg.packets = n;
    } catch { leg.heard = false; }
  }
  talkback();
}
async function offerDesk(id) {
  const had = legs.get(id); if (had && had.busy) return;
  if (had) closeConn(had.pc);
  const leg = { pc: new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' }), seq: -1, busy: true }; legs.set(id, leg);
  try {
    const conn = leg.pc;
    for (const t of sendTracks()) {
      const sender = conn.addTrack(t, media);
      // A preview, not the programme: a quarter of the pixels and a modest bit rate leave the uplink for the stream.
      if (t.kind === 'video') { try { const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]; p.encodings[0].maxBitrate = 400000; p.encodings[0].scaleResolutionDownBy = 2; await sender.setParameters(p); } catch { /* full size then */ } }
    }
    // TALKBACK: the studio can talk to this guest on the same connection. A guest without a microphone still gets the line to listen on.
    if (!media.getAudioTracks().length) conn.addTransceiver('audio', { direction: 'recvonly' });
    conn.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      const el = document.createElement('audio'); el.autoplay = true; el.srcObject = new MediaStream([e.track]); leg.audio = el;
      el.play().catch(() => {});
      leg.rx = e.receiver;
    };
    conn.onconnectionstatechange = () => { if (legs.get(id) === leg && conn.connectionState === 'failed') dropLeg(id); };
    await conn.setLocalDescription(await conn.createOffer());
    await gathered(conn);
    if (!me || legs.get(id) !== leg) throw new Error('superseded');
    leg.seq = (await post('/desk-offer', { ...me, desk: id, sdp: conn.localDescription.sdp })).seq;
  } catch { if (legs.get(id) === leg) dropLeg(id); }
  leg.busy = false;
}
function syncDesks(list) {
  if (!media || !me) return;
  const here = new Set((list || []).map((d) => d.id));
  for (const id of [...legs.keys()]) if (!here.has(id)) dropLeg(id);
  for (const d of list || []) {
    const leg = legs.get(d.id);
    if (!leg || (d.need_offer && !leg.busy)) { offerDesk(d.id); continue; }
    if (!leg.busy && d.answer && d.seq === leg.seq && leg.pc.signalingState === 'have-local-offer') leg.pc.setRemoteDescription({ type: 'answer', sdp: d.answer }).catch(() => dropLeg(d.id));
  }
}

function show(st) {
  const view = $('gsView');
  const connected = pc && pc.connectionState === 'connected';
  // Four states, and the page never claims more than is true: no studio yet, connecting, backstage, on air.
  const mode = !st.studio ? 'wait' : !connected ? 'conn' : st.on_air ? 'air' : 'back';
  if (mode === 'air' && !view.classList.contains('is-air') && navigator.vibrate) { try { navigator.vibrate(200); } catch { /* not allowed */ } }
  view.classList.toggle('is-air', mode === 'air');
  view.classList.toggle('is-back', mode === 'back');
  view.classList.toggle('is-wait', mode === 'wait' || mode === 'conn');
  const set = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };      // unchanged text is not read out again
  set('gsTag', { wait: 'Waiting', conn: 'Connecting', back: 'Backstage', air: 'ON AIR' }[mode]);
  set('gsTitle', { wait: 'Waiting for the studio', conn: 'Connecting to the studio', back: 'You are backstage', air: 'You are on air' }[mode]);
  set('gsLead', !st.studio ? 'You are in. The stream has not started yet: keep this page open and you will be connected as soon as it does.'
    : !connected ? (fails >= 3 ? 'Your network is blocking the connection to the studio. Try mobile data or another Wi-Fi; this page keeps trying.' : 'Connecting you to the studio...')
      : st.on_air ? 'The audience can see and hear you now.'
        : 'The studio can see you. Nobody else can see or hear you until you are put on air.');
}

let ticking = false;
async function tick() {
  if (!me || ticking) return;
  ticking = true;
  try {
    let st;
    try { st = await post('/state', { ...me, green: !!cut }); }
    catch (e) {
      if (e.status === 410) return ended('The studio has ended your visit. Thank you for joining.');
      if (e.status === 404) return await rejoin();
      throw e;
    }
    if (st.ice_servers) ice = st.ice_servers;
    // A connection that has been silent for a few seconds is not coming back by itself: offer again without waiting for it to fail.
    if (pc && lostAt && Date.now() - lostAt > 5000 && pc.connectionState === 'disconnected' && !offering) { lostAt = 0; fails += 1; closeConn(pc); pc = null; }
    if (st.studio && (st.need_offer || !pc)) offer();
    else if (pc && !offering && st.answer && st.seq === pc.seq && pc.signalingState === 'have-local-offer') { const conn = pc; await conn.setRemoteDescription({ type: 'answer', sdp: st.answer }).catch(() => { if (pc === conn) { closeConn(conn); pc = null; } }); }
    syncDesks(st.desks); hearCheck();
    // A device that cannot keep up says so: a few pictures a second looks worse than a real background.
    if (cut) { const r = cut.rate(); $('gsCutNote').textContent = r && r < 10 ? `Background removal is slow on this device (${Math.round(r)} pictures a second). Turn it off if the picture looks jerky.` : ''; }
    show(st); say('');
  } catch { say('Lost touch with the studio. Trying again...'); }
  finally { ticking = false; }
}

/** The server no longer knows this guest (it restarted, or this page was asleep for minutes): come in again, same name. */
async function rejoin() {
  const was = me; me = null;
  closeConn(pc); pc = null; for (const id of [...legs.keys()]) dropLeg(id);
  try {
    const j = await post('/join', { name: myName });
    me = { guest_id: j.guest_id, key: j.key }; ice = j.ice_servers || ice;
    show(j); say('You were reconnected to the studio.');
    if (j.studio) offer();
  } catch (e) {
    if (e.status === 404) return ended('The studio has closed this visit. Thank you for joining.');
    if (e.status === 409) return ended(e.message, true);
    me = was;              // the server did not answer: the next tick tries again
    say('Lost touch with the studio. Trying again...');
  }
}

function ended(text, keepMedia) {
  me = null;
  closeConn(pc); pc = null;
  for (const id of [...legs.keys()]) dropLeg(id);
  if (lock) { try { lock.release(); } catch { /* gone */ } lock = null; }
  // The camera light goes out when the visit is over; Join opens it again.
  if (cut) { cut.stop(); cut = null; }
  if (!keepMedia && media) { media.getTracks().forEach((t) => { t.onended = null; t.stop(); }); media = null; $('gsVideo').srcObject = null; }
  $('gsLive').hidden = true; $('gsSetup').hidden = false;
  $('gsView').classList.remove('is-air', 'is-back', 'is-wait'); $('gsTag').textContent = 'Camera check';
  $('gsTitle').textContent = 'Join the broadcast'; $('gsLead').textContent = '';
  say(text);
}

/** Keeps the phone's screen on while in the green room: a locked phone stops sending. */
async function stayAwake() {
  try { if (navigator.wakeLock && !lock && document.visibilityState === 'visible') { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { /* the browser said no */ }
}
document.addEventListener('visibilitychange', () => { if (me && document.visibilityState === 'visible') { stayAwake(); tick(); } });

const labels = () => {
  $('gsMute').textContent = want.mic ? 'Mute microphone' : 'Unmute microphone'; $('gsMute').setAttribute('aria-pressed', String(!want.mic));
  $('gsCamOff').textContent = want.cam ? 'Turn camera off' : 'Turn camera on'; $('gsCamOff').setAttribute('aria-pressed', String(!want.cam));
};
$('gsCut').addEventListener('change', () => { cutWanted = $('gsCut').checked; cutSync(); });
$('gsCam').addEventListener('change', () => { pick.cam = $('gsCam').value; openMedia().catch((e) => say(mediaError(e), true)); });
$('gsMic').addEventListener('change', () => { pick.mic = $('gsMic').value; openMedia().catch((e) => say(mediaError(e), true)); });
$('gsJoin').addEventListener('click', async () => {
  $('gsJoin').disabled = true;
  try {
    if (!media) await openMedia();
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    myName = $('gsName').value.trim();
    try { localStorage.setItem('st_guest_name', myName); } catch { /* not kept */ }
    let j;
    try { j = await post('/join', { name: myName }); } catch (e) { say(e.message, true); $('gsJoin').disabled = false; return; }
    me = { guest_id: j.guest_id, key: j.key }; ice = j.ice_servers || []; fails = 0; lostAt = 0;
    $('gsSetup').hidden = true; $('gsLive').hidden = false; labels();
    show(j); stayAwake();
    if (j.studio) offer();
  } catch (e) { say(mediaError(e), true); }
  $('gsJoin').disabled = false;
});
$('gsMute').addEventListener('click', () => { want.mic = !want.mic; if (media) media.getAudioTracks().forEach((t) => { t.enabled = want.mic; }); labels(); });
$('gsCamOff').addEventListener('click', () => { want.cam = !want.cam; if (media) media.getVideoTracks().forEach((t) => { t.enabled = want.cam; }); labels(); });
$('gsLeave').addEventListener('click', async () => { const who = me; if (who) post('/leave', who).catch(() => {}); ended('You have left. You can close this page.'); });
window.addEventListener('pagehide', () => { if (me && navigator.sendBeacon) navigator.sendBeacon(api + '/leave', new Blob([JSON.stringify(me)], { type: 'application/json' })); });
setInterval(tick, 1000);

if (!window.isSecureContext) say(mediaError(null), true);
else if (!navigator.mediaDevices || !window.RTCPeerConnection) say('This browser cannot join a broadcast. Use a current Chrome, Edge, Firefox or Safari.', true);
else openMedia().catch((e) => say(e && e.name === 'NotAllowedError' ? 'Allow the camera and microphone for this page, then press Join.' : mediaError(e), true));

// A tall picture (a phone held upright) is shown whole, and the guest is told how to fill the frame.
{ const v = $('gsVideo'), tall = () => { $('gsTurn').hidden = !(v.videoHeight > v.videoWidth); }; v.addEventListener('loadedmetadata', tall); v.addEventListener('resize', tall); }
