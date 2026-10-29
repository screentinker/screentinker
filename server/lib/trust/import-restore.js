'use strict';

/*
 * Restoring ONE organization from its export into ONE organization on this server
 * (lib/trust/import.js runs it as a job; docs/move-server.md is the user-facing description).
 *
 * SHAPE
 *   scan()     reads every entry once, checking each against the manifest's digests, checks that
 *              every row belongs to the exported organization (a row outside it refuses the whole
 *              archive — an archive can be edited by hand), and summarises: workspaces, screens,
 *              media size against this server's room, members, what needs reconnecting, what is not
 *              restored and why. It writes nothing.
 *   restore()  phases, each resumable:
 *                ids      a new id for every row that has one, stored (org_import_ids) before any
 *                         row is written, so every reference can be rewritten whatever order the
 *                         tables come in — and a resumed job reuses exactly the same ids;
 *                rows     table by table in dependency order, in batches; each batch commits in ONE
 *                         transaction with the job's cursor, so a restart resumes at the next batch;
 *                members  people become pending invites (an organization import) or accounts and
 *                         memberships (a whole-server restore);
 *                finish   organization settings, the screen list and the reconnect checklist.
 *   rollback() deletes what the job created: a new organization entirely; in an existing (empty)
 *              organization, the workspaces it created and the organization-level rows it wrote.
 *
 * ⚠️ NEVER OVERWRITES. Rows get new ids, files are written with O_EXCL (an existing file is reused
 * only when its bytes hash the same), and a value that must be unique and is taken here gets a fresh
 * one. Nothing outside the target organization is written, except the files in the shared media
 * directory and — in a whole-server restore only — the accounts of its people.
 *
 * ⚠️ A REFERENCE NOT IN THE ARCHIVE IS DROPPED, NEVER KEPT. Kept as written it could name a row
 * that exists on this server and belongs to another organization (lib/trust/import-tables.js REFS).
 * Inside JSON, an id-shaped token that is not in the archive is replaced by a fresh one that names
 * nothing, except inside URLs (an external service's own ids).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const exportTables = require('./export-tables');
const T = require('./import-tables');
const archive = require('./import-archive');
const { ImportError } = archive;

const BATCH = 400;
// Tables an import drops even when an archive carries them (see scan()).
const NEVER_IMPORTED = Object.freeze(['device_wifi_networks']);
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const SPECIAL = new Set(['organizations', 'users', 'organization_members', 'workspace_members']);
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf']);
const INVITE_DAYS = 14;
const now = () => Math.floor(Date.now() / 1000);
const tick = () => new Promise((r) => setImmediate(r));
const uuid = () => crypto.randomUUID();
const tableName = (n) => n.replace(/^tables\//, '').replace(/\.jsonl$/, '');

/* ───────────── schema ───────────── */

function schemaOf(db) {
  const cache = new Map();
  return (table) => {
    if (cache.has(table)) return cache.get(table);
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const fks = new Map();
    for (const f of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) fks.set(f.from, f.table);
    const byName = new Map(cols.map((c) => [c.name, c]));
    const idCol = byName.get('id');
    const pkCols = cols.filter((c) => c.pk);
    const info = {
      exists: cols.length > 0, cols, byName, fks,
      textId: !!(idCol && idCol.pk && pkCols.length === 1 && !/INT/i.test(idCol.type || '')),
      intId: !!(idCol && idCol.pk && pkCols.length === 1 && /INT/i.test(idCol.type || '')),
    };
    cache.set(table, info);
    return info;
  };
}

/** The tables a restore writes in its rows phase, parents before children. */
function restoreOrder(db, { instance, options, present }) {
  const schema = schemaOf(db);
  const wanted = Object.keys(exportTables.EXPORTED).filter((t) => {
    if (SPECIAL.has(t)) return false;
    const d = T.decision(t, { instance });
    if (!d || !d.restore) return false;
    const opt = T.optionalOf(t);
    if (opt && options && options[`include_${opt}`] === false) return false;
    return schema(t).exists && (!present || present.has(t));
  });
  const set = new Set(wanted);
  const deps = new Map(wanted.map((t) => {
    const s = schema(t);
    const d = new Set();
    for (const target of s.fks.values()) if (target !== t && set.has(target)) d.add(target);
    for (const [k, target] of Object.entries(T.INT_REFS)) if (k.startsWith(`${t}.`) && set.has(target)) d.add(target);
    const sc = exportTables.EXPORTED[t].scope;
    if (sc.via && sc.parent !== t && set.has(sc.parent)) d.add(sc.parent);
    return [t, d];
  }));
  const order = [];
  const done = new Set();
  let progress = true;
  while (order.length < wanted.length && progress) {
    progress = false;
    for (const t of wanted) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every((x) => done.has(x))) { order.push(t); done.add(t); progress = true; }
    }
  }
  // A cycle (none today): whatever is left goes in classification order; its references are still
  // rewritten (ids are allocated first), only a declared foreign key could refuse a row, and that
  // row is counted as dropped rather than failing the restore.
  for (const t of wanted) if (!done.has(t)) order.push(t);
  return order;
}

/* ───────────── scan ───────────── */

const CREDENTIAL_TABLES = {
  org_sso_providers: 'sso',
  org_m365_apps: 'm365',
  canva_integrations: 'canva',
  bi_connections: 'bi',
  social_connections: 'social',
  room_connections: 'rooms',
  storage_profiles: 'storage',
  automation_hooks: 'automation_hook',
  api_tokens: 'api_token',
  automation_subscriptions: 'webhook',
  scim_tokens: 'scim',
  org_sso_domains: 'sso_domain',
};

/** Does this data source need a credential this archive cannot carry? */
function dataSourceNeedsSecret(row) {
  let cfg = {};
  try { cfg = JSON.parse(row.config || '{}') || {}; } catch (_) { cfg = {}; }
  let type = null;
  try { type = require('../data-sources/builtin-types').getBuiltinType(row.type); } catch (_) { type = null; }
  if (!type) return { needs: true, fields: [] };   // a plugin type: its secret fields are unknown here
  const fields = (type.fields || []).filter((f) => f.type === 'password').map((f) => f.name);
  if (!fields.length) return { needs: false, fields: [] };
  if (row.type === 'rest' && (!cfg.auth_type || cfg.auth_type === 'none')) return { needs: false, fields: [] };
  const missing = fields.filter((f) => cfg[f] == null || cfg[f] === '');
  return { needs: missing.length > 0, fields: missing };
}

/**
 * Check and summarise an archive. `ctx`: { db, importerId, instance, targetOrgId? }.
 * Throws ImportError when the archive must be refused.
 */
