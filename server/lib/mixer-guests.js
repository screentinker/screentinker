'use strict';

/*
 * GUESTS of a stream output: someone opens a link, lets the browser use their camera and
 * microphone, and can be put on air in the stream.
 *
 * Who talks to whom. The guest's browser and this server's renderer (the headless browser that
 * draws the stream, lib/stream-out.js) connect to each other directly over WebRTC. This server
 * only passes the two session descriptions between them: the guest's offer and the renderer's
 * answer, each sent once, complete with its network candidates. Nothing of the picture or sound
 * passes through this process.
 *
 *   the operator    asks for an invite link for one output (routes/stream-out.js, signed in)
 *   the guest       GET /guest/<token>, then join -> offer -> poll for the answer and their state
 *   the renderer    sees the guests in its feed (it is addressed by the output's feed secret),
 *                   answers each, shows the ones that are on air, and sends a thumbnail back
 *
 * A guest who has joined is BACKSTAGE: connected, seen by the operator as a thumbnail, heard and
 * seen by no one else. The operator puts them on air and takes them off.
 *
 * What a guest holds: the invite token (in the link) and, once joined, a key of their own. With
 * those they can send their own offer, read their own state, and leave. They learn nothing about
 * the workspace, the output's destination, or the other guests.
 *
 * THE OPERATOR'S OWN VIEW. The desk shows each guest as moving picture, not through the renderer:
 * the guest's browser makes one more connection, straight to each open desk (at most MAX_DESKS),
 * with a smaller picture. It is signalled the same way: the guest offers, the desk answers, this
 * server passes the two descriptions. A desk is a signed-in operator's page; it names itself with
 * a random id on every poll and is forgotten a few seconds after it stops asking. A desk sees
 * guests whether or not the stream is running, so the operator can greet people before standby.
 *
 * Everything here is in memory: a restart of the server ends every visit, and the guests'
 * pages join again by themselves with the same link.
 */

const crypto = require('crypto');

const MAX_GUESTS = 6;                       // in one output's green room
const MAX_ON_AIR = 4;
const INVITE_MS = 12 * 3600 * 1000;
// A guest whose page has stopped asking is gone. Long on purpose: a phone that locks, changes
// network or has its timers slowed in a background tab must not lose its place (or its place on air).
const GONE_MS = 120000;
const OFFER_GAP_MS = 1500;                  // a guest's offers, no closer together than this
const REMOVED_MS = 15 * 60 * 1000;          // how long a removed guest is remembered as removed
const LAYOUTS = ['pip', 'side', 'grid'];
const MAX_DESKS = 2;                        // desks one guest sends a picture to
// A desk in a background tab asks less often (the browser slows its timers): 30 s is well over that.
const DESK_GONE_MS = 30000;
const MAX_LEVEL = 1.5;                       // a guest's fader goes as high as the console's other strips

const invites = new Map();                  // token -> { outputId, workspaceId, until } (+ personal: { id, name, used } for a link for one person)
const byOutput = new Map();                 // outputId -> the room's token (the link anyone may use)
const MAX_PERSONAL = 12;
const PERSONAL_IDLE_MS = 10000;             // a guest page asks every second or two: ten silent seconds is a lost page
const guests = new Map();                   // id -> guest
const layouts = new Map();                  // outputId -> layout
const hush = new Map();                     // outputId -> until when its (stopping) renderer is not listened to
const removed = new Map();                  // guest id -> when the operator removed them
// Where invites are kept so a restart of the server does not end them: { save(outputId, token, until), drop(outputId),
// savePersonal(outputId, [{ id, token, name, until }]) }.
let store = null;
const desks = new Map();                    // outputId -> Map(deskId -> last seen)
const deskOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v);

