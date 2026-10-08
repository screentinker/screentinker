'use strict';

/*
 * Microsoft 365 (lib/m365.js) and SharePoint/OneDrive folder syncs (lib/cloud-folders.js).
 *
 * JWT only (config/api-surface.js): the app holds a credential into the customer's tenant.
 *   /app       the ORGANIZATION's Entra app. Org owners/admins only; the secret is never returned.
 *   /folders   folder syncs into the CURRENT workspace. Read: any member. Change: editor or above.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const m365 = require('../lib/m365');
const folders = require('../lib/cloud-folders');

function workspaceCtx(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  return { ws, ctx, orgId: ws.organization_id };
}

function isOrgAdmin(req, orgId) {
  if (!orgId) return false;
  const row = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(orgId, req.user.id);
  return !!row && (row.role === 'org_owner' || row.role === 'org_admin');
}

function audit(req, action, details) {
  try { require('../lib/audit').audit(action, { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details }); } catch (_) { /* */ }
}

const fail = (res, e) => res.status(e && e.status ? e.status : 500).json({ error: e && e.status ? e.message : 'Something went wrong', code: e && e.code });

/* ============================== the organization's app ============================== */

router.get('/app', (req, res) => {
  const w = workspaceCtx(req, res); if (!w) return;
  const manage = isOrgAdmin(req, w.orgId);
  const pub = m365.present(m365.appRow(w.orgId));
  // Members may know whether it is set up (the folder screen needs that); only admins see the ids.
  res.json(manage ? { ...pub, can_manage: true } : { configured: pub.configured, can_manage: false });
});

router.put('/app', (req, res) => {
  const w = workspaceCtx(req, res); if (!w) return;
  if (!isOrgAdmin(req, w.orgId)) return res.status(403).json({ error: 'Only an organization owner or admin can set up Microsoft 365.' });
  const b = req.body || {};
  const existing = m365.appRow(w.orgId);
  const tenant = b.tenant_id !== undefined ? m365.validateTenant(b.tenant_id) : existing && existing.tenant_id;
  if (!tenant) return res.status(400).json({ error: 'Enter your Directory (tenant) ID — a GUID, or your tenant\'s domain. "common" and "organizations" are not allowed.' });
  const clientId = b.client_id !== undefined ? String(b.client_id || '').trim().toLowerCase() : existing && existing.client_id;
  if (!clientId || !m365.GUID_RE.test(clientId)) return res.status(400).json({ error: 'The Application (client) ID is a GUID, from the app registration\'s Overview page.' });
  // Absent keeps the stored secret; it is never sent back, so a form round trip must not blank it.
  let secretEnc = existing ? existing.client_secret_enc : null;
  if (b.client_secret !== undefined && b.client_secret !== null && b.client_secret !== '') {
    const secret = String(b.client_secret);
    if (secret.length < 8 || secret.length > 512) return res.status(400).json({ error: 'That client secret does not look right. Copy the secret VALUE, not its ID.' });
    secretEnc = require('../lib/secretbox').encrypt(secret);
  }
  if (!secretEnc) return res.status(400).json({ error: 'A client secret is required.' });
  db.prepare(`INSERT INTO org_m365_apps (organization_id, tenant_id, client_id, client_secret_enc, last_test_at, last_test_ok, last_error)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(organization_id) DO UPDATE SET tenant_id = excluded.tenant_id, client_id = excluded.client_id,
        client_secret_enc = excluded.client_secret_enc, last_test_at = NULL, last_test_ok = NULL, last_error = NULL,
        updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), org_m365_apps.updated_at + 1)`)
    .run(w.orgId, tenant, clientId, secretEnc);
  m365.forgetToken(w.orgId);
  audit(req, 'm365_app.save', { organization_id: w.orgId, tenant_id: tenant, client_id: clientId, secret_changed: !existing || secretEnc !== existing.client_secret_enc });
  res.json({ ...m365.present(m365.appRow(w.orgId)), can_manage: true });
});

