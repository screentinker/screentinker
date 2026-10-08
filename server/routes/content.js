const express = require('express');
const router = express.Router();

// Smart playlists select content by rule, so any successful content write can change what they
// play. Notify once per write; lib/smart-playlist debounces per workspace and republishes only the
// playlists whose matches actually changed.
router.use((req, res, next) => {
  // Not upload chunks: they change nothing until finalize, and finalize notifies via content-ingest.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.path.startsWith('/uploads') && !req.path.endsWith('/bundle-preview')) {
    res.on('finish', () => {
      if (res.statusCode < 400) require('../lib/smart-playlist').notifyContentChanged(req.workspaceId);
    });
  }
  next();
});
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { devicesPlayingContent } = require('../lib/devices-playing');
const upload = require('../middleware/upload');
const multer = require('multer');   // for MulterError only — the configured instance is `upload` above
const config = require('../config');
const replicaProxy = require('../lib/replica-proxy');
const { checkStorageLimit, checkRemoteUrl } = require('../middleware/subscription');
const { cleanUserText } = require('../middleware/sanitize');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2b: workspace-aware access. Mirrors the pattern from devices.js.
const { denyReadOnly, resourceAccess } = require('../lib/tenancy');
// #73: the upload ingest (processing + insert) is now shared with the agency router.
const { ingestUploadedFile, deriveMediaMetadata } = require('../lib/content-ingest');
const uploadSession = require('../lib/upload-session');
const subscriptionLimits = require('../middleware/subscription');
const htmlBundle = require('../lib/html-bundle');
const { finalizeUpload, INLINE_SAFE_EXTS, sniffMime, readHead: readUploadHead, MIME_TO_EXT: UPLOAD_MIME_TO_EXT } = require('../lib/upload-sniff');
const { digestFile } = require('../lib/content-digest');
const { normalizeTags, normalizeMeta, parseTags, parseMeta } = require('../lib/content-tags');
const { unlinkIfUnreferenced, releaseMeshProvenance } = require('../lib/content-files');
const storageLocations = require('../lib/storage/locations');
const storageServe = require('../lib/storage/serve');
const revisionsLib = require('../lib/revisions');
// IPTV/HLS: the URL gates (server-fetched vs player-opened) and the live mime live
// in one place so the route, the PUT boundary and the tests share one definition.
const { LIVE_MIME, RTSP_MIME, HDMI_IN_MIME, LIVE_MIMES, validateRemoteUrl, validatePlayerOpenedUrl, validateRtspUrl, validateHdmiInUrl, looksLikeHlsUrl, looksLikeRtspUrl, classifyLiveUrl } = require('../lib/remote-url');

// Multer captures file.originalname directly from the multipart filename header,
// bypassing sanitizeBody, so it is cleaned here instead.
//
// ⚠️ IT IS NO LONGER HTML-ESCAPED, AND THAT IS THE POINT. Escaping on the way in and again at the
// sink is double encoding, not defence: a file called `Q&A.jpg` was stored as `Q&amp;A.jpg` and
// shown to the operator as `Q&amp;A.jpg`. The name is stored as typed and escaped where it is
// rendered — every library sink already does. What is stripped is control characters, which is what
// actually matters for a value that reaches a log line and a Content-Disposition header.
//
// .normalize('NFC') first: macOS clients send NFD-decomposed filenames (an
// umlaut like "u" + combining diaeresis U+0308 instead of the precomposed
// "u-umlaut" U+00FC). Linux + most renderers expect NFC; without this, names
// like "Begrussungsscreens.jpg" arrive with the combining char floating and
// display as mojibake. Single-point fix - every user-facing filename storage
// site (POST /, POST /remote, POST /embed, PUT /:id rename) flows through
// safeFilename, so normalizing here covers all paths.
function safeFilename(name) {
  return cleanUserText((name || '').normalize('NFC'));
}

// validateRemoteUrl / validatePlayerOpenedUrl now live in ../lib/remote-url (imported
// above): both POST /remote and PUT /:id share the SSRF gate, and POST /hls + PUT /:id
// (for a video/hls row) use the player-opened gate that allows LAN addresses.

// List content in the caller's current workspace, plus any platform-template
// rows (workspace_id IS NULL) that are shared with all workspaces.
// Phase 2.2b: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list filter.
// folder_id filter: omit for everything; "root" or "" for root-level only; <uuid> for that folder.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folder = req.query.folder;
  const folderId = req.query.folder_id;
  let sql = 'SELECT * FROM content WHERE (workspace_id = ? OR workspace_id IS NULL)';
  const params = [req.workspaceId];
  // #157: by default hide expired/deactivated content (the "live" set). ?include_expired=1
  // returns everything so the library's "Show expired" view can surface + restore them.
  if (req.query.include_expired !== '1' && req.query.include_expired !== 'true') {
    sql += " AND is_active = 1 AND (expires_at IS NULL OR expires_at > strftime('%s','now'))";
  }
  if (folder) { sql += ' AND folder = ?'; params.push(folder); }
  // #214: a text search (?q=) spans the whole workspace, not just the open folder —
  // "searching for a logo on page 1 shouldn't miss logos in another folder". When q is
  // absent we keep the folder-scoped browse behaviour.
  const q = (req.query.q || '').trim();
  if (!q && folderId !== undefined) {
    if (folderId === 'root' || folderId === '') {
      sql += ' AND folder_id IS NULL';
    } else {
      sql += ' AND folder_id = ?';
      params.push(folderId);
    }
  }
  if (q) {
    const esc = q.replace(/[\\%_]/g, (m) => '\\' + m);
    const tagQ = q.replace(/^#/, '').replace(/^tag:/i, '').trim().toLowerCase();
    if (q.startsWith('#') || /^tag:/i.test(q)) {
      sql += " AND tags LIKE ? ESCAPE '\\'";
      params.push('%"' + tagQ.replace(/[\\%_]/g, (m) => '\\' + m) + '"%');
    } else {
      sql += " AND (filename LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR meta LIKE ? ESCAPE '\\')";
      const like = '%' + esc + '%';
      params.push(like, like, like);
    }
  }
  // #214: type filter. youtube (video/youtube) and web (any other remote_url) are split
  // out from plain uploaded video/image so the UI's four buckets map cleanly.
  switch (req.query.type) {
    case 'image':   sql += " AND mime_type LIKE 'image/%'"; break;
    // Live streams are their own bucket (operators need to find channels), so they
    // are excluded from the plain uploaded-video bucket and from the web-page bucket.
    case 'video':   sql += " AND mime_type LIKE 'video/%' AND mime_type NOT IN ('video/youtube','video/hls','video/rtsp')"; break;
    case 'youtube': sql += " AND mime_type = 'video/youtube'"; break;
    case 'live':    sql += " AND mime_type IN ('video/hls','video/rtsp')"; break;
    case 'web':     sql += " AND remote_url IS NOT NULL AND mime_type NOT IN ('video/youtube','video/hls','video/rtsp')"; break;
    // HTML bundles are their own bucket: they are neither image nor video, and without a case here
    // they appear only under "all" — present in the library and unfindable.
    case 'audio':   sql += " AND mime_type LIKE 'audio/%'"; break;
    case 'bundle':  sql += " AND mime_type = '" + htmlBundle.BUNDLE_MIME + "'"; break;
    // default / 'all' / unknown: no type constraint
  }
  // #214: whitelisted sort (never interpolate user input into ORDER BY). Default keeps the
  // legacy newest-first ordering.
  const SORTS = {
    date_desc: 'created_at DESC',
    date_asc:  'created_at ASC',
    name:      'filename COLLATE NOCASE ASC',
    size:      'file_size DESC',
  };
  sql += ' ORDER BY ' + (SORTS[req.query.sort] || SORTS.date_desc) + ' LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(req.query.limit) || 100, 500), parseInt(req.query.offset) || 0);
  const content = db.prepare(sql).all(...params);
  for (const c of content) {
    c.tags = parseTags(c.tags);
    c.meta = parseMeta(c.meta);
  }
  res.json(content);
});

