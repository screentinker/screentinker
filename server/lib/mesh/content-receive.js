'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const contentSync = require('./content-sync');
const meshAudit = require('./audit');
const { downloadResumable } = require('./pull-download');

/*
 * RECEIVING A CONTENT PUSH — the orchestration, on the node that owns the screens.
 *
 * The decisions all live elsewhere and are deliberately not repeated here: content-sync decides
 * what is actually needed (checking the DISK, not just the rows), whether the edge may send it at
 * all, and whether each arrived file is what it claimed. This walks that sequence and moves bytes.
 *
 * ⚠️ THE ORDER IS THE DESIGN. Evaluate, admit, THEN transfer. A transfer that discovers the limit
 * halfway has already spent the disk it was meant to protect and leaves a half-populated playlist
 * to explain — so both the allowance and the free space are settled before a single byte moves.
 *
 * ⚠️ THE URL COMES FROM OUR OWN EDGE ROW, NEVER FROM THE MESSAGE. The parent supplies a ticket, not
 * a location. A peer that could name the host to fetch from could point this node at anything on
 * its network and have it download the result with the node's own credentials — and it would look
 * exactly like a normal content push. peer_url is what this node dialled when its operator set the
 * link up; it is the only address that has ever been consented to (I7).
 */

/*
 * ⚠️ Wrapped for the same reason as applyWrite: this returns from several places — a missing
 * workspace, a grant that does not cover it, a manifest that cannot be read, an allowance or a disk
 * that will not take it, and the per-file results — and the refusals are the ones an operator most
 * wants to see. One record, from one return value.
 */
async function receiveContentOffer(db, edge, req, deps = {}) {
  const outcome = await receiveContentOfferInner(db, edge, req, deps);
  meshAudit.recordPeerAction(db, edge, {
    action: 'mesh:content-push',
    ok: !!(outcome && outcome.ok),
    reason: outcome && outcome.reason,
    actor: req && req.actor,
    workspaceId: req && req.workspaceId,
    userId: deps && deps.userId,
    // A count is what an operator reads first: "12 files" answers the question that "ok" does not.
    path: outcome && Array.isArray(outcome.stored)
      ? `${outcome.stored.length} file(s) stored, ${(outcome.alreadyHeld || []).length} already here`
      : null,
    method: null,
  });
  return outcome;
}

