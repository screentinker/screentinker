'use strict';

/*
 * One-click complete export: an organization's everything (org owners and admins), or a person's own
 * account data (anyone, for themselves — the GDPR right of access). docs/trust.md is the user-facing
 * description; lib/trust/export-tables.js decides, table by table, what "everything" means.
 *
 * SHAPE OF THE JOB
 *   request()  checks the limits, writes a data_exports row (queued) and wakes the worker.
 *   worker     one export at a time, in this process. It STREAMS a zip to DATA_DIR/exports/<id>.zip:
 *              rows are read in keyset pages of PAGE rows and written as JSON Lines, so neither a
 *              million play logs nor a large media library is ever held in memory.
 *   link()     mints a short-lived download key (only its hash is stored) for a ready export.
 *   download   GET /api/trust/download/:id?key= — the key is the credential (a browser download
 *              cannot send an Authorization header), it lives LINK_TTL_MIN minutes, and the person
 *              who asked must still have the access they had when they asked.
 *   sweep()    deletes expired archives and marks their rows expired; also fails jobs a restart
 *              interrupted.
 *
 * ⚠️ NEVER AN OPEN ITERATOR. better-sqlite3 refuses every other query on the connection while a
 * statement is iterating, and the archive is written asynchronously — an .iterate() held across an
 * await would break every request the server serves meanwhile. Pages are read with .all().
 *
 * ⚠️ SECRETS NEVER LEAVE. Every row goes through redactRow: credential-named columns are dropped
 * (lib/secret-names.js), the replication blocklist applies, and JSON config is scrubbed of encrypted
 * values and secret-named keys. The manifest lists every column removed, so "secrets excluded" can
 * be checked rather than trusted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const tables = require('./export-tables');
const { isSecretName } = require('../secret-names');

const PAGE = 1000;
const TTL_HOURS = require('./report').EXPORT_TTL_HOURS;
const LINK_TTL_MIN = 15;
const MAX_PER_DAY = 3;          // per organization (org exports) or per person (personal exports)
const STALE_RUNNING_SEC = 6 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const exportsDir = () => path.join(config.dataDir, 'exports');
/** Bytes a non-root process may still write on the filesystem holding `dir` (null if unknown). */
function freeBytes(dir) {
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch (_) { return null; }
}
/** Bytes of the whole filesystem holding `dir` (null if unknown). */
function diskBytes(dir) {
  try { const st = fs.statfsSync(dir); return st.blocks * st.bsize; } catch (_) { return null; }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ───────────── redaction ───────────── */

let _replication = null;
function replication() {
  if (!_replication) _replication = require('../mesh/replication');
  return _replication;
}

/** Columns of `table` an export may carry: never a credential-shaped name, never a blocklisted one. */
function exportableColumns(db, table) {
  const r = replication();
  const block = new Set(r.BLOCKLIST[table] || []);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const keep = [], removed = [];
  for (const c of cols) {
    const allowed = Object.prototype.hasOwnProperty.call(r.NOT_A_SECRET, `${table}.${c}`);
    if (block.has(c) || (isSecretName(c) && !allowed)) removed.push(c);
    else keep.push(c);
  }
  return { keep, removed };
}

/** Scrub every JSON-object string column of encrypted values and secret-named keys. */
function redactRow(row) {
  const { scrubJson } = replication();
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'string' && v[0] === '{') row[k] = scrubJson(v);
    else if (typeof v === 'string' && /^enc:v1:/.test(v)) row[k] = null;
    else if (Buffer.isBuffer(v)) row[k] = v.toString('base64');
  }
  return row;
}

/* ───────────── scoping ───────────── */

/**
 * WHERE clause (+ args) selecting the rows of `table` that belong to organization `orgId`.
 * Built from the classification only; no input reaches the SQL text.
 */
