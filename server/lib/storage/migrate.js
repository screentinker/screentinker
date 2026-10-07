'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const config = require('../../config');
const { db } = require('../../db/database');
const storage = require('./index');
const locations = require('./locations');
const { StorageError, StorageRefusedError } = require('./errors');

/*
 * ⚠️ A MIGRATION IS A COPY, THEN A FLIP, THEN A DRAIN — AND ONLY THE COPY IS AUTOMATIC.
 *
 *   start   records a storage_migrations row and starts the copier. Nothing a screen reads changes.
 *   copy    for each content row: stream the bytes from the first ready copy to the target, hashing
 *           as they go; on a digest match insert a READY REPLICA on the target. The source stays
 *           ready. From this moment the row can be served from either.
 *   commit  (operator) target becomes primary, the old primary becomes DRAINING — still readable,
 *           still served if the target errors. New uploads go to the target only.
 *   drain   (operator, or STORAGE_DRAIN_AFTER_HOURS) deletes draining copies ScreenTinker wrote,
 *           after the refcount says nothing else needs them. Reference imports are never drained.
 *   abort   stops the copier, puts primary back where it was. Copied replicas stay: abort is not a
 *           delete.
 *
 * ⚠️ A RESTART RESUMES, IT NEVER DECIDES. Progress is the row in SQLite (cursor = last content id
 * done). On boot a migration in `copying` carries on from its cursor; nothing at boot commits,
 * flips a primary or deletes a source. Those are only ever the operator's calls.
 *
 * Mesh-shared bytes: the copier dedupes on (target profile, digest) within the org, so a 400 MB
 * video pushed to ten workspaces is uploaded once and ten location rows point at it. The refcount
 * in locations.releaseObjects is what keeps a drain from deleting it out from under nine of them.
 *
 * Quota does not double: content.file_size is still the billable number; a second copy is a
 * location row, not a second content row.
 */

const BATCH = 20;
const ACTIVE = ['copying', 'ready_to_commit'];
const running = new Map();   // migrationId -> { stop: boolean }

function get(id) { return db.prepare('SELECT * FROM storage_migrations WHERE id = ?').get(id) || null; }
/* One copy at a time per organization, whatever its scope: two copiers over overlapping rows would
 * race the same location rows, and an operator watching one progress bar is the clearer model. */
