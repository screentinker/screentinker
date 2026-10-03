'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digestFile, digestFilename } = require('../content-digest');
const uploadSniff = require('../upload-sniff');

/*
 * ⚠️ THE REAL SNIFFER. `deps.sniffExt` was called here and never implemented anywhere — the only
 * thing that ever satisfied it was the test's own `() => '.mp4'`, so the loudest safety comment in
 * this file was covered by a stub that never sniffed anything. That is the same lesson as the
 * unawaited promise two commits ago: a stub simpler than its collaborator tests the stub.
 *
 * Returns BOTH the type and the extension, because they have to come from the same reading of the
 * same bytes. Deriving the extension from the file while taking mime_type from the peer's manifest
 * is how a PNG gets stored as <sha>.png and announced to the player as video/mp4 — a black frame
 * for the item's whole duration, on every screen in the playlist.
 */
/** Free bytes on the filesystem holding `dir`, or null when it cannot be measured. */
function defaultFreeBytes(dir) {
  if (!dir || typeof fs.statfsSync !== 'function') return null;
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return null;
  }
}

function defaultSniff(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(uploadSniff.SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, uploadSniff.SNIFF_BYTES, 0);
    const mime = uploadSniff.sniffMime(buf.subarray(0, n));
    const ext = mime ? uploadSniff.MIME_TO_EXT[mime] : null;
    return (mime && ext) ? { mime, ext } : null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* best effort */ } }
  }
}
const grants = require('./grants');

/*
 * Receiving content a hub wants to put on this node's screens.
 *
 * ⚠️ THE ORDER IS THE DESIGN, AND IT IS NOT NEGOTIABLE:
 *
 *   stage -> verify -> rename -> commit metadata -> (only then) the playlist write
 *
 * Every other order has a known failure, and two of them are documented incidents in this codebase:
 *
 *   COMMIT BEFORE RENAME — the content row names a file that does not exist yet, and
 *   refreshContentRevs re-stamps that filepath onto every panel's payload AT SEND TIME. Panels
 *   fetch it and 404. That is the "replacing an asset 404'd every web and BrightSign panel"
 *   incident, reproduced deliberately.
 *
 *   RENAME BEFORE VERIFY — a corrupt or truncated asset goes live under Cache-Control immutable
 *   for 30 days, and Android's cache validates the BYTE COUNT rather than the content, so a short
 *   file with a matching Content-Length is promoted as valid.
 *
 *   PUBLISH BEFORE EVERYTHING IS PRESENT — the player declares its URL list to the service worker
 *   as the COMPLETE set with prune:true, so a half-transferred playlist does not merely fail to
 *   play the new item, it EVICTS the cached bytes of everything that was working. On exactly the
 *   site whose link was bad enough to make the transfer slow.
 *
 * ⚠️ ALL OR NOTHING. If any asset fails, nothing is committed and the node's state is identical to
 * before. There is no "apply 4 of 6": a short playlist that publishes successfully is the silent
 * failure — the operator is told it worked and the wall is missing two items.
 */

/*
 * A single asset may not claim more than this. Bounds one malformed or hostile entry from
 * exhausting an allowance in one go, and gives Number.isFinite something to be finite against.
 * Deliberately generous — it is a sanity bound, not a policy; policy is the operator's budget.
 */
const MAX_ASSET_BYTES = 32 * 1024 * 1024 * 1024;

const MAX_MANIFEST_ENTRIES = 500;   // matches the envelope's item cap

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

/**
 * Given a hub's manifest, what does this node actually need?
 *
 * ⚠️ "Have a row" is NOT the same as "have the bytes". In a typical library a large fraction of
 * content rows have no file on disk — restores, migrations, and manual cleanups all produce them.
 * A check that stops at the row would report a playlist ready and then play nothing.
 *
 * @returns {{ok:true, need:Array, have:Array, cannot:Array, bytesNeeded:number}
 *          |{ok:false, reason:string}}
 */