function whereFor(db, table, orgId, depth = 0) {
  const spec = tables.EXPORTED[table];
  if (!spec || depth > 4) return null;
  const s = spec.scope;
  const wsSub = 'SELECT id FROM workspaces WHERE organization_id = ?';
  if (s.self) return { sql: 'id = ?', args: [orgId] };
  if (s.ws) return { sql: `${s.ws} IN (${wsSub})`, args: [orgId] };
  if (s.org) return { sql: `${s.org} = ?`, args: [orgId] };
  if (s.audit) return { sql: `(workspace_id IN (${wsSub}) OR organization_id = ?)`, args: [orgId, orgId] };
  if (s.members) {
    return {
      sql: `id IN (SELECT user_id FROM organization_members WHERE organization_id = ?
                   UNION SELECT wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ?)`,
      args: [orgId, orgId],
    };
  }
  if (s.via) {
    const parent = whereFor(db, s.parent, orgId, depth + 1);
    if (!parent) return null;
    return { sql: `${s.via} IN (SELECT ${s.pk || 'id'} FROM ${s.parent} WHERE ${parent.sql})`, args: parent.args };
  }
  return null;
}

/* ───────────── zip writing ───────────── */

function tableExists(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
}

const tick = () => new Promise((r) => setImmediate(r));

/*
 * 3.0 (docs/move-server.md): every entry's SHA-256 and size go into the manifest, so an archive can be
 * checked entry by entry on ANOTHER server — including one restoring it after this server is gone,
 * where the manifest is the only thing left to check against. The digest is of the bytes exactly as
 * they are in the archive, computed as they are written (tables, strings) or read once beforehand
 * (media, which is written once and never changed in place).
 */
function recordIntegrity(archive, name, sha256, bytes) {
  if (!archive._stIntegrity) archive._stIntegrity = {};
  archive._stIntegrity[name] = { sha256, bytes };
}
function appendString(archive, text, name) {
  const buf = Buffer.from(String(text), 'utf8');
  recordIntegrity(archive, name, crypto.createHash('sha256').update(buf).digest('hex'), buf.length);
  archive.append(buf, { name });
}
function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    fs.createReadStream(abs).on('data', (c) => { h.update(c); n += c.length; }).on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes: n }));
  });
}
/** Add a file from disk with its digest; null when it could not be read. */
async function appendHashedFile(archive, abs, name) {
  let d;
  try { d = await hashFile(abs); } catch (_) { return null; }
  recordIntegrity(archive, name, d.sha256, d.bytes);
  archive.file(abs, { name });
  return d;
}

/**
 * Append `table`'s rows matching `where` to the archive as JSON Lines. Keyset pagination on rowid
 * (falls back to OFFSET for a table without one). Returns { rows, removed }.
 */
async function appendTable(archive, db, table, where, name, { columns = null } = {}) {
  const { keep, removed } = exportableColumns(db, table);
  const cols = (columns ? keep.filter((c) => columns.includes(c)) : keep);
  if (!cols.length) return { rows: 0, removed };
  const colSql = cols.map((c) => `"${c}"`).join(', ');
  const { PassThrough } = require('stream');
  const out = new PassThrough();
  archive._stCurrent = out;
  archive.append(out, { name });
  let rows = 0, last = -Infinity, offset = 0;
  let byRowid = true;
  const h = crypto.createHash('sha256');
  let bytes = 0;
  try { db.prepare(`SELECT rowid FROM ${table} LIMIT 0`).all(); } catch (_) { byRowid = false; }
  for (;;) {
    const page = byRowid
      ? db.prepare(`SELECT rowid AS __rid, ${colSql} FROM ${table} WHERE (${where.sql}) AND rowid > ? ORDER BY rowid LIMIT ${PAGE}`).all(...where.args, last)
      : db.prepare(`SELECT ${colSql} FROM ${table} WHERE ${where.sql} LIMIT ${PAGE} OFFSET ${offset}`).all(...where.args);
    if (!page.length) break;
    let chunk = '';
    for (const r of page) {
      if (byRowid) { last = r.__rid; delete r.__rid; }
      chunk += JSON.stringify(redactRow(r)) + '\n';
    }
    rows += page.length; offset += page.length;
    const buf = Buffer.from(chunk, 'utf8');
    h.update(buf); bytes += buf.length;
    if (!out.write(buf)) {
      // 'close' too: an archive error destroys this stream (runJob), and a drain would never come.
      await new Promise((r) => { out.once('drain', r); out.once('close', r); });
      if (archive._stErr) throw archive._stErr;
    }
    if (page.length < PAGE) break;
    await tick();
  }
  out.end();
  recordIntegrity(archive, name, h.digest('hex'), bytes);
  return { rows, removed };
}

