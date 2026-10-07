'use strict';

/*
 * Where media is stored — storage profiles, bucket attach/import, and live migration.
 * lib/storage holds every rule; this file is the HTTP shape of it. docs/storage.md is the
 * operator's view.
 *
 * Mounted at /api/storage-profiles, JWT only (config/api-surface.js), resolveTenancy. An API token
 * cannot reach any of it. Three levels, three kinds of caller:
 *   instance      — platform admins: the profile every organization without its own storage uses.
 *   organization  — org owners/admins: the org's shared profiles and default, AND every workspace's
 *                   own storage in the org (they can always see and override it).
 *   workspace     — workspace admins, ONLY when the organization has switched on "workspaces may
 *                   choose their own storage" (organizations.storage_workspace_choice, default off),
 *                   and only for their own workspace: its own profiles, its override, its moves.
 * A profile holds cloud credentials and decides where a tenant's bytes go, which is why the default
 * leaves the choice with the organization.
 *
 * ⚠️ CREDENTIALS GO IN, NEVER OUT. A POST/PUT body may carry them; no response carries them, in
 * any form — `configured` and a four-character `hint` are all a GET ever says (storage.publicView).
 * They are stored as a secretbox blob keyed from JWT_SECRET; rotating that secret makes them
 * unreadable, which the UI reports as "re-enter the key".
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const secretbox = require('../lib/secretbox');
const storage = require('../lib/storage');
const locations = require('../lib/storage/locations');
const migrate = require('../lib/storage/migrate');
const attach = require('../lib/storage/attach');
const { checkEndpoint, parseEndpoint } = require('../lib/storage/endpoint-guard');
const { isOrgAdmin, canAdmin } = require('../lib/permissions');
const { logActivity, getClientIp } = require('../services/activity');

function orgAllowsWorkspaceChoice(orgId) {
  if (!orgId) return false;
  const r = db.prepare('SELECT storage_workspace_choice FROM organizations WHERE id = ?').get(orgId);
  return !!(r && r.storage_workspace_choice);
}

/** Who is asking: { org: org admin (incl. platform admin), ws: workspace admin allowed to choose }. */
function accessOf(req) {
  const org = isOrgAdmin(req) && (!!req.organizationId || !!req.isPlatformAdmin);
  const ws = !org && !!req.workspaceId && canAdmin(req) && orgAllowsWorkspaceChoice(req.organizationId);
  return { org, ws };
}

function requireStorageAccess(req, res) {
  if (!req.organizationId && !req.isPlatformAdmin) { res.status(403).json({ error: 'No organization context' }); return null; }
  const a = accessOf(req);
  if (!a.org && !a.ws) { res.status(403).json({ error: 'Organization admin required' }); return null; }
  return a;
}

/**
 * A profile this caller may act on, by id (incl. 'local' and 'env'), or a 404 answer. Org admins
 * see every profile of the org, workspace-owned ones included; a workspace admin sees only what
 * their workspace can use. Another org's — or another workspace's — is "no such profile".
 */
function loadProfile(req, res, a = accessOf(req)) {
  const p = a.org ? storage.profileForOrgAdmin(req.params.id, req.organizationId)
    : storage.profileForWorkspace(req.params.id, req.workspaceId);
  if (!p) { res.status(404).json({ error: 'No such storage profile' }); return null; }
  return p;
}

/** Instance rows are platform-admin territory; org rows the org admin's; a workspace's own row its admin's too. */
function mayEdit(req, p, a = accessOf(req)) {
  if (p.synthetic) return false;
  if (p.org_id == null) return !!req.isPlatformAdmin;
  if (p.org_id !== req.organizationId) return false;
  if (a.org) return true;
  return !!(a.ws && p.workspace_id && p.workspace_id === req.workspaceId);
}

