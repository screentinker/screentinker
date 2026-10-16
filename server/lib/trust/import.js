'use strict';

/*
 * "Move your organization to another server" — the import jobs (docs/move-server.md).
 *
 * An import is ONE organization's export restored into ONE organization here. Three ways in, and
 * none of them needs the old server to still exist except the first:
 *   pull    the old server's export download link; this server streams the archive itself (the
 *           outbound guard applies: no private or internal addresses unless the operator opened
 *           them), resuming with HTTP Range after an interruption, and checks the whole file
 *           against the digest the old server sent;
 *   upload  the archive from the browser in chunks (resumable: the offset is the size on disk);
 *   disk    platform administrators only: an archive already in DATA_DIR/imports (copied there with
 *           scp or rsync), picked from a list — never a path typed in a browser.
 * Then: scan (check every entry against the manifest, summarise, compare with the room here) →
 * the administrator chooses → restore (lib/trust/import-restore.js), resumable, rolled back on
 * failure → invites and the "move your screens" step.
 *
 * A platform administrator can also restore a WHOLE-SERVER bundle (lib/trust/instance-export.js):
 * one child job per organization in it, each through the same per-organization path, so one bad
 * organization never stops the others.
 *
 * Job statuses: receiving (upload waiting for chunks) · fetching · scanning · scanned · refused ·
 * restoring · done · failed (rolled back) · partial (rollback failed: delete the organization) ·
 * interrupted (a pull that needs a fresh link) · cancelled.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { resolveWithin } = require('../safe-path');
const archive = require('./import-archive');
const restoreLib = require('./import-restore');
const { ImportError } = archive;

const MAX_ARCHIVE_BYTES = Number(process.env.IMPORT_MAX_ARCHIVE_BYTES) || 2 * 1024 * 1024 * 1024 * 1024; // 2 TB
const CHUNK_MAX = 16 * 1024 * 1024;
const MAX_PER_DAY = 10;
const ACTIVE = ['receiving', 'fetching', 'scanning', 'scanned', 'restoring', 'interrupted'];
const now = () => Math.floor(Date.now() / 1000);
const tick = () => new Promise((r) => setImmediate(r));

function dbOf() { return require('../../db/database').db; }
const importsDir = () => path.join(config.dataDir, 'imports');
const incomingDir = () => path.join(importsDir(), 'incoming');

/* ───────────── files ───────────── */

/** Where a job's archive is. A disk job names a file in DATA_DIR/imports; the others own one in incoming/. */
function archivePath(job) {
  if (job.source === 'disk') return diskFile(job.file_name);
  return path.join(incomingDir(), `${job.id}.zip`);
}

/**
 * The archives a platform administrator has placed in DATA_DIR/imports. Regular files only, named
 * plainly, directly in that folder: a symbolic link (or a name with a path in it) is never listed and
 * never opened, so the folder cannot be used to read anything else on the machine.
 */
function listDisk() {
  const dir = importsDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const p = diskFile(name);
    if (!p) continue;
    const st = fs.lstatSync(p);
    out.push({ name, bytes: st.size, modified_at: Math.floor(st.mtimeMs / 1000) });
  }
  return out.sort((a, b) => b.modified_at - a.modified_at);
}

function diskFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/.test(name)) return null;
  const dir = path.resolve(importsDir());
  const p = resolveWithin(dir, name);
  if (!p || path.dirname(p) !== dir) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    // The folder itself must not be a link to somewhere else either.
    if (fs.realpathSync(p) !== path.join(fs.realpathSync(dir), name)) return null;
  } catch (_) { return null; }
  return p;
}

/* ───────────── jobs ───────────── */

function getJob(db, id) { return db.prepare('SELECT * FROM org_imports WHERE id = ?').get(String(id || '')); }

function update(db, id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE org_imports SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(...keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k])), id);
}

/**
 * Parse an export download link: `https://old.example/api/public/trust-export/<id>?key=<key>` (or
 * the whole-server bundle's instance-export). Returns { base, key } or throws ImportError.
 */
function parseSourceLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw new ImportError('Paste the full download link from the old server.', 'bad_link'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImportError('The link must start with https://', 'bad_link');
  if (u.username || u.password) throw new ImportError('The link must not contain a user name or password.', 'bad_link');
  const m = /^\/api\/public\/(trust-export|instance-export)\/([A-Za-z0-9-]{8,64})$/.exec(u.pathname);
  const key = u.searchParams.get('key');
  if (!m || !key || !/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw new ImportError('That is not an export download link. On the old server open Settings → Data & privacy, prepare an export and copy its link.', 'bad_link');
  return { base: `${u.origin}${u.pathname}`, key, bundle: m[1] === 'instance-export' };
}

class LimitError extends ImportError {}

/*
 * An archive is mostly media, which the plan's storage allowance covers — checked properly at the
 * scan, against the media the manifest lists. Before that, while bytes are still arriving, the
 * archive as a whole may not exceed the allowance by more than this much (the tables and history),
 * so a plan with little storage cannot be used to fill the server's disk with an enormous upload.
 */
const PLAN_SLACK_BYTES = 2 * 1024 * 1024 * 1024;
function overPlan(room, bytes) {
  return room.plan_room_bytes != null && bytes > Math.max(0, room.plan_room_bytes) + PLAN_SLACK_BYTES;
}

/**
 * Start a job. `who`: { userId, orgId (the requester's current organization), platformAdmin }.
 * `kind` 'org' (default) or 'instance' (platform administrators only).
 */
async function create(db, who, { source, kind = 'org', url = null, file_name = null, bytes = null, disk_name = null } = {}) {
  if (!['pull', 'upload', 'disk'].includes(source)) throw new ImportError('Choose how to bring the export in.', 'bad_source');
  if (kind !== 'org' && kind !== 'instance') throw new ImportError('Unknown import kind.', 'bad_kind');
  if (kind === 'instance' && !who.platformAdmin) throw new ImportError('Only a platform administrator can restore a whole server.', 'forbidden', 403);
  // DATA_DIR/imports is the server's own disk: instance-level, so platform administrators only.
  if (source === 'disk' && !who.platformAdmin) throw new ImportError('Only a platform administrator can import a file from the server\'s disk.', 'forbidden', 403);

  const scope = who.platformAdmin && kind === 'instance' ? ['requested_by = ?', who.userId] : ['requester_org_id = ?', who.orgId];
  const busy = db.prepare(`SELECT id FROM org_imports WHERE ${scope[0]} AND parent_id IS NULL AND status IN (${ACTIVE.map(() => '?').join(',')})`).get(scope[1], ...ACTIVE);
  if (busy) throw new LimitError('An import is already in progress. Finish or cancel it first.', 'busy', 429);
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM org_imports WHERE ${scope[0]} AND parent_id IS NULL AND created_at > ?`).get(scope[1], now() - 86400).n;
  if (recent >= MAX_PER_DAY) throw new LimitError(`At most ${MAX_PER_DAY} imports a day.`, 'daily_limit', 429);

  const id = crypto.randomUUID();
  const row = { id, kind, requested_by: who.userId, requester_org_id: who.orgId || null, source, status: 'receiving' };
  if (source === 'pull') {
    const link = parseSourceLink(url);
    if (link.bundle && kind !== 'instance') throw new ImportError('That is a whole-server bundle: a platform administrator restores it from Platform → Data & privacy.', 'is_bundle');
    if (!link.bundle && kind === 'instance') throw new ImportError('That is one organization\'s export: import it from Settings → Data & privacy.', 'not_bundle');
    // Refused now rather than when the worker gets to it: a private or internal address is not a
    // place an import fetches from unless the operator opened it (docs/outbound-requests.md).
    try { await require('../ssrf-guard').assertSafeUrl(link.base); } catch (e) {
      throw new ImportError(`This server will not fetch from that address (${e.reason || e.message}). ${require('../ssrf-guard').privateAddressHint()}`, 'blocked_address');
    }
    row.source_url = link.base;
    row.source_key_enc = require('../secretbox').encrypt(link.key);
    row.status = 'fetching';
  } else if (source === 'upload') {
    const n = Number(bytes);
    if (!Number.isSafeInteger(n) || n <= 0) throw new ImportError('Choose the export file.', 'bad_size');
    if (n > MAX_ARCHIVE_BYTES) throw new ImportError('That file is larger than this server accepts.', 'too_large', 413);
    // Before a byte is accepted: will it fit?
    const room = restoreLib.roomFor(db, who.userId, n, 0);
    if (room.reasons.includes('disk')) throw new ImportError('There is not enough free disk space on this server for that file.', 'no_room', 413);
    if (overPlan(room, n)) throw new ImportError('That file is larger than your plan\'s storage allows.', 'no_room', 413);
    row.declared_bytes = n;
    row.file_name = String(file_name || 'export.zip').replace(/[^\w .()-]/g, '_').slice(0, 120);
  } else {
    const p = diskFile(disk_name);
    if (!p) throw new ImportError('Choose one of the files in the imports folder.', 'bad_file');
    row.file_name = disk_name;
    row.declared_bytes = fs.statSync(p).size;
    row.status = 'scanning';
  }
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO org_imports (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  if (row.status !== 'receiving') kick();
  return getJob(db, id);
}

/** Append one uploaded chunk at `offset`. Returns { offset, complete }. */
function appendChunk(db, job, offset, buf) {
  if (job.status !== 'receiving' || job.source !== 'upload') throw new ImportError('This import is not waiting for an upload.', 'not_receiving', 409);
  fs.mkdirSync(incomingDir(), { recursive: true, mode: 0o700 });
  const p = archivePath(job);
  let have = 0;
  try { have = fs.statSync(p).size; } catch (_) { have = 0; }
  if (Number(offset) !== have) return { ok: false, offset: have };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: true, offset: have, complete: have === job.declared_bytes };
  if (buf.length > CHUNK_MAX) throw new ImportError('That chunk is too large.', 'chunk_too_large', 413);
  if (have + buf.length > job.declared_bytes) throw new ImportError('The upload is larger than it said it would be.', 'too_large', 413);
  fs.appendFileSync(p, buf, { mode: 0o600 });
  const next = have + buf.length;
  const complete = next === job.declared_bytes;
  update(db, job.id, complete ? { status: 'scanning', progress: { phase: 'received', bytes: next } } : { progress: { phase: 'receiving', bytes: next } });
  if (complete) kick();
  return { ok: true, offset: next, complete };
}

/** A fresh download link for a pull that was interrupted after its link expired. */
async function relink(db, job, url) {
  if (job.source !== 'pull' || !['interrupted', 'fetching'].includes(job.status)) throw new ImportError('This import is not waiting for a link.', 'not_interrupted', 409);
  const link = parseSourceLink(url);
  if (link.base !== job.source_url) throw new ImportError('That link is for a different export. Paste a new link for the same export.', 'other_export');
  update(db, job.id, { source_key_enc: require('../secretbox').encrypt(link.key), status: 'fetching', error: null });
  kick();
  return getJob(db, job.id);
}

/* ───────────── pull ───────────── */

async function fetchArchive(db, job) {
  const { guardedRequest } = require('../ssrf-guard');
  fs.mkdirSync(incomingDir(), { recursive: true, mode: 0o700 });
  const p = archivePath(job);
  let have = 0;
  try { have = fs.statSync(p).size; } catch (_) { have = 0; }
  const key = require('../secretbox').decrypt(job.source_key_enc || '');
  if (!key) throw new ImportError('The download link is no longer available. Paste a new one.', 'link_expired');
  let r;
  try {
    r = await guardedRequest(`${job.source_url}?key=${encodeURIComponent(key)}`, {
      headers: have ? { Range: `bytes=${have}-`, Accept: 'application/zip' } : { Accept: 'application/zip' },
      responseType: 'stream', accept2xx: true, timeoutMs: 60000, idleTimeoutMs: 120000, maxRedirects: 2,
    });
  } catch (e) {
    if (e && e.code === 'ssrf') throw new ImportError(`This server will not fetch from that address (${e.reason}). ${require('../ssrf-guard').privateAddressHint()}`, 'blocked_address');
    if (e && (e.statusCode === 404 || e.statusCode === 403)) throw new ImportError('The old server refused the link: it has expired (links last 15 minutes) or the export is gone. Paste a new link.', 'link_expired');
    if (e && e.statusCode === 416) { have = 0; try { fs.rmSync(p, { force: true }); } catch (_) { /* */ } }
    throw new ImportError(`Could not reach the old server (${(e && e.message) || 'error'}).`, 'unreachable');
  }
  const res = r.res;
  let total;
  if (r.statusCode === 206) {
    const m = /\/(\d+)$/.exec(String(r.headers['content-range'] || ''));
    total = m ? Number(m[1]) : null;
  } else {
    // A 200 is the whole file again: the old server does not do ranges, so start over.
    if (have) { fs.rmSync(p, { force: true }); have = 0; }
    total = Number(r.headers['content-length']) || null;
  }
  const sha = String(r.headers['x-export-sha256'] || '').toLowerCase();
  if (total != null) {
    if (total > MAX_ARCHIVE_BYTES) { res.destroy(); throw new ImportError('The archive is larger than this server accepts.', 'too_large'); }
    const room = restoreLib.roomFor(db, job.requested_by, total - have, 0);
    if (room.reasons.includes('disk')) { res.destroy(); throw new ImportError('There is not enough free disk space on this server for this archive.', 'no_room'); }
    if (overPlan(room, total - have)) { res.destroy(); throw new ImportError('The archive is larger than your plan\'s storage allows.', 'no_room'); }
  }
  update(db, job.id, { declared_bytes: total, source_sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : job.source_sha256 || null });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(p, { flags: 'a', mode: 0o600 });
    let n = have, lastSave = 0;
    res.on('data', (c) => {
      n += c.length;
      if ((total != null && n > total) || n > MAX_ARCHIVE_BYTES) { res.destroy(new ImportError('The old server sent more than it said.', 'too_large')); return; }
      if (Date.now() - lastSave > 1000) { lastSave = Date.now(); update(db, job.id, { progress: { phase: 'fetching', bytes: n, total } }); }
    });
    res.on('error', (e) => { out.end(); reject(e instanceof ImportError ? e : new ImportError('The transfer was interrupted.', 'interrupted')); });
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  const got = fs.statSync(p).size;
  if (total != null && got !== total) throw new ImportError('The transfer was interrupted.', 'interrupted');
  const want = getJob(db, job.id).source_sha256;
  if (want) {
    const h = await hashFile(p);
    if (h !== want) {
      fs.rmSync(p, { force: true });
      throw new ImportError('The archive that arrived does not match the one the old server sent. It has been discarded; try again.', 'tampered');
    }
  }
  update(db, job.id, { status: 'scanning', source_key_enc: null, progress: { phase: 'received', bytes: got } });
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/* ───────────── scan ───────────── */

async function scanJob(db, job) {
  const arch = await archive.open(archivePath(job));
  const onProgress = (pr) => update(db, job.id, { progress: pr });
  if (job.kind === 'instance') {
    if (arch.kind !== 'instance') throw new ImportError('This is one organization\'s export, not a whole-server bundle.', 'not_bundle');
    const summary = await require('./instance-export').scanBundle(db, job, arch, onProgress);
    update(db, job.id, { status: 'scanned', scan: summary, progress: { phase: 'scanned' } });
    return;
  }
  if (arch.kind !== 'org') throw new ImportError('This is a whole-server bundle; a platform administrator restores it from Platform → Data & privacy.', 'is_bundle');
  const summary = await restoreLib.scan(arch, { db, instance: !!job.parent_id }, onProgress);
  summary.room = restoreLib.roomFor(db, job.requested_by, summary.media.bytes, summary.devices.length);
  summary.archive_bytes = fs.statSync(archivePath(job)).size;
  update(db, job.id, { status: 'scanned', scan: summary, progress: { phase: 'scanned' } });
}

/* ───────────── restore ───────────── */

/** May `who` restore into organization `orgId`? Owners and admins of it, or a platform administrator. */
function canTarget(db, who, orgId) {
  if (who.platformAdmin) return !!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(orgId);
  const r = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(orgId, who.userId);
  return !!r && (r.role === 'org_owner' || r.role === 'org_admin');
}

/*
 * "Empty" means nothing anyone made yet: no screens, media, playlists, layouts, widgets, schedules,
 * signs or data sources in any of its workspaces. Its existing workspaces are left as they are; the
 * import creates its own beside them.
 */
function isEmptyOrg(db, orgId) {
  const ws = 'SELECT id FROM workspaces WHERE organization_id = ?';
  for (const t of ['devices', 'content', 'playlists', 'widgets', 'schedules', 'slide_decks', 'data_sources']) {
    try { if (db.prepare(`SELECT 1 FROM ${t} WHERE workspace_id IN (${ws}) LIMIT 1`).get(orgId)) return false; } catch (_) { /* table absent */ }
  }
  if (db.prepare(`SELECT 1 FROM layouts WHERE is_template = 0 AND workspace_id IN (${ws}) LIMIT 1`).get(orgId)) return false;
  return true;
}

/**
 * Choose where the archive goes and start restoring it.
 * target: { mode: 'new', name? } | { mode: 'existing', organization_id }. options: include_* flags.
 */
function startRestore(db, job, who, { target = { mode: 'new' }, options = {} } = {}) {
  if (job.status !== 'scanned' && !(job.status === 'failed' && job.parent_id)) throw new ImportError('This import is not ready to restore.', 'not_ready', 409);
  const scan = JSON.parse(job.scan || '{}');
  if (job.kind === 'instance') return require('./instance-export').startBundleRestore(db, job, who, options);
  if (scan.room && !scan.room.ok && !job.parent_id) {
    const room = restoreLib.roomFor(db, who.userId, scan.media.bytes, scan.devices.length);
    if (!room.ok) throw new ImportError('This organization does not fit here: ' + room.reasons.map((r) => ({ plan_storage: 'it needs more storage than your plan allows', disk: 'the server does not have enough free disk', plan_devices: 'it has more screens than your plan allows' }[r])).join('; ') + '.', 'no_room', 413);
  }
  const opts = {
    include_proof_of_play: options.include_proof_of_play !== false,
    include_audit: options.include_audit !== false,
    include_history: options.include_history !== false,
  };
  let orgId, created = 0;
  const instance = !!job.parent_id;
  db.transaction(() => {
    if (target.mode === 'existing') {
      const id = String(target.organization_id || '');
      if (!canTarget(db, who, id)) throw new ImportError('You cannot import into that organization.', 'forbidden', 403);
      if (!isEmptyOrg(db, id)) throw new ImportError('That organization is not empty. Import into a new organization instead; an import never writes over existing data.', 'not_empty', 409);
      orgId = id;
    } else {
      orgId = crypto.randomUUID();
      created = 1;
      let name = String((target.name || (scan.organization && scan.organization.name) || 'Imported organization')).trim().slice(0, 120) || 'Imported organization';
      if (!instance && db.prepare('SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id = o.id WHERE m.user_id = ? AND o.name = ?').get(who.userId, name)) name = `${name} (imported)`.slice(0, 120);
      db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(orgId, name, who.userId);
      // The importing administrator owns it. A whole-server restore gives the organization back to
      // its own owner instead (lib/trust/import-restore.js finish), and adds no one else.
      if (!instance) db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(orgId, who.userId);
    }
    update(db, job.id, { status: 'restoring', organization_id: orgId, created_org: created, options: opts, progress: { phase: 'ids' }, error: null, result: null });
  })();
  kick();
  return getJob(db, job.id);
}

async function restoreJob(db, job) {
  const arch = await archive.open(archivePath(job));
  const scan = JSON.parse(job.scan || '{}');
  const importer = db.prepare('SELECT id, email FROM users WHERE id = ?').get(job.requested_by) || { id: job.requested_by, email: '' };
  let orgRow = null;
  await archive.readRows(arch, 'tables/organizations.jsonl', async (rows) => { orgRow = rows[0]; });
  const present = new Set([...arch.entries.keys()].filter((n) => n.startsWith('tables/')).map(restoreLib.tableName));
  const r = new restoreLib.Restorer({
    db, job, arch, importer, instance: !!job.parent_id, options: JSON.parse(job.options || '{}'),
    orgId: job.organization_id, srcOrgId: arch.manifest.organization.id, createdOrg: !!job.created_org, orgRow, present,
    counts: scan.counts || {},
    canGrantOwner: !!job.created_org || isPlatformUser(db, job.requested_by)
      || !!db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role = 'org_owner'").get(job.organization_id, job.requested_by),
  });
  const result = await r.run();
  if (job.parent_id && job.created_org && orgRow && orgRow.owner_user_id) {
    // A whole-server restore: the organization belongs to its own owner again.
    const owner = r.userMap.get(orgRow.owner_user_id);
    if (owner) db.prepare('UPDATE organizations SET owner_user_id = ? WHERE id = ?').run(owner, job.organization_id);
  }
  update(db, job.id, { status: 'done', result, finished_at: now(), progress: { phase: 'done', stats: r.stats } });
  try { require('../audit').audit('trust.import_done', { userId: job.requested_by, details: { import_id: job.id, organization_id: job.organization_id, screens: result.screens, invites: result.invites || 0 } }); } catch (_) { /* */ }
}

function isPlatformUser(db, userId) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!u && require('../../middleware/auth').isPlatformRole(u.role);
}

/* ───────────── worker ───────────── */

let running = false;
let currentJob = null;
function kick() { setImmediate(() => { runQueue().catch((e) => console.warn(`[import] queue: ${e && e.message}`)); }); }

async function runQueue(db = dbOf()) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare("SELECT * FROM org_imports WHERE status IN ('fetching','scanning','restoring') ORDER BY updated_at, rowid LIMIT 1").get();
      if (!job) break;
      currentJob = job.id;
      await runOne(db, job);
      currentJob = null;
      await tick();
    }
  } finally { running = false; currentJob = null; }
}

async function runOne(db, job) {
  try {
    if (job.status === 'fetching') await fetchArchive(db, job);
    else if (job.status === 'scanning') await scanJob(db, job);
    else if (job.status === 'restoring') {
      if (job.kind === 'instance') await require('./instance-export').runBundleRestore(db, job);
      else await restoreJob(db, job);
    }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    const code = (e && e.code) || 'error';
    const fresh = getJob(db, job.id);
    if (!fresh || fresh.status === 'cancelled') return;
    if (job.status === 'fetching') {
      // A link that expired or a transfer that dropped can be continued; anything else cannot.
      const resumable = ['link_expired', 'interrupted', 'unreachable'].includes(code);
      update(db, job.id, { status: resumable ? 'interrupted' : 'refused', error: msg });
    } else if (job.status === 'scanning') {
      update(db, job.id, { status: 'refused', error: msg, scan: { refused: { code, message: msg } } });
    } else {
      console.warn(`[import] ${job.id} failed: ${msg}`);
      let status = 'failed';
      try { restoreLib.rollback(db, fresh); } catch (re) { status = 'partial'; console.warn(`[import] rollback of ${job.id} failed: ${re && re.message}`); }
      update(db, job.id, { status, error: msg, finished_at: now(), ...(status === 'failed' ? { progress: { phase: 'rolled_back' }, organization_id: fresh.created_org ? null : fresh.organization_id } : {}) });
      try { require('../audit').audit('trust.import_failed', { userId: job.requested_by, details: { import_id: job.id, error: msg.slice(0, 200), rolled_back: status === 'failed' } }); } catch (_) { /* */ }
    }
  }
}

/** Cancel a job that has not been restored; its uploaded or pulled file is removed. */
function cancel(db, job) {
  if (['restoring'].includes(job.status)) throw new ImportError('A restore cannot be cancelled while it runs; it rolls back by itself if it fails.', 'running', 409);
  if (job.status === 'done') throw new ImportError('This import is finished. Delete the organization instead if you do not want it.', 'done', 409);
  update(db, job.id, { status: 'cancelled', source_key_enc: null, finished_at: now() });
  discardFile(job);
  for (const c of db.prepare('SELECT * FROM org_imports WHERE parent_id = ?').all(job.id)) {
    if (c.status !== 'done') { update(db, c.id, { status: 'cancelled' }); discardFile(c); }
  }
}

function discardFile(job) {
  if (job.source === 'disk') return;      // the administrator's own file is never deleted
  try { fs.rmSync(archivePath(job), { force: true }); } catch (_) { /* */ }
}

/** Delete what a partial (failed, not rolled back) restore left. */
function discardPartial(db, job) {
  if (job.status !== 'partial') throw new ImportError('Only a partial import can be deleted this way.', 'not_partial', 409);
  restoreLib.rollback(db, job);
  update(db, job.id, { status: 'failed', organization_id: job.created_org ? null : job.organization_id, progress: { phase: 'rolled_back' } });
}

/** Old uploads that never finished, and archives of finished jobs, are removed after a week. */
function sweep(db = dbOf()) {
  try {
    const old = now() - 7 * 86400;
    for (const j of db.prepare("SELECT * FROM org_imports WHERE updated_at < ? AND status IN ('receiving','interrupted','refused','done','failed','cancelled','scanned')").all(old)) {
      discardFile(j);
      if (['receiving', 'interrupted', 'scanned'].includes(j.status)) update(db, j.id, { status: 'cancelled', source_key_enc: null });
    }
  } catch (_) { /* table absent */ }
}

let sweepTimer = null;
function start(db = dbOf()) {
  if (sweepTimer) return;
  sweep(db);
  kick();   // a restart resumes fetching, scanning and restoring jobs where they stopped
  sweepTimer = setInterval(() => sweep(db), 6 * 3600 * 1000);
  sweepTimer.unref?.();
}

/** What a requester may see of a job (never the download key). */
function publicJob(j) {
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } };
  return {
    id: j.id, kind: j.kind, parent_id: j.parent_id || null, status: j.status, source: j.source,
    source_host: j.source_url ? (() => { try { return new URL(j.source_url).host; } catch (_) { return null; } })() : null,
    file_name: j.file_name || null, declared_bytes: j.declared_bytes || null,
    organization_id: j.organization_id || null, created_org: !!j.created_org,
    progress: parse(j.progress), scan: parse(j.scan), options: parse(j.options), result: parse(j.result),
    error: j.error || null, created_at: j.created_at, updated_at: j.updated_at, finished_at: j.finished_at || null,
  };
}

module.exports = {
  create, appendChunk, relink, startRestore, cancel, discardPartial, runQueue, runOne, start, kick, sweep, getJob, update,
  publicJob, listDisk, diskFile, archivePath, importsDir, incomingDir, parseSourceLink, canTarget, isEmptyOrg,
  ImportError, LimitError, MAX_PER_DAY, CHUNK_MAX, ACTIVE, hashFile, currentJob: () => currentJob,
};