async function scan(arch, ctx, onProgress = () => {}) {
  const { db } = ctx;
  if (arch.kind !== 'org') throw new ImportError('This is a whole-server bundle; import it from Platform → Data & privacy.', 'is_bundle');
  const m = arch.manifest;
  const orgId = m.organization.id;
  /*
   * #720: Wi-Fi passwords are never imported. The export leaves the table out (export-tables.js
   * EXCLUDED), so a genuine archive never carries it; one that does (hand-edited, or from a fork) has
   * it dropped here, explicitly, rather than refused as an unknown table or restored by accident.
   */
  const tablesIn = new Set([...arch.entries.keys()].filter((n) => n.startsWith('tables/')).map(tableName)
    .filter((t) => !NEVER_IMPORTED.includes(t)));
  const unknownTables = [...tablesIn].filter((t) => !exportTables.EXPORTED[t]);
  if (unknownTables.length) throw new ImportError(`The archive contains tables this server does not know (${unknownTables.slice(0, 5).join(', ')}). Update this server first.`, 'newer_export');

  // Parents first, so a child's scope can be checked against the ids its parent table holds.
  const order = Object.keys(exportTables.EXPORTED).filter((t) => tablesIn.has(t));
  const first = ['organizations', 'workspaces', 'organization_members', 'workspace_members'];
  order.sort((a, b) => (first.indexOf(a) < 0 ? 99 : first.indexOf(a)) - (first.indexOf(b) < 0 ? 99 : first.indexOf(b)));
  const parents = new Set(Object.values(exportTables.EXPORTED).filter((s) => s.scope.via).map((s) => s.scope.parent));
  const ids = new Map();               // parent table -> Set of its key values
  const wsIds = new Set();
  const memberIds = new Set();
  const counts = {};
  const summary = {
    organization: { id: orgId, name: String(m.organization.name || '') },
    exported_at: m.exported_at || null,
    workspaces: [], members: [], devices: [], integrations: [], data_sources: [],
    not_restored: [], warnings: [],
  };
  const orgMembers = new Map(), wsMembers = new Map();
  let done = 0;
  const total = arch.entries.size;

  for (const t of order) {
    const spec = exportTables.EXPORTED[t];
    const sc = spec.scope;
    const keep = parents.has(t) ? new Set() : null;
    const pkOf = (r) => (sc.pk && sc.pk !== 'id' ? r[sc.pk] : r.id);
    let n = 0;
    const d = T.decision(t, { instance: ctx.instance });
    await archive.readRows(arch, `tables/${t}.jsonl`, async (rows) => {
      for (const r of rows) {
        n += 1;
        // ⚠️ Every row must belong to the exported organization. One that does not is a hand-edited
        // (or corrupted) archive, and the whole archive is refused rather than the row quietly kept.
        let inside;
        if (sc.self) inside = r.id === orgId;
        else if (sc.org) inside = r[sc.org] === orgId;
        else if (sc.ws) inside = wsIds.has(r[sc.ws]);
        else if (sc.members) inside = memberIds.has(r.id);
        else if (sc.audit) inside = wsIds.has(r.workspace_id) || r.organization_id === orgId;
        else if (sc.via) inside = !!(ids.get(sc.parent) && ids.get(sc.parent).has(r[sc.via]));
        else inside = false;
        // A via table whose link column is itself redacted (api_token_targets.token_id) is never
        // restored, so there is nothing to protect; it is only counted.
        if (!inside && sc.via && !(sc.via in r) && !(d && d.restore)) inside = true;
        if (!inside) throw new ImportError(`The archive contains rows that do not belong to its organization (${t}). It was changed by hand or is damaged, and is refused.`, 'outside_org');
        if (keep) keep.add(pkOf(r));
        if (t === 'workspaces') { wsIds.add(r.id); summary.workspaces.push({ id: r.id, name: String(r.name || '') }); }
        if (t === 'organization_members') { memberIds.add(r.user_id); orgMembers.set(r.user_id, r.role); }
        if (t === 'workspace_members') {
          memberIds.add(r.user_id);
          if (!wsMembers.has(r.user_id)) wsMembers.set(r.user_id, []);
          wsMembers.get(r.user_id).push({ workspace_id: r.workspace_id, role: r.role });
        }
        if (t === 'users') {
          summary.members.push({ id: r.id, email: String(r.email || '').toLowerCase(), name: String(r.name || ''), role: r.role || 'user', auth_provider: r.auth_provider || 'local', disabled: !!r.disabled_at, org_role: null, workspaces: [] });
        }
        if (t === 'devices') summary.devices.push({ id: r.id, name: String(r.name || ''), workspace_id: r.workspace_id, client_type: r.client_type || null, platform: r.platform || null });
        if (t === 'data_sources') {
          const need = dataSourceNeedsSecret(r);
          summary.data_sources.push({ name: String(r.name || ''), type: String(r.type || ''), needs_secret: need.needs, fields: need.fields });
        }
        if (CREDENTIAL_TABLES[t]) summary.integrations.push({ kind: CREDENTIAL_TABLES[t], table: t, name: String(r.name || r.slug || r.domain || r.prefix || r.client_id || r.kind || '') });
        if (t === 'ai_settings' && (r.base_url || r.provider_kind || r.image_provider)) summary.integrations.push({ kind: 'ai', table: t, name: String(r.provider_kind || r.base_url || '') });
        if (t === 'rooms' && r.source === 'ics') summary.integrations.push({ kind: 'room_calendar', table: t, name: String(r.name || '') });
        if (t === 'cloud_folders') summary.integrations.push({ kind: 'cloud_folder', table: t, name: String(r.name || '') });
        if (t === 'triggers') summary.integrations.push({ kind: 'trigger', table: t, name: String(r.name || '') });
      }
    }, { batch: 1000 });
    if (keep) ids.set(t, keep);
    counts[t] = n;
    done += 1;
    onProgress({ phase: 'checking', done, total });
    await tick();
  }
  if (!wsIds.size) throw new ImportError('The archive contains no workspaces.', 'empty');
  if (counts.organizations !== 1) throw new ImportError('The archive must contain exactly its own organization.', 'outside_org');

  // Every other entry: media, fonts, workspace exports, README — digest-checked without writing.
  let mediaBytes = 0, mediaFiles = 0;
  for (const name of arch.entries.keys()) {
    if (name.startsWith('tables/') || name === 'manifest.json') continue;
    if (name.startsWith('files/') || name.startsWith('fonts/')) {
      const owner = name.split('/')[1];
      const table = name.startsWith('files/') ? 'content' : 'custom_fonts';
      if (!ids.get(table) || !ids.get(table).has(owner)) {
        // Parent sets exist only for parent tables; check against the rows instead.
        if (!(await rowExists(arch, table, owner))) throw new ImportError(`The archive contains a file for something not in it (${name.slice(0, 120)}).`, 'outside_org');
      }
      mediaBytes += arch.digest(name).bytes;
      mediaFiles += 1;
    }
    await archive.verifyEntry(arch, name);
    done += 1;
    onProgress({ phase: 'checking', done, total });
  }

  for (const p of summary.members) {
    p.org_role = orgMembers.get(p.id) || null;
    p.workspaces = (wsMembers.get(p.id) || []).map((w) => ({ ...w, name: (summary.workspaces.find((x) => x.id === w.workspace_id) || {}).name || '' }));
  }
  summary.counts = counts;
  summary.categories = Object.fromEntries(Object.entries(m.categories || {}).map(([k, v]) => [k, v && v.rows || 0]));
  summary.media = { files: mediaFiles, bytes: mediaBytes };
  for (const t of Object.keys(exportTables.EXPORTED)) {
    const d = T.decision(t, { instance: ctx.instance });
    if (d && !d.restore && counts[t]) summary.not_restored.push({ table: t, rows: counts[t], reason: d.reason });
  }
  for (const [t, why] of Object.entries(m.excluded_tables || {})) {
    // Left out by the export itself, but worth saying here: the site cache boxes and people's passkeys.
    if (['site_caches', 'webauthn_credentials'].includes(t)) summary.not_restored.push({ table: t, rows: null, reason: why });
  }
  summary.columns_removed = (m.redaction && m.redaction.columns_removed) || {};
  summary.history = {
    proof_of_play: Object.keys(T.RESTORED).filter((t) => T.optionalOf(t) === 'proof_of_play').reduce((n, t) => n + (counts[t] || 0), 0),
    audit: counts.activity_log || 0,
    history: Object.keys(T.RESTORED).filter((t) => T.optionalOf(t) === 'history').reduce((n, t) => n + (counts[t] || 0), 0),
  };
  return summary;
}

