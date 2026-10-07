'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const config = require('../../config');
const { db } = require('../../db/database');
const storage = require('./index');
const breaker = require('./breaker');
const { StorageError } = require('./errors');

/*
 * ⚠️ A CONTENT ROW HAS A SET OF LOCATIONS, NOT A LOCATION.
 *
 * Every read — the URL in a playlist payload, the origin proxy, /uploads/content — walks the same
 * ordered list and uses the first copy that can serve. That is what makes a storage change a live
 * operation: during a migration the row has its old copy and its new one, both `ready`, and a
 * screen is served from whichever answers. Adding a location never removes one; removing one
 * (drain) is a separate, explicit step that refuses to remove the last good copy.
 *
 * ⚠️ NO ROWS MEANS LOCAL. A content row with no content_locations of a kind has exactly one,
 * implicit: ready, primary, the basename of the matching column under contentDir. That is how every
 * row written before this layer existed keeps working with zero backfill, and it is why the rows a
 * migration touches first get an EXPLICIT local location before anything is flipped.
 *
 * Read order (orderForRead):
 *   1. primary + ready, unless its profile's breaker is open
 *   2. other ready copies (replica, then draining) by the profile's read_priority (lower first;
 *      local disk is 0 by default — the air-gap-friendly choice; STORAGE_LOCAL_READ_PRIORITY moves it)
 *   draining still counts: it means "do not WRITE here", not "do not read".
 *
 * ⚠️ THE PICKER NEVER WAITS FOR A STORE. Playlist payloads are built synchronously and pushed to
 * hundreds of screens; a health check per item would put a timeout per item in that path. It reads
 * DB state and the in-memory breaker only. The proxy (openForRead) is where requests actually go
 * out, and where failures feed the breaker.
 */

const KIND_COLUMN = { asset: 'filepath', thumb: 'thumbnail_path', subtitle: 'subtitle_url' };

/*
 * ⚠️ A DATABASE WITHOUT content_locations MEANS "EVERYTHING IS LOCAL", NOT AN ERROR. The table is
 * created by the boot migrations, but code paths that run against a partial schema (a restore in
 * progress, a test database built from schema.sql alone) must still delete and read content the
 * way they always did. Checked once per database handle.
 */
