'use strict';

/*
 * Zapier — and any other REST-hook client (Make, n8n, Power Automate's HTTP webhook trigger).
 * The app definition that calls this lives in /zapier; docs/automation.md explains both.
 *
 *   GET    /me                       auth test: which workspace this token is for
 *   GET    /events?event=…           polling fallback + Zapier's sample data (newest first)
 *   POST   /subscriptions            REST hook subscribe { event, target_url } → { id, secret }
 *   DELETE /subscriptions/:id        REST hook unsubscribe
 *   GET    /options/:kind            dynamic dropdowns: groups, playlists, triggers, tables, screens
 *   POST   /actions/emergency        raise / clear an emergency alert
 *   POST   /actions/playlist         switch screens to a playlist for N minutes / stop
 *   POST   /actions/trigger          fire / clear a trigger
 *   POST   /actions/data             write rows to a Table data source
 *
 * Scopes (API tokens; a JWT session passes requireScope and is role-checked instead): read for the
 * auth test, polling and dropdowns; write for subscribing and the data action (the token door
 * already treats every POST/DELETE as a write); full for anything that takes over screens. The actions
 * run through the same code as inbound hooks (lib/automation/hooks.js), so a Zapier alert and a
 * hook alert are the same thing on screen and in the log.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { resourceAccess } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const events = require('../lib/automation/events');
const hooks = require('../lib/automation/hooks');

function access(req, res, { admin = false, write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && (admin || write) && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  if (admin && !ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
    res.status(403).json({ error: 'Only a workspace admin can take over screens.', code: 'AUTOMATION_ADMIN_REQUIRED' }); return null;
  }
  return { ws, ctx };
}

router.get('/me', requireScope('read'), (req, res) => {
  const a = access(req, res); if (!a) return;
  res.json({
    workspace_id: a.ws.id, workspace_name: a.ws.name,
    token: req.apiToken ? { name: req.apiToken.name, prefix: req.apiToken.prefix, scope: req.tokenScope } : null,
    events: events.EVENTS,
  });
});

router.get('/events', requireScope('read'), (req, res) => {
  if (!access(req, res)) return;
  const type = String(req.query.event || '');
  if (!events.EVENTS.includes(type)) return res.status(400).json({ error: `event must be one of: ${events.EVENTS.join(', ')}` });
  const list = events.recent(db, req.workspaceId, type, req.query.limit);
  // Zapier's "test trigger" step needs something to map fields from even on a quiet workspace.
  res.json(list.length || req.query.sample === '0' ? list : [events.sample(type, req.workspaceId)]);
});

function checkTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return 'target_url must be a URL'; }
  if (u.protocol !== 'https:') return 'target_url must start with https://';
  if (u.username || u.password) return 'target_url must not contain a username or password';
  if (String(raw).length > 2000) return 'target_url is too long';
  return null;
}

router.post('/subscriptions', requireScope('write'), (req, res) => {
  if (!access(req, res)) return;
  const b = req.body || {};
  const event = String(b.event || '');
  if (!events.EVENTS.includes(event)) return res.status(400).json({ error: `event must be one of: ${events.EVENTS.join(', ')}` });
  const e = checkTarget(b.target_url || b.hookUrl);
  if (e) return res.status(400).json({ error: e });
  const n = db.prepare('SELECT COUNT(*) AS n FROM automation_subscriptions WHERE workspace_id = ?').get(req.workspaceId).n;
  if (n >= 200) return res.status(409).json({ error: 'A workspace can have up to 200 subscriptions.' });
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO automation_subscriptions (id, workspace_id, token_id, user_id, event, target_url, secret_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.workspaceId, req.apiToken ? req.apiToken.id : null, req.user ? req.user.id : null, event,
      String(b.target_url || b.hookUrl).trim(), require('../lib/secretbox').encrypt(secret));
  logActivity(req.user ? req.user.id : null, 'automation:subscribed', `${event} via ${req.apiToken ? `token ${req.apiToken.prefix}` : 'session'}`, null, getClientIp(req), req.workspaceId);
  // The signing secret is returned once, so a receiver that wants to verify deliveries can.
  res.status(201).json({ id, event, signing_secret: secret });
});

router.delete('/subscriptions/:id', requireScope('write'), (req, res) => {
  if (!access(req, res)) return;
  const r = db.prepare('DELETE FROM automation_subscriptions WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  if (r.changes) db.prepare("UPDATE automation_deliveries SET status = 'failed', last_error = 'unsubscribed' WHERE subscription_id = ? AND status = 'pending'").run(req.params.id);
  // Idempotent: Zapier retries an unsubscribe, and "already gone" is success.
  res.json({ ok: true, removed: r.changes > 0 });
});

router.get('/options/:kind', requireScope('read'), (req, res) => {
  if (!access(req, res)) return;
  const ws = req.workspaceId;
  const q = {
    groups: () => db.prepare('SELECT id, name FROM device_groups WHERE workspace_id = ? ORDER BY name').all(ws),
    playlists: () => db.prepare('SELECT id, name FROM playlists WHERE workspace_id = ? ORDER BY name').all(ws),
    triggers: () => db.prepare("SELECT id, name FROM triggers WHERE workspace_id = ? AND COALESCE(kind, '') != 'emergency' ORDER BY name").all(ws),
    tables: () => db.prepare("SELECT id, name FROM data_sources WHERE workspace_id = ? AND type = 'table' ORDER BY name").all(ws),
    screens: () => db.prepare('SELECT id, name FROM devices WHERE workspace_id = ? ORDER BY name').all(ws),
  }[req.params.kind];
  if (!q) return res.status(404).json({ error: 'Unknown option list' });
  res.json(q());
});

/* ============================== actions ============================== */