/*
 * Mint a short-lived preview of an HTML bundle for the dashboard.
 *
 * Authenticated, and checked against the caller's own workspace by checkContentWrite's read
 * sibling — a preview must not become a way to read another tenant's archive by uuid. The flatten
 * happens here so a broken bundle reports its reason to the operator who just uploaded it, rather
 * than 500ing inside an iframe where nobody sees it.
 */
router.post('/:id/bundle-preview', async (req, res) => {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (content.workspace_id && content.workspace_id !== req.workspaceId) {
    return res.status(403).json({ error: 'Not your content' });
  }
  if (content.mime_type !== htmlBundle.BUNDLE_MIME || !content.filepath) {
    return res.status(400).json({ error: 'Not an HTML bundle' });
  }
  let safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  try {
    if (!fs.existsSync(safePath) && storageServe.storedElsewhere(content)) {
      safePath = await storageLocations.ensureLocalFile(content, 'asset');
      if (!safePath) return res.status(404).json({ error: 'Bundle not found' });
    }
    const { inlineBundle } = require('../lib/bundle-inline');
    const out = await inlineBundle(safePath, content.bundle_entry || 'index.html');
    const token = require('../lib/bundle-preview-store').put(content.id, out.html);
    res.json({ url: `/api/content/${content.id}/bundle-preview/${token}`, skipped: out.skipped, inlined: out.inlined });
  } catch (e) {
    res.status(e && e.status === 413 ? 413 : 500).json({ error: (e && e.message) || 'Bundle could not be rendered' });
  }
});

// Get folders list for the caller's current workspace.
router.get('/folders', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folders = db.prepare(
    'SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL AND (workspace_id = ? OR workspace_id IS NULL) GROUP BY folder ORDER BY folder'
  ).all(req.workspaceId);
  res.json(folders);
});

// Upload content
// #212: multi-file upload. Accept the new `files` field and keep the legacy single `file` field so
// older clients / API callers / the replace flow are unaffected.
//
// #317: the cap was 20 and nothing caught the refusal. Somebody uploading 160 photos from a party
// got an error with no number in it and no way to know what to do differently; they ended up
// dragging them in sixteen at a time. Two halves to that: the cap is higher now, and — the part
// that actually mattered — going over it says so. Multer rejects a field with too many files by
// throwing LIMIT_UNEXPECTED_FILE, which without a handler surfaces as a bare 500.
//
// The dashboard also splits a large selection into batches, so the cap is a backstop for direct API
// callers rather than something a person is meant to feel. It is not removed altogether: one
// request still has to fit in a proxy's body limit and finish inside its timeout.
const MAX_FILES_PER_UPLOAD = 60;
const uploadContentFiles = upload.fields([
  { name: 'files', maxCount: MAX_FILES_PER_UPLOAD },
  { name: 'file', maxCount: 1 },
]);

// Turn multer's own refusals into something the person reading the toast can act on. Without this
// every one of them was an unhandled error: not just the file count, but an oversized file too.
function uploadContentFilesGuarded(req, res, next) {
  uploadContentFiles(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          error: `Too many files in one upload. The limit is ${MAX_FILES_PER_UPLOAD} per request — `
               + 'the dashboard splits larger selections automatically, so send them in batches if you are calling the API directly.',
        });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `That file is larger than the ${Math.round(config.maxFileSize / (1024 * 1024))} MB limit for a single upload.`,
        });
      }
      return res.status(400).json({ error: `Upload rejected: ${err.message}` });
    }
    return next(err);
  });
}
/*
 * ⚠️ MULTER HAS ALREADY WRITTEN EVERY BYTE BEFORE A ROUTE HANDLER RUNS. Each upload lands in
 * contentDir as `<uuid>.part`, and nothing sweeps those (upload-session sweeps only incoming/,
 * content-receive only `mesh-*`) and nothing counts them against an allowance. So every refusal a
 * handler makes AFTER multer must remove what multer wrote, or a 404 on a made-up content id
 * leaves 500 MB on disk for ever — at the route's rate limit, gigabytes a minute per user.
 * `files` defaults to everything on the request; the batch loop passes only the files it has not
 * ingested yet, because the ones before them are now rows and their bytes are live.
 */
function discardUploads(req, files = null) {
  const list = files || [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
  ];
  for (const f of list) {
    if (f && f.path) { try { fs.unlinkSync(f.path); } catch (_) { /* already gone */ } }
  }
}

/*
 * The checks that need no request body run BEFORE multer, so a caller who would be refused never
 * gets to put bytes on this disk at all. The post-multer handler repeats them (cheap) so it stays
 * correct on its own, and cleans up whatever it refuses.
 */
function uploadPreflight(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
  if (denyReadOnly(req, res)) return;
  next();
}