let locTableKnown = null;
function hasLocTable() {
  if (locTableKnown === true) return true;
  try { locTableKnown = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_locations'").get(); }
  catch (_) { locTableKnown = false; }
  return locTableKnown;
}

function basenameOf(v) {
  if (!v || /^https?:\/\//i.test(String(v))) return null;
  return path.basename(String(v));
}

/** The kind whose locations serve this column of this row (an SVG is its own thumbnail). */
function effectiveKind(row, kind) {
  if (kind === 'thumb' && row && row.thumbnail_path && row.thumbnail_path === row.filepath) return 'asset';
  return kind;
}

const stmtLocs = () => db.prepare('SELECT * FROM content_locations WHERE content_id = ? AND kind = ? ORDER BY id');

/** All locations of one kind for a row, explicit or the implicit local one. */
function listLocations(row, kind = 'asset') {
  if (!row) return [];
  const k = effectiveKind(row, kind);
  const explicit = hasLocTable() ? stmtLocs().all(row.id, k) : [];
  if (explicit.length) return explicit;
  if (k === 'history') return [];
  const base = basenameOf(row[KIND_COLUMN[k]]);
  if (!base || (k === 'asset' && row.remote_url)) return [];
  return [{ id: null, content_id: row.id, kind: k, storage_profile_id: null, object_key: base, role: 'primary', state: 'ready', owned: 1, implicit: true }];
}

function hasExplicitLocations(contentId) {
  if (!hasLocTable()) return false;
  return !!db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? LIMIT 1').get(contentId);
}

function priorityOf(loc, profileCache) {
  const p = profileFor(loc, profileCache);
  return p ? Number(p.read_priority || 0) : Number.MAX_SAFE_INTEGER;
}

function profileFor(loc, cache) {
  const id = loc.storage_profile_id || null;
  const k = id || 'local';
  if (cache && cache.has(k)) return cache.get(k);
  const p = storage.getProfile(id);
  if (cache) cache.set(k, p);
  return p;
}

/** Ready locations in read order. Breaker-open profiles go last (still listed, for the view). */
function orderForRead(locs, { profileCache = new Map() } = {}) {
  const roleRank = { primary: 0, replica: 1, draining: 2 };
  return locs
    .filter((l) => l.state === 'ready')
    .map((l) => ({ l, open: l.storage_profile_id ? breaker.isOpen(l.storage_profile_id) : false, pr: priorityOf(l, profileCache) }))
    .sort((a, b) => (a.open - b.open)
      || ((a.l.role === 'primary' ? 0 : 1) - (b.l.role === 'primary' ? 0 : 1))
      || (a.pr - b.pr)
      || (roleRank[a.l.role] - roleRank[b.l.role]))
    .map((x) => x.l);
}

const localBackend = () => storage.backendFor(storage.LOCAL_PROFILE);

function localExists(key) {
  try { return localBackend().existsSync(key); } catch (_) { return false; }
}

/* ───────────────────────────── player URLs ───────────────────────────── */

/** May this screen fetch a bucket URL directly? device flag, else workspace flag, else yes. */
function directFetchAllowed(device) {
  if (device && device.storage_direct_fetch != null) return Number(device.storage_direct_fetch) === 1;
  const wsId = device && device.workspace_id;
  if (wsId) {
    const w = db.prepare('SELECT storage_direct_fetch FROM workspaces WHERE id = ?').get(wsId);
    if (w && w.storage_direct_fetch != null) return Number(w.storage_direct_fetch) === 1;
  }
  return true;
}

/*
 * ⚠️ PRESIGNED URLS ARE STABLE FOR A WINDOW, NOT PER CALL. The payload is rebuilt on every push and
 * every reconnect; a URL whose signature changed each time would look like a new file to any cache
 * keyed by URL. So the signing time is floored to a window of TTL/3 and the expiry stretched by that
 * window — every URL handed out is valid for at least the configured TTL, and identical for every
 * build inside the window. Ceiling 1 h, floor 60 s (storage.presignTtl).
 */
function presignStable(be, key, { ttlSec, contentType = null, filename = null, nowMs = Date.now() } = {}) {
  const ttl = storage.presignTtl(ttlSec);
  const windowSec = Math.max(60, Math.floor(ttl / 3));
  const signAt = Math.floor(nowMs / 1000 / windowSec) * windowSec;
  const expires = Math.min(3600, ttl + windowSec);
  return be.presignGet(key, { expiresSec: expires, contentType, filename, now: new Date(signAt * 1000) });
}

function originUrl(row, kind) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/content/${encodeURIComponent(row.id)}/${kind === 'thumb' ? 'thumbnail' : 'file'}`;
}

/**
 * Which copy a SCREEN should be pointed at, and the URL for it. Synchronous by design.
 * Returns { loc, url, via: 'local'|'presign'|'proxy', tried } or null when nothing is readable.
 *
 * via 'local' — url is null: the player keeps building /uploads/content/<basename> as it always has.
 * via 'presign' — url is a bucket URL the screen fetches directly.
 * via 'proxy' — url is this server's /api/content/:id/file (absolute when APP_URL is set, else null:
 *               the relative /uploads/content/<basename> the player already uses is served by the
 *               same proxy). The screen never receives a list of buckets; failover is server-side.
 */
function pickForPlayer(row, kind = 'asset', { device = null, nowMs } = {}) {
  const tried = [];
  const cache = new Map();
  const ordered = orderForRead(listLocations(row, kind), { profileCache: cache });
  const direct = directFetchAllowed(device);
  // The first copy the SERVER can read, used for the proxy when no copy is directly fetchable.
  // A later local or presignable copy still wins over proxying an earlier one: both are what the
  // operator's order allows, and they cost this server less.
  let serverReadable = null;
  for (const loc of ordered) {
    const p = profileFor(loc, cache);
    if (!p) { tried.push({ loc: loc.id, skip: 'no profile' }); continue; }
    if (!loc.storage_profile_id) {
      if (localExists(loc.object_key)) return { loc, url: null, via: 'local', tried };
      tried.push({ loc: loc.id, skip: 'local file missing' });
      continue;
    }
    if (breaker.isOpen(loc.storage_profile_id)) { tried.push({ loc: loc.id, skip: 'breaker open' }); continue; }
    if (direct) {
      let url = null;
      try { url = presignStable(storage.backendFor(p), loc.object_key, { nowMs }); } catch (_) { url = null; }
      if (url) return { loc, url, via: 'presign', tried };
    }
    if (!serverReadable) serverReadable = loc;
  }
  if (serverReadable) return { loc: serverReadable, url: originUrl(row, kind), via: 'proxy', tried };
  return null;
}

/* ───────────────────────────── server-side reads ───────────────────────────── */

function noteError(loc, err) {
  if (!loc || !loc.id) return;
  try {
    db.prepare(`UPDATE content_locations SET last_error = ?, last_error_at = CAST(strftime('%s','now') AS INTEGER)
                 ${err && err.code === 'not_found' ? ", state = 'error'" : ''}
                 WHERE id = ? AND (last_error_at IS NULL OR last_error_at < CAST(strftime('%s','now') AS INTEGER) - 60 OR ? = 'not_found')`)
      .run(String((err && err.code) || 'unknown').slice(0, 40), loc.id, err && err.code);
  } catch (_) { /* bookkeeping must never fail a read */ }
}

/**
 * Open a stream on the first copy that answers. Skips a profile whose breaker is open (unless this
 * call is the half-open probe). Throws StorageError('not_found') listing what was tried when every
 * copy fails — the caller answers the same 404 a player already handles.
 */
async function openForRead(row, kind = 'asset', { range = null, locations = null } = {}) {
  const tried = [];
  const cache = new Map();
  const ordered = locations || orderForRead(listLocations(row, kind), { profileCache: cache });
  for (const loc of ordered) {
    const p = profileFor(loc, cache);
    if (!p) { tried.push(`${loc.storage_profile_id}:no-profile`); continue; }
    if (loc.storage_profile_id && !breaker.tryAcquire(loc.storage_profile_id)) { tried.push(`${loc.storage_profile_id}:breaker-open`); continue; }
    try {
      const out = await storage.backendFor(p).getStream(loc.object_key, { range });
      return { ...out, loc, profile: p, tried };
    } catch (e) {
      if (e && e.code === 'range') throw e;
      tried.push(`${storage.outId(loc.storage_profile_id)}:${(e && e.code) || 'error'}`);
      if (e instanceof StorageError) console.warn(e.logLine());
      noteError(loc, e);
    }
  }
  const err = new StorageError('not_found', 'No stored copy of this file could be read.', { key: row && row.id });
  err.tried = tried;
  console.warn(`[storage] content=${row && row.id} kind=${kind} unreadable; tried ${tried.join(', ') || 'nothing'}`);
  throw err;
}

/* ───────────────────────────── writes: placing new bytes ───────────────────────────── */

function contentTypeFor(kind, mime) {
  if (kind === 'thumb') return 'image/jpeg';
  if (kind === 'subtitle') return 'text/vtt';
  return mime || 'application/octet-stream';
}

/** The key a file of this kind gets on this profile. Local keeps the basename scheme. */
function keyFor(profile, { kind, orgId, workspaceId, digest, basename, contentId, rev }) {
  if (!profile || profile.provider === 'local') return path.basename(basename);
  if (kind === 'asset') return storage.keys.asset(orgId, workspaceId, digest, storage.extOf(basename));
  if (kind === 'thumb') return storage.keys.thumb(orgId, workspaceId, digest);
  if (kind === 'subtitle') return storage.keys.subtitle(orgId, workspaceId, digest, storage.extOf(basename));
  if (kind === 'history') return storage.keys.history(orgId, workspaceId, contentId, rev, digest, storage.extOf(basename));
  throw new StorageError('refused', 'Unknown location kind.');
}

async function sha256File(abs) { return require('../content-digest').digestFile(abs); }

/** An existing ready object with these bytes on this profile, in this org — so it is not uploaded twice. */
function findByDigest(profileId, digest, kind, orgId) {
  if (!profileId || !digest) return null;
  return db.prepare(`SELECT l.object_key FROM content_locations l
                       JOIN content c ON c.id = l.content_id
                       JOIN workspaces w ON w.id = c.workspace_id
                      WHERE l.storage_profile_id = ? AND l.byte_digest = ? AND l.kind = ? AND l.state = 'ready' AND l.owned = 1
                        AND w.organization_id IS ? LIMIT 1`).get(profileId, digest, kind, orgId || null) || null;
}

/**
 * Put a set of local files for ONE content row where the workspace writes, BEFORE the row is
 * inserted or changed. Returns a plan:
 *   plan.remote      false when the write target is local disk (then nothing was copied: the files
 *                    already sit in contentDir exactly as before this layer existed)
 *   plan.commit(id)  insert the location rows (call inside the row's transaction)
 *   plan.cleanup()   remove the local copies the bucket now holds (call AFTER the commit)
 *
 * ⚠️ THE ASSET PUT FAILING IS THE UPLOAD FAILING. It throws, nothing is inserted, and the caller
 * answers 502 with the StorageError's operator-safe message. A thumbnail or subtitle put failing is
 * not: that file stays on local disk as an explicit local location, still served.
 * ⚠️ The dual-write to the PREVIOUS primary during a migration is best-effort once the target put
 * has succeeded: logged, never a failed upload.
 */
async function placeFiles({ workspaceId, files, mime }) {
  const t = storage.writeTargetsForWorkspace(workspaceId);
  const primary = t.primary;
  const plan = { remote: primary.provider !== 'local', placed: [], localKeep: [], primary, cleanup: () => {}, commit: () => {} };
  if (!plan.remote && !t.dualWrite) return plan;   // byte-for-byte the pre-storage behaviour

  const orgId = t.orgId;
  for (const f of files) {
    if (!f || !f.abs) continue;
    const digest = f.digest || await sha256File(f.abs);
    const size = fs.statSync(f.abs).size;
    const targets = [{ profile: primary, role: 'primary', required: f.kind === 'asset' }];
    if (t.dualWrite) targets.push({ profile: t.dualWrite, role: 'replica', required: false });
    for (const tg of targets) {
      const isLocal = tg.profile.provider === 'local';
      let key = keyFor(tg.profile, { kind: f.kind, orgId, workspaceId, digest, basename: f.basename });
      const pid = isLocal ? null : tg.profile.id;
      try {
        if (!isLocal) {
          // The same bytes already stored for another row of this org (any workspace): point at that
          // object instead of storing a second copy. The refcount keeps it while either row needs it.
          // A HEAD first: a row saying "ready" is not proof the object survived an operator's cleanup.
          const be = storage.backendFor(tg.profile);
          const existing = digest ? findByDigest(pid, digest, f.kind, orgId) : null;
          const reusable = existing && await be.head(existing.object_key).then((h) => !!h && (h.size == null || h.size === size), () => false);
          if (reusable) key = existing.object_key;
          else await be.putFile(key, f.abs, { contentType: contentTypeFor(f.kind, mime), contentLength: size, sha256: digest });
        }
        // Local: the file is already in contentDir under its basename; that IS the local copy.
        plan.placed.push({ kind: f.kind, storage_profile_id: pid, object_key: key, role: tg.role, byte_digest: digest, size });
      } catch (e) {
        if (e instanceof StorageError) console.warn(e.logLine());
        if (tg.required) throw e;
        if (tg.role === 'primary') plan.localKeep.push({ kind: f.kind, basename: f.basename, byte_digest: digest, size });
        else console.warn(`[storage] dual-write of ${f.kind} to previous primary ${storage.outId(pid)} failed; upload kept`);
      }
    }
  }

  plan.commit = (contentId) => {
    const ins = db.prepare(`INSERT OR IGNORE INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, byte_digest, size, verified_at)
                            VALUES (?, ?, ?, ?, ?, 'ready', 1, ?, ?, CAST(strftime('%s','now') AS INTEGER))`);
    for (const p of plan.placed) ins.run(contentId, p.kind, p.storage_profile_id, p.object_key, p.role, p.byte_digest, p.size);
    for (const k of plan.localKeep) ins.run(contentId, k.kind, null, k.basename, 'primary', k.byte_digest, k.size);
    const a = plan.placed.find((p) => p.kind === 'asset' && p.role === 'primary');
    if (a) db.prepare('UPDATE content SET storage_profile_id = ?, object_key = ? WHERE id = ?').run(a.storage_profile_id, a.object_key, contentId);
  };
  plan.cleanup = () => {
    if (!plan.remote) return;
    // Only files whose primary copy is now remote; a local dual-write copy or a kept thumbnail stays.
    const localPlaced = new Set(plan.placed.filter((p) => !p.storage_profile_id).map((p) => p.kind));
    const kept = new Set(plan.localKeep.map((k) => k.kind));
    for (const f of files) {
      if (!f || !f.abs || localPlaced.has(f.kind) || kept.has(f.kind)) continue;
      if (!plan.placed.some((p) => p.kind === f.kind && p.role === 'primary')) continue;
      if (localStillNeeded(path.basename(f.abs), null)) continue;
      try { fs.unlinkSync(f.abs); } catch (_) { /* already gone */ }
    }
  };
  return plan;
}

/*
 * Is a local basename still needed by ANY row other than `exceptContentId`? A row needs it locally
 * when it has an explicit local location with that key, or has no explicit location of the kind
 * whose column names it (the implicit "local, as today").
 */
function localStillNeeded(base, exceptContentId) {
  const ex = exceptContentId || '';
  if (db.prepare("SELECT 1 FROM content_locations WHERE storage_profile_id IS NULL AND object_key = ? AND content_id != ? AND state != 'error' LIMIT 1").get(base, ex)) return true;
  for (const [kind, col] of Object.entries(KIND_COLUMN)) {
    const rows = db.prepare(`SELECT id FROM content WHERE id != ? AND (${col} = ? OR ${col} LIKE ?)`).all(ex, base, `%/${base}`);
    for (const r of rows) {
      if (!db.prepare('SELECT 1 FROM content_locations WHERE content_id = ? AND kind = ? LIMIT 1').get(r.id, kind)) return true;
    }
  }
  return false;
}

/**
 * Move a row's LIVE local files to where its workspace writes, after a writer that only knows how
 * to write locally (mesh receive, backup import, a released draft, a subtitle) has finished.
 * No-op when the workspace writes to local disk. Never throws: on failure the row simply stays on
 * local disk, which is where it already worked.
 */
async function settleRow(contentId, { kinds = ['asset', 'thumb', 'subtitle'] } = {}) {
  try {
    const row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
    if (!row || !row.workspace_id) return { settled: false };
    const t = storage.writeTargetsForWorkspace(row.workspace_id);
    if (t.primary.provider === 'local' && !t.dualWrite) return { settled: false, reason: 'local' };
    const files = [];
    // Only the kinds the caller just wrote: settling a new subtitle must not re-home an asset that
    // was deliberately left where it was ("changing the org profile does not move existing rows").
    for (const kind of kinds) {
      const k = effectiveKind(row, kind);
      if (k !== kind) continue;
      const locs = listLocations(row, kind);
      // Only a row whose live copy of this kind is local and nowhere else.
      if (!locs.length || locs.some((l) => l.storage_profile_id)) continue;
      const loc = locs[0];
      const abs = path.join(config.contentDir, loc.object_key);
      if (!fs.existsSync(abs)) continue;
      files.push({ kind, abs, basename: loc.object_key, digest: kind === 'asset' ? row.byte_digest : null });
    }
    if (!files.length) return { settled: false, reason: 'nothing local' };
    const plan = await placeFiles({ workspaceId: row.workspace_id, files, mime: row.mime_type });
    db.transaction(() => {
      // Any explicit local row for these files is replaced by what placeFiles recorded (which keeps
      // a local row only when the local copy really stays: a dual-write replica or a failed put).
      for (const f of files) db.prepare('DELETE FROM content_locations WHERE content_id = ? AND kind = ? AND storage_profile_id IS NULL AND object_key = ?').run(contentId, f.kind, f.basename);
      plan.commit(contentId);
    })();
    plan.cleanup();
    return { settled: true };
  } catch (e) {
    console.warn(`[storage] content=${contentId} could not be moved to its workspace's storage; kept on local disk (${(e && e.code) || (e && e.message)})`);
    return { settled: false, reason: 'error' };
  }
}

