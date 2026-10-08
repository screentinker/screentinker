'use strict';

/*
 * Outbound HTTP for room calendars.
 *
 * ⚠️ THE HOSTS ARE FIXED, never taken from a credential or a response. A Google service-account key
 * carries its own `token_uri`, and trusting it would let whoever pastes a key point this server at
 * any address it can reach; Graph and Google endpoints are constants for the same reason. Only an
 * ICS URL is caller-supplied, and that goes through the SSRF guard (lib/rooms/ics.js).
 *
 * The overrides exist for the end-to-end tests' mock calendar server and are honoured only when
 * NODE_ENV=test, the same gate lib/corporate/emergency-live.js uses for its test clock.
 */

const TIMEOUT_MS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;

class RoomSourceError extends Error {
  constructor(message, { status = 502, code = 'upstream', upstreamStatus = null } = {}) {
    super(message);
    this.name = 'RoomSourceError';
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

function endpoints() {
  const test = process.env.NODE_ENV === 'test';
  const pick = (name, dflt) => (test && process.env[name]) || dflt;
  return {
    msLogin: pick('ROOMS_MS_LOGIN_BASE', 'https://login.microsoftonline.com'),
    graph: pick('ROOMS_GRAPH_BASE', 'https://graph.microsoft.com/v1.0'),
    googleToken: pick('ROOMS_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    googleCalendar: pick('ROOMS_GOOGLE_CALENDAR_BASE', 'https://www.googleapis.com/calendar/v3'),
    googleDirectory: pick('ROOMS_GOOGLE_DIRECTORY_BASE', 'https://admin.googleapis.com/admin/directory/v1'),
  };
}

/** Upstream error text worth showing an admin, without echoing a whole HTML error page. */
function upstreamMessage(body) {
  if (!body) return '';
  if (typeof body === 'object') {
    const e = body.error;
    if (e && typeof e === 'object') return String(e.message || e.code || '').slice(0, 300);
    if (typeof e === 'string') return String(body.error_description || e).slice(0, 300);
    return '';
  }
  return '';
}

/**
 * fetch() with a timeout and a size cap; JSON in, JSON out. Throws RoomSourceError with the
 * upstream's own message (Graph and Google both explain a missing permission clearly).
 */
async function request(url, { method = 'GET', headers = {}, body, form, what = 'Calendar service' } = {}) {
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new RoomSourceError(`${what} ${timeout ? 'did not answer in time' : 'could not be reached'}.`, { code: timeout ? 'timeout' : 'unreachable' });
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new RoomSourceError(`${what} sent more data than a room calendar should.`, { code: 'too-large' });
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  if (!res.ok) {
    const detail = upstreamMessage(json);
    const status = res.status === 401 || res.status === 403 ? 400 : 502;
    throw new RoomSourceError(`${what} answered ${res.status}${detail ? `: ${detail}` : ''}`, { status, code: `http-${res.status}`, upstreamStatus: res.status });
  }
  return json;
}

module.exports = { request, endpoints, RoomSourceError };