router.post('/', checkStorageLimit, uploadPreflight, uploadContentFilesGuarded, async (req, res) => {
  const files = [...((req.files && req.files.files) || []), ...((req.files && req.files.file) || [])];
  // Index of the first file NOT yet ingested; everything from here on is still a `.part` on disk.
  let next = 0;
  try {
    if (!req.workspaceId) { discardUploads(req); return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' }); }
    if (denyReadOnly(req, res)) { discardUploads(req); return; }
    if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    // #73: shared ingest - identical processing + insert for dashboard and agency uploads.
    const folderId = req.body.folder_id || null;
    // Validate the folder is in this workspace (PUT /:id and batch/move already do; upload did not,
    // so an upload could be filed under another workspace's folder id).
    if (folderId) {
      const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folderId);
      if (!target || target.workspace_id !== req.workspaceId) {
        discardUploads(req);
        return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
      }
    }

    /*
     * ⚠️ SNIFF THE WHOLE BATCH BEFORE INGESTING ANY OF IT. The loop used to stop at the first
     * unsupported file and answer 400 — but the files before it were already rows. The client saw a
     * failure, retried, and duplicated them; the files after it were left as `.part` orphans. A
     * wrong type is the common refusal and it is knowable from the head bytes alone, so it now
     * refuses the batch as a unit. (A zip that is not a valid bundle can still only be found out
     * inside ingest; the catch below at least removes the files that were never reached.)
     */
    for (const file of files) {
      let mime = null;
      try { mime = sniffMime(readUploadHead(file.path)); } catch (_) { mime = null; }
      if (!mime || !UPLOAD_MIME_TO_EXT[mime]) {
        discardUploads(req);
        return res.status(400).json({
          error: `Unsupported file type (${file.originalname || 'upload'}) — only image, video and audio files are accepted. Nothing in this upload was added.`,
        });
      }
    }

    const results = [];
    for (; next < files.length; next++) {
      results.push(await ingestUploadedFile({ file: files[next], userId: req.user.id, workspaceId: req.workspaceId, folderId }));
    }
    // Backward-compatible shape: a single upload still returns the content object (what
    // every existing caller reads); a multi-file upload returns the array of them.
    for (const c of results) { try { require('../lib/revisions').recordCurrent(db, 'content', c.id, { actor: require('../lib/releases').actorOf(req), summary: 'Uploaded' }); } catch (_) {} }
    res.status(201).json(results.length === 1 ? results[0] : results);
  } catch (err) {
    // files[next] was being ingested (ingest removes what it refuses); the rest were never reached.
    discardUploads(req, files.slice(next + 1));
    if (err && err.name === 'UnsupportedUploadError') return res.status(400).json({ error: err.message });
    if (err && err.name === 'StorageWriteError') { err.discard(); return res.status(502).json({ error: err.message, code: 'STORAGE_WRITE_FAILED' }); }
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/* ================================================================================================
 * RESUMABLE UPLOADS — lib/upload-session.js holds the state and the bytes.
 *
 * ⚠️ WHY, in one measurement: a single-request upload must finish inside the shortest timeout
 * between the browser and this process. On prod that is Cloudflare's, and it is exactly 125s —
 * seven consecutive failures from one customer at 125.008-125.012s, while his 65 successes in the
 * same session peaked at 114.2s. He was inside a ten-second margin. The ceiling is not ours to
 * raise and it scales with file size; smaller requests are the fix, because each chunk gets its own
 * budget and a dropped connection costs one chunk instead of a gigabyte.
 *
 * The single-shot POST / above STAYS. API tokens, the agency portal and older dashboards use it,
 * and for a small file one request is simply better than five.
 * ============================================================================================= */

/** Everything below is a write to this workspace's library; one gate, applied the same way. */
function uploadSessionGate(req, res) {
  if (!req.workspaceId) {
    res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
    return false;
  }
  if (denyReadOnly(req, res)) return false;
  return true;
}

// Open a session. Answers with the chunk size the SERVER wants, so the limit can be tuned here
// without shipping a new dashboard.
router.post('/uploads', checkStorageLimit, (req, res) => {
  if (!uploadSessionGate(req, res)) return;
  const { filename, size, folder_id: folderId } = req.body || {};

  const declared = Number(size);
  if (!filename || !Number.isFinite(declared) || declared <= 0) {
    return res.status(400).json({ error: 'filename and a positive size are required' });
  }
  if (declared > config.maxFileSize) {
    return res.status(413).json({
      error: `file is larger than the ${Math.round(config.maxFileSize / 1048576)}MB limit`,
    });
  }

  /*
   * ⚠️ The storage allowance is checked against the DECLARED SIZE here, not merely against current
   * usage. checkStorageLimit alone refuses only once you are ALREADY at the limit, so a workspace
   * at 19.9GB of 20GB could start a 500MB upload and land at 20.4GB. Knowing the size up front is
   * the one advantage a session has over a stream, and this is what it buys.
   */
  /*
   * ⚠️ ...and against what this user's OTHER open sessions have already declared. Room counts only
   * finished rows, so without the reservation N parallel sessions each saw the same room and all
   * passed (see uploadSession.reservedBytes). The check and the INSERT below run in one synchronous
   * stretch with no await between them, so two concurrent creates cannot both see the same room.
   */
  const rawRoom = subscriptionLimits.storageRoomBytes(req.user.id);
  const reserved = rawRoom === null ? 0 : uploadSession.reservedBytes(req.user.id);
  const room = rawRoom === null ? null : rawRoom - reserved;
  if (room !== null && declared > room) {
    return res.status(403).json({
      error: reserved > 0
        ? 'This upload would exceed your storage allowance, counting uploads you already have in progress.'
        : 'This upload would exceed your storage allowance.',
      code: 'STORAGE_LIMIT',
      needed_bytes: declared,
      available_bytes: Math.max(0, room),
      reserved_bytes: reserved,
    });
  }

  if (folderId) {
    const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folderId);
    if (!target || target.workspace_id !== req.workspaceId) {
      return res.status(400).json({ error: 'Invalid folder_id for this workspace' });
    }
  }

  const session = uploadSession.create({
    workspaceId: req.workspaceId, userId: req.user.id,
    filename, declaredSize: declared, folderId: folderId || null,
  });
  res.status(201).json({
    id: session.id,
    offset: 0,
    chunk_size: uploadSession.CHUNK_SIZE,
    declared_size: session.declared_size,
  });
});

/*
 * Where is this upload up to?
 *
 * ⚠️ THE ENDPOINT THAT MAKES RESUME REAL. A client that reloaded, crashed, or closed its laptop
 * asks this and learns exactly where to continue — it needs to remember only the session id, and
 * the answer comes from the bytes on disk rather than from anything the client told us. Without
 * it, "resumable" would mean "retryable within one page session".
 */
router.head('/uploads/:id', (req, res) => {
  if (!req.workspaceId) return res.status(403).end();
  const session = uploadSession.get(req.params.id, req.workspaceId);
  if (!session) return res.status(404).end();
  res.set('Upload-Offset', String(uploadSession.offsetOf(session)));
  res.set('Upload-Length', String(session.declared_size));
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
});

// A GET twin, because XHR/fetch in a browser cannot read headers from a 204 as conveniently as a
// body, and a resume prompt needs the filename to say what it is offering to resume.
router.get('/uploads/:id', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const session = uploadSession.get(req.params.id, req.workspaceId);
  if (!session) return res.status(404).json({ error: 'no such upload' });
  res.set('Cache-Control', 'no-store');
  res.json({
    id: session.id,
    filename: session.filename,
    offset: uploadSession.offsetOf(session),
    declared_size: session.declared_size,
    chunk_size: uploadSession.CHUNK_SIZE,
    folder_id: session.folder_id,
  });
});

/*
 * Append one chunk. Raw bytes, `Upload-Offset` says where the client believes it is.
 *
 * express.raw rather than multer: this is a byte range, not a form. It also means no temp file and
 * no multipart parse per chunk.
 */
router.patch('/uploads/:id',
  express.raw({ type: () => true, limit: uploadSession.MAX_CHUNK_BYTES }),
  (req, res) => {
    if (!uploadSessionGate(req, res)) return;
    const session = uploadSession.get(req.params.id, req.workspaceId);
    if (!session) return res.status(404).json({ error: 'no such upload' });

    const declaredOffset = Number(req.get('Upload-Offset'));
    if (!Number.isFinite(declaredOffset) || declaredOffset < 0) {
      return res.status(400).json({ error: 'Upload-Offset header is required' });
    }

    const result = uploadSession.append(session, declaredOffset, req.body);
    if (!result.ok) {
      // The refusal NAMES the offset, so a client that lost a response corrects itself in one
      // round trip instead of starting again.
      return res.status(result.status).json({ error: result.error, offset: result.offset });
    }
    res.set('Upload-Offset', String(result.offset));
    res.json({ offset: result.offset, complete: result.offset === session.declared_size });
  });

/*
 * Every byte has arrived: run the SAME ingest a single-shot upload runs.
 *
 * lib/content-ingest.ingestUploadedFile does the sniffing, bundle validation, ffprobe, thumbnails,
 * digest, row and plugin hook. Handing it a multer-shaped object is the entire integration — the
 * alternative, a parallel ingest for chunked uploads, is how two paths drift until only one of them
 * gets the next fix.
 */
router.post('/uploads/:id/finalize', async (req, res) => {
  if (!uploadSessionGate(req, res)) return;
  const session = uploadSession.get(req.params.id, req.workspaceId);
  if (!session) return res.status(404).json({ error: 'no such upload' });

  const offset = uploadSession.offsetOf(session);
  if (!uploadSession.isComplete(session)) {
    // Not an error state the client cannot act on: tell it what is missing and let it send the rest.
    return res.status(409).json({
      error: `upload is incomplete: ${offset} of ${session.declared_size} bytes`,
      offset, declared_size: session.declared_size,
    });
  }

  /*
   * ⚠️ RE-CHECKED AT FINALIZE, against the bytes actually staged. The create-time check is a
   * reservation made against a number the client chose, and usage can move in between (another
   * upload finalized, a plan downgrade, an upload path that does not reserve). This is the last
   * moment before the bytes become a row, so it is the one check that cannot be raced past. The
   * session is discarded on refusal: the client forgets a completed session and starts a new one
   * on retry, so keeping it would only pin a reservation until the sweeper.
   */
  const room = subscriptionLimits.storageRoomBytes(session.user_id);
  if (room !== null && offset > room) {
    uploadSession.discard(session);
    return res.status(403).json({
      error: 'This upload would exceed your storage allowance.',
      code: 'STORAGE_LIMIT',
      needed_bytes: offset,
      available_bytes: Math.max(0, room),
    });
  }

  try {
    const content = await ingestUploadedFile({
      file: uploadSession.stageForIngest(session),
      userId: session.user_id,
      workspaceId: session.workspace_id,
      folderId: session.folder_id,
    });
    // The bytes now live under contentDir with a sniffed extension; the session row is spent.
    uploadSession.forget(session.id);
    try {
      require('../lib/revisions').recordCurrent(db, 'content', content.id,
        { actor: require('../lib/releases').actorOf(req), summary: 'Uploaded' });
    } catch (_) { /* revision history must not fail an upload */ }
    res.status(201).json(content);
  } catch (err) {
    /*
     * The bucket refused the bytes (lib/storage). The upload itself is intact, so it is NOT thrown
     * away: the asset goes back into the session as its part file and the client may simply retry
     * the finalize once the operator has fixed the profile. Nothing was inserted.
     */
    if (err && err.name === 'StorageWriteError') {
      const [asset, ...rest] = err.files || [];
      try { fs.renameSync(asset, uploadSession.partPath(session)); } catch (_) { uploadSession.discard(session); }
      for (const f of rest) { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } }
      return res.status(502).json({ error: err.message, code: 'STORAGE_WRITE_FAILED', retryable: true });
    }
    /*
     * ⚠️ The part file goes on an unsupported type, and only then. finalizeUpload already unlinked
     * whatever it rejected, so leaving the row would strand a session pointing at nothing — and
     * keeping it would invite a client to retry a finalize that can never succeed.
     */
    uploadSession.discard(session);
    if (err && err.name === 'UnsupportedUploadError') return res.status(400).json({ error: err.message });
    console.error('Resumable finalize error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Give up on an upload. Idempotent: a client that already forgot gets the same answer.
router.delete('/uploads/:id', (req, res) => {
  if (!uploadSessionGate(req, res)) return;
  const session = uploadSession.get(req.params.id, req.workspaceId);
  if (session) uploadSession.discard(session);
  res.json({ ok: true });
});

// Add remote URL content
router.post('/remote', checkRemoteUrl, (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding remote content.' });
    if (denyReadOnly(req, res)) return;
    const { url, name, mime_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const urlErr = validateRemoteUrl(url);
    if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    const mimeType = mime_type || (url.match(/\.(mp4|webm|mkv|avi|mov)/i) ? 'video/mp4' : 'image/jpeg');

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), mimeType, url);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { require('../lib/revisions').recordCurrent(db, 'content', content.id, { actor: require('../lib/releases').actorOf(req), summary: 'Added' }); } catch (_) {}
    res.status(201).json(content);
  } catch (err) {
    console.error('Remote URL add error:', err);
    res.status(500).json({ error: 'Failed to add remote URL' });
  }
});

// Add YouTube content (available to all plans - no storage used)
router.post('/youtube', async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding YouTube content.' });
    if (denyReadOnly(req, res)) return;
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Extract YouTube video ID from various URL formats
    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // Fetch title + aspect from YouTube oEmbed, queried with the ORIGINAL url so a
    // /shorts/ link reports its true vertical dimensions. A Short is detected from
    // the /shorts/ URL form OR portrait oEmbed dims (height > width). We persist that
    // as st_aspect=vertical on the embed URL so every player can render it 9:16
    // without re-querying oEmbed on each loop (remote_url is the only signal players
    // get; the /shorts/ origin is otherwise lost after ingest). YouTube ignores the
    // unknown param, and players read the video id — not the full URL — for the embed.
    let filename = name;
    let isVertical = /\/shorts\//i.test(url);
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (!filename) filename = oembed.title;
        if (oembed.height && oembed.width && Number(oembed.height) > Number(oembed.width)) isVertical = true;
      }
    } catch {}
    if (!filename) filename = `YouTube: ${videoId}`;

    const id = uuidv4();
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=${videoId}&enablejsapi=1${isVertical ? '&st_aspect=vertical' : ''}`;
    // thumbnail_path is a REMOTE URL here; the /api/content/:id/thumbnail route proxies
    // remote thumbnails server-side (so this isn't a local-file path). Future option for
    // CDN independence: download the thumbnail at ingest into contentDir + backfill
    // existing rows, then this would store a local filename like image uploads do.
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path)
      VALUES (?, ?, ?, ?, '', 'video/youtube', 0, ?, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), embedUrl, thumbnailUrl);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { require('../lib/revisions').recordCurrent(db, 'content', content.id, { actor: require('../lib/releases').actorOf(req), summary: 'Added' }); } catch (_) {}
    res.status(201).json(content);
  } catch (err) {
    console.error('YouTube add error:', err);
    res.status(500).json({ error: 'Failed to add YouTube video' });
  }
});

// Add a live stream (IPTV / camera). Same shape as YouTube: a URL the PLAYER opens on
// the LAN. The SERVER NEVER FETCHES IT — no HEAD/GET here (that would be both SSRF and
// a WAN pull of a 24/7 stream across every screen). We trust the URL SHAPE; a junk
// stream fails to a skip on the player. An http(s) .m3u8 becomes video/hls (all players);
// an rtsp:// URL becomes video/rtsp (Android/ExoPlayer only — the deviceSocket strip keeps
// it off screens that cannot open rtsp). hdmi://<port> becomes video/hdmi-in: the screen's own HDMI
// input, Android TV boxes that have one only. Private / .local hosts and rtsp credentials are
// allowed because the screen, not the server, opens the URL on its own LAN.
router.post('/hls', (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding a live stream.' });
    if (denyReadOnly(req, res)) return;
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const kind = classifyLiveUrl(url);
    if (kind.error) return res.status(kind.error.status).json({ error: kind.error.error });

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'Live stream';
    // filepath '' + file_size 0 like YouTube: no bytes stored, no storage counted.
    // duration_sec on the CONTENT stays null (unknown / infinite) — DWELL is set per
    // playlist item.
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), kind.mime, url);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { require('../lib/revisions').recordCurrent(db, 'content', content.id, { actor: require('../lib/releases').actorOf(req), summary: 'Added' }); } catch (_) {}
    res.status(201).json(content);
  } catch (err) {
    console.error('HLS add error:', err);
    res.status(500).json({ error: 'Failed to add live stream' });
  }
});

// Add a HOLD (lib/hold-item.js): an item that shows nothing new for its duration — blank, or the
// previous item's last frame. No bytes and no URL to check: the mode is the whole item.
router.post('/hold', (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding a hold.' });
    if (denyReadOnly(req, res)) return;
    const { HOLD_MIME, HOLD_MODES, holdUrl } = require('../lib/hold-item');
    const mode = req.body && req.body.mode ? String(req.body.mode) : 'blank';
    if (!HOLD_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${HOLD_MODES.join(', ')}` });
    const name = (req.body && req.body.name && String(req.body.name).trim()) || (mode === 'freeze' ? 'Hold (freeze frame)' : 'Hold (blank)');
    const id = uuidv4();
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
      VALUES (?, ?, ?, ?, '', ?, 0, ?)
    `).run(id, req.user.id, req.workspaceId, safeFilename(name), HOLD_MIME, holdUrl(mode));
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    try { require('../lib/revisions').recordCurrent(db, 'content', content.id, { actor: require('../lib/releases').actorOf(req), summary: 'Added' }); } catch (_) {}
    res.status(201).json(content);
  } catch (err) {
    console.error('Hold add error:', err);
    res.status(500).json({ error: 'Failed to add hold' });
  }
});

function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // bare video ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Phase 2.2b: workspace-aware access. Mirrors the device check pattern.
// Platform-template content (workspace_id IS NULL) is readable by anyone
// and writable only by platform_admin.
function checkContentRead(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: readable by anyone authenticated.
  if (!content.workspace_id) return content;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

function checkContentWrite(req, res) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  // Platform-template row: only platform_admin may write.
  if (!content.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared content' }); return null;
    }
    return content;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  // Workspace_viewer is read-only; acting-as (platform_admin or org owner/admin) and editor/admin pass.
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  /*
   * ⚠️ CORPORATE: media head office's playlist plays (directly, through a child, as a slot
   * fallback, or still in its published copy) may be changed only by a corporate author. Every
   * caller of this helper mutates — PUT, replace (same id, new bytes), subtitle, delete — and the
   * delete would otherwise cascade the item out of the corporate playlist.
   */
  try { require('../lib/corporate/guard').assertMediaWritable(req, 'content', content.id); } catch (e) {
    if (require('../lib/corporate/guard').send(res, e, req)) return null;
    throw e;
  }
  return content;
}

// #213: boolean form of checkContentWrite for batch paths (no res side effects). True if
// req.user may modify this content row. Mirrors checkContentWrite's authorization exactly.
function contentWritable(req, content) {
  if (!content) return false;
  if (!content.workspace_id) return PLATFORM_ROLES.includes(req.user.role);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(content.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return false;
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return false;
  // CORPORATE: same rule as checkContentWrite (batch delete / move of head office's media).
  try { require('../lib/corporate/guard').assertMediaWritable(req, 'content', content.id); } catch (e) {
    if (e && e.name === 'CorporateError') return false;
    throw e;
  }
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #213: shared single-row teardown used by DELETE /:id and POST /batch/delete. Removes the
// row's files, scrubs it from published snapshots in its workspace, deletes the row (cascades
// playlist_items). Returns the device ids whose playlists referenced it so the caller can push
// updates. Pure DB+FS, no HTTP. `content.id` MUST be a validated UUID (LIKE scrub) and the
// caller MUST have authorized the write. File unlinks are wrapped so they never throw.
/*
 * ⚠️ CORPORATE (spec §3.4). The same scrub for what a mandated screen plays, which no snapshot holds
 * whole: a corporate playlist's published_composable (its items, and its slots' fallbacks) and every
 * cached composition. Each scrubbed playlist's published_rev moves, so any composition built from the
 * old copy is stale on its next read; the cache rows naming the content are dropped outright. The
 * screens of a scrubbed store fill are added to `affected`: they never resolve to the fill itself.
 */
function scrubCorporate(id, workspaceId, affected, scrubbed) {
  try {
    const probe = require('../lib/corporate/schema-probe');
    if (!probe.hasColumn(db, 'playlists', 'published_composable')) return;
    // ⚠️ `scrubbed` (the snapshots the caller just rewrote) is passed in rather than re-queried: by now
    // those snapshots no longer contain the id, so a LIKE here would find none of them.
    const touched = new Set(scrubbed || []);
    for (const pl of db.prepare('SELECT id, published_composable FROM playlists WHERE workspace_id = ? AND published_composable LIKE ?').all(workspaceId, `%${id}%`)) {
      let list;
      try { list = JSON.parse(pl.published_composable); } catch (_) { continue; }
      if (!Array.isArray(list)) continue;
      let changed = false;
      const out = [];
      for (const el of list) {
        if (el && el.__slot) {
          if (el.fallback && el.fallback.content_id === id) { out.push({ ...el, fallback: null }); changed = true; } else out.push(el);
        } else if (el && el.content_id === id) { changed = true; } else out.push(el);
      }
      if (changed) { db.prepare('UPDATE playlists SET published_composable = ? WHERE id = ?').run(JSON.stringify(out), pl.id); touched.add(pl.id); }
    }
    // Every playlist whose published copy named it (snapshot or composable) moves its rev, so any
    // composition built from the old copy is stale on its next read.
    const bump = db.prepare('UPDATE playlists SET published_rev = published_rev + 1 WHERE id = ?');
    const fills = require('../lib/corporate/fills');
    for (const pid of touched) {
      bump.run(pid);
      // A store's slot content: its screens resolve to head office's playlist, never to the fill.
      for (const d of fills.devicesPlayingFill(db, pid)) affected.push(d);
    }
    db.prepare('DELETE FROM corporate_compositions WHERE snapshot LIKE ?').run(`%${id}%`);
  } catch (e) { console.warn(`[content] corporate scrub failed for ${id}: ${e && e.message}`); }
}

function purgeContentRow(content) {
  const id = content.id;
  // Copies in storage backends (lib/storage): their rows go with the content row, in this
  // transaction; the objects go after it commits, refcounted against what survives.
  const storedCopies = storageLocations.locationsOf(id);
  unlinkIfUnreferenced(content.filepath, id, 'filepath');
  unlinkIfUnreferenced(content.thumbnail_path, id, 'thumbnail_path');
  unlinkIfUnreferenced(content.subtitle_url, id, 'subtitle_url'); // #216 sidecar (no-op pre-#216)

  /*
   * ⚠️ And the provenance row goes with it, because nothing else will take it. The table declares
   * no FOREIGN KEY, so the cascade that removes playlist_items does not reach it — the row would
   * survive pointing at a deleted content id, and the next push of that asset would find it,
   * conclude the bytes are merely missing, transfer the whole file again and charge the operator's
   * allowance a second time for storage they had already paid for and then reclaimed.
   */
  releaseMeshProvenance(id);

  // Resolved: a device that INHERITS the playlist holding this content has no copy of the id on
  // its row, so joining on devices.playlist_id would leave exactly those screens showing content
  // that no longer exists on disk.
  const affected = db.prepare(`
    SELECT DISTINCT d.id as device_id FROM devices d
    JOIN device_resolved_playlist r ON r.device_id = d.id
    JOIN playlists p ON r.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(id).map(r => r.device_id);

  const snapshotPlaylists = db.prepare(
    "SELECT id, published_snapshot FROM playlists WHERE workspace_id = ? AND published_snapshot LIKE ?"
  ).all(content.workspace_id, `%${id}%`);
  const scrubbed = [];
  for (const pl of snapshotPlaylists) {
    try {
      const items = JSON.parse(pl.published_snapshot);
      const filtered = items.filter(item => item.content_id !== id);
      if (filtered.length !== items.length) {
        db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(filtered), pl.id);
        require('../lib/corporate/digest').followSnapshot(db, pl.id, pl.published_snapshot, JSON.stringify(filtered));
        scrubbed.push(pl.id);
        // ⚠️ The snapshot, not playlist_items, is what screens play. A smart playlist (or a parent
        // that flattened one) holds this content with no playlist_items row, so the join above misses
        // its screens; and the later smart refresh rebuilds a list identical to this scrubbed one, so
        // it pushes nothing either. Push from here.
        for (const r of db.prepare('SELECT device_id FROM device_resolved_playlist WHERE playlist_id = ?').all(pl.id)) affected.push(r.device_id);
      }
    } catch (e) { /* corrupt snapshot, skip */ }
  }
  scrubCorporate(id, content.workspace_id, affected, scrubbed);

  // Audit F22: the history goes with the row - submissions BEFORE revisions (FK), not swallowed.
  revisionsLib.deleteHistoryRows(db, 'content', id);
  db.prepare('DELETE FROM content WHERE id = ?').run(id);
  // A Canva link would otherwise outlive its item (foreign_keys is off in production).
  try { db.prepare('DELETE FROM canva_links WHERE content_id = ?').run(id); } catch (_) { /* table absent in an old test schema */ }
  storageLocations.deleteLocationRows(id);
  storageLocations.queueRelease(storedCopies);
  // ⚠️ Its own try: a filesystem error must never skip (or be mistaken for) the DB work above.
  try { revisionsLib.removeRetainedFiles(id); }
  catch (e) { console.warn(`[content] could not remove retained history for ${id}: ${e.message}`); }
  return affected;
}

