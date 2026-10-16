'use strict';

/*
 * Content requests — the PUBLIC side (lib/content-requests.js, docs/content-requests.md).
 *
 * Nobody here has an account. What authorizes a call is, in order: the form code in the path (a
 * 128-bit secret the admin can rotate), then a short-lived ticket in the X-Request-Ticket header that
 * proves the requester passed the form's gate (link, emailed code or SSO), then — for the status
 * page — the status token, which arrives in the BODY so it never sits in a URL, a referrer or a log.
 * No cookie authorizes anything on this router, so there is nothing for a cross-site form to ride.
 *
 * Every action has its own per-IP limit here (server.js puts one coarse cap over the whole mount),
 * and unknown codes or status tokens count toward a lockout, so the path cannot be scanned cheaply.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const uploadSession = require('../lib/upload-session');
const cr = require('../lib/content-requests');
const { getClientIp } = require('../services/activity');

const ipOf = (req) => String(getClientIp(req) || req.ip || '');

function send(res, e) {
  if (e && (e.name === 'RequestError' || e.name === 'ApprovalError')) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || null, ...(e.extra || {}) });
  }
  console.error('[requests] public error:', e && e.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

/** Per-IP, per-action. Returns true when it answered 429. */
function limit(req, res, bucket, max, windowMs = 60000) {
  const wait = cr.limited(bucket, ipOf(req), max, windowMs);
  if (!wait) return false;
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: 'Too many requests, try again later', code: 'rate_limited' });
  return true;
}

/*
 * Resolve the form from the path, or answer. An unknown code is a miss against this IP; enough of
 * them and the IP is locked out of every code (valid ones too) for a while — guessing 128 bits is
 * hopeless, but this keeps a scan from costing a database lookup per guess.
 */
function formFrom(req, res) {
  const ip = ipOf(req);
  if (cr.isLockedOut(ip)) { res.set('Retry-After', '900'); res.status(429).json({ error: 'Too many wrong links from this network. Try again later.', code: 'locked_out' }); return null; }
  const form = cr.formByCode(req.params.code);
  if (!form) { cr.noteMiss(ip); res.status(404).json({ error: 'This request form does not exist, or its link has changed', code: 'not_found' }); return null; }
  return form;
}

function ticketFrom(req, res, form) {
  const t = cr.ticketFor(form, req.get('X-Request-Ticket'));
  if (!t) { res.status(401).json({ error: 'Your session for this form has expired. Start again.', code: 'ticket_invalid' }); return null; }
  return t;
}

/*
 * Scale-out (docs/scale-out.md): these writes land in the workspace the FORM belongs to, which no
 * session names, so resolveTenancy's interceptor never sees them. When that workspace is a copy on
 * this node, every mutating call is forwarded to the primary here, before any body parser on the
 * route (express.raw for chunks), so the stream is still intact.
 */
const replicaProxy = require('../lib/replica-proxy');
const appConfig = require('../config');
const { db } = require('../db/database');
function copiedWorkspace(workspaceId) {
  const ws = db.prepare('SELECT id, origin_node_id FROM workspaces WHERE id = ?').get(workspaceId);
  return ws && replicaProxy.isCopiedWorkspace(ws) ? ws : null;
}
router.param('code', (req, res, next, code) => {
  const form = cr.formByCode(code);
  const ws = form ? copiedWorkspace(form.workspace_id) : null;
  if (ws && replicaProxy.shouldIntercept(req, ws)) return replicaProxy.proxyToPrimary(req, res, appConfig);
  next();
});

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); };
router.use(noStore);

// ─── the form ────────────────────────────────────────────────────────────────────────────────

router.get('/form/:code', (req, res) => {
  if (limit(req, res, 'form', 60)) return;
  const form = formFrom(req, res);
  if (!form) return;
  if (form.status !== 'open') {
    // Enough to say so in the workspace's own colours; nothing about targets or rules.
    return res.json({ status: form.status, title: form.title, brand: cr.publicForm(form).brand });
  }
  res.json({
    ...cr.publicForm(form),
    sso_available: form.access_mode === 'sso' && !!cr.ssoProviderFor(form.workspace_id),
    email_available: form.access_mode !== 'email' || cr.emailConfigured(),
  });
});

// Open-link forms: name and email, no verification.
router.post('/form/:code/start', (req, res) => {
  if (limit(req, res, 'start', 10)) return;
  const form = formFrom(req, res);
  if (!form) return;
  try { res.status(201).json(cr.startLink(form, req.body || {})); } catch (e) { send(res, e); }
});

// Email-domain forms: mail a code (the spray surface, so the tightest limit), then confirm it.
router.post('/form/:code/verify', async (req, res) => {
  if (limit(req, res, 'verify', 5)) return;
  const form = formFrom(req, res);
  if (!form) return;
  try { res.json(await cr.startEmail(form, req.body || {})); } catch (e) { send(res, e); }
});

