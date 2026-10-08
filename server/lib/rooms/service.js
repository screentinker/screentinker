'use strict';

/*
 * Meeting-room displays: the calendar cache, what a panel is allowed to see, and what it is allowed
 * to do.
 *
 *   CACHE      A room's calendar is fetched on demand when a panel asks and the copy is over a minute
 *              old (never more often, however many panels show the room), from the start of today to
 *              the end of tomorrow in the ROOM's zone. The last good copy is kept in the rooms row, so
 *              a restart, a second node, or an upstream outage still has something to show; errors
 *              back off from 30 s to 15 min. No panel showing a room means nobody polls it.
 *   PRIVACY    Applied here, before anything leaves the server: a hidden title is never sent, so it
 *              cannot be read out of the page or the JSON.
 *   ACTIONS    Book now, end early, check in. They come from a PANEL, proved by a capability derived
 *              from that device's own token (panelToken below), and are checked against a FRESH copy
 *              of the calendar, not the cache, so two panels cannot book the same slot off stale data.
 *   RELEASE    Optional, per organization: a meeting nobody checks in to within N minutes of its
 *              start gives the room back. Off by default, and only while a screen someone could
 *              have checked in at is showing the room (panelPresent below).
 */

const crypto = require('crypto');
const { db } = require('../../db/database');
const config = require('../../config');
const secretbox = require('../secretbox');
const { computeRoomState, dayBounds } = require('./freebusy');
const { RoomSourceError } = require('./http');
const graph = require('./graph');
const google = require('./google');
const ics = require('./ics');
const capsLib = require('../player-capabilities');

const FRESH_MS = 60 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const BOOK_OPTIONS = [15, 30, 60];
const MIN_BOOK_MS = 5 * 60 * 1000;
const CHECKIN_EARLY_MS = 10 * 60 * 1000;
const RELEASE_GRACE_MS = 15 * 60 * 1000;   // release only shortly after the deadline, never hours later
const PRESENCE_MS = 3 * 60 * 1000;         // a panel reports every minute while the room is on screen
const PRESENCE_WRITE_MS = 20 * 1000;       // and at most this often is written down
const PANEL_TITLE = 'Booked at the room display';

let clock = () => Date.now();
const inflight = new Map();   // room id -> Promise<day>

const DETAILS = new Set(['shown', 'private_hidden', 'hidden']);
const SOURCES = new Set(['m365', 'google', 'ics']);

/* ================================ connections ================================ */

/** A connection row with its secret decrypted, for the adapters. Fails closed on a bad secret. */
function connectionFor(id, orgId) {
  const row = db.prepare('SELECT * FROM room_connections WHERE id = ? AND organization_id = ?').get(id, orgId);
  if (!row) return null;
  let secret = null;
  if (row.secret_enc) {
    secret = secretbox.decrypt(row.secret_enc);
    if (secret == null) throw new RoomSourceError('The stored secret could not be decrypted. Enter it again.', { status: 400, code: 'secret-undecryptable' });
  }
  return { ...row, secret };
}

const adapterOf = (kind) => (kind === 'm365' ? graph : kind === 'google' ? google : null);

/* ================================ rooms ================================ */

const orgOfWorkspace = (wsId) => {
  const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(wsId);
  return r ? r.organization_id : null;
};

function orgSettings(orgId) {
  const r = orgId ? db.prepare('SELECT room_end_any, room_release_min FROM organizations WHERE id = ?').get(orgId) : null;
  return { end_any: !!(r && r.room_end_any), release_min: Math.max(0, Number((r && r.room_release_min) || 0)) };
}

function icsUrlOf(room) {
  if (!room.ics_url_enc) return null;
  const u = secretbox.decrypt(room.ics_url_enc);
  if (u == null) throw new RoomSourceError('The stored calendar address could not be decrypted. Enter it again.', { status: 400, code: 'secret-undecryptable' });
  return u;
}

/** The room's events from its source, from the start of today to the end of tomorrow (room zone). */
async function fetchEvents(room) {
  const now = clock();
  const { start } = dayBounds(room.timezone || 'UTC', now);
  const from = start;
  const to = start + 2 * 24 * 3600 * 1000 + 2 * 3600 * 1000;   // past tomorrow, however DST falls
  if (room.source === 'ics') return ics.events(icsUrlOf(room), room.timezone);
  const conn = connectionFor(room.connection_id, orgOfWorkspace(room.workspace_id));
  if (!conn) throw new RoomSourceError('This room’s calendar connection no longer exists.', { status: 400, code: 'no-connection' });
  const a = adapterOf(conn.kind);
  return a.events(conn, room.calendar_id, from, to, room.timezone);
}