// #213: push a playlist refresh to a set of device ids (deduped). Silent on any failure.
function pushContentUpdates(req, deviceIds) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    for (const id of new Set(deviceIds)) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

// #213: batch delete. Validates + authorizes EVERY id first (atomic — the whole batch is
// rejected if any id is malformed/missing/forbidden), then deletes in one transaction.
router.post('/batch/delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many items (max 500 per batch)' });

  const rows = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: `Invalid content ID: ${id}` });
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    if (!content) return res.status(404).json({ error: `Content not found: ${id}` });
    if (!contentWritable(req, content)) return res.status(403).json({ error: `Access denied for content: ${id}` });
    rows.push(content);
  }

  const affected = new Set();
  db.transaction(() => {
    for (const content of rows) for (const d of purgeContentRow(content)) affected.add(d);
  })();
  pushContentUpdates(req, affected);
  res.json({ success: true, deleted: rows.length, affectedDevices: [...affected] });
});

// #213: batch move. Reassigns folder_id for many items at once. Folder is organizational only
// (not in the published snapshot), so no device push is needed. Same atomic validate-all-first.
router.post('/batch/move', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  const folderId = req.body.folder_id || null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many items (max 500 per batch)' });

  const rows = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: `Invalid content ID: ${id}` });
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    if (!content) return res.status(404).json({ error: `Content not found: ${id}` });
    if (!contentWritable(req, content)) return res.status(403).json({ error: `Access denied for content: ${id}` });
    rows.push(content);
  }
  // Target folder (if any) must exist and share the workspace of every moved item.
  if (folderId) {
    const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folderId);
    if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
    for (const content of rows) {
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
  }

  db.transaction(() => {
    const stmt = db.prepare('UPDATE content SET folder_id = ? WHERE id = ?');
    for (const content of rows) stmt.run(folderId, content.id);
  })();
  res.json({ success: true, moved: rows.length, folder_id: folderId });
});

