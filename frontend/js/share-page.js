/*
 * 3.0 screen share — the meeting-room page at /share (frontend/share.html). No account: a guest
 * types the code the screen shows (or scans its QR, which opens /share?code=…) and presents.
 *
 * What they can present depends on the device, and only what it can actually do is offered:
 *   - their SCREEN, where the browser has getDisplayMedia (computers);
 *   - their CAMERA, where it has getUserMedia (phones and tablets too: Android Chrome, iPhone
 *     Safari) — the back camera by default, switchable while live;
 *   - on Android, their phone's SCREEN through the ScreenTinker app, which the page opens with the
 *     server address and the code (no account, no saved server: docs/screen-share.md).
 *
 * The order matters: the picker / camera prompt opens FIRST (it needs the click), and only then is
 * the code spent on POST /api/share/join — cancelling the picker leaves the code usable.
 *
 * Several people at once: when the screen lets several present, the server tells this page who is
 * on it ({type:'room'}); the FIRST presenter gets "Make full screen" / "Remove" next to the others.
 *
 * All text goes in with textContent; nothing from the server or the URL is parsed as HTML.
 */
import { t } from './i18n.js';
import {
  ScreenShareSender, MultiShareSender, pickScreen, pickCamera, shareUnsupportedReason, cameraUnsupportedReason,
  isMobileBrowser, isAndroid, stopStream, managerAppLink, soundMissing, noSoundKey,
} from './lib/screen-share-client.js';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'st_share_name';

const KNOWN_REASONS = new Set([
  'stopped_by_sharer', 'stopped_by_owner', 'max_duration', 'connection_failed', 'screen_unreachable',
  'screen_offline', 'screen_left', 'screen_unsupported', 'signalling_closed', 'signalling_failed',
  'invalid_ticket', 'not_connected', 'disabled_by_admin', 'sharer_left',
  'disabled', 'workspace_disabled', 'unsupported', 'offline', 'busy', 'invalid_code', 'removed',
]);
const reasonText = (r) => t(KNOWN_REASONS.has(r) ? `screen_share.reason.${r}` : 'screen_share.reason.generic');

document.title = t('screen_share.guest_page.title');
document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.getAttribute('data-t')); });

// The QR opens /share?code=… (older screens put it in the #fragment). Take it, then drop it from
// the address bar and history, so it is not left in a shared link or a screenshot.
function codeFromUrl() {
  let raw = '';
  try { raw = new URLSearchParams(location.search).get('code') || ''; } catch (_) { raw = ''; }
  if (!raw) raw = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  return raw.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12);
}
const fromUrl = codeFromUrl();
if (fromUrl) {
  const plain = fromUrl.replace(/-/g, '');
  $('shareCode').value = plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : fromUrl;
  try { history.replaceState(null, '', location.pathname); } catch (_) { /* cosmetic */ }
}
try { $('shareName').value = localStorage.getItem(NAME_KEY) || ''; } catch (_) { /* private mode */ }

