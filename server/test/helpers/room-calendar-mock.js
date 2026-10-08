'use strict';

/*
 * A fake Microsoft Graph + Google Calendar/Directory for the room-booking tests. One handler, two
 * ways in: `fetch` (swap global.fetch, in-process tests) and `listen()` (a real HTTP server the
 * spawned server is pointed at through the NODE_ENV=test base-URL overrides in lib/rooms/http.js).
 *
 * Paths, under whatever base the caller chose:
 *   /ms/<tenant>/oauth2/v2.0/token          client credentials; secret must be GOOD_SECRET
 *   /graph/places/microsoft.graph.room      rooms
 *   /graph/users/<room>/calendarView        events overlapping the window
 *   /graph/users/<room>/events              POST create
 *   /graph/users/<room>/events/<id>         PATCH end
 *   /graph/users/<room>/events/<id>/decline POST
 *   /google/token                           JWT bearer grant; records the decoded assertion
 *   /gcal/calendars/<cal>/events[/<id>]     list / POST / GET / PATCH / DELETE
 *
 * With state.pageSize set, lists come back in pages: Graph with @odata.nextLink, Google with
 * nextPageToken, as the real services do.
 *   /gdir/customer/my_customer/resources/calendars
 */

const http = require('http');

const GOOD_SECRET = 's3cret-value-never-echoed';

