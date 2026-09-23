'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { db } = require('../db/database');

/*
 * RESUMABLE UPLOADS — the session store and the bytes on disk.
 *
 * ⚠️ WHAT THIS IS FOR, in one measurement. A single-request upload has to finish inside the
 * shortest timeout anywhere between the browser and this process. On prod that is Cloudflare's, and
 * it is exactly 125 seconds: seven consecutive failures from one customer, 125.008s to 125.012s,
 * while his 65 SUCCESSFUL uploads in the same session peaked at 114.2s. He was living inside a
 * ten-second margin and did not know it. Every customer far from the origin is in the same
 * position; they have simply not hit it yet.
 *
 * A bigger timeout is not the fix, because the ceiling is not ours to raise and the failure scales
 * with file size. Smaller requests are: each chunk gets its own budget, so a 5 GB file is as safe
 * as a 5 MB one and a dropped connection costs one chunk instead of everything.
 *
 * ⚠️ THE OFFSET IS THE FILE SIZE, ALWAYS. It is never stored in a column. A counter would be a
 * second source of truth that can disagree with the bytes, and it would disagree precisely after a
 * crash mid-append — the case this feature exists to survive. `fs.statSync().size` cannot be wrong
 * about how many bytes are on the disk.
 */

/**
 * ⚠️ 5 MiB, AND IT IS SIZED FOR THE WORST LINK RATHER THAN THE AVERAGE.
 *
 * The average link never had this bug. On the ~4 Mbps uplink that produced the failures above, a
 * 5 MiB chunk takes about ten seconds — a twelvefold margin against the 125s ceiling. At 1 Mbps it
 * is forty seconds, still threefold. Larger chunks would mean fewer round trips on a fast
 * connection and a return to the exact cliff this replaces on a slow one.
 */
const CHUNK_SIZE = 5 * 1024 * 1024;

/** Sessions idle this long are collectable. Long enough that a stalled-but-alive client recovers. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function incomingDir() {
  // ⚠️ NOT config.contentDir. /uploads/content is served statically, so a partial file there is
  // web-reachable from the dashboard's own origin BEFORE upload-sniff has read a byte of it — an
  // unvalidated, caller-influenced file on a trusted origin. This directory is served by nothing.
  return path.join(config.uploadsDir, 'incoming');
}

function partPath(session) {
  return path.join(incomingDir(), session.part_name);
}

/** Bytes actually on disk for this session. The single source of truth for "where are we". */
function offsetOf(session) {
  try {
    return fs.statSync(partPath(session)).size;
  } catch (_) {
    return 0;   // not yet created == nothing received
  }
}

function get(id, workspaceId) {
  if (!id) return null;
  return db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND workspace_id = ?').get(id, workspaceId) || null;
}

/**
 * Open a session. The part file is created empty so the offset is answerable immediately —
 * a HEAD before the first chunk must say 0, not 404.
 */