const sdpOk = (v) => typeof v === 'string' && v.length <= 64 * 1024 && v.startsWith('v=0');
const cleanName = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function sweep(now = Date.now()) {
  // An invite past its time lets nobody new in (invited()); it ends, with its green room, only once that room is empty.
  for (const [token, inv] of [...invites]) {
    if (inv.until >= now) continue;
    // A personal link past its time goes once its guest has gone; the room's link ends its room once that is empty.
    if (inv.personal) { if (!(inv.personal.used && guests.has(inv.personal.used))) dropPersonal(inv.outputId, token); }
    else if (!of(inv.outputId).length) { if (personalOf(inv.outputId).length) dropRoomLink(inv.outputId); else revoke(inv.outputId); }
  }
  for (const [id, at] of removed) if (now - at > REMOVED_MS) removed.delete(id);
  for (const [id, g] of guests) if (now - g.seenAt > GONE_MS) guests.delete(id);
  for (const [out, m] of desks) { for (const [d, at] of m) if (now - at > DESK_GONE_MS) m.delete(d); if (!m.size) desks.delete(out); }
  for (const g of guests.values()) { const m = desks.get(g.outputId); for (const d of g.legs.keys()) if (!m || !m.has(d)) g.legs.delete(d); }
}
/** A desk is looking at this output's green room. Returns whether it is one of the desks guests send to. */
function deskSeen(outputId, deskId, now = Date.now()) {
  if (!deskOk(deskId)) return false;
  let m = desks.get(outputId);
  if (!m) { m = new Map(); desks.set(outputId, m); }
  if (!m.has(deskId) && m.size >= MAX_DESKS) return false;
  m.set(deskId, now);
  return true;
}
const desksOf = (outputId) => [...(desks.get(outputId) || new Map()).keys()];

/** The invite of an output: the one it has, or a new one. */
function invite(output, now = Date.now()) {
  sweep(now);
  const had = byOutput.get(output.id);
  // Asking again gives the same link, good for another full period.
  if (had && invites.has(had)) { const inv = invites.get(had); inv.until = now + INVITE_MS; if (store) store.save(output.id, had, inv.until); return had; }
  const token = crypto.randomBytes(32).toString('base64url');
  invites.set(token, { outputId: output.id, workspaceId: output.workspace_id, until: now + INVITE_MS });
  byOutput.set(output.id, token);
  if (store) store.save(output.id, token, now + INVITE_MS);
  return token;
}
/** Invites kept from before a restart: [{ outputId, workspaceId, token, until }]. `keep` is where changes are saved from now on. */
function restore(rows, keep, now = Date.now()) {
  store = keep || null;
  for (const r of rows || []) {
    // Personal links of this output, kept as a list.
    for (const p of Array.isArray(r && r.personal) ? r.personal.slice(0, MAX_PERSONAL) : []) {
      if (p && typeof p.token === 'string' && p.token.length >= 40 && p.until > now && typeof p.id === 'string' && !invites.has(p.token)) invites.set(p.token, { outputId: r.outputId, workspaceId: r.workspaceId, until: p.until, personal: { id: p.id, name: cleanName(p.name), used: null } });
    }
    if (!r || typeof r.token !== 'string' || r.token.length < 40 || !(r.until > now) || byOutput.has(r.outputId)) continue;
    invites.set(r.token, { outputId: r.outputId, workspaceId: r.workspaceId, until: r.until });
    byOutput.set(r.outputId, r.token);
  }
}
/** Ends an output's invites (the room's and every personal one) and everyone who came in. */
function revoke(outputId) {
  const token = byOutput.get(outputId);
  if (token) invites.delete(token);
  if (token && store) store.drop(outputId);
  for (const [tk, inv] of [...invites]) if (inv.personal && inv.outputId === outputId) invites.delete(tk);
  if (store && store.savePersonal) store.savePersonal(outputId, []);
  byOutput.delete(outputId); layouts.delete(outputId); desks.delete(outputId);
  for (const [id, g] of guests) if (g.outputId === outputId) guests.delete(id);
}
const inviteOf = (outputId) => { const t = byOutput.get(outputId); return t && invites.has(t) ? t : null; };
/** The room's own link ends; personal links (and whoever came in by them) stay. */
function dropRoomLink(outputId) { const token = byOutput.get(outputId); if (token) invites.delete(token); if (store) store.drop(outputId); byOutput.delete(outputId); }
/*
 * PERSONAL LINKS. A link for one person, by name: one guest at a time comes in by it (they can come back by it after
 * losing the page), and removing that guest ends the link, so Remove keeps them out. The room's link is still there
 * for a quick "anyone with this link"; a show that wants to know who comes in uses these.
 */