/**
 * The cached day, refreshed when it is over a minute old (or always with `force`). On an error the
 * last good copy is returned with the error, and the next attempt backs off.
 */
async function getDay(roomId, { force = false } = {}) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return null;
  const now = clock();
  const cached = room.cache_json ? safeJson(room.cache_json, []) : null;
  const fresh = cached && room.cache_at && now - room.cache_at < FRESH_MS;
  const backingOff = !force && room.next_poll_at && room.next_poll_at > now;
  if (!force && (fresh || backingOff)) {
    return { room, events: cached || [], fetched_at: room.cache_at || null, error: room.last_error || null };
  }
  if (inflight.has(roomId)) return inflight.get(roomId);
  const p = (async () => {
    try {
      const events = await fetchEvents(room);
      const at = clock();
      db.prepare('UPDATE rooms SET cache_json = ?, cache_at = ?, last_error = NULL, error_count = 0, next_poll_at = NULL WHERE id = ?')
        .run(JSON.stringify(events), at, roomId);
      return { room: { ...room, cache_at: at, last_error: null }, events, fetched_at: at, error: null };
    } catch (e) {
      const n = (room.error_count || 0) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (n - 1));
      const msg = e instanceof RoomSourceError ? e.message : 'The calendar could not be read.';
      if (!(e instanceof RoomSourceError)) console.warn(`[rooms] ${roomId}: ${e && e.message}`);
      db.prepare('UPDATE rooms SET last_error = ?, error_count = ?, next_poll_at = ? WHERE id = ?').run(msg, n, clock() + wait, roomId);
      if (force) throw e;
      return { room, events: cached || [], fetched_at: room.cache_at || null, error: msg };
    } finally {
      inflight.delete(roomId);
    }
  })();
  inflight.set(roomId, p);
  return p;
}

function safeJson(t, d) { try { return JSON.parse(t); } catch { return d; } }

/* ================================ what a panel sees ================================ */

const bookedIds = (roomId) => new Set(db.prepare('SELECT event_id FROM room_bookings WHERE room_id = ?').all(roomId).map((r) => r.event_id));
const checkinsOf = (roomId) => {
  const m = new Map();
  for (const r of db.prepare('SELECT event_id, kind FROM room_checkins WHERE room_id = ?').all(roomId)) m.set(r.event_id, r.kind);
  return m;
};

/** One event as a panel may see it. Hidden details are dropped here, not in the page. */
function publicEvent(e, room, booked, checkins) {
  const panel = booked.has(e.id);
  const hide = room.details === 'hidden' || (room.details !== 'shown' && e.private);
  return {
    id: e.id,
    start: e.start,
    end: e.end,
    allDay: !!e.allDay,
    free: !!e.free,
    private: !!e.private,
    panel,
    title: panel ? PANEL_TITLE : (hide ? null : (e.title || null)),
    organiser: panel || hide ? null : (e.organiser || null),
    checked_in: checkins.get(e.id) === 'checkin' || panel,
    released: checkins.get(e.id) === 'released',
  };
}

/** Everything the room display page needs, privacy applied. */
async function panelState(room) {
  const day = await getDay(room.id);
  const booked = bookedIds(room.id);
  const checkins = checkinsOf(room.id);
  const s = orgSettings(orgOfWorkspace(room.workspace_id));
  const events = (day ? day.events : [])
    .map((e) => publicEvent(e, room, booked, checkins))
    .filter((e) => !e.released);
  const writable = room.source !== 'ics' && !!room.allow_booking && !isReadOnly(room);
  return {
    room: { id: room.id, name: room.name, timezone: room.timezone || 'UTC' },
    events,
    server_now: clock(),
    fetched_at: day ? day.fetched_at : null,
    stale: !!(day && day.error),
    options: {
      booking: writable,
      book_minutes: BOOK_OPTIONS,
      end_any: writable && s.end_any,
      release_min: room.source === 'ics' ? 0 : s.release_min,
    },
  };
}

