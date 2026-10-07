'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { db } = require('../../db/database');
const storage = require('./index');
const locations = require('./locations');
const { checkEndpoint } = require('./endpoint-guard');
const { StorageError, StorageRefusedError } = require('./errors');
const { sniffMime, MIME_TO_EXT, SNIFF_BYTES } = require('../upload-sniff');

/*
 * BUCKET ATTACH / EXTRACT: point at a bucket the operator already has, list it, and bring chosen
 * objects in as content rows.
 *
 *   reference  the row points at the existing key. ScreenTinker never rewrites, moves or deletes
 *              that object: its location is owned = 0, the write guard refuses anything outside
 *              st/ on a profile whose scope is 'st', and refuses everything on one whose scope is
 *              'none' (the default for a read-only profile). Nothing is downloaded to import it —
 *              a HEAD for the size and a 4 KiB ranged GET to sniff the type — and the thumbnail is
 *              made afterwards, in the background.
 *   copy       the bytes are pulled into the workspace's own storage through the ordinary ingest
 *              path (sniff, bundle validation, ffprobe, thumbnail, digest), so a copied object is
 *              indistinguishable from an upload.
 */

const REF_ACCEPT = new Set(Object.keys(MIME_TO_EXT).filter((m) => m !== 'application/zip'));
const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m]));
EXT_TO_MIME['.jpeg'] = 'image/jpeg';
EXT_TO_MIME['.m4v'] = 'video/mp4';

/** The endpoint this profile actually connects to, for the SSRF check. */
function endpointOf(profile) {
  if (profile.provider === 's3') return profile.endpoint || null;
  if (profile.provider === 'azure') return storage.rawBackend(profile).endpointUrl() || null;
  return null;
}

/** Vet the endpoint (SSRF) before any request; null endpoint = the provider's public default. */
async function vetProfileEndpoint(profile) {
  const ep = endpointOf(profile);
  if (ep) await checkEndpoint(ep, { allowPrivate: !!profile.allow_private });
  if (profile.public_endpoint) {
    // Only parsed, never connected to by this server, but it is still a URL we will hand to screens.
    require('./endpoint-guard').parseEndpoint(profile.public_endpoint);
  }
}

/*
 * Test connection. Distinguishes the three things an operator needs to fix differently:
 *   ssrf     the endpoint is not allowed (metadata / link-local / private without opt-in)
 *   auth     credentials rejected
 *   no_bucket  bucket/container missing
 *   network  could not reach it
 * Never echoes a secret: StorageError messages are fixed sentences.
 */
async function testConnection(profile) {
  if (profile.provider === 'local') return { ok: true, code: 'ok', message: 'Local disk is always available.' };
  if (profile.credentials_unreadable) return { ok: false, code: 'auth', message: 'The stored credentials could not be decrypted — the server\'s JWT secret changed. Re-enter them.' };
  try { await vetProfileEndpoint(profile); }
  catch (e) { return { ok: false, code: 'ssrf', message: 'That storage endpoint is not allowed from this server.' }; }
  try {
    const be = storage.backendFor(profile);
    await be.probe();
    // A HEAD of a key that cannot exist proves read access by its 404, without listing anything.
    await be.head(`st/.screentinker-probe-${crypto.randomBytes(4).toString('hex')}`);
    return { ok: true, code: 'ok', message: 'Connected.' };
  } catch (e) {
    const err = e instanceof StorageError ? e : require('./errors').classify(e, { profileId: profile.id });
    console.warn(err.logLine());
    return { ok: false, code: err.code, message: err.message };
  }
}