// Get content metadata
router.get('/:id', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  content.tags = parseTags(content.tags);
  content.meta = parseMeta(content.meta);
  res.json(content);
});

// Update content metadata
router.put('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;

  const { filename, mime_type, remote_url, folder, folder_id, expires_at, unstable_connection,
          captions_enabled, captions_lang, subtitle_url, subtitle_lang, tags, meta } = req.body;
  const updates = [];
  const values = [];
  /*
   * Under approval, the fields that change WHAT PLAYS (the URL a remote item points at, its type,
   * captions, subtitles, the quality ceiling) are not "details": a new remote_url is new content
   * on every screen that shows the item. Those land in the draft beside the live row and go
   * through review like replaced bytes do. Name, folder and expiry stay live: they organise and
   * schedule the item without changing what it shows.
   */
  const policy = require('../lib/release-policy');
  const revisionsLib = require('../lib/revisions');
  const approvalOn = !!(content.workspace_id && policy.approvalRequired(db, content.workspace_id));
  const draftPatch = {};
  const set = (col, val) => {
    if (approvalOn && revisionsLib.CONTENT_PLAYBACK_FIELDS.includes(col)) draftPatch[col] = val;
    else { updates.push(`${col} = ?`); values.push(val); }
  };
  if (filename !== undefined) { updates.push('filename = ?'); values.push(safeFilename(filename)); }
  if (tags !== undefined) {
    const n = normalizeTags(tags);
    if (n === false) return res.status(400).json({ error: 'tags must be an array of labels, or a comma-separated string' });
    updates.push('tags = ?'); values.push(JSON.stringify(n));
  }
  if (meta !== undefined) {
    const n = normalizeMeta(meta);
    if (n === false) return res.status(400).json({ error: 'meta must be an object of key=value pairs' });
    updates.push('meta = ?'); values.push(JSON.stringify(n));
  }
  /*
   * A live stream is a different KIND of item, the same way an HTML bundle is (see the
   * replace-boundary note below): mime_type is what every player switches on, and its URL
   * is validated by a different gate (player-opened, LAN allowed) than a server-fetched
   * remote. So turning a youtube/web/video row INTO a live stream, or a live stream into
   * anything else, is refused here — delete it and add the right kind instead. Switching a
   * live item BETWEEN transports (video/hls <-> video/rtsp <-> video/hdmi-in) is allowed: it is still live.
   */
  const targetMime = mime_type !== undefined ? mime_type : content.mime_type;
  // A hold has no bytes and no URL, so nothing can be swapped into or out of one.
  {
    const { HOLD_MIME } = require('../lib/hold-item');
    if ((content.mime_type === HOLD_MIME) !== (targetMime === HOLD_MIME)
        || (content.mime_type === HOLD_MIME && remote_url !== undefined && !/^hold:\/\/(blank|freeze)$/.test(String(remote_url || '')))) {
      return res.status(400).json({ error: 'A hold cannot be turned into other content, or other content into a hold. Add a new item instead.' });
    }
  }
  const wasLive = LIVE_MIMES.indexOf(content.mime_type) !== -1;
  const targetIsLive = LIVE_MIMES.indexOf(targetMime) !== -1;
  if (wasLive !== targetIsLive) {
    return res.status(400).json({
      error: wasLive
        ? 'This item is a live stream — replace its URL, or delete it and add the new content.'
        : 'A live stream cannot replace this item. Add it as a new live stream instead.',
    });
  }
  if (mime_type !== undefined) set('mime_type', mime_type);
  if (remote_url !== undefined) {
    if (remote_url) {
      // A live URL is opened by the player on its LAN, never fetched by the server, so it
      // uses the player-opened gate for its transport (private hosts / rtsp creds allowed);
      // everything else stays on the SSRF gate.
      if (targetMime === require('../lib/hold-item').HOLD_MIME) {
        // Shape already checked above: hold://blank or hold://freeze — nothing to fetch or gate.
      } else if (targetIsLive) {
        const urlErr = targetMime === RTSP_MIME ? validateRtspUrl(remote_url)
          : targetMime === HDMI_IN_MIME ? validateHdmiInUrl(remote_url)
          : validatePlayerOpenedUrl(remote_url);
        if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
        if (targetMime === LIVE_MIME && !looksLikeHlsUrl(remote_url)) {
          return res.status(400).json({ error: 'That does not look like an HLS stream. The URL should point at an .m3u8 playlist.' });
        }
        if (targetMime === RTSP_MIME && !looksLikeRtspUrl(remote_url)) {
          return res.status(400).json({ error: 'A camera stream URL must use rtsp://.' });
        }
      } else {
        const urlErr = validateRemoteUrl(remote_url);
        if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
      }
    }
    set('remote_url', remote_url || null);
  }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }
  if (folder_id !== undefined) {
    // Phase 2.2c: target folder must live in the same workspace as the
    // content row being modified. Strict same-workspace check - no
    // platform_admin override, because cross-workspace folder references
    // break the isolation model. To move content across workspaces, switch
    // workspace first.
    if (folder_id) {
      const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folder_id);
      if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
    updates.push('folder_id = ?');
    values.push(folder_id || null);
  }
  // #157: set/clear expiry (epoch seconds, or null = never). Whenever expiry changes we
  // reset is_active=1 — the expiry sweep's once-only marker. That means: clearing/extending
  // to a future time reactivates the item immediately; setting a PAST time leaves it "active"
  // for the sweep to flip to 0 AND republish the playlists that carried it (the immediate-
  // expiry path). Publish-time filtering already excludes past-expiry items regardless.
  if (expires_at !== undefined) {
    let val = null;
    if (expires_at !== null && expires_at !== '') {
      val = Number(expires_at);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ error: 'expires_at must be epoch seconds (positive integer) or null' });
      }
      val = Math.floor(val);
    }
    updates.push('expires_at = ?'); values.push(val);
    updates.push('is_active = 1');
  }
  // #217: force a lower YouTube quality ceiling for weak/unstable WiFi. Stored 0/1;
  // accepts booleans or 0/1 from the client and coerces to an integer.
  if (unstable_connection !== undefined) set('unstable_connection', unstable_connection ? 1 : 0);
  // #216: caption/subtitle metadata. The subtitle FILE is uploaded via POST /:id/subtitle;
  // these fields toggle YouTube captions, set languages, or clear a subtitle (subtitle_url=null).
  if (captions_enabled !== undefined) set('captions_enabled', captions_enabled ? 1 : 0);
  if (captions_lang !== undefined) set('captions_lang', captions_lang ? String(captions_lang).slice(0, 10) : null);
  if (subtitle_url !== undefined) {
    // Only null (clear) is accepted here — a real subtitle_url is set by the upload endpoint.
    set('subtitle_url', subtitle_url ? String(subtitle_url).slice(0, 255) : null);
  }
  if (subtitle_lang !== undefined) set('subtitle_lang', subtitle_lang ? String(subtitle_lang).slice(0, 10) : null);

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const actor = require('../lib/releases').actorOf(req);
  if (Object.keys(draftPatch).length) {
    const existing = revisionsLib.parseJson(content.draft_json, null) || {};
    db.prepare('UPDATE content SET draft_json = ? WHERE id = ?').run(JSON.stringify({ ...existing, ...draftPatch }), req.params.id);
    revisionsLib.recordCurrent(db, 'content', req.params.id, { actor, summary: 'Updated details (draft)' });
    return res.json({ ...db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id), draft: true, pending_review: true });
  }
  revisionsLib.recordCurrent(db, 'content', req.params.id, { actor, summary: 'Updated details' });
  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Replace content file