router.delete('/app', (req, res) => {
  const w = workspaceCtx(req, res); if (!w) return;
  if (!isOrgAdmin(req, w.orgId)) return res.status(403).json({ error: 'Only an organization owner or admin can remove Microsoft 365.' });
  db.prepare('DELETE FROM org_m365_apps WHERE organization_id = ?').run(w.orgId);
  m365.forgetToken(w.orgId);
  audit(req, 'm365_app.delete', { organization_id: w.orgId });
  res.json({ success: true });
});

router.post('/app/test', async (req, res) => {
  const w = workspaceCtx(req, res); if (!w) return;
  if (!isOrgAdmin(req, w.orgId)) return res.status(403).json({ error: 'Only an organization owner or admin can test Microsoft 365.' });
  let ok = false, error = null;
  try { await m365.testApp(w.orgId); ok = true; } catch (e) { error = e && e.status ? e.message : 'The test failed.'; }
  try {
    db.prepare("UPDATE org_m365_apps SET last_test_at = strftime('%s','now'), last_test_ok = ?, last_error = ? WHERE organization_id = ?").run(ok ? 1 : 0, error, w.orgId);
  } catch (_) { /* */ }
  res.json({ ok, error });
});

/* ============================== folder syncs ============================== */

function loadFolder(req, res) {
  const row = db.prepare('SELECT * FROM cloud_folders WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) { res.status(404).json({ error: 'Folder not found' }); return null; }
  return row;
}

router.get('/folders', (req, res) => {
  const w = workspaceCtx(req, res); if (!w) return;
  res.json(db.prepare('SELECT * FROM cloud_folders WHERE workspace_id = ? ORDER BY name').all(req.workspaceId).map(folders.present));
});

router.post('/folders', async (req, res) => {
  const w = workspaceCtx(req, res, { write: true }); if (!w) return;
  const { fields, error } = folders.normaliseInput(req.body);
  if (error) return res.status(400).json({ error });
  let row;
  try {
    row = await folders.createFolder({ workspaceId: req.workspaceId, organizationId: w.orgId, userId: req.user.id, shareUrl: (req.body || {}).share_url, fields });
  } catch (e) { return fail(res, e); }
  audit(req, 'cloud_folder.create', { folder_id: row.id, name: row.name });
  // The first sync runs now, in the background; the list shows its outcome.
  folders.syncFolder(row.id, { trigger: 'created' }).catch(() => { /* recorded on the row */ });
  res.status(201).json(folders.present(row));
});

router.put('/folders/:id', (req, res) => {
  const w = workspaceCtx(req, res, { write: true }); if (!w) return;
  const row = loadFolder(req, res); if (!row) return;
  const { fields, error } = folders.normaliseInput(req.body, row);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(fields).filter((k) => fields[k] !== null && fields[k] !== undefined);
  if (cols.length) db.prepare(`UPDATE cloud_folders SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ ...fields, id: row.id });
  audit(req, 'cloud_folder.update', { folder_id: row.id, fields: cols });
  res.json(folders.present(db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(row.id)));
});

router.delete('/folders/:id', (req, res) => {
  const w = workspaceCtx(req, res, { write: true }); if (!w) return;
  const row = loadFolder(req, res); if (!row) return;
  // Stop syncing. The files already in the library and the playlist stay: they may be on screens.
  db.transaction(() => {
    db.prepare('DELETE FROM cloud_folder_items WHERE folder_id = ?').run(row.id);
    db.prepare('DELETE FROM cloud_folder_removed WHERE folder_id = ?').run(row.id);
    db.prepare('DELETE FROM cloud_folders WHERE id = ?').run(row.id);
  })();
  audit(req, 'cloud_folder.delete', { folder_id: row.id, name: row.name });
  res.json({ success: true });
});

router.post('/folders/:id/sync', async (req, res) => {
  const w = workspaceCtx(req, res, { write: true }); if (!w) return;
  const row = loadFolder(req, res); if (!row) return;
  try {
    const out = await folders.syncFolder(row.id, { trigger: 'manual' });
    res.json({ ...out, folder: folders.present(db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(row.id)) });
  } catch (e) { fail(res, e); }
});

module.exports = router;