function activeFor(orgId) { return db.prepare(`SELECT * FROM storage_migrations WHERE org_id = ? AND state IN ('copying','ready_to_commit') LIMIT 1`).get(orgId) || null; }
function latestFor(orgId) { return db.prepare('SELECT * FROM storage_migrations WHERE org_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(orgId) || null; }

/*
 * ⚠️ THE SCOPE OF A MIGRATION, used by every step so copy, commit, abort and drain always agree on
 * which rows they touch:
 *   workspace_id set  -> that workspace's content only;
 *   workspace_id NULL -> the organization's content, EXCEPT workspaces that have their own override.
 * Those chose their storage deliberately; an org-wide move must not drag their media along, and its
 * commit must not flip their rows.
 */
function scopeSql(m) {
  return m.workspace_id
    ? { join: 'JOIN workspaces w ON w.id = c.workspace_id', where: 'w.organization_id = ? AND c.workspace_id = ?', args: [m.org_id, m.workspace_id] }
    : { join: 'JOIN workspaces w ON w.id = c.workspace_id', where: 'w.organization_id = ? AND w.storage_profile_id IS NULL', args: [m.org_id] };
}
function scopeIds(m) {
  const q = scopeSql(m);
  return db.prepare(`SELECT c.id FROM content c ${q.join} WHERE ${q.where}`).all(...q.args);
}

function touch(id, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  sets.push("updated_at = CAST(strftime('%s','now') AS INTEGER)");
  db.prepare(`UPDATE storage_migrations SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(fields), id);
}

/** Content rows in scope that have bytes (not remote URLs / YouTube / HLS). */
function contentAfter(m, cursor, limit) {
  const q = scopeSql(m);
  return db.prepare(`SELECT c.* FROM content c ${q.join}
                      WHERE ${q.where} AND c.filepath IS NOT NULL AND c.filepath != '' AND c.remote_url IS NULL
                        AND c.id > ? ORDER BY c.id LIMIT ?`).all(...q.args, cursor || '', limit);
}
function contentCount(m) {
  const q = scopeSql(m);
  return db.prepare(`SELECT COUNT(*) AS n FROM content c ${q.join}
                      WHERE ${q.where} AND c.filepath IS NOT NULL AND c.filepath != '' AND c.remote_url IS NULL`).get(...q.args).n;
}

/**
 * Start copying. `scope` is the organization id (an org-wide move), or { orgId, workspaceId } to
 * move one workspace — which must then be able to use the target (its own, its org's, or an
 * instance profile).
 */
function start(scope, targetId) {
  const orgId = typeof scope === 'object' && scope ? scope.orgId : scope;
  const workspaceId = typeof scope === 'object' && scope ? scope.workspaceId || null : null;
  const target = workspaceId ? storage.profileForWorkspace(targetId, workspaceId) : storage.profileForOrg(targetId, orgId);
  if (!target) { const e = new StorageRefusedError('No such storage profile.'); e.status = 404; throw e; }
  if (target.mode !== 'rw') { const e = new StorageRefusedError('A read-only profile cannot be a migration target.'); e.status = 400; throw e; }
  if (target.credentials_unreadable) { const e = new StorageRefusedError('This profile\'s credentials must be re-entered (the server\'s JWT secret changed).'); e.status = 400; throw e; }
  if (activeFor(orgId)) { const e = new StorageRefusedError('A migration is already running for this organization.'); e.status = 409; throw e; }
  // previous_profile_id is the RAW setting being replaced (the org's, or the workspace's override;
  // NULL = follows the level above), so an abort puts back exactly what was there rather than
  // pinning anything to whatever that resolved to.
  const prev = workspaceId
    ? db.prepare('SELECT storage_profile_id FROM workspaces WHERE id = ?').get(workspaceId)
    : db.prepare('SELECT storage_profile_id FROM organizations WHERE id = ?').get(orgId);
  const id = storage.newId();
  const m = { org_id: orgId, workspace_id: workspaceId };
  db.prepare(`INSERT INTO storage_migrations (id, org_id, workspace_id, target_profile_id, previous_profile_id, state, total)
              VALUES (?, ?, ?, ?, ?, 'copying', ?)`).run(id, orgId, workspaceId, storage.outId(storage.normId(target.id)), (prev && prev.storage_profile_id) || null, contentCount(m));
  run(id);
  return get(id);
}

/* ───────────────────────────── the copier ───────────────────────────── */

function run(id) {
  if (running.has(id)) return;
  const ctl = { stop: false };
  running.set(id, ctl);
  setImmediate(() => loop(id, ctl).catch((e) => {
    console.warn(`[storage] migration ${id} stopped: ${(e && e.code) || (e && e.message)}`);
    try { touch(id, { last_error: String((e && e.code) || 'error').slice(0, 40) }); } catch (_) {}
  }).finally(() => running.delete(id)));
}

async function loop(id, ctl) {
  for (;;) {
    if (ctl.stop) return;
    const m = get(id);
    if (!m || m.state !== 'copying') return;
    const target = storage.getProfile(m.target_profile_id);
    if (!target) { touch(id, { last_error: 'target profile deleted' }); return; }
    const rows = contentAfter(m, m.cursor, BATCH);
    if (!rows.length) { touch(id, { state: 'ready_to_commit' }); console.log(`[storage] migration ${id} copied: ${m.verified} verified, ${m.failed} failed, ${m.skipped} already there`); return; }
    for (const row of rows) {
      if (ctl.stop) return;
      let r;
      try { r = await copyRow(row, target, m.org_id); }
      catch (e) { r = { outcome: 'failed', code: (e && e.code) || 'error' }; }
      const cur = get(id);
      if (!cur || cur.state !== 'copying') return;
      touch(id, {
        cursor: row.id,
        copied: cur.copied + (r.outcome === 'copied' ? 1 : 0),
        verified: cur.verified + (r.outcome === 'copied' || r.outcome === 'present' ? 1 : 0),
        failed: cur.failed + (r.outcome === 'failed' ? 1 : 0),
        skipped: cur.skipped + (r.outcome === 'present' ? 1 : 0),
        ...(r.outcome === 'failed' ? { last_error: String(r.code || 'error').slice(0, 40) } : {}),
      });
    }
  }
}

function insertLocation(contentId, kind, profileId, key, role, digest, size, owned = 1, ref = null) {
  db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest, size, verified_at, ref)
              VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, CAST(strftime('%s','now') AS INTEGER), ?)
              ON CONFLICT DO UPDATE SET state = 'ready', verified_at = excluded.verified_at, last_error = NULL`)
    .run(contentId, kind, profileId, key, role, owned, digest, size, ref);
}

/** Make the implicit local location explicit, so commit has a row to mark draining. */
function materializeImplicit(row, kind, locs) {
  if (locs.length === 1 && locs[0].implicit) {
    insertLocation(row.id, kind, null, locs[0].object_key, 'primary', kind === 'asset' ? row.byte_digest : null, kind === 'asset' ? row.file_size : null);
    return locations.listLocations(row, kind);
  }
  return locs;
}

/**
 * Copy one kind of one row to `target`. 'present' when a ready copy is already there, 'copied' on a
 * verified copy, throws on failure. Never removes or demotes anything.
 */
async function copyKind(row, kind, target, orgId, { historyLoc = null } = {}) {
  const pid = target.provider === 'local' ? null : target.id;
  let locs = historyLoc ? [historyLoc] : locations.listLocations(row, kind);
  if (!locs.length) return 'none';
  if (!historyLoc && locs.some((l) => (l.storage_profile_id || null) === pid && l.state === 'ready')) return 'present';
  if (!historyLoc) locs = materializeImplicit(row, kind, locs);
  const sourceOrder = locations.orderForRead(locs);
  if (!sourceOrder.length) throw new StorageError('not_found', 'No readable source copy.', { key: row.id });

  const storeKind = historyLoc ? 'history' : kind;
  const basename = historyLoc
    ? path.basename(String(historyLoc.ref || historyLoc.object_key))
    : locations.basenameOf(row[locations.KIND_COLUMN[locations.effectiveKind(row, kind)]]);
  const knownDigest = storeKind === 'asset' ? row.byte_digest : (sourceOrder[0].byte_digest || null);
  const be = storage.backendFor(target);
  const tag = historyLoc ? String(historyLoc.ref || '').split('/')[2] || 'r0' : null;
  const keyOf = (digest) => locations.keyFor(target, { kind: storeKind, orgId, workspaceId: row.workspace_id, digest, basename, contentId: row.id, rev: tag });

  // Dedupe: these bytes already on the target for another row of this org?
  if (knownDigest && pid) {
    const dup = locations.findByDigest(pid, knownDigest, storeKind, orgId);
    if (dup) {
      insertLocation(row.id, storeKind, pid, dup.object_key, 'replica', knownDigest, sourceOrder[0].size || null, 1, historyLoc ? historyLoc.ref : null);
      return 'copied';
    }
  }
  if (!pid && fs.existsSync(path.join(config.contentDir, basename)) && knownDigest) {
    const have = await require('../content-digest').digestFile(path.join(config.contentDir, basename));
    if (have === knownDigest) { insertLocation(row.id, storeKind, null, basename, 'replica', knownDigest, fs.statSync(path.join(config.contentDir, basename)).size, 1, historyLoc ? historyLoc.ref : null); return 'copied'; }
  }

  if (knownDigest) {
    // Stream straight across, hashing in flight; verify the hash and the size afterwards.
    const out = await locations.openForRead(row, kind, { locations: sourceOrder });
    const key = keyOf(knownDigest);
    const hash = crypto.createHash('sha256');
    let size = 0;
    // A Transform, not a 'data' listener on a PassThrough: a listener switches the stream to
    // flowing mode before the SDK has attached, and the first chunks would go to nobody.
    const tee = new Transform({ transform(c, _e, cb) { hash.update(c); size += c.length; cb(null, c); } });
    out.stream.on('error', (e) => tee.destroy(e));
    out.stream.pipe(tee);
    await be.put(key, tee, { contentType: locations.contentTypeFor(storeKind === 'history' ? 'asset' : kind, row.mime_type), contentLength: out.size, sha256: knownDigest });
    const got = hash.digest('hex');
    if (got !== knownDigest) {
      try { await be.delete(key); } catch (_) {}
      throw new StorageError('precondition', 'The copied bytes did not match the recorded digest.', { key });
    }
    const h = await be.head(key);
    if (!h || (h.size != null && out.size != null && h.size !== out.size)) throw new StorageError('precondition', 'The copy could not be verified on the target.', { key });
    insertLocation(row.id, storeKind, pid, key, 'replica', got, size, 1, historyLoc ? historyLoc.ref : null);
    return 'copied';
  }

  // No recorded digest: the key needs one, so land it in a temp file first, then store the hash too.
  const tmpDir = path.join(config.uploadsDir, 'storage-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}.part`);
  try {
    const { digest, size } = await locations.downloadTo(row, kind, tmp, { locations: sourceOrder });
    const key = keyOf(digest);
    if (pid) await be.putFile(key, tmp, { contentType: locations.contentTypeFor(storeKind === 'history' ? 'asset' : kind, row.mime_type), sha256: digest });
    else if (!fs.existsSync(path.join(config.contentDir, key))) await be.putFile(key, tmp, { move: true });
    insertLocation(row.id, storeKind, pid, key, 'replica', digest, size, 1, historyLoc ? historyLoc.ref : null);
    if (storeKind === 'asset' && !row.byte_digest) db.prepare('UPDATE content SET byte_digest = ? WHERE id = ? AND byte_digest IS NULL').run(digest, row.id);
    return 'copied';
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

/** One row: the asset must verify; thumbnail, subtitle and retained history are best-effort. */
async function copyRow(row, target, orgId) {
  const asset = await copyKind(row, 'asset', target, orgId);
  if (asset === 'none') return { outcome: 'present' };
  for (const kind of ['thumb', 'subtitle']) {
    if (locations.effectiveKind(row, kind) !== kind) continue;
    try { await copyKind(row, kind, target, orgId); }
    catch (e) { console.warn(`[storage] content=${row.id} ${kind} copy failed (asset kept): ${(e && e.code) || 'error'}`); }
  }
  const pid = target.provider === 'local' ? null : target.id;
  if (pid) {
    for (const h of db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'history' AND state = 'ready'").all(row.id)) {
      if ((h.storage_profile_id || null) === pid) continue;
      if (db.prepare("SELECT 1 FROM content_locations WHERE content_id = ? AND kind = 'history' AND ref = ? AND storage_profile_id IS ?").get(row.id, h.ref, pid)) continue;
      try { await copyKind(row, 'history', target, orgId, { historyLoc: h }); }
      catch (e) { console.warn(`[storage] content=${row.id} history copy failed: ${(e && e.code) || 'error'}`); }
    }
  }
  return { outcome: asset === 'present' ? 'present' : 'copied' };
}

/* ───────────────────────────── commit / abort / drain ───────────────────────────── */

function requireMigration(orgId, targetId, states) {
  const m = latestFor(orgId);
  if (!m || (targetId && m.target_profile_id !== storage.outId(storage.normId(targetId))) || !states.includes(m.state)) {
    const e = new StorageRefusedError(`No ${states.join(' or ')} migration to that profile.`); e.status = 409; throw e;
  }
  return m;
}

/*
 * The flip. Per row and kind: a ready copy on the target becomes primary, every other primary
 * becomes draining. A row whose copy failed keeps its old primary — it is reported, never left
 * without a primary.
 */
function commit(orgId, targetId) {
  const m = requireMigration(orgId, targetId, ['ready_to_commit']);
  const pid = storage.normId(m.target_profile_id);
  let flipped = 0, notCopied = 0;
  db.transaction(() => {
    const rows = scopeIds(m);
    for (const { id } of rows) {
      let any = false;
      for (const kind of ['asset', 'thumb', 'subtitle']) {
        const target = db.prepare("SELECT id FROM content_locations WHERE content_id = ? AND kind = ? AND storage_profile_id IS ? AND state = 'ready' LIMIT 1").get(id, kind, pid);
        if (!target) continue;
        db.prepare("UPDATE content_locations SET role = 'draining' WHERE content_id = ? AND kind = ? AND role = 'primary' AND id != ?").run(id, kind, target.id);
        db.prepare("UPDATE content_locations SET role = 'primary' WHERE id = ?").run(target.id);
        if (kind === 'asset') {
          const k = db.prepare('SELECT object_key FROM content_locations WHERE id = ?').get(target.id);
          db.prepare('UPDATE content SET storage_profile_id = ?, object_key = ? WHERE id = ?').run(pid, pid ? k.object_key : null, id);
          any = true;
        }
      }
      // Retained revision copies: once the target holds a ref, the other copies of it may drain.
      for (const h of db.prepare("SELECT ref FROM content_locations WHERE content_id = ? AND kind = 'history' AND storage_profile_id IS ? AND state = 'ready'").all(id, pid)) {
        db.prepare("UPDATE content_locations SET role = 'draining' WHERE content_id = ? AND kind = 'history' AND ref = ? AND storage_profile_id IS NOT ?").run(id, h.ref, pid);
      }
      if (any) flipped++;
      else if (db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? LIMIT 1').get(id)) notCopied++;
    }
    // 'local' is stored as 'local' (local disk even if the instance default is a bucket); the env
    // profile as NULL, which is what "follow the instance default" means. A workspace move pins the
    // workspace's own override instead — that is what makes it stay put on the next org-wide move.
    if (m.workspace_id) db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(m.target_profile_id === storage.ENV_ID ? null : m.target_profile_id, m.workspace_id);
    else db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(m.target_profile_id === storage.ENV_ID ? null : m.target_profile_id, orgId);
    touch(m.id, { state: 'committed', committed_at: Math.floor(Date.now() / 1000) });
  })();
  return { ...get(m.id), flipped, not_copied: notCopied };
}

function abort(orgId, targetId) {
  const m = requireMigration(orgId, targetId, ['copying', 'ready_to_commit', 'committed', 'draining']);
  const ctl = running.get(m.id);
  if (ctl) ctl.stop = true;
  const pid = storage.normId(m.target_profile_id);
  /*
   * Primary goes back to a non-target copy wherever one is still ready: the draining one after a
   * commit, or — for a file uploaded during the copy, which was dual-written with the target as
   * primary — its replica on the previous primary. A row with no other copy left (drained, or a
   * dual-write that failed) keeps the target as primary: abort never leaves a row without one.
   * Nothing is deleted; copies on the target stay as replicas.
   */
  db.transaction(() => {
    const rows = scopeIds(m);
    for (const { id } of rows) {
      for (const kind of ['asset', 'thumb', 'subtitle']) {
        const onTarget = db.prepare("SELECT id FROM content_locations WHERE content_id = ? AND kind = ? AND role = 'primary' AND storage_profile_id IS ?").get(id, kind, pid);
        if (!onTarget) continue;
        const back = db.prepare(`SELECT id, storage_profile_id, object_key FROM content_locations
                                  WHERE content_id = ? AND kind = ? AND state = 'ready' AND storage_profile_id IS NOT ?
                                  ORDER BY CASE role WHEN 'draining' THEN 0 ELSE 1 END, id LIMIT 1`).get(id, kind, pid);
        if (!back) continue;
        db.prepare("UPDATE content_locations SET role = 'replica' WHERE id = ?").run(onTarget.id);
        db.prepare("UPDATE content_locations SET role = 'primary' WHERE id = ?").run(back.id);
        if (kind === 'asset') db.prepare('UPDATE content SET storage_profile_id = ?, object_key = ? WHERE id = ?').run(back.storage_profile_id, back.storage_profile_id ? back.object_key : null, id);
      }
      // History copies the commit had marked draining are ordinary replicas again.
      db.prepare("UPDATE content_locations SET role = 'replica' WHERE content_id = ? AND kind = 'history' AND role = 'draining'").run(id);
    }
    if (m.state === 'committed' || m.state === 'draining') {
      if (m.workspace_id) db.prepare('UPDATE workspaces SET storage_profile_id = ? WHERE id = ?').run(m.previous_profile_id || null, m.workspace_id);
      else db.prepare('UPDATE organizations SET storage_profile_id = ? WHERE id = ?').run(m.previous_profile_id || null, orgId);
    }
    touch(m.id, { state: 'aborted' });
  })();
  return get(m.id);
}

/*
 * Delete the org's DRAINING copies that are safe to delete:
 *   - the row has a ready primary of that kind somewhere else (never the last good copy)
 *   - ScreenTinker wrote it (owned = 1) — a reference import is never drained
 *   - no other location row still names the same (profile, key) as anything but draining
 * Local draining copies are unlinked only when no other row still needs the basename locally.
 */
async function drain(orgId, { migrationId = null } = {}) {
  const m = migrationId ? get(migrationId) : latestFor(orgId);
  // Drain within the latest migration's scope; with no migration at all, the whole organization
  // (a draining copy is only ever created by a commit, so that set is what some commit left).
  const q = m ? scopeSql(m) : { join: 'JOIN workspaces w ON w.id = c.workspace_id', where: 'w.organization_id = ?', args: [orgId] };
  const rows = db.prepare(`SELECT l.* FROM content_locations l JOIN content c ON c.id = l.content_id ${q.join}
                            WHERE ${q.where} AND l.role = 'draining'`).all(...q.args);
  const out = { deleted: 0, kept_referenced: 0, kept_not_owned: 0, kept_no_primary: 0, errors: 0 };
  if (m && m.state === 'committed') touch(m.id, { state: 'draining' });
  for (const l of rows) {
    const primary = l.kind === 'history'
      ? db.prepare("SELECT 1 FROM content_locations WHERE content_id = ? AND kind = 'history' AND ref = ? AND role != 'draining' AND state = 'ready' AND id != ? LIMIT 1").get(l.content_id, l.ref, l.id)
      : db.prepare("SELECT 1 FROM content_locations WHERE content_id = ? AND kind = ? AND role = 'primary' AND state = 'ready' AND id != ? LIMIT 1").get(l.content_id, l.kind, l.id);
    if (!primary) { out.kept_no_primary++; continue; }
    if (!l.owned) { out.kept_not_owned++; continue; }
    const shared = db.prepare("SELECT 1 FROM content_locations WHERE storage_profile_id IS ? AND object_key = ? AND id != ? AND role != 'draining' AND state = 'ready' LIMIT 1").get(l.storage_profile_id, l.object_key, l.id);
    db.prepare('DELETE FROM content_locations WHERE id = ?').run(l.id);
    if (shared) { out.kept_referenced++; continue; }
    if (db.prepare('SELECT 1 FROM content_locations WHERE storage_profile_id IS ? AND object_key = ? LIMIT 1').get(l.storage_profile_id, l.object_key)) { out.kept_referenced++; continue; }
    try {
      if (!l.storage_profile_id) {
        if (locations.localStillNeeded(l.object_key, null)) { out.kept_referenced++; continue; }
        await storage.backendFor(storage.LOCAL_PROFILE).delete(l.object_key);
      } else {
        const p = storage.getProfile(l.storage_profile_id);
        if (!p) { out.errors++; continue; }
        await storage.backendFor(p).delete(l.object_key);
      }
      out.deleted++;
    } catch (e) {
      out.errors++;
      console.warn(e instanceof StorageError ? e.logLine() : `[storage] drain delete failed: ${e && e.code}`);
    }
  }
  if (m && (m.state === 'committed' || m.state === 'draining')) {
    const left = db.prepare(`SELECT COUNT(*) AS n FROM content_locations l JOIN content c ON c.id = l.content_id ${q.join}
                              WHERE ${q.where} AND l.role = 'draining'`).get(...q.args).n;
    touch(m.id, { state: left ? 'draining' : 'done' });
  }
  return out;
}

/* ───────────────────────────── boot + timers ───────────────────────────── */

let timer = null;
/** Resume copiers interrupted by a restart; drain on STORAGE_DRAIN_AFTER_HOURS if set. */
function startBackground() {
  if (timer) return;
  for (const m of db.prepare("SELECT id FROM storage_migrations WHERE state = 'copying'").all()) run(m.id);
  const tick = () => {
    const hours = Number(process.env.STORAGE_DRAIN_AFTER_HOURS || 0);
    if (hours > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
      for (const m of db.prepare("SELECT * FROM storage_migrations WHERE state IN ('committed','draining') AND committed_at < ?").all(cutoff)) {
        drain(m.org_id, { migrationId: m.id }).catch(() => {});
      }
    }
    probeOpenBreakers().catch(() => {});
  };
  timer = setInterval(tick, 30 * 1000);
  if (timer.unref) timer.unref();
}

/** The background half-open probe: a cooled breaker is tested here, not by a viewer's request. */
async function probeOpenBreakers() {
  const breaker = require('./breaker');
  for (const id of breaker.dueForProbe()) {
    if (!id) continue;
    const p = storage.getProfile(id);
    if (!p || !breaker.tryAcquire(id)) continue;
    try { await storage.rawBackend(p).probe(); breaker.success(id); }
    catch (e) { breaker.failure(id, e); }
  }
}

function stopAll() { for (const ctl of running.values()) ctl.stop = true; if (timer) { clearInterval(timer); timer = null; } }

/** Tests: wait for a migration's copier to finish its current run. */
async function _settle(id, { timeoutMs = 10000 } = {}) {
  const t0 = Date.now();
  while (running.has(id) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 10));
  return get(id);
}

module.exports = { start, commit, abort, drain, get, activeFor, latestFor, startBackground, stopAll, copyRow, probeOpenBreakers, ACTIVE, _settle };
