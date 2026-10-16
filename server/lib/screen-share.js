'use strict';
/*
 * 3.0: "Share your screen to a TV" — the signalling relay and session state (docs/screen-share.md).
 *
 * A person's browser (the SHARER: an editor on the dashboard, or a guest in a meeting room with the
 * code the screen shows) sends its getDisplayMedia() stream straight to a screen (the PLAYER) over
 * peer-to-peer WebRTC. This server never touches the media. It only:
 *
 *   1. decides who may share to which screen (routes/screen-share.js, routes/screen-share-guest.js),
 *   2. hands the sharer a single-use TICKET for this one session,
 *   3. pairs two WebSockets — the sharer's and the screen's — and relays the SDP offer/answer and
 *      ICE candidates between them, validated and rebuilt field by field (never passed through),
 *   4. ends the session when either side leaves, an owner stops it, or the maximum duration passes.
 *
 * WHY PEER-TO-PEER AND NOT THE go2rtc SIDECAR that live video and Talk use: a share has exactly one
 * viewer (the screen), so a restreamer buys nothing, and go2rtc is optional and off by default — a
 * feature that needs it would not work on a plain self-hosted install. P2P works with no sidecar on
 * a LAN (host candidates), and the org's existing ICE config (lib/org-webrtc.js: per-org TURN/STUN
 * override, else the GO2RTC_STUN/TURN globals) covers NAT for the rest.
 *
 * WHY TWO WEBSOCKETS rather than the Socket.IO namespaces: a guest has no account and so no
 * dashboard socket, and one relay shape for both sharer kinds is one thing to secure. The screen's
 * leg is a WebSocket too (authenticated with its device_token in the FIRST MESSAGE, not the URL, so
 * the token never lands in an access log) and speaks go2rtc's own message shape
 * ({type:'webrtc/offer'|'webrtc/answer'|'webrtc/candidate', value}) so the native Android talk leg
 * could later reuse its signalling code unchanged. The screen is told to open that leg over its
 * existing Socket.IO connection (device:screenshare-start).
 *
 * The screen OFFERS (recvonly video + audio) and the sharer ANSWERS with its tracks. That way the
 * screen — the side that can be relied on to exist and be online — drives the negotiation, and the
 * sharer's page only ever reacts.
 *
 * ⚠️ STATE IS IN MEMORY, in the process the screen is connected to. A share needs the sharer's
 * WebSocket and the screen's to land on the same process; on a scale-out replica the screens stay
 * on the primary, so the sharer must reach the primary too (docs/screen-share.md, "Limits").
 */
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('../config');
const { db } = require('../db/database');
const playerCapabilities = require('./player-capabilities');
const { audit } = require('./audit');

const CAP = 'remote.screen_share';
// The player can show up to MAX_TILES shares side by side / in a 2x2 grid (the web player's receiver).
// A screen without it shows one presenter at a time: the spotlighted one, else the first.
const TILES_CAP = 'remote.screen_share_tiles';
const MAX_TILES = 4;

// A ticket must be used (sharer WebSocket opened and authenticated) within this long of being minted.
const TICKET_TTL_MS = 60 * 1000;
// After the sharer connects, the screen has this long to open its leg before we give up.
const DEVICE_JOIN_MS = 20 * 1000;
// Each WebSocket must authenticate (first message) within this long, or it is closed.
const AUTH_MS = 10 * 1000;
// Liveness ping on both legs; a peer that misses two is gone (a laptop lid closed mid-share).
const PING_MS = 15 * 1000;
// Meeting-room codes rotate this often even if nobody uses them, and after every successful join.
const CODE_TTL_MS = 10 * 60 * 1000;
// Bounds on what the relay will carry. An SDP is a few KB; a candidate line is ~150 bytes.
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 1024;
const MAX_CANDIDATES_PER_LEG = 200;
const MAX_NAME = 40;

/*
 * The code alphabet: Crockford base32 — no I, L, O or U, so a code read off a TV across a room is
 * not ambiguous, and input normalisation (normaliseCode) forgives the look-alikes. 8 characters is
 * 40 bits: with 10 guesses a minute per address (server.js) and a code that changes every ten
 * minutes, guessing one is not a practical attack even across a building full of screens.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

const sessions = new Map();    // session id -> session
// device id -> its live legs, oldest first. One leg per screen unless the screen is in a ROOM that
// lets several people present at once (below, "Several presenters"); then one per presenter.
const byDevice = new Map();
const codes = new Map();       // device id  -> { code, expiresAt }
const codeIndex = new Map();   // code       -> device id
const origins = new Map();     // device id  -> the origin that screen reaches us on (for its QR)
// room key (the display a share was started for) -> { spotlight: shareId | null }. Who is IN a room
// is never stored: it is the live sessions carrying that roomKey (roomPresenters), so nothing can
// drift out of step with the relay.
const roomState = new Map();
let deviceNs = null;
let sweepTimer = null;

// ------------------------------------------------------------------------------------------------
// Gates
// ------------------------------------------------------------------------------------------------

function featureOn() { return !!config.screenShareEnabled; }
function workspaceOn(ws) { return !!ws && ws.screen_share_enabled !== 0; }
function maxSeconds() { return Math.round((config.screenShareMaxMinutes || 60) * 60); }

// Is a player connected to THIS process right now? The room is the truth for "can we reach it";
// the devices.status column lags by the offline debounce.
function isOnline(deviceId) {
  try {
    if (deviceNs && deviceNs.adapter && deviceNs.adapter.rooms) {
      const room = deviceNs.adapter.rooms.get(deviceId);
      if (room && room.size > 0) return true;
    }
  } catch (_) { /* fall through */ }
  return false;
}

/*
 * Whether this screen can be shared to right now, and if not, why — the reason is what the
 * dashboard shows, so each is distinct: 'disabled' (server), 'workspace_disabled', 'unsupported'
 * (the player does not declare remote.screen_share), 'offline', 'busy'.
 */
function availability(device, workspace, roomKey) {
  if (!featureOn()) return { ok: false, reason: 'disabled' };
  if (!workspaceOn(workspace)) return { ok: false, reason: 'workspace_disabled' };
  if (!playerCapabilities.supports(device, CAP)) return { ok: false, reason: 'unsupported' };
  if (!isOnline(device.id)) return { ok: false, reason: 'offline' };
  // A leg on a display's MIRROR, for a share started on the display (roomKey): see legRoomFor.
  if (roomKey && roomKey !== device.id) {
    const why = legRoomFor(device, roomKey, null);
    return why ? { ok: false, reason: why } : { ok: true };
  }
  if (!roomHasSlot(device.id)) return { ok: false, reason: 'busy' };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Several presenters at once (a "room")
// ------------------------------------------------------------------------------------------------
/*
 * A share started FOR a display (the dashboard's start, a guest's code, each screen of a multi
 * share) is a PRESENTER in that display's room; the display is the room key, and the presenter's
 * legs on the display's mirrors belong to the same room. Today's rule — one share per screen — is a
 * room with one slot, which is what every screen has unless a workspace admin turned on
 * devices.screen_share_multi AND the display's player can tile (TILES_CAP). Then the room has
 * maxPresenters() slots (platform setting, 1-4).
 *
 * WHY THE DISPLAY MUST TILE for more than one slot: every presenter is then guaranteed one screen
 * that shows them. A mirror that cannot tile shows one presenter (the spotlighted one, else the
 * first) and the others are told so (reason 'single_presenter'); fillScreen keeps that right as
 * people come and go.
 */
function maxPresenters() {
  let v = parseInt(require('./app-settings').get('screen_share_max_presenters', ''), 10);
  if (!Number.isFinite(v)) v = parseInt(config.screenShareMaxPresenters, 10);
  if (!Number.isFinite(v)) v = MAX_TILES;
  return Math.max(1, Math.min(MAX_TILES, v));
}

function deviceRow(id) {
  try { return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) || null; } catch (_) { return null; }
}

