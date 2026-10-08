'use strict';

/*
 * Canva: connect an account, browse designs, import them, keep them in sync (lib/canva.js).
 *
 * JWT only (config/api-surface.js): a Canva connection is a PERSON's grant to read their designs,
 * and an API token acting as that person must not be able to spend it. The OAuth callback is the
 * one exception — the browser arrives from canva.com with no Authorization header — so it is
 * exported separately and mounted on its own in server.js; it trusts nothing but the signed,
 * httpOnly transaction cookie set when this person pressed Connect.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const canva = require('../lib/canva');
const { canRead, canWrite, isOrgAdmin } = require('../lib/permissions');
const { checkStorageLimit } = require('../middleware/subscription');

const TX_COOKIE = 'st_canva_tx';

function publicOrigin(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

function sendError(res, e) {
  if (e instanceof canva.CanvaError) return res.status(e.status || 502).json({ error: e.message, code: e.code });
  console.error('[canva]', e);
  return res.status(500).json({ error: 'Canva request failed' });
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

function needWorkspace(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  return true;
}

function integrationOr400(req, res) {
  const i = canva.integrationForWorkspace(req.workspaceId);
  if (!i) { res.status(400).json({ error: 'Canva is not set up. An organization admin can add a Canva integration in Settings.', code: 'not_configured' }); return null; }
  return i;
}

/* ============================== status & integration ============================== */

router.get('/status', wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  let integration = null;
  let configError = null;
  try { integration = canva.integrationForWorkspace(req.workspaceId); } catch (e) { configError = e.message; }
  const conn = integration ? canva.connectionRow(req.user.id, integration.key) : null;
  res.json({
    configured: !!integration,
    source: integration ? integration.source : null,
    config_error: configError,
    can_manage: isOrgAdmin(req),
    connected: !!conn,
    display_name: conn ? conn.display_name : null,
    redirect_uri: canva.redirectUri(publicOrigin(req)),
  });
}));

function requireOrgAdmin(req, res) {
  if (!req.organizationId || !isOrgAdmin(req)) { res.status(403).json({ error: 'Organization admins only' }); return false; }
  return true;
}

router.get('/integration', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = db.prepare('SELECT client_id, client_secret_enc, updated_at FROM canva_integrations WHERE organization_id = ?').get(req.organizationId);
  res.json({
    client_id: row ? row.client_id : '',
    has_client_secret: !!(row && row.client_secret_enc),
    updated_at: row ? row.updated_at : null,
    instance_configured: !!((process.env.CANVA_CLIENT_ID || '').trim() && (process.env.CANVA_CLIENT_SECRET || '').trim()),
    redirect_uri: canva.redirectUri(publicOrigin(req)),
    scopes: canva.SCOPES,
  });
});

