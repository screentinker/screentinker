'use strict';

/*
 * Alert channels (lib/alert-channels.js) — Settings → Alerts.
 *
 * JWT only (config/api-surface.js): a channel holds credentials into someone else's systems.
 * Reading needs workspace membership and returns MASKED credentials; changing a channel needs a
 * workspace admin (or an org admin acting as one).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const ch = require('../lib/alert-channels');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && !ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
    res.status(403).json({ error: 'Only a workspace admin can change alert channels.', code: 'ALERTS_ADMIN_REQUIRED' }); return null;
  }
  return ctx;
}
function load(req, res) {
  const row = db.prepare('SELECT * FROM alert_channels WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) { res.status(404).json({ error: 'Channel not found' }); return null; }
  return row;
}
function audit(req, action, details) {
  try { require('../lib/audit').audit(action, { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details }); } catch (_) { /* */ }
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  res.json(db.prepare('SELECT * FROM alert_channels WHERE workspace_id = ? ORDER BY name').all(req.workspaceId).map((r) => ch.present(db, r)));
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const { fields, error } = ch.normaliseInput(req.body);
  if (error) return res.status(400).json({ error });
  const sc = ch.validateScopes(db, req.workspaceId, req.body.scopes === undefined ? [{ scope_kind: 'workspace' }] : req.body.scopes);
  if (sc.error) return res.status(400).json({ error: sc.error });
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO alert_channels (id, workspace_id, user_id, kind, name, config, events, offline_minutes, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.workspaceId, req.user.id, fields.kind, fields.name, fields.config,
      fields.events, fields.offline_minutes ?? 5, fields.enabled ?? 1);
    ch.setScopes(db, id, sc.rows);
  })();
  audit(req, 'alert_channel.create', { channel_id: id, kind: fields.kind, name: fields.name });
  res.status(201).json(ch.present(db, db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(id)));
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const { fields, error } = ch.normaliseInput(req.body, row);
  if (error) return res.status(400).json({ error });
  const sc = ch.validateScopes(db, req.workspaceId, req.body.scopes);
  if (sc.error) return res.status(400).json({ error: sc.error });
  db.transaction(() => {
    const cols = Object.keys(fields);
    if (cols.length) db.prepare(`UPDATE alert_channels SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ ...fields, id: row.id });
    if (sc.rows) ch.setScopes(db, row.id, sc.rows);
  })();
  audit(req, 'alert_channel.update', { channel_id: row.id, fields: Object.keys(fields).filter((k) => k !== 'config'), credentials_changed: fields.config !== row.config });
  res.json(ch.present(db, db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(row.id)));
});

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  db.prepare('DELETE FROM alert_channels WHERE id = ?').run(row.id);
  audit(req, 'alert_channel.delete', { channel_id: row.id, kind: row.kind, name: row.name });
  res.json({ success: true });
});

/** Send one test message now. */
router.post('/:id/test', async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const row = load(req, res); if (!row) return;
  const r = await ch.sendTest(db, row);
  res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

module.exports = router;