/** Fire-and-forget settle, for synchronous writers. */
function settleSoon(contentId, opts) {
  setImmediate(() => { settleRow(contentId, opts).catch(() => {}); });
}

/* ───────────────────────────── deletes: refcounted ───────────────────────────── */

/** Snapshot of a row's explicit locations, taken BEFORE its rows are deleted. */
function locationsOf(contentId) {
  if (!hasLocTable()) return [];
  return db.prepare('SELECT * FROM content_locations WHERE content_id = ?').all(contentId);
}

function deleteLocationRows(contentId) {
  if (!hasLocTable()) return;
  db.prepare('DELETE FROM content_locations WHERE content_id = ?').run(contentId);
}

/*
 * ⚠️ THE REFCOUNT RULE MOVES WITH THE BYTES. Mesh content and deduplicated uploads mean one object
 * can back one row per workspace. An object is deleted only when NO remaining location row — any
 * content, any workspace, any kind — still names that (profile, key), and only when ScreenTinker
 * wrote it (owned = 1). A reference import is never deleted by anything here.
 *
 * Call AFTER the rows' deletion has committed, so the count sees exactly the survivors. Remote
 * deletes are best-effort and logged, like the local unlink has always been. Local copies are left
 * to lib/content-files.unlinkIfUnreferenced, which the delete paths already call.
 */