/*
 * ⚠️ AUTHORISED BEFORE MULTER, so a caller who will be refused (a viewer, a made-up id) never puts
 * bytes on disk. This route used to authorise AFTER upload.single had written the whole file, then
 * return without removing it — an orphan `.part` per refused request that nothing ever sweeps.
 */
function replacePreflight(req, res, next) {
  if (!checkContentWrite(req, res)) return;
  next();
}
router.put('/:id/replace', replacePreflight, upload.single('file'), async (req, res) => {
  // Re-read after the upload: the row may have changed (or gone) while the bytes were arriving.
  const content = checkContentWrite(req, res);
  if (!content) { discardUploads(req); return; }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const { replaceContentBytes } = require('../lib/content-replace');
  const out = await replaceContentBytes({ content, file: req.file, actor: require('../lib/releases').actorOf(req), reqOrIo: req });
  res.status(out.status).json(out.body);
});

// #216: upload a WebVTT subtitle track for an uploaded video. Stores the .vtt in the
// content dir (served at /uploads/content/<file>) and records its filename + language on
// the content row. Replaces any existing subtitle (old file removed).
router.post('/:id/subtitle', upload.subtitleUpload.single('subtitle'), async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) {
    // checkContentWrite already sent the response; clean up the orphaned upload.
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return;
  }
  if (!req.file) return res.status(400).json({ error: 'No subtitle file provided' });

  // Remove the previous subtitle file if there was one, unless it is shared (see purgeContentRow).
  unlinkIfUnreferenced(content.subtitle_url, content.id, 'subtitle_url');
  const lang = req.body.subtitle_lang ? String(req.body.subtitle_lang).slice(0, 10) : (content.subtitle_lang || null);
  const staleSubs = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'subtitle'").all(content.id);
  db.transaction(() => {
    db.prepare("DELETE FROM content_locations WHERE content_id = ? AND kind = 'subtitle'").run(content.id);
    db.prepare('UPDATE content SET subtitle_url = ?, subtitle_lang = ? WHERE id = ?')
      .run(req.file.filename, lang, req.params.id);
  })();
  storageLocations.queueRelease(staleSubs);
  // The new .vtt is a local file; it follows the asset to the workspace's storage (lib/storage).
  storageLocations.settleSoon(content.id, { kinds: ['subtitle'] });
  res.json(db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id));
});

