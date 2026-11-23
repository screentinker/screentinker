'use strict';

/*
 * Curbside pickup: the state and every change to it (docs/curbside-pickup.md).
 *
 * A location is a car park with labelled spots. Each spot has a QR code; the customer opens it, types
 * an order number (and an optional short note such as the colour of the car) and taps "I'm here". That
 * is a row in curbside_arrivals. Staff see the open arrivals oldest first, press "We got you" (the
 * customer's page and the screens say the order is on the way) and "Done". Standalone: there is no POS
 * and no name field anywhere, only an order number, a spot and the optional note.
 *
 * Built the same way as "Now serving" (lib/queue/service.js), and reusing its day and token helpers:
 *
 * ⚠️ ONE OPEN ARRIVAL PER SPOT, enforced by the database (partial unique index idx_curbside_open_spot
 * on status waiting/seen), so two phones tapping at the same moment get one check-in and one "this
 * spot is taken", never two cars on one spot.
 *
 * ⚠️ THE DAY ROLLS OVER LAZILY, like a queue: nothing runs at midnight. The first call that touches the
 * location after its own local day changed expires the arrivals still open (status 'expired') and
 * deletes arrivals older than 7 days, in the same transaction. A daily sweep (purgeOld) deletes the
 * old rows of locations nobody touched.
 *
 * ⚠️ TWO CAPABILITIES, NEVER CONFUSED. public_token opens the customer page and can only check in,
 * cancel the check-in this browser made, and read the state. staff_token is the staff link,
 * "<location id>.<token>", found by id and compared in constant time (never a lookup key).
 *
 * The customer's browser makes a random client id and keeps it; it goes in a header, never a URL. It
 * is how "open the page again on the same phone" finds the same check-in, and the only thing that
 * can cancel it.
 */

const crypto = require('crypto');
const { isRealTimezone } = require('../device-timezone');
const { localDay, resolveTimezone, newToken } = require('../queue/service');
const texts = require('./texts');

const PURGE_DAYS = 7;
// At most this many OPEN check-ins per network address per location, so one phone rotating client ids
// cannot fill every spot. Counted by a keyed hash of the address (ip_key), cleared when a check-in closes.
const OPEN_PER_IP = 2;
const MAX_SPOTS = 200;
const SPOT_MAX = 12;
const ORDER_MAX = 20;
const NOTE_MAX = 80;
const NAME_MAX = 80;
const OPEN = ['waiting', 'seen'];

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
// An order number: letters and digits, with the separators receipts use. Starts with a letter or a
// digit (or "#", as in "#1234").
const ORDER_RE = /^#?[\p{L}\p{N}][\p{L}\p{N} #._/-]*$/u;

class CurbsideError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const nowSec = (ms) => Math.floor(ms / 1000);
const oneLine = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

function cleanName(v) { return oneLine(v).slice(0, NAME_MAX); }

function cleanSpotLabel(v) { return oneLine(v).slice(0, SPOT_MAX); }

/**
 * The spot list from what the dashboard sent: `spots` (an array of labels, or one string with a label
 * per line or comma) or `count` (1..N). Labels are trimmed, capped at 12 characters and unique
 * (ignoring case). Throws on an empty or oversized list.
 */
function cleanSpots(spots, count) {
  let list;
  if (count !== undefined && count !== null && count !== '') {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SPOTS) throw new CurbsideError(400, 'spots', `Choose between 1 and ${MAX_SPOTS} spots`);
    list = Array.from({ length: n }, (_, i) => String(i + 1));
  } else {
    const raw = Array.isArray(spots) ? spots : (typeof spots === 'string' ? spots.split(/[\n,]/) : []);
    if (raw.length > MAX_SPOTS * 2) throw new CurbsideError(400, 'spots', `At most ${MAX_SPOTS} spots`);
    const seen = new Set();
    list = [];
    for (const r of raw) {
      if (typeof r !== 'string' && typeof r !== 'number') continue;
      const l = cleanSpotLabel(r);
      if (!l || seen.has(l.toLowerCase())) continue;
      seen.add(l.toLowerCase());
      list.push(l);
    }
  }
  if (!list.length) throw new CurbsideError(400, 'spots', 'A location needs at least one spot');
  if (list.length > MAX_SPOTS) throw new CurbsideError(400, 'spots', `At most ${MAX_SPOTS} spots`);
  return list;
}

