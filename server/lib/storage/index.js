'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { db } = require('../../db/database');
const secretbox = require('../secretbox');
const { LocalBackend } = require('./local');
const { StorageError, StorageRefusedError } = require('./errors');
const breaker = require('./breaker');

/*
 * ⚠️ THE ONE PLACE THAT DECIDES WHERE A CONTENT ROW'S BYTES LIVE. Callers ask this module for a
 * backend; nothing outside lib/storage imports an AWS or Azure SDK, and nothing outside it builds
 * a bucket key. See docs/storage.md for the operator's view.
 *
 * Profile ids:
 *   'local'  local disk (config.contentDir). Stored as NULL in content_locations / content.
 *   'env'    the instance default synthesized from STORAGE_PROVIDER + S3_* / AZURE_* env. It is
 *            never written to SQLite, and neither are its credentials.
 *   <uuid>   a storage_profiles row.
 *
 * ⚠️ ENV WINS OVER A NULL-ORG ROW. When STORAGE_PROVIDER is set, the instance default is the env
 * profile even if a platform admin once saved an instance-default row in the database. The reason
 * is redeploys: an operator who changes the bucket in their compose file and redeploys must get
 * that bucket, not have it silently overridden by a row an old version of them saved through the
 * UI. Unset STORAGE_PROVIDER and the row (if any) is the default; neither, and it is local disk.
 * test/storage-profiles.test.js pins this.
 *
 * ⚠️ A PROFILE OF ORG A IS NEVER RESOLVABLE FOR A WORKSPACE OF ORG B. profileForWorkspace() and
 * profileForOrg() are the only ways a route turns an id into a profile, and both refuse a
 * cross-org id with the same answer as "no such profile".
 *
 * THREE LEVELS, ONE RULE for where a workspace's NEW uploads go:
 *   workspace override (workspaces.storage_profile_id) -> organization default
 *   (organizations.storage_profile_id) -> instance default (env, else the null-org row, else local).
 * A profile can be owned by the instance (org_id NULL), an organization (org_id, workspace_id NULL)
 * or one workspace (org_id + workspace_id). A workspace-owned profile is visible to that workspace
 * only — its sibling workspaces in the same organization resolve it as "no such profile", exactly
 * like another organization's.
 */

const LOCAL_ID = 'local';
const ENV_ID = 'env';

const LOCAL_PROFILE = Object.freeze({
  id: LOCAL_ID, org_id: null, name: 'Local disk', provider: 'local', mode: 'rw', manage_scope: 'all',
  read_priority: Number(process.env.STORAGE_LOCAL_READ_PRIORITY || 0), presign: 0, synthetic: true,
});

const normId = (id) => (id == null || id === '' || id === LOCAL_ID ? null : String(id));
const outId = (id) => (id == null ? LOCAL_ID : id);

/* ───────────────────────────── env (instance default) ───────────────────────────── */

/**
 * The env-configured instance default, or null. Read lazily (not frozen into config.js at require
 * time) so the value a test or a reload sets is the value used.
 */