function createMock() {
  const state = {
    graph: {},      // room -> [{ id, subject, organizer, start, end, isAllDay, sensitivity, showAs, responseStatus }]
    google: {},     // cal -> [{ id, summary, organizer, start, end, visibility, transparency, status }]
    requests: [],   // { method, path, auth, body }
    assertions: [], // decoded Google JWT claims
    failGraph: 0,   // answer the next N Graph calls with 503
    pageSize: 0,    // > 0: page every list
    seq: 0,
  };
  const ms = (iso) => Date.parse(iso);
  const graphDt = (msv) => new Date(msv).toISOString().replace('Z', '0000');

  function json(status, body) { return { status, body: body == null ? '' : JSON.stringify(body) }; }
  // One page of a Graph list, with the absolute nextLink Graph sends.
  function graphPage(u, list) {
    if (!state.pageSize) return { value: list };
    const skip = Number(u.searchParams.get('$skip') || 0);
    const out = { value: list.slice(skip, skip + state.pageSize) };
    if (skip + state.pageSize < list.length) { const n = new URL(u); n.searchParams.set('$skip', String(skip + state.pageSize)); out['@odata.nextLink'] = n.toString(); }
    return out;
  }
  function googlePage(u, list) {
    if (!state.pageSize) return { items: list };
    const at = Number(u.searchParams.get('pageToken') || 0);
    const out = { items: list.slice(at, at + state.pageSize) };
    if (at + state.pageSize < list.length) out.nextPageToken = String(at + state.pageSize);
    return out;
  }

  function handle(method, rawUrl, headers, bodyText) {
    const u = new URL(rawUrl, 'http://mock');
    const p = decodeURIComponent(u.pathname);
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = null; }
    const form = /x-www-form-urlencoded/.test(headers['content-type'] || '') ? Object.fromEntries(new URLSearchParams(bodyText || '')) : null;
    state.requests.push({ method, path: p, auth: headers.authorization || null, body: body || form });
    let m;

    if ((m = /\/ms\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(p)) && method === 'POST') {
      if (!form || form.client_secret !== GOOD_SECRET) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      return json(200, { access_token: `ms-${m[1]}-${++state.seq}`, expires_in: 3600 });
    }
    if (/\/graph\//.test(p) && state.failGraph > 0) { state.failGraph--; return json(503, { error: { code: 'ServiceUnavailable', message: 'Try later' } }); }
    if (/\/graph\//.test(p) && !/^Bearer ms-/.test(headers.authorization || '')) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'no token' } });
    if (/\/graph\/places\/microsoft\.graph\.room$/.test(p)) {
      return json(200, graphPage(u, [{ emailAddress: 'boardroom@acme.test', displayName: 'Boardroom' }, { emailAddress: 'huddle@acme.test', displayName: 'Huddle 1' }]));
    }
    if ((m = /\/graph\/users\/([^/]+)\/calendarView$/.exec(p))) {
      const from = ms(u.searchParams.get('startDateTime'));
      const to = ms(u.searchParams.get('endDateTime'));
      const list = (state.graph[m[1]] || []).filter((e) => e.start < to && e.end > from);
      return json(200, graphPage(u, list.map((e) => ({ ...e, start: { dateTime: graphDt(e.start), timeZone: 'UTC' }, end: { dateTime: graphDt(e.end), timeZone: 'UTC' } }))));
    }
    if ((m = /\/graph\/users\/([^/]+)\/events$/.exec(p)) && method === 'POST') {
      const id = `g-${++state.seq}`;
      (state.graph[m[1]] = state.graph[m[1]] || []).push({
        id, subject: body.subject, organizer: { emailAddress: { name: m[1], address: m[1] } },
        start: ms(body.start.dateTime + 'Z'), end: ms(body.end.dateTime + 'Z'), isAllDay: false, showAs: body.showAs || 'busy',
      });
      return json(201, { id });
    }
    if ((m = /\/graph\/users\/([^/]+)\/events\/([^/]+)\/decline$/.exec(p)) && method === 'POST') {
      const e = (state.graph[m[1]] || []).find((x) => x.id === m[2]);
      if (!e) return json(404, { error: { code: 'ErrorItemNotFound', message: 'gone' } });
      e.responseStatus = { response: 'declined' };
      return json(202, null);
    }
    if ((m = /\/graph\/users\/([^/]+)\/events\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const e = (state.graph[m[1]] || []).find((x) => x.id === m[2]);
      if (!e) return json(404, { error: { code: 'ErrorItemNotFound', message: 'gone' } });
      if (body.end) e.end = ms(body.end.dateTime + 'Z');
      return json(200, { id: e.id });
    }

    if (/\/google\/token$/.test(p) && method === 'POST') {
      const parts = String((form && form.assertion) || '').split('.');
      try { state.assertions.push({ header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), jwt: form.assertion }); } catch { return json(400, { error: 'invalid_grant' }); }
      return json(200, { access_token: `goog-${++state.seq}`, expires_in: 3600 });
    }
    if (/\/(gcal|gdir)\//.test(p) && !/^Bearer goog-/.test(headers.authorization || '')) return json(401, { error: { message: 'no token' } });
    if (/\/gdir\/customer\/my_customer\/resources\/calendars$/.test(p)) {
      return json(200, googlePage(u, [{ resourceEmail: 'c_room1@resource.calendar.google.com', resourceName: 'Room 1' }]));
    }
    if ((m = /\/gcal\/calendars\/([^/]+)\/events$/.exec(p))) {
      const list = (state.google[m[1]] = state.google[m[1]] || []);
      if (method === 'POST') { const id = `ge-${++state.seq}`; list.push({ id, ...body }); return json(200, { id }); }
      const from = ms(u.searchParams.get('timeMin'));
      const to = ms(u.searchParams.get('timeMax'));
      const t = (v) => (v.dateTime ? ms(v.dateTime) : ms(v.date + 'T00:00:00Z'));
      return json(200, googlePage(u, list.filter((e) => t(e.start) < to && t(e.end) > from)));
    }
    if ((m = /\/gcal\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
      const list = state.google[m[1]] || [];
      const i = list.findIndex((x) => x.id === m[2]);
      if (i < 0) return json(404, { error: { message: 'Not Found' } });
      if (method === 'GET') return json(200, list[i]);
      if (method === 'DELETE') { list.splice(i, 1); return json(204, null); }
      if (method === 'PATCH' && body && body.attendeesOmitted) {
        // Only the caller's own response changes, as Google does with attendeesOmitted.
        for (const a of body.attendees || []) {
          const mine = (list[i].attendees || []).find((x) => x.email === a.email);
          if (mine) Object.assign(mine, a);
        }
        return json(200, { id: list[i].id });
      }
      if (method === 'PATCH') { Object.assign(list[i], body); return json(200, { id: list[i].id }); }
    }
    return json(404, { error: { message: `mock: no route for ${method} ${p}` } });
  }

  const fetchImpl = async (url, opts = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const r = handle(opts.method || 'GET', String(url), headers, typeof opts.body === 'string' ? opts.body : '');
    return new Response(r.body === '' ? null : r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  function listen() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
          const r = handle(req.method, req.url, req.headers, data);
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(r.body);
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }

  return { state, handle, fetch: fetchImpl, listen };
}

module.exports = { createMock, GOOD_SECRET };
