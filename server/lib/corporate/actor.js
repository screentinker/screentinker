'use strict';

/*
 * WHO is making this change — carried through the async call chain, so code far below a route
 * (a lib writer, a SQLite trigger's UDF) can ask without being handed `req`.
 *
 * The store is set at the END of resolveTenancy (lib/tenancy.js), wrapping next(), so every router
 * family — PUBLIC (token door), JWT_ONLY with tenancy, AGENCY — runs inside it. MCP re-enters this
 * server over loopback HTTP and so gets the caller's own actor. The dashboard socket does NOT pass
 * resolveTenancy: its handlers build an actor with fromUser(socket.user) and pass it EXPLICITLY.
 *
 * ⚠️ authorOrgIds/adminOrgIds are COMPUTED UP FRONT, never lazily. The backstop's UDFs
 * (lib/corporate/backstop.js) read them from inside a running INSERT/UPDATE/DELETE, and
 * better-sqlite3 refuses any query on a connection that is busy executing a statement — a lazy
 * lookup there would throw in the middle of a write.
 *
 * ⚠️ API tokens and agency tokens get EMPTY sets, always. A token acts as its owner with role
 * forced to 'user' (middleware/apiToken.js), and accessContext gives an org admin acting-as WRITE —
 * so a token minted by an org admin would otherwise be able to author corporate content. Authoring
 * is a signed-in, human action (decision D12).
 *
 * runAsSystem: background work that can be SCHEDULED from inside a request — the smart-playlist
 * debounce timer, a republish of ancestors, the corporate sweep — runs outside the request's
 * store, so a timer started by a store user's upload is not judged as that store user.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
// A separate, lightweight marker: "an HTTP request is being served". Set by the first middleware
// in server.js for EVERY request (authenticated or not), so the tripwire can tell "system work"
// from "a request whose actor got lost".
const httpAls = new AsyncLocalStorage();

let _isPlatformRole = null;
function isPlatformRole(role) {
  if (!_isPlatformRole) _isPlatformRole = require('../../middleware/auth').isPlatformRole;
  return _isPlatformRole(role);
}
let _isPlatformStaff = null;
function isPlatformStaff(role) {
  if (!_isPlatformStaff) _isPlatformStaff = require('../../middleware/auth').isPlatformStaff;
  return _isPlatformStaff(role);
}

const SETS_SQL = `
  SELECT om.organization_id AS org, 'admin' AS kind
    FROM organization_members om
   WHERE om.user_id = ? AND om.role IN ('org_owner', 'org_admin')
  UNION ALL
  SELECT o.id AS org, 'author' AS kind
    FROM organizations o
    JOIN workspace_members wm ON wm.workspace_id = o.hq_workspace_id
   WHERE wm.user_id = ? AND wm.role IN ('workspace_admin', 'workspace_editor')
     AND o.corporate_authors = 'org_admins_and_hq_editors'`;

/**
 * Build an actor for a user. Never throws: a database without the corporate columns (a hand-built
 * fixture, a degraded boot) yields an actor that authors nothing — fail closed for authoring,
 * which changes nothing anywhere else.
 */
function fromUser(user, { viaToken = false, tokenScope = null } = {}) {
  const role = user && user.role;
  const actor = {
    userId: (user && user.id) || null,
    role: role || null,
    viaToken: !!viaToken,
    tokenScope: tokenScope || null,
    agency: tokenScope === 'agency',
    isPlatformAdmin: !viaToken && isPlatformRole(role),
    isPlatformStaff: !viaToken && isPlatformStaff(role),
    authorOrgIds: new Set(),
    adminOrgIds: new Set(),
  };
  if (!actor.userId || viaToken) return actor;
  if (actor.isPlatformAdmin) {
    actor.authorOrgIds.add('*');
    actor.adminOrgIds.add('*');
    return actor;
  }
  try {
    const { db } = require('../../db/database');
    for (const r of db.prepare(SETS_SQL).all(actor.userId, actor.userId)) {
      actor.authorOrgIds.add(r.org);
      if (r.kind === 'admin') actor.adminOrgIds.add(r.org);
    }
  } catch (_) {
    // Columns or tables absent: no authoring rights. organization_members alone may still work.
    try {
      const { db } = require('../../db/database');
      for (const r of db.prepare(
        "SELECT organization_id AS org FROM organization_members WHERE user_id = ? AND role IN ('org_owner','org_admin')"
      ).all(actor.userId)) { actor.authorOrgIds.add(r.org); actor.adminOrgIds.add(r.org); }
    } catch (_) { /* nothing */ }
  }
  return actor;
}

/** The actor for a request (memoised on req). */
function fromReq(req) {
  if (!req) return null;
  if (req._corpActor) return req._corpActor;
  if (!req.user) return null;
  req._corpActor = fromUser(req.user, { viaToken: !!req.viaToken, tokenScope: req.tokenScope || null });
  return req._corpActor;
}

/** The ambient actor (ALS), or null when running as system. */
function current() {
  return als.getStore() || null;
}

/** The actor that should be judged: an explicit one, else the request's, else the ambient one. */
function resolve(reqOrActor) {
  if (reqOrActor && reqOrActor.authorOrgIds instanceof Set) return reqOrActor;
  if (reqOrActor && (reqOrActor.user || reqOrActor._corpActor)) return fromReq(reqOrActor);
  return current();
}

function canAuthorOrg(actor, orgId) {
  if (!actor) return true;               // system
  if (actor.viaToken) return false;
  return actor.authorOrgIds.has('*') || (!!orgId && actor.authorOrgIds.has(orgId));
}

function isOrgAdminOf(actor, orgId) {
  if (!actor) return true;               // system
  if (actor.viaToken) return false;
  return actor.adminOrgIds.has('*') || (!!orgId && actor.adminOrgIds.has(orgId));
}

function runWithActor(actor, fn) { return als.run(actor, fn); }

/** Run fn with NO actor (system), also outside the HTTP marker so the tripwire stays quiet. */
function runAsSystem(fn) {
  return als.exit(() => httpAls.exit(fn));
}

/** Wrap a callback (a timer body) so it always runs as system, wherever it was scheduled from. */
function bindSystem(fn) {
  return function systemBound(...args) { return runAsSystem(() => fn.apply(this, args)); };
}

/* ── Tripwire: a write with no actor while an HTTP request is being served ─────────────────── */

let _tripwireCount = 0;
const _lastLogged = new Map();   // route -> ms
function noteActorlessWrite() {
  const h = httpAls.getStore();
  if (!h) return;
  _tripwireCount++;
  const key = `${h.method} ${h.path}`;
  const now = Date.now();
  const last = _lastLogged.get(key) || 0;
  if (now - last < 60000) return;
  _lastLogged.set(key, now);
  if (_lastLogged.size > 500) _lastLogged.clear();
  console.warn(`[corporate] backstop: write with no actor inside an HTTP request (${key})`);
}
function tripwireCount() { return _tripwireCount; }
function resetTripwire() { _tripwireCount = 0; _lastLogged.clear(); }

/** Express middleware: mark "an HTTP request is being served". Mount FIRST. */
function httpMarker(req, res, next) {
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/[0-9a-f-]{16,}/gi, ':id');
  httpAls.run({ method: req.method, path }, next);
}

module.exports = {
  als, httpAls, fromUser, fromReq, current, resolve, canAuthorOrg, isOrgAdminOf,
  runWithActor, runAsSystem, bindSystem, noteActorlessWrite, tripwireCount, resetTripwire, httpMarker,
};