function canTile(device) { return !!device && playerCapabilities.supports(device, TILES_CAP); }

// Does this display let several people present at once right now? The switch (a display's; a
// mirror has none), the player able to tile, and the platform allowing more than one.
function multiOn(device) {
  return !!(device && !device.mirror_of && device.screen_share_multi && canTile(device) && maxPresenters() > 1);
}

function slotsFor(roomKey) { return multiOn(deviceRow(roomKey)) ? maxPresenters() : 1; }

function legsOn(deviceId) { return (byDevice.get(deviceId) || []).filter((s) => !s.ended); }

/*
 * The presenters in a room, first-come first: [{ shareId, sharedBy, guest, userId, audio, joinedAt,
 * legs }]. Derived from the live sessions every time.
 */
function roomPresenters(roomKey) {
  const by = new Map();
  for (const s of sessions.values()) {
    if (s.ended || s.roomKey !== roomKey) continue;
    let p = by.get(s.shareId);
    if (!p) { p = { shareId: s.shareId, sharedBy: s.sharedBy, guest: s.guest, userId: s.userId, ip: s.ip, audio: s.audio, joinedAt: s.createdAt, legs: [] }; by.set(s.shareId, p); }
    p.joinedAt = Math.min(p.joinedAt, s.createdAt);
    p.legs.push(s);
  }
  return [...by.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.shareId < b.shareId ? -1 : 1));
}

// Can one more presenter join the room keyed on this display? No legs of ANOTHER room on it (a
// mirror busy with a share of its own), and a free slot.
function roomHasSlot(deviceId) {
  if (legsOn(deviceId).some((l) => l.roomKey !== deviceId)) return false;
  return roomPresenters(deviceId).length < slotsFor(deviceId);
}

/*
 * Why a presenter (shareId; null = a new one) of room `roomKey` cannot have a leg on `device`, or
 * null when it can. 'busy': the screen shows another room, the presenter is already on it, or every
 * tile is taken; 'single_presenter': the screen cannot tile and already shows someone of this room.
 */
function legRoomFor(device, roomKey, shareId) {
  const legs = legsOn(device.id);
  if (legs.some((l) => l.roomKey !== roomKey)) return 'busy';
  if (shareId && legs.some((l) => l.shareId === shareId)) return 'busy';
  if (!legs.length) return null;
  if (!canTile(device)) return 'single_presenter';
  return legs.length < Math.min(MAX_TILES, slotsFor(roomKey)) ? null : 'busy';
}

function iceServersFor(deviceId) {
  try { return require('./org-webrtc').iceServersForDevice(deviceId); } catch (_) { return []; }
}
// A guest's page: no long-lived TURN login (lib/org-webrtc.js guestIceServers).
function guestIceServersFor(deviceId) {
  try { return require('./org-webrtc').guestIceServersForDevice(deviceId); } catch (_) { return []; }
}

// A display name a person typed. Control characters out, whitespace collapsed, bounded. It is only
// ever rendered with textContent (player badge, dashboard via esc()), but it is also written to the
// audit log, so it is cleaned here once.
function cleanName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s || fallback;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

// ------------------------------------------------------------------------------------------------
// Sessions
// ------------------------------------------------------------------------------------------------

/*
 * Mint a session and its single-use ticket. The caller has already checked access and
 * availability(); this re-checks the room so two simultaneous starts cannot both win.
 *
 * opts: { device, workspace, sharedBy, userId, guest, ip, audio, shareId?, roomKey? }
 *   roomKey: the display the share was started for (default: this screen). A leg on a display's
 *   mirror carries the display's key.
 * returns { session, ticket } or { error: 'busy' | 'single_presenter' }
 */
function createSession(opts) {
  const { device, workspace } = opts;
  const roomKey = opts.roomKey || device.id;
  if (roomKey === device.id) {
    if (!roomHasSlot(device.id)) return { error: 'busy' };
    if (opts.shareId && roomPresenters(roomKey).some((p) => p.shareId === opts.shareId)) return { error: 'busy' };
  } else {
    const why = legRoomFor(device, roomKey, opts.shareId || null);
    if (why) return { error: why };
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const s = {
    id,
    // Multi share: every screen of one share carries the same shareId; a one-screen share is its
    // own share (shareId === id), so nothing that predates multi share changes.
    shareId: opts.shareId || id,
    roomKey,
    deviceId: device.id,
    deviceName: device.name || '',
    workspaceId: workspace.id,
    sharedBy: cleanName(opts.sharedBy, 'Guest'),
    userId: opts.userId || null,
    guest: !!opts.guest,
    ip: opts.ip || null,
    audio: !!opts.audio,
    ticketHash: sha256(ticket),
    ticketUsed: false,
    createdAt: Date.now(),
    startedAt: null,
    live: false,
    sharer: null,
    device: null,
    deviceCandidates: 0,
    sharerCandidates: 0,
    controls: 0,
    offerSeen: false,
    answerSeen: false,
    pendingToDevice: [],
    // Messages for the sharer once its socket is up (e.g. "this mirror shows one presenter at a time").
    notices: [],
    timers: {},
    ended: false,
  };
  sessions.set(s.id, s);
  if (!byDevice.has(device.id)) byDevice.set(device.id, []);
  byDevice.get(device.id).push(s);
  s.timers.ticket = setTimeout(() => endSession(s, 'not_connected'), TICKET_TTL_MS);
  unrefTimer(s.timers.ticket);
  audit(s.guest ? 'screen_share.guest_join' : 'screen_share.start', {
    userId: s.userId, workspaceId: s.workspaceId, deviceId: s.deviceId, ip: s.ip,
    details: { session_id: s.id, share_id: s.shareId, shared_by: s.sharedBy, guest: s.guest, audio: s.audio, room: roomKey !== device.id ? roomKey : undefined, source: opts.source || undefined },
  });
  /*
   * The meeting-room code is SINGLE USE whoever joins. A presenter joining the display's room spends
   * it: the display (and its mirrors) get a NEW code at once while a slot is still free (several
   * presenters), and none while the room is full (currentCode). A share on one MIRROR alone (its own
   * room, the display free) leaves the family offering a code — a fresh one, minted now, and again
   * when that share ends (endSession).
   */
  const src = codeSource(device.id);
  s.onMirrorAlone = src !== device.id && roomKey === device.id;
  if (roomKey === device.id) dropCode(src);
  if (s.guest || roomKey === device.id || src !== device.id || guestEnabled(src)) pushCode(device.id);
  if (!roomState.has(roomKey)) roomState.set(roomKey, { spotlight: null });
  roomChanged(roomKey);
  return { session: s, ticket };
}

// Lazy, like every other cross-module require here: keeps the load order free of cycles.
function mirrorsLib() { return require('./mirrors'); }

function unrefTimer(t) { try { if (t && t.unref) t.unref(); } catch (_) {} }

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch (_) {} }
}

/*
 * End a session for any reason. Idempotent. Tells both sides, closes both legs, tells the screen
 * over Socket.IO as well (its WebSocket may already be gone, and the player must put its content
 * back either way), audits, and re-publishes the meeting-room code so the badge returns.
 */
