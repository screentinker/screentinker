'use strict';

/*
 * Content freshness (lib/freshness.js, docs/content-freshness.md): the report, the workspace
 * thresholds, snoozes, and the caller's own weekly-digest preference.
 *
 * Mounted JWT-only with resolveTenancy (config/api-surface.js), so every handler acts on the
 * caller's ACTIVE workspace and nothing else. No handler takes a workspace id from the request.
 *
 *   GET    /                         the full report (any member, viewers included: it is read-only)
 *   GET    /chips                    the compact per-id form the dashboard chips use
 *   GET    /settings                 thresholds
 *   PUT    /settings                 admin only
 *   POST   /snooze                   { type, id, days }   editors and admins
 *   DELETE /snooze/:type/:id         editors and admins
 *   GET    /digest                   the caller's own digest preference
 *   PUT    /digest                   { enabled }   the caller's own; any member who receives it
 *
 * The one-click actions on the page (replace, remove, set an expiry) are NOT here: they go through
 * the existing content endpoints, so approval, plan limits, publishing and the audit trail all apply
 * exactly as they do from the library.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const freshness = require('../lib/freshness');
const { canRead, canWrite, canAdmin } = require('../lib/permissions');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');

const MAX_SNOOZE_DAYS = 365;

function requireWs(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  if (!canRead(req)) { res.status(403).json({ error: 'Workspace access required' }); return false; }
  return true;
}

router.get('/', (req, res) => {
  if (!requireWs(req, res)) return;
  // Always computed fresh: the page is opened rarely, and right after one of its own fixes (an expiry
  // set through the content route, which this cache cannot hear about) a minute-old answer would
  // show the problem still there. The cached copy serves the chips, which are drawn constantly.
  const report = freshness.computeWorkspace(db, req.workspaceId, { useCache: false });
  res.json({ ...report, can_write: canWrite(req), can_admin: canAdmin(req) });
});

router.get('/chips', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json(freshness.chipsFrom(freshness.computeWorkspace(db, req.workspaceId)));
});

router.get('/settings', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json({ ...freshness.getSettings(db, req.workspaceId), defaults: freshness.DEFAULTS });
});

router.put('/settings', (req, res) => {
  if (!requireWs(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const current = freshness.getSettings(db, req.workspaceId);
  const v = freshness.validateSettings(current, req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  freshness.saveSettings(db, req.workspaceId, v.settings, req.user.id);
  auditFromReq(req, 'freshness_settings_updated', { workspace_id: req.workspaceId, before: current, after: v.settings });
  res.json(v.settings);
});

/*
 * ⚠️ THE RESOURCE MUST BE IN THE ACTIVE WORKSPACE. A snooze row only ever changes what this
 * workspace's report says, so a foreign id could not leak anything by itself — but accepting one
 * would let a caller probe which ids exist elsewhere (201 vs 404), and leave rows naming another
 * tenant's resources in this one's table. Unknown and foreign ids get the same 404.
 */
router.post('/snooze', (req, res) => {
  if (!requireWs(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Workspace editor or admin required' });
  const b = req.body || {};
  const type = String(b.type || '');
  const id = String(b.id || '');
  const days = Number(b.days);
  if (!freshness.SNOOZE_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${freshness.SNOOZE_TYPES.join(', ')}` });
  if (!Number.isInteger(days) || days < 1 || days > MAX_SNOOZE_DAYS) return res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_SNOOZE_DAYS}` });
  if (!id || freshness.resourceWorkspace(db, type, id) !== req.workspaceId) return res.status(404).json({ error: 'Not found' });
  const until = Math.floor(Date.now() / 1000) + days * 86400;
  db.prepare(`INSERT INTO freshness_snoozes (workspace_id, resource_type, resource_id, until, created_by)
              VALUES (?,?,?,?,?)
              ON CONFLICT(workspace_id, resource_type, resource_id) DO UPDATE SET until = excluded.until, created_by = excluded.created_by,
                created_at = strftime('%s','now')`)
    .run(req.workspaceId, type, id, until, req.user.id);
  freshness.invalidate(req.workspaceId);
  auditFromReq(req, 'freshness_snoozed', { workspace_id: req.workspaceId, type, id, days });
  res.status(201).json({ type, id, until });
});

router.delete('/snooze/:type/:id', (req, res) => {
  if (!requireWs(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Workspace editor or admin required' });
  const r = db.prepare('DELETE FROM freshness_snoozes WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?')
    .run(req.workspaceId, String(req.params.type), String(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  freshness.invalidate(req.workspaceId);
  auditFromReq(req, 'freshness_unsnoozed', { workspace_id: req.workspaceId, type: req.params.type, id: req.params.id });
  res.json({ ok: true });
});

/*
 * The caller's own digest preference. Personal, but still a write: a viewer is refused here like
 * everywhere else (they are never sent the digest, so there is nothing for them to turn off, and the
 * email's own unsubscribe link works for anyone it reaches). The account-wide alert opt-out (users.email_alerts) is reported beside it because it wins: a person
 * who stopped all alert email gets no digest whatever this says.
 */
function digestState(userId) {
  const pref = db.prepare('SELECT opted_out, last_sent_at FROM freshness_digest_prefs WHERE user_id = ?').get(userId);
  const u = db.prepare('SELECT email_alerts FROM users WHERE id = ?').get(userId);
  return {
    enabled: !(pref && pref.opted_out),
    email_alerts_off: !!(u && u.email_alerts === 0),
    last_sent_at: pref ? pref.last_sent_at : null,
    // The digest needs both a transport and APP_URL (services/freshness-digest.js); the page says
    // "this server sends no digest" rather than offering a switch that does nothing.
    email_configured: require('../services/email').isConfigured() && !!String(process.env.APP_URL || '').trim(),
  };
}

router.get('/digest', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json(digestState(req.user.id));
});

router.put('/digest', (req, res) => {
  if (!requireWs(req, res)) return;
  if (denyReadOnly(req, res)) return;
  const enabled = !!(req.body && req.body.enabled);
  const t = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO freshness_digest_prefs (user_id, opted_out, opted_out_at) VALUES (?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET opted_out = excluded.opted_out, opted_out_at = excluded.opted_out_at`)
    .run(req.user.id, enabled ? 0 : 1, enabled ? null : t);
  auditFromReq(req, enabled ? 'freshness_digest_subscribed' : 'freshness_digest_unsubscribed', { via: 'settings' });
  res.json(digestState(req.user.id));
});

module.exports = router;