function sendErr(res, e) {
  const status = e.status || (e.name === 'StorageRefusedError' ? 400 : e.name === 'StorageError' ? 502 : 500);
  if (status >= 500 && e.name !== 'StorageError') console.error('[storage-profiles]', e && e.message);
  res.status(status).json({ error: e.name && /Storage/.test(e.name) ? e.message : (status >= 500 ? 'Storage request failed' : e.message), code: e.code || null });
}

const audit = (req, action, details) => logActivity(req.user.id, action, details, null, getClientIp(req), req.workspaceId || null);

/* ───────────────────────────── validation ───────────────────────────── */

const bool01 = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : v === false || v === 0 || v === '0' || v === 'false' ? 0 : null);
const str = (v, max = 512) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

const CRED_FIELDS = {
  s3: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
  azure: ['connectionString', 'accountName', 'accountKey', 'sasToken'],
};

/**
 * Turn a request body into column values. `existing` for an update: absent fields keep their value,
 * absent credentials keep the stored blob. Throws {status, message} on a bad value.
 */
async function validate(req, body, existing = null) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const provider = existing ? existing.provider : String(body.provider || '').toLowerCase();
  if (!['s3', 'azure'].includes(provider)) throw bad('provider must be "s3" or "azure" (local disk is always available as "local")');
  const pick = (k, fn = str) => (k in body ? fn(body[k]) : existing ? existing[k] : null);

  const out = {
    provider,
    name: pick('name', (v) => str(v, 80)),
    bucket: pick('bucket', (v) => str(v, 255)),
    endpoint: pick('endpoint'),
    public_endpoint: pick('public_endpoint'),
    public_base_url: provider === 's3' ? pick('public_base_url') : null,
    region: provider === 's3' ? pick('region', (v) => str(v, 64)) : null,
    prefix: 'prefix' in body ? storage.sanitizePrefix(body.prefix || '') || null : existing ? existing.prefix : null,
    force_path_style: provider === 's3' ? ('force_path_style' in body ? bool01(body.force_path_style) : existing ? existing.force_path_style : null) : null,
    mode: pick('mode', (v) => (v === 'ro' ? 'ro' : 'rw')) || 'rw',
    read_priority: 'read_priority' in body ? Math.max(-1000, Math.min(1000, parseInt(body.read_priority, 10) || 0)) : existing ? existing.read_priority : 100,
    presign: 'presign' in body ? (bool01(body.presign) === 0 ? 0 : 1) : existing ? existing.presign : 1,
    allow_private: 'allow_private' in body ? (bool01(body.allow_private) === 1 ? 1 : 0) : existing ? existing.allow_private : 0,
  };
  if (!out.name) throw bad('name is required');
  if (!out.bucket) throw bad(provider === 's3' ? 'bucket is required' : 'container is required');
  // Read-only profiles are for attach: ScreenTinker manages nothing in them. A writable one manages
  // only its own st/ prefix. 'all' is never set from here (a destructive import is not built).
  out.manage_scope = out.mode === 'ro' ? 'none' : 'st';

  /*
   * ⚠️ allow_private lets this server connect to loopback / LAN addresses. On a hosted instance
   * that is the platform's own network, so only a platform admin may grant it; on a self-hosted
   * one the org admin IS the operator. Metadata and link-local stay refused either way.
   */
  if (out.allow_private && !(existing && existing.allow_private) && !req.isPlatformAdmin && !config.selfHosted) {
    throw Object.assign(new Error('Only a platform administrator can allow a private-network storage endpoint.'), { status: 403 });
  }

  for (const k of ['endpoint', 'public_endpoint', 'public_base_url']) {
    if (!out[k]) continue;
    try { parseEndpoint(out[k]); } catch (e) { throw bad(`${k} must be an http(s) URL with no credentials, query or fragment`); }
    out[k] = out[k].replace(/\/+$/, '');
  }
  if (out.endpoint) {
    try { await checkEndpoint(out.endpoint, { allowPrivate: !!out.allow_private }); }
    catch (e) { throw bad('That storage endpoint is not allowed from this server (loopback, private and metadata addresses are refused unless explicitly allowed; metadata never is).'); }
  }

  // Credentials: replaced only when the body carries a credentials object.
  if (body.credentials && typeof body.credentials === 'object') {
    const c = {};
    for (const k of CRED_FIELDS[provider]) if (body.credentials[k]) c[k] = String(body.credentials[k]).trim().slice(0, 4096);
    if (provider === 's3' && (!c.accessKeyId || !c.secretAccessKey)) throw bad('accessKeyId and secretAccessKey are required');
    if (provider === 'azure' && !c.connectionString && !(c.accountName && (c.accountKey || c.sasToken))) throw bad('a connection string, or an account name with a key or SAS, is required');
    if (provider === 'azure' && c.connectionString) {
      // The connection string carries its own endpoint; it is vetted like a typed one.
      const be = new (require('../lib/storage/azure').AzureBackend)({ ...out, credentials: c });
      if (be.endpointUrl()) {
        try { await checkEndpoint(be.endpointUrl(), { allowPrivate: !!out.allow_private }); }
        catch (e) { throw bad('The connection string\'s endpoint is not allowed from this server.'); }
      }
    }
    out.credentials_enc = secretbox.encrypt(JSON.stringify(c));
    out.credentials_hint = storage.hintOf(c);
  } else if (!existing) {
    throw bad('credentials are required');
  }
  return out;
}