router.post('/form/:code/verify/confirm', (req, res) => {
  if (limit(req, res, 'confirm', 10)) return;
  const form = formFrom(req, res);
  if (!form) return;
  try { res.status(201).json(cr.confirmEmail(form, req.body || {})); } catch (e) { send(res, e); }
});

// SSO forms: off to the organization's identity provider; routes/auth.js brings them back to /r/<code>.
router.get('/form/:code/sso', async (req, res) => {
  if (limit(req, res, 'sso', 20)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const back = (code) => res.redirect(`/r/${encodeURIComponent(form.code)}#sso_error=${encodeURIComponent(code)}`);
  if (form.status !== 'open') return back('form_unavailable');
  if (form.access_mode !== 'sso') return back('wrong_mode');
  const slug = cr.ssoProviderFor(form.workspace_id);
  let provider = null;
  try { provider = slug ? require('../lib/oidc-providers').get(slug) : null; } catch (_) { provider = null; }
  if (!provider) return back('provider_unavailable');
  try { await require('./auth').beginRequesterSso(req, res, provider, form); } catch (e) { if (!res.headersSent) back('provider_unavailable'); }
});

// ─── uploads (resumable; lib/upload-session holds the bytes, outside anything served) ───────

router.post('/form/:code/uploads', (req, res) => {
  if (limit(req, res, 'upload', 10)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const t = ticketFrom(req, res, form);
  if (!t) return;
  try { res.status(201).json(cr.createUpload(form, t, req.body || {}, ipOf(req))); } catch (e) { send(res, e); }
});

router.get('/form/:code/uploads/:id', (req, res) => {
  if (limit(req, res, 'chunk', 1200)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const t = ticketFrom(req, res, form);
  if (!t) return;
  const s = cr.getUpload(form, t, req.params.id);
  if (!s) return res.status(404).json({ error: 'No such upload', code: 'no_upload' });
  res.json({ id: s.id, offset: uploadSession.offsetOf(s), declared_size: s.declared_size, chunk_size: uploadSession.CHUNK_SIZE });
});

router.patch('/form/:code/uploads/:id', express.raw({ type: () => true, limit: uploadSession.MAX_CHUNK_BYTES }), (req, res) => {
  if (limit(req, res, 'chunk', 1200)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const t = ticketFrom(req, res, form);
  if (!t) return;
  const offset = Number(req.get('Upload-Offset'));
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: 'Upload-Offset header is required' });
  // A JSON body was already parsed by the global parser and is not bytes: refuse rather than append.
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Send the chunk as raw bytes (Content-Type: application/octet-stream)' });
  try {
    const out = cr.appendChunk(form, t, req.params.id, offset, req.body);
    res.set('Upload-Offset', String(out.offset));
    res.json(out);
  } catch (e) { send(res, e); }
});

router.delete('/form/:code/uploads/:id', (req, res) => {
  if (limit(req, res, 'chunk', 1200)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const t = ticketFrom(req, res, form);
  if (!t) return;
  cr.cancelUpload(form, t, req.params.id);
  res.json({ ok: true });
});

// ─── submit ──────────────────────────────────────────────────────────────────────────────────

router.post('/form/:code/submit', async (req, res) => {
  if (limit(req, res, 'submit', 10)) return;
  const form = formFrom(req, res);
  if (!form) return;
  const t = ticketFrom(req, res, form);
  if (!t) return;
  try {
    // Emailed links (the reviewers' and the requester's status link): never the raw Host header.
    const origin = require('../lib/public-origin').publicOrigin(req);
    res.status(201).json(await cr.submitRequest(form, t, req.body || {}, { ip: ipOf(req), origin }));
  } catch (e) { send(res, e); }
});

// ─── the status link (POST: the token travels in the body, never in a URL) ───────────────────

function requestFrom(req, res) {
  const ip = ipOf(req);
  if (cr.isLockedOut(ip)) { res.set('Retry-After', '900'); res.status(429).json({ error: 'Too many wrong links from this network. Try again later.', code: 'locked_out' }); return null; }
  const r = cr.byStatusToken(req.body && req.body.token);
  if (!r) { cr.noteMiss(ip); res.status(404).json({ error: 'No request matches this link', code: 'not_found' }); return null; }
  return r;
}

router.post('/status', (req, res) => {
  if (limit(req, res, 'status', 60)) return;
  const r = requestFrom(req, res);
  if (!r) return;
  res.json(cr.publicStatus(r));
});

router.post('/status/cancel', (req, res) => {
  if (limit(req, res, 'status-cancel', 10)) return;
  const r = requestFrom(req, res);
  if (!r) return;
  if (copiedWorkspace(r.workspace_id)) return replicaProxy.proxyToPrimary(req, res, appConfig);
  if (r.status !== 'pending') return res.status(409).json({ error: 'Only a request that is still waiting can be withdrawn', code: 'not_pending' });
  cr.cancelRequest(r, { ip: ipOf(req) });
  res.json(cr.publicStatus(cr.byStatusToken(req.body.token)));
});

module.exports = router;
