'use strict';

/*
 * Tracked QR links (lib/qr-links.js): /api/qr-links. Token-reachable like other workspace content;
 * reading needs membership, changing needs an editor (not a viewer). The public redirect /q/:code
 * is mounted separately in server.js.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const qr = require('../lib/qr-links');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  return ctx;
}
function load(req, res) {
  const row = db.prepare('SELECT * FROM qr_links WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) { res.status(404).json({ error: 'QR link not found' }); return null; }
  return row;
}
function present(row) {
  const s = qr.stats(db, row.id);
  return { id: row.id, name: row.name, code: row.code, path: `/q/${row.code}`, target_url: row.target_url, enabled: !!row.enabled,
    scans: s.total, last_7_days: s.last_7_days, last_scan_at: s.last_scan_at, created_at: row.created_at, updated_at: row.updated_at };
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  res.json(db.prepare('SELECT * FROM qr_links WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId).map(present));
});

router.get('/:id', (req, res) => {
  if (!access(req, res)) return;
  const row = load(req, res); if (!row) return;
  res.json({ ...present(row), stats: qr.stats(db, row.id) });
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const { fields, error } = qr.normaliseInput(req.body);
  if (error) return res.status(400).json({ error });
  const id = crypto.randomUUID();
  let code;
  for (let i = 0; i < 5; i++) { code = qr.newCode(); if (!db.prepare('SELECT 1 FROM qr_links WHERE code = ?').get(code)) break; }
  db.prepare('INSERT INTO qr_links (id, workspace_id, user_id, code, name, target_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.workspaceId, req.user.id, code, fields.name, fields.target_url);
  res.status(201).json(present(db.prepare('SELECT * FROM qr_links WHERE id = ?').get(id)));
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const { fields, error } = qr.normaliseInput(req.body, row);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(fields);
  if (cols.length) db.prepare(`UPDATE qr_links SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ ...fields, id: row.id });
  res.json(present(db.prepare('SELECT * FROM qr_links WHERE id = ?').get(row.id)));
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  db.prepare('DELETE FROM qr_links WHERE id = ?').run(row.id);
  res.json({ success: true });
});

/**
 * The QR itself, as SVG, for printing or for any content. `origin` is the public address phones
 * reach (the dashboard passes its own); it defaults to APP_URL, then this request's origin.
 */
router.get('/:id/qr.svg', (req, res) => {
  if (!access(req, res)) return;
  const row = load(req, res); if (!row) return;
  const origin = publicOrigin(req, req.query.origin);
  const svg = require('../lib/slide-render').qrSvg(`${origin}/q/${row.code}`, 'M', '#000000', '#FFFFFF');
  if (!svg) return res.status(500).json({ error: 'Could not draw the QR code' });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `inline; filename="qr-${row.code}.svg"`);
  res.send(svg.startsWith('<?xml') || svg.startsWith('<svg') ? svg : `<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
});

function publicOrigin(req, asked) {
  const ok = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
  return ok(asked) || ok(process.env.APP_URL) || `${req.protocol}://${req.get('host')}`;
}

/** GET /q/:code — the public redirect a phone opens after scanning (mounted in server.js). */
function redirect(req, res) {
  const code = String(req.params.code || '').slice(0, 32);
  let hit = null;
  try { hit = qr.recordScan(db, code, { ip: req.ip, ua: req.get('user-agent') }); } catch (e) { hit = null; }
  res.setHeader('Cache-Control', 'no-store');   // every scan must reach the server to be counted
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!hit || hit.disabled) {
    return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found</title><body style="font-family:system-ui,sans-serif;padding:2em;text-align:center"><h1>This code is no longer active</h1></body>');
  }
  res.redirect(302, hit.link.target_url);
}

module.exports = router;
module.exports.redirect = redirect;
