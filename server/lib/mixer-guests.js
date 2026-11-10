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
 * Everything here is in memory: a restart of the server ends every visit, and the guests'
 * pages join again by themselves with the same link.
 */

const crypto = require('crypto');

const MAX_GUESTS = 6;                       // in one output's green room
const MAX_ON_AIR = 4;
const INVITE_MS = 12 * 3600 * 1000;
const GONE_MS = 20000;                      // a guest whose page has stopped asking is gone
const LAYOUTS = ['pip', 'side', 'grid'];

const invites = new Map();                  // token -> { outputId, workspaceId, until }
const byOutput = new Map();                 // outputId -> token
const guests = new Map();                   // id -> guest
const layouts = new Map();                  // outputId -> layout

const sdpOk = (v) => typeof v === 'string' && v.length <= 64 * 1024 && v.startsWith('v=0');
const cleanName = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function sweep(now = Date.now()) {
  for (const [t, inv] of invites) if (inv.until < now) revoke(inv.outputId);
  for (const [id, g] of guests) if (now - g.seenAt > GONE_MS) guests.delete(id);
}

/** The invite of an output: the one it has, or a new one. */
function invite(output, now = Date.now()) {
  sweep(now);
  const had = byOutput.get(output.id);
  if (had && invites.has(had)) return had;
  const token = crypto.randomBytes(32).toString('base64url');
  invites.set(token, { outputId: output.id, workspaceId: output.workspace_id, until: now + INVITE_MS });
  byOutput.set(output.id, token);
  return token;
}
/** Ends an output's invite and everyone who came in by it. */
function revoke(outputId) {
  const token = byOutput.get(outputId);
  if (token) invites.delete(token);
  byOutput.delete(outputId); layouts.delete(outputId);
  for (const [id, g] of guests) if (g.outputId === outputId) guests.delete(id);
}
const inviteOf = (outputId) => { const t = byOutput.get(outputId); return t && invites.has(t) ? t : null; };
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
  const g = { id: crypto.randomUUID(), key: crypto.randomBytes(24).toString('base64url'), outputId: inv.outputId, workspaceId: inv.workspaceId,
    name: cleanName(name) || `Guest ${of(inv.outputId).length + 1}`, offer: null, seq: 0, answer: null, answerSeq: 0, onAir: false,
    joinedAt: now, seenAt: now, thumb: null, state: 'new' };
  guests.set(g.id, g);
  return { guest: g };
}
/** The guest named by this token, id and key, or null. Marks them seen. */
function who(token, id, key, now = Date.now()) {
  const inv = invited(token, now), g = guests.get(String(id || ''));
  if (!inv || !g || g.outputId !== inv.outputId || !same(g.key, key)) return null;
  g.seenAt = now;
  return g;
}
function setOffer(g, sdp) {
  if (!sdpOk(sdp)) return false;
  g.offer = sdp; g.seq += 1; g.answer = null; g.state = 'connecting';
  return true;
}
/** What a guest's page is told about itself. */
function stateFor(g, studioRunning) {
  return { on_air: g.onAir, studio: !!studioRunning, need_offer: !g.offer, answer: g.answer && g.answerSeq === g.seq ? g.answer : null, seq: g.seq, name: g.name };
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
    const out = { id: g.id, name: g.name, on_air: g.onAir, seq: g.seq };
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
function fromRenderer(outputId, b) {
  const g = guests.get(String((b && b.guest_id) || ''));
  if (!g || g.outputId !== outputId) return false;
  if (b.answer !== undefined) { if (!sdpOk(b.answer) || Number(b.seq) !== g.seq) return false; g.answer = b.answer; g.answerSeq = g.seq; }
  if (typeof b.state === 'string' && /^[a-z]{1,16}$/.test(b.state)) g.state = b.state;
  if (typeof b.thumb === 'string' && b.thumb.length <= 60000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.thumb)) g.thumb = b.thumb;
  return true;
}

/** The green room as the operator sees it. */
function forDesk(outputId, now = Date.now()) {
  sweep(now);
  return { invite: inviteOf(outputId), layout: layouts.get(outputId) || 'pip', layouts: LAYOUTS, max_on_air: MAX_ON_AIR,
    guests: of(outputId).map((g) => ({ id: g.id, name: g.name, on_air: g.onAir, state: g.state, thumb: g.thumb, joined_at: g.joinedAt })) };
}
function setOnAir(outputId, id, on) {
  const g = guests.get(String(id || ''));
  if (!g || g.outputId !== outputId) return { status: 404, error: 'That guest has left.' };
  if (on && !g.onAir && of(outputId).filter((x) => x.onAir).length >= MAX_ON_AIR) return { status: 409, error: `At most ${MAX_ON_AIR} guests can be on air at once.` };
  g.onAir = !!on;
  return { ok: true };
}
function remove(outputId, id) { const g = guests.get(String(id || '')); if (!g || g.outputId !== outputId) return false; guests.delete(g.id); return true; }
function setLayout(outputId, layout) { if (!LAYOUTS.includes(layout)) return false; layouts.set(outputId, layout); return true; }
/** When an output's renderer stops, nobody is on air any more and every connection has to be made again. */
function rendererGone(outputId) { for (const g of of(outputId)) { g.onAir = false; g.offer = null; g.answer = null; g.thumb = null; g.state = 'waiting'; } }

module.exports = { MAX_GUESTS, MAX_ON_AIR, LAYOUTS, invite, revoke, inviteOf, invited, join, who, setOffer, stateFor, leave, forRenderer, fromRenderer, forDesk, setOnAir, remove, setLayout, rendererGone, sweep, _guests: guests };
