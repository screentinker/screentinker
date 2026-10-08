'use strict';

/*
 * Meeting-room displays, the dashboard side (lib/rooms). JWT only (config/api-surface.js): a
 * connection holds an organization's Microsoft 365 client secret or Google service-account key.
 *
 *   /connections   the organization's calendar apps. Org admins write; workspace admins may LIST
 *                  them (names and kinds only) to pick one for a room.
 *   /settings      org-wide panel rules: end any meeting, release when nobody checks in.
 *   / (rooms)      a workspace's rooms. Workspace admins write; anyone in the workspace reads.
 *
 * ⚠️ No secret ever leaves: a connection answers has_secret, a room answers has_ics_url and the
 * ICS host only (a published calendar address IS a credential — anyone holding it reads the room).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const secretbox = require('../lib/secretbox');
const { canRead, canAdmin, isOrgAdmin } = require('../lib/permissions');
const { logActivity, getClientIp } = require('../services/activity');
const { isRealTimezone } = require('../lib/device-timezone');
const svc = require('../lib/rooms/service');
const graph = require('../lib/rooms/graph');
const google = require('../lib/rooms/google');
const { RoomSourceError } = require('../lib/rooms/http');
const { checkHttpUrl } = require('../lib/data-sources/http');
const { SsrfError, GuardedRequestError } = require('../lib/ssrf-guard');

const audit = (req, action, details) => logActivity(req.user.id, action, details, null, getClientIp(req), req.workspaceId || null);
const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const bool01 = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

// An async handler's failure goes to sendErr, not to an unhandled rejection (Express 4).
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { if (!res.headersSent) sendErr(res, e); });

/*
 * An ICS calendar is read through the iCal resolver (lib/rooms/ics.js), which throws the SSRF guard's
 * own errors, not RoomSourceError. Those are an admin's address being refused or failing, never a
 * server fault: say which, instead of a generic 500. `status` is what sendErr answers.
 */
function icsSourceError(e) {
  if (e instanceof SsrfError) {
    const r = String(e.reason || '');
    let msg = 'This server will not fetch that calendar address.';
    if (r === 'dns-fail') msg = 'The calendar address’s host could not be found.';
    else if (r === 'bad-url' || r === 'bad-scheme' || r === 'userinfo') msg = 'The calendar address must be a plain http:// or https:// URL.';
    else if (r.startsWith('blocked-ip') || r === 'no-address') msg = 'The calendar address points at a private or internal network address, which this server will not fetch.';
    return { status: 400, message: msg, code: 'ssrf' };
  }
  if (e instanceof GuardedRequestError) return { status: 502, message: `${e.message}.`, code: e.code || 'upstream' };
  if (e && /^Remote calendar data could not be parsed/.test(e.message || '')) {
    return { status: 502, message: 'The calendar address did not return a calendar (ICS) file.', code: 'bad-ics' };
  }
  return null;
}

function sendErr(res, e) {
  if (e instanceof RoomSourceError || e instanceof svc.ActionError) return res.status(e.status || 400).json({ error: e.message, code: e.code || null });
  const src = icsSourceError(e);
  if (src) return res.status(src.status).json({ error: src.message, code: src.code });
  console.error('[rooms]', e && e.message);
  return res.status(500).json({ error: 'Something went wrong with the room calendar' });
}

/* ================================ connections ================================ */

