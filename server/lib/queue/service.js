'use strict';

/*
 * "Now serving" queues: the state and every change to it (docs/now-serving-queue.md).
 *
 * One row in `queues` is the whole live state of a queue. Customers take a number (a row in
 * queue_tickets), staff call the next one or a specific one, and the screens and phones poll a
 * small JSON answer. Everything here is synchronous better-sqlite3 inside transactions, so two staff
 * pressing Next at the same moment call two numbers, never the same one twice.
 *
 * ⚠️ THE DAY ROLLS OVER LAZILY. Nothing runs at midnight: whoever touches the queue first after the
 * queue's own local day has changed (a poll, a ticket, a Next) starts the new day, inside the same
 * transaction. A manual "start of day" does the same thing on demand. Either way `round` goes up,
 * numbers start again at 1, and tickets from earlier rounds are deleted.
 *
 * ⚠️ TWO CAPABILITIES, NEVER CONFUSED. public_token opens the customer page and can only take a
 * number and read the state. staff_token is the staff link: it can call numbers and start the day.
 * The staff link is sent as `<queue id>.<token>`, the row is found by id and the token compared in
 * constant time, so a wrong guess costs the same as a right one and the token is never a lookup key.
 */

const crypto = require('crypto');
const { isRealTimezone } = require('../device-timezone');

const EVENT_LIMIT = 20;
const MAX_PER_DAY_CAP = 9999;
const DEFAULT_MAX_PER_DAY = 999;
const EVENT_KINDS = new Set(['next', 'call', 'reset', 'new_day', 'sound_on', 'sound_off']);

const newToken = () => crypto.randomBytes(32).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

class QueueError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** The calendar date (YYYY-MM-DD) in `tz` at `nowMs`. */
function localDay(tz, nowMs = Date.now()) {
  const zone = isRealTimezone(tz) ? tz : 'UTC';
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs)).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/*
 * The zone a new queue's day is counted in. There is no workspace-wide timezone column on every
 * install (routes/schedules.js workspaceTz reads one only "where the column exists"), so: the zone
 * the person creating it asked for (the dashboard sends the browser's), else the workspace's, else
 * the zone of the workspace's oldest screen that reports one (the group/wall rule), else the
 * server's own. Stored on the queue and changeable, so it is never a guess at midnight.
 */
function resolveTimezone(db, workspaceId, asked) {
  if (isRealTimezone(asked)) return asked;
  try {
    const ws = db.prepare('SELECT timezone FROM workspaces WHERE id = ?').get(workspaceId);
    if (ws && isRealTimezone(ws.timezone) && ws.timezone !== 'UTC') return ws.timezone;
  } catch (_) { /* no such column on this install */ }
  try {
    const { effectiveDeviceTz } = require('../device-timezone');
    const d = db.prepare(`SELECT timezone, reported_timezone FROM devices
      WHERE workspace_id = ? AND COALESCE(NULLIF(timezone, 'UTC'), reported_timezone) IS NOT NULL
      ORDER BY created_at LIMIT 1`).get(workspaceId);
    const tz = effectiveDeviceTz(d);
    if (isRealTimezone(tz)) return tz;
  } catch (_) { /* no devices */ }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isRealTimezone(tz)) return tz;
  } catch (_) { /* fall through */ }
  return 'UTC';
}

function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return s;
}

function cleanMax(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(MAX_PER_DAY_CAP, Math.max(1, Math.floor(n)));
}

function load(db, id) {
  return db.prepare('SELECT * FROM queues WHERE id = ?').get(String(id || ''));
}

function logEvent(db, queueId, kind, number, source, nowMs) {
  if (!EVENT_KINDS.has(kind)) return;
  db.prepare('INSERT INTO queue_events (queue_id, at, kind, number, source) VALUES (?, ?, ?, ?, ?)')
    .run(queueId, nowMs, kind, number == null ? null : number, source === 'staff_link' ? 'staff_link' : (source === 'auto' ? 'auto' : 'dashboard'));
  // Keep the last EVENT_LIMIT per queue.
  db.prepare(`DELETE FROM queue_events WHERE queue_id = ? AND id NOT IN (
    SELECT id FROM queue_events WHERE queue_id = ? ORDER BY id DESC LIMIT ${EVENT_LIMIT})`).run(queueId, queueId);
}

/*
 * Start a new round: numbers restart at 1. `day` is the local day it belongs to. Old tickets go.
 * call_seq is NOT reset: it only ever goes up, so a widget can tell "a number was called" from
 * "the day started" (the first chimes, the second must not).
 */
function startRound(db, q, day, nowMs) {
  db.prepare(`UPDATE queues SET day = ?, round = round + 1, last_issued = 0, now_serving = 0, rev = rev + 1,
    updated_at = ? WHERE id = ?`).run(day, Math.floor(nowMs / 1000), q.id);
  db.prepare('DELETE FROM queue_tickets WHERE queue_id = ? AND round <= ?').run(q.id, q.round);
}