function evaluateManifest(db, edge, manifest, deps = {}) {
  const contentDir = deps.contentDir;
  if (!contentDir) return { ok: false, reason: 'This server is not configured to receive content.' };

  const entries = (manifest && Array.isArray(manifest.content)) ? manifest.content : null;
  if (!entries) return { ok: false, reason: 'That manifest is not readable.' };
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    return {
      ok: false,
      reason: `That manifest lists ${entries.length} items; this server takes ` +
              `${MAX_MANIFEST_ENTRIES} at a time. Send it in pages.`,
    };
  }

  const originNodeId = edge && edge.peer_node_id;
  const need = []; const have = []; const cannot = [];

  for (const e of entries) {
    if (!e || typeof e.oid !== 'string') { cannot.push({ oid: null, why: 'An entry had no id.' }); continue; }

    /*
     * ⚠️ A DECLARED SIZE IS MANDATORY, AND THIS IS THE BUDGET'S ONLY FOOTING.
     *
     * Every byte limit downstream is computed from the sum of these numbers, so an entry that
     * simply omits `sz` contributed 0 — `Number(undefined) || 0` — and a manifest of such entries
     * needed "nothing", which every budget and every free-space floor permits. The transfer then
     * arrived at whatever size it liked. A JSON string, a negative, a NaN and an Infinity all did
     * the same thing, and the later per-file size verification was itself written as
     * `if (typeof entry.sz === 'number')`, so the string form skipped that too.
     *
     * The declared size is still only a claim — it is checked again against statSync before the
     * bytes are committed — but a claim that must be made is what turns the budget from decoration
     * into a limit. Refused per entry rather than rejecting the whole manifest, so a hub with one
     * malformed row is told which one.
     */
    if (!Number.isFinite(e.sz) || e.sz < 0 || e.sz > MAX_ASSET_BYTES) {
      cannot.push({ oid: e.oid, why: 'That entry did not declare a usable size.' });
      continue;
    }

    /*
     * Remote and YouTube items have no local bytes and never will. They still need a ROW — the
     * child's own playlist route refuses an item whose content_id does not resolve — so they
     * participate fully in the metadata closure and not at all in the byte closure. Listing them
     * explicitly is also what lets a hub say "3 of 9 items will not work offline on this site"
     * rather than succeeding quietly.
     */
    if (e.kind === 'remote' || e.kind === 'youtube') {
      have.push({ oid: e.oid, matched: 'no-bytes', kind: e.kind });
      continue;
    }

    const prov = db.prepare(`SELECT local_content_id FROM mesh_content_provenance
                              WHERE origin_node_id = ? AND origin_content_id = ?`)
      .get(originNodeId, e.oid);

    if (prov) {
      const row = db.prepare('SELECT id, filepath, byte_digest FROM content WHERE id = ?')
        .get(prov.local_content_id);
      // ⚠️ The row can exist while the bytes do not. Check the disk, not the database.
      const onDisk = row && row.filepath &&
        fs.existsSync(path.join(contentDir, path.basename(row.filepath)));
      if (row && onDisk && (!e.dg || !row.byte_digest || row.byte_digest === e.dg)) {
        have.push({ oid: e.oid, localId: row.id, matched: 'provenance' });
        continue;
      }
      need.push({ oid: e.oid, why: onDisk ? 'digest-mismatch' : 'bytes-missing', sz: Number(e.sz) || 0 });
      continue;
    }

    /*
     * No provenance, but we may already hold these exact bytes from somewhere else — a sibling
     * site, an earlier manual upload, the same stock clip. Costs one indexed lookup and saves the
     * entire transfer.
     */
    if (e.dg) {
      /*
       * ⚠️ SCOPED TO THE WORKSPACE THIS PUSH IS FOR. Without the predicate this returns a row from
       * ANY workspace on the node, so the first time two customers on one server happened to hold
       * the same stock clip, one customer's playlist would start pointing at the other's asset —
       * and deleting it from one library would empty a screen in the other. The schema note beside
       * byte_digest warns about exactly this; the query did not honour it.
       */
      const byDigest = deps.workspaceId
        ? db.prepare('SELECT id, filepath FROM content WHERE byte_digest = ? AND workspace_id = ? LIMIT 1')
            .get(e.dg, deps.workspaceId)
        : null;
      if (byDigest && byDigest.filepath &&
          fs.existsSync(path.join(contentDir, path.basename(byDigest.filepath)))) {
        have.push({ oid: e.oid, localId: byDigest.id, matched: 'digest' });
        continue;
      }
    }
    need.push({ oid: e.oid, why: 'absent', sz: Number(e.sz) || 0 });
  }

  const bytesNeeded = need.reduce((n, x) => n + (x.sz || 0), 0);
  return { ok: true, need, have, cannot, bytesNeeded };
}

/**
 * May this edge send us these bytes at all?
 *
 * ⚠️ CHECKED BEFORE ANY BYTES MOVE. A transfer that discovers the limit halfway has already spent
 * the disk it was meant to protect, and leaves a half-populated playlist to explain. The same
 * applies to free space: refuse at negotiation, never mid-transfer.
 */
