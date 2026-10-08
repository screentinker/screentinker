'use strict';

/*
 * Microsoft 365 room mailboxes through Microsoft Graph, with the organization's own Entra app
 * (client credentials). Application permissions: Calendars.Read to show a room, Calendars.ReadWrite
 * to book from the panel, Place.Read.All to list rooms. docs/room-booking.md recommends an
 * ApplicationAccessPolicy so the app can reach room mailboxes and nothing else.
 *
 * Self-contained on purpose (its own token cache, its own table row): other features may add an
 * org-level Entra app later, and a room display should not break when they do.
 */

const crypto = require('crypto');
const { request, endpoints, RoomSourceError } = require('./http');

const tokens = new Map();   // `${connection.id}:${credentialsHash}` -> { token, exp }
/*
 * Keyed on the credentials themselves, not on updated_at: that has one-second resolution, so a
 * secret corrected within the same second kept using the token the OLD secret had earned — and Test
 * said "signed in" for a secret that was wrong.
 */
const credKey = (conn) => `${conn.id}:${crypto.createHash('sha256').update(`${conn.tenant_id}|${conn.client_id}|${conn.secret}`).digest('hex').slice(0, 24)}`;

// A GUID or a verified domain. The multi-tenant aliases are refused: client credentials against
// /common cannot work, and the error Microsoft returns for it does not say so.
const TENANT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i;
function validTenant(t) {
  const v = String(t || '').trim();
  return TENANT_RE.test(v) && !/^(common|organizations|consumers)$/i.test(v);
}

async function token(conn) {
  const key = credKey(conn);
  const hit = tokens.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  if (!validTenant(conn.tenant_id)) throw new RoomSourceError('The tenant ID must be your directory (tenant) GUID or a verified domain.', { status: 400, code: 'bad-tenant' });
  if (!conn.client_id || !conn.secret) throw new RoomSourceError('The client ID and client secret are required.', { status: 400, code: 'incomplete' });
  const r = await request(`${endpoints().msLogin}/${encodeURIComponent(conn.tenant_id)}/oauth2/v2.0/token`, {
    method: 'POST',
    what: 'Microsoft sign-in',
    form: { client_id: conn.client_id, client_secret: conn.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' },
  });
  if (!r || !r.access_token) throw new RoomSourceError('Microsoft sign-in returned no token.', { code: 'no-token' });
  for (const k of tokens.keys()) if (k.startsWith(`${conn.id}:`)) tokens.delete(k);
  tokens.set(key, { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  return r.access_token;
}

const auth = async (conn) => ({ Authorization: `Bearer ${await token(conn)}` });
const userPath = (room) => `${endpoints().graph}/users/${encodeURIComponent(room)}`;
// Graph answers in the timezone the Prefer header asks for, without an offset. UTC, then 'Z'.
const graphTime = (dt) => Date.parse(String(dt || '').replace(/(\.\d{3})\d*$/, '$1') + 'Z');
const graphStamp = (ms) => new Date(ms).toISOString().replace(/Z$/, '');

async function listRooms(conn) {
  const r = await request(`${endpoints().graph}/places/microsoft.graph.room?$top=200`, { headers: await auth(conn), what: 'Microsoft Graph' });
  return ((r && r.value) || [])
    .filter((p) => p && p.emailAddress)
    .map((p) => ({ calendar_id: String(p.emailAddress), name: String(p.displayName || p.emailAddress) }));
}

function mapEvent(e) {
  if (!e || e.isCancelled) return null;
  const declined = e.responseStatus && e.responseStatus.response === 'declined';
  const org = e.organizer && e.organizer.emailAddress;
  return {
    id: String(e.id),
    title: e.subject ? String(e.subject) : '',
    organiser: org ? String(org.name || org.address || '') : '',
    start: graphTime(e.start && e.start.dateTime),
    end: graphTime(e.end && e.end.dateTime),
    allDay: !!e.isAllDay,
    // "Free" and "working elsewhere" do not occupy a room; a meeting the room itself declined is gone.
    free: declined || e.showAs === 'free' || e.showAs === 'workingElsewhere',
    private: e.sensitivity === 'private' || e.sensitivity === 'confidential',
  };
}

async function events(conn, room, fromMs, toMs) {
  const qs = new URLSearchParams({
    startDateTime: new Date(fromMs).toISOString(),
    endDateTime: new Date(toMs).toISOString(),
    $top: '100',
    $orderby: 'start/dateTime',
    $select: 'id,subject,organizer,start,end,isAllDay,sensitivity,showAs,isCancelled,responseStatus',
  });
  const r = await request(`${userPath(room)}/calendarView?${qs}`, {
    headers: { ...(await auth(conn)), Prefer: 'outlook.timezone="UTC"' }, what: 'Microsoft Graph',
  });
  return ((r && r.value) || []).map(mapEvent).filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end));
}

/** A meeting in the room's own calendar, organised by the room. Returns its id. */
async function create(conn, room, { title, start, end }) {
  const r = await request(`${userPath(room)}/events`, {
    method: 'POST', headers: await auth(conn), what: 'Microsoft Graph',
    body: {
      subject: title,
      start: { dateTime: graphStamp(start), timeZone: 'UTC' },
      end: { dateTime: graphStamp(end), timeZone: 'UTC' },
      showAs: 'busy',
      isReminderOn: false,
      body: { contentType: 'text', content: 'Booked on the room display.' },
    },
  });
  if (!r || !r.id) throw new RoomSourceError('Microsoft Graph did not return the new meeting.', { code: 'no-id' });
  return String(r.id);
}

/** Shorten a meeting the room organises (one booked at the panel) so it ends now. */
async function shorten(conn, room, id, endMs) {
  await request(`${userPath(room)}/events/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: await auth(conn), what: 'Microsoft Graph',
    body: { end: { dateTime: graphStamp(endMs), timeZone: 'UTC' } },
  });
}

/** Free the room from someone else's meeting: the room declines it, and the organiser is told. */
async function release(conn, room, id, comment) {
  await request(`${userPath(room)}/events/${encodeURIComponent(id)}/decline`, {
    method: 'POST', headers: await auth(conn), what: 'Microsoft Graph',
    body: { sendResponse: true, comment },
  });
}

async function test(conn) {
  await token(conn);
  try { return { ok: true, rooms: (await listRooms(conn)).length }; }
  catch (e) { return { ok: true, rooms: null, rooms_error: e.message }; }
}

function _reset() { tokens.clear(); }

module.exports = { validTenant, listRooms, events, create, shorten, release, test, mapEvent, _reset };