/** One page of a prefix. Folders via the delimiter. Page size capped at 200. */
async function listObjects(profile, { prefix = '', cursor = null, limit = 200 } = {}) {
  const p = String(prefix || '');
  if (p) storage.assertSafeKey(p.replace(/\/$/, '') || 'x');
  await vetProfileEndpoint(profile);
  const out = await storage.backendFor(profile).list(p, { cursor: cursor || null, limit: Math.min(200, Math.max(1, Number(limit) || 200)), delimiter: '/' });
  return {
    prefix: p,
    folders: out.prefixes,
    objects: out.items.map((o) => ({ ...o, importable: !!guessMime(o.key), st_internal: /^st\//.test(o.key) })),
    cursor: out.cursor,
  };
}

function guessMime(key) { return EXT_TO_MIME[path.extname(String(key)).toLowerCase()] || null; }

async function sniffRemote(profile, key) {
  try {
    const out = await storage.backendFor(profile).getStream(key, { range: { start: 0, end: SNIFF_BYTES - 1 } });
    const chunks = [];
    let n = 0;
    for await (const c of out.stream) { chunks.push(c); n += c.length; if (n >= SNIFF_BYTES) break; }
    try { out.stream.destroy(); } catch (_) {}
    return sniffMime(Buffer.concat(chunks).subarray(0, SNIFF_BYTES));
  } catch (_) { return null; }
}

/**
 * Import keys into a workspace. Returns { imported: [rows], errors: [{key, error}] }.
 * reference: never put, never delete — only head + a ranged get.
 */
async function importKeys(profile, { keys, mode, workspaceId, userId, folderId = null }) {
  if (!Array.isArray(keys) || !keys.length) throw Object.assign(new StorageRefusedError('No keys to import.'), { status: 400 });
  if (keys.length > 200) throw Object.assign(new StorageRefusedError('Import at most 200 keys at a time.'), { status: 400 });
  if (mode !== 'reference' && mode !== 'copy') throw Object.assign(new StorageRefusedError('mode must be "reference" or "copy".'), { status: 400 });
  await vetProfileEndpoint(profile);
  const imported = [], errors = [];
  for (const raw of keys) {
    let key;
    try { key = storage.assertSafeKey(raw); }
    catch (e) { errors.push({ key: String(raw).slice(0, 200), error: e.message }); continue; }
    try {
      const row = mode === 'reference'
        ? await importReference(profile, key, { workspaceId, userId, folderId })
        : await importCopy(profile, key, { workspaceId, userId, folderId });
      imported.push(row);
    } catch (e) {
      errors.push({ key, error: e instanceof StorageError ? e.message : (e && e.status ? e.message : 'Import failed.') });
      if (e instanceof StorageError) console.warn(e.logLine());
    }
  }
  return { imported, errors };
}

async function importReference(profile, key, { workspaceId, userId, folderId }) {
  const be = storage.backendFor(profile);
  const h = await be.head(key);
  if (!h) throw new StorageError('not_found', 'The object does not exist.', { profileId: profile.id, key });
  if (h.size != null && h.size > config.maxFileSize) throw Object.assign(new StorageRefusedError('That object is larger than this server\'s maximum file size.'), { status: 413 });
  const sniffed = await sniffRemote(profile, key);
  const mime = (sniffed && REF_ACCEPT.has(sniffed) ? sniffed : null) || (sniffed ? null : guessMime(key));
  if (!mime || !REF_ACCEPT.has(mime)) throw Object.assign(new StorageRefusedError('Only image, video and audio objects can be imported by reference (HTML bundles must be copied).'), { status: 400 });
  const id = crypto.randomUUID();
  const filepath = `ref-${id}${MIME_TO_EXT[mime]}`;
  const ownerUserId = require('../support-access').isSupportUserId(userId) ? null : userId;
  const name = require('../content-ingest').safeFilename(path.basename(key));
  db.transaction(() => {
    db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, folder_id, storage_profile_id, object_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerUserId, workspaceId, name || filepath, filepath, mime, h.size || 0, folderId, profile.id, key);
    db.prepare(`INSERT INTO content_locations (content_id, kind, storage_profile_id, object_key, role, state, owned, size, verified_at)
                VALUES (?, 'asset', ?, ?, 'primary', 'ready', 0, ?, CAST(strftime('%s','now') AS INTEGER))`).run(id, profile.id, key, h.size || null);
  })();
  try { require('../plugins/hooks').emit('content.uploaded', { content_id: id, workspace_id: workspaceId, mime }); } catch (_) { /* hooks never fail an import */ }
  try { require('../smart-playlist').notifyContentChanged(workspaceId); } catch (_) {}
  setImmediate(() => { deriveReferenceMetadata(id).catch(() => {}); });
  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

/*
 * Thumbnail, dimensions, duration and digest for a reference import, in the background. Downloads
 * to a temp file (capped at MAX_FILE_SIZE), runs the SAME deriveMediaMetadata an upload does, puts
 * the thumbnail where the workspace writes, and stores the digest it computed on the way.
 */
async function deriveReferenceMetadata(contentId) {
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!row) return;
  const tmpDir = path.join(config.uploadsDir, 'storage-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}${path.extname(row.filepath)}`);
  try {
    const { digest } = await locations.downloadTo(row, 'asset', tmp, { maxBytes: config.maxFileSize });
    const { width, height, durationSec, thumbnailPath } = await require('../content-ingest').deriveMediaMetadata(tmp, row.filepath, row.mime_type);
    let thumbPlan = null;
    if (thumbnailPath && thumbnailPath !== row.filepath) {
      thumbPlan = await locations.placeFiles({ workspaceId: row.workspace_id, files: [{ kind: 'thumb', abs: path.join(config.contentDir, thumbnailPath), basename: thumbnailPath }], mime: row.mime_type });
    }
    db.transaction(() => {
      db.prepare('UPDATE content SET width = COALESCE(?, width), height = COALESCE(?, height), duration_sec = COALESCE(?, duration_sec), thumbnail_path = ?, byte_digest = COALESCE(byte_digest, ?) WHERE id = ?')
        .run(width, height, durationSec, thumbnailPath && thumbnailPath !== row.filepath ? thumbnailPath : null, digest, contentId);
      db.prepare("UPDATE content_locations SET byte_digest = COALESCE(byte_digest, ?) WHERE content_id = ? AND kind = 'asset'").run(digest, contentId);
      if (thumbPlan) thumbPlan.commit(contentId);
    })();
    if (thumbPlan) thumbPlan.cleanup();
  } catch (e) {
    console.warn(`[storage] reference import ${contentId}: metadata not derived (${(e && e.code) || 'error'}); the item still plays`);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

async function importCopy(profile, key, { workspaceId, userId, folderId }) {
  const be = storage.backendFor(profile);
  const h = await be.head(key);
  if (!h) throw new StorageError('not_found', 'The object does not exist.', { profileId: profile.id, key });
  if (h.size != null && h.size > config.maxFileSize) throw Object.assign(new StorageRefusedError('That object is larger than this server\'s maximum file size.'), { status: 413 });
  // Staged exactly as a finished resumable upload is (lib/upload-session.stageForIngest): a `.part`
  // in contentDir, unsniffed, one statement before the sniffer reads it.
  fs.mkdirSync(config.contentDir, { recursive: true });
  const part = path.join(config.contentDir, `${crypto.randomUUID()}.part`);
  const pseudo = { id: `import:${profile.id}:${key}`, filepath: path.basename(key) };
  try {
    await locations.downloadTo(pseudo, 'asset', part, {
      maxBytes: config.maxFileSize,
      locations: [{ id: null, storage_profile_id: storage.normId(profile.id), object_key: key, role: 'primary', state: 'ready', owned: 0 }],
    });
  } catch (e) {
    try { fs.unlinkSync(part); } catch (_) {}
    if (e && e.code === 'too_large') throw Object.assign(new StorageRefusedError('That object is larger than this server\'s maximum file size.'), { status: 413 });
    throw e;
  }
  const file = { path: part, originalname: path.basename(key), size: fs.statSync(part).size, mimetype: 'application/octet-stream' };
  try {
    return await require('../content-ingest').ingestUploadedFile({ file, userId, workspaceId, folderId });
  } catch (e) {
    if (e && e.name === 'StorageWriteError') e.discard();
    try { fs.unlinkSync(file.path); } catch (_) { /* ingest already moved or removed it */ }
    throw e;
  }
}

module.exports = { testConnection, listObjects, importKeys, deriveReferenceMetadata, vetProfileEndpoint, guessMime };
