'use strict';

/*
 * "Now serving" queues, the side with no account (lib/queue/service.js, docs/now-serving-queue.md).
 * Mounted in server.js at /api/public/queue, outside every session router.
 *
 *   GET  /c/:token/state      the customer page's poll: the number being served and the queue's
 *                             revision. ?rev=<rev> that still matches answers {unchanged:true}.
 *   POST /c/:token/ticket     take a number. Body {client_id}: a random id the browser made and keeps
 *                             for the day, so a second scan (or a retry) gets the same number back.
 *   GET  /s/state             the staff page: state plus the last 20 events.
 *   POST /s/next | /s/call {number} | /s/reset | /s/sound {on}
 *
 * The customer token is in the path; the access log only ever writes the route template, and
 * lib/limit-paths.js folds it out of rate-limit buckets so a 429 line never carries it. The STAFF
 * key never appears in a URL at all: the staff page keeps it in its fragment and sends it in the
 * X-Queue-Staff-Key header. Answers never include either token.
 *
 * Limits (per client IP, on top of the coarse mount limit in server.js): 20 new tickets a minute,
 * 120 staff actions a minute, and 20 refused staff keys a minute. The daily ticket cap lives on the
 * queue (max_per_day, 1..9999, default 999).
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const svc = require('../lib/queue/service');
const { getClientIp } = require('../services/activity');

const ipOf = (req) => String(getClientIp(req) || req.ip || '');

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
  const wait = limited(bucket, ipOf(req), max);
  if (!wait) return false;
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: 'Too many requests, try again in a moment', code: 'rate_limited' });
  return true;
}

function quiet(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
router.use((req, res, next) => { quiet(res); next(); });

function send(res, e) {
  if (e instanceof svc.QueueError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[queue] public error:', e && e.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

// ---- customer -------------------------------------------------------------------------------

function customerQueue(req, res) {
  const q = svc.byPublicToken(db, req.params.token);
  if (!q) { res.status(404).json({ error: 'This queue link is not active', code: 'not_found' }); return null; }
  return svc.current(db, q);
}

router.get('/c/:token/state', (req, res) => {
  try {
    const q = customerQueue(req, res); if (!q) return;
    const rev = svc.revOf(q);
    if (typeof req.query.rev === 'string' && req.query.rev === rev) return res.json({ rev, unchanged: true });
    res.json(svc.customerState(q));
  } catch (e) { send(res, e); }
});

router.post('/c/:token/ticket', (req, res) => {
  try {
    const q = customerQueue(req, res); if (!q) return;
    const clientId = req.body && typeof req.body.client_id === 'string' ? req.body.client_id : null;
    // A repeat of a ticket this browser already holds costs nothing and is never limited.
    if (clientId) {
      const had = db.prepare('SELECT number FROM queue_tickets WHERE queue_id = ? AND round = ? AND client_id = ?').get(q.id, q.round, clientId);
      if (had) return res.json({ number: had.number, existing: true, state: svc.customerState(q) });
    }
    if (limit(req, res, 'ticket', 20)) return;
    const r = svc.takeTicket(db, q, { clientId });
    res.status(r.existing ? 200 : 201).json({ number: r.number, existing: r.existing, state: svc.customerState(r.queue) });
  } catch (e) { send(res, e); }
});

// ---- staff ----------------------------------------------------------------------------------

function staffQueue(req, res) {
  const key = req.get('x-queue-staff-key');
  const q = key ? svc.byStaffKey(db, key) : null;
  if (!q) {
    if (limit(req, res, 'staff-miss', 20)) return null;
    res.status(401).json({ error: 'This staff link is not valid any more. Ask for a new one.', code: 'staff_link' });
    return null;
  }
  return svc.current(db, q);
}

router.get('/s/state', (req, res) => {
  try {
    const q = staffQueue(req, res); if (!q) return;
    res.json(svc.staffState(db, q));
  } catch (e) { send(res, e); }
});

const ACTIONS = {
  next: (q) => svc.next(db, q, { source: 'staff_link' }),
  call: (q, body) => svc.call(db, q, body && body.number, { source: 'staff_link' }),
  reset: (q) => svc.reset(db, q, { source: 'staff_link' }),
  sound: (q, body) => svc.setSound(db, q, !!(body && body.on), { source: 'staff_link' }),
};
for (const [name, fn] of Object.entries(ACTIONS)) {
  router.post(`/s/${name}`, (req, res) => {
    try {
      if (limit(req, res, 'staff', 120)) return;
      const q = staffQueue(req, res); if (!q) return;
      res.json(svc.staffState(db, fn(q, req.body || {})));
    } catch (e) { send(res, e); }
  });
}

module.exports = router;