function envProfile() {
  const e = process.env;
  const provider = String(e.STORAGE_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;
  if (provider === 'local') return { ...LOCAL_PROFILE, from_env: true };
  const base = {
    id: ENV_ID, org_id: null, name: 'Instance default (environment)', provider, synthetic: true, from_env: true,
    mode: 'rw', manage_scope: 'st', read_priority: Number(e.STORAGE_READ_PRIORITY || 100), presign: e.STORAGE_PRESIGN === 'false' ? 0 : 1,
    // Env is the operator's own configuration, not a tenant's input: MinIO on the compose network
    // resolves to a private address and must work. Metadata/link-local stay refused regardless.
    allow_private: e.STORAGE_ALLOW_PRIVATE_ENDPOINT === 'false' ? 0 : 1,
  };
  if (provider === 's3') {
    const endpoint = (e.S3_ENDPOINT || '').trim() || null;
    const fps = e.S3_FORCE_PATH_STYLE;
    return {
      ...base, bucket: e.S3_BUCKET || '', endpoint, public_endpoint: (e.S3_PUBLIC_ENDPOINT || '').trim() || null,
      public_base_url: (e.S3_PUBLIC_BASE_URL || '').trim() || null,
      region: (e.S3_REGION || '').trim() || null, prefix: sanitizePrefix(e.S3_PREFIX || ''),
      force_path_style: fps == null || fps === '' ? null : (fps === 'true' ? 1 : 0),
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID || '', secretAccessKey: e.S3_SECRET_ACCESS_KEY || '', sessionToken: e.S3_SESSION_TOKEN || undefined },
    };
  }
  if (provider === 'azure') {
    return {
      ...base, bucket: e.AZURE_STORAGE_CONTAINER || '', endpoint: (e.AZURE_STORAGE_ENDPOINT || '').trim() || null,
      public_endpoint: (e.AZURE_STORAGE_PUBLIC_ENDPOINT || '').trim() || null,
      prefix: sanitizePrefix(e.AZURE_STORAGE_PREFIX || ''),
      credentials: {
        connectionString: e.AZURE_STORAGE_CONNECTION_STRING || undefined,
        accountName: e.AZURE_STORAGE_ACCOUNT || undefined,
        accountKey: e.AZURE_STORAGE_ACCOUNT_KEY || undefined,
        sasToken: e.AZURE_STORAGE_SAS_TOKEN || undefined,
      },
    };
  }
  console.warn(`[storage] STORAGE_PROVIDER=${provider} is not one of local|s3|azure; using local disk`);
  return { ...LOCAL_PROFILE, from_env: true };
}

/* ───────────────────────────── keys & prefixes ───────────────────────────── */

/** An operator-typed prefix: no `..`, no leading slash, no backslash, no empty segments. */
function sanitizePrefix(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s.includes('\\') || s.startsWith('/') || s.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new StorageRefusedError('A storage prefix may not contain "..", a backslash, or start with "/".');
  }
  const out = s.replace(/\/+$/, '');
  if (out.split('/').some((seg) => seg === '')) throw new StorageRefusedError('A storage prefix may not contain empty segments.');
  return out;
}

