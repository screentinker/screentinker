'use strict';

/*
 * Google Workspace resource calendars, with the organization's own service account.
 *
 * Two ways to grant it access, both supported:
 *   - share each room's calendar with the service account's address ("Make changes to events" to
 *     book from the panel), and leave the subject empty; or
 *   - domain-wide delegation, with `subject` set to a Workspace admin the account acts as. That is
 *     also what listing the rooms (Directory API) needs.
 *
 * The JWT is signed here with Node's crypto (RS256), so there is no googleapis dependency. The key's
 * own `token_uri` is ignored: see lib/rooms/http.js for why every host is fixed.
 */

const crypto = require('crypto');
const { request, endpoints, RoomSourceError } = require('./http');
const { midnightIn } = require('./freebusy');

const tokens = new Map();   // `${conn.id}:${credentialsHash}:${scope}` -> { token, exp } (see graph.js for why not updated_at)
const credKey = (conn) => `${conn.id}:${crypto.createHash('sha256').update(`${conn.client_id}|${conn.subject || ''}|${conn.secret}`).digest('hex').slice(0, 24)}`;
const SCOPE_RW = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE_RO = 'https://www.googleapis.com/auth/calendar.events.readonly';
const SCOPE_DIR = 'https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly';
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Pull client_email and private_key out of a pasted service-account JSON key. */
function parseKey(text) {
  let k;
  try { k = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { error: 'That is not a service account JSON key.' }; }
  if (!k || k.type !== 'service_account' || !k.client_email || !k.private_key) {
    return { error: 'That is not a service account JSON key (it needs type "service_account", client_email and private_key).' };
  }
  try { crypto.createPrivateKey(k.private_key); } catch { return { error: 'The private key in that JSON key could not be read.' }; }
  return { client_email: String(k.client_email), private_key: String(k.private_key) };
}

/** The signed assertion exchanged for an access token. Exported for the tests. */
function assertion(conn, scope, nowSec = Math.floor(Date.now() / 1000)) {
  const claims = { iss: conn.client_id, scope, aud: endpoints().googleToken, iat: nowSec, exp: nowSec + 3600 };
  if (conn.subject) claims.sub = conn.subject;
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(conn.secret).toString('base64url');
  return `${unsigned}.${sig}`;
}

async function token(conn, scope) {
  const key = `${credKey(conn)}:${scope}`;
  const hit = tokens.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  if (!conn.client_id || !conn.secret) throw new RoomSourceError('The service account key is required.', { status: 400, code: 'incomplete' });
  let jwt;
  try { jwt = assertion(conn, scope); } catch { throw new RoomSourceError('The service account key could not sign a request — paste it again.', { status: 400, code: 'bad-key' }); }
  const r = await request(endpoints().googleToken, {
    method: 'POST', what: 'Google sign-in',
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
  });
  if (!r || !r.access_token) throw new RoomSourceError('Google sign-in returned no token.', { code: 'no-token' });
  tokens.set(key, { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  return r.access_token;
}

const scopeFor = (conn) => (conn.read_only ? SCOPE_RO : SCOPE_RW);
const auth = async (conn, scope = scopeFor(conn)) => ({ Authorization: `Bearer ${await token(conn, scope)}` });
const calPath = (cal) => `${endpoints().googleCalendar}/calendars/${encodeURIComponent(cal)}/events`;

/** An all-day 'YYYY-MM-DD' is midnight in the ROOM's zone, not the server's. */
function dateToMs(v, tz) {
  if (!v) return NaN;
  if (v.dateTime) return Date.parse(v.dateTime);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v.date || ''));
  return m ? midnightIn(tz || 'UTC', +m[1], +m[2], +m[3]) : NaN;
}

function mapEvent(e, calId, tz) {
  if (!e || e.status === 'cancelled') return null;
  const self = (e.attendees || []).find((a) => a && (a.self || (a.email && a.email.toLowerCase() === String(calId).toLowerCase())));
  return {
    id: String(e.id),
    title: e.summary ? String(e.summary) : '',
    organiser: e.organizer ? String(e.organizer.displayName || e.organizer.email || '') : '',
    start: dateToMs(e.start, tz),
    end: dateToMs(e.end, tz),
    allDay: !!(e.start && e.start.date && !e.start.dateTime),
    free: e.transparency === 'transparent' || (self && self.responseStatus === 'declined'),
    private: e.visibility === 'private' || e.visibility === 'confidential',
  };
}

async function events(conn, cal, fromMs, toMs, tz) {
  const qs = new URLSearchParams({
    timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
  });
  const r = await request(`${calPath(cal)}?${qs}`, { headers: await auth(conn), what: 'Google Calendar' });
  return ((r && r.items) || []).map((e) => mapEvent(e, cal, tz)).filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end));
}

async function create(conn, cal, { title, start, end }) {
  const r = await request(calPath(cal), {
    method: 'POST', headers: await auth(conn), what: 'Google Calendar',
    body: { summary: title, description: 'Booked on the room display.', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } },
  });
  if (!r || !r.id) throw new RoomSourceError('Google Calendar did not return the new meeting.', { code: 'no-id' });
  return String(r.id);
}

async function shorten(conn, cal, id, endMs) {
  await request(`${calPath(cal)}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: await auth(conn), what: 'Google Calendar',
    body: { end: { dateTime: new Date(endMs).toISOString() } },
  });
}

/*
 * Free the room from someone else's meeting. Deleting an event from an ATTENDEE's calendar (the
 * room's) removes the room from it rather than cancelling the meeting for everyone.
 */
async function release(conn, cal, id) {
  await request(`${calPath(cal)}/${encodeURIComponent(id)}?sendUpdates=all`, {
    method: 'DELETE', headers: await auth(conn), what: 'Google Calendar',
  });
}

async function listRooms(conn) {
  if (!conn.subject) throw new RoomSourceError('Listing rooms needs domain-wide delegation and an admin to act as. Enter calendar IDs by hand instead.', { status: 400, code: 'needs-subject' });
  const r = await request(`${endpoints().googleDirectory}/customer/my_customer/resources/calendars?maxResults=200`, {
    headers: await auth(conn, SCOPE_DIR), what: 'Google Directory',
  });
  return ((r && r.items) || [])
    .filter((x) => x && x.resourceEmail)
    .map((x) => ({ calendar_id: String(x.resourceEmail), name: String(x.resourceName || x.resourceEmail) }));
}

async function test(conn) {
  await token(conn, scopeFor(conn));
  if (!conn.subject) return { ok: true, rooms: null };
  try { return { ok: true, rooms: (await listRooms(conn)).length }; }
  catch (e) { return { ok: true, rooms: null, rooms_error: e.message }; }
}

function _reset() { tokens.clear(); }

module.exports = { parseKey, assertion, listRooms, events, create, shorten, release, test, mapEvent, SCOPE_RW, SCOPE_RO, _reset };
