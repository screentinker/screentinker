/*
 * The guest's page of a broadcast (server/lib/mixer-guests.js): /guest/<token>.
 *
 * Camera and microphone are opened here and shown back to the guest. Join sends the studio an
 * offer of a direct connection carrying both; the studio's renderer answers it. From then on
 * the page asks, once a second, how things stand: still connected, backstage or on air.
 *
 * Whenever the studio has no connection for this guest (it was started after they joined, it was
 * restarted, the network dropped), the page simply offers again. The guest does nothing.
 */
const token = location.pathname.split('/').filter(Boolean).pop();
const api = `/api/stream-guest/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);
const say = (text, error) => { $('gsMsg').textContent = text || ''; $('gsMsg').classList.toggle('error', !!error); };

let media = null;            // the camera and microphone
let me = null;               // { guest_id, key } once joined
let pc = null, pcSeq = 0, offering = false, ice = [];
let actx = null, analyser = null;
const pick = { cam: '', mic: '' };
try { $('gsName').value = localStorage.getItem('st_guest_name') || ''; } catch { /* not kept */ }

async function post(path, body) {
  const r = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'The studio did not answer.'), { status: r.status });
  return j;
}

async function openMedia() {
  const next = await navigator.mediaDevices.getUserMedia({
    video: { ...(pick.cam ? { deviceId: { exact: pick.cam } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    audio: { ...(pick.mic ? { deviceId: { exact: pick.mic } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const old = media; media = next;
  $('gsVideo').srcObject = media;
  if (old) old.getTracks().forEach((t) => t.stop());
  // The level bar under the picture.
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    actx.createMediaStreamSource(media).connect(analyser);
  } catch { analyser = null; }
  // The devices have names once the browser has said yes.
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const fill = (sel, kind, current) => {
    sel.innerHTML = '';
    for (const d of devs.filter((x) => x.kind === kind)) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (kind === 'videoinput' ? 'Camera' : 'Microphone'); if (d.deviceId === current) o.selected = true; sel.appendChild(o); }
  };
  fill($('gsCam'), 'videoinput', (media.getVideoTracks()[0] || { getSettings: () => ({}) }).getSettings().deviceId);
  fill($('gsMic'), 'audioinput', (media.getAudioTracks()[0] || { getSettings: () => ({}) }).getSettings().deviceId);
  // Already connected: the new camera or microphone replaces the old one in place.
  if (pc) for (const s of pc.getSenders()) { const t = media.getTracks().find((x) => s.track && x.kind === s.track.kind); if (t) s.replaceTrack(t).catch(() => {}); }
}

const buf = new Float32Array(1024);
setInterval(() => {
  let peak = 0;
  if (analyser && media && media.getAudioTracks().some((t) => t.enabled)) { analyser.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }
  const pct = peak > 0.001 ? Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60)) * 100 : 0;
  $('gsLevel').style.width = pct + '%';
}, 100);

/** Offer the studio a connection carrying the camera and the microphone, complete with its candidates. */
async function offer() {
  if (offering || !me || !media) return;
  offering = true;
  try {
    if (pc) { try { pc.close(); } catch { /* gone */ } }
    const conn = pc = new RTCPeerConnection({ iceServers: ice });
    for (const t of media.getTracks()) conn.addTrack(t, media);
    conn.onconnectionstatechange = () => { if (pc === conn && (conn.connectionState === 'failed' || conn.connectionState === 'closed')) { pc = null; } };
    await conn.setLocalDescription(await conn.createOffer());
    await new Promise((resolve) => {
      if (conn.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 3000);
      conn.addEventListener('icegatheringstatechange', () => { if (conn.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
    const st = await post('/offer', { ...me, sdp: conn.localDescription.sdp });
    pcSeq = st.seq;
  } catch (e) { pc = null; }
  offering = false;
}

function show(st) {
  const view = $('gsView');
  const connected = pc && pc.connectionState === 'connected';
  // Four states, and the page never claims more than is true: no studio yet, connecting, backstage, on air.
  const mode = !st.studio ? 'wait' : !connected ? 'conn' : st.on_air ? 'air' : 'back';
  view.classList.toggle('is-air', mode === 'air');
  view.classList.toggle('is-back', mode === 'back');
  view.classList.toggle('is-wait', mode === 'wait' || mode === 'conn');
  $('gsTag').textContent = { wait: 'Waiting', conn: 'Connecting', back: 'Backstage', air: 'ON AIR' }[mode];
  $('gsTitle').textContent = { wait: 'Waiting for the studio', conn: 'Connecting to the studio', back: 'You are backstage', air: 'You are on air' }[mode];
  $('gsLead').textContent = !st.studio ? 'You are in, but the studio has not started yet. Keep this page open: you will be connected as soon as it does.'
    : !connected ? 'Connecting you to the studio...'
      : st.on_air ? 'The audience can see and hear you now.'
        : 'The studio can see you. Nobody else can see or hear you until you are put on air.';
}

async function tick() {
  if (!me) return;
  try {
    const r = await fetch(`${api}/state?guest_id=${encodeURIComponent(me.guest_id)}&key=${encodeURIComponent(me.key)}`, { cache: 'no-store' });
    if (r.status === 404) return ended('The studio has closed this visit. Thank you for joining.');
    if (!r.ok) throw new Error('later');
    const st = await r.json();
    if (st.studio && (st.need_offer || !pc)) offer();
    else if (pc && st.answer && st.seq === pcSeq && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp: st.answer }).catch(() => { pc = null; });
    show(st); say('');
  } catch { say('Lost touch with the studio. Trying again...'); }
}

function ended(text) {
  me = null;
  if (pc) { try { pc.close(); } catch { /* gone */ } pc = null; }
  $('gsLive').hidden = true; $('gsSetup').hidden = false;
  $('gsView').classList.remove('is-air', 'is-back'); $('gsTag').textContent = 'Camera check';
  $('gsTitle').textContent = 'Join the broadcast'; $('gsLead').textContent = '';
  say(text);
}

$('gsCam').addEventListener('change', () => { pick.cam = $('gsCam').value; openMedia().catch((e) => say(e.message, true)); });
$('gsMic').addEventListener('change', () => { pick.mic = $('gsMic').value; openMedia().catch((e) => say(e.message, true)); });
$('gsJoin').addEventListener('click', async () => {
  $('gsJoin').disabled = true;
  try {
    if (!media) await openMedia();
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    const name = $('gsName').value.trim();
    try { localStorage.setItem('st_guest_name', name); } catch { /* not kept */ }
    const j = await post('/join', { name });
    me = { guest_id: j.guest_id, key: j.key }; ice = j.ice_servers || [];
    $('gsSetup').hidden = true; $('gsLive').hidden = false;
    show(j);
    if (j.studio) offer();
  } catch (e) { say(e.name === 'NotAllowedError' ? 'The browser did not allow the camera and microphone. Allow them for this page and try again.' : e.message, true); }
  $('gsJoin').disabled = false;
});
$('gsMute').addEventListener('click', () => { const t = media && media.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; $('gsMute').textContent = t.enabled ? 'Mute microphone' : 'Unmute microphone'; });
$('gsCamOff').addEventListener('click', () => { const t = media && media.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; $('gsCamOff').textContent = t.enabled ? 'Turn camera off' : 'Turn camera on'; });
$('gsLeave').addEventListener('click', async () => { const who = me; if (who) post('/leave', who).catch(() => {}); ended('You have left. You can close this page.'); });
window.addEventListener('pagehide', () => { if (me && navigator.sendBeacon) navigator.sendBeacon(api + '/leave', new Blob([JSON.stringify(me)], { type: 'application/json' })); });
setInterval(tick, 1000);

if (!navigator.mediaDevices || !window.RTCPeerConnection) say('This browser cannot join a broadcast. Use a current Chrome, Edge, Firefox or Safari.', true);
else openMedia().catch((e) => say(e.name === 'NotAllowedError' ? 'Allow the camera and microphone for this page, then press Join.' : 'No camera or microphone was found: ' + e.message, true));