/** Content files (and thumbnails) and uploaded fonts, wherever the bytes are kept. */
async function appendFiles(archive, db, wsIds, prefix = 'files') {
  const storageLoc = require('../storage/locations');
  const stats = { files: 0, bytes: 0, missing: 0 };
  if (!wsIds.length) return stats;
  const ph = wsIds.map(() => '?').join(',');
  let last = '';
  for (;;) {
    const rows = db.prepare(`SELECT * FROM content WHERE workspace_id IN (${ph}) AND remote_url IS NULL AND id > ? ORDER BY id LIMIT 200`).all(...wsIds, last);
    if (!rows.length) break;
    for (const row of rows) {
      last = row.id;
      for (const [kind, col] of [['asset', 'filepath'], ['thumb', 'thumbnail_path']]) {
        if (!row[col] || (kind === 'thumb' && row.thumbnail_path === row.filepath)) continue;
        let abs = null;
        try {
          if (storageLoc.hasExplicitLocations(row.id)) abs = await storageLoc.ensureLocalFile(row, kind);
          else abs = path.join(config.contentDir, path.basename(row[col]));
        } catch (_) { abs = null; }
        const d = abs && fs.existsSync(abs) ? await appendHashedFile(archive, abs, `${prefix}/${row.id}/${path.basename(row[col])}`) : null;
        if (d) { stats.files += 1; stats.bytes += d.bytes; } else if (kind === 'asset') stats.missing += 1;
      }
    }
    await tick();
  }
  if (tableExists(db, 'custom_fonts')) {
    for (const f of db.prepare(`SELECT id, filepath FROM custom_fonts WHERE workspace_id IN (${ph})`).all(...wsIds)) {
      const abs = f.filepath ? path.join(config.fontsDir, path.basename(f.filepath)) : null;
      const d = abs && fs.existsSync(abs) ? await appendHashedFile(archive, abs, `fonts/${f.id}/${path.basename(f.filepath)}`) : null;
      if (d) { stats.files += 1; stats.bytes += d.bytes; }
    }
  }
  return stats;
}

const README_ORG = `ScreenTinker organization export
================================

manifest.json           what is in this archive: every category, every table, row counts,
                        the columns removed because they hold credentials, and the tables
                        deliberately not included (with the reason for each).
tables/<table>.jsonl    every row of every table that belongs to the organization, one JSON
                        object per line. Secrets (passwords, tokens, keys, encrypted values)
                        are removed.
files/<content id>/     the uploaded media (and thumbnails) of every workspace.
fonts/<font id>/        uploaded fonts.
workspaces/<id>/export.json
                        each workspace in the format Settings -> Import data reads. To restore
                        one workspace, zip that export.json together with the files/ folder.
`;

const README_USER = `ScreenTinker personal data export
=================================

manifest.json           what is in this archive.
account.json            your account, memberships, sign-in methods (no secrets) and settings.
activity.jsonl          the audit log entries that record your actions.
resources/export.json   what you created, in the format Settings -> Import data reads.
`;

/* ───────────── org export ───────────── */