async function releaseObjects(locs) {
  let deleted = 0;
  for (const l of locs || []) {
    if (!l || !l.storage_profile_id || !l.owned) continue;
    const others = db.prepare('SELECT COUNT(*) AS n FROM content_locations WHERE storage_profile_id = ? AND object_key = ?').get(l.storage_profile_id, l.object_key).n;
    if (others > 0) continue;
    const p = storage.getProfile(l.storage_profile_id);
    if (!p) continue;
    try { await storage.backendFor(p).delete(l.object_key); deleted++; }
    catch (e) { console.warn(e instanceof StorageError ? e.logLine() : `[storage] delete failed: ${e && e.code}`); }
  }
  return { deleted };
}

/*
 * Release objects once the CURRENT synchronous transaction has finished. Safe even if it rolled
 * back: the refcount in releaseObjects then finds the restored location rows and deletes nothing.
 */
function queueRelease(locs) {
  if (!locs || !locs.some((l) => l.storage_profile_id)) return;
  setImmediate(() => { releaseObjects(locs).catch(() => {}); });
}

/** Delete the location rows of rows already gone, then their unreferenced objects. */
function releaseDeletedContent(contentIds) {
  const locs = [];
  for (const id of contentIds || []) { locs.push(...locationsOf(id)); deleteLocationRows(id); }
  queueRelease(locs);
  return locs.length;
}