router.put('/integration', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const b = req.body || {};
  const clientId = String(b.client_id || '').trim();
  if (!clientId || clientId.length > 200 || /\s/.test(clientId)) return res.status(400).json({ error: 'A Canva client ID is required.' });
  const existing = db.prepare('SELECT client_secret_enc FROM canva_integrations WHERE organization_id = ?').get(req.organizationId);
  // Absent keeps the stored secret (the API never returns it, so a form cannot round-trip it).
  let secretEnc = existing ? existing.client_secret_enc : null;
  if (b.client_secret !== undefined) {
    const s = String(b.client_secret || '');
    if (s.length > 500) return res.status(400).json({ error: 'That client secret is too long.' });
    secretEnc = s ? require('../lib/secretbox').encrypt(s) : null;
  }
  if (!secretEnc) return res.status(400).json({ error: 'A Canva client secret is required.' });
  db.prepare(`INSERT INTO canva_integrations (organization_id, client_id, client_secret_enc, updated_by, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(organization_id) DO UPDATE SET client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(req.organizationId, clientId, secretEnc, req.user.id);
  try { require('../services/activity').logActivity(req.user.id, 'canva_integration_saved', `org=${req.organizationId}`, null, null); } catch { /* audit is best effort */ }
  res.json({ ok: true, client_id: clientId, has_client_secret: true });
});

router.delete('/integration', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const key = `org:${req.organizationId}`;
  db.prepare('DELETE FROM canva_integrations WHERE organization_id = ?').run(req.organizationId);
  // Connections to an app that is gone can never be refreshed; links keep their content but report it.
  db.prepare('DELETE FROM canva_connections WHERE integration_key = ?').run(key);
  try { require('../services/activity').logActivity(req.user.id, 'canva_integration_removed', `org=${req.organizationId}`, null, null); } catch { /* best effort */ }
  res.json({ ok: true });
});

/*
 * Check the client id and secret without anyone signing in: trade a code that cannot exist. Canva
 * answers invalid_grant when it knows the client and invalid_client (or 401) when it does not.
 */
router.post('/integration/test', wrap(async (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  let integration;
  try { integration = canva.integrationForOrg(req.organizationId); } catch (e) { return res.json({ ok: false, detail: e.message }); }
  if (!integration) return res.json({ ok: false, detail: 'No Canva integration is set up.' });
  try {
    await canva.tokenRequest(integration, { grant_type: 'authorization_code', code: 'screentinker-test', code_verifier: 'x'.repeat(43), redirect_uri: canva.redirectUri(publicOrigin(req)) });
    return res.json({ ok: true, source: integration.source, detail: 'Canva accepted the client.' });
  } catch (e) {
    if (e.oauthError === 'invalid_grant' || e.oauthError === 'invalid_request') {
      return res.json({ ok: true, source: integration.source, detail: 'Canva recognised the client ID and secret.' });
    }
    if (e.code === 'unreachable') return res.json({ ok: false, detail: 'Canva could not be reached from this server.' });
    return res.json({ ok: false, source: integration.source, detail: 'Canva did not accept this client ID and secret.' });
  }
}));

/* ============================== connect ============================== */

router.post('/connect', wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  const integration = integrationOr400(req, res);
  if (!integration) return;
  const pk = canva.newPkce();
  const tx = jwt.sign({ typ: 'canva-tx', uid: req.user.id, key: integration.key, state: pk.state, verifier: pk.verifier }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 600 });
  res.cookie(TX_COOKIE, tx, { httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 600 * 1000, path: '/api/canva' });
  res.json({ url: canva.authorizeUrl(integration, pk, publicOrigin(req)) });
}));

async function callback(req, res) {
  const back = (params) => res.redirect(`/app#/content?${new URLSearchParams(params)}`);
  const raw = readCookie(req, TX_COOKIE);
  res.clearCookie(TX_COOKIE, { path: '/api/canva' });
  if (req.query.error) return back({ canva_error: 'refused' });
  if (!raw) return back({ canva_error: 'expired' });
  let tx;
  try {
    tx = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'] });
    if (tx.typ !== 'canva-tx') throw new Error('wrong token');
  } catch { return back({ canva_error: 'expired' }); }
  const got = Buffer.from(String(req.query.state || ''), 'utf8');
  const want = Buffer.from(String(tx.state || ''), 'utf8');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return back({ canva_error: 'bad_state' });
  if (!req.query.code) return back({ canva_error: 'no_code' });
  try {
    const integration = canva.integrationByKey(tx.key);
    if (!integration) return back({ canva_error: 'not_configured' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(tx.uid);
    if (!user) return back({ canva_error: 'expired' });
    await canva.completeConnect(user.id, integration, { code: String(req.query.code), verifier: tx.verifier, origin: publicOrigin(req) });
    back({ canva: 'connected' });
  } catch (e) {
    console.warn(`[canva] connect failed: ${e.message}`);
    back({ canva_error: 'failed' });
  }
}

router.post('/disconnect', wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  const integration = canva.integrationForWorkspace(req.workspaceId);
  if (integration) await canva.revoke(req.user.id, integration);
  res.json({ ok: true });
}));

/* ============================== designs ============================== */

router.get('/designs', wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const integration = integrationOr400(req, res);
  if (!integration) return;
  res.json(await canva.listDesigns(req.user.id, integration, { query: req.query.query, continuation: req.query.continuation }));
}));