async function writeOrgExport(archive, db, job) {
  const orgId = job.organization_id;
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId);
  if (!org) throw new Error('organization not found');
  const wsRows = db.prepare('SELECT id, name FROM workspaces WHERE organization_id = ?').all(orgId);
  const wsIds = wsRows.map((w) => w.id);
  try { require('../outbound-ledger').flush(); } catch (_) { /* the ledger's last minute is optional */ }

  const categories = Object.fromEntries(tables.CATEGORIES.map((c) => [c, { tables: {}, rows: 0 }]));
  const columnsRemoved = {};
  for (const [table, spec] of Object.entries(tables.EXPORTED)) {
    if (!tableExists(db, table)) continue;
    const where = whereFor(db, table, orgId);
    if (!where) continue;
    const name = `tables/${table}.jsonl`;
    const r = await appendTable(archive, db, table, where, name, { columns: spec.scope.members ? tables.MEMBER_COLUMNS : null });
    categories[spec.category].tables[table] = { rows: r.rows, file: name };
    categories[spec.category].rows += r.rows;
    if (r.removed.length) columnsRemoved[table] = r.removed;
    await tick();
  }

  const files = await appendFiles(archive, db, wsIds);
  categories.content.files = files;

  // One re-importable workspace export each, in the format the existing import reads.
  const collect = require('../../routes/status').collectExportData;
  const workspaces = [];
  for (const w of wsRows) {
    const data = collect({ userId: job.user_id, workspaceId: w.id, byWorkspace: true });
    if (!data) continue;
    for (const c of data.content) {
      const row = db.prepare('SELECT filepath, thumbnail_path, remote_url FROM content WHERE id = ?').get(c.id);
      if (row && !row.remote_url && row.filepath) c.original_filepath = path.basename(row.filepath);
      if (row && !row.remote_url && row.thumbnail_path && row.thumbnail_path !== row.filepath) c.original_thumbnail = path.basename(row.thumbnail_path);
    }
    const name = `workspaces/${w.id}/export.json`;
    appendString(archive, JSON.stringify(data, null, 2), name);
    workspaces.push({ id: w.id, name: w.name, export: name });
    await tick();
  }

  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
  const manifest = {
    format: 'screentinker-org-export-v1',
    kind: 'org',
    exported_at: new Date().toISOString(),
    organization: { id: org.id, name: org.name },
    workspaces,
    categories,
    files,
    excluded_tables: Object.fromEntries(Object.entries(tables.EXCLUDED).filter(([t]) => present.has(t))),
    redaction: {
      rule: 'Columns whose name marks a credential, the replication blocklist, encrypted values and secret-named keys inside JSON settings are removed.',
      columns_removed: columnsRemoved,
    },
  };
  appendString(archive, README_ORG, 'README.txt');
  // Last, so it can list the digest of every entry before it. It cannot list its own.
  manifest.integrity = { algorithm: 'sha256', entries: { ...(archive._stIntegrity || {}) } };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  return manifest;
}

/* ───────────── personal export ───────────── */

const USER_COLUMNS = ['id', 'email', 'name', 'auth_provider', 'avatar_url', 'role', 'plan_id', 'totp_enabled', 'email_alerts',
  'email_verified', 'ui_mode', 'created_at', 'updated_at', 'last_login', 'onboarded_at', 'disabled_at'];

