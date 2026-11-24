'use strict';

/*
 * Curbside pickup, the side with no account (lib/curbside/service.js, docs/curbside-pickup.md).
 * Mounted in server.js at /api/public/curbside, outside every session router.
 *
 *   GET  /c/:token/state?spot=<label>   the customer page: the location, its words, whether the spot
 *                                       is taken, and this browser's own check-in. ?rev=<rev> that
 *                                       still matches answers {unchanged:true}.
 *   POST /c/:token/checkin              {spot, order_ref, note}: "I'm here".
 *   POST /c/:token/cancel               cancel this browser's open check-in.
 *   GET  /s/state                       the staff page: the open arrivals, oldest first.
 *   POST /s/ack {id} | /s/done {id}     "We got you" and "Done".
 *
 * The browser's client id travels in the X-Curbside-Client header, never in a URL (it is what can
 * cancel a check-in). The customer token is in the path; lib/limit-paths.js folds it out of
 * rate-limit buckets and 429 logs. The STAFF key never appears in a URL: the staff page keeps it in
 * its fragment and sends it in X-Curbside-Staff-Key. Answers never include a token or a client id.
 *
 * Limits (per client IP, on top of the coarse mount limit in server.js): 20 check-ins and 20 cancels
 * a minute, at most 2 OPEN check-ins per address per location (code 'open_limit'), 120 staff actions
 * a minute, 20 refused staff keys a minute.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const svc = require('../lib/curbside/service');
const { getClientIp } = require('../services/activity');

const ipOf = (req) => String(getClientIp(req) || req.ip || '');
// ⚠️ Limits, caps and lockouts count the NETWORK, never the exact address: one IPv6 host owns a whole
// /64, so keying on the address gave every rotated source a fresh budget (same as lib/pair-lockout.js).
const { ipKeyGenerator } = require('express-rate-limit');
const netOf = (req) => { const ip = ipOf(req); return ip ? ipKeyGenerator(ip, 64) : ''; };
// The per-address cap on open check-ins (service.js OPEN_PER_IP) counts a keyed hash, never the address.
const crypto = require('crypto');
const ipKeyOf = (req, loc) => crypto.createHmac('sha256', String(appConfig.jwtSecret || ''))
  .update(`curbside-ip|${loc.id}|${netOf(req)}`).digest('base64url').slice(0, 32);
const clientOf = (req) => { const v = req.get('x-curbside-client'); return typeof v === 'string' ? v.slice(0, 80) : null; };

/*
 * Scale-out (docs/scale-out.md): these calls land in the workspace the LOCATION belongs to, which no
 * session names. When that workspace is a copy on this node, EVERY call is forwarded to the primary,
 * reads included (a poll can roll the day over, and a copy's list is stale). Same guards as
 * routes/queue-public.js, before anything here reads or writes the location.
 */
const replicaProxy = require('../lib/replica-proxy');
const appConfig = require('../config');
function copiedLocation(loc) {
  if (!loc) return false;
  const ws = db.prepare('SELECT id, origin_node_id FROM workspaces WHERE id = ?').get(loc.workspace_id);
  return !!(ws && replicaProxy.isCopiedWorkspace(ws));
}
router.param('token', (req, res, next, token) => {
  if (copiedLocation(svc.byPublicToken(db, token))) return replicaProxy.proxyToPrimary(req, res, appConfig);
  next();
});
router.use('/s', (req, res, next) => {
  const key = req.get('x-curbside-staff-key');
  if (key && copiedLocation(svc.byStaffKey(db, key))) return replicaProxy.proxyToPrimary(req, res, appConfig);
  next();
});

// Bounded per-IP sliding windows.
const hits = new Map();
function limited(bucket, key, max, windowMs = 60000) {
  const k = bucket + '|' + key;
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
  if (list.length >= max) { hits.set(k, list); return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)); }
  list.push(now);
  hits.delete(k);
  hits.set(k, list);
  if (hits.size > 20000) hits.delete(hits.keys().next().value);
  return 0;
}
function limit(req, res, bucket, max) {
  const wait = limited(bucket, netOf(req), max);
  if (!wait) return false;
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: 'Too many requests, try again in a moment', code: 'rate_limited' });
  return true;
}

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

function send(res, e) {
  if (e instanceof svc.CurbsideError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[curbside] public error:', e && e.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

// ---- customer -------------------------------------------------------------------------------

function customerLocation(req, res) {
  const loc = svc.byPublicToken(db, req.params.token);
  if (!loc) { res.status(404).json({ error: 'This curbside link is not active', code: 'not_found' }); return null; }
  return svc.current(db, loc);
}

router.get('/c/:token/state', (req, res) => {
  try {
    const loc = customerLocation(req, res); if (!loc) return;
    const rev = svc.revOf(loc);
    if (typeof req.query.rev === 'string' && req.query.rev === rev) return res.json({ rev, unchanged: true });
    const spot = typeof req.query.spot === 'string' ? req.query.spot : null;
    res.json(svc.customerState(db, loc, { spot, clientId: clientOf(req) }));
  } catch (e) { send(res, e); }
});

router.post('/c/:token/checkin', (req, res) => {
  try {
    const loc = customerLocation(req, res); if (!loc) return;
    const b = req.body || {};
    const clientId = clientOf(req);
    // Asking again for the check-in this browser already has costs nothing and is never limited.
    const had = svc.clientArrival(db, loc, clientId);
    if (!(had && (had.status === 'waiting' || had.status === 'seen'))) {
      if (limit(req, res, 'checkin', 20)) return;
    }
    const r = svc.checkIn(db, loc, { spot: b.spot, orderRef: b.order_ref, note: b.note, clientId, ipKey: ipKeyOf(req, loc) });
    res.status(r.existing ? 200 : 201).json({ existing: r.existing, state: svc.customerState(db, r.location, { spot: r.arrival.spot, clientId }) });
  } catch (e) { send(res, e); }
});

router.post('/c/:token/cancel', (req, res) => {
  try {
    if (limit(req, res, 'cancel', 20)) return;
    const loc = customerLocation(req, res); if (!loc) return;
    const clientId = clientOf(req);
    const r = svc.cancel(db, loc, { clientId });
    res.json({ state: svc.customerState(db, r.location, { spot: r.arrival.spot, clientId }) });
  } catch (e) { send(res, e); }
});

// ---- staff ----------------------------------------------------------------------------------

function staffLocation(req, res) {
  const key = req.get('x-curbside-staff-key');
  const loc = key ? svc.byStaffKey(db, key) : null;
  if (!loc) {
    if (limit(req, res, 'staff-miss', 20)) return null;
    res.status(401).json({ error: 'This staff link is not valid any more. Ask for a new one.', code: 'staff_link' });
    return null;
  }
  return svc.current(db, loc);
}

router.get('/s/state', (req, res) => {
  try {
    const loc = staffLocation(req, res); if (!loc) return;
    res.json(svc.staffState(db, loc));
  } catch (e) { send(res, e); }
});

const ACTIONS = {
  ack: (loc, body) => svc.acknowledge(db, loc, body && body.id),
  done: (loc, body) => svc.done(db, loc, body && body.id),
};
for (const [name, fn] of Object.entries(ACTIONS)) {
  router.post(`/s/${name}`, (req, res) => {
    try {
      if (limit(req, res, 'staff', 120)) return;
      const loc = staffLocation(req, res); if (!loc) return;
      res.json(svc.staffState(db, fn(loc, req.body || {})));
    } catch (e) { send(res, e); }
  });
}

module.exports = router;
