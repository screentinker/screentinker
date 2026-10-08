'use strict';

/*
 * Replace a content item's BYTES while keeping its id: the one operation that can make a player's
 * cached copy wrong, so the one place the revision bump, version history, approval drafts, storage
 * placement and device pushes all happen together.
 *
 * Shared by PUT /api/content/:id/replace and anything else that refreshes an item from a source it
 * was imported from (lib/canva.js sync). It was inline in the route; a second caller with its own
 * copy is how the old image-only replace got three things wrong (see the comments below).
 *
 * `file` is a multer-shaped object for a file already written under config.contentDir as
 * `<uuid>.part` ({ path, size, originalname }). `reqOrIo` is an Express request or a socket.io
 * server — whichever the caller has — and is used only to push the change to screens.
 * Resolves { status, body }; the caller decides how to answer.
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const { db } = require('../db/database');
const htmlBundle = require('./html-bundle');
const { finalizeUpload } = require('./upload-sniff');
const { deriveMediaMetadata } = require('./content-ingest');
const { digestFile } = require('./content-digest');
const { unlinkIfUnreferenced } = require('./content-files');
const storageLocations = require('./storage/locations');
const { devicesPlayingContent } = require('./devices-playing');

const reply = (status, body) => ({ status, body });

function pushDevices(reqOrIo, deviceIds) {
  try {
    const io = reqOrIo && reqOrIo.app ? reqOrIo.app.get('io') : reqOrIo;
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('./command-queue');
    const deviceNs = io.of('/device');
    for (const id of new Set(deviceIds)) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, id, buildPlaylistPayload);
    }
  } catch (e) { /* silent */ }
}