const _rowCache = new WeakMap();
async function rowExists(arch, table, id) {
  let byTable = _rowCache.get(arch);
  if (!byTable) { byTable = new Map(); _rowCache.set(arch, byTable); }
  if (!byTable.has(table)) {
    const s = new Set();
    await archive.readRows(arch, `tables/${table}.jsonl`, async (rows) => { for (const r of rows) s.add(r.id); }, { batch: 2000 });
    byTable.set(table, s);
  }
  return byTable.get(table).has(id);
}

/* ───────────── room on this server ───────────── */

/**
 * Will the media fit? The importer's plan allowance (null = unlimited) and the free disk. Checked at
 * scan time and again when the restore starts, BEFORE a byte is written.
 */
function roomFor(db, importerId, bytes, devices) {
  const out = { need_bytes: bytes, plan_room_bytes: null, disk_free_bytes: null, devices, device_limit: null, devices_now: 0, ok: true, reasons: [] };
  try {
    const sub = require('../../middleware/subscription');
    out.plan_room_bytes = sub.storageRoomBytes(importerId);
    const plan = sub.getUserPlan(importerId);
    if (plan && plan.max_devices !== -1) {
      out.device_limit = plan.max_devices;
      out.devices_now = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(importerId).n;
    }
  } catch (_) { /* no plan machinery: unlimited */ }
  try {
    fs.mkdirSync(config.contentDir, { recursive: true });
    const st = fs.statfsSync(config.contentDir);
    out.disk_free_bytes = Number(st.bavail) * Number(st.bsize);
  } catch (_) { out.disk_free_bytes = null; }
  if (out.plan_room_bytes != null && bytes > out.plan_room_bytes) { out.ok = false; out.reasons.push('plan_storage'); }
  // 10% and 256 MB headroom: the database grows too, and a full disk breaks the whole server.
  if (out.disk_free_bytes != null && bytes * 1.1 + 256 * 1024 * 1024 > out.disk_free_bytes) { out.ok = false; out.reasons.push('disk'); }
  if (out.device_limit != null && out.devices_now + devices > out.device_limit) { out.ok = false; out.reasons.push('plan_devices'); }
  return out;
}

/* ───────────── the restore ───────────── */

function loadMaps(db, jobId) {
  const maps = new Map();
  for (const r of db.prepare('SELECT tbl, old_id, new_id FROM org_import_ids WHERE job_id = ?').all(jobId)) {
    if (!maps.has(r.tbl)) maps.set(r.tbl, new Map());
    maps.get(r.tbl).set(r.old_id, r.new_id);
  }
  return maps;
}