function spotsOf(loc) {
  try { const s = JSON.parse(loc.spots || '[]'); return Array.isArray(s) ? s.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
const overridesOf = (loc) => texts.parseStored(loc.texts);

/** The spot label as stored, for what a URL or a request asked (exact first, then ignoring case). */
function findSpot(loc, asked) {
  if (typeof asked !== 'string' && typeof asked !== 'number') return null;
  const a = cleanSpotLabel(asked);
  if (!a) return null;
  const list = spotsOf(loc);
  return list.find((s) => s === a) || list.find((s) => s.toLowerCase() === a.toLowerCase()) || null;
}

function cleanOrder(v) {
  const s = oneLine(v);
  if (!s) throw new CurbsideError(400, 'order', 'Type your order number');
  if (s.length > ORDER_MAX) throw new CurbsideError(400, 'order', `An order number is at most ${ORDER_MAX} characters`);
  if (!ORDER_RE.test(s)) throw new CurbsideError(400, 'order', 'An order number can only have letters, digits, spaces and # . _ / -');
  return s;
}

function cleanNote(v) {
  const s = oneLine(v);
  if (s.length > NOTE_MAX) throw new CurbsideError(400, 'note', `The note is at most ${NOTE_MAX} characters`);
  return s || null;
}

const validClient = (v) => (typeof v === 'string' && CLIENT_ID_RE.test(v) ? v : null);

function load(db, id) {
  return db.prepare('SELECT * FROM curbside_locations WHERE id = ?').get(String(id || ''));
}

// Every change a screen or phone shows bumps rev; an acknowledgement or an arrival also bumps its counter.
const BUMP_SQL = {
  plain: 'UPDATE curbside_locations SET rev = rev + 1, updated_at = ? WHERE id = ?',
  ack: 'UPDATE curbside_locations SET rev = rev + 1, ack_seq = ack_seq + 1, updated_at = ? WHERE id = ?',
  arrive: 'UPDATE curbside_locations SET rev = rev + 1, arrive_seq = arrive_seq + 1, updated_at = ? WHERE id = ?',
};
function bump(db, id, nowMs, kind = 'plain') {
  db.prepare(BUMP_SQL[kind] || BUMP_SQL.plain).run(nowSec(nowMs), id);
}

/** Delete this location's arrivals older than PURGE_DAYS (every location: purgeOld below). */
function purgeLocation(db, locationId, nowMs) {
  return db.prepare('DELETE FROM curbside_arrivals WHERE location_id = ? AND created_at < ?')
    .run(locationId, nowMs - PURGE_DAYS * 86400000).changes;
}

/** The location as it is now, with the day rolled over first when its local day has changed. */
function current(db, loc, nowMs = Date.now()) {
  if (!loc) return loc;
  const today = localDay(loc.timezone, nowMs);
  if (loc.day === today) return loc;
  return db.transaction(() => {
    const fresh = load(db, loc.id);
    if (!fresh) return null;
    if (fresh.day !== today) {
      db.prepare(`UPDATE curbside_arrivals SET status = 'expired', done_at = ?, ip_key = NULL WHERE location_id = ? AND status IN ('waiting', 'seen') AND day <> ?`)
        .run(nowMs, fresh.id, today);
      purgeLocation(db, fresh.id, nowMs);
      db.prepare('UPDATE curbside_locations SET day = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(today, nowSec(nowMs), fresh.id);
    }
    return load(db, loc.id);
  })();
}

function create(db, { workspaceId, name, timezone, spots, spotsCount, userId, nowMs = Date.now() }) {
  // Nothing said about spots (missing, null or a blank string, as an empty form field sends) means 1..10.
  const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
  const list = blank(spots) && blank(spotsCount) ? cleanSpots(undefined, 10) : cleanSpots(blank(spots) ? undefined : spots, blank(spotsCount) ? undefined : spotsCount);
  const id = crypto.randomUUID();
  const tz = resolveTimezone(db, workspaceId, timezone);
  db.prepare(`INSERT INTO curbside_locations (id, workspace_id, name, timezone, spots, texts, public_token, staff_token, day, created_by)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`)
    .run(id, workspaceId, cleanName(name) || 'Curbside', tz, JSON.stringify(list), newToken(), newToken(), localDay(tz, nowMs), userId || null);
  return load(db, id);
}

/*
 * ⚠️ A NEW TIMEZONE IS NOT A NEW DAY. The location's `day` is recomputed in the new zone in the same
 * transaction, and today's open arrivals move to it, so changing Chicago to Tokyo (where it may
 * already be tomorrow) never makes current() see a rollover and expire the cars waiting outside.
 */
function update(db, loc, { name, timezone, spots, spotsCount, texts: t }, nowMs = Date.now()) {
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    const n = cleanName(name);
    if (!n) throw new CurbsideError(400, 'name', 'A location needs a name');
    sets.push('name = ?'); vals.push(n);
  }
  if (timezone !== undefined && !isRealTimezone(timezone)) {
    throw new CurbsideError(400, 'timezone', 'Not a timezone this server knows (use a name like Europe/Lisbon)');
  }
  if (spots !== undefined || (spotsCount !== undefined && spotsCount !== null && spotsCount !== '')) {
    sets.push('spots = ?'); vals.push(JSON.stringify(cleanSpots(spots, spotsCount)));
  }
  if (t !== undefined) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new CurbsideError(400, 'texts', 'texts must be an object');
    sets.push('texts = ?'); vals.push(JSON.stringify(texts.cleanOverrides(t)));
  }
  if (!sets.length && timezone === undefined) return loc;
  return db.transaction(() => {
    // Any real rollover in the OLD zone happens first, exactly as it would have on the next poll.
    const live = current(db, load(db, loc.id), nowMs);
    if (!live) throw new CurbsideError(404, 'not_found', 'This location no longer exists');
    if (timezone !== undefined) {
      sets.push('timezone = ?'); vals.push(timezone);
      const newDay = localDay(timezone, nowMs);
      if (newDay !== live.day) {
        sets.push('day = ?'); vals.push(newDay);
        db.prepare(`UPDATE curbside_arrivals SET day = ? WHERE location_id = ? AND day = ? AND status IN ('waiting', 'seen')`)
          .run(newDay, live.id, live.day);
      }
    }
    db.prepare(`UPDATE curbside_locations SET ${sets.join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ?`).run(...vals, nowSec(nowMs), live.id);
    return current(db, load(db, live.id), nowMs);
  })();
}

const ARRIVAL_COLS = 'id, spot, order_ref, note, status, created_at, ack_at, done_at, cancelled';

function openArrivals(db, loc) {
  return db.prepare(`SELECT ${ARRIVAL_COLS} FROM curbside_arrivals WHERE location_id = ? AND day = ? AND status IN ('waiting', 'seen')
    ORDER BY created_at, id`).all(loc.id, loc.day);
}

/** The newest check-in this browser made today (any status but expired), or null. */
function clientArrival(db, loc, clientId) {
  const cid = validClient(clientId);
  if (!cid) return null;
  return db.prepare(`SELECT ${ARRIVAL_COLS} FROM curbside_arrivals WHERE location_id = ? AND client_id = ? AND day = ? AND status <> 'expired'
    ORDER BY id DESC LIMIT 1`).get(loc.id, cid, loc.day) || null;
}

function spotTaken(db, loc, spot) {
  return !!db.prepare(`SELECT 1 FROM curbside_arrivals WHERE location_id = ? AND spot = ? AND status IN ('waiting', 'seen')`).get(loc.id, spot);
}

/*
 * "I'm here". Idempotent for the browser's client id: while this browser has an open check-in, asking
 * again returns it (whatever spot was asked), so a double tap, a retry or a second scan never makes a
 * second one. A spot with someone else's open check-in is refused with code 'spot_taken'.
 */
function checkIn(db, loc, { spot, orderRef, note, clientId, ipKey = null, nowMs = Date.now() } = {}) {
  const cid = validClient(clientId);
  if (!cid) throw new CurbsideError(400, 'client', 'Please reload the page and try again');
  return db.transaction(() => {
    const live = current(db, load(db, loc.id), nowMs);
    if (!live) throw new CurbsideError(404, 'not_found', 'This curbside link is not active');
    const mine = clientArrival(db, live, cid);
    if (mine && OPEN.includes(mine.status)) return { location: live, arrival: mine, existing: true };
    const label = findSpot(live, spot);
    if (!label) throw new CurbsideError(400, 'spot', 'Choose your parking spot');
    const order = cleanOrder(orderRef);
    const n = cleanNote(note);
    if (spotTaken(db, live, label)) throw new CurbsideError(409, 'spot_taken', 'This spot is taken');
    const ipk = typeof ipKey === 'string' && ipKey ? ipKey.slice(0, 64) : null;
    if (ipk) {
      const open = db.prepare(`SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ? AND ip_key = ? AND status IN ('waiting', 'seen')`).get(live.id, ipk).n;
      if (open >= OPEN_PER_IP) {
        throw new CurbsideError(429, 'open_limit', `This network already has ${OPEN_PER_IP} cars checked in here. Please come inside or ask a member of staff.`);
      }
    }
    let id;
    try {
      id = db.prepare(`INSERT INTO curbside_arrivals (location_id, day, spot, order_ref, note, status, client_id, created_at, ip_key)
        VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`).run(live.id, live.day, label, order, n, cid, nowMs, ipk).lastInsertRowid;
    } catch (e) {
      if (e && /UNIQUE/.test(String(e.code || e.message))) throw new CurbsideError(409, 'spot_taken', 'This spot is taken');
      throw e;
    }
    bump(db, live.id, nowMs, 'arrive');
    const arrival = db.prepare(`SELECT ${ARRIVAL_COLS} FROM curbside_arrivals WHERE id = ?`).get(id);
    return { location: load(db, live.id), arrival, existing: false };
  })();
}

/** The customer cancels the check-in this browser made. Only an open one; nothing else is touched. */
function cancel(db, loc, { clientId, nowMs = Date.now() } = {}) {
  const cid = validClient(clientId);
  return db.transaction(() => {
    const live = current(db, load(db, loc.id), nowMs);
    if (!live) throw new CurbsideError(404, 'not_found', 'This curbside link is not active');
    const mine = cid ? clientArrival(db, live, cid) : null;
    if (!mine || !OPEN.includes(mine.status)) throw new CurbsideError(404, 'none', 'There is no check-in to cancel');
    db.prepare(`UPDATE curbside_arrivals SET status = 'cancelled', cancelled = 1, done_at = ?, ip_key = NULL WHERE id = ?`).run(nowMs, mine.id);
    bump(db, live.id, nowMs);
    return { location: load(db, live.id), arrival: db.prepare(`SELECT ${ARRIVAL_COLS} FROM curbside_arrivals WHERE id = ?`).get(mine.id) };
  })();
}

function staffArrival(db, live, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new CurbsideError(400, 'id', 'Which arrival?');
  const a = db.prepare(`SELECT ${ARRIVAL_COLS} FROM curbside_arrivals WHERE id = ? AND location_id = ?`).get(n, live.id);
  if (!a) throw new CurbsideError(404, 'gone', 'That car is no longer on the list');
  return a;
}

/** "We got you": the customer's page and the screens now say the order is on the way. */
function acknowledge(db, loc, id, { nowMs = Date.now() } = {}) {
  return db.transaction(() => {
    const live = current(db, load(db, loc.id), nowMs);
    if (!live) throw new CurbsideError(404, 'not_found', 'This location no longer exists');
    const a = staffArrival(db, live, id);
    if (a.status === 'seen') return load(db, live.id);
    if (a.status !== 'waiting') throw new CurbsideError(409, 'closed', 'That car is no longer on the list');
    db.prepare(`UPDATE curbside_arrivals SET status = 'seen', ack_at = ? WHERE id = ?`).run(nowMs, a.id);
    bump(db, live.id, nowMs, 'ack');
    return load(db, live.id);
  })();
}

/** "Done": the car leaves the list; the customer's page says thank you. */
function done(db, loc, id, { nowMs = Date.now() } = {}) {
  return db.transaction(() => {
    const live = current(db, load(db, loc.id), nowMs);
    if (!live) throw new CurbsideError(404, 'not_found', 'This location no longer exists');
    const a = staffArrival(db, live, id);
    if (a.status === 'done') return load(db, live.id);
    if (!OPEN.includes(a.status)) throw new CurbsideError(409, 'closed', 'That car is no longer on the list');
    db.prepare(`UPDATE curbside_arrivals SET status = 'done', done_at = ?, ip_key = NULL WHERE id = ?`).run(nowMs, a.id);
    bump(db, live.id, nowMs);
    return load(db, live.id);
  })();
}

function rotateStaff(db, loc) {
  db.prepare('UPDATE curbside_locations SET staff_token = ? WHERE id = ?').run(newToken(), loc.id);
  return load(db, loc.id);
}
function revokeStaff(db, loc) {
  db.prepare('UPDATE curbside_locations SET staff_token = NULL WHERE id = ?').run(loc.id);
  return load(db, loc.id);
}
function rotatePublic(db, loc) {
  db.prepare('UPDATE curbside_locations SET public_token = ?, rev = rev + 1 WHERE id = ?').run(newToken(), loc.id);
  return load(db, loc.id);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/*
 * The location a staff link names, or null. `key` is "<location id>.<token>". Found by id; the token is
 * compared as two SHA-256 digests with timingSafeEqual (equal length by construction), so a wrong
 * guess costs the same as a right one.
 */
function byStaffKey(db, key) {
  if (typeof key !== 'string' || key.length > 200) return null;
  const dot = key.lastIndexOf('.');
  if (dot < 1) return null;
  const id = key.slice(0, dot);
  const token = key.slice(dot + 1);
  if (!TOKEN_RE.test(token)) return null;
  const loc = load(db, id);
  const stored = loc && loc.staff_token ? loc.staff_token : newToken();   // compare against something either way
  const ok = crypto.timingSafeEqual(sha(stored), sha(token));
  return ok && loc && loc.staff_token ? loc : null;
}

function byPublicToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return db.prepare('SELECT * FROM curbside_locations WHERE public_token = ?').get(token) || null;
}

const revOf = (loc) => String(loc.rev);

const customerArrival = (a) => (a ? { spot: a.spot, order_ref: a.order_ref, note: a.note || '', status: a.status, created_at: a.created_at } : null);

/* What a widget, a phone and staff see. None of these carries a token or a client id. */
function widgetState(db, loc) {
  return {
    rev: revOf(loc), name: loc.name, ack_seq: loc.ack_seq, arrive_seq: loc.arrive_seq,
    labels: texts.widgetTexts(overridesOf(loc)),
    // Order number, spot and status only: the note is for staff, never on a screen.
    arrivals: openArrivals(db, loc).map((a) => ({ order_ref: a.order_ref, spot: a.spot, status: a.status })),
  };
}

/** The customer page: the location, the spot it was opened for, and this browser's own check-in. */
function customerState(db, loc, { spot, clientId } = {}) {
  const label = findSpot(loc, spot);
  const mine = clientArrival(db, loc, clientId);
  return {
    rev: revOf(loc), name: loc.name, day: loc.day,
    spot: label, spots: spotsOf(loc),
    spot_taken: !!(label && spotTaken(db, loc, label) && !(mine && OPEN.includes(mine.status) && mine.spot === label)),
    texts: texts.customerTexts(overridesOf(loc)),
    arrival: customerArrival(mine),
  };
}

function staffState(db, loc, nowMs = Date.now()) {
  const doneToday = db.prepare(`SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ? AND day = ? AND status = 'done'`).get(loc.id, loc.day).n;
  return {
    rev: revOf(loc), id: loc.id, name: loc.name, day: loc.day, timezone: loc.timezone, now: nowMs,
    spots: spotsOf(loc), done_today: doneToday,
    arrivals: openArrivals(db, loc).map((a) => ({ id: a.id, spot: a.spot, order_ref: a.order_ref, note: a.note || '', status: a.status, created_at: a.created_at, ack_at: a.ack_at })),
  };
}

/*
 * The daily sweep (server.js): arrivals older than PURGE_DAYS, for this server's own workspaces only.
 * A workspace copied from another node is the primary's to clean (its rows arrive by replication).
 */
function purgeOld(db, nowMs = Date.now()) {
  return db.prepare(`DELETE FROM curbside_arrivals WHERE created_at < ? AND location_id IN (
    SELECT l.id FROM curbside_locations l JOIN workspaces w ON w.id = l.workspace_id WHERE w.origin_node_id IS NULL)`)
    .run(nowMs - PURGE_DAYS * 86400000).changes;
}

module.exports = {
  CurbsideError, current, create, update, checkIn, cancel, acknowledge, done,
  rotateStaff, revokeStaff, rotatePublic, byStaffKey, byPublicToken, revOf, load,
  widgetState, customerState, staffState, openArrivals, clientArrival, purgeOld,
  spotsOf, overridesOf, findSpot, cleanSpots, cleanOrder, cleanNote, localDay, newToken,
  PURGE_DAYS, OPEN_PER_IP, MAX_SPOTS, SPOT_MAX, ORDER_MAX, NOTE_MAX,
};