function create({ workspaceId, userId, filename, declaredSize, folderId = null }) {
  fs.mkdirSync(incomingDir(), { recursive: true });
  const id = uuidv4();
  const partName = `${id}.part`;
  fs.writeFileSync(path.join(incomingDir(), partName), '');
  db.prepare(
    `INSERT INTO upload_sessions (id, workspace_id, user_id, filename, declared_size, folder_id, part_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, userId, String(filename || 'upload'), Number(declaredSize) || 0, folderId || null, partName);
  return db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id);
}

/**
 * Append one chunk at [expectedOffset].
 *
 * ⚠️ STRICTLY SEQUENTIAL, and the 409 is a feature. Out-of-order writes would mean sparse files,
 * a separate record of which ranges have landed, and a resume that has to reconcile the two. A
 * refusal that NAMES the current offset lets a confused client — one that retried a chunk it had
 * already sent, or lost a response — correct itself in one round trip with no state of its own.
 *
 * @returns {{ok:true, offset:number} | {ok:false, status:number, error:string, offset:number}}
 */
function append(session, expectedOffset, buffer) {
  const current = offsetOf(session);

  if (Number(expectedOffset) !== current) {
    return {
      ok: false, status: 409, offset: current,
      error: `offset mismatch: this upload is at ${current}`,
    };
  }

  const size = buffer ? buffer.length : 0;
  if (size === 0) return { ok: true, offset: current };

  /*
   * The declared size is a CEILING, enforced here rather than trusted. A client that declares 10 MB
   * and streams for ever would otherwise fill the disk one honest-looking chunk at a time, and the
   * storage allowance was checked once, at create, against a number the same client chose.
   */
  if (current + size > session.declared_size) {
    return {
      ok: false, status: 413, offset: current,
      error: `this upload declared ${session.declared_size} bytes and is trying to exceed it`,
    };
  }

  fs.appendFileSync(partPath(session), buffer);
  const next = offsetOf(session);
  db.prepare("UPDATE upload_sessions SET updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?")
    .run(session.id);
  return { ok: true, offset: next };
}

/**
 * Move the finished part into contentDir and describe it the way multer would have.
 *
 * ⚠️ THE MOVE IS NOT OPTIONAL, AND A TEST FOUND OUT WHY. upload-sniff.finalizeUpload renames the
 * file *within its own directory* — `path.dirname(file.path)` — because multer always wrote it
 * straight into contentDir. Hand it a file in `incoming/` and it renames it there, reports the bare
 * filename, and the content row then points at `contentDir/<uuid>.<ext>` which does not exist. The
 * upload returns 201 and the media is unplayable. The symptom that surfaced was a NULL byte_digest;
 * the actual damage was a broken row.
 *
 * So the bytes enter contentDir at the LAST possible moment — still named `.part`, still unsniffed,
 * one statement before the sniffer looks at them. Same filesystem, so the rename is atomic and free.
 * Up to here they lived in `incoming/`, which nothing serves; see the note on incomingDir().
 *
 * After this, lib/content-ingest.ingestUploadedFile does every downstream thing exactly as it does
 * for a form upload — sniff, bundle validation, ffprobe, thumbnails, digest, row, plugin hook.
 */
function stageForIngest(session) {
  const size = offsetOf(session);
  const staged = path.join(config.contentDir, session.part_name);
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.renameSync(partPath(session), staged);
  return {
    path: staged,
    originalname: session.filename,
    size,
    // Deliberately a placeholder: the caller does not get to choose the type. finalizeUpload reads
    // the bytes and decides, exactly as it does for a single-shot upload.
    mimetype: 'application/octet-stream',
  };
}

/** True when every declared byte has arrived. */
function isComplete(session) {
  return offsetOf(session) === session.declared_size && session.declared_size > 0;
}

function forget(id) {
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(id);
}

/** Drop the session and its bytes. Used on abandon, on a failed finalize, and by the sweeper. */
function discard(session) {
  try { fs.unlinkSync(partPath(session)); } catch (_) { /* already gone */ }
  forget(session.id);
}

/**
 * Collect abandoned sessions.
 *
 * ⚠️ DELETES BY ROW, NEVER BY GLOB. A pattern like `incoming/*.part` looks equivalent and is not:
 * it would also match the file an in-flight upload is appending to right now, and a widened or
 * mistyped glob is how this project has twice deleted more than it meant to. Every unlink below
 * comes from a row whose id we hold and whose idle time we measured.
 *
 * Orphan part files with NO row are reported, not removed — that asymmetry is deliberate. A file
 * without a row means something failed in a way I did not predict, and quietly deleting the
 * evidence of an unknown bug is how it stays unknown.
 */
function sweep({ ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  const cutoff = Math.floor((now - ttlMs) / 1000);
  const stale = db.prepare('SELECT * FROM upload_sessions WHERE updated_at < ?').all(cutoff);
  let bytes = 0;
  for (const s of stale) {
    bytes += offsetOf(s);
    discard(s);
  }

  let orphans = 0;
  try {
    const known = new Set(db.prepare('SELECT part_name FROM upload_sessions').all().map((r) => r.part_name));
    for (const f of fs.readdirSync(incomingDir())) {
      if (!known.has(f)) orphans++;
    }
  } catch (_) { /* directory may not exist yet */ }

  if (stale.length || orphans) {
    console.log(`[uploads] swept ${stale.length} abandoned session(s), ${Math.round(bytes / 1048576)}MB`
      + (orphans ? `; ⚠️ ${orphans} orphan part file(s) with no session row — left in place deliberately` : ''));
  }
  return { swept: stale.length, bytes, orphans };
}

let _sweepTimer = null;
function startSweep(intervalMs = 60 * 60 * 1000) {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => { try { sweep(); } catch (e) { console.warn(`[uploads] sweep: ${e.message}`); } }, intervalMs);
  if (_sweepTimer.unref) _sweepTimer.unref();
}
function stopSweep() { if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; } }

module.exports = {
  CHUNK_SIZE, SESSION_TTL_MS,
  create, get, append, offsetOf, isComplete, stageForIngest, discard, forget,
  sweep, startSweep, stopSweep, incomingDir, partPath,
};