function endSession(s, reason, by) {
  if (!s || s.ended) return;
  s.ended = true;
  for (const t of Object.values(s.timers)) { try { clearTimeout(t); clearInterval(t); } catch (_) {} }
  send(s.sharer, { type: 'ended', reason });
  send(s.device, { type: 'ended', reason });
  try { if (s.sharer) s.sharer.close(1000, 'ended'); } catch (_) {}
  try { if (s.device) s.device.close(1000, 'ended'); } catch (_) {}
  sessions.delete(s.id);
  const list = byDevice.get(s.deviceId);
  if (list) {
    const rest = list.filter((x) => x !== s && !x.ended);
    if (rest.length) byDevice.set(s.deviceId, rest); else byDevice.delete(s.deviceId);
  }
  if (deviceNs) { try { deviceNs.to(s.deviceId).emit('device:screenshare-stop', { session_id: s.id, reason }); } catch (_) {} }
  audit('screen_share.stop', {
    userId: (by && by.userId) || null, workspaceId: s.workspaceId, deviceId: s.deviceId, ip: (by && by.ip) || null,
    details: {
      session_id: s.id, reason, shared_by: s.sharedBy, guest: s.guest,
      seconds: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    },
  });
  const src = codeSource(s.deviceId);
  // A share that ran on a mirror alone (the display free, so it kept a code): fresh code now too.
  if (s.onMirrorAlone && !legsOn(src).length) dropCode(src);
  if (codes.has(src) || guestEnabled(src)) pushCode(s.deviceId);
  // A mirror leg that failed is not handed to the same presenter again until the mirror reconnects.
  if (s.roomKey !== s.deviceId && reason !== 'spotlight_changed' && roomState.has(s.roomKey)) {
    const st = roomState.get(s.roomKey);
    if (!st.gaveUp) st.gaveUp = new Map();
    if (!st.gaveUp.has(s.deviceId)) st.gaveUp.set(s.deviceId, new Set());
    st.gaveUp.get(s.deviceId).add(s.shareId);
  }
  roomChanged(s.roomKey);
}

// The oldest share on a screen (what a one-at-a-time screen shows), or null.
function sessionForDevice(deviceId) { return legsOn(deviceId)[0] || null; }

// What the dashboard may know about a running share. Never the ticket, the IP or the code.
function publicSession(s) {
  if (!s) return null;
  return {
    session_id: s.id, shared_by: s.sharedBy, guest: s.guest, audio: s.audio, live: s.live,
    started_at: s.startedAt || s.createdAt, max_seconds: maxSeconds(),
    // Multi share: which share this screen is part of, and how many screens it is on right now.
    // A display's mirrors (the same display link open somewhere else) ride along with it and are
    // counted apart, so a one-display share with its mirrors still reads as one screen to stop.
    share_id: s.shareId, ...shareCounts(s.shareId),
  };
}

// { screens, mirrors }: legs of a share, with mirrors of a display that is itself in the share
// counted apart.
function shareCounts(shareId) {
  const legs = sessionsForShare(shareId);
  const ids = new Set(legs.map((l) => l.deviceId));
  let mirrorLegs = 0;
  for (const l of legs) { const src = mirrorsLib().sourceOf(l.deviceId); if (src && ids.has(src)) mirrorLegs++; }
  return { screens: Math.max(1, legs.length - mirrorLegs), mirrors: mirrorLegs };
}

/*
 * Run `fn` with room bookkeeping held: ending a batch of legs one by one must not let fillScreen
 * hand a freed mirror to a presenter that is about to be ended too. Rooms touched meanwhile are
 * settled once, at the end.
 */
let holdDepth = 0;
const heldRooms = new Set();
function holdRooms(fn) {
  holdDepth++;
  try { return fn(); } finally {
    holdDepth--;
    if (!holdDepth) { const keys = [...heldRooms]; heldRooms.clear(); for (const k of keys) roomChanged(k); }
  }
}

// Every share on a screen (the owner's "stop all" on a mirror, the screen going offline).
function stopForDevice(deviceId, reason, by) {
  const legs = legsOn(deviceId);
  if (!legs.length) return false;
  holdRooms(() => { for (const s of legs) endSession(s, reason, by); });
  return true;
}

/*
 * The owner's "stop all" on a display: every presenter's leg on it AND their legs on its mirrors
 * (the room). The mirrors are that display shown somewhere else, so a share kicked off the display
 * must not keep playing on them. A different share running on a mirror alone is left alone. On a
 * mirror (which has no mirrors) this is stopForDevice.
 */
function stopForDisplay(deviceId, reason, by) {
  const all = [...new Set([...legsOn(deviceId), ...[...sessions.values()].filter((s) => !s.ended && s.roomKey === deviceId)])];
  if (!all.length) return false;
  holdRooms(() => { for (const s of all) endSession(s, reason, by); });
  return true;
}

// ------------------------------------------------------------------------------------------------
// Multi share: one person's screen on several screens at once
// ------------------------------------------------------------------------------------------------
/*
 * A multi share is N ordinary sessions — one per screen, each with its own single-use ticket, its
 * own sharer WebSocket and its own screen leg — that carry the same shareId. Nothing in the relay
 * changes: a screen authenticates exactly as before, and a leg can only ever talk to the one screen
 * its ticket was minted for (per-leg isolation is the relay's existing ticket ↔ session binding).
 * The sharer's browser keeps one capture and one RTCPeerConnection per screen.
 *
 * What the shareId adds: the owner can stop ALL screens of a share at once, the dashboard can say
 * "on 4 screens", and a screen that drops out ends only its own session — the others keep going.
 *
 * WHY A LIMIT (SCREEN_SHARE_MAX_TARGETS, default 6): every screen is a separate upload from the
 * sharer's computer, ~1-3 Mbit/s each for a screen. Beyond a handful a laptop on office Wi-Fi
 * cannot keep up and every screen degrades together. A whole floor of screens wants ONE upload to a
 * restreamer that fans out (the go2rtc sidecar live video uses) — not implemented here; see
 * docs/screen-share.md, "Sharing to many screens".
 */
function maxTargets() { return Math.max(1, Math.min(50, Number(config.screenShareMaxTargets) || 6)); }

function sessionsForShare(shareId) {
  if (!shareId) return [];
  return [...sessions.values()].filter((s) => s.shareId === shareId && !s.ended);
}

/*
 * The screens a share to `deviceIds` must reach, in order, without duplicates. Returns
 * [{ id, via }] where via is null for a screen that was asked for and 'mirror' for one added because
 * it mirrors one that was.
 *
 * Each requested screen's MIRRORS (lib/mirrors.js: the same display link open somewhere else) are
 * added after it, so sharing to a display also reaches the places it is showing. Every caller
 * treats a 'mirror' entry as best-effort (skipped, not refused, when the sharer cannot reach it).
 */
function expandShareTargets(deviceIds) {
  const out = [];
  const seen = new Set();
  const add = (id, via, of) => { const k = String(id || ''); if (k && !seen.has(k)) { seen.add(k); out.push(via ? { id: k, via, of } : { id: k, via }); } };
  for (const id of deviceIds || []) {
    add(id, null);
    const mirrors = mirrorsLib().mirrorsOf(id);
    // `of`: the display a mirror was added for — its room (several presenters) is that display's.
    for (const m of mirrors) add(m && m.id ? m.id : m, 'mirror', String(id));
  }
  return out;
}

/*
 * A share to ONE display (the dashboard's "Share my screen", a guest's meeting-room code): the
 * display itself, then each of its mirrors that can take it. The caller has already checked access
 * to and availability of the display. A mirror is best-effort: one in another workspace (cannot
 * happen through the socket, but a row could say so) or one `reachable(row)` refuses is left out
 * silently; one that cannot show a share right now (offline, no receiver, busy, past the target
 * limit) is listed in `skipped`. Neither ever refuses the share to the display. A mirror that cannot
 * tile and already shows another presenter of the display's room is skipped as 'single_presenter'.
 * returns { targets: [{ device, workspace, roomKey }], skipped: [{ id, name, ok, reason, platform, mirror }] }
 */
