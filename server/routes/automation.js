'use strict';

/*
 * Automation (lib/automation) — the dashboard's Automation page: inbound hooks, their call log,
 * and the REST-hook subscriptions Zapier (or anything else) has made.
 *
 * JWT ONLY (config/api-surface.js), like alert channels: a hook's URL is a credential that can take
 * over screens, so minting or rotating one is a signed-in admin's act, not an API token's. Zapier's
 * own surface (subscriptions, events, actions) is routes/zapier.js, on the token door.
 *
 * WHO: reading needs workspace membership; changing anything needs a workspace admin (or an org
 * admin acting as one) — an emergency hook can take over every screen in the workspace.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const hooks = require('../lib/automation/hooks');
const events = require('../lib/automation/events');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && !ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
    res.status(403).json({ error: 'Only a workspace admin can change automation.', code: 'AUTOMATION_ADMIN_REQUIRED' }); return null;
  }
  return ctx;
}

function meshRefusal(req) {
  try {
    if (require('../lib/corporate/guard').isReplicatedWorkspace(db, req.workspaceId)) {
      return 'Automation is not available in a workspace replicated over the mesh: hooks are not replicated, so its screens would never see what a hook does.';
    }
  } catch (_) { /* no mesh */ }
  return null;
}

function publicOrigin(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}
const hookUrl = (req, id, secret) => `${publicOrigin(req)}/api/hooks/in/${id}/${secret}`;

function present(req, h) {
  const cfg = hooks.parseConfig(h);
  let live = 0;
  if (h.feed_id) {
    const feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(h.feed_id);
    if (feed) live = require('../lib/cap/feeds').liveAlerts(db, feed).length;
  }
  const now = Math.floor(Date.now() / 1000);
  const overrides = db.prepare('SELECT COUNT(*) AS n FROM automation_overrides WHERE hook_id = ? AND ends_at > ?').get(h.id, now).n;
  return {
    id: h.id, name: h.name, kind: h.kind, enabled: !!h.enabled, config: cfg,
    // The secret is never stored, so the URL can only be shown at creation or after a rotation.
    url_hint: `${publicOrigin(req)}/api/hooks/in/${h.id}/…`,
    has_signing_secret: !!h.hmac_secret_enc,
    live_alerts: live, screens_overridden: overrides,
    call_count: h.call_count, last_called_at: h.last_called_at,
    created_at: h.created_at, updated_at: h.updated_at,
  };
}

function loadHook(req, res) {
  const h = db.prepare('SELECT * FROM automation_hooks WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!h) { res.status(404).json({ error: 'Hook not found' }); return null; }
  return h;
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  const rows = db.prepare('SELECT * FROM automation_hooks WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ hooks: rows.map((h) => present(req, h)), kinds: hooks.KINDS, events: events.EVENTS, api_base: `${publicOrigin(req)}/api/zapier` });
});

router.get('/subscriptions', (req, res) => {
  if (!access(req, res)) return;
  const rows = db.prepare('SELECT * FROM automation_subscriptions WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json(rows.map((s) => {
    let host = '';
    try { host = new URL(s.target_url).host; } catch { host = ''; }
    const counts = db.prepare("SELECT status, COUNT(*) AS n FROM automation_deliveries WHERE subscription_id = ? GROUP BY status").all(s.id);
    const tok = s.token_id ? db.prepare('SELECT name FROM api_tokens WHERE id = ?').get(s.token_id) : null;
    // The target URL is the receiver's credential (a Zapier catch-hook URL): only its host is shown.
    return { id: s.id, event: s.event, target_host: host, token_name: tok ? tok.name : null, last_ok_at: s.last_ok_at, last_error: s.last_error,
      deliveries: Object.fromEntries(counts.map((c) => [c.status, c.n])), created_at: s.created_at };
  }));
});

router.delete('/subscriptions/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const r = db.prepare('DELETE FROM automation_subscriptions WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  if (!r.changes) return res.status(404).json({ error: 'Subscription not found' });
  db.prepare("UPDATE automation_deliveries SET status = 'failed', last_error = 'unsubscribed' WHERE subscription_id = ? AND status = 'pending'").run(req.params.id);
  logActivity(req.user.id, 'automation:unsubscribed', `subscription ${req.params.id}`, null, getClientIp(req), req.workspaceId);
  res.json({ ok: true });
});

router.get('/events', (req, res) => {
  if (!access(req, res)) return;
  const type = events.EVENTS.includes(req.query.event) ? req.query.event : null;
  res.json(events.recent(db, req.workspaceId, type, req.query.limit));
});

router.get('/:id', (req, res) => {
  if (!access(req, res)) return;
  const h = loadHook(req, res); if (!h) return;
  res.json(present(req, h));
});