/** A key from list/import or anywhere outside this module. */
function assertSafeKey(key) {
  const k = String(key || '');
  if (!k || k.length > 1024) throw new StorageRefusedError('Refusing an empty or overlong object key.');
  if (k.startsWith('/') || k.includes('\\') || k.split('/').some((seg) => seg === '..' || seg === '.') || /[\u0000-\u001f]/.test(k)) {
    throw new StorageRefusedError('Refusing an object key containing "..", a backslash, a control character, or a leading "/".');
  }
  return k;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function extOf(name) {
  const m = /(\.[A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
function idPart(v, what) {
  const s = String(v || '');
  if (!SAFE_ID.test(s)) throw new StorageRefusedError(`Refusing to build a key from an unsafe ${what}.`);
  return s;
}

/*
 * Keys are generated HERE, from ids and the digest — never from the uploader's file name, which is
 * attacker-chosen and could say anything (`../../`, a 4 KB emoji string, another tenant's prefix).
 */
const keys = {
  asset: (orgId, wsId, sha, ext) => `st/${idPart(orgId || '_', 'org id')}/${idPart(wsId || '_', 'workspace id')}/${hexOrThrow(sha)}${extOf(ext)}`,
  thumb: (orgId, wsId, sha) => `st/${idPart(orgId || '_', 'org id')}/${idPart(wsId || '_', 'workspace id')}/thumbs/${hexOrThrow(sha)}.jpg`,
  subtitle: (orgId, wsId, sha, ext) => `st/${idPart(orgId || '_', 'org id')}/${idPart(wsId || '_', 'workspace id')}/subs/${hexOrThrow(sha)}${extOf(ext)}`,
  history: (orgId, wsId, contentId, rev, sha, ext) => `st/${idPart(orgId || '_', 'org id')}/${idPart(wsId || '_', 'workspace id')}/history/${idPart(contentId, 'content id')}/${idPart(rev, 'revision')}/${hexOrThrow(sha)}${extOf(ext)}`,
};
function hexOrThrow(sha) {
  if (!HEX64.test(String(sha || ''))) throw new StorageRefusedError('A bucket key needs the sha256 of the bytes.');
  return sha;
}

/* ───────────────────────────── profiles ───────────────────────────── */

function rowToProfile(row) {
  if (!row) return null;
  let credentials = null;
  if (row.credentials_enc) {
    const plain = secretbox.decrypt(row.credentials_enc);
    try { credentials = plain ? JSON.parse(plain) : null; } catch (_) { credentials = null; }
  }
  return {
    ...row, credentials,
    // A secretbox blob that no longer decrypts means JWT_SECRET was rotated. The profile is still
    // listed (so the operator can re-enter the key) but cannot connect.
    credentials_unreadable: !!row.credentials_enc && !credentials,
  };
}

/** Any profile by id, unscoped. Internal: routes must use profileForOrg / profileForWorkspace. */
function getProfile(id) {
  const n = normId(id);
  if (n === null) return LOCAL_PROFILE;
  if (n === ENV_ID) { const e = envProfile(); return e && e.id === ENV_ID ? e : null; }
  return rowToProfile(db.prepare('SELECT * FROM storage_profiles WHERE id = ?').get(n));
}

/** The instance default: env, else the null-org row, else local. */
function instanceDefault() {
  const e = envProfile();
  if (e) return e;
  const row = db.prepare('SELECT * FROM storage_profiles WHERE org_id IS NULL LIMIT 1').get();
  return row ? rowToProfile(row) : LOCAL_PROFILE;
}

function orgOfWorkspace(workspaceId) {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  return r ? r.organization_id : null;
}

/**
 * Is this profile usable by this org (and, for a workspace-owned profile, this workspace)?
 * Instance-level profiles (local, env, null-org) are usable by all. Without a workspaceId only the
 * org's SHARED profiles count — a workspace's own profile is never an organization-wide answer.
 */
function visibleToOrg(profile, orgId, workspaceId = null) {
  if (!profile) return false;
  if (profile.org_id == null) return true;
  if (!orgId || profile.org_id !== orgId) return false;
  return !profile.workspace_id || (!!workspaceId && profile.workspace_id === workspaceId);
}

function profileForOrg(id, orgId) {
  const p = getProfile(id);
  return visibleToOrg(p, orgId) ? p : null;
}

function profileForWorkspace(id, workspaceId) {
  const p = getProfile(id);
  return visibleToOrg(p, orgOfWorkspace(workspaceId), workspaceId) ? p : null;
}

/**
 * Org admin management view: any profile of the org, including every workspace's own. Used only
 * to EDIT or DELETE a profile, never to choose where a workspace writes (that is profileForWorkspace).
 */
function profileForOrgAdmin(id, orgId) {
  const p = getProfile(id);
  if (!p) return null;
  if (p.org_id == null) return p;
  return orgId && p.org_id === orgId ? p : null;
}

/** The org's default write profile (organizations.storage_profile_id), else the instance default. */
function orgDefaultProfile(orgId) {
  if (orgId) {
    const r = db.prepare('SELECT storage_profile_id FROM organizations WHERE id = ?').get(orgId);
    if (r && r.storage_profile_id) {
      const p = profileForOrg(r.storage_profile_id, orgId);
      if (p && p.mode === 'rw') return p;
      if (r.storage_profile_id === LOCAL_ID) return LOCAL_PROFILE;
    }
  }
  return instanceDefault();
}

/** The workspace's raw override (NULL = follows its organization). */
function workspaceOverride(workspaceId) {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT storage_profile_id FROM workspaces WHERE id = ?').get(workspaceId);
  return (r && r.storage_profile_id) || null;
}

/**
 * Where this workspace's new uploads go when nothing is migrating: its own override when that still
 * resolves to a writable profile it may use, else its organization's default. A dangling or
 * read-only override falls back rather than failing uploads — the settings page reports it.
 */
function workspaceDefaultProfile(workspaceId) {
  const orgId = orgOfWorkspace(workspaceId);
  const o = workspaceOverride(workspaceId);
  if (o) {
    if (o === LOCAL_ID) return LOCAL_PROFILE;
    const p = profileForWorkspace(o, workspaceId);
    if (p && p.mode === 'rw' && !p.credentials_unreadable) return p;
  }
  return orgDefaultProfile(orgId);
}

/**
 * Where a NEW file for this workspace is written: { primary, dualWrite }.
 *
 * During a live migration (copying / ready_to_commit) new uploads go to the TARGET as primary —
 * "do not insert a row whose only copy is a place you are trying to leave" — and to the old
 * default as a best-effort replica, so that an abort still has every file where it started.
 */
function writeTargetsForWorkspace(workspaceId) {
  const orgId = orgOfWorkspace(workspaceId);
  const current = workspaceDefaultProfile(workspaceId);
  if (orgId) {
    // A migration applies to this workspace when it is scoped to it, or when it is org-wide and the
    // workspace follows the organization (an override opts the workspace out of org-wide moves).
    const mig = db.prepare(`SELECT * FROM storage_migrations WHERE org_id = ? AND state IN ('copying','ready_to_commit')
                              AND (workspace_id = ? OR (workspace_id IS NULL AND ? IS NULL)) LIMIT 1`)
      .get(orgId, workspaceId, workspaceOverride(workspaceId));
    if (mig) {
      const target = getProfile(mig.target_profile_id);
      if (target && target.mode === 'rw' && visibleToOrg(target, orgId, workspaceId)) {
        const same = outId(normId(target.id)) === outId(normId(current.id));
        return { primary: target, dualWrite: same ? null : current, orgId, migrationId: mig.id };
      }
    }
  }
  return { primary: current, dualWrite: null, orgId, migrationId: null };
}

/* ───────────────────────────── backends ───────────────────────────── */

const backendCache = new Map();
let testFactory = null;   // tests only: (profile) => backend | null

function rawBackend(profile) {
  if (!profile || profile.provider === 'local') return new LocalBackend({ dir: config.contentDir });
  if (testFactory) { const be = testFactory(profile); if (be) return be; }
  const cacheKey = `${profile.id}:${profile.updated_at || ''}`;
  if (backendCache.has(cacheKey)) return backendCache.get(cacheKey);
  let be;
  if (profile.provider === 's3') be = new (require('./s3').S3Backend)(profile);
  else if (profile.provider === 'azure') be = new (require('./azure').AzureBackend)(profile);
  else throw new StorageError('unavailable', 'Unknown storage provider.', { profileId: profile.id });
  for (const k of backendCache.keys()) if (k.startsWith(`${profile.id}:`)) backendCache.delete(k);
  backendCache.set(cacheKey, be);
  return be;
}

/*
 * ⚠️ THE WRITE GUARD IS HERE, IN THE BACKEND, NOT IN THE UI. A read-only profile cannot be put to
 * or deleted from by ANY caller — a migration bug, a drain, a future route — because the wrapper
 * refuses before a request leaves the process. manage_scope 'st' confines writes to keys under
 * `st/` (after the profile prefix), so a bucket shared with the operator's own objects only ever
 * gains or loses things ScreenTinker named.
 */
function mayWrite(profile, key) {
  if (!profile || profile.provider === 'local') return true;
  if (profile.mode !== 'rw') return false;
  if (profile.manage_scope === 'all') return true;
  if (profile.manage_scope === 'st') return String(key).startsWith('st/');
  return false;
}

function guardWrite(profile, key, verb) {
  if (!mayWrite(profile, key)) {
    throw new StorageRefusedError(`This storage profile does not allow ScreenTinker to ${verb} that key.`, { profileId: profile && profile.id, key });
  }
}

/** A backend with the write guard and breaker bookkeeping applied. */
function backendFor(profile) {
  const be = rawBackend(profile);
  const pid = profile && profile.provider !== 'local' ? profile.id : null;
  const track = async (fn) => {
    try { const out = await fn(); breaker.success(pid); return out; }
    catch (e) {
      if (require('./errors').isLocationFailure(e)) breaker.failure(pid, e);
      throw e;
    }
  };
  return {
    provider: be.provider,
    profile,
    raw: be,
    put: async (key, body, opts) => { guardWrite(profile, key, 'write'); return track(() => be.put(key, body, opts)); },
    putFile: async (key, filePath, opts) => { guardWrite(profile, key, 'write'); return track(() => be.putFile(key, filePath, opts)); },
    delete: async (key) => { guardWrite(profile, key, 'delete'); return track(() => be.delete(key)); },
    copy: async (from, to) => { guardWrite(profile, to, 'write'); return track(() => be.copy(from, to)); },
    getStream: (key, opts) => track(() => be.getStream(key, opts)),
    head: (key) => track(() => be.head(key)),
    exists: (key) => track(() => be.exists(key)),
    list: (prefix, opts) => track(() => be.list(prefix, opts)),
    probe: () => track(() => (be.probe ? be.probe() : be.list('', { limit: 1 }))),
    presignGet: (key, opts) => (profile && profile.presign === 0 ? null : be.presignGet(key, opts)),
    presignPut: () => null,
    existsSync: be.existsSync ? (key) => be.existsSync(key) : null,
  };
}

/** Clamp a presign TTL: floor 60 s, ceiling 1 h. */
function presignTtl(sec) {
  const n = Number(sec != null ? sec : process.env.STORAGE_PRESIGN_TTL_SEC || 900);
  if (!Number.isFinite(n)) return 900;
  return Math.min(3600, Math.max(60, Math.floor(n)));
}

/* ───────────────────────────── presentation ───────────────────────────── */

/*
 * What a GET returns about a profile. Credentials are NEVER returned, in any form: `configured`
 * says whether there are any, `hint` is the last four characters of the key id (or account name)
 * so an operator can tell two profiles apart, and `credentials_unreadable` tells them the JWT
 * secret was rotated and the key must be re-entered.
 */
function publicView(p) {
  if (!p) return null;
  return {
    id: outId(normId(p.id)), org_id: p.org_id || null, workspace_id: p.workspace_id || null,
    scope: p.org_id == null ? 'instance' : p.workspace_id ? 'workspace' : 'organization',
    name: p.name, provider: p.provider,
    bucket: p.bucket || null, endpoint: p.endpoint || null, public_endpoint: p.public_endpoint || null,
    public_base_url: p.public_base_url || null, region: p.region || null, prefix: p.prefix || null,
    force_path_style: p.force_path_style == null ? null : !!p.force_path_style,
    mode: p.mode, manage_scope: p.manage_scope, read_priority: p.read_priority,
    presign: p.presign !== 0, allow_private: !!p.allow_private,
    configured: p.provider === 'local' ? true : !!(p.credentials_enc || (p.credentials && Object.values(p.credentials).some(Boolean))),
    hint: p.credentials_hint || (p.from_env ? hintOf(p.credentials) : null),
    credentials_unreadable: !!p.credentials_unreadable,
    synthetic: !!p.synthetic, from_env: !!p.from_env,
    created_at: p.created_at || null, updated_at: p.updated_at || null,
  };
}

function hintOf(creds) {
  if (!creds) return null;
  const id = creds.accessKeyId || creds.accountName || (creds.connectionString && (/AccountName=([^;]+)/.exec(creds.connectionString) || [])[1]) || null;
  if (id) return String(id).slice(-4);
  return creds.sasToken ? 'SAS' : null;
}

function newId() { return crypto.randomUUID(); }

module.exports = {
  LOCAL_ID, ENV_ID, LOCAL_PROFILE, normId, outId,
  envProfile, instanceDefault, getProfile, profileForOrg, profileForWorkspace, profileForOrgAdmin, orgOfWorkspace, visibleToOrg,
  orgDefaultProfile, workspaceOverride, workspaceDefaultProfile, writeTargetsForWorkspace,
  backendFor, rawBackend, mayWrite, presignTtl,
  keys, sanitizePrefix, assertSafeKey, extOf,
  publicView, hintOf, rowToProfile, newId,
  _clearBackendCache: () => backendCache.clear(),
  /** Tests only: substitute a backend (e.g. in-memory) for non-local profiles. */
  _setBackendFactory: (fn) => { testFactory = fn || null; backendCache.clear(); },
};