function admitTransfer(edge, bytesNeeded, deps = {}) {
  const grant = parseList(edge && edge.write_grant);
  if (!grant.includes('content-push')) {
    return { ok: false, reason: 'This connection may not send content to this server.' };
  }

  const budget = typeof edge.write_bytes_budget === 'number' ? edge.write_bytes_budget : null;
  const used = Number(edge.write_bytes_used) || 0;
  if (!grants.budgetAllows(budget, used, bytesNeeded)) {
    return {
      ok: false,
      reason: budget === null
        ? 'This connection has no storage allowance on this server.'
        : `That needs ${grants.describeBytes(bytesNeeded)}, and only ` +
          `${grants.describeBytes(Math.max(0, budget - used))} of the ` +
          `${grants.describeBytes(budget)} allowance is left.`,
    };
  }

  /*
   * ⚠️ And the disk itself, which the allowance knows nothing about. A budget is what the operator
   * agreed to give; free space is what the machine actually has, and the second can be smaller. A
   * full disk on a signage server takes the screens down with it.
   */
  const freeFloor = typeof deps.freeFloorBytes === 'number' ? deps.freeFloorBytes : 1024 * 1024 * 1024;
  /*
   * ⚠️ DEFAULTED TO A REAL MEASUREMENT. This read `deps.freeBytes` and nothing ever supplied one,
   * so `free` was null on every real call and the whole disk check was skipped — the comment above
   * described a guard that never ran. A budget is what the operator agreed to give; free space is
   * what the machine actually has, and the second can be smaller.
   *
   * Measured against the directory the bytes will LAND in, not the process's cwd — on a signage box
   * the content directory is very often a mounted disk while the root filesystem is a small card,
   * and checking the wrong one gives a confident answer about the wrong number.
   *
   * If the measurement itself fails the check is skipped rather than failing closed: statfs is
   * unavailable on some platforms this runs on, and refusing every transfer on a box that cannot
   * measure its own disk would break the feature for a diagnostic. The budget still bounds it.
   */
  const free = typeof deps.freeBytes === 'function' ? deps.freeBytes() : defaultFreeBytes(deps.contentDir);
  if (free !== null && free - bytesNeeded < freeFloor) {
    return {
      ok: false,
      reason: `This server does not have room for ${grants.describeBytes(bytesNeeded)} right now.`,
    };
  }
  return { ok: true };
}

/**
 * Commit one staged asset: verify, rename, insert, record provenance — in a single transaction.
 *
 * @param {string} stagedPath  the `.part` file already written to contentDir
 * @param {object} entry       the manifest entry it was staged for
 */