function isReadOnly(room) {
  if (!room.connection_id) return false;
  const c = db.prepare('SELECT read_only FROM room_connections WHERE id = ?').get(room.connection_id);
  return !!(c && c.read_only);
}

/* ================================ panel capability ================================ */

/*
 * What lets a panel act, without ever giving it calendar credentials.
 *
 * Derived from the device's OWN token (hashed, never echoed), the widget and the device, so it is
 * worth nothing for another room or another screen, and it stops working the moment the screen is
 * re-paired or removed. The server hands it to the device over its authenticated socket in the
 * playlist payload (ws/deviceSocket.js), and the player puts it in the FRAGMENT of the widget URL —
 * which browsers never send to a server, so it is in no access log and no cache key.
 */
function panelToken(widgetId, device) {
  if (!device || !device.device_token || !widgetId) return null;
  const tokenHash = crypto.createHash('sha256').update(String(device.device_token)).digest('hex');
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`room-panel|${widgetId}|${device.id}|${tokenHash}`).digest('base64url');
}

function verifyPanelToken(widgetId, device, presented) {
  const want = panelToken(widgetId, device);
  if (!want || typeof presented !== 'string') return false;
  const a = Buffer.from(want);
  const b = Buffer.from(presented);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ================================ panel presence ================================ */

/*
 * Which screens are showing a room with WORKING buttons, right now.
 *
 * The page reports itself (POST /api/room-panel/:widget/seen) once a minute, and only when it holds
 * the panel capability, so a report proves three things together: the room's widget is on that
 * screen at this moment, the player passed the capability (a read-only player, or one older than
 * room displays, never does), and the screen is paired in the widget's own workspace (the route
 * checks it, as it does for an action). The release sweep adds the rest when it reads it back: the
 * screen is still online, not blocked, and declares room.panel (lib/player-capabilities.js) — so a
 * BrightSign or a webOS TV, which pass the capability but have nobody to press a button, does not
 * count — and the widget still shows that room.
 */
const lastPresenceWrite = new Map();   // `${widget}|${device}` -> ms, bounded below
function recordPresence(room, widgetId, deviceId) {
  const now = clock();
  const key = `${widgetId}|${deviceId}`;
  if (now - (lastPresenceWrite.get(key) || 0) < PRESENCE_WRITE_MS) return;
  lastPresenceWrite.delete(key);
  lastPresenceWrite.set(key, now);
  if (lastPresenceWrite.size > 5000) lastPresenceWrite.delete(lastPresenceWrite.keys().next().value);
  db.prepare(`INSERT INTO room_panel_presence (room_id, widget_id, device_id, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (room_id, widget_id, device_id) DO UPDATE SET seen_at = excluded.seen_at`).run(room.id, widgetId, deviceId, now);
}

/** True when a screen someone could check in at is showing this room right now. */
function panelPresent(room) {
  const rows = db.prepare(`
    SELECT p.widget_id, w.widget_type, w.workspace_id AS widget_ws, w.config,
           d.workspace_id, d.status, d.blocked, d.capabilities, d.platform, d.android_version, d.client_type
    FROM room_panel_presence p
    JOIN devices d ON d.id = p.device_id
    JOIN widgets w ON w.id = p.widget_id
    WHERE p.room_id = ? AND p.seen_at >= ?
  `).all(room.id, clock() - PRESENCE_MS);
  return rows.some((r) => r.status === 'online' && !r.blocked
    && r.workspace_id === room.workspace_id && r.widget_ws === room.workspace_id
    && r.widget_type === 'room-display' && safeJson(r.config || '{}', {}).room_id === room.id
    && capsLib.supports(r, 'room.panel'));
}

/* ================================ actions ================================ */

class ActionError extends Error {
  constructor(message, status = 409, code = 'refused') { super(message); this.status = status; this.code = code; }
}

function writableRoom(room) {
  if (room.source === 'ics') throw new ActionError('This room’s calendar is read-only.', 403, 'read-only');
  if (!room.allow_booking || isReadOnly(room)) throw new ActionError('Booking from the display is turned off for this room.', 403, 'booking-off');
  const conn = connectionFor(room.connection_id, orgOfWorkspace(room.workspace_id));
  if (!conn) throw new ActionError('This room’s calendar connection no longer exists.', 409, 'no-connection');
  return { conn, a: adapterOf(conn.kind) };
}

// One action per room at a time, in this process: a double tap must not create two meetings.
const roomLocks = new Map();
async function withRoomLock(roomId, fn) {
  while (roomLocks.has(roomId)) await roomLocks.get(roomId).catch(() => {});
  const p = fn();
  roomLocks.set(roomId, p);
  try { return await p; } finally { if (roomLocks.get(roomId) === p) roomLocks.delete(roomId); }
}

const floorMinute = (ms) => Math.floor(ms / 60000) * 60000;

async function book(room, deviceId, minutes) {
  const m = Number(minutes);
  if (!BOOK_OPTIONS.includes(m) && m !== 0) throw new ActionError('Choose 15, 30 or 60 minutes.', 400, 'bad-minutes');
  return withRoomLock(room.id, async () => {
    const { conn, a } = writableRoom(room);
    const day = await getDay(room.id, { force: true });
    const now = clock();
    const st = computeRoomState(day.events, now);
    if (st.busy) throw new ActionError('The room is in use.', 409, 'busy');
    const start = floorMinute(now);
    // 0 = "until the next meeting", offered when no full option fits the gap.
    let end = m === 0 ? (st.freeUntil || start + 60 * 60000) : start + m * 60000;
    if (st.freeUntil && end > st.freeUntil) end = st.freeUntil;
    if (end - now < MIN_BOOK_MS) throw new ActionError('The next meeting starts too soon to book.', 409, 'too-short');
    const id = await a.create(conn, room.calendar_id, { title: PANEL_TITLE, start, end });
    db.prepare('INSERT INTO room_bookings (id, room_id, event_id, device_id, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), room.id, id, deviceId, start, end, now);
    await getDay(room.id, { force: true }).catch(() => {});
    return { event_id: id, start, end };
  });
}

async function endMeeting(room, deviceId, eventId) {
  return withRoomLock(room.id, async () => {
    const { conn, a } = writableRoom(room);
    const day = await getDay(room.id, { force: true });
    const now = clock();
    const st = computeRoomState(day.events, now);
    if (!st.busy || !st.current || st.current.id !== eventId) throw new ActionError('That meeting is not in progress.', 409, 'not-current');
    const panel = bookedIds(room.id).has(eventId);
    const s = orgSettings(orgOfWorkspace(room.workspace_id));
    if (panel) {
      // Ours (the room organises it): shorten it to end now. A meeting must still end after it
      // starts, hence the one-minute floor for one booked this very minute; bookings are at least
      // five minutes long, so this is always before its original end.
      const end = Math.max(floorMinute(now), st.current.start + 60000);
      if (end < st.current.end) await a.shorten(conn, room.calendar_id, eventId, end);
      db.prepare('UPDATE room_bookings SET ended_at = ? WHERE room_id = ? AND event_id = ?').run(now, room.id, eventId);
    } else if (s.end_any) {
      // Someone else's: the room declines it (both adapters). The meeting itself is
      // not cancelled for its attendees, and the organiser is told.
      try {
        await a.release(conn, room.calendar_id, eventId, 'Ended early at the room display.');
      } catch (e) {
        if (e instanceof RoomSourceError && KEEP_CODES.has(e.code)) throw new ActionError(e.message, 409, e.code);
        throw e;
      }
      db.prepare('INSERT OR REPLACE INTO room_checkins (room_id, event_id, kind, device_id, at) VALUES (?, ?, ?, ?, ?)')
        .run(room.id, eventId, 'released', deviceId, now);
    } else {
      throw new ActionError('Only meetings booked at this display can be ended here.', 403, 'not-panel');
    }
    await getDay(room.id, { force: true }).catch(() => {});
    return { ended: eventId };
  });
}

async function checkIn(room, deviceId, eventId) {
  const day = await getDay(room.id);
  const now = clock();
  const e = (day.events || []).find((x) => x.id === eventId && !x.free);
  if (!e || e.end <= now || e.start - CHECKIN_EARLY_MS > now) throw new ActionError('That meeting cannot be checked in to now.', 409, 'not-checkable');
  db.prepare('INSERT OR IGNORE INTO room_checkins (room_id, event_id, kind, device_id, at) VALUES (?, ?, ?, ?, ?)')
    .run(room.id, eventId, 'checkin', deviceId, now);
  return { checked_in: eventId };
}

// What an adapter's release() says when the room may not give the meeting up (Google: the room is
// its organiser, so removing the room would cancel it for everyone; or the room is not an attendee).
const KEEP_CODES = new Set(['room-organiser', 'not-attendee']);

/*
 * Give back rooms nobody turned up to. Runs every minute; does nothing for an organization that has
 * not turned it on. Only timed meetings, only between the deadline and 15 minutes after it (so a
 * meeting that started before the setting was turned on is not released hours in), never one booked
 * at a panel (someone was standing there), and checked against a fresh copy before acting.
 *
 * ⚠️ And only while a screen someone could have checked in at is showing the room (panelPresent).
 * Without that, a room shown only on a read-only TV, on a screen that is offline, through a head
 * office widget the store's screen cannot act on, or on no screen at all lost every meeting, and
 * each organiser was sent a decline. Nobody was absent; there was simply no button.
 */
async function sweepReleases({ log } = {}) {
  const now = clock();
  const rows = db.prepare(`
    SELECT r.*, o.room_release_min AS release_min
    FROM rooms r
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN organizations o ON o.id = w.organization_id
    WHERE o.room_release_min > 0 AND r.source != 'ics' AND r.allow_booking = 1
  `).all();
  let released = 0;
  for (const room of rows) {
    const graceMs = room.release_min * 60000;
    const cached = room.cache_json ? safeJson(room.cache_json, []) : [];
    const due = (evs) => {
      const booked = bookedIds(room.id);
      const seen = checkinsOf(room.id);
      return evs.filter((e) => !e.free && !e.allDay && !booked.has(e.id) && !seen.has(e.id)
        && e.start + graceMs <= now && now < e.end && now < e.start + graceMs + RELEASE_GRACE_MS);
    };
    if (!due(cached).length) continue;
    if (!panelPresent(room)) continue;
    try {
      const { conn, a } = writableRoom(room);
      const day = await getDay(room.id, { force: true });
      let here = 0;
      for (const e of due(day.events)) {
        try {
          await a.release(conn, room.calendar_id, e.id, `Released: nobody checked in at the room display within ${room.release_min} minutes.`);
        } catch (err) {
          if (!(err instanceof RoomSourceError && KEEP_CODES.has(err.code))) throw err;
          // Never releasable: remember it, so it is not tried again every minute.
          db.prepare('INSERT OR IGNORE INTO room_checkins (room_id, event_id, kind, device_id, at) VALUES (?, ?, ?, ?, ?)')
            .run(room.id, e.id, 'kept', null, now);
          continue;
        }
        db.prepare('INSERT OR REPLACE INTO room_checkins (room_id, event_id, kind, device_id, at) VALUES (?, ?, ?, ?, ?)')
          .run(room.id, e.id, 'released', null, now);
        released++;
        here++;
        if (log) log(room, e);
      }
      if (here) await getDay(room.id, { force: true }).catch(() => {});
    } catch (e) {
      console.warn(`[rooms] release sweep ${room.id}: ${e && e.message}`);
    }
  }
  // Housekeeping: bookings and check-ins for meetings over a day ago are of no further use.
  const old = now - 36 * 3600 * 1000;
  db.prepare('DELETE FROM room_bookings WHERE end_ms < ?').run(old);
  db.prepare('DELETE FROM room_checkins WHERE at < ?').run(old);
  db.prepare('DELETE FROM room_panel_presence WHERE seen_at < ?').run(old);
  return released;
}

let timer = null;
function start() {
  if (timer) return;
  const { logActivity } = require('../../services/activity');
  timer = setInterval(() => {
    sweepReleases({
      log: (room, e) => logActivity(null, 'room:released', `${room.name}: a meeting nobody checked in to`, null, null, room.workspace_id),
    }).catch((e) => console.warn(`[rooms] sweep: ${e && e.message}`));
  }, 60 * 1000);
  if (timer.unref) timer.unref();
}

function _setClock(fn) { clock = fn || (() => Date.now()); }
function _reset() { inflight.clear(); roomLocks.clear(); lastPresenceWrite.clear(); graph._reset(); google._reset(); }

module.exports = {
  DETAILS, SOURCES, BOOK_OPTIONS, PANEL_TITLE,
  connectionFor, orgSettings, orgOfWorkspace, getDay, panelState, publicEvent,
  panelToken, verifyPanelToken, recordPresence, panelPresent, book, endMeeting, checkIn, sweepReleases, start,
  ActionError, adapterOf,
  _setClock, _reset,
};