const personalOf = (outputId) => [...invites].filter(([, inv]) => inv.personal && inv.outputId === outputId);
const savePersonal = (outputId) => { if (store && store.savePersonal) store.savePersonal(outputId, personalOf(outputId).map(([token, inv]) => ({ id: inv.personal.id, token, name: inv.personal.name, until: inv.until }))); };
function personal(output, name, now = Date.now()) {
  sweep(now);
  const n = cleanName(name);
  if (!n) return { status: 400, error: 'A personal link is for someone: give their name.' };
  if (personalOf(output.id).length >= MAX_PERSONAL) return { status: 409, error: `A stream has at most ${MAX_PERSONAL} personal links. Cancel one first.` };
  const token = crypto.randomBytes(32).toString('base64url');
  invites.set(token, { outputId: output.id, workspaceId: output.workspace_id, until: now + INVITE_MS, personal: { id: crypto.randomBytes(6).toString('hex'), name: n, used: null } });
  savePersonal(output.id);
  return { token, id: invites.get(token).personal.id };
}
function dropPersonal(outputId, token) { const inv = invites.get(token); if (!inv || !inv.personal || inv.outputId !== outputId) return false; invites.delete(token); savePersonal(outputId); return true; }
/** Cancels a personal link (by its id); its guest, if they are here, leaves with it. */
function cancelPersonal(outputId, pid) {
  const hit = personalOf(outputId).find(([, inv]) => inv.personal.id === pid);
  if (!hit) return false;
  const [token, inv] = hit;
  if (inv.personal.used) { const g = guests.get(inv.personal.used); if (g) { guests.delete(g.id); removed.set(g.id, Date.now()); } }
  return dropPersonal(outputId, token);
}
/** Whether anyone can come in to this output's green room: by its link or a personal one. */
const open = (outputId) => !!inviteOf(outputId) || personalOf(outputId).length > 0;
function invited(token, now = Date.now()) {
  const inv = typeof token === 'string' && token.length >= 40 ? invites.get(token) : null;
  return inv && inv.until >= now ? inv : null;
}
const of = (outputId) => [...guests.values()].filter((g) => g.outputId === outputId).sort((a, b) => a.joinedAt - b.joinedAt);

/** A guest comes in. Returns { guest } or { error, status }. */
function join(token, name, now = Date.now()) {
  sweep(now);
  const inv = invited(token, now);
  if (!inv) return { status: 404, error: 'This invitation is no longer open. Ask for a new link.' };
  if (of(inv.outputId).length >= MAX_GUESTS) return { status: 409, error: 'The green room is full.' };
  // A personal link: one person at a time. Whoever is in by it and has not been heard from for a few seconds (their page
  // closed, their phone slept, their network dropped) has lost it: the person coming back by it takes their place.
  if (inv.personal && inv.personal.used && guests.has(inv.personal.used)) {
    const was = guests.get(inv.personal.used);
    if (now - was.seenAt < PERSONAL_IDLE_MS) return { status: 409, error: 'This link is for one person, and they are already in. Ask the studio for a link of your own.' };
    guests.delete(was.id);
  }
  const g = { id: crypto.randomUUID(), key: crypto.randomBytes(24).toString('base64url'), outputId: inv.outputId, workspaceId: inv.workspaceId,
    name: cleanName(name) || (inv.personal && inv.personal.name) || `Guest ${of(inv.outputId).length + 1}`, via: token, offer: null, seq: 0, answer: null, answerSeq: 0, onAir: false,
    joinedAt: now, seenAt: now, thumb: null, state: 'new', legs: new Map(), green: false, cut: null, level: 1,
    // Their strip on the stream's sound console (lib/stream-audio.js): fader and mute above; the processing
    // the operator gave them (null: as new guests start); whether they hear the show (a mix without their own voice).
    muted: false, strip: null, hear: true };
  guests.set(g.id, g);
  if (inv.personal) inv.personal.used = g.id;
  return { guest: g };
}
/** The guest named by this token, id and key, or null. Marks them seen. */
function who(token, id, key, now = Date.now()) {
  // Someone already inside stays inside when the invite runs out: the time limit is on coming in.
  const inv = typeof token === 'string' ? invites.get(token) : null, g = guests.get(String(id || ''));
  if (!inv || !g || g.outputId !== inv.outputId || !same(g.key, key)) return null;
  g.seenAt = now;
  return g;
}
/** Whether this guest may make an offer now: a page gone wrong must not have the renderer rebuild connections without pause. */
function mayOffer(g, now = Date.now()) { if (now - (g.offerAt || 0) < OFFER_GAP_MS) return false; g.offerAt = now; return true; }
function setOffer(g, sdp) {
  if (!sdpOk(sdp)) return false;
  // The still on the desk belongs to the connection that is being replaced.
  g.offer = sdp; g.seq += 1; g.answer = null; g.state = 'connecting'; g.thumb = null;
  return true;
}
/** What a guest's page is told about itself. */
function stateFor(g, studioRunning) {
  return { on_air: g.onAir, studio: !!studioRunning, need_offer: !g.offer, answer: g.answer && g.answerSeq === g.seq ? g.answer : null, seq: g.seq, name: g.name,
    // The desks to send a picture to: an opaque id each, and where that connection stands.
    desks: desksOf(g.outputId).map((id) => { const leg = g.legs.get(id); return { id, seq: leg ? leg.seq : 0, need_offer: !leg || !leg.offer, answer: leg && leg.answer && leg.answerSeq === leg.seq ? leg.answer : null }; }) };
}
/** The guest's offer to one desk. */
function setDeskOffer(g, deskId, sdp, now = Date.now()) {
  if (!sdpOk(sdp) || !desksOf(g.outputId).includes(deskId)) return null;
  const leg = g.legs.get(deskId) || { seq: 0, at: 0 };
  if (now - leg.at < OFFER_GAP_MS) return null;
  leg.at = now;
  leg.offer = sdp; leg.seq += 1; leg.answer = null; leg.answerSeq = 0;
  g.legs.set(deskId, leg);
  return leg.seq;
}
/** A desk's answer to a guest's offer, or (again) its request for a new offer after its connection failed. */
function fromDesk(outputId, guestId, deskId, b) {
  const g = guests.get(String(guestId || ''));
  if (!g || g.outputId !== outputId || !desksOf(outputId).includes(deskId)) return false;
  const leg = g.legs.get(deskId);
  if (b && b.again === true) { if (leg) { leg.offer = null; leg.answer = null; } return true; }
  if (!leg || !leg.offer || !sdpOk(b && b.answer) || Number(b.seq) !== leg.seq) return false;
  leg.answer = b.answer; leg.answerSeq = leg.seq;
  return true;
}
function leave(g) { guests.delete(g.id); }