function withMirrors(device, workspace, { reachable } = {}) {
  const targets = [{ device, workspace, roomKey: device.id }];
  const skipped = [];
  for (const t of expandShareTargets([device.id])) {
    if (!t.via) continue;
    const m = db.prepare('SELECT * FROM devices WHERE id = ?').get(t.id);
    if (!m || m.workspace_id !== device.workspace_id) continue;
    if (reachable && !reachable(m)) continue;
    let a = availability(m, workspace, device.id);
    if (a.ok && targets.length >= maxTargets()) a = { ok: false, reason: 'too_many_targets' };
    if (!a.ok) {
      skipped.push({ id: m.id, name: m.name || '', ok: false, reason: a.reason, platform: playerCapabilities.platformFamily(m), mirror: true });
      continue;
    }
    targets.push({ device: m, workspace, roomKey: device.id });
  }
  return { targets, skipped };
}

/*
 * The answer to a one-display start (POST /api/screen-share/devices/:id and the guest join): the
 * display's own leg in the top-level fields every caller has always read, plus (additive) the share
 * id, every leg (the display first, then its mirrors) and the mirrors left out. A caller that only
 * knows the top-level ticket still shares to the display exactly as before; the mirror legs it never
 * opens expire unused after TICKET_TTL_MS.
 */
/*
 * Mint the share for a withMirrors() plan. A mirror that turned busy between the plan and now (a
 * race with someone else's start) costs only that mirror: the share goes ahead on the display alone.
 * returns { out: createShare's result, skipped }
 */
function createDisplayShare(plan, opts) {
  let out = createShare({ ...opts, targets: plan.targets });
  let skipped = plan.skipped;
  const display = plan.targets[0].device;
  if (out.error && out.device_id && out.device_id !== display.id && plan.targets.length > 1) {
    const rest = plan.targets.slice(1).map((t) => ({ id: t.device.id, name: t.device.name || '', ok: false, reason: 'busy', platform: playerCapabilities.platformFamily(t.device), mirror: true }));
    out = createShare({ ...opts, targets: [plan.targets[0]] });
    skipped = plan.skipped.concat(rest);
  }
  // "This screen shows one presenter at a time": told to the sharer on its own socket once it is up
  // (a guest included — it is the room they are standing in, not a list of the workspace's screens).
  if (!out.error) {
    const main = out.legs[0].session;
    for (const k of skipped) if (k.reason === 'single_presenter') main.notices.push({ type: 'leg_skipped', screen_name: k.name || '', reason: 'single_presenter' });
  }
  return { out, skipped };
}

function displayShareBody(out, skipped, guest) {
  const ice = guest ? guestIceServersFor : iceServersFor;
  const legs = out.legs.map((l) => ({
    device_id: l.device.id, screen_name: l.device.name || '', session_id: l.session.id,
    ticket: l.ticket, ice_servers: ice(l.device.id),
  }));
  const main = legs[0];
  return {
    session_id: main.session_id,
    ticket: main.ticket,
    ws_path: '/api/screen-share/ws',
    ice_servers: main.ice_servers,
    max_seconds: maxSeconds(),
    screen_name: main.screen_name,
    share_id: out.shareId,
    legs,
    skipped: skipped || [],
  };
}

/*
 * Mint one share across targets [{ device, workspace }] (already access-checked and available).
 * All or nothing: if any screen turned busy in between, nothing is left behind.
 * returns { shareId, legs: [{ session, ticket, device }] } or { error }
 */
function createShare(opts) {
  const targets = opts.targets || [];
  if (!targets.length) return { error: 'none_available' };
  if (targets.length > maxTargets()) return { error: 'too_many_targets' };
  const busy = targets.find((t) => {
    const key = t.roomKey || t.device.id;
    return key === t.device.id ? !roomHasSlot(t.device.id) : !!legRoomFor(t.device, key, null);
  });
  if (busy) return { error: 'busy', device_id: busy.device.id };
  // The share id is its FIRST leg's session id, so a share that reached one screen has the shape a
  // one-screen share always had (share_id === session_id), whether or not mirrors joined it.
  return holdRooms(() => {
    let shareId = null;
    const legs = [];
    for (const t of targets) {
      const out = createSession({ ...opts, device: t.device, workspace: t.workspace, roomKey: t.roomKey || t.device.id, shareId: shareId || undefined });
      if (!out.error && !shareId) shareId = out.session.id;
      if (out.error) {
        for (const l of legs) endSession(l.session, 'not_connected');
        return { error: out.error, device_id: t.device.id };
      }
      legs.push({ session: out.session, ticket: out.ticket, device: t.device });
    }
    return { shareId, legs };
  });
}

// Stop every screen of a share (the owner's "stop on all screens"). Returns how many were running.
function stopShare(shareId, reason, by) {
  const all = sessionsForShare(shareId);
  holdRooms(() => { for (const s of all) endSession(s, reason, by); });
  return all.length;
}

// The screen dropped off Socket.IO: its share cannot continue and its code means nothing now.
function deviceGone(deviceId) {
  stopForDevice(deviceId, 'screen_offline');
  if (codes.has(deviceId)) {
    dropCode(deviceId);
    // The code was this display's: its mirrors stop offering one nobody can use now.
    emitCode(mirrorsLib().mirrorsOf(deviceId).map((m) => m.id), { code: null });
  }
}

// A workspace switched the feature off: end everything running in it.
function stopWorkspace(workspaceId, reason, by) {
  holdRooms(() => { for (const s of [...sessions.values()]) if (s.workspaceId === workspaceId) endSession(s, reason, by); });
  try {
    for (const d of db.prepare('SELECT id FROM devices WHERE workspace_id = ?').all(workspaceId)) {
      if (codes.has(d.id)) { dropCode(d.id); pushCode(d.id); }
    }
  } catch (_) { /* best effort */ }
}

// ------------------------------------------------------------------------------------------------
// Meeting-room codes
// ------------------------------------------------------------------------------------------------

// Should this screen show a meeting-room code? The code switch, the workspace switch, and a player
// that can actually show a share — a code on a screen that would then refuse every guest is a trap.
function guestEnabled(deviceId) {
  if (!featureOn()) return false;
  try {
    const d = db.prepare(`SELECT d.*, w.screen_share_enabled AS ws_share
                          FROM devices d LEFT JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?`).get(deviceId);
    return !!(d && d.screen_share_guest && d.ws_share !== 0 && playerCapabilities.supports(d, CAP));
  } catch (_) { return false; }
}

function newCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}