async function replaceContentBytes({ content, file, actor, reqOrIo = null }) {
  const policy = require('./release-policy');
  const revisions = require('./revisions');
  const approvalOn = !!(content.workspace_id && policy.approvalRequired(db, content.workspace_id));

  // Same content-derived naming as the main ingest path (lib/upload-sniff) — the caller
  // does not choose the extension here either. A non-media upload 400s.
  let filepath, mime;
  try { ({ filepath, mime } = finalizeUpload(file)); }
  catch (e) { return reply(e.status || 400, { error: e.message }); }

  /*
   * ⚠️ A REPLACE MAY NOT CROSS THE BUNDLE BOUNDARY, IN EITHER DIRECTION.
   *
   * Replacing a video with an image is deliberately allowed — the item still plays, it just plays
   * something else. A bundle is different in kind: mime_type is what every player switches on, and
   * ws/deviceSocket.js re-stamps it into the live payload at send time, so swapping a JPEG for a
   * bundle changes what every screen must DO with that item, with no republish, no operator
   * confirmation and nothing in any log. A player that cannot render bundles would simply stop.
   */
  const wasBundle = content.mime_type === htmlBundle.BUNDLE_MIME;
  const isBundle = mime === 'application/zip' || mime === htmlBundle.BUNDLE_MIME;
  if (wasBundle !== isBundle) {
    try { fs.unlinkSync(path.join(config.contentDir, filepath)); } catch (e) { /* best effort */ }
    return reply(400, {
      error: wasBundle
        ? 'This item is an HTML bundle — replace it with another bundle, or delete it and add the new file.'
        : 'An HTML bundle cannot replace a media file. Add it as new content instead.',
    });
  }

  /* Re-derived from the NEW archive, for the same reason byte_digest is re-hashed below: the row
   * keeps its id while its contents change, and an entry point carried over from the old bytes
   * names a file the new archive may not contain. */
  let bundleEntry = null;
  if (isBundle) {
    try {
      const info = await htmlBundle.validateBundle(path.join(config.contentDir, filepath));
      bundleEntry = info.entryPoint;
      mime = htmlBundle.BUNDLE_MIME;
    } catch (e) {
      try { fs.unlinkSync(path.join(config.contentDir, filepath)); } catch (e2) { /* best effort */ }
      return reply(e.status || 400, { error: e.message });
    }
  }

  // Re-derive EVERYTHING the bytes decide, through the SAME function the upload path uses.
  // This route used to carry a shorter copy that handled images only, and got three things
  // wrong that an upload gets right:
  //   - a replaced VIDEO lost its duration (the row kept the OLD clip's length, so #237's
  //     "default an item to the clip's own length" then handed out the wrong number), its
  //     dimensions, and its thumbnail;
  //   - a replaced IMAGE was measured with raw sharp metadata instead of imageDisplayDims and
  //     thumbnailed without .rotate(), re-introducing the EXIF-orientation bug (#170) that
  //     ingest fixes — a portrait photo came back landscape with blue bars;
  //   - both left width/height NULL for video, which is what the orientation-aware paths read.
  const { width, height, durationSec, thumbnailPath } = await deriveMediaMetadata(file.path, filepath, mime);

  // Bump the revision: this is the ONLY operation in the product that changes an asset's bytes
  // without changing its id, so it is the only thing that can make a player's cached copy wrong.
  // Players key their media cache on the revision, so this is what evicts it.
  //
  // strftime seconds can collide with the previous value if a replace lands inside the same second
  // as the upload (a small file, a scripted replace) — and a revision that does not change is a
  // cache that never updates. MAX(now, previous + 1) guarantees it moves.
  // duration_sec comes from the NEW bytes. COALESCE-to-NULL rather than keeping the old value:
  // a replace that turns a video into an image genuinely has no duration, and a stale one would
  // silently become the default for every later playlist add (lib/item-duration.js).
  /*
   * ⚠️ byte_digest IS RE-HASHED FROM THE NEW BYTES, OR THE DIGEST BECOMES A LIE.
   *
   * This is the writer the column's migration note flags most sharply: the row keeps its id and
   * filepath while its CONTENT changes, so a digest carried over from the old bytes describes a
   * file that no longer exists. A mesh peer asking "do you already have this asset?" would then be
   * told yes — matching digest, file present on disk — for ever, and its push would be skipped
   * while the screen played the operator's local replacement instead.
   */
  let newDigest = null;
  try { newDigest = await digestFile(path.join(config.contentDir, filepath)); } catch (e) { newDigest = null; }

  if (approvalOn) {
    const prevDraft = revisions.parseJson(content.draft_json, null) || {};
    revisions.disposeDraftFiles(db, content.id, prevDraft, content);
    const { filepath: _f, thumbnail_path: _t, ...prevFields } = prevDraft;   // keep pending URL/caption edits, drop the old bytes
    const draft = { ...prevFields, filepath, mime_type: mime, file_size: file.size, thumbnail_path: thumbnailPath, width, height, duration_sec: durationSec, byte_digest: newDigest, bundle_entry: bundleEntry };
    db.prepare('UPDATE content SET draft_json = ? WHERE id = ?').run(JSON.stringify(draft), content.id);
    revisions.recordCurrent(db, 'content', content.id, { actor, summary: 'Replaced file (draft)' });
    return reply(200, { ...db.prepare('SELECT * FROM content WHERE id = ?').get(content.id), draft: true, pending_review: true });
  }

  // Delete old file and thumbnail — but only if no other row still points at them. A
  // mesh-received asset is named after its bytes and can legitimately back one row per
  // workspace; replacing one customer's copy must not empty another's screen.
  /*
   * Version history: the bytes being replaced are RETAINED under .history (a move when this row
   * is their only reference, a copy otherwise), and every revision that described them is
   * repointed there, so the previous version stays restorable. Approval on: the new bytes land as
   * a DRAFT next to the live file and nothing a screen shows changes until the draft is reviewed
   * and published (lib/releases.js releaseContentDraft) — that branch returned above.
   *
   * ⚠️ THIS RUNS ONLY ONCE THE NEW BYTES HAVE PASSED EVERY CHECK. It used to run first, before the
   * sniffer, the bundle-boundary check and validateBundle — so a refused replace (a .zip picked for
   * an image, a corrupt file) answered 400 with the row unchanged but its live file already moved
   * into .history and no revision repointed at it. Every screen without a cached copy lost the
   * item, the thumbnail vanished, and restore could not find the old bytes. Nothing may touch the
   * live file until the replacement is certain to be written.
   */
  /*
   * The new bytes go where this workspace writes BEFORE anything about the old ones changes
   * (lib/storage) — the same order the rule above demands of the sniffer. A refused put answers 502
   * with the live row and its file untouched.
   */
  const placedFiles = [{ kind: 'asset', abs: path.join(config.contentDir, filepath), basename: filepath, digest: newDigest }];
  if (thumbnailPath && thumbnailPath !== filepath) placedFiles.push({ kind: 'thumb', abs: path.join(config.contentDir, thumbnailPath), basename: thumbnailPath });
  let storagePlan;
  try {
    storagePlan = await storageLocations.placeFiles({ workspaceId: content.workspace_id, files: placedFiles, mime });
  } catch (e) {
    for (const f of placedFiles) { try { fs.unlinkSync(f.abs); } catch (_) { /* already gone */ } }
    return reply(502, { error: `The file could not be stored: ${e && /Storage/.test(e.name || '') ? e.message : 'the storage backend refused it.'}`, code: 'STORAGE_WRITE_FAILED' });
  }

  const prev = revisions.latest(db, 'content', content.id);
  const tag = prev ? `r${prev.rev_no}` : 'r0';
  const retainedFile = revisions.retainContentFile(db, content.id, content.filepath, tag);
  const retainedThumb = revisions.retainContentFile(db, content.id, content.thumbnail_path, tag);
  if (!retainedFile) unlinkIfUnreferenced(content.filepath, content.id, 'filepath');
  if (!retainedThumb) unlinkIfUnreferenced(content.thumbnail_path, content.id, 'thumbnail_path');

  db.transaction(() => {
    if (retainedFile) db.prepare('UPDATE revisions SET file_ref = ? WHERE resource_type = ? AND resource_id = ? AND file_ref = ?').run(retainedFile, 'content', content.id, content.filepath);
    if (retainedThumb) db.prepare('UPDATE revisions SET thumb_ref = ? WHERE resource_type = ? AND resource_id = ? AND thumb_ref = ?').run(retainedThumb, 'content', content.id, content.thumbnail_path);
    db.prepare(`UPDATE content
                   SET filepath = ?, mime_type = ?, file_size = ?, thumbnail_path = ?, width = ?, height = ?,
                       duration_sec = ?, byte_digest = ?, bundle_entry = ?,
                       updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at, 0), created_at) + 1)
                 WHERE id = ?`)
      .run(filepath, mime, file.size, thumbnailPath, width, height, durationSec, newDigest, bundleEntry, content.id);
    // Copies of the OLD bytes that were not retained above are not this row's any more.
    const stale = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind IN ('asset','thumb')").all(content.id);
    db.prepare("DELETE FROM content_locations WHERE content_id = ? AND kind IN ('asset','thumb')").run(content.id);
    storageLocations.queueRelease(stale);
    db.prepare('UPDATE content SET storage_profile_id = NULL, object_key = NULL WHERE id = ?').run(content.id);
    storagePlan.commit(content.id);
    revisions.recordCurrent(db, 'content', content.id, { actor, summary: 'Replaced file' });
  })();
  storagePlan.cleanup();

  const affected = devicesPlayingContent(content.id);
  pushDevices(reqOrIo, affected);
  // CORPORATE: a replaced video can be LONGER than a store slot allows. Re-judge every slot fill that
  // plays it; one now over the limit stops playing (over_limit) until the store fixes it (spec §3.4).
  try { require('./corporate/fanout').recheckFillsForContent(reqOrIo, content.id); } catch (e) { console.warn(`[content] fill re-check failed: ${e && e.message}`); }

  return reply(200, db.prepare('SELECT * FROM content WHERE id = ?').get(content.id));
}

// pushDevices: also used by lib/cloud-folders.js after it retires a synced item.
module.exports = { replaceContentBytes, pushDevices };