/* ───────────────────────────── revision history ───────────────────────────── */

const HISTORY_REF_PREFIX = '@storage/';
const isStorageRef = (ref) => String(ref || '').startsWith(HISTORY_REF_PREFIX);

/*
 * Keep a REMOTE live file as a revision's retained copy. lib/revisions.retainContentFile moves a
 * local file into .history; the equivalent for an object is to keep it where it is and re-label its
 * location rows `history` under a ref the revision can name. No bytes move and nothing is copied —
 * the object stays referenced, so the refcount keeps it, until retention lets the ref go.
 * Returns the ref, or null when this kind has no remote copy (local handling applies).
 */
function retainRemote(contentId, kind, tag, relPath) {
  const locs = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = ? AND storage_profile_id IS NOT NULL AND state = 'ready'").all(contentId, kind);
  if (!locs.length) return null;
  const ref = `${HISTORY_REF_PREFIX}${contentId}/${tag}/${kind}/${path.basename(String(relPath || 'file'))}`;
  const localCopies = db.prepare('SELECT * FROM content_locations WHERE content_id = ? AND kind = ? AND storage_profile_id IS NULL').all(contentId, kind);
  db.transaction(() => {
    for (const l of locs) {
      db.prepare("UPDATE content_locations SET kind = 'history', role = 'replica', ref = ? WHERE id = ?").run(ref, l.id);
    }
    // A local copy of the same bytes (a dual-write replica) is not kept as history: the remote copy
    // is the retained one. Its row goes, and its file unless another row still needs it locally.
    for (const l of localCopies) db.prepare('DELETE FROM content_locations WHERE id = ?').run(l.id);
  })();
  for (const l of localCopies) {
    if (!localStillNeeded(l.object_key, null)) { try { fs.unlinkSync(path.join(config.contentDir, path.basename(l.object_key))); } catch (_) { /* already gone */ } }
  }
  return ref;
}