/**
 * What the renderer is told: who is here, who is on air, and the offer of anyone it does not
 * hold a connection for yet. `have` is what it does hold, as "id:seq" pairs.
 */
function forRenderer(outputId, have, now = Date.now()) {
  sweep(now);
  const held = new Map(String(have || '').split(',').map((p) => p.split(':')).filter((p) => p.length === 2).map(([id, seq]) => [id, Number(seq)]));
  const list = of(outputId).map((g) => {
    const out = { id: g.id, name: g.name, on_air: g.onAir, seq: g.seq, cut: cutOf(g), level: g.level };
    if (g.offer && held.get(g.id) !== g.seq) {
      // An offer that was already answered (by a renderer that has since gone) cannot be answered again: the guest makes a new one.
      if (g.answer && g.answerSeq === g.seq) { g.offer = null; g.answer = null; g.state = 'connecting'; }
      else out.offer = g.offer;
    }
    return out;
  });
  return { layout: layouts.get(outputId) || 'pip', list };
}
/** From the renderer: its answer to a guest, how the connection is, a thumbnail of their picture. */
function fromRenderer(outputId, b, now = Date.now()) {
  // A renderer that is being stopped may still be posting: what it says in its last seconds is not kept.
  if ((hush.get(outputId) || 0) > now) return false;
  const g = guests.get(String((b && b.guest_id) || ''));
  if (!g || g.outputId !== outputId) return false;
  if (b.answer !== undefined) { if (!sdpOk(b.answer) || Number(b.seq) !== g.seq) return false; g.answer = b.answer; g.answerSeq = g.seq; }
  if (typeof b.state === 'string' && /^[a-z]{1,16}$/.test(b.state)) g.state = b.state;
  if (typeof b.thumb === 'string' && b.thumb.length <= 60000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.thumb)) g.thumb = b.thumb;
  return true;
}