async function commitStagedAsset(db, edge, entry, stagedPath, deps) {
  const { contentDir, workspaceId, userId, now = () => Date.now() } = deps;
  const sniff = typeof deps.sniff === 'function' ? deps.sniff : defaultSniff;

  let stat;
  try { stat = fs.statSync(stagedPath); } catch (e) {
    return { ok: false, reason: 'The transferred file is not there.' };
  }

  /*
   * ⚠️ Size from the DISK, never from the wire. The manifest is a claim; statSync is a fact.
   *
   * Unconditional. This was written `if (typeof entry.sz === 'number')`, so an entry that sent its
   * size as a JSON string skipped the check entirely and could be any length — the same omission
   * that let it through the budget upstream. evaluateManifest now refuses an entry without a finite
   * size, and this asserts that rather than trusting it.
   */
  if (!Number.isFinite(entry.sz) || stat.size !== entry.sz) {
    return { ok: false, reason: `That file arrived ${stat.size} bytes, not the ${entry.sz} promised.` };
  }

  const digest = await digestFile(stagedPath);
  if (!digest) return { ok: false, reason: 'The transferred file could not be read back.' };
  if (entry.dg && entry.dg !== digest) {
    return { ok: false, reason: 'The transferred file does not match its checksum.' };
  }

  /*
   * ⚠️ SNIFFED HERE TOO. A hub is an authenticated remote writer running a version we do not
   * control — exactly the caller the upload sniffer exists for. Trusting the peer's declared type
   * because "the hub checked" is letting the sender choose the extension the browser interprets.
   */
  const sniffed = sniff(stagedPath);
  if (!sniffed || !sniffed.ext || !sniffed.mime) {
    return { ok: false, reason: 'That file is not a type this server accepts.' };
  }
  const { ext, mime } = sniffed;

  const finalName = digestFilename(digest, ext);
  const finalPath = path.join(contentDir, finalName);

  try {
    // Same filesystem, so the rename is atomic. If the bytes are already here under this exact
    // name, they are byte-identical by construction — drop the duplicate rather than rewrite it.
    if (fs.existsSync(finalPath)) fs.unlinkSync(stagedPath);
    else fs.renameSync(stagedPath, finalPath);
  } catch (e) {
    return { ok: false, reason: 'That file could not be stored.' };
  }

  const ts = Math.floor(now() / 1000);

  /*
   * ⚠️ ONE ROW PER FILE IN A WORKSPACE. NEVER A SECOND ROW ON SOMEONE ELSE'S BYTES.
   *
   * Content-addressed names mean two different pushes can resolve to the same file — the same logo
   * listed twice in one manifest, a re-push after the row was deleted, an entry with no digest.
   * The original minted a fresh row every time and pointed it at the existing filepath, which put
   * TWO rows on ONE file. Nothing in this codebase refcounts a filepath, so deleting either row
   * unlinks the bytes out from under the other, and every panel that had not already cached it
   * 404s. That converts a safe-by-construction delete into a data-loss path, and the naming scheme
   * is what introduced it.
   *
   * Reusing the row also keeps `content.id` stable, which matters more than the filename did:
   * content_id is field 1 of the player's structural fingerprint on web, and it is what Android and
   * Tizen key their caches on — those two do not include filepath at all. A fresh uuid per commit
   * would restart playback on every platform for bytes that never changed, which is the exact
   * failure (#234) the content-addressed naming was chosen to avoid.
   */
  const existing = db.prepare(
    'SELECT id FROM content WHERE filepath = ? AND workspace_id = ? LIMIT 1',
  ).get(finalName, workspaceId);

  const localId = existing ? existing.id : crypto.randomUUID();
  // Only bytes we actually added to this workspace are charged. A re-push that resolved to a file
  // already here has cost the operator nothing and must not spend their allowance again.
  const charge = existing ? 0 : stat.size;

  const commit = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE content SET mime_type = ?, file_size = ?, byte_digest = ?,
                                     duration_sec = COALESCE(?, duration_sec),
                                     width = COALESCE(?, width), height = COALESCE(?, height),
                                     updated_at = ?
                   WHERE id = ?`)
        .run(mime, stat.size, digest, entry.dur ?? null, entry.w ?? null, entry.h ?? null, ts, localId);
    } else {
      db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type,
                                       file_size, byte_digest, duration_sec, width, height,
                                       created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(localId, userId, workspaceId, entry.fn || finalName, finalName,
             mime, stat.size, digest,
             entry.dur ?? null, entry.w ?? null, entry.h ?? null, ts, ts);
    }

    /*
     * ⚠️ `relayable` COMES FROM THE SENDER AND IS THE OWNER'S DECISION, not this node's. It records
     * that whoever sent this file agreed it may travel further down the tree — a consent only they
     * can give, because they own it. This node still decides, separately, whether it is willing to
     * hold anything at all for onward use (the redistributes-content capability), and any server
     * below still decides whether to accept it. Three parties, three answers, all required.
     *
     * Coerced to 0/1 rather than stored as whatever arrived: a truthy string from a peer must not
     * become a permission, and absent means no.
     */
    const relayable = (entry.rl === true || entry.rl === 1) ? 1 : 0;

    db.prepare(`INSERT INTO mesh_content_provenance
                  (origin_node_id, origin_content_id, local_content_id, edge_id, bytes,
                   first_seen_at, last_seen_at, relayable)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(origin_node_id, origin_content_id) DO UPDATE SET
                  local_content_id = excluded.local_content_id,
                  last_seen_at     = excluded.last_seen_at,
                  relayable        = excluded.relayable`)
      .run(edge.peer_node_id, entry.oid, localId, edge.id, stat.size, ts, ts, relayable);

    // The allowance is spent here, in the same transaction as the row that spent it. Accounting
    // that happens separately is accounting that drifts.
    if (charge) {
      db.prepare('UPDATE mesh_edges SET write_bytes_used = COALESCE(write_bytes_used,0) + ? WHERE id = ?')
        .run(charge, edge.id);
    }
  });
  commit();
    try { require('../revisions').recordCurrent(db, 'content', localId, { actor: { userId: null, kind: 'mesh', label: 'mesh hub' }, summary: existing ? 'Synced from hub (bytes changed)' : 'Synced from hub' }); } catch (_) {}

  return { ok: true, localId, filepath: finalName, digest, bytes: stat.size, reusedRow: !!existing };
}

module.exports = { evaluateManifest, admitTransfer, commitStagedAsset, MAX_MANIFEST_ENTRIES };