/** Screens for an action: explicit scopes, or group_id / device_id / tag shortcuts Zapier can fill. */
function scopesFrom(b) {
  if (Array.isArray(b.scopes) && b.scopes.length) return b.scopes;
  const out = [];
  for (const g of [].concat(b.group_id || [])) if (g) out.push({ scope_kind: 'group', scope_id: g });
  for (const d of [].concat(b.device_id || [])) if (d) out.push({ scope_kind: 'device', scope_id: d });
  for (const t of [].concat(b.tag || [])) if (t) out.push({ scope_kind: 'tag', scope_id: t });
  return out.length ? out : [{ scope_kind: 'workspace' }];
}

/**
 * The workspace's Zapier hook for a kind, created on first use. A real hook row, so what Zapier
 * raised shows on the Automation page and can be cleared or deleted there. It has no usable URL
 * (its secret is never shown) until an admin rotates it.
 */
function zapierHook(req, kind, config) {
  const v = hooks.validateConfig(db, req.workspaceId, kind, config);
  if (v.error) return { error: v.error };
  const cfg = { ...v.config, via: 'zapier' };
  let h = db.prepare("SELECT * FROM automation_hooks WHERE workspace_id = ? AND kind = ? AND json_extract(config, '$.via') = 'zapier'").get(req.workspaceId, kind);
  if (!h) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO automation_hooks (id, workspace_id, name, kind, config, secret_hash, enabled, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(id, req.workspaceId, `Zapier: ${kind === 'emergency' ? 'emergency alerts' : kind}`, kind,
      JSON.stringify(cfg), hooks.newSecret().hash, req.user ? req.user.id : null);
    h = db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(id);
  } else {
    db.prepare("UPDATE automation_hooks SET config = ?, updated_at = strftime('%s','now') WHERE id = ?").run(JSON.stringify(cfg), h.id);
    h = db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(h.id);
  }
  if (!h.enabled) return { error: 'The Zapier emergency hook is switched off on the Automation page.' };
  return { hook: h };
}

function finish(req, res, label, r) {
  logActivity(req.user ? req.user.id : null, 'automation:zapier_action', `${label}: ${r.outcome}`.slice(0, 500), null, getClientIp(req), req.workspaceId, r.status);
  res.status(r.ok ? 200 : (r.status || 500)).json({ ok: !!r.ok, result: r.outcome, ...(r.ok ? {} : { error: r.outcome }) });
}