function selectOwn(db, table, sql, args, columns = null) {
  if (!tableExists(db, table)) return [];
  const { keep } = exportableColumns(db, table);
  const cols = columns ? keep.filter((c) => columns.includes(c)) : keep;
  if (!cols.length) return [];
  return db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE ${sql}`).all(...args).map(redactRow);
}

async function writeUserExport(archive, db, job) {
  const uid = job.user_id;
  const user = selectOwn(db, 'users', 'id = ?', [uid], USER_COLUMNS)[0];
  if (!user) throw new Error('user not found');
  const account = {
    user,
    organizations: tableExists(db, 'organization_members')
      ? db.prepare('SELECT o.id, o.name, om.role, om.joined_at FROM organization_members om JOIN organizations o ON o.id = om.organization_id WHERE om.user_id = ?').all(uid).map(redactRow)
      : [],
    workspaces: db.prepare('SELECT w.id, w.name, w.organization_id, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ?').all(uid),
    passkeys: selectOwn(db, 'webauthn_credentials', 'user_id = ?', [uid], ['name', 'device_type', 'backed_up', 'transports', 'created_at', 'last_used_at']),
    api_tokens: selectOwn(db, 'api_tokens', 'user_id = ?', [uid], ['id', 'prefix', 'name', 'workspace_id', 'scope', 'created_at', 'last_used_at', 'revoked_at']),
    canva_connections: selectOwn(db, 'canva_connections', 'user_id = ?', [uid], ['integration_key', 'display_name', 'scopes', 'created_at', 'updated_at']),
    teams: selectOwn(db, 'team_members', 'user_id = ?', [uid]),
    email_preferences: selectOwn(db, 'freshness_digest_prefs', 'user_id = ?', [uid]),
    billing_receipts: selectOwn(db, 'billing_receipts', 'user_id = ?', [uid]),
    templates_seen: selectOwn(db, 'template_seen', 'user_id = ?', [uid]),
    product_events: selectOwn(db, 'conversion_events', 'user_id = ?', [uid]),
    mfa: { totp_enabled: !!user.totp_enabled, passkeys: 0 },
  };
  account.mfa.passkeys = account.passkeys.length;
  archive.append(JSON.stringify(account, null, 2), { name: 'account.json' });

  const where = { sql: '(user_id = ? OR acting_user_id = ?)', args: [uid, uid] };
  const activity = tableExists(db, 'activity_log') ? await appendTable(archive, db, 'activity_log', where, 'activity.jsonl') : { rows: 0 };

  const collect = require('../../routes/status').collectExportData;
  const resources = collect({ userId: uid, workspaceId: null });
  if (resources) archive.append(JSON.stringify(resources, null, 2), { name: 'resources/export.json' });

  const manifest = {
    format: 'screentinker-personal-export-v1',
    kind: 'user',
    exported_at: new Date().toISOString(),
    subject: { id: uid, email: user.email },
    contents: {
      'account.json': ['user', 'organizations', 'workspaces', 'passkeys', 'api_tokens', 'canva_connections', 'teams', 'email_preferences', 'billing_receipts', 'templates_seen', 'product_events'],
      'activity.jsonl': { rows: activity.rows },
      'resources/export.json': resources ? Object.keys(resources).filter((k) => Array.isArray(resources[k])).reduce((o, k) => ({ ...o, [k]: resources[k].length }), {}) : {},
    },
    not_included: {
      'organization data': 'content, screens and settings belong to the organization; its owner or admins export them',
      'secrets': 'password hash, two-factor secret, recovery codes, token hashes and OAuth tokens are never exported',
    },
  };
  archive.append(README_USER, { name: 'README.txt' });
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  return manifest;
}

/* ───────────── jobs ───────────── */

class ExportError extends Error {
  constructor(message, status = 400, code = 'export') { super(message); this.status = status; this.code = code; }
}

function dbOf() { return require('../../db/database').db; }

/**
 * Queue an export. kind 'org' needs orgId. Throws ExportError(429) over the limits: one export in
 * progress per subject, and MAX_PER_DAY per subject per 24 hours.
 */
function request({ db = dbOf(), kind, orgId = null, userId }) {
  if (kind !== 'org' && kind !== 'user') throw new ExportError('Unknown export kind');
  if (kind === 'org' && !orgId) throw new ExportError('No organization');
  const subject = kind === 'org' ? ['organization_id = ? AND kind = \'org\'', orgId] : ['user_id = ? AND kind = \'user\'', userId];
  const busy = db.prepare(`SELECT id FROM data_exports WHERE ${subject[0]} AND status IN ('queued','running')`).get(subject[1]);
  if (busy) throw new ExportError('An export is already being prepared.', 429, 'busy');
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM data_exports WHERE ${subject[0]} AND created_at > ?`).get(subject[1], now() - 86400).n;
  if (recent >= MAX_PER_DAY) throw new ExportError(`At most ${MAX_PER_DAY} exports a day.`, 429, 'daily_limit');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO data_exports (id, kind, organization_id, user_id, status) VALUES (?, ?, ?, ?, \'queued\')').run(id, kind, orgId, userId);
  kick();
  return id;
}