function connPublic(row) {
  return {
    id: row.id, kind: row.kind, name: row.name,
    tenant_id: row.kind === 'm365' ? row.tenant_id : undefined,
    client_id: row.client_id,                 // Microsoft app id, or the service account's address
    subject: row.kind === 'google' ? (row.subject || null) : undefined,
    read_only: !!row.read_only,
    has_secret: !!row.secret_enc,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function requireOrg(req, res, { admin = false } = {}) {
  if (!req.organizationId) { res.status(403).json({ error: 'No organization context' }); return false; }
  if (admin && !isOrgAdmin(req)) { res.status(403).json({ error: 'Organization admin required' }); return false; }
  if (!admin && !isOrgAdmin(req) && !canAdmin(req)) { res.status(403).json({ error: 'Workspace admin required' }); return false; }
  return true;
}

/** Validate a create/update body for one kind. Returns fields to write, or { error }. */
function connFields(kind, b, existing = null) {
  const out = {};
  if (b.name !== undefined || !existing) { out.name = str(b.name, 120); if (!out.name) return { error: 'A name is required.' }; }
  out.read_only = b.read_only === undefined ? (existing ? existing.read_only : 0) : bool01(b.read_only);
  if (kind === 'm365') {
    if (b.tenant_id !== undefined || !existing) {
      out.tenant_id = str(b.tenant_id, 255);
      if (!graph.validTenant(out.tenant_id)) return { error: 'The tenant ID must be your directory (tenant) GUID or a verified domain — not common or organizations.' };
    }
    if (b.client_id !== undefined || !existing) { out.client_id = str(b.client_id, 255); if (!out.client_id) return { error: 'The application (client) ID is required.' }; }
    // Absent leaves the stored secret alone (the API never returns it); '' is refused rather than
    // silently breaking a working connection.
    if (b.client_secret !== undefined) {
      if (!b.client_secret) return { error: 'Enter the client secret, or leave it out to keep the stored one.' };
      out.secret_enc = secretbox.encrypt(String(b.client_secret));
    } else if (!existing) return { error: 'The client secret is required.' };
  } else {
    if (b.service_account_json !== undefined) {
      const k = google.parseKey(b.service_account_json);
      if (k.error) return { error: k.error };
      out.client_id = k.client_email;
      out.secret_enc = secretbox.encrypt(k.private_key);
    } else if (!existing) return { error: 'Paste the service account JSON key.' };
    if (b.subject !== undefined) {
      out.subject = str(b.subject, 255) || null;
      if (out.subject && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.subject)) return { error: 'The admin to act as must be an email address.' };
    }
  }
  return out;
}

router.get('/connections', (req, res) => {
  if (!requireOrg(req, res)) return;
  const rows = db.prepare('SELECT * FROM room_connections WHERE organization_id = ? ORDER BY created_at').all(req.organizationId);
  res.json({ connections: rows.map(connPublic), can_manage: isOrgAdmin(req) });
});

router.post('/connections', (req, res) => {
  if (!requireOrg(req, res, { admin: true })) return;
  const b = req.body || {};
  const kind = b.kind === 'google' ? 'google' : b.kind === 'm365' ? 'm365' : null;
  if (!kind) return res.status(400).json({ error: 'kind must be m365 or google' });
  const f = connFields(kind, b);
  if (f.error) return res.status(400).json({ error: f.error });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO room_connections (id, organization_id, kind, name, tenant_id, client_id, secret_enc, subject, read_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.organizationId, kind, f.name, f.tenant_id || null, f.client_id || null, f.secret_enc, f.subject || null, f.read_only);
  audit(req, 'room_connection_created', `${f.name} (${kind})`);
  res.status(201).json(connPublic(db.prepare('SELECT * FROM room_connections WHERE id = ?').get(id)));
});

function loadConn(req, res) {
  const row = db.prepare('SELECT * FROM room_connections WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!row) { res.status(404).json({ error: 'No such connection' }); return null; }
  return row;
}

router.put('/connections/:id', (req, res) => {
  if (!requireOrg(req, res, { admin: true })) return;
  const row = loadConn(req, res);
  if (!row) return;
  const f = connFields(row.kind, req.body || {}, row);
  if (f.error) return res.status(400).json({ error: f.error });
  const next = { ...row, ...f };
  db.prepare(`UPDATE room_connections SET name = ?, tenant_id = ?, client_id = ?, secret_enc = ?, subject = ?, read_only = ?,
    updated_at = strftime('%s','now') WHERE id = ?`).run(next.name, next.tenant_id, next.client_id, next.secret_enc, next.subject, next.read_only, row.id);
  // The cached copies were read with the old credentials; read again with the new ones.
  db.prepare('UPDATE rooms SET cache_at = NULL, next_poll_at = NULL, error_count = 0 WHERE connection_id = ?').run(row.id);
  audit(req, 'room_connection_updated', `${next.name} (${row.kind})`);
  res.json(connPublic(db.prepare('SELECT * FROM room_connections WHERE id = ?').get(row.id)));
});

router.delete('/connections/:id', (req, res) => {
  if (!requireOrg(req, res, { admin: true })) return;
  const row = loadConn(req, res);
  if (!row) return;
  const used = db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE connection_id = ?').get(row.id).n;
  if (used) return res.status(409).json({ error: `${used} room(s) still read their calendar through this connection. Move or remove them first.`, code: 'in-use' });
  db.prepare('DELETE FROM room_connections WHERE id = ?').run(row.id);
  audit(req, 'room_connection_deleted', `${row.name} (${row.kind})`);
  res.json({ success: true });
});

router.post('/connections/:id/test', async (req, res) => {
  if (!requireOrg(req, res, { admin: true })) return;
  if (!loadConn(req, res)) return;
  try {
    const conn = svc.connectionFor(req.params.id, req.organizationId);
    res.json(await svc.adapterOf(conn.kind).test(conn));
  } catch (e) {
    if (e instanceof RoomSourceError) return res.json({ ok: false, error: e.message });
    const src = icsSourceError(e);
    if (src) return res.json({ ok: false, error: src.message, code: src.code });
    sendErr(res, e);
  }
});

// The rooms a connection can see, to pick from. Workspace admins may use it to add a room.
router.get('/connections/:id/rooms', async (req, res) => {
  if (!requireOrg(req, res)) return;
  if (!loadConn(req, res)) return;
  try {
    const conn = svc.connectionFor(req.params.id, req.organizationId);
    res.json({ rooms: await svc.adapterOf(conn.kind).listRooms(conn) });
  } catch (e) { sendErr(res, e); }
});

/* ================================ org settings ================================ */

router.get('/settings', (req, res) => {
  if (!requireOrg(req, res)) return;
  res.json({ ...svc.orgSettings(req.organizationId), can_manage: isOrgAdmin(req) });
});

router.put('/settings', (req, res) => {
  if (!requireOrg(req, res, { admin: true })) return;
  const b = req.body || {};
  const cur = svc.orgSettings(req.organizationId);
  const endAny = b.end_any === undefined ? cur.end_any : !!b.end_any;
  let rel = b.release_min === undefined ? cur.release_min : Number(b.release_min);
  if (!Number.isInteger(rel) || rel < 0 || rel > 60) return res.status(400).json({ error: 'release_min must be a whole number of minutes from 0 (off) to 60.' });
  db.prepare('UPDATE organizations SET room_end_any = ?, room_release_min = ? WHERE id = ?').run(endAny ? 1 : 0, rel, req.organizationId);
  audit(req, 'room_settings_updated', `end_any=${endAny} release_min=${rel}`);
  res.json(svc.orgSettings(req.organizationId));
});

/* ================================ rooms ================================ */

function roomPublic(r) {
  let icsHost = null;
  if (r.ics_url_enc) { try { icsHost = new URL(secretbox.decrypt(r.ics_url_enc)).host; } catch { icsHost = null; } }
  return {
    id: r.id, name: r.name, source: r.source,
    connection_id: r.connection_id || null, calendar_id: r.calendar_id || null,
    has_ics_url: !!r.ics_url_enc, ics_host: icsHost,
    timezone: r.timezone, details: r.details, allow_booking: !!r.allow_booking,
    last_synced_at: r.cache_at || null, last_error: r.last_error || null,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

function roomFields(b, existing = null) {
  const out = {};
  if (b.name !== undefined || !existing) { out.name = str(b.name, 120); if (!out.name) return { error: 'A room name is required.' }; }
  const source = existing ? existing.source : b.source;
  if (!svc.SOURCES.has(source)) return { error: 'source must be m365, google or ics' };
  if (!existing) out.source = source;
  if (source === 'ics') {
    if (b.ics_url !== undefined) {
      const raw = str(b.ics_url, 2000).replace(/^webcal:\/\//i, 'https://');
      const bad = checkHttpUrl(raw, 'Calendar address');
      if (bad) return { error: bad };
      out.ics_url_enc = secretbox.encrypt(raw);
    } else if (!existing) return { error: 'The calendar (ICS) address is required.' };
  } else {
    if (b.connection_id !== undefined || !existing) {
      out.connection_id = str(b.connection_id, 64);
      if (!out.connection_id) return { error: 'Choose a calendar connection.' };
    }
    if (b.calendar_id !== undefined || !existing) {
      out.calendar_id = str(b.calendar_id, 255);
      if (!out.calendar_id) return { error: 'The room’s calendar (its email address) is required.' };
    }
  }
  if (b.timezone !== undefined || !existing) {
    out.timezone = str(b.timezone, 64) || 'UTC';
    if (!isRealTimezone(out.timezone)) return { error: `"${out.timezone}" is not a time zone. Use an IANA name such as Europe/London.` };
  }
  if (b.details !== undefined) {
    if (!svc.DETAILS.has(b.details)) return { error: 'details must be shown, private_hidden or hidden' };
    out.details = b.details;
  }
  if (b.allow_booking !== undefined) out.allow_booking = bool01(b.allow_booking);
  return out;
}

function connectionInOrg(req, id) {
  return !!db.prepare('SELECT 1 FROM room_connections WHERE id = ? AND organization_id = ?').get(id, req.organizationId);
}

/*
 * ⚠️ A connection is the ORGANIZATION's, and reads any mailbox its app can reach — on Microsoft 365,
 * without an ApplicationAccessPolicy, that is every mailbox in the tenant. So a workspace admin who
 * is not an org admin may point a room only at a calendar the connection itself lists as a room;
 * otherwise "calendar_id: ceo@corp.com" would publish that calendar on the room's unauthenticated
 * panel page, and with end-any on, let the panel decline its meetings. Fails closed: a connection
 * that cannot list its rooms (a Google one without delegation) is left to an org admin. Returns an
 * error message, or null.
 */
async function calendarAllowed(req, connectionId, calendarId) {
  if (isOrgAdmin(req)) return null;
  const refuse = 'Choose one of the rooms this connection lists. Only an organization admin can enter another calendar.';
  let listed;
  try {
    const conn = svc.connectionFor(connectionId, req.organizationId);
    const a = conn && svc.adapterOf(conn.kind);
    listed = a ? await a.listRooms(conn) : null;
  } catch (e) {
    listed = null;
  }
  if (!Array.isArray(listed)) return `The rooms this connection can see could not be listed. ${refuse}`;
  const want = String(calendarId || '').toLowerCase();
  return listed.some((r) => r && String(r.calendar_id || '').toLowerCase() === want) ? null : refuse;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json({ rooms: [] });
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const rows = db.prepare('SELECT * FROM rooms WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.workspaceId);
  res.json({ rooms: rows.map(roomPublic), can_manage: canAdmin(req) });
});

router.post('/', wrap(async (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const f = roomFields(req.body || {});
  if (f.error) return res.status(400).json({ error: f.error });
  if (f.connection_id && !connectionInOrg(req, f.connection_id)) return res.status(400).json({ error: 'That connection is not in this organization.' });
  if (f.source !== 'ics') {
    const bad = await calendarAllowed(req, f.connection_id, f.calendar_id);
    if (bad) return res.status(403).json({ error: bad, code: 'calendar-not-listed' });
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO rooms (id, workspace_id, name, source, connection_id, calendar_id, ics_url_enc, timezone, details, allow_booking)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.workspaceId, f.name, f.source, f.connection_id || null, f.calendar_id || null,
    f.ics_url_enc || null, f.timezone, f.details || 'private_hidden', f.allow_booking === undefined ? 1 : f.allow_booking);
  audit(req, 'room_created', `${f.name} (${f.source})`);
  res.status(201).json(roomPublic(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)));
}));

function loadRoom(req, res) {
  const r = req.workspaceId ? db.prepare('SELECT * FROM rooms WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId) : null;
  if (!r) { res.status(404).json({ error: 'No such room' }); return null; }
  return r;
}

router.put('/:id', wrap(async (req, res) => {
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const r = loadRoom(req, res);
  if (!r) return;
  const f = roomFields(req.body || {}, r);
  if (f.error) return res.status(400).json({ error: f.error });
  if (f.connection_id && !connectionInOrg(req, f.connection_id)) return res.status(400).json({ error: 'That connection is not in this organization.' });
  const n = { ...r, ...f };
  // Moving a room to another calendar or connection is checked like adding one; renaming it is not.
  if (r.source !== 'ics' && (n.connection_id !== r.connection_id || String(n.calendar_id || '').toLowerCase() !== String(r.calendar_id || '').toLowerCase())) {
    const bad = await calendarAllowed(req, n.connection_id, n.calendar_id);
    if (bad) return res.status(403).json({ error: bad, code: 'calendar-not-listed' });
  }
  const sourceChanged = n.connection_id !== r.connection_id || n.calendar_id !== r.calendar_id || n.ics_url_enc !== r.ics_url_enc || n.timezone !== r.timezone;
  db.prepare(`UPDATE rooms SET name = ?, connection_id = ?, calendar_id = ?, ics_url_enc = ?, timezone = ?, details = ?, allow_booking = ?,
    ${sourceChanged ? 'cache_json = NULL, cache_at = NULL, next_poll_at = NULL, error_count = 0, last_error = NULL,' : ''}
    updated_at = strftime('%s','now') WHERE id = ?`)
    .run(n.name, n.connection_id, n.calendar_id, n.ics_url_enc, n.timezone, n.details, n.allow_booking, r.id);
  audit(req, 'room_updated', n.name);
  res.json(roomPublic(db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.id)));
}));

router.delete('/:id', (req, res) => {
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const r = loadRoom(req, res);
  if (!r) return;
  // Foreign keys are off in production, so the children go explicitly.
  db.transaction(() => {
    db.prepare('DELETE FROM room_bookings WHERE room_id = ?').run(r.id);
    db.prepare('DELETE FROM room_checkins WHERE room_id = ?').run(r.id);
    db.prepare('DELETE FROM room_panel_presence WHERE room_id = ?').run(r.id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);
  })();
  audit(req, 'room_deleted', r.name);
  res.json({ success: true });
});

// Read the calendar now and say what the panel would show — the check an admin runs after setup.
router.post('/:id/test', async (req, res) => {
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const r = loadRoom(req, res);
  if (!r) return;
  try {
    const day = await svc.getDay(r.id, { force: true });
    const st = require('../lib/rooms/freebusy').computeRoomState(day.events, Date.now());
    res.json({ ok: true, events: day.events.length, busy: st.busy, free_until: st.freeUntil, busy_until: st.busyUntil });
  } catch (e) {
    if (e instanceof RoomSourceError) return res.json({ ok: false, error: e.message });
    const src = icsSourceError(e);
    if (src) return res.json({ ok: false, error: src.message, code: src.code });
    sendErr(res, e);
  }
});

module.exports = router;
module.exports.sendErr = sendErr; // tests