/** One asset at a time. See the note at the transfer loop. */
async function receiveContentOfferInner(db, edge, req, deps = {}) {
  const contentDir = deps.contentDir;
  if (!contentDir) return { ok: false, reason: 'This server is not configured to receive content.' };

  const manifest = req && req.manifest;
  const tickets = (req && req.tickets && typeof req.tickets === 'object') ? req.tickets : {};
  const workspaceId = req && req.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string') {
    return { ok: false, reason: 'A content push must name a workspace on this server.' };
  }

  /*
   * ⚠️ THE WORKSPACE IS CHECKED AGAINST THE GRANT BEFORE ANYTHING ELSE, and against this node's own
   * stored scope rather than anything in the message. Without this a peer holding content-push for
   * one workspace could deposit files into another — the byte budget would still be honoured, and
   * the files would still land somewhere their operator never agreed to.
   */
  const grants = require('./grants');
  const writeGrant = safeList(edge && edge.write_grant);
  const writeScope = safeList(edge && edge.write_scope);
  if (!grants.writeAllows(writeGrant, writeScope, 'content-push', workspaceId)) {
    return { ok: false, reason: require('./write-proxy').REFUSED };
  }

  const evaluation = contentSync.evaluateManifest(db, edge, manifest, { contentDir, workspaceId });
  if (!evaluation.ok) return evaluation;

  const admit = contentSync.admitTransfer(edge, evaluation.bytesNeeded, { ...deps, contentDir });
  if (!admit.ok) return admit;

  const peerUrl = edge && edge.peer_url;
  if (evaluation.need.length && !peerUrl) {
    return { ok: false, reason: 'This server does not know how to reach the other one.' };
  }

  const stored = [];
  const failed = [];

  /*
   * ⚠️ SEQUENTIAL, ON PURPOSE. This runs on the same box that is decoding video for the screen in
   * front of somebody. Four concurrent 400 MB downloads is a saturated link and a stuttering wall,
   * and the operator would blame the playlist. Content arriving an hour later than it might have is
   * invisible; playback stuttering while it arrives is not.
   */
  for (const item of evaluation.need) {
    const ticket = tickets[item.oid];
    if (!ticket || typeof ticket !== 'string') {
      failed.push({ oid: item.oid, reason: 'The other server did not offer a way to fetch that file.' });
      continue;
    }

    const entry = findEntry(manifest, item.oid);
    if (!entry) { failed.push({ oid: item.oid, reason: 'That entry vanished from the manifest.' }); continue; }

    const stagedPath = path.join(contentDir, `mesh-${crypto.randomUUID()}.part`);
    let result;
    try {
      result = await downloadResumable({
        url: `${String(peerUrl).replace(/\/+$/, '')}/api/mesh/pull/${encodeURIComponent(ticket)}`,
        stagedPath,
        expectedBytes: item.sz,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
    } catch (e) {
      result = { ok: false, reason: (e && e.message) || 'the transfer failed' };
    }

    if (!result.ok) {
      safeUnlink(stagedPath);
      failed.push({ oid: item.oid, reason: result.reason });
      continue;
    }

    /*
     * Verification, renaming, the row and the allowance all happen in there — and every one of them
     * before the file is visible under its final name. A failure leaves nothing behind but the
     * staged file, which is removed here.
     */
    const commit = await contentSync.commitStagedAsset(db, edge, entry, stagedPath, {
      contentDir, workspaceId, userId: deps.userId, sniff: deps.sniff, now: deps.now,
    });
    if (!commit.ok) {
      safeUnlink(stagedPath);
      failed.push({ oid: item.oid, reason: commit.reason });
      continue;
    }
    stored.push({ oid: item.oid, localId: commit.localId, bytes: commit.bytes, reusedRow: !!commit.reusedRow });
  }

  /*
   * ⚠️ REPORTED PER ITEM RATHER THAN AS ONE VERDICT, and the caller is told plainly if anything
   * failed. "Mostly worked" is the answer that gets a playlist published with a hole in it, and the
   * hub operator has no other way to find out — they are not standing in front of the screen.
   */
  return {
    ok: failed.length === 0,
    stored,
    alreadyHeld: evaluation.have,
    failed,
    cannot: evaluation.cannot,
    ...(failed.length ? { reason: `${failed.length} of ${evaluation.need.length} files could not be stored.` } : {}),
  };
}

function findEntry(manifest, oid) {
  const list = (manifest && Array.isArray(manifest.content)) ? manifest.content : [];
  return list.find((e) => e && e.oid === oid) || null;
}

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

function safeList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []; }
  catch (e) { return []; }
}

/*
 * ⚠️ STALE `.part` FILES ARE SWEPT, because a crash mid-transfer leaves a full-size orphan in the
 * content directory that nothing else will ever look at. They are named distinctly so this cannot
 * touch an in-flight upload from the ordinary path, and an age floor keeps it off transfers that
 * are merely slow — a 400 MB file over a bad link legitimately takes hours.
 */
function sweepStagedParts(contentDir, { olderThanMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(contentDir); } catch (e) { return { removed: 0 }; }
  for (const name of names) {
    if (!name.startsWith('mesh-') || !name.endsWith('.part')) continue;
    const p = path.join(contentDir, name);
    try {
      if (now() - fs.statSync(p).mtimeMs > olderThanMs) { fs.unlinkSync(p); removed += 1; }
    } catch (e) { /* best effort */ }
  }
  return { removed };
}

module.exports = { receiveContentOffer, sweepStagedParts };