/** The queue as it is now, with the day rolled over first when the queue's local day has changed. */
function current(db, q, nowMs = Date.now()) {
  if (!q) return q;
  const today = localDay(q.timezone, nowMs);
  if (q.day === today) return q;
  return db.transaction(() => {
    const fresh = load(db, q.id);
    if (!fresh) return null;
    if (fresh.day !== today) {
      startRound(db, fresh, today, nowMs);
      logEvent(db, fresh.id, 'new_day', null, 'auto', nowMs);
    }
    return load(db, q.id);
  })();
}

function create(db, { workspaceId, name, timezone, maxPerDay, userId, nowMs = Date.now() }) {
  const id = crypto.randomUUID();
  const tz = resolveTimezone(db, workspaceId, timezone);
  db.prepare(`INSERT INTO queues (id, workspace_id, name, timezone, public_token, staff_token, day, max_per_day, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, cleanName(name) || 'Queue', tz, newToken(), newToken(), localDay(tz, nowMs),
      cleanMax(maxPerDay, DEFAULT_MAX_PER_DAY), userId || null);
  return load(db, id);
}

function update(db, q, { name, timezone, maxPerDay }, nowMs = Date.now()) {
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    const n = cleanName(name);
    if (!n) throw new QueueError(400, 'name', 'A queue needs a name');
    sets.push('name = ?'); vals.push(n);
  }
  if (timezone !== undefined) {
    if (!isRealTimezone(timezone)) throw new QueueError(400, 'timezone', 'Not a timezone this server knows (use a name like Europe/Lisbon)');
    sets.push('timezone = ?'); vals.push(timezone);
  }
  if (maxPerDay !== undefined) { sets.push('max_per_day = ?'); vals.push(cleanMax(maxPerDay, q.max_per_day)); }
  if (!sets.length) return q;
  db.prepare(`UPDATE queues SET ${sets.join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ?`).run(...vals, Math.floor(nowMs / 1000), q.id);
  // A changed zone can mean a changed local day: apply it now rather than at the next poll.
  return current(db, load(db, q.id), nowMs);
}

/*
 * Take a number. Idempotent for a browser-made `clientId`: the same id in the same round gets the
 * same number back, so scanning twice, a double tap or a retried request never takes a second one.
 */
function takeTicket(db, q, { clientId, nowMs = Date.now() } = {}) {
  const cid = typeof clientId === 'string' && CLIENT_ID_RE.test(clientId) ? clientId : null;
  return db.transaction(() => {
    const live = current(db, load(db, q.id), nowMs);
    if (!live) throw new QueueError(404, 'not_found', 'This queue no longer exists');
    if (cid) {
      const had = db.prepare('SELECT number FROM queue_tickets WHERE queue_id = ? AND round = ? AND client_id = ?').get(live.id, live.round, cid);
      if (had) return { queue: live, number: had.number, existing: true };
    }
    if (live.last_issued >= live.max_per_day) {
      throw new QueueError(409, 'full', `No more numbers today: this queue hands out at most ${live.max_per_day} a day. Please ask a member of staff.`);
    }
    const number = live.last_issued + 1;
    db.prepare('UPDATE queues SET last_issued = ?, rev = rev + 1 WHERE id = ?').run(number, live.id);
    db.prepare('INSERT INTO queue_tickets (queue_id, round, number, client_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(live.id, live.round, number, cid, nowMs);
    return { queue: load(db, live.id), number, existing: false };
  })();
}

/** Call the next number. Refused when nobody is waiting. */
function next(db, q, { source, nowMs = Date.now() } = {}) {
  return db.transaction(() => {
    const live = current(db, load(db, q.id), nowMs);
    if (!live) throw new QueueError(404, 'not_found', 'This queue no longer exists');
    if (live.now_serving >= live.last_issued) throw new QueueError(409, 'empty', 'Nobody is waiting');
    const n = live.now_serving + 1;
    db.prepare('UPDATE queues SET now_serving = ?, call_seq = call_seq + 1, rev = rev + 1 WHERE id = ?').run(n, live.id);
    logEvent(db, live.id, 'next', n, source, nowMs);
    return load(db, live.id);
  })();
}

/*
 * Call a specific number: skip ahead, call back an earlier one, or call the current one again.
 * Any number handed out today (1..last issued).
 */
function call(db, q, number, { source, nowMs = Date.now() } = {}) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw new QueueError(400, 'number', 'Choose a number of 1 or more');
  return db.transaction(() => {
    const live = current(db, load(db, q.id), nowMs);
    if (!live) throw new QueueError(404, 'not_found', 'This queue no longer exists');
    if (n > live.last_issued) {
      throw new QueueError(409, 'not_issued', live.last_issued
        ? `Number ${n} has not been handed out yet today (the last one was ${live.last_issued})`
        : 'No numbers have been handed out yet today');
    }
    db.prepare('UPDATE queues SET now_serving = ?, call_seq = call_seq + 1, rev = rev + 1 WHERE id = ?').run(n, live.id);
    logEvent(db, live.id, 'call', n, source, nowMs);
    return load(db, live.id);
  })();
}

/** Start of day (the manual reset): numbers restart at 1 now. */
function reset(db, q, { source, nowMs = Date.now() } = {}) {
  return db.transaction(() => {
    const live = current(db, load(db, q.id), nowMs);
    if (!live) throw new QueueError(404, 'not_found', 'This queue no longer exists');
    startRound(db, live, localDay(live.timezone, nowMs), nowMs);
    logEvent(db, live.id, 'reset', null, source, nowMs);
    return load(db, live.id);
  })();
}

/** The staff sound switch. A widget chimes only when this is on AND its own chime is on. */
function setSound(db, q, on, { source, nowMs = Date.now() } = {}) {
  const v = on ? 1 : 0;
  return db.transaction(() => {
    const live = current(db, load(db, q.id), nowMs);
    if (!live) throw new QueueError(404, 'not_found', 'This queue no longer exists');
    if (live.sound_on !== v) {
      db.prepare('UPDATE queues SET sound_on = ?, rev = rev + 1 WHERE id = ?').run(v, live.id);
      logEvent(db, live.id, v ? 'sound_on' : 'sound_off', null, source, nowMs);
    }
    return load(db, live.id);
  })();
}

function rotateStaff(db, q) {
  db.prepare('UPDATE queues SET staff_token = ? WHERE id = ?').run(newToken(), q.id);
  return load(db, q.id);
}
function revokeStaff(db, q) {
  db.prepare('UPDATE queues SET staff_token = NULL WHERE id = ?').run(q.id);
  return load(db, q.id);
}
function rotatePublic(db, q) {
  db.prepare('UPDATE queues SET public_token = ?, rev = rev + 1 WHERE id = ?').run(newToken(), q.id);
  return load(db, q.id);
}

function events(db, queueId) {
  return db.prepare('SELECT at, kind, number, source FROM queue_events WHERE queue_id = ? ORDER BY id DESC LIMIT ?')
    .all(queueId, EVENT_LIMIT);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/*
 * The queue a staff link names, or null. `key` is "<queue id>.<token>". The row is found by its id;
 * the token is compared as two SHA-256 digests with timingSafeEqual (equal length by construction),
 * so the comparison takes the same time whatever the guess.
 */
function byStaffKey(db, key) {
  if (typeof key !== 'string' || key.length > 200) return null;
  const dot = key.lastIndexOf('.');
  if (dot < 1) return null;
  const id = key.slice(0, dot);
  const token = key.slice(dot + 1);
  if (!TOKEN_RE.test(token)) return null;
  const q = load(db, id);
  const stored = q && q.staff_token ? q.staff_token : newToken();   // compare against something either way
  const ok = crypto.timingSafeEqual(sha(stored), sha(token));
  return ok && q && q.staff_token ? q : null;
}

function byPublicToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return db.prepare('SELECT * FROM queues WHERE public_token = ?').get(token) || null;
}

/** A compact revision string: changes whenever anything a screen or phone shows changes. */
const revOf = (q) => `${q.round}.${q.rev}`;

/* What a widget, a phone and staff see. None of these carries a token. */
function widgetState(q) {
  return { rev: revOf(q), name: q.name, now_serving: q.now_serving, call_seq: q.call_seq, sound: !!q.sound_on,
    waiting: Math.max(0, q.last_issued - q.now_serving) };
}
function customerState(q) {
  return { rev: revOf(q), name: q.name, day: q.day, round: q.round, now_serving: q.now_serving, last_issued: q.last_issued };
}
function staffState(db, q) {
  return { rev: revOf(q), id: q.id, name: q.name, day: q.day, round: q.round, timezone: q.timezone,
    now_serving: q.now_serving, last_issued: q.last_issued, waiting: Math.max(0, q.last_issued - q.now_serving),
    max_per_day: q.max_per_day, sound_on: !!q.sound_on, events: events(db, q.id) };
}

/*
 * "About X ahead of you" for the customer page, as a pure function so it is tested on its own and
 * shared with the page (frontend/js/queue-page.js mirrors it). Never negative: once the number is
 * called or passed the answer is a status, not a count.
 */
function aheadOf(ticket, nowServing) {
  const t = Number(ticket);
  const s = Number(nowServing) || 0;
  if (!Number.isInteger(t) || t < 1) return { status: 'none', ahead: 0 };
  if (s === t) return { status: 'called', ahead: 0 };
  if (s > t) return { status: 'passed', ahead: 0 };
  // The numbers still to be called before theirs (the one being served is not counted: it has
  // been called). 0 means they are next.
  const ahead = Math.max(0, t - s - 1);
  return { status: ahead ? 'waiting' : 'next', ahead };
}

module.exports = {
  QueueError, localDay, resolveTimezone, current, create, update, takeTicket, next, call, reset, setSound,
  rotateStaff, revokeStaff, rotatePublic, events, byStaffKey, byPublicToken, revOf, load,
  widgetState, customerState, staffState, aheadOf, newToken,
  EVENT_LIMIT, MAX_PER_DAY_CAP, DEFAULT_MAX_PER_DAY,
};