function meshRefusal(req, res) {
  try {
    if (require('../lib/corporate/guard').isReplicatedWorkspace(db, req.workspaceId)) {
      res.status(409).json({ error: 'Automation is not available in a workspace replicated over the mesh.', code: 'MESH_REPLICATED' });
      return true;
    }
  } catch (_) { /* no mesh */ }
  return false;
}

router.post('/actions/emergency', requireScope('full'), async (req, res) => {
  if (!access(req, res, { admin: true }) || meshRefusal(req, res)) return;
  const b = req.body || {};
  const op = b.op === 'clear' ? 'clear' : 'raise';
  const z = zapierHook(req, 'emergency', {
    op, scopes: scopesFrom(b), expires_min: b.expires_min, severity: b.severity || 'Extreme',
    headline: '{{body.headline}}', description: '{{body.message}}', instruction: '{{body.instruction}}', event: '{{body.event}}',
    alert_id: '{{body.alert_id}}', playlist_id: b.playlist_id || null,
  });
  if (z.error) return res.status(400).json({ error: z.error });
  const body = { headline: b.headline, message: b.message, instruction: b.instruction, event: b.event || 'Emergency', alert_id: b.alert_id };
  const r = await hooks.run(db, z.hook, { body, text: JSON.stringify(body), format: 'json' }, { io: req.app.get('io') });
  finish(req, res, `emergency ${op}`, r);
});

router.post('/actions/playlist', requireScope('full'), (req, res) => {
  if (!access(req, res, { admin: true }) || meshRefusal(req, res)) return;
  const b = req.body || {};
  const ov = require('../lib/automation/overrides');
  const sc = hooks.validateConfig(db, req.workspaceId, 'playlist', { op: b.op === 'stop' ? 'stop' : 'start', playlist_id: b.playlist_id, minutes: b.minutes, scopes: scopesFrom(b) });
  if (sc.error) return res.status(400).json({ error: sc.error });
  const c = sc.config;
  if (c.op === 'stop') {
    const n = ov.stop(db, { workspaceId: req.workspaceId, scopes: c.scopes });
    return finish(req, res, 'playlist stop', { ok: true, outcome: `released ${n} screen(s)` });
  }
  const r = ov.start(db, { workspaceId: req.workspaceId, playlistId: c.playlist_id, minutes: c.minutes, scopes: c.scopes });
  if (r.error) return finish(req, res, 'playlist start', { ok: false, status: 409, outcome: r.error });
  finish(req, res, 'playlist start', { ok: true, outcome: `switched ${r.devices} screen(s) for ${c.minutes} minute(s)` });
});

router.post('/actions/trigger', requireScope('full'), async (req, res) => {
  if (!access(req, res, { admin: true }) || meshRefusal(req, res)) return;
  const b = req.body || {};
  const v = hooks.validateConfig(db, req.workspaceId, 'trigger', { trigger_id: b.trigger_id, op: b.op === 'clear' ? 'clear' : 'fire' });
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await hooks.run(db, { id: 'zapier', workspace_id: req.workspaceId, kind: 'trigger', name: 'Zapier', config: JSON.stringify(v.config) },
    { body: {}, text: '', format: 'json' }, { io: req.app.get('io'), log: false });
  finish(req, res, 'trigger', r);
});

router.post('/actions/data', requireScope('write'), async (req, res) => {
  if (!access(req, res, { write: true }) || meshRefusal(req, res)) return;
  const b = req.body || {};
  const v = hooks.validateConfig(db, req.workspaceId, 'data', { data_source_id: b.data_source_id, mode: b.mode, key_column: b.key_column, rows: '{{body.rows}}' });
  if (v.error) return res.status(400).json({ error: v.error });
  let rows = b.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { return res.status(400).json({ error: 'rows must be a JSON array' }); } }
  const r = await hooks.run(db, { id: 'zapier', workspace_id: req.workspaceId, kind: 'data', name: 'Zapier', config: JSON.stringify(v.config) },
    { body: { rows }, text: '', format: 'json' }, { log: false });
  finish(req, res, 'data', r);
});

module.exports = router;