router.get('/designs/:id/pages', wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const integration = integrationOr400(req, res);
  if (!integration) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid design id' });
  const [design, pages] = await Promise.all([
    canva.getDesign(req.user.id, integration, req.params.id),
    canva.listPages(req.user.id, integration, req.params.id).catch(() => []),
  ]);
  res.json({ design, pages });
}));

router.post('/import', checkStorageLimit, wrap(async (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const integration = integrationOr400(req, res);
  if (!integration) return;
  if (!canva.connectionRow(req.user.id, integration.key)) return res.status(400).json({ error: 'Connect your Canva account first.', code: 'not_connected' });
  const b = req.body || {};
  const designId = String(b.design_id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(designId)) return res.status(400).json({ error: 'design_id is required' });
  const format = b.format === 'mp4' ? 'mp4' : 'png';
  const pages = Array.isArray(b.pages) ? b.pages.slice(0, 51) : [];
  if (b.folder_id) {
    const f = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(b.folder_id);
    if (!f || f.workspace_id !== req.workspaceId) return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
  }
  const playlistName = b.playlist_name ? String(b.playlist_name).trim().slice(0, 120) : null;
  const actor = require('../lib/releases').actorOf(req);
  const workspaceId = req.workspaceId;
  const userId = req.user.id;
  const jobId = canva.runJob({ workspaceId, userId, kind: 'import' }, async () => {
    const r = await canva.importDesign({ workspaceId, userId, designId, pages, format, folderId: b.folder_id || null, playlistName, actor });
    return { content_ids: r.content.map((c) => c.id), playlist_id: r.playlist_id };
  });
  res.status(202).json({ job_id: jobId });
}));

router.get('/jobs/:id', (req, res) => {
  const j = db.prepare('SELECT * FROM canva_jobs WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId || '');
  if (!j) return res.status(404).json({ error: 'Not found' });
  let result = null;
  try { result = j.result ? JSON.parse(j.result) : null; } catch { result = null; }
  res.json({ id: j.id, kind: j.kind, status: j.status, error: j.error, result });
});

/* ============================== links ============================== */

router.get('/links', (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canRead(req)) return res.status(403).json({ error: 'Access denied' });
  const rows = db.prepare(`SELECT l.content_id, l.design_id, l.design_title, l.pages, l.format, l.last_synced_at, l.last_checked_at, l.last_error, l.user_id,
      u.name AS linked_by_name, u.email AS linked_by_email
      FROM canva_links l JOIN content c ON c.id = l.content_id LEFT JOIN users u ON u.id = l.user_id
      WHERE l.workspace_id = ? AND c.workspace_id = ?`).all(req.workspaceId, req.workspaceId);
  res.json({ links: rows.map((r) => ({ ...r, pages: JSON.parse(r.pages || '[]'), linked_by: r.linked_by_name || r.linked_by_email || null, linked_by_name: undefined, linked_by_email: undefined })) });
});

function linkInWorkspace(req, res) {
  const l = db.prepare('SELECT * FROM canva_links WHERE content_id = ? AND workspace_id = ?').get(req.params.contentId, req.workspaceId || '');
  if (!l) { res.status(404).json({ error: 'Not found' }); return null; }
  return l;
}

router.post('/links/:contentId/sync', (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const l = linkInWorkspace(req, res);
  if (!l) return;
  const force = !!(req.body && req.body.force);
  const io = req.app.get('io');
  const jobId = canva.runJob({ workspaceId: req.workspaceId, userId: req.user.id, kind: 'sync' },
    () => canva.syncContent([l.content_id], { force, reqOrIo: io }));
  res.status(202).json({ job_id: jobId });
});

router.delete('/links/:contentId', (req, res) => {
  if (!needWorkspace(req, res)) return;
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const l = linkInWorkspace(req, res);
  if (!l) return;
  db.prepare('DELETE FROM canva_links WHERE content_id = ?').run(l.content_id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.callback = callback;