function say(msg, isError) {
  const el = $('shareMsg');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

// ------------------------------------------------------------------ what this device can present
const screenWhy = shareUnsupportedReason();
const cameraWhy = cameraUnsupportedReason();
const mobile = isMobileBrowser();

function paintWays() {
  $('shareGo').hidden = !!screenWhy;
  // A camera share is offered wherever the browser has a camera API; on a computer it is a second
  // choice under "Share my screen", on a phone it is the main one.
  $('shareCameraBox').hidden = !!cameraWhy;
  // Sound only means something when this browser can send something.
  $('shareAudio').closest('label').hidden = !!(screenWhy && cameraWhy);
  const note = $('shareScreenNote');
  if (screenWhy) {
    // Why there is no "Share my screen": a phone browser cannot, an http address cannot, …
    const msg = screenWhy === 'no_display_media' && mobile
      ? t(cameraWhy ? 'screen_share.guest_page.no_screen_phone_nocam' : 'screen_share.guest_page.no_screen_phone')
      : t(`screen_share.unsupported.${screenWhy}`);
    note.textContent = msg + (isAndroid() ? ' ' + t('screen_share.guest_page.no_screen_android_app') : '');
    note.hidden = false;
  } else note.hidden = true;
  // Android: the phone's own screen goes through the ScreenTinker app (MediaProjection).
  // (also over plain http on a LAN, where the browser can capture nothing but the app can).
  $('shareApp').hidden = !(isAndroid() && screenWhy);
  if (screenWhy && cameraWhy && !isAndroid()) say(t(`screen_share.unsupported.${screenWhy}`), true);
}
paintWays();

let sender = null;
let mode = null;          // 'screen' | 'camera'
let facing = 'environment';
let roomState = null;

function showLive(screenName, state) {
  $('shareForm').hidden = true;
  $('shareLive').hidden = false;
  $('shareLive').classList.toggle('on', state === 'live');
  $('shareLiveTitle').textContent = t('screen_share.bar.sharing_to', { name: screenName });
  $('shareLiveState').textContent = state === 'live'
    ? t(mode === 'camera' ? 'screen_share.guest_page.live_camera' : 'screen_share.state.live')
    : t(state === 'negotiating' ? 'screen_share.state.negotiating' : 'screen_share.state.connecting');
  $('shareFlip').hidden = mode !== 'camera';
}

function showForm(msg, isError) {
  $('shareLive').hidden = true;
  $('shareForm').hidden = false;
  $('shareRoom').hidden = true;
  $('shareLiveMsg').textContent = '';
  roomState = null;
  setBusy(false);
  // A code is good for one share: the screen is already showing a new one.
  $('shareCode').value = '';
  say(msg, isError);
}

function setBusy(on) {
  for (const id of ['shareGo', 'shareCamera', 'shareApp']) { const b = $(id); if (b) b.disabled = !!on; }
}

// ------------------------------------------------------------------ the room (several presenters)
function paintRoom() {
  const box = $('shareRoom');
  const r = roomState;
  if (!r || !Array.isArray(r.presenters) || (r.presenters.length < 2 && !(r.slots > 1))) { box.hidden = true; return; }
  box.hidden = false;
  $('shareRoomTitle').textContent = t('screen_share.room.count', { count: r.presenters.length, slots: r.slots || r.presenters.length });
  const ul = $('shareRoomList');
  ul.textContent = '';
  const anySpot = r.presenters.some((p) => p.spotlight);
  for (const p of r.presenters) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name + (p.you ? ` (${t('screen_share.room.you')})` : '');
    li.appendChild(who);
    if (p.spotlight) {
      const tag = document.createElement('small');
      tag.textContent = t('screen_share.room.full_screen');
      li.appendChild(tag);
    }
    if (r.can_control) {
      const spot = document.createElement('button');
      spot.type = 'button';
      spot.className = 'btn btn-secondary btn-sm';
      spot.textContent = t(p.spotlight ? 'screen_share.room.unspotlight' : 'screen_share.room.spotlight');
      spot.addEventListener('click', () => sender && sender.roomAction(r.room, 'spotlight', p.spotlight ? null : p.id));
      li.appendChild(spot);
      if (!p.you) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn btn-danger btn-sm';
        rm.textContent = t('screen_share.room.remove');
        rm.addEventListener('click', () => sender && sender.roomAction(r.room, 'remove', p.id));
        li.appendChild(rm);
      }
    }
    ul.appendChild(li);
  }
  if (anySpot && !r.can_control) {
    const li = document.createElement('li');
    const note = document.createElement('small');
    note.textContent = t('screen_share.room.spotlight_note');
    li.appendChild(note);
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ joining
async function join(kind) {
  if (sender) return;
  const code = $('shareCode').value.trim();
  const name = $('shareName').value.trim();
  const audio = $('shareAudio').checked;
  if (!code) { say(t('screen_share.guest_page.need_code'), true); return; }
  try { localStorage.setItem(NAME_KEY, name); } catch (_) { /* private mode */ }
  setBusy(true);
  say('');
  let stream;
  try {
    if (kind === 'camera') {
      facing = (document.querySelector('input[name="shareFacing"]:checked') || {}).value === 'user' ? 'user' : 'environment';
      stream = await pickCamera({ facing, audio });
    } else stream = await pickScreen({ audio });
  } catch (err) {
    setBusy(false);
    if (kind === 'camera' && err && err.name === 'NotAllowedError') say(t('screen_share.guest_page.camera_denied'), true);
    else if (!(err && err.name === 'NotAllowedError')) say(t(kind === 'camera' ? 'screen_share.guest_page.camera_failed' : 'screen_share.pick_failed'), true);
    return;
  }
  const noSound = kind !== 'camera' && soundMissing(stream, audio);
  let body;
  try {
    const res = await fetch('/api/share/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, audio: audio && stream.getAudioTracks().length > 0, source: kind }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      stopStream(stream);
      setBusy(false);
      say(res.status === 429 ? t('screen_share.guest_page.slow_down') : reasonText(body.reason), true);
      return;
    }
  } catch (_) {
    stopStream(stream);
    setBusy(false);
    say(t('screen_share.reason.generic'), true);
    return;
  }
  mode = kind;
  const screenName = body.screen_name || '';
  showLive(screenName, 'connecting');
  const onEnded = (reason) => {
    sender = null;
    mode = null;
    showForm(reason === 'stopped_by_sharer' ? t('screen_share.stopped') : reasonText(reason),
      !['stopped_by_sharer', 'stopped_by_owner', 'max_duration', 'removed'].includes(reason));
  };
  // The code is the display's and shows on its mirrors too (its link open somewhere else): the
  // join hands back one leg per place, the one capture goes to all of them, and a mirror that
  // connects during the share is added by the server over these same sockets. To the guest it is
  // still one screen, named after the display. (No `legs`: an older server, one leg.)
  if (Array.isArray(body.legs) && body.legs.length) {
    sender = new MultiShareSender({
      legs: body.legs, wsPath: body.ws_path, stream,
      onState: (sum) => showLive(screenName, sum.state),
      onRoom: (r) => { roomState = r; paintRoom(); },
      onRoomRefused: () => { $('shareLiveMsg').textContent = t('screen_share.room.refused'); },
      onLegSkipped: (leg) => {
        if (leg.reason === 'single_presenter') $('shareLiveMsg').textContent = t('screen_share.multi.single', { name: leg.name || screenName });
      },
      onLegEnded: (leg, reason) => {
        if (reason === 'spotlight_changed') $('shareLiveMsg').textContent = t('screen_share.multi.single', { name: leg.name || screenName });
      },
      onEnded,
    });
  } else {
    sender = new ScreenShareSender({
      ticket: body.ticket, wsPath: body.ws_path, iceServers: body.ice_servers, stream,
      onState: (st) => showLive(screenName, st),
      onEnded,
    });
  }
  sender.start();
  if (noSound) say(t(noSoundKey(stream)));
}

$('shareJoin').addEventListener('submit', (e) => { e.preventDefault(); if (!screenWhy) join('screen'); });
$('shareCamera').addEventListener('click', () => { if (!cameraWhy) join('camera'); });

// The other camera, without leaving the share.
$('shareFlip').addEventListener('click', async () => {
  if (!sender || mode !== 'camera' || typeof sender.replaceVideo !== 'function') return;
  const next = facing === 'user' ? 'environment' : 'user';
  $('shareFlip').disabled = true;
  try {
    const s = await pickCamera({ facing: next, audio: false });
    await sender.replaceVideo(s);
    facing = next;
  } catch (_) { $('shareLiveMsg').textContent = t('screen_share.guest_page.camera_failed'); }
  $('shareFlip').disabled = false;
});

/*
 * Android: share the PHONE's screen through the ScreenTinker app. The app takes the server and the
 * code from this link — no account, no saved server — and asks before anything is captured
 * ("Share your screen to <host>?"). Not installed: Android opens the Play Store instead.
 */
$('shareApp').addEventListener('click', () => {
  const link = managerAppLink(location.origin, $('shareCode').value.trim());
  if (!link) { say(t('screen_share.guest_page.need_code'), true); $('shareCode').focus(); return; }
  location.href = link;
});

$('shareStop').addEventListener('click', () => { if (sender) sender.stop(); });
window.addEventListener('pagehide', () => { if (sender) sender.stop(); });