function historyLocations(ref) {
  if (!isStorageRef(ref)) return [];
  const contentId = String(ref).slice(HISTORY_REF_PREFIX.length).split('/')[0];
  return db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'history' AND ref = ? AND state = 'ready'").all(contentId, ref);
}

function refExists(ref) { return historyLocations(ref).length > 0; }

/** Drop every history location of these refs' content that no revision names any more. */
function pruneHistoryLocations(namedRefs) {
  const rows = db.prepare("SELECT * FROM content_locations WHERE kind = 'history'").all();
  const gone = rows.filter((l) => !namedRefs.has(l.ref));
  if (!gone.length) return 0;
  db.transaction(() => { for (const l of gone) db.prepare('DELETE FROM content_locations WHERE id = ?').run(l.id); })();
  releaseObjects(gone).catch(() => {});
  return gone.length;
}

/* ───────────────────────────── local materialisation ───────────────────────────── */

/*
 * Some readers genuinely need a FILE: the bundle inliner reads a zip's central directory, ffprobe
 * reads a path, the export archiver adds paths. For a row whose bytes are only in a bucket, this
 * fetches them once into uploads/storage-cache/ (NOT contentDir — that is publicly served and
 * would turn every cached object into a second, unrefcounted copy) and returns the path.
 * Returns the contentDir path directly when the local copy exists.
 */