router.get('/:id/calls', (req, res) => {
  if (!access(req, res)) return;
  const h = loadHook(req, res); if (!h) return;
  res.json(db.prepare('SELECT at, status, outcome, test FROM automation_hook_calls WHERE hook_id = ? ORDER BY id DESC LIMIT 50').all(h.id)
    .map((c) => ({ ...c, test: !!c.test })));
});

router.post('/', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const mesh = meshRefusal(req);
  if (mesh) return res.status(409).json({ error: mesh, code: 'MESH_REPLICATED' });
  const n = hooks.normaliseInput(db, req.workspaceId, req.body);
  if (n.error) return res.status(400).json({ error: n.error });
  const count = db.prepare('SELECT COUNT(*) AS n FROM automation_hooks WHERE workspace_id = ?').get(req.workspaceId).n;
  if (count >= 100) return res.status(409).json({ error: 'A workspace can have up to 100 hooks.' });
  const id = crypto.randomUUID();
  const { secret, hash } = hooks.newSecret();
  const f = n.fields;
  db.prepare(`INSERT INTO automation_hooks (id, workspace_id, name, kind, config, secret_hash, hmac_secret_enc, enabled, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.workspaceId, f.name, f.kind, f.config, hash, f.hmac_secret_enc || null, f.enabled === undefined ? 1 : f.enabled, req.user.id);
  logActivity(req.user.id, 'automation:hook_created', `${f.name} (${f.kind})`, null, getClientIp(req), req.workspaceId);
  const h = db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(id);
  res.status(201).json({ ...present(req, h), url: hookUrl(req, id, secret) });
});

router.put('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const h = loadHook(req, res); if (!h) return;
  const n = hooks.normaliseInput(db, req.workspaceId, req.body, h);
  if (n.error) return res.status(400).json({ error: n.error });
  const cols = Object.keys(n.fields);
  if (cols.length) {
    db.prepare(`UPDATE automation_hooks SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`)
      .run({ ...n.fields, id: h.id });
  }
  const after = db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(h.id);
  // Disabling an emergency hook takes down what it raised; re-enabling does not resurrect it.
  if (h.enabled && !after.enabled && after.feed_id) {
    const feeds = require('../lib/cap/feeds');
    const feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(after.feed_id);
    if (feed) { feeds.endPushed(db, feed, null); feeds.refresh(db, feed.id); }
  }
  if (h.enabled && !after.enabled) require('../lib/automation/overrides').stop(db, { workspaceId: h.workspace_id, hookId: h.id });
  logActivity(req.user.id, 'automation:hook_updated', `${after.name} (${after.kind})`, null, getClientIp(req), req.workspaceId);
  res.json(present(req, after));
});

router.post('/:id/rotate', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const h = loadHook(req, res); if (!h) return;
  const { secret, hash } = hooks.newSecret();
  db.prepare("UPDATE automation_hooks SET secret_hash = ?, updated_at = strftime('%s','now') WHERE id = ?").run(hash, h.id);
  logActivity(req.user.id, 'automation:hook_rotated', h.name, null, getClientIp(req), req.workspaceId);
  res.json({ ...present(req, db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(h.id)), url: hookUrl(req, h.id, secret) });
});

/*
 * Test-fire: runs the hook for real with the body given (or a representative one), marked as a test
 * in the call log. It is not a dry run — a test of an emergency hook shows the alert on screens, so
 * the page says so and offers the clear straight after.
 */
router.post('/:id/test', async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const h = loadHook(req, res); if (!h) return;
  const body = req.body && req.body.body !== undefined ? req.body.body : sampleBody(h);
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const parsed = hooks.parseBody(Buffer.from(raw), typeof body === 'string' && raw.trimStart().startsWith('<') ? 'application/xml' : 'application/json');
  const r = await hooks.run(db, h, parsed, { io: req.app.get('io'), test: true });
  logActivity(req.user.id, 'automation:hook_tested', `${h.name}: ${r.outcome}`, null, getClientIp(req), req.workspaceId);
  res.status(r.ok ? 200 : 422).json({ ok: r.ok, outcome: r.outcome });
});

function sampleBody(h) {
  if (h.kind === 'emergency') return { id: 'test-1', headline: 'Test alert', message: 'This is a test of the emergency hook.', status: 'active' };
  if (h.kind === 'mass_notification') return { alertId: 'test-1', title: 'Test alert', message: 'This is a test of the mass notification hook.', status: 'active' };
  if (h.kind === 'data') return [];
  return {};
}

router.delete('/:id', (req, res) => {
  if (!access(req, res, { write: true })) return;
  const h = loadHook(req, res); if (!h) return;
  hooks.removeHook(db, h);
  logActivity(req.user.id, 'automation:hook_deleted', `${h.name} (${h.kind})`, null, getClientIp(req), req.workspaceId);
  res.json({ ok: true });
});

module.exports = router;