// What a person typed -> canonical form. Case, spaces and dashes forgiven; Crockford look-alikes
// mapped (O->0, I/L->1). Anything else that is not in the alphabet makes it not a code.
function normaliseCode(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

function dropCode(deviceId) {
  const c = codes.get(deviceId);
  if (c) { codeIndex.delete(c.code); codes.delete(deviceId); }
}

function rotateCode(deviceId) {
  dropCode(deviceId);
  let code;
  do { code = newCode(); } while (codeIndex.has(code));
  const entry = { code, expiresAt: Date.now() + CODE_TTL_MS };
  codes.set(deviceId, entry);
  codeIndex.set(code, deviceId);
  return entry;
}

// The current code for a screen that should show one, minting or rotating as needed; null when the
// screen should show none (feature off, guest sharing off, offline, or a share is running).
function currentCode(deviceId) {
  if (!guestEnabled(deviceId) || !isOnline(deviceId) || !roomHasSlot(deviceId)) { dropCode(deviceId); return null; }
  const c = codes.get(deviceId);
  if (c && c.expiresAt > Date.now()) return c;
  return rotateCode(deviceId);
}

/*
 * Redeem a typed code. Returns the device id, or null. A redeemed code is spent: the screen gets a
 * fresh one immediately (pushCode), so a code photographed in a meeting is useless afterwards.
 */
function redeemCode(raw) {
  const code = normaliseCode(raw);
  if (!code) return null;
  const deviceId = codeIndex.get(code);
  if (!deviceId) return null;
  const c = codes.get(deviceId);
  if (!c || c.code !== code || c.expiresAt <= Date.now()) { dropCode(deviceId); return null; }
  dropCode(deviceId);
  return deviceId;
}

function formatCode(code) { return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null; }

function emitCode(ids, payload) {
  if (!deviceNs) return;
  for (const id of ids) { try { deviceNs.to(id).emit('device:screenshare-code', payload); } catch (_) {} }
}

// Whose code a screen shows: a mirror shows its display's (lib/mirrors.js); codes are keyed by
// the display only.
function codeSource(deviceId) { return mirrorsLib().sourceOf(deviceId) || deviceId; }

// A mirror shows its display's code unless it is busy with a share of its own, its player cannot
// show a share, or it is (impossibly) in another workspace than the display.
function mirrorShowsCode(mirrorId, srcWorkspaceId) {
  const src = codeSource(mirrorId);
  if (legsOn(mirrorId).some((l) => l.roomKey !== src)) return false;
  try {
    const m = db.prepare('SELECT * FROM devices WHERE id = ?').get(mirrorId);
    return !!(m && m.workspace_id && m.workspace_id === srcWorkspaceId && playerCapabilities.supports(m, CAP));
  } catch (_) { return false; }
}

/*
 * Tell a display AND every mirror of it what to show in the corner: the code, the address, and a QR
 * for `<address>?code=<code>`, so a phone that scans it lands on /share with the code filled in (and
 * the Android Manager app, which reads the same link, gets the server and the code from it). A query
 * string rather than the fragment: the app and the phone's camera both need to SEE the code in the
 * link. The cost is that a reverse proxy's access log may record it; this server logs no request
 * URLs, /share strips it from the address bar and sends no Referer, and the code is single-use and
 * dead within ten minutes anyway (docs/screen-share.md, "Abuse").
 * `deviceId` may be the display or one of its mirrors; either way the whole family is told.
 * The code is the display's: a guest standing at a mirror who types it presents to the display and
 * all its mirrors (routes/screen-share-guest.js), exactly as from the display itself.
 */
async function pushCode(deviceId) {
  if (!deviceNs) return;
  const src = codeSource(deviceId);
  const family = [src, ...mirrorsLib().mirrorsOf(src).map((m) => m.id)];
  const c = currentCode(src);
  if (!c) { emitCode(family, { code: null }); return; }
  let srcWs = null;
  try { const r = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(src); srcWs = r ? r.workspace_id : null; } catch (_) { /* no mirror shows it */ }
  if (!c.qrs) c.qrs = new Map();
  for (const id of family) {
    if (id !== src && !mirrorShowsCode(id, srcWs)) { emitCode([id], { code: null }); continue; }
    // Each screen's own address (the one people in ITS room are most likely to reach), else the display's.
    const origin = origins.get(id) || origins.get(src) || '';
    const url = origin ? `${origin}/share` : '/share';
    // Cached on the code entry per address: a web player re-registers every minute or so, and the
    // image only changes when the code (or the address) does.
    let qr = c.qrs.get(url) || null;
    if (origin && !qr) {
      try { qr = await require('qrcode').toDataURL(`${url}?code=${c.code}`, { margin: 1, width: 220, errorCorrectionLevel: 'M' }); } catch (_) { qr = null; }
      if (qr && c.qrs.size < 16) c.qrs.set(url, qr);
    }
    // Re-check after the await: the code may have rotated or been redeemed meanwhile.
    const now = codes.get(src);
    if (!now || now.code !== c.code) return;
    emitCode([id], { code: formatCode(c.code), url, qr, expires_at: c.expiresAt });
  }
}

/*
 * A player finished registering. Remember the origin it reached us on (the address people in the
 * same room are most likely to reach too) and tell it its code, if it should show one.
 */
function onDeviceRegistered(deviceId, handshake) {
  try {
    const { publicOrigin } = require('./public-origin');
    const h = (handshake && handshake.headers) || {};
    const fwd = String(h['x-forwarded-proto'] || '').split(',')[0].trim();
    const fakeReq = { get: (n) => h[String(n).toLowerCase()], protocol: (handshake && handshake.secure) || fwd === 'https' ? 'https' : 'http' };
    origins.set(deviceId, publicOrigin(fakeReq));
  } catch (_) { /* the badge can show the path alone */ }
  // A mirror that connects while its display is being shared to joins that share (before the code:
  // a screen in a share shows none).
  try { joinLiveShare(deviceId); } catch (_) { /* never block register */ }
  // A mirror shows its display's code from the moment it connects, not from the next rotation.
  const src = codeSource(deviceId);
  if (guestEnabled(src) || codes.has(src)) pushCode(deviceId);
}

/*
 * A MIRROR that connects (is created, or comes back after a drop) while its display is being shared
 * to joins: one more leg per presenter of the display's room (one, on a mirror that cannot tile),
 * minted here and handed to each sharer over a signalling socket that sharer already has open
 * ({type:'add_leg', leg}). The sharer's page (MultiShareSender) opens one more peer connection from
 * the same capture, and the new leg goes through the ordinary ticket handshake: nothing about the
 * relay changes.
 *
 * Who may be added is decided HERE and nowhere else: a screen whose lib/mirrors.js original is the
 * display of the room, in that display's workspace, that can take a share right now. The sharer
 * never names a screen — nothing it sends can add one. The target limit holds: a full share skips
 * the mirror and tells the sharer ({type:'leg_skipped'}).
 * Returns the first new session, or null.
 */
function joinLiveShare(deviceId) {
  const src = mirrorsLib().sourceOf(deviceId);
  if (!src) return null;
  const st = roomState.get(src);
  if (st && st.gaveUp) st.gaveUp.delete(deviceId);   // back again: worth another try
  return fillScreen(deviceId, src, true)[0] || null;
}

// The sharer socket a presenter's room messages and new legs go to: its leg on the display first.
function presenterSocket(p, roomKey) {
  const open = (l) => !l.ended && l.sharer && l.sharer.readyState === WebSocket.OPEN;
  return p.legs.find((l) => l.deviceId === roomKey && open(l)) || p.legs.find(open) || null;
}

// One more leg for presenter `p` of room `roomKey` on `mirror`, announced to the sharer. Or null.
function mintLeg(p, mirror, ws, roomKey) {
  const via = presenterSocket(p, roomKey);
  if (!via) return null;   // nobody to hand it to: a leg that could never be used
  const name = mirror.name || '';
  if (sessionsForShare(p.shareId).length >= maxTargets()) {
    send(via.sharer, { type: 'leg_skipped', screen_name: name, reason: 'too_many_targets', max_targets: maxTargets() });
    return null;
  }
  const out = createSession({
    device: mirror, workspace: ws, shareId: p.shareId, roomKey, sharedBy: via.sharedBy, userId: via.userId,
    guest: via.guest, ip: via.ip, audio: via.audio,
  });
  if (out.error) return null;
  const leg = { session_id: out.session.id, ticket: out.ticket, screen_name: name, ice_servers: (via.guest ? guestIceServersFor : iceServersFor)(mirror.id) };
  if (!via.guest) leg.device_id = mirror.id;   // a guest is told no device ids (routes/screen-share-guest.js)
  send(via.sharer, { type: 'add_leg', share_id: p.shareId, leg });
  return out.session;
}

/*
 * Make one of a display's mirrors show what the display's room should show. A mirror that can tile
 * gets every presenter it lacks (`all`: when it has just connected); one that cannot shows exactly
 * one — the spotlighted presenter, else the first — and is switched over when that changes (the old
 * leg ends with 'spotlight_changed', the new one is handed to its sharer). A presenter whose leg on
 * this mirror already failed is not retried until the mirror reconnects (gaveUp), so a mirror that
 * cannot connect to one laptop does not loop.
 */
const filling = new Set();
function fillScreen(mirrorId, roomKey, all) {
  const made = [];
  if (filling.has(mirrorId) || !featureOn() || !isOnline(mirrorId)) return made;
  const presenters = roomPresenters(roomKey);
  if (!presenters.length) return made;
  const mirror = deviceRow(mirrorId);
  const display = deviceRow(roomKey);
  if (!mirror || !display || !mirror.workspace_id || mirror.workspace_id !== display.workspace_id) return made;
  if (codeSource(mirrorId) !== roomKey) return made;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(mirror.workspace_id);
  if (!ws) return made;
  const legs = legsOn(mirrorId);
  if (legs.some((l) => l.roomKey !== roomKey)) return made;   // busy with a share of its own
  if (!workspaceOn(ws) || !playerCapabilities.supports(mirror, CAP)) {
    if (all && !legs.length) {
      for (const p of presenters) { const via = presenterSocket(p, roomKey); if (via) send(via.sharer, { type: 'leg_skipped', screen_name: mirror.name || '', reason: workspaceOn(ws) ? 'unsupported' : 'workspace_disabled' }); }
    }
    return made;
  }
  const st = roomState.get(roomKey);
  const gaveUp = (st && st.gaveUp && st.gaveUp.get(mirrorId)) || new Set();
  filling.add(mirrorId);
  try {
    if (canTile(mirror)) {
      if (!all) return made;
      for (const p of presenters) {
        if (legsOn(mirrorId).some((l) => l.shareId === p.shareId) || gaveUp.has(p.shareId)) continue;
        if (legsOn(mirrorId).length >= Math.min(MAX_TILES, slotsFor(roomKey))) break;
        const s = mintLeg(p, mirror, ws, roomKey);
        if (s) made.push(s);
      }
    } else {
      const want = (st && st.spotlight && presenters.find((p) => p.shareId === st.spotlight)) || presenters[0];
      if (legs.length === 1 && legs[0].shareId === want.shareId) return made;
      if (gaveUp.has(want.shareId) || !presenterSocket(want, roomKey)) return made;   // keep what is showing
      for (const l of legs) endSession(l, 'spotlight_changed');
      const s = mintLeg(want, mirror, ws, roomKey);
      if (s) made.push(s);
    }
  } finally { filling.delete(mirrorId); }
  return made;
}

/*
 * Something about a room changed (a presenter came or went, the spotlight moved). Settle it: drop a
 * spotlight on someone who left, put the right presenter on mirrors that cannot tile, tell every
 * screen of the room how to lay out its tiles and whose sound to play, and tell every presenter
 * who is in the room.
 */
function roomChanged(roomKey) {
  if (!roomKey) return;
  if (holdDepth) { heldRooms.add(roomKey); return; }
  let presenters = roomPresenters(roomKey);
  const st = roomState.get(roomKey);
  if (st && st.spotlight && !presenters.some((p) => p.shareId === st.spotlight)) st.spotlight = null;
  if (!presenters.length) {
    // The last presenter left: content again, and a code nobody in the meeting has seen (with
    // several presenters the old one may have been on screen the whole time).
    if (st) { roomState.delete(roomKey); if (codes.has(roomKey)) { dropCode(roomKey); pushCode(roomKey); } }
    return;
  }
  // Mirrors that cannot tile follow the spotlight / the first presenter (a mirror that can tile got
  // every presenter when they joined or when it connected: fillScreen leaves it alone here).
  let switched = false;
  for (const m of mirrorsLib().mirrorsOf(roomKey)) {
    try { if (fillScreen(m.id, roomKey, false).length) switched = true; } catch (_) { /* best effort */ }
  }
  if (switched) presenters = roomPresenters(roomKey);
  pushLayout(roomKey, presenters);
  pushRoom(roomKey, presenters);
}

/*
 * device:screenshare-layout {spotlight, audio} to each screen of a room, in THAT screen's session
 * ids: `spotlight` fills the screen (the others stay connected, hidden), `audio` is the one session
 * whose sound plays — the spotlighted presenter's if they share sound, else the most recent presenter
 * on that screen who does. A player that does not tile never gets a second session, so it may ignore
 * this event.
 */
function pushLayout(roomKey, presenters) {
  if (!deviceNs) return;
  const st = roomState.get(roomKey);
  const spot = st && st.spotlight;
  const screens = new Set();
  for (const p of presenters) for (const l of p.legs) screens.add(l.deviceId);
  for (const id of screens) {
    const legs = legsOn(id).filter((l) => l.roomKey === roomKey).sort((a, b) => a.createdAt - b.createdAt);
    const spotLeg = spot ? legs.find((l) => l.shareId === spot) || null : null;
    let audioLeg = spotLeg && spotLeg.audio ? spotLeg : null;
    if (!audioLeg) {
      // The most recent presenter to join with sound: order by when the PRESENTER joined the room.
      const joined = (l) => { const p = presenters.find((x) => x.shareId === l.shareId); return p ? p.joinedAt : l.createdAt; };
      const withSound = legs.filter((l) => l.audio).sort((a, b) => joined(a) - joined(b));
      audioLeg = withSound[withSound.length - 1] || null;
    }
    try { deviceNs.to(id).emit('device:screenshare-layout', { spotlight: spotLeg ? spotLeg.id : null, audio: audioLeg ? audioLeg.id : null, count: legs.length }); } catch (_) {}
  }
}

// A guest who typed no name, in a room: "Guest 1", "Guest 2"… — the first number not on screen now,
// so two nameless guests side by side can be told apart (and the owner can say which to remove).
function guestName(roomKey, base) {
  const taken = new Set(roomPresenters(roomKey).map((p) => p.sharedBy));
  for (let n = 1; n <= MAX_TILES + 1; n++) { const c = `${base || 'Guest'} ${n}`; if (!taken.has(c)) return c; }
  return base || 'Guest';
}

// An opaque id for a presenter (or a room) as the presenters' pages see it: never a session id.
function opaqueId(s) { return crypto.createHash('sha256').update('st-share:' + s).digest('base64url').slice(0, 16); }

/*
 * May this presenter control the room (spotlight, remove someone)? The FIRST presenter (the one in
 * the room longest) may, and so may a signed-in presenter who can still edit the screen's workspace
 * (they could stop anyone from the dashboard anyway). Any other guest may not.
 */
function canControl(p, roomKey, index) {
  if (index === 0) return true;
  if (p.guest || !p.userId) return false;
  return userCanEdit(p.userId, roomKey);
}

function userCanEdit(userId, deviceId) {
  try {
    const d = deviceRow(deviceId);
    const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    const ws = d && d.workspace_id ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(d.workspace_id) : null;
    if (!u || !ws) return false;
    const ctx = require('./tenancy').accessContext(u.id, u.role, ws);
    return !!(ctx && (ctx.actingAs || ctx.workspaceRole === 'workspace_admin' || ctx.workspaceRole === 'workspace_editor'));
  } catch (_) { return false; }
}

// {type:'room'} to each presenter's page: who is in the room, who is spotlighted, and whether this
// presenter may control it. Names only (what the screen shows anyway), never ids of anything else.
function pushRoom(roomKey, presenters) {
  const st = roomState.get(roomKey);
  const display = deviceRow(roomKey);
  const slots = slotsFor(roomKey);
  const list = presenters.map((p, i) => ({
    id: opaqueId(p.shareId), name: p.sharedBy, guest: p.guest, first: i === 0,
    spotlight: !!(st && st.spotlight === p.shareId), audio: p.audio,
  }));
  presenters.forEach((p, i) => {
    const via = presenterSocket(p, roomKey);
    if (!via) return;
    send(via.sharer, {
      type: 'room', room: opaqueId('room:' + roomKey), screen_name: (display && display.name) || '', slots,
      you: list[i].id, first: i === 0, can_control: canControl(p, roomKey, i),
      presenters: list.map((x) => ({ ...x, you: x.id === list[i].id })),
    });
  });
}

/*
 * The spotlight: one presenter fills the screen(s), the others stay connected but hidden. null
 * clears it (back to tiles). Returns false for a presenter not in the room.
 */
function setSpotlight(roomKey, shareId, by) {
  const presenters = roomPresenters(roomKey);
  const p = shareId ? presenters.find((x) => x.shareId === shareId) : null;
  if (shareId && !p) return false;
  if (!presenters.length) return false;
  if (!roomState.has(roomKey)) roomState.set(roomKey, { spotlight: null });
  roomState.get(roomKey).spotlight = p ? p.shareId : null;
  const d = deviceRow(roomKey);
  audit('screen_share.spotlight', {
    userId: (by && by.userId) || null, workspaceId: d ? d.workspace_id : null, deviceId: roomKey, ip: (by && by.ip) || null,
    details: { shared_by: p ? p.sharedBy : null, by: by && by.name ? by.name : undefined, by_presenter: !!(by && by.presenter) || undefined },
  });
  roomChanged(roomKey);
  return true;
}

/*
 * Take one presenter off a display and its mirrors (the owner's or the first presenter's "Remove").
 * Their page is told 'removed'. Their other screens (a multi share to other displays) carry on. The
 * code they joined with was spent when they joined, so it cannot bring them back.
 */
function removePresenter(roomKey, shareId, by) {
  const legs = [...sessions.values()].filter((s) => !s.ended && s.roomKey === roomKey && s.shareId === shareId);
  if (!legs.length) return 0;
  const d = deviceRow(roomKey);
  audit('screen_share.presenter_remove', {
    userId: (by && by.userId) || null, workspaceId: d ? d.workspace_id : null, deviceId: roomKey, ip: (by && by.ip) || null,
    details: { shared_by: legs[0].sharedBy, guest: legs[0].guest, by: by && by.name ? by.name : undefined, by_presenter: !!(by && by.presenter) || undefined },
  });
  holdRooms(() => { for (const s of legs) endSession(s, 'removed', by && by.presenter ? null : by); });
  return legs.length;
}

// What the dashboard shows of a room: [{ share_id, shared_by, guest, audio, started_at, first,
// spotlight, live }]. Never a ticket, an address or a code.
function publicPresenters(roomKey) {
  const st = roomState.get(roomKey);
  return roomPresenters(roomKey).map((p, i) => ({
    share_id: p.shareId, shared_by: p.sharedBy, guest: p.guest, audio: p.audio,
    started_at: Math.min(...p.legs.map((l) => l.startedAt || l.createdAt)), first: i === 0,
    spotlight: !!(st && st.spotlight === p.shareId), live: p.legs.some((l) => l.live),
  }));
}

// A control from a presenter's page ({type:'room', action, target}) on its signalling socket.
function roomControl(s, m) {
  const key = s.roomKey;
  const presenters = roomPresenters(key);
  const idx = presenters.findIndex((p) => p.shareId === s.shareId);
  if (idx < 0) return;
  const me = presenters[idx];
  if (!canControl(me, key, idx)) { send(s.sharer, { type: 'room_refused', reason: 'not_allowed' }); return; }
  const target = typeof m.target === 'string' ? presenters.find((p) => opaqueId(p.shareId) === m.target) : null;
  const by = { userId: me.userId, ip: me.ip, name: me.sharedBy, presenter: true };
  if (m.action === 'spotlight') {
    if (m.target != null && !target) return;
    setSpotlight(key, target ? target.shareId : null, by);
  } else if (m.action === 'remove') {
    if (!target || target.shareId === me.shareId) return;
    removePresenter(key, target.shareId, by);
  }
}

/*
 * Every 30s: rotate codes about to expire, so the TV never shows a dead one, and catch any screen
 * with the code switched on that is online here but holds none (it registered through a path that
 * did not call onDeviceRegistered, or an admin turned the workspace back on).
 */
function sweep() {
  if (!featureOn()) return;
  const now = Date.now();
  for (const [deviceId, c] of [...codes.entries()]) {
    if (c.expiresAt <= now + 1000) { rotateCode(deviceId); pushCode(deviceId); }
  }
  try {
    for (const d of db.prepare('SELECT id FROM devices WHERE screen_share_guest = 1').all()) {
      if (!codes.has(d.id) && roomHasSlot(d.id) && isOnline(d.id)) pushCode(d.id);
    }
  } catch (_) { /* the next sweep tries again */ }
}

// ------------------------------------------------------------------------------------------------
// The relay
// ------------------------------------------------------------------------------------------------

const SHARER_STATES = new Set(['connecting', 'connected', 'failed', 'disconnected']);
const DEVICE_STATES = new Set(['connecting', 'connected', 'playing', 'failed', 'disconnected', 'unsupported']);

function parse(data) {
  if (data == null) return null;
  const s = data.toString();
  if (s.length > MAX_SDP + 1024) return null;
  try { const m = JSON.parse(s); return m && typeof m === 'object' && !Array.isArray(m) ? m : null; } catch (_) { return null; }
}

// Rebuild a candidate from its validated fields. Returns null if it is not a plausible candidate.
function candidateMsg(m) {
  const value = m.value;
  if (typeof value !== 'string' || !value || value.length > MAX_CANDIDATE) return null;
  if (!/^(a=)?candidate:/.test(value)) return null;
  const out = { type: 'webrtc/candidate', value };
  if (typeof m.mid === 'string' && m.mid.length <= 32) out.mid = m.mid;
  if (Number.isInteger(m.mline) && m.mline >= 0 && m.mline < 16) out.mline = m.mline;
  return out;
}

function sdpOk(v) { return typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP && v.startsWith('v=0'); }

function keepAlive(ws, onDead) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const iv = setInterval(() => {
    if (!ws.isAlive) { clearInterval(iv); try { ws.terminate(); } catch (_) {} onDead(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }, PING_MS);
  unrefTimer(iv);
  return iv;
}

// The sharer's leg. First message must be {type:'auth', ticket}.
function onSharer(ws) {
  let s = null;
  const authTimer = setTimeout(() => { if (!s) { try { ws.close(4001, 'auth timeout'); } catch (_) {} } }, AUTH_MS);
  unrefTimer(authTimer);
  ws.on('message', (data) => {
    const m = parse(data);
    if (!m) return;
    if (!s) {
      if (m.type !== 'auth' || typeof m.ticket !== 'string' || m.ticket.length > 128) { try { ws.close(4001, 'unauthorized'); } catch (_) {} return; }
      const h = sha256(m.ticket);
      const found = [...sessions.values()].find((x) => !x.ended && !x.ticketUsed && crypto.timingSafeEqual(x.ticketHash, h));
      if (!found) { send(ws, { type: 'ended', reason: 'invalid_ticket' }); try { ws.close(4001, 'unauthorized'); } catch (_) {} return; }
      clearTimeout(authTimer);
      s = found;
      s.ticketUsed = true;
      s.sharer = ws;
      s.startedAt = Date.now();
      clearTimeout(s.timers.ticket);
      s.timers.max = setTimeout(() => endSession(s, 'max_duration'), maxSeconds() * 1000);
      unrefTimer(s.timers.max);
      s.timers.join = setTimeout(() => { if (!s.device) endSession(s, 'screen_unreachable'); }, DEVICE_JOIN_MS);
      unrefTimer(s.timers.join);
      s.timers.sharerPing = keepAlive(ws, () => endSession(s, 'sharer_left'));
      send(ws, { type: 'ready', session_id: s.id, max_seconds: maxSeconds() });
      if (!deviceNs || !isOnline(s.deviceId)) { endSession(s, 'screen_unreachable'); return; }
      deviceNs.to(s.deviceId).emit('device:screenshare-start', {
        session_id: s.id, shared_by: s.sharedBy, guest: s.guest, audio: s.audio,
        max_seconds: maxSeconds(), ice_servers: iceServersFor(s.deviceId),
      });
      for (const n of s.notices.splice(0)) send(ws, n);
      // The screen lays its tiles out (and picks whose sound plays) from the room; this presenter's
      // page learns who else is in it.
      roomChanged(s.roomKey);
      return;
    }
    if (s.ended) return;
    if (m.type === 'webrtc/answer') {
      if (s.answerSeen || !s.offerSeen || !sdpOk(m.value)) return;
      s.answerSeen = true;
      send(s.device, { type: 'webrtc/answer', value: m.value });
    } else if (m.type === 'webrtc/candidate') {
      if (++s.sharerCandidates > MAX_CANDIDATES_PER_LEG) return;
      const c = candidateMsg(m);
      if (!c) return;
      if (s.device) send(s.device, c); else if (s.pendingToDevice.length < MAX_CANDIDATES_PER_LEG) s.pendingToDevice.push(c);
    } else if (m.type === 'state') {
      if (!SHARER_STATES.has(m.value)) return;
      if (m.value === 'connected') s.live = true;
      if (m.value === 'failed') endSession(s, 'connection_failed');
    } else if (m.type === 'stop') {
      endSession(s, 'stopped_by_sharer');
    } else if (m.type === 'room') {
      // Spotlight / remove from a presenter's page. Bounded: a page has no reason to send many.
      if (++s.controls > 120) return;
      if (typeof m.action !== 'string' || (m.target != null && (typeof m.target !== 'string' || m.target.length > 64))) return;
      roomControl(s, m);
    }
  });
  ws.on('close', () => { clearTimeout(authTimer); if (s) endSession(s, 'sharer_left'); });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

// The screen's leg. First message must be {type:'auth', device_token, session_id}; the device id
// comes from the URL and must match both the token and the session.
function onDevice(ws, deviceId) {
  let s = null;
  const authTimer = setTimeout(() => { if (!s) { try { ws.close(4001, 'auth timeout'); } catch (_) {} } }, AUTH_MS);
  unrefTimer(authTimer);
  ws.on('message', (data) => {
    const m = parse(data);
    if (!m) return;
    if (!s) {
      if (m.type !== 'auth' || typeof m.device_token !== 'string' || typeof m.session_id !== 'string') { try { ws.close(4001, 'unauthorized'); } catch (_) {} return; }
      let valid = false;
      try { valid = require('../ws/deviceSocket').validateDeviceToken(deviceId, m.device_token); } catch (_) { valid = false; }
      const found = sessions.get(m.session_id);
      if (!valid || !found || found.ended || found.deviceId !== deviceId || !found.sharer || found.device) {
        send(ws, { type: 'ended', reason: 'invalid_session' });
        try { ws.close(4001, 'unauthorized'); } catch (_) {}
        return;
      }
      clearTimeout(authTimer);
      s = found;
      s.device = ws;
      clearTimeout(s.timers.join);
      s.timers.devicePing = keepAlive(ws, () => endSession(s, 'screen_left'));
      send(ws, { type: 'ready', session_id: s.id });
      send(s.sharer, { type: 'screen_joined' });
      return;
    }
    if (s.ended) return;
    if (m.type === 'webrtc/offer') {
      if (s.offerSeen || !sdpOk(m.value)) return;
      s.offerSeen = true;
      send(s.sharer, { type: 'webrtc/offer', value: m.value });
      for (const c of s.pendingToDevice.splice(0)) send(ws, c);
    } else if (m.type === 'webrtc/candidate') {
      if (++s.deviceCandidates > MAX_CANDIDATES_PER_LEG) return;
      const c = candidateMsg(m);
      if (c) send(s.sharer, c);
    } else if (m.type === 'state') {
      if (!DEVICE_STATES.has(m.value)) return;
      if (m.value === 'playing') { s.live = true; send(s.sharer, { type: 'screen_playing' }); }
      if (m.value === 'failed' || m.value === 'unsupported') endSession(s, m.value === 'unsupported' ? 'screen_unsupported' : 'connection_failed');
    }
  });
  ws.on('close', () => { clearTimeout(authTimer); if (s) endSession(s, 'screen_left'); });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

const SHARER_PATH = '/api/screen-share/ws';
const DEVICE_PATH_RE = /^\/api\/devices\/([0-9A-Za-z_-]{1,64})\/screen-share\/ws$/;

function reject(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch (_) {}
  try { socket.destroy(); } catch (_) {}
}

// Claim our two upgrade paths on the shared HTTP server; every other upgrade is left untouched.
function attach(server) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_SDP + 4096 });
  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (_) { return; }
    const isSharer = u.pathname === SHARER_PATH;
    const dm = isSharer ? null : DEVICE_PATH_RE.exec(u.pathname);
    if (!isSharer && !dm) return;
    if (!featureOn()) return reject(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isSharer) onSharer(ws);
      else onDevice(ws, dm[1]);
    });
  });
  return wss;
}