// Uploads share the dashboard origin — see server.js hardenUploadResponse. Same rule
// applied here so these routes are safe on their own merits, not because another mount
// happens to be registered first.
function hardenUploadResponse(res, filename) {
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!INLINE_SAFE_EXTS.has(path.extname(String(filename || '')).toLowerCase())) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
  }
}

/*
 * Scale-out (docs/scale-out.md): the row was copied from the primary but the bytes were not. When
 * the local file is absent and the row's workspace is a copy, the request is forwarded to the
 * primary as-is (the caller's token travels with it) and the answer streamed back. No cache in C1.
 */
function fetchThroughIfCopied(req, res, content, localPath) {
  if (!config.primaryUrl || !content.workspace_id || fs.existsSync(localPath)) return false;
  const ws = db.prepare('SELECT origin_node_id FROM workspaces WHERE id = ?').get(content.workspace_id);
  if (!replicaProxy.isCopiedWorkspace(ws)) return false;
  // C3: under a caches-content edge, store first and serve the local file; otherwise serve through.
  const contentCache = require('../lib/mesh/content-cache');
  if (!contentCache.edgeForContent(db, content)) { replicaProxy.proxyToPrimary(req, res, config); return true; }
  contentCache.ensure(db, config, content).then((r) => {
    if (!(r.ok && fs.existsSync(localPath))) return replicaProxy.proxyToPrimary(req, res, config);
    hardenUploadResponse(res, path.basename(localPath));
    res.setHeader('x-st-replica-cache', 'stored');
    res.sendFile(localPath);
  });
  return true;
}