class Restorer {
  /**
   * opts: { db, job, arch, importer: {id, email}, instance, options, orgId, srcOrgId, setProgress(progressObj) }
   * `orgId` is the destination organization (created by the caller for a new one).
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.schema = schemaOf(this.db);
    this.maps = loadMaps(this.db, this.job.id);
    this.all = new Map();        // every old id -> new id, any table
    this.foreign = new Map();    // an id-shaped token that is not in the archive -> a fresh one
    this.userMap = new Map();    // old user id -> new user id
    this.stats = {};
    this.progress = JSON.parse(this.job.progress || '{}');
    this.result = JSON.parse(this.job.result || '{}');
    this.insertSql = new Map();
  }

  map(table) { if (!this.maps.has(table)) this.maps.set(table, new Map()); return this.maps.get(table); }

  stat(table, key, n = 1) {
    if (!this.stats[table]) this.stats[table] = { restored: 0, dropped: 0, regenerated: 0, kept_existing: 0 };
    this.stats[table][key] = (this.stats[table][key] || 0) + n;
  }

  rebuildAll() {
    this.all = new Map();
    for (const [t, m] of this.maps) {
      if (t.includes(':')) continue;
      for (const [o, n] of m) {
        if (t === 'files') { this.mapFileName(o, n, false); continue; }
        this.all.set(o, n);
      }
    }
    for (const [o, n] of this.userMap) this.all.set(o, n);
    this.all.set(this.srcOrgId, this.orgId);
  }

  persist(tbl, pairs) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO org_import_ids (job_id, tbl, old_id, new_id) VALUES (?, ?, ?, ?)');
    for (const [o, n] of pairs) ins.run(this.job.id, tbl, String(o), String(n));
  }

  saveProgress(p) {
    this.progress = { ...this.progress, ...p };
    this.db.prepare("UPDATE org_imports SET progress = ?, updated_at = strftime('%s','now') WHERE id = ?").run(JSON.stringify(this.progress), this.job.id);
    if (this.onProgress) { try { this.onProgress(this.progress); } catch (_) { /* */ } }
  }

  /* ---------- value rewriting ---------- */

  mapUser(v, notnull) {
    if (v == null || v === '') return notnull ? this.importer.id : null;
    if (this.userMap.has(v)) return this.userMap.get(v);
    return notnull ? this.importer.id : null;
  }

  token(tok, neutralize) {
    if (this.all.has(tok)) return this.all.get(tok);
    const low = tok.toLowerCase();
    if (this.all.has(low)) return this.all.get(low);
    if (!neutralize) return tok;
    if (!this.foreign.has(low)) this.foreign.set(low, uuid());
    return this.foreign.get(low);
  }

  rewriteString(s, neutralize) {
    if (this.all.has(s)) return this.all.get(s);
    if (!UUID_RE.test(s)) { UUID_RE.lastIndex = 0; return s; }
    UUID_RE.lastIndex = 0;
    // An external service's URL keeps its own ids; everything else that looks like an id and is not
    // in the archive is made to name nothing.
    const n = neutralize && !s.includes('://');
    return s.replace(UUID_RE, (tok) => this.token(tok, n));
  }

  deep(v) {
    if (typeof v === 'string') return this.rewriteString(v, true);
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[this.rewriteString(k, true)] = this.deep(x);
      return o;
    }
    return v;
  }

  /** A free-text or JSON column: ids inside are rewritten. */
  loose(v) {
    if (typeof v !== 'string' || !v) return v;
    if (this.all.has(v)) return this.all.get(v);
    const c = v.trimStart()[0];
    if (c === '{' || c === '[') {
      try { return JSON.stringify(this.deep(JSON.parse(v))); } catch (_) { /* not JSON after all */ }
    }
    return this.rewriteString(v, false);
  }

  /** A reference column to `target`: the new id, or undefined when it names nothing in the archive. */
  ref(target, v) {
    if (v == null || v === '') return null;
    if (target === '*') return this.all.has(v) ? this.all.get(v) : undefined;
    if (target === 'users') return this.userMap.has(v) ? this.userMap.get(v) : undefined;
    if (target === 'organizations') return v === this.srcOrgId ? this.orgId : undefined;
    const m = this.maps.get(target);
    return m && m.has(String(v)) ? m.get(String(v)) : undefined;
  }

  /* ---------- one row ---------- */

  /** Build the row to insert, or null (with the reason counted) when it cannot be restored. */
  prepare(table, raw) {
    const s = this.schema(table);
    const refs = T.REFS[table] || {};
    const sc = exportTables.EXPORTED[table].scope;
    const row = {};
    for (const [col, v0] of Object.entries(raw)) {
      const c = s.byName.get(col);
      if (!c) continue;                         // a column this server does not have
      let v = v0;
      const notnull = !!c.notnull && c.dflt_value == null;
      const intRef = T.INT_REFS[`${table}.${col}`];
      if (col === 'id' && s.textId) {
        v = this.map(table).get(String(v0));
        if (!v) return this.drop(table, 'no_id');
      } else if (col === 'id' && s.intId) {
        continue;                               // the database assigns it
      } else if (T.SCOPE_COLUMNS.has(col)) {
        // The organization or one of its workspaces; anything else is outside the import.
        const scoping = sc.ws === col || sc.org === col;
        if (v0 == null || v0 === '') v = scoping ? undefined : null;
        else if (v0 === this.srcOrgId) v = this.orgId;
        else v = this.ref('workspaces', v0);
        if (v === undefined) {
          if (scoping || notnull) return this.drop(table, 'outside');
          v = null;
        }
      } else if (intRef) {
        const m = this.maps.get(`int:${intRef}`);
        v = v0 == null ? null : (m && m.has(String(v0)) ? Number(m.get(String(v0))) : undefined);
        if (v === undefined) { if (notnull) return this.drop(table, 'dangling'); v = null; }
      } else if (T.USER_COLUMNS.has(col) || s.fks.get(col) === 'users') {
        v = this.mapUser(v0, notnull);
      } else if (s.fks.has(col) || col in refs) {
        const target = col in refs ? refs[col] : s.fks.get(col);
        if (target === null) v = null;
        else if (target === 'external') v = v0;
        else if (target === 'plans') v = v0;
        else if (this.pos && this.deferredCols(table).some(([dc]) => dc === col)) {
          v = null;                               // filled in by applyDeferred once its target is in
        } else {
          v = this.ref(target, v0);
          if (v === undefined) { if (notnull) return this.drop(table, 'dangling'); v = null; }
        }
      } else if (typeof v0 === 'string') {
        v = this.loose(v0);
      }
      row[col] = v;
    }
    return row;
  }

  drop(table, why) { this.stat(table, 'dropped'); this.stat(table, `dropped_${why}`); return null; }

  insert(table, row) {
    const s = this.schema(table);
    // A NULL for a NOT NULL column with a default means "use the default", which only omitting it does.
    const cols = Object.keys(row).filter((k) => {
      if (k.startsWith('__')) return false;
      const c = s.byName.get(k);
      return !(row[k] === null && c && c.notnull && c.dflt_value != null);
    });
    const key = `${table}|${cols.join(',')}`;
    let st = this.insertSql.get(key);
    if (!st) {
      st = this.db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      this.insertSql.set(key, st);
    }
    return st.run(...cols.map((c) => row[c]));
  }

  /** Insert, regenerating a unique value that is taken here; null when the row cannot go in. */
  insertOne(table, raw) {
    let row = this.prepare(table, raw);
    if (!row) return null;
    const hook = HOOKS[table];
    if (hook) {
      row = hook(this, row, raw);
      if (!row) return this.drop(table, 'hook');
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = this.insert(table, row);
        this.stat(table, 'restored');
        return { row, rowid: r.lastInsertRowid };
      } catch (e) {
        const msg = String(e && e.message);
        if (/UNIQUE constraint failed/.test(msg)) {
          const regen = (T.UNIQUE_REGENERATE[table] || []).find((c) => msg.includes(`${table}.${c}`));
          if (regen && row[regen] != null) { row[regen] = `${String(row[regen]).slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`; this.stat(table, 'regenerated'); continue; }
          if (table === 'play_logs' && row.client_event_id != null) { row.client_event_id = null; continue; }
          this.stat(table, 'kept_existing');
          return null;
        }
        if (/FOREIGN KEY constraint failed|NOT NULL constraint failed|CHECK constraint failed/.test(msg)) {
          // Kept with the counts, so "dropped" in the summary always says why.
          this.stat(table, 'dropped', 0);
          this.stats[table].last_error = msg.slice(0, 200);
          return this.drop(table, 'constraint');
        }
        throw e;
      }
    }
    return this.drop(table, 'unique');
  }

  /* ---------- phases ---------- */

  async run() {
    const phase = this.progress.phase || 'ids';
    this.loadUsers();
    if (!this.instance) await this.loadEmails();
    if (phase === 'ids') { await this.allocateIds(); this.saveProgress({ phase: 'rows', table: null, rows: 0, tables_done: [] }); }
    this.rebuildAll();
    if (this.progress.phase === 'rows') { await this.restoreRows(); this.saveProgress({ phase: 'members' }); }
    if (this.progress.phase === 'members') { await this.restoreMembers(); this.saveProgress({ phase: 'finish' }); }
    if (this.progress.phase === 'finish') { this.finish(); this.saveProgress({ phase: 'done' }); }
    return this.result;
  }

  /** Who the archive's people are on this server. */
  loadUsers() {
    const m = this.map('users');
    for (const [o, n] of m) this.userMap.set(o, n);
  }

  async allocateIds() {
    const tables = ['workspaces', ...restoreOrder(this.db, { instance: this.instance, options: this.options, present: this.present })]
      .filter((t, i, a) => a.indexOf(t) === i);
    this.saveProgress({ phase: 'ids', total_tables: tables.length });
    if (this.instance) await this.createAccounts();
    else await this.mapPeopleToImporter();
    for (const t of tables) {
      if (!this.schema(t).textId) continue;
      const m = this.map(t);
      await archive.readRows(this.arch, `tables/${t}.jsonl`, async (rows) => {
        const fresh = [];
        for (const r of rows) {
          if (r.id == null || m.has(String(r.id))) continue;
          const n = uuid();
          m.set(String(r.id), n);
          fresh.push([r.id, n]);
        }
        if (fresh.length) this.db.transaction(() => this.persist(t, fresh))();
        await tick();
      }, { batch: 2000 });
    }
  }

  async mapPeopleToImporter() {
    const pairs = [];
    await archive.readRows(this.arch, 'tables/users.jsonl', async (rows) => { for (const r of rows) pairs.push([r.id, this.importer.id]); });
    for (const [o, n] of pairs) { this.userMap.set(o, n); this.map('users').set(o, n); }
    this.db.transaction(() => this.persist('users', pairs))();
  }

  /*
   * A whole-server restore recreates its people as accounts. An address that already has an account
   * here maps to it and the account is not changed in any way. A new account has no password (the
   * export never carries one): the person sets one with "Forgot password", or the administrator
   * hands them a set-password link; single sign-on accounts sign in through their provider once it
   * is reconnected. Platform roles are carried only here, in a whole-server restore.
   */
  async createAccounts() {
    const rows = [];
    await archive.readRows(this.arch, 'tables/users.jsonl', async (batch) => { rows.push(...batch); });
    const plans = new Set(this.db.prepare('SELECT id FROM plans').all().map((p) => p.id));
    const { isPlatformRole } = require('../../middleware/auth');
    this.db.transaction(() => {
      for (const r of rows) {
        if (this.userMap.has(r.id)) continue;
        const email = String(r.email || '').trim().toLowerCase();
        if (!email) continue;
        const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
          this.userMap.set(r.id, existing.id);
          this.persist('users', [[r.id, existing.id]]);
          continue;
        }
        const id = uuid();
        const role = isPlatformRole(r.role) || r.role === 'user' ? r.role : 'user';
        this.db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, email_verified, created_at, disabled_at, ui_mode)
                         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'advanced')`)
          .run(id, email, String(r.name || email.split('@')[0]), ['local', 'google', 'microsoft', 'oidc', 'saml'].includes(r.auth_provider) ? r.auth_provider : 'local',
            role, plans.has(r.plan_id) ? r.plan_id : 'free', r.email_verified ? 1 : 0, r.created_at || now(), r.disabled_at || null);
        this.userMap.set(r.id, id);
        this.persist('users', [[r.id, id]]);
        this.persist('created:users', [[id, id]]);
      }
    })();
  }

  async restoreRows() {
    const order = restoreOrder(this.db, { instance: this.instance, options: this.options, present: this.present });
    this.pos = new Map(order.map((t, i) => [t, i]));
    const doneTables = new Set(this.progress.tables_done || []);
    const total = Object.values(this.counts || {}).reduce((a, b) => a + b, 0);
    let rowsDone = this.progress.rows_done || 0;
    for (const t of order) {
      if (doneTables.has(t)) continue;
      const skip = this.progress.table === t ? (this.progress.rows || 0) : 0;
      let consumed = skip;
      await archive.readRows(this.arch, `tables/${t}.jsonl`, async (rows) => {
        if (t === 'content') await this.restoreContentFiles(rows);
        if (t === 'custom_fonts') await this.restoreFontFiles(rows);
        this.db.transaction(() => {
          for (const r of rows) this.writeRow(t, r);
          consumed += rows.length;
          rowsDone += rows.length;
          this.saveProgress({ phase: 'rows', table: t, rows: consumed, rows_done: rowsDone, rows_total: total, stats: this.stats });
        })();
        await tick();
      }, { batch: BATCH, skip });
      doneTables.add(t);
      this.saveProgress({ phase: 'rows', table: null, rows: 0, tables_done: [...doneTables] });
    }
    for (const t of order) await this.applyDeferred(t);
  }

  /**
   * Foreign keys to a row written LATER (its own table — folders in folders — or a table further
   * down the order) are written as NULL first, then filled in here once everything is in. Idempotent,
   * so a resumed job simply does it again.
   */
  deferredCols(t) {
    if (!this._deferred) this._deferred = new Map();
    if (this._deferred.has(t)) return this._deferred.get(t);
    const s = this.schema(t);
    const out = [...s.fks.entries()].filter(([c, target]) => {
      const col = s.byName.get(c);
      if (!col || col.notnull || T.USER_COLUMNS.has(c) || target === 'users') return false;
      return target === t || (this.pos && this.pos.has(target) && this.pos.get(target) > this.pos.get(t));
    });
    this._deferred.set(t, out);
    return out;
  }

  async applyDeferred(t) {
    const cols = this.deferredCols(t);
    const s = this.schema(t);
    if (!cols.length || !s.textId) return;
    const m = this.map(t);
    await archive.readRows(this.arch, `tables/${t}.jsonl`, async (rows) => {
      this.db.transaction(() => {
        for (const r of rows) {
          if (!m.has(String(r.id))) continue;
          for (const [c, target] of cols) {
            const v = r[c] == null ? undefined : this.ref(target, r[c]);
            if (v === undefined || v === null) continue;
            try { this.db.prepare(`UPDATE ${t} SET "${c}" = ? WHERE id = ?`).run(v, m.get(String(r.id))); } catch (_) { /* that row was not restored */ }
          }
        }
      })();
    });
  }

  writeRow(t, raw) {
    const r = this.insertOne(t, raw);
    if (!r) return;
    const s = this.schema(t);
    // Integer ids that something else names (playlist items) are mapped as they are written, in the
    // same transaction as the row, so a resume never loses one.
    if (s.intId && raw.id != null && Object.values(T.INT_REFS).includes(t)) {
      this.map(`int:${t}`).set(String(raw.id), String(r.rowid));
      this.persist(`int:${t}`, [[raw.id, r.rowid]]);
    }
    // Rows a workspace cascade would not delete (organization-level ones, and the activity log, which a
    // cascade only detaches), so a rollback finds them.
    const sc = exportTables.EXPORTED[t].scope;
    if (sc.org || sc.audit) this.persist(`created:${t}`, [[`${r.rowid}`, `${r.rowid}`]]);
  }

  /* ---------- files ---------- */

  /**
   * Write the media of a batch of content rows, BEFORE the rows' transaction. Each file keeps its
   * name when that name is free here (player caches and published playlists name it), is reused when
   * a file of that name already holds the same bytes, and otherwise gets a fresh name — which the
   * id rewriting then carries into every snapshot that named the old one.
   */
  async restoreContentFiles(rows) {
    const { INLINE_SAFE_EXTS } = require('../upload-sniff');
    fs.mkdirSync(config.contentDir, { recursive: true });
    for (const r of rows) {
      r.__files = {};
      for (const [kind, col] of [['asset', 'filepath'], ['thumb', 'thumbnail_path']]) {
        if (!r[col] || r.remote_url) continue;
        const base = path.basename(String(r[col]));
        const entryName = `files/${r.id}/${base}`;
        if (!this.arch.entries.has(entryName)) { if (kind === 'asset') this.stat('content', 'missing_files'); continue; }
        if (kind === 'thumb' && r.thumbnail_path === r.filepath) continue;
        const ext = path.extname(base).toLowerCase();
        if (!INLINE_SAFE_EXTS.has(ext)) { this.stat('content', 'refused_files'); continue; }
        const newId = this.map('content').get(String(r.id)) || uuid();
        const placed = await this.placeFile(entryName, config.contentDir, [base, `${newId}${kind === 'thumb' ? '-thumb' : ''}${ext}`, `${uuid()}${ext}`]);
        if (!placed) { this.stat('content', 'missing_files'); continue; }
        r.__files[kind] = placed;
        if (placed.name !== base) this.mapFileName(base, placed.name);
        this.stat('content', 'files');
        this.stat('content', 'file_bytes', placed.bytes);
      }
    }
  }

  async restoreFontFiles(rows) {
    fs.mkdirSync(config.fontsDir, { recursive: true });
    for (const r of rows) {
      r.__files = {};
      if (!r.filepath) continue;
      const base = path.basename(String(r.filepath));
      const entryName = `fonts/${r.id}/${base}`;
      const ext = path.extname(base).toLowerCase();
      if (!this.arch.entries.has(entryName) || !FONT_EXTS.has(ext)) continue;
      const newId = this.map('custom_fonts').get(String(r.id)) || uuid();
      const placed = await this.placeFile(entryName, config.fontsDir, [base, `${newId}${ext}`, `${uuid()}${ext}`]);
      if (placed) { r.__files.asset = placed; this.persist('created:font_files', [[placed.name, placed.name]]); }
    }
  }

  /** Put an entry into `dir` under the first usable name. Returns { name, sha256, bytes } or null. */
  async placeFile(entryName, dir, names) {
    const d = this.arch.digest(entryName);
    for (const name of names) {
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) {
        // Same bytes already here (a resumed job, or the same media in another organization):
        // reuse it. Deleting either row later is refcounted (lib/content-files.js).
        if (await sameDigest(dest, d.sha256)) return { name, sha256: d.sha256, bytes: d.bytes };
        continue;
      }
      const tmp = path.join(dir, `.import-${crypto.randomBytes(8).toString('hex')}.part`);
      await archive.extractTo(this.arch, entryName, tmp);
      try {
        fs.linkSync(tmp, dest);                // fails if the name was taken meanwhile: never overwrites
        fs.rmSync(tmp, { force: true });
        return { name, sha256: d.sha256, bytes: d.bytes };
      } catch (_) {
        fs.rmSync(tmp, { force: true });
      }
    }
    return null;
  }

  mapFileName(oldBase, newBase, save = true) {
    const a = oldBase.replace(/\.[^.]*$/, ''), b = newBase.replace(/\.[^.]*$/, '');
    if (a && b && a !== b) {
      this.all.set(oldBase, newBase);
      if (/^[0-9a-fA-F-]{36}$/.test(a) && /^[0-9a-fA-F-]{36}$/.test(b)) this.all.set(a, b);
      if (save) this.persist('files', [[oldBase, newBase]]);
    }
  }

  /* ---------- people ---------- */

  async restoreMembers() {
    const orgMembers = [], wsMembers = [], users = [];
    await archive.readRows(this.arch, 'tables/organization_members.jsonl', async (r) => { orgMembers.push(...r); });
    await archive.readRows(this.arch, 'tables/workspace_members.jsonl', async (r) => { wsMembers.push(...r); });
    await archive.readRows(this.arch, 'tables/users.jsonl', async (r) => { users.push(...r); });
    if (this.instance) return this.restoreMemberships(orgMembers, wsMembers);
    return this.inviteMembers(orgMembers, wsMembers, users);
  }

  restoreMemberships(orgMembers, wsMembers) {
    this.db.transaction(() => {
      for (const m of orgMembers) {
        const u = this.userMap.get(m.user_id);
        if (!u) continue;
        this.db.prepare('INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
          .run(this.orgId, u, ['org_owner', 'org_admin', 'org_member'].includes(m.role) ? m.role : 'org_member', m.joined_at || now());
      }
      for (const m of wsMembers) {
        const u = this.userMap.get(m.user_id);
        const ws = this.ref('workspaces', m.workspace_id);
        if (!u || !ws) continue;
        this.db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
          .run(ws, u, ['workspace_admin', 'workspace_editor', 'workspace_viewer'].includes(m.role) ? m.role : 'workspace_viewer', m.joined_at || now());
      }
    })();
    this.result.accounts = this.db.prepare("SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'created:users'").all(this.job.id).length;
  }

  /*
   * An organization import invites its people (it never creates accounts): each pending invite
   * carries the workspace role they had and their organization role. Someone who already has an
   * account here joins on accepting; nothing else about their account changes. The importer is the
   * owner and needs no invite.
   */
  inviteMembers(orgMembers, wsMembers, users) {
    const byUser = new Map(users.map((u) => [u.id, u]));
    const orgRole = new Map(orgMembers.map((m) => [m.user_id, m.role]));
    const wsOf = new Map();
    for (const m of wsMembers) { if (!wsOf.has(m.user_id)) wsOf.set(m.user_id, []); wsOf.get(m.user_id).push(m); }
    const firstWs = this.db.prepare('SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = ? ORDER BY rowid LIMIT 1').get(this.job.id, 'workspaces');
    const ids = new Set([...orgRole.keys(), ...wsOf.keys()]);
    const exp = now() + INVITE_DAYS * 86400;
    const me = String(this.importer.email || '').toLowerCase();
    const ins = this.db.prepare(`INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at, org_role, org_only, import_job_id)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0, skipped = 0;
    this.db.transaction(() => {
      for (const uid of ids) {
        const u = byUser.get(uid);
        const email = u && String(u.email || '').trim().toLowerCase();
        if (!email || email === me || (u && u.disabled_at)) { skipped += 1; continue; }
        let role = ['org_owner', 'org_admin', 'org_member'].includes(orgRole.get(uid)) ? orgRole.get(uid) : null;
        // Never more than the importer may give: an org admin importing into an organization they do
        // not own cannot hand out ownership of it through an archive.
        if (role === 'org_owner' && !this.canGrantOwner) role = 'org_admin';
        const memberships = (wsOf.get(uid) || []).map((m) => ({ ws: this.ref('workspaces', m.workspace_id), role: m.role })).filter((m) => m.ws);
        const already = (ws) => this.db.prepare('SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND lower(email) = ?').get(ws, email);
        if (!memberships.length) {
          if (!role || !firstWs || already(firstWs.new_id)) { skipped += 1; continue; }
          ins.run(uuid(), firstWs.new_id, email, 'workspace_viewer', this.importer.id, exp, role, 1, this.job.id);
          n += 1;
          continue;
        }
        memberships.forEach((m, i) => {
          if (already(m.ws)) return;
          const wsRole = ['workspace_admin', 'workspace_editor', 'workspace_viewer'].includes(m.role) ? m.role : 'workspace_viewer';
          ins.run(uuid(), m.ws, email, wsRole, this.importer.id, exp, i === 0 ? role : null, 0, this.job.id);
          n += 1;
        });
      }
      // Invites that were pending on the old server, restored as rows, are this import's too.
      this.db.prepare(`UPDATE workspace_invites SET import_job_id = ?, invited_by = ? WHERE import_job_id IS NULL
                         AND workspace_id IN (SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'workspaces')`).run(this.job.id, this.importer.id, this.job.id);
    })();
    this.result.invites = n;
    this.result.people_skipped = skipped;
  }

  /* ---------- finish ---------- */

  finish() {
    const db = this.db;
    // Organization settings travel only into the organization the import created; an existing one
    // keeps its own.
    if (this.createdOrg) {
      const src = this.orgRow || {};
      const hq = src.hq_workspace_id ? this.ref('workspaces', src.hq_workspace_id) : null;
      const carry = ['default_brand_name', 'default_logo_url', 'default_primary_color', 'room_end_any', 'room_release_min',
        'corporate_enabled', 'corporate_authors', 'emergency_triggers_enabled', 'store_triggers_under_mandate', 'store_trigger_cap_sec', 'storage_workspace_choice'];
      // Platform-controlled switches (talk, the widget sandbox, ICE servers) are the destination
      // platform's to give; a whole-server restore carries them, an organization import does not.
      if (this.instance) carry.push('talk_enabled', 'ice_servers', 'widget_sandbox_isolation_disabled');
      const cols = this.schema('organizations').byName;
      const sets = [], args = [];
      for (const c of carry) if (cols.has(c) && src[c] !== undefined) { sets.push(`"${c}" = ?`); args.push(this.loose(src[c])); }
      if (hq) { sets.push('hq_workspace_id = ?'); args.push(hq); }
      if (sets.length) db.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...args, this.orgId);
    }
    this.settle();
    this.result.workspaces = db.prepare(`SELECT id, name FROM workspaces WHERE organization_id = ? AND id IN (SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'workspaces') ORDER BY name`).all(this.orgId, this.job.id);
    this.result.stats = this.stats;
    this.result.screens =db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE workspace_id IN (SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'workspaces')`).get(this.job.id).n;
  }
}

/* ───────────── per-table rules ───────────── */

const sixDigit = () => require('../numeric-code').sixDigitCode();
const randomHash = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');

/*
 * What a table needs beyond the generic rewriting: credentials that never travel are replaced by
 * fresh unknowable ones (so the feature is off until someone sets it again), live state is reset,
 * and the same validation the normal routes apply is applied again.
 */
const HOOKS = {
  workspaces(r, row) {
    row.origin_node_id = null; row.replica_rev = null; row.replica_as_of = null; row.storage_profile_id = null;
    return row;
  },
  content(r, row, raw) {
    const refusal = require('../../routes/status').importedContentRefusal(raw);
    if (refusal) { r.stat('content', 'refused'); return null; }
    const f = raw.__files || {};
    row.filepath = f.asset ? f.asset.name : (raw.remote_url ? (row.filepath || '') : '');
    row.thumbnail_path = f.thumb ? f.thumb.name : (raw.thumbnail_path && raw.thumbnail_path === raw.filepath && f.asset ? f.asset.name : null);
    row.byte_digest = f.asset ? f.asset.sha256 : null;
    row.storage_profile_id = null; row.object_key = null;
    return row;
  },
  custom_fonts(r, row, raw) {
    const f = raw.__files || {};
    if (!f.asset) return null;
    row.filepath = f.asset.name;
    return row;
  },
  devices(r, row) {
    // A screen arrives offline and unclaimed by any player: it is claimed again by its own player
    // (the enrolment link, or the fingerprint a re-pairing Android player presents — docs/move-server.md).
    Object.assign(row, {
      status: 'offline', pairing_code: null, device_token: null, claim_secret: null, last_heartbeat: null,
      enrol_key: require('../enrol-key').generateEnrolKey(), settings_pin: sixDigit(),
      trigger_secret: null, trigger_clear_all_token: null, triggers_accept_http: 0, triggers_accept_udp: 0,
      local_api_secret: null, local_api_enabled: 0, view_enabled: 0, view_token_hash: null, view_token_enc: null,
      attached_node_id: null, offline_reason: null, offline_reason_at: null, offline_detail: null, heartbeat_expected_by: null,
      ota_status: 'none', ota_attempts: 0,
    });
    return row;
  },
  device_fingerprints(r, row) {
    // A fingerprint already known here belongs to a screen on THIS server; it is never taken over.
    if (r.db.prepare('SELECT 1 FROM device_fingerprints WHERE fingerprint = ?').get(row.fingerprint)) { r.stat('device_fingerprints', 'kept_existing'); return null; }
    return row;
  },
  device_settings(r, row) {
    if (r.db.prepare('SELECT 1 FROM device_settings WHERE fingerprint = ?').get(row.fingerprint)) { r.stat('device_settings', 'kept_existing'); return null; }
    return row;
  },
  triggers(r, row) {
    // The match token is the trigger's credential and never left the old server: a fresh one means
    // the trigger URL must be copied again (the checklist says so).
    row.match_token = crypto.randomBytes(16).toString('hex');
    row.clear_token = null;
    return row;
  },
  automation_hooks(r, row) {
    row.secret_hash = randomHash();   // nobody holds the matching secret: rotate to get a new URL
    row.hmac_secret_enc = null;
    row.enabled = 0;
    return row;
  },
  content_requests(r, row) { row.status_token_hash = randomHash(); row.ip_hash = null; return row; },
  submissions(r, row) {
    const rev = row.revision_id ? r.db.prepare('SELECT state_hash FROM revisions WHERE id = ?').get(row.revision_id) : null;
    if (!rev) return null;
    row.state_hash = rev.state_hash;
    return row;
  },
  emergency_activations(r, row) { if (!row.ended_at) { row.ended_at = now(); row.ended_by = null; } return row; },
  screen_verification_incidents(r, row) { if (!row.resolved_at) { row.resolved_at = now(); row.resolved_reason = 'imported'; } return row; },
  org_sso_providers(r, row) { row.enabled = 0; row.client_secret_enc = null; return row; },
  org_scim_settings(r, row) { row.enabled = 0; return row; },
  cloud_folders(r, row) { row.enabled = 0; row.sync_lease_until = null; row.last_error = 'Imported from another server: reconnect Microsoft 365, then switch the folder on.'; return row; },
  data_sources(r, row, raw) {
    if (dataSourceNeedsSecret(raw).needs) { row.last_status = 'error'; row.last_error = 'Imported from another server: enter the credentials again.'; }
    return row;
  },
  rooms(r, row, raw) { if (raw.source === 'ics') row.last_error = 'Imported from another server: enter the calendar address again.'; return row; },
  white_labels(r, row) {
    // A custom domain and login-page CSS stay platform-admin decisions (routes/white-label.js).
    if (!r.instance) { row.custom_domain = null; row.custom_css = null; }
    return row;
  },
  widgets(r, row) {
    let cfg = {};
    try { cfg = JSON.parse(row.config || '{}') || {}; } catch (_) { cfg = {}; }
    if (row.widget_type === 'template') {
      try { row.config = JSON.stringify(require('../templates/widget').buildConfig(cfg.template, cfg.values, row.workspace_id)); } catch (_) {
        row.config = JSON.stringify({ template: typeof cfg.template === 'string' ? cfg.template.slice(0, 100) : '', values: {}, ds_refs: [] });
      }
    }
    if (row.widget_type === 'bi-dashboard') {
      const bi = require('../bi/widget');
      try { row.config = JSON.stringify(bi.normaliseConfig(r.db, r.orgId, cfg)); } catch (_) {
        row.config = JSON.stringify(bi.PROVIDERS.includes(cfg && cfg.provider) ? { provider: cfg.provider, mode: 'connection' } : {});
      }
    }
    return row;
  },
  playlists(r, row) {
    if (row.smart_rules) {
      const rules = require('../smart-playlist').normalizeRules(row.smart_rules);
      row.smart_rules = rules ? JSON.stringify(rules) : null;
    }
    return row;
  },
  device_groups(r, row) {
    if (row.rules) {
      const rules = require('../device-group-rules').parseRules(row.rules);
      row.rules = rules ? JSON.stringify(rules) : null;
    }
    return row;
  },
  workspace_invites(r, row) {
    // A pending invite from the old server grants its workspace role only — never an organization
    // role, whatever a hand-edited archive says.
    if (!(row.expires_at && row.expires_at > now())) return null;
    row.org_role = null; row.org_only = 0; row.import_job_id = r.job.id;
    if (!['workspace_admin', 'workspace_editor', 'workspace_viewer'].includes(row.role)) row.role = 'workspace_viewer';
    return row;
  },
  activity_log(r, row, raw) {
    // Read-only history. In an organization import its people are not accounts here, so who did it
    // is kept as text inside the entry rather than pointing at the importer.
    if (!r.instance) {
      const who = r.emailOf(raw.user_id) || r.emailOf(raw.acting_user_id);
      row.user_id = null; row.acting_user_id = null;
      let d = raw.details;
      try {
        const o = d ? JSON.parse(d) : {};
        row.details = JSON.stringify(o && typeof o === 'object' && !Array.isArray(o) ? { ...r.deep(o), imported: { by: who || null } } : { value: r.deep(o), imported: { by: who || null } });
      } catch (_) { row.details = JSON.stringify({ text: r.loose(String(d || '')), imported: { by: who || null } }); }
    }
    return row;
  },
};

Restorer.prototype.emailOf = function emailOf(uid) {
  if (!uid) return null;
  if (!this._emails) this._emails = new Map();
  return this._emails.get(uid) || null;
};

/** Read the archive's people's addresses (for the audit history's "who"). */
Restorer.prototype.loadEmails = async function loadEmails() {
  this._emails = new Map();
  await archive.readRows(this.arch, 'tables/users.jsonl', async (rows) => { for (const u of rows) this._emails.set(u.id, String(u.email || '')); });
};

/** After the content rows commit, move restored media to the workspace's bucket if it writes to one. */
Restorer.prototype.settle = function settle() {
  try {
    const loc = require('../storage/locations');
    const rows = this.db.prepare(`SELECT id FROM content WHERE workspace_id IN (SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'workspaces') AND filepath != ''`).all(this.job.id);
    for (const r of rows) loc.settleSoon(r.id);
  } catch (_) { /* local storage only */ }
};

/* ───────────── rollback ───────────── */

/**
 * Undo what a job wrote. A new organization goes entirely (its media files with it, refcounted); in an
 * existing organization, the workspaces the job created and the organization-level rows it wrote.
 * Accounts a whole-server restore created go too, unless they have joined anything else since.
 */
function rollback(db, job) {
  const del = require('../user-deletion');
  const created = (tbl) => db.prepare('SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = ?').all(job.id, tbl).map((r) => r.new_id);
  const wsIds = created('workspaces').filter((id) => db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND organization_id = ?').get(id, job.organization_id));
  // Org-level and org-only audit rows the job wrote (recorded by rowid as they were written).
  for (const r of db.prepare("SELECT tbl FROM org_import_ids WHERE job_id = ? AND tbl LIKE 'created:%' GROUP BY tbl").all(job.id)) {
    const t = r.tbl.slice('created:'.length);
    if (!exportTables.EXPORTED[t]) continue;
    const ids = created(r.tbl);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      try { db.prepare(`DELETE FROM ${t} WHERE rowid IN (${part.map(() => '?').join(',')})`).run(...part.map(Number)); } catch (_) { /* gone with a cascade */ }
    }
  }
  if (job.created_org && job.organization_id) {
    del.deleteOrgCascade(db, { orgId: job.organization_id });
  } else {
    for (const id of wsIds) del.deleteWorkspaceCascade(db, { workspaceId: id });
  }
  for (const name of created('created:font_files')) {
    const p = path.join(config.fontsDir, path.basename(name));
    if (!db.prepare('SELECT 1 FROM custom_fonts WHERE filepath = ?').get(path.basename(name))) { try { fs.rmSync(p, { force: true }); } catch (_) { /* */ } }
  }
  for (const uid of created('created:users')) {
    const busy = db.prepare('SELECT 1 FROM organization_members WHERE user_id = ? UNION SELECT 1 FROM workspace_members WHERE user_id = ?').get(uid, uid);
    if (!busy) { try { db.prepare('DELETE FROM users WHERE id = ?').run(uid); } catch (_) { /* referenced: keep */ } }
  }
  db.prepare('DELETE FROM org_import_ids WHERE job_id = ?').run(job.id);
}

async function sameDigest(file, sha) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', () => resolve(false)).on('end', () => resolve(h.digest('hex') === sha));
  });
}

module.exports = { scan, roomFor, Restorer, rollback, restoreOrder, schemaOf, dataSourceNeedsSecret, tableName };
