'use strict';

/*
 * "Now serving" queues, the dashboard side (lib/queue/service.js, docs/now-serving-queue.md).
 * JWT only, on the caller's active workspace (config/api-surface.js): the staff link it hands out is
 * a credential, and API tokens are not given a way to mint one.
 *
 * Reading needs membership of the workspace. Everything that changes a queue (create, edit, delete,
 * Next, call a number, start of day, sound, links) needs write access: a read-only member
 * (workspace_viewer) is refused, the same rule as every other workspace resource (qr-links, widgets).
 *
 * ⚠️ THE STAFF LINK IS ONLY EVER SENT TO A MEMBER WHO CAN WRITE. A read-only member's answer has no
 * staff_url at all, and the token is never written to the activity log (only "rotated"/"revoked").
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const svc = require('../lib/queue/service');

const audit = (req, action, details) => logActivity(req.user.id, action, details, null, getClientIp(req), req.workspaceId || null);

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  const canWrite = !!ctx.actingAs || ctx.workspaceRole !== 'workspace_viewer';
  if (write && !canWrite) { res.status(403).json({ error: 'Read-only access' }); return null; }
  return { ...ctx, canWrite };
}

function load(req, res) {
  const q = db.prepare('SELECT * FROM queues WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!q) { res.status(404).json({ error: 'Queue not found' }); return null; }
  return svc.current(db, q);
}

function present(q, canWrite) {
  const out = {
    ...svc.staffState(db, q),
    customer_path: `/queue/${q.public_token}`,
    staff_link_active: !!q.staff_token,
    can_write: !!canWrite,
  };
  // The staff link is a capability: writers only, and only while it exists.
  if (canWrite && q.staff_token) out.staff_path = `/queue-staff#${q.id}.${q.staff_token}`;
  return out;
}

function send(res, e) {
  if (e instanceof svc.QueueError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

router.get('/', (req, res) => {
  const ctx = access(req, res); if (!ctx) return;
  const rows = db.prepare('SELECT * FROM queues WHERE workspace_id = ? ORDER BY created_at, name').all(req.workspaceId);
  res.json(rows.map((q) => present(svc.current(db, q), ctx.canWrite)));
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const b = req.body || {};
  if (b.timezone !== undefined && b.timezone !== null && b.timezone !== '' && !require('../lib/device-timezone').isRealTimezone(b.timezone)) {
    return res.status(400).json({ error: 'Not a timezone this server knows (use a name like Europe/Lisbon)' });
  }
  const q = svc.create(db, { workspaceId: req.workspaceId, name: b.name, timezone: b.timezone, maxPerDay: b.max_per_day, userId: req.user.id });
  audit(req, 'queue_created', `Queue "${q.name}" created`);
  res.status(201).json(present(q, true));
});

router.get('/:id', (req, res) => {
  const ctx = access(req, res); if (!ctx) return;
  const q = load(req, res); if (!q) return;
  res.json(present(q, ctx.canWrite));
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const q = load(req, res); if (!q) return;
  const b = req.body || {};
  try {
    const out = svc.update(db, q, { name: b.name, timezone: b.timezone, maxPerDay: b.max_per_day });
    res.json(present(out, true));
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const q = load(req, res); if (!q) return;
  db.transaction(() => {
    db.prepare('DELETE FROM queue_tickets WHERE queue_id = ?').run(q.id);
    db.prepare('DELETE FROM queue_events WHERE queue_id = ?').run(q.id);
    db.prepare('DELETE FROM queues WHERE id = ?').run(q.id);
  })();
  audit(req, 'queue_deleted', `Queue "${q.name}" deleted`);
  res.json({ success: true });
});

const ACTIONS = {
  next: (q) => svc.next(db, q, { source: 'dashboard' }),
  call: (q, b) => svc.call(db, q, b.number, { source: 'dashboard' }),
  reset: (q) => svc.reset(db, q, { source: 'dashboard' }),
  sound: (q, b) => svc.setSound(db, q, !!b.on, { source: 'dashboard' }),
};
for (const [name, fn] of Object.entries(ACTIONS)) {
  router.post(`/:id/${name}`, (req, res) => {
    if (!access(req, res, { write: true })) return;
    const q = load(req, res); if (!q) return;
    try { res.json(present(fn(q, req.body || {}), true)); } catch (e) { send(res, e); }
  });
}

// A new staff link: the old one stops working at once.
router.post('/:id/staff-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const q = load(req, res); if (!q) return;
  const out = svc.rotateStaff(db, q);
  audit(req, 'queue_staff_link_rotated', `Queue "${q.name}": staff link replaced`);
  res.json(present(out, true));
});
// No staff link at all until a new one is made.
router.delete('/:id/staff-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const q = load(req, res); if (!q) return;
  const out = svc.revokeStaff(db, q);
  audit(req, 'queue_staff_link_revoked', `Queue "${q.name}": staff link turned off`);
  res.json(present(out, true));
});
// A new customer link (and so a new QR code): for a printed code that should stop working.
router.post('/:id/customer-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const q = load(req, res); if (!q) return;
  const out = svc.rotatePublic(db, q);
  audit(req, 'queue_customer_link_rotated', `Queue "${q.name}": customer link and QR code replaced`);
  res.json(present(out, true));
});

/**
 * The customer QR code as SVG (same drawing as routes/qr-links.js). `origin` is the address phones
 * reach; the dashboard passes its own, else APP_URL, else this request's.
 */
router.get('/:id/qr.svg', (req, res) => {
  if (!access(req, res)) return;
  const q = load(req, res); if (!q) return;
  const origin = publicOrigin(req, req.query.origin);
  const svg = require('../lib/slide-render').qrSvg(`${origin}/queue/${q.public_token}`, 'M', '#000000', '#FFFFFF');
  if (!svg) return res.status(500).json({ error: 'Could not draw the QR code' });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg.startsWith('<?xml') || svg.startsWith('<svg') ? svg : `<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
});

function publicOrigin(req, asked) {
  const ok = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
  return ok(asked) || ok(process.env.APP_URL) || `${req.protocol}://${req.get('host')}`;
}

module.exports = router;
