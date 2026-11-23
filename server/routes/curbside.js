'use strict';

/*
 * Curbside pickup, the dashboard side (lib/curbside/service.js, docs/curbside-pickup.md).
 * JWT only, on the caller's active workspace (config/api-surface.js): the staff link it hands out is
 * a credential, and API tokens are not given a way to mint one.
 *
 * Reading needs membership of the workspace. Everything that changes a location (create, edit,
 * delete, "We got you", Done, links) needs write access: a read-only member (workspace_viewer) is
 * refused, the same rule as queues (routes/queues.js) and every other workspace resource.
 *
 * ⚠️ THE STAFF LINK IS ONLY EVER SENT TO A MEMBER WHO CAN WRITE, and never written to the activity log.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const { isRealTimezone } = require('../lib/device-timezone');
const svc = require('../lib/curbside/service');
const texts = require('../lib/curbside/texts');

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
  const loc = db.prepare('SELECT * FROM curbside_locations WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!loc) { res.status(404).json({ error: 'Location not found' }); return null; }
  return svc.current(db, loc);
}

function present(loc, canWrite) {
  const out = {
    ...svc.staffState(db, loc),
    customer_path: `/curbside/${loc.public_token}`,
    texts: svc.overridesOf(loc),
    text_defaults: texts.DEFAULTS,
    text_max: texts.MAX,
    staff_link_active: !!loc.staff_token,
    can_write: !!canWrite,
  };
  // The staff link is a capability: writers only, and only while it exists.
  if (canWrite && loc.staff_token) out.staff_path = `/curbside-staff#${loc.id}.${loc.staff_token}`;
  return out;
}

function send(res, e) {
  if (e instanceof svc.CurbsideError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

router.get('/', (req, res) => {
  const ctx = access(req, res); if (!ctx) return;
  const rows = db.prepare('SELECT * FROM curbside_locations WHERE workspace_id = ? ORDER BY created_at, name').all(req.workspaceId);
  res.json(rows.map((l) => present(svc.current(db, l), ctx.canWrite)));
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const b = req.body || {};
  if (b.timezone !== undefined && b.timezone !== null && b.timezone !== '' && !isRealTimezone(b.timezone)) {
    return res.status(400).json({ error: 'Not a timezone this server knows (use a name like Europe/Lisbon)' });
  }
  try {
    let loc = svc.create(db, { workspaceId: req.workspaceId, name: b.name, timezone: b.timezone, spots: b.spots, spotsCount: b.spots_count, userId: req.user.id });
    if (b.texts !== undefined) loc = svc.update(db, loc, { texts: b.texts });
    audit(req, 'curbside_created', `Curbside location "${loc.name}" created`);
    res.status(201).json(present(loc, true));
  } catch (e) { send(res, e); }
});

router.get('/:id', (req, res) => {
  const ctx = access(req, res); if (!ctx) return;
  const loc = load(req, res); if (!loc) return;
  res.json(present(loc, ctx.canWrite));
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const loc = load(req, res); if (!loc) return;
  const b = req.body || {};
  try {
    const out = svc.update(db, loc, { name: b.name, timezone: b.timezone, spots: b.spots, spotsCount: b.spots_count, texts: b.texts });
    res.json(present(out, true));
  } catch (e) { send(res, e); }
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const loc = load(req, res); if (!loc) return;
  db.transaction(() => {
    db.prepare('DELETE FROM curbside_arrivals WHERE location_id = ?').run(loc.id);
    db.prepare('DELETE FROM curbside_locations WHERE id = ?').run(loc.id);
  })();
  audit(req, 'curbside_deleted', `Curbside location "${loc.name}" deleted`);
  res.json({ success: true });
});

const ACTIONS = {
  ack: (loc, b) => svc.acknowledge(db, loc, b.id),
  done: (loc, b) => svc.done(db, loc, b.id),
};
for (const [name, fn] of Object.entries(ACTIONS)) {
  router.post(`/:id/${name}`, (req, res) => {
    if (!access(req, res, { write: true })) return;
    const loc = load(req, res); if (!loc) return;
    try { res.json(present(fn(loc, req.body || {}), true)); } catch (e) { send(res, e); }
  });
}

// A new staff link: the old one stops working at once.
router.post('/:id/staff-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const loc = load(req, res); if (!loc) return;
  const out = svc.rotateStaff(db, loc);
  audit(req, 'curbside_staff_link_rotated', `Curbside location "${loc.name}": staff link replaced`);
  res.json(present(out, true));
});
// No staff link at all until a new one is made.
router.delete('/:id/staff-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const loc = load(req, res); if (!loc) return;
  const out = svc.revokeStaff(db, loc);
  audit(req, 'curbside_staff_link_revoked', `Curbside location "${loc.name}": staff link turned off`);
  res.json(present(out, true));
});
// A new customer link (and so new QR codes for every spot): for printed codes that should stop working.
router.post('/:id/customer-link', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const loc = load(req, res); if (!loc) return;
  const out = svc.rotatePublic(db, loc);
  audit(req, 'curbside_customer_link_rotated', `Curbside location "${loc.name}": customer link and QR codes replaced`);
  res.json(present(out, true));
});

function publicOrigin(req, asked) {
  const ok = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
  return ok(asked) || ok(process.env.APP_URL) || `${req.protocol}://${req.get('host')}`;
}

/**
 * The QR sheet: one QR code per spot, each opening the customer page for that spot. JSON
 * [{spot, url, svg}], drawn by this server's QR library (lib/slide-render.js qrSvg) from URLs it
 * built. `origin` is the address phones reach; the dashboard passes its own, else APP_URL, else this
 * request's.
 */
router.get('/:id/qr-sheet', (req, res) => {
  if (!access(req, res)) return;
  const loc = load(req, res); if (!loc) return;
  const origin = publicOrigin(req, req.query.origin);
  const { qrSvg } = require('../lib/slide-render');
  const codes = [];
  for (const spot of svc.spotsOf(loc)) {
    const url = `${origin}/curbside/${loc.public_token}?spot=${encodeURIComponent(spot)}`;
    const svg = qrSvg(url, 'M', '#000000', '#FFFFFF');
    if (!svg) return res.status(500).json({ error: 'Could not draw the QR codes' });
    codes.push({ spot, url, svg });
  }
  res.setHeader('Cache-Control', 'no-store');
  const words = texts.customerTexts(svc.overridesOf(loc));
  res.json({ name: loc.name, heading: words.heading, spot_label: words.spot_label, codes });
});

module.exports = router;