/* ───────────────────────────── routes ───────────────────────────── */

function orgSettings(req, a = accessOf(req)) {
  const org = req.organizationId ? db.prepare('SELECT storage_profile_id, storage_workspace_choice FROM organizations WHERE id = ?').get(req.organizationId) : null;
  const ws = req.workspaceId ? db.prepare('SELECT name, storage_direct_fetch, storage_profile_id FROM workspaces WHERE id = ?').get(req.workspaceId) : null;
  const def = storage.orgDefaultProfile(req.organizationId);
  const wsEff = req.workspaceId ? storage.workspaceDefaultProfile(req.workspaceId) : null;
  return {
    can_manage_org: a.org,
    default_profile_id: storage.outId(storage.normId(def.id)),
    org_override: org && org.storage_profile_id ? org.storage_profile_id : null,
    instance_default_id: storage.outId(storage.normId(storage.instanceDefault().id)),
    workspace_choice: !!(org && org.storage_workspace_choice),
    workspace: req.workspaceId ? {
      id: req.workspaceId, name: ws ? ws.name : null,
      override: ws && ws.storage_profile_id ? ws.storage_profile_id : null,
      effective_profile_id: wsEff ? storage.outId(storage.normId(wsEff.id)) : null,
      // An override that no longer resolves (deleted, read-only, key unreadable) silently falls back
      // to the org default for uploads; the page says so instead of pretending it applies.
      override_unusable: !!(ws && ws.storage_profile_id && wsEff && storage.outId(storage.normId(wsEff.id)) !== ws.storage_profile_id),
    } : null,
    workspace_direct_fetch: ws && ws.storage_direct_fetch != null ? !!ws.storage_direct_fetch : null,
    presign_ttl_sec: storage.presignTtl(),
    can_allow_private: !!(req.isPlatformAdmin || config.selfHosted),
    migration: req.organizationId ? visibleMigration(req, a) : null,
  };
}

/** A workspace admin sees only a migration of their own workspace. */
function visibleMigration(req, a) {
  const m = migrate.latestFor(req.organizationId);
  if (!m || a.org) return m;
  return m.workspace_id && m.workspace_id === req.workspaceId ? m : null;
}

const workspaceNames = (orgId) => Object.fromEntries(db.prepare('SELECT id, name FROM workspaces WHERE organization_id = ?').all(orgId || '').map((w) => [w.id, w.name]));