let running = false;
let _hooks = { onDone: null };
function kick() { setImmediate(() => { runQueue().catch(() => {}); }); }

async function runQueue(db = dbOf()) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare("SELECT * FROM data_exports WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get();
      if (!job) break;
      await runJob(db, job);
    }
  } finally { running = false; }
}

/*
 * Stream an archive built by `write(archive)` to `file`, hashing the bytes on their way to disk.
 * Resolves { manifest, sha256, bytes }; on failure the partial file is removed and it throws. Shared
 * by the organization and personal exports and the whole-server bundle (lib/trust/instance-export.js).
 */
async function buildZip(file, write, { store = false } = {}) {
  const { ZipArchive } = require('archiver');
  const { Transform } = require('stream');
  const archive = new ZipArchive(store ? { store: true } : { zlib: { level: 5 } });
  const out = fs.createWriteStream(file, { mode: 0o600 });
  // The whole archive's SHA-256: the download sends it, so a server pulling the archive can check
  // that every byte arrived as it left (docs/move-server.md).
  const whole = crypto.createHash('sha256');
  const tap = new Transform({ transform(chunk, enc, cb) { whole.update(chunk); cb(null, chunk); } });
  const done = new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', (e) => {
      archive._stErr = e;
      if (archive._stCurrent) archive._stCurrent.destroy();
      reject(e);
    });
  });
  done.catch(() => { /* surfaced by the await below, or by the writer that stopped */ });
  /*
   * ⚠️ A WRITE ERROR (A FULL DISK) MUST STOP THE WRITER. `done` is only awaited after `write`, so
   * without this the writer kept queueing entries into an archive whose output was gone, waited on
   * back-pressure that never drained, and the job hung as 'running' with its files left on disk
   * (prod, 2026-10-20: a whole-server export filled the disk and held it). Writers that wait on the
   * archive themselves race `archive._stFailed`.
   */
  const failed = new Promise((_, reject) => { done.catch(reject); });
  failed.catch(() => { /* raced below */ });
  archive._stFailed = failed;
  archive.pipe(tap).pipe(out);
  try {
    const manifest = await Promise.race([write(archive), failed]);
    await Promise.race([archive.finalize(), failed]);
    await done;
    return { manifest, sha256: whole.digest('hex'), bytes: fs.statSync(file).size };
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* */ }
    throw e;
  }
}

async function runJob(db, job) {
  db.prepare("UPDATE data_exports SET status = 'running', started_at = ? WHERE id = ?").run(now(), job.id);
  fs.mkdirSync(exportsDir(), { recursive: true });
  const file = path.join(exportsDir(), `${job.id}.zip`);
  try {
    const { manifest, sha256, bytes } = await buildZip(file, (archive) => (job.kind === 'org' ? writeOrgExport(archive, db, job) : writeUserExport(archive, db, job)));
    const summary = job.kind === 'org'
      ? { categories: Object.fromEntries(Object.entries(manifest.categories).map(([k, v]) => [k, v.rows])), files: manifest.files }
      : { contents: manifest.contents };
    db.prepare("UPDATE data_exports SET status = 'ready', file_name = ?, bytes = ?, sha256 = ?, manifest = ?, finished_at = ?, expires_at = ? WHERE id = ?")
      .run(path.basename(file), bytes, sha256, JSON.stringify(summary), now(), now() + TTL_HOURS * 3600, job.id);
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* */ }
    db.prepare("UPDATE data_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String((e && e.message) || e).slice(0, 300), now(), job.id);
    console.warn(`[trust] export ${job.id} failed: ${e && e.message}`);
  }
  if (_hooks.onDone) { try { _hooks.onDone(job.id); } catch (_) { /* */ } }
}