function cacheDir() { return path.join(config.uploadsDir, 'storage-cache'); }
const CACHE_MAX_BYTES = () => Math.max(64, Number(process.env.STORAGE_CACHE_MAX_MB || 2048)) * 1024 * 1024;

async function ensureLocalFile(row, kind = 'asset') {
  const locs = orderForRead(listLocations(row, kind));
  const local = locs.find((l) => !l.storage_profile_id && localExists(l.object_key));
  if (local) return path.join(config.contentDir, local.object_key);
  if (!locs.length) return null;
  const base = basenameOf(row[KIND_COLUMN[effectiveKind(row, kind)]]) || `${row.id}.bin`;
  const dest = path.join(cacheDir(), `${row.id}-${kind}-${base}`);
  if (fs.existsSync(dest)) { const t = new Date(); try { fs.utimesSync(dest, t, t); } catch (_) {} return dest; }
  fs.mkdirSync(cacheDir(), { recursive: true });
  const out = await openForRead(row, kind, { locations: locs });
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    await pipeline(out.stream, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  trimCache();
  return dest;
}

function trimCache() {
  try {
    const dir = cacheDir();
    const files = fs.readdirSync(dir).filter((n) => !n.endsWith('.part')).map((n) => { const st = fs.statSync(path.join(dir, n)); return { n, size: st.size, t: st.mtimeMs }; });
    let total = files.reduce((s, f) => s + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES()) break;
      try { fs.unlinkSync(path.join(dir, f.n)); total -= f.size; } catch (_) {}
    }
  } catch (_) { /* best effort */ }
}