router.get('/', (req, res) => {
  const a = requireStorageAccess(req, res);
  if (!a) return;
  // Instance rows, the org's shared rows, and workspace-owned rows: every one of them for an org
  // admin, only the current workspace's for a workspace admin.
  const rows = db.prepare(`SELECT * FROM storage_profiles
                             WHERE org_id IS NULL OR (org_id = ? AND (workspace_id IS NULL OR ? = 1 OR workspace_id = ?))
                             ORDER BY org_id IS NOT NULL, workspace_id IS NOT NULL, name`)
    .all(req.organizationId || '', a.org ? 1 : 0, req.workspaceId || '');
  const env = storage.envProfile();
  const names = workspaceNames(req.organizationId);
  const list = [storage.LOCAL_PROFILE, ...(env && env.id === storage.ENV_ID ? [env] : []), ...rows.map(storage.rowToProfile)];
  res.json({
    profiles: list.map((p) => ({
      ...storage.publicView(p), editable: mayEdit(req, p, a), in_use: inUse(p),
      workspace_name: p.workspace_id ? names[p.workspace_id] || null : null,
      // Can the CURRENT workspace write here? (an org admin also sees other workspaces' profiles)
      usable_here: !!(req.workspaceId && storage.profileForWorkspace(p.id, req.workspaceId)),
    })),
    settings: orgSettings(req, a),
  });
});

/*
 * The instance level, for Platform → System. Platform admins only. When the server's environment
 * sets STORAGE_PROVIDER, that is the instance default and the stored row (if any) is inactive —
 * the page shows both, so nobody edits a row that is not in effect without knowing.
 */
router.get('/instance', (req, res) => {
  if (!req.isPlatformAdmin) return res.status(403).json({ error: 'Platform admin required' });
  const env = storage.envProfile();
  const row = db.prepare('SELECT * FROM storage_profiles WHERE org_id IS NULL LIMIT 1').get();
  const eff = storage.instanceDefault();
  const p = row ? storage.rowToProfile(row) : null;
  res.json({
    effective_id: storage.outId(storage.normId(eff.id)),
    env: env && env.id === storage.ENV_ID ? storage.publicView(env) : (env && env.provider === 'local' && process.env.STORAGE_PROVIDER ? { provider: 'local', from_env: true } : null),
    profile: p ? { ...storage.publicView(p), editable: true, in_use: inUse(p), active: storage.outId(storage.normId(eff.id)) === p.id } : null,
    orgs_following: db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE storage_profile_id IS NULL').get().n,
    can_allow_private: true,
  });
});