/** A fresh download key for a ready export (only its hash is stored). Returns { key, expires_at }. */
function link(db, job) {
  if (!job || job.status !== 'ready' || !job.expires_at || job.expires_at <= now()) throw new ExportError('This export is not available.', 404, 'not_ready');
  const key = crypto.randomBytes(32).toString('base64url');
  const linkExp = Math.min(now() + LINK_TTL_MIN * 60, job.expires_at);
  db.prepare('UPDATE data_exports SET download_hash = ? WHERE id = ?').run(`${sha(key)}:${linkExp}`, job.id);
  return { key, expires_at: linkExp };
}

/** Constant-time check of a download key. Returns the job row or null. */
function verifyKey(db, id, key) {
  const job = db.prepare('SELECT * FROM data_exports WHERE id = ?').get(String(id || ''));
  if (!job || !job.download_hash || !key) return null;
  const [hash, exp] = job.download_hash.split(':');
  if (!exp || Number(exp) <= now()) return null;
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(sha(String(key)), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (job.status !== 'ready' || !job.expires_at || job.expires_at <= now()) return null;
  return job;
}

function filePath(job) {
  const p = path.join(exportsDir(), path.basename(String(job.file_name || '')));
  return p.startsWith(exportsDir() + path.sep) ? p : null;
}

/** Remove expired archives; fail jobs a restart interrupted. Returns how many expired. */
function sweep(db = dbOf()) {
  let n = 0;
  try {
    for (const j of db.prepare("SELECT * FROM data_exports WHERE status = 'ready' AND expires_at <= ?").all(now())) {
      const p = filePath(j);
      if (p) { try { fs.rmSync(p, { force: true }); } catch (_) { /* */ } }
      db.prepare("UPDATE data_exports SET status = 'expired', download_hash = NULL WHERE id = ?").run(j.id);
      n++;
    }
    db.prepare("UPDATE data_exports SET status = 'failed', error = 'interrupted by a restart' WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)").run(now() - STALE_RUNNING_SEC);
  } catch (_) { /* table absent */ }
  return n;
}

let sweepTimer = null;
function start(db = dbOf()) {
  if (sweepTimer) return;
  // A job left 'running' by a stopped process will never finish: requeue it once at boot.
  try { db.prepare("UPDATE data_exports SET status = 'queued' WHERE status = 'running'").run(); } catch (_) { /* */ }
  sweep(db);
  kick();
  sweepTimer = setInterval(() => sweep(db), 15 * 60 * 1000);
  sweepTimer.unref?.();
}

/** The fields a requester may see about a job. */
function publicJob(j) {
  let summary = null;
  try { summary = j.manifest ? JSON.parse(j.manifest) : null; } catch (_) { summary = null; }
  return {
    id: j.id, kind: j.kind, status: j.status, bytes: j.bytes || null, created_at: j.created_at,
    finished_at: j.finished_at || null, expires_at: j.expires_at || null, error: j.status === 'failed' ? (j.error || null) : null,
    downloads: j.downloads || 0, sha256: j.sha256 || null, summary,
  };
}

module.exports = {
  request, runQueue, runJob, link, verifyKey, filePath, sweep, start, publicJob, whereFor, exportableColumns, redactRow,
  buildZip, writeOrgExport, appendTable, appendString, recordIntegrity, now, exportsDir, freeBytes, diskBytes,
  ExportError, MAX_PER_DAY, LINK_TTL_MIN, TTL_HOURS,
  _setHooks: (h) => { _hooks = { ...(h || {}) }; },
};