// Serve content file
router.get('/:id/file', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(safePath) && storageServe.storedElsewhere(content)) {
    return storageServe.serveFromStorage(req, res, content, 'asset', { harden: hardenUploadResponse });
  }
  if (fetchThroughIfCopied(req, res, content, safePath)) return;
  hardenUploadResponse(res, content.filepath);
  res.sendFile(safePath);
});

/*
 * Every stored copy of this item, its state, and which one a read would use right now — the
 * "anything available" view (lib/storage/locations.describe). Org admin only: it names buckets and
 * keys. No credentials, no presigned URLs.
 */
router.get('/:id/locations', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!require('../lib/permissions').isOrgAdmin(req)) return res.status(403).json({ error: 'Organization admin required' });
  res.json(storageLocations.describe(content));
});

// Serve thumbnail
router.get('/:id/thumbnail', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(safePath) && storageServe.storedElsewhere(content)) {
    return storageServe.serveFromStorage(req, res, content, 'thumb', { harden: hardenUploadResponse });
  }
  if (fetchThroughIfCopied(req, res, content, safePath)) return;
  hardenUploadResponse(res, content.thumbnail_path);
  res.sendFile(safePath);
});

// Delete content
router.delete('/:id', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  // Validate UUID format to prevent LIKE wildcard injection in the snapshot scrub.
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid content ID format' });

  // #213: shared teardown (file removal + snapshot scrub + row delete). Returns the affected
  // device ids so we can push a refresh.
  // Deleting the item deletes its history and retained bytes with it, consistent with the file
  // (purgeContentRow, so POST /batch/delete does too). One transaction: the row and its history
  // rows go together or not at all.
  const affectedDevices = db.transaction(() => purgeContentRow(content))();
  pushContentUpdates(req, affectedDevices);
  res.json({ success: true, affectedDevices });
});

module.exports = router;