function inUse(p) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM content_locations WHERE storage_profile_id IS ?').get(storage.normId(p.id)).n;
  return n;
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  // scope: 'instance' (platform admin), 'organization' (default; org admin), 'workspace' (the
  // current workspace's own profile; org admin, or a workspace admin when the org allows it).
  const scope = body.instance ? 'instance' : body.scope === 'workspace' ? 'workspace' : body.scope === 'instance' ? 'instance' : 'organization';
  let a = null;
  if (scope === 'instance') {
    if (!req.isPlatformAdmin) return res.status(403).json({ error: 'Only a platform administrator can create the instance default profile' });
  } else {
    a = requireStorageAccess(req, res);
    if (!a) return;
    if (scope === 'organization' && !a.org) return res.status(403).json({ error: 'Organization admin required' });
    if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
    if (scope === 'workspace' && !req.workspaceId) return res.status(403).json({ error: 'Switch to the workspace first' });
  }
  try {
    const v = await validate(req, body);
    const id = storage.newId();
    const orgId = scope === 'instance' ? null : req.organizationId;
    const wsId = scope === 'workspace' ? req.workspaceId : null;
    db.prepare(`INSERT INTO storage_profiles (id, org_id, workspace_id, name, provider, bucket, endpoint, public_endpoint, public_base_url, region, prefix,
                  force_path_style, credentials_enc, credentials_hint, mode, manage_scope, read_priority, presign, allow_private)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, wsId, v.name, v.provider, v.bucket, v.endpoint, v.public_endpoint, v.public_base_url, v.region, v.prefix,
           v.force_path_style, v.credentials_enc, v.credentials_hint, v.mode, v.manage_scope, v.read_priority, v.presign, v.allow_private);
    audit(req, 'storage_profile_create', `${v.provider} profile "${v.name}" (${id}) [${scope}${wsId ? ` ${wsId}` : ''}]`);
    res.status(201).json({ ...storage.publicView(storage.getProfile(id)), editable: true });
  } catch (e) {
    if (e && /UNIQUE/.test(e.message || '')) return res.status(409).json({ error: e.message.includes('instance') || (req.body && req.body.instance) ? 'An instance default profile already exists' : 'A profile with that name already exists' });
    sendErr(res, e);
  }
});

/*
 * By-id routes. A platform admin editing the INSTANCE row may have no organization context at all
 * (Platform → System), so an instance id resolves for them before the org/workspace rules apply.
 */
function instanceRowFor(req) {
  if (!req.isPlatformAdmin) return null;
  const p = storage.getProfile(req.params.id);
  return p && !p.synthetic && p.org_id == null ? p : null;
}
function loadForRoute(req, res) {
  const inst = instanceRowFor(req);
  if (inst) return { p: inst, a: { org: true, ws: false } };
  const a = requireStorageAccess(req, res);
  if (!a) return null;
  const p = loadProfile(req, res, a);
  return p ? { p, a } : null;
}

router.get('/:id', (req, res) => {
  const r = loadForRoute(req, res);
  if (!r) return;
  res.json({ ...storage.publicView(r.p), editable: mayEdit(req, r.p, r.a), in_use: inUse(r.p) });
});

router.put('/:id', async (req, res) => {
  const r = loadForRoute(req, res);
  if (!r) return;
  const p = r.p;
  if (!mayEdit(req, p, r.a)) return res.status(403).json({ error: p.synthetic ? 'This profile comes from the server configuration and cannot be edited here' : 'Only a platform administrator can edit an instance profile' });
  try {
    const v = await validate(req, req.body || {}, p);
    db.prepare(`UPDATE storage_profiles SET name = ?, bucket = ?, endpoint = ?, public_endpoint = ?, public_base_url = ?, region = ?, prefix = ?,
                  force_path_style = ?, credentials_enc = COALESCE(?, credentials_enc), credentials_hint = COALESCE(?, credentials_hint),
                  mode = ?, manage_scope = ?, read_priority = ?, presign = ?, allow_private = ?, updated_at = CAST(strftime('%s','now') AS INTEGER)
                WHERE id = ?`)
      .run(v.name, v.bucket, v.endpoint, v.public_endpoint, v.public_base_url, v.region, v.prefix, v.force_path_style,
           v.credentials_enc || null, v.credentials_hint || null, v.mode, v.manage_scope, v.read_priority, v.presign, v.allow_private, p.id);
    audit(req, 'storage_profile_update', `profile "${v.name}" (${p.id})${v.credentials_enc ? ' — credentials replaced' : ''}`);
    res.json({ ...storage.publicView(storage.getProfile(p.id)), editable: true });
  } catch (e) {
    if (e && /UNIQUE/.test(e.message || '')) return res.status(409).json({ error: 'A profile with that name already exists' });
    sendErr(res, e);
  }
});

router.delete('/:id', (req, res) => {
  const r = loadForRoute(req, res);
  if (!r) return;
  const p = r.p;
  if (!mayEdit(req, p, r.a)) return res.status(403).json({ error: 'This profile cannot be deleted here' });
  // A profile that still holds copies is where some row's bytes ARE; deleting it would orphan them.
  const n = inUse(p);
  if (n) return res.status(409).json({ error: `${n} stored file(s) still live in this profile. Migrate them elsewhere and drain first.` });
  if (db.prepare('SELECT 1 FROM organizations WHERE storage_profile_id = ? LIMIT 1').get(p.id)) return res.status(409).json({ error: 'This profile is an organization\'s default for new uploads' });
  if (db.prepare('SELECT 1 FROM workspaces WHERE storage_profile_id = ? LIMIT 1').get(p.id)) return res.status(409).json({ error: 'A workspace stores its new uploads here; point it elsewhere first' });
  if (db.prepare("SELECT 1 FROM storage_migrations WHERE target_profile_id = ? AND state IN ('copying','ready_to_commit','committed','draining') LIMIT 1").get(p.id)) return res.status(409).json({ error: 'A migration targets this profile' });
  db.prepare('DELETE FROM storage_profiles WHERE id = ?').run(p.id);
  audit(req, 'storage_profile_delete', `profile "${p.name}" (${p.id})`);
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const r = loadForRoute(req, res);
  if (!r) return;
  const out = await attach.testConnection(r.p);
  res.status(out.ok ? 200 : 200).json(out);
});

router.get('/:id/objects', async (req, res) => {
  const r = loadForRoute(req, res);
  if (!r) return;
  const p = r.p;
  if (p.provider === 'local') return res.status(400).json({ error: 'Local disk is not listed here' });
  try {
    res.json(await attach.listObjects(p, { prefix: String(req.query.prefix || ''), cursor: req.query.cursor ? String(req.query.cursor) : null, limit: req.query.limit }));
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/import', async (req, res) => {
  const a = requireStorageAccess(req, res);
  if (!a) return;
  if (!req.workspaceId) return res.status(403).json({ error: 'Switch to the workspace to import into first' });
  // Importing INTO this workspace: the source must be one this workspace may use.
  const p = storage.profileForWorkspace(req.params.id, req.workspaceId);
  if (!p) return res.status(404).json({ error: 'No such storage profile' });
  if (p.provider === 'local') return res.status(400).json({ error: 'Import from a bucket profile' });
  const { keys, mode, folder_id: folderId = null } = req.body || {};
  if (folderId) {
    const f = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folderId);
    if (!f || f.workspace_id !== req.workspaceId) return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
  }
  try {
    const out = await attach.importKeys(p, { keys, mode, workspaceId: req.workspaceId, userId: req.user.id, folderId });
    audit(req, 'storage_import', `${out.imported.length} object(s) by ${mode} from profile ${p.id}${out.errors.length ? `, ${out.errors.length} refused` : ''}`);
    res.status(out.imported.length ? 201 : 400).json(out);
  } catch (e) { sendErr(res, e); }
});

/*
 * Settings: the org's default write profile (new uploads only — never re-homes existing rows), and
 * whether this workspace's screens may fetch presigned bucket URLs directly.
 */
router.put('/settings/current', (req, res) => {
  const a = requireStorageAccess(req, res);
  if (!a) return;
  const b = req.body || {};
  if (('default_profile_id' in b || 'workspace_choice' in b) && !a.org) return res.status(403).json({ error: 'Organization admin required' });
  if ('workspace_choice' in b) {
    if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
    const v = bool01(b.workspace_choice) === 1 ? 1 : 0;
    db.prepare('UPDATE organizations SET storage_workspace_choice = ? WHERE id = ?').run(v, req.organizationId);
    audit(req, 'storage_workspace_choice', v ? 'workspace admins may choose their workspace\'s storage' : 'storage is chosen by the organization only');
  }
  if ('workspace_profile_id' in b) {
    if (!req.workspaceId) return res.status(403).json({ error: 'Switch to the workspace first' });
    if (migrate.activeFor(req.organizationId)) return res.status(409).json({ error: 'A migration is running; commit or abort it first' });
    // null = follow the organization; 'local' = local disk even if the org/instance uses a bucket.
    const target = b.workspace_profile_id == null ? null : storage.profileForWorkspace(b.workspace_profile_id, req.workspaceId);
    if (b.workspace_profile_id != null && !target) return res.status(404).json({ error: 'No such storage profile' });
    if (target && target.mode !== 'rw') return res.status(400).json({ error: 'A read-only profile cannot receive uploads' });
    if (target && target.credentials_unreadable) return res.status(400).json({ error: 'This profile\'s key must be re-entered first' });
    const stored = target ? (target.id === storage.LOCAL_ID ? storage.LOCAL_ID : target.id === storage.ENV_ID ? null : target.id) : null;
    db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(stored, req.workspaceId);
    audit(req, 'storage_workspace_default_set', `workspace ${req.workspaceId}: new uploads -> ${stored || 'organization default'}`);
  }
  if ('default_profile_id' in b) {
    if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
    if (migrate.activeFor(req.organizationId)) return res.status(409).json({ error: 'A migration is running; commit or abort it first' });
    const target = b.default_profile_id == null ? null : storage.profileForOrg(b.default_profile_id, req.organizationId);
    if (b.default_profile_id != null && !target) return res.status(404).json({ error: 'No such storage profile' });
    if (target && target.mode !== 'rw') return res.status(400).json({ error: 'A read-only profile cannot receive uploads' });
    // null = follow the instance default; 'local' = local disk even if the instance default is a bucket.
    const stored = target ? (target.id === storage.LOCAL_ID ? storage.LOCAL_ID : target.id === storage.ENV_ID ? null : target.id) : null;
    db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(stored, req.organizationId);
    audit(req, 'storage_default_set', `new uploads -> ${stored || 'instance default'}`);
  }
  if ('workspace_direct_fetch' in b) {
    if (!req.workspaceId || !canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
    const v = b.workspace_direct_fetch == null ? null : (bool01(b.workspace_direct_fetch) === 1 ? 1 : 0);
    db.prepare('UPDATE workspaces SET storage_direct_fetch = ? WHERE id = ?').run(v, req.workspaceId);
  }
  res.json(orgSettings(req, a));
});

/* ───────────────────────────── migration ───────────────────────────── */

router.get('/migration/current', (req, res) => {
  const a = requireStorageAccess(req, res);
  if (!a) return;
  res.json({ migration: req.organizationId ? visibleMigration(req, a) : null });
});

/*
 * Moves. body.scope 'workspace' moves the CURRENT workspace's media (and pins its override to the
 * target on commit); otherwise the move is org-wide and leaves workspaces with an override alone.
 * A workspace admin can only ever move their own workspace, and only act on its own migration.
 */
function migrationRoute(fn, action) {
  return async (req, res) => {
    const a = requireStorageAccess(req, res);
    if (!a) return;
    if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
    const p = loadProfile(req, res, a);
    if (!p) return;
    const wantWs = (req.body && req.body.scope === 'workspace') || !a.org;
    if (wantWs && !req.workspaceId) return res.status(403).json({ error: 'Switch to the workspace first' });
    if (!a.org) {
      const m = migrate.latestFor(req.organizationId);
      if (action !== 'storage_migrate_start' && !(m && m.workspace_id === req.workspaceId)) return res.status(403).json({ error: 'Organization admin required' });
    }
    try {
      const out = await fn(req, p, wantWs);
      audit(req, action, `target ${storage.outId(storage.normId(p.id))}${wantWs ? ` [workspace ${req.workspaceId}]` : ''}`);
      res.json(out);
    } catch (e) { sendErr(res, e); }
  };
}

router.post('/:id/migrate', migrationRoute((req, p, ws) => ({ migration: migrate.start(ws ? { orgId: req.organizationId, workspaceId: req.workspaceId } : req.organizationId, p.id) }), 'storage_migrate_start'));
router.post('/:id/migrate/commit', migrationRoute((req, p) => ({ migration: migrate.commit(req.organizationId, p.id) }), 'storage_migrate_commit'));
router.post('/:id/migrate/abort', migrationRoute((req, p) => ({ migration: migrate.abort(req.organizationId, p.id) }), 'storage_migrate_abort'));
router.post('/:id/migrate/drain', migrationRoute(async (req) => ({ drained: await migrate.drain(req.organizationId), migration: migrate.latestFor(req.organizationId) }), 'storage_migrate_drain'));

module.exports = router;
