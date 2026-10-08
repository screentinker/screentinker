'use strict';

/*
 * The inbound hook door: POST /api/hooks/in/<hook id>/<secret> (and GET, only for a hook with
 * "allow GET" switched on).
 *
 * No session and no API token — the secret in the URL is the credential, which is what Zapier,
 * Make, n8n, Alertus, InformaCast and a building's fire panel can all actually send. See
 * lib/automation/hooks.js for the rules.
 *
 * ⚠️ ONE ANSWER FOR EVERY KIND OF "NO": an unknown id, a wrong secret and a disabled hook are all
 * the same 404 with the same body, after the same work (the secret is hashed and compared even when
 * the id is unknown). Only a caller holding the right URL ever learns anything — and only then does
 * a missing or wrong signature answer 401, or the rate limit 429.
 *
 * Not workspace-scoped through resolveTenancy: the hook row names its workspace. Hooks are refused
 * in a mesh-replicated workspace at creation (routes/automation.js), and hook rows are never
 * replicated, so a replica has nothing for this door to find.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { logActivity, getClientIp } = require('../services/activity');
const hooks = require('../lib/automation/hooks');

const NOT_FOUND = { error: 'Not found' };

async function handle(req, res) {
  const hook = db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(String(req.params.id || '').slice(0, 64));
  // Compared even when the hook is unknown (against a dummy hash), so timing says nothing either way.
  const ok = hooks.secretMatches(hook || { secret_hash: '0'.repeat(64) }, String(req.params.secret || '').slice(0, 200));
  if (!hook || !ok || !hook.enabled) return res.status(404).json(NOT_FOUND);
  /*
   * ⚠️ GET IS OPT-IN, per hook. A link unfurler (Slack, Teams), a mail scanner or a browser
   * prefetch GETs any URL it sees, and a hook URL pasted into a chat would have raised an alert.
   * Refused with the same 404 as everything else, so the method says nothing about the hook.
   */
  if (req.method === 'GET' && !hooks.parseConfig(hook).allow_get) return res.status(404).json(NOT_FOUND);

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (hook.hmac_secret_enc) {
    let key = null;
    try { key = require('../lib/secretbox').decrypt(hook.hmac_secret_enc); } catch { key = null; }
    if (!key || !hooks.verifySignature(key, raw, req.headers)) {
      hooks.record(db, hook, 401, 'refused: missing or wrong signature');
      return res.status(401).json({ error: 'Missing or invalid signature' });
    }
  }
  if (!hooks.allowCall(hook.id)) {
    hooks.record(db, hook, 429, 'refused: rate limit (30 calls a minute)');
    return res.status(429).json({ error: 'Too many calls to this hook; try again in a minute.' });
  }

  const parsed = req.method === 'GET'
    ? { body: { ...req.query }, text: JSON.stringify(req.query || {}), format: 'json' }
    : hooks.parseBody(raw, req.get('content-type'));
  const r = await hooks.run(db, hook, parsed, { query: req.query, io: req.app.get('io') });
  logActivity(hook.created_by || null, 'automation:hook_called', `${hook.name}: ${r.outcome}`.slice(0, 500), null, getClientIp(req), hook.workspace_id, r.status);
  res.status(r.status).json({ ok: !!r.ok, result: r.outcome });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[automation] inbound hook error:', e && e.message);
  try { if (!res.headersSent) res.status(500).json({ error: 'Internal error' }); } catch (_) { /* the socket is gone */ }
});

// Raw body, any type: CAP arrives as XML, InformaCast and Alertus as JSON, a form as urlencoded —
// and the signature is over the exact bytes.
router.post('/:id/:secret', express.raw({ type: () => true, limit: '256kb' }), wrap(handle));
router.get('/:id/:secret', wrap(handle));

module.exports = router;