/** The green room as the operator sees it. */
function forDesk(outputId, now = Date.now(), deskId = null) {
  sweep(now);
  const live = deskId != null && open(outputId) ? deskSeen(outputId, deskId, now) : false;
  const tok = inviteOf(outputId);
  return { invite: tok, expires_at: tok ? invites.get(tok).until : null,
    personal: personalOf(outputId).map(([token, inv]) => ({ id: inv.personal.id, name: inv.personal.name, token, until: inv.until, here: !!(inv.personal.used && guests.has(inv.personal.used)) })),
    layout: layouts.get(outputId) || 'pip', layouts: LAYOUTS, max_on_air: MAX_ON_AIR, live,
    guests: of(outputId).map((g) => {
      const out = { id: g.id, name: g.name, on_air: g.onAir, state: g.state, thumb: g.thumb, joined_at: g.joinedAt, personal: !!(g.via && invites.get(g.via) && invites.get(g.via).personal), green: g.green, cut: cutOf(g), level: g.level, muted: g.muted, hear: g.hear, strip: g.strip };
      // This desk's own connection to the guest: the offer to answer, until it has been answered.
      const leg = live ? g.legs.get(deskId) : null;
      if (leg && leg.offer) { out.leg_seq = leg.seq; if (!(leg.answer && leg.answerSeq === leg.seq)) out.leg_offer = leg.offer; }
      return out;
    }) };
}
function setOnAir(outputId, id, on) {
  const g = guests.get(String(id || ''));
  if (!g || g.outputId !== outputId) return { status: 404, error: 'That guest has left.' };
  if (on && !g.onAir && of(outputId).filter((x) => x.onAir).length >= MAX_ON_AIR) return { status: 409, error: `At most ${MAX_ON_AIR} guests can be on air at once.` };
  g.onAir = !!on;
  return { ok: true };
}
/*
 * CUT OUT: a guest shown without their background. The guest's picture arrives with the
 * background painted green (their page did it, "Remove my background", or they stand in front of a
 * real green screen) and the renderer keys the green out. It follows what the guest's page says it
 * is sending, until the operator chooses otherwise for that guest.
 */
const cutOf = (g) => (g.cut == null ? !!g.green : !!g.cut);
function setGreen(g, on) { g.green = on === true; }
/** How loud this guest is in the stream, 0 (silent) to 1 (as they arrive). Each guest has their own. */
function setLevel(outputId, id, level) { const g = guests.get(String(id || '')); const v = Number(level); if (!g || g.outputId !== outputId || !Number.isFinite(v)) return false; g.level = Math.max(0, Math.min(MAX_LEVEL, Math.round(v * 100) / 100)); return true; }
const mineOf = (outputId, id) => { const g = guests.get(String(id || '')); return g && g.outputId === outputId ? g : null; };
function setMuted(outputId, id, on) { const g = mineOf(outputId, id); if (!g) return false; g.muted = on === true; return true; }
function setHear(outputId, id, on) { const g = mineOf(outputId, id); if (!g) return false; g.hear = on === true; return true; }
/** The processing of a guest's strip (EQ, compressor, ...), as the console's strips take it; null puts back what new guests get. */
function setStrip(outputId, id, set) { const g = mineOf(outputId, id); if (!g || (set !== null && (typeof set !== 'object' || Array.isArray(set)))) return false; g.strip = set; return true; }
function setCut(outputId, id, on) { const g = guests.get(String(id || '')); if (!g || g.outputId !== outputId) return false; g.cut = on === true; return true; }
function remove(outputId, id, now = Date.now()) {
  const g = guests.get(String(id || '')); if (!g || g.outputId !== outputId) return false;
  guests.delete(g.id); removed.set(g.id, now);
  // Came in by a link of their own: it ends with them, so they cannot come straight back.
  const inv = g.via ? invites.get(g.via) : null; if (inv && inv.personal) dropPersonal(outputId, g.via);
  return true;
}
/** Whether the operator removed this guest (as opposed to the server having lost track of them). */
const wasRemoved = (id) => removed.has(String(id || ''));
function setLayout(outputId, layout) { if (!LAYOUTS.includes(layout)) return false; layouts.set(outputId, layout); return true; }
/** When an output's renderer stops, nobody is on air any more and every connection has to be made again. */
/** A new renderer for the output is starting (the old one is closed by then): it is listened to at once. */
function rendererBack(outputId) { hush.delete(outputId); }
function rendererGone(outputId, now = Date.now()) { hush.set(outputId, now + 5000); for (const g of of(outputId)) { g.onAir = false; g.offer = null; g.answer = null; g.thumb = null; g.state = 'waiting'; g.seq += 1; } }

module.exports = { MAX_GUESTS, MAX_ON_AIR, MAX_DESKS, LAYOUTS, deskSeen, setDeskOffer, fromDesk, restore, mayOffer, wasRemoved, sdpOk, setGreen, setCut, setLevel, invite, revoke, inviteOf, open, personal, cancelPersonal, MAX_PERSONAL, invited, join, who, setOffer, stateFor, leave, forRenderer, fromRenderer, forDesk, setOnAir, remove, setLayout, rendererGone, rendererBack, sweep, setMuted, setHear, setStrip, list: (outputId) => of(outputId), _guests: guests };