function init(io) {
  deviceNs = io ? io.of('/device') : null;
  if (!sweepTimer) { sweepTimer = setInterval(sweep, 30 * 1000); unrefTimer(sweepTimer); }
}

function _reset() {
  for (const s of [...sessions.values()]) { s.ended = true; for (const t of Object.values(s.timers)) { try { clearTimeout(t); clearInterval(t); } catch (_) {} } }
  sessions.clear(); byDevice.clear(); codes.clear(); codeIndex.clear(); origins.clear(); roomState.clear();
}

module.exports = {
  CAP, TILES_CAP, MAX_TILES, CODE_TTL_MS, TICKET_TTL_MS,
  init, attach,
  featureOn, workspaceOn, availability, isOnline, maxSeconds, iceServersFor, guestIceServersFor, cleanName,
  createSession, endSession, stopForDevice, stopForDisplay, stopWorkspace, sessionForDevice, publicSession, deviceGone,
  maxPresenters, multiOn, slotsFor, canTile, roomPresenters, roomHasSlot, publicPresenters, setSpotlight, removePresenter, opaqueId, guestName,
  maxTargets, expandShareTargets, withMirrors, createDisplayShare, displayShareBody, createShare, stopShare, sessionsForShare,
  guestEnabled, currentCode, rotateCode, redeemCode, normaliseCode, formatCode, pushCode, dropCode, onDeviceRegistered, codeSource, joinLiveShare,
  _reset, _sessions: sessions, _codes: codes, _sweep: sweep,
};