/** Stream a copy into a local file while hashing it. Returns { digest, size }. */
async function downloadTo(row, kind, dest, { maxBytes = Infinity, locations = null } = {}) {
  const out = await openForRead(row, kind, { locations });
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(Object.assign(new Error('too large'), { code: 'too_large' }));
      hash.update(chunk); cb(null, chunk);
    },
  });
  await pipeline(out.stream, meter, fs.createWriteStream(dest));
  return { digest: hash.digest('hex'), size, loc: out.loc };
}

/* ───────────────────────────── the operator's view ───────────────────────────── */

function describe(row) {
  const out = { content_id: row.id, kinds: {} };
  for (const kind of ['asset', 'thumb', 'subtitle']) {
    const locs = listLocations(row, kind);
    if (!locs.length) continue;
    const cache = new Map();
    const ordered = orderForRead(locs, { profileCache: cache });
    const pick = pickForPlayer(row, kind);
    out.kinds[kind] = locs.map((l) => {
      const p = profileFor(l, cache);
      return {
        id: l.id, implicit: !!l.implicit,
        profile_id: storage.outId(l.storage_profile_id), profile_name: p ? p.name : '(deleted profile)', provider: p ? p.provider : null,
        object_key: l.object_key, role: l.role, state: l.state, owned: !!l.owned,
        size: l.size != null ? l.size : null, verified_at: l.verified_at || null,
        last_error: l.last_error || null, last_error_at: l.last_error_at || null,
        breaker: l.storage_profile_id ? breaker.snapshot(l.storage_profile_id) : { open: false },
        local_file_present: l.storage_profile_id ? null : localExists(l.object_key),
        read_rank: ordered.indexOf(l) >= 0 ? ordered.indexOf(l) + 1 : null,
        would_serve: !!(pick && pick.loc && ((pick.loc.id && pick.loc.id === l.id) || (pick.loc.implicit && l.implicit))),
      };
    });
    if (pick) out[`${kind}_served_via`] = pick.via;
  }
  return out;
}

module.exports = {
  listLocations, orderForRead, pickForPlayer, openForRead, presignStable, directFetchAllowed, effectiveKind,
  placeFiles, settleRow, settleSoon, keyFor, findByDigest, localStillNeeded, contentTypeFor,
  locationsOf, deleteLocationRows, releaseObjects, queueRelease, releaseDeletedContent, hasExplicitLocations,
  retainRemote, historyLocations, refExists, isStorageRef, pruneHistoryLocations, HISTORY_REF_PREFIX,
  ensureLocalFile, downloadTo, describe, KIND_COLUMN, basenameOf,
};
