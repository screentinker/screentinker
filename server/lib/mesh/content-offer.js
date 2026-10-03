'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/*
 * OFFERING CONTENT TO A CHILD — the parent's half, and it is deliberately the dumber half.
 *
 * This builds a description of some files and a one-time ticket for each. It decides nothing about
 * whether the child wants them, may have them, or has room: every one of those questions is
 * answered on the machine that owns the disk (I10). A parent that pre-judged them would be a parent
 * the child had to trust.
 *
 * ⚠️ TICKETS ARE MINTED FOR EVERY ENTRY, INCLUDING ONES THE CHILD ALREADY HOLDS. The alternative is
 * a second round trip — offer, hear what is needed, mint, transfer — and the saving is a few short
 * rows that expire on their own. A ticket is not permission to browse: it names ONE file, for ONE
 * edge, for a short window, and reveals nothing about what else exists here.
 */

/** Short enough that a leaked ticket is worthless, long enough for a big file on a bad link. */
const TICKET_TTL_SECONDS = 6 * 60 * 60;

/** A cap on one push, so a mis-click cannot queue a library. */
const MAX_OFFER_ENTRIES = 500;

/**
 * @param {object}   db
 * @param {object}   edge         the `down` edge to the child
 * @param {string[]} contentIds   rows in THIS node's library
 * @param {object}   deps         { contentDir }
 */
/**
 * @param {boolean} [deps.relayable]  whether THIS operator agrees the files may be passed on by the
 *   receiving server to servers below it. Their content, their call — and the receiving node still
 *   has to be willing to hold it, and the node below still has to accept it.
 */
function buildOffer(db, edge, contentIds, deps = {}) {
  const contentDir = deps.contentDir;
  if (!contentDir) return { ok: false, reason: 'This server has no content directory configured.' };

  const ids = [...new Set((contentIds || []).filter((x) => typeof x === 'string'))];
  if (!ids.length) return { ok: false, reason: 'Choose some content to send.' };
  if (ids.length > MAX_OFFER_ENTRIES) {
    return { ok: false, reason: `That is ${ids.length} items; ${MAX_OFFER_ENTRIES} can be sent at a time.` };
  }

  const content = [];
  const tickets = {};
  const skipped = [];
  const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);

  for (const id of ids) {
    const row = db.prepare(`SELECT id, filename, filepath, mime_type, file_size, byte_digest,
                                   duration_sec, width, height, remote_url
                              FROM content WHERE id = ?`).get(id);
    if (!row) { skipped.push({ id, why: 'no longer in this library' }); continue; }

    /*
     * ⚠️ Remote and YouTube items have no bytes and never will. They still need to travel, because
     * the child's playlist route refuses an item whose content does not resolve — so they are
     * listed with a kind and excluded from the byte closure rather than silently dropped, which
     * would publish a playlist one item short on the far side.
     */
    if (row.remote_url) {
      content.push({
        oid: row.id, kind: row.mime_type === 'video/youtube' ? 'youtube' : 'remote',
        fn: row.filename, mt: row.mime_type, url: row.remote_url,
        dur: row.duration_sec ?? null, sz: 0,
      });
      continue;
    }

    const abs = path.join(contentDir, path.basename(row.filepath || ''));
    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) { stat = null; }
    /*
     * ⚠️ Checked on DISK before it is offered. A row whose file is missing — a restore, a migration,
     * a manual cleanup — would otherwise be advertised, ticketed, and fail at transfer, and the
     * operator would be told the network was at fault.
     */
    if (!stat) { skipped.push({ id, why: 'its file is missing on this server' }); continue; }

    content.push({
      oid: row.id,
      kind: 'local',
      // ⚠️ Sent explicitly rather than omitted-means-yes. A receiver treats absent as NO.
      rl: !!deps.relayable,
      fn: row.filename,
      mt: row.mime_type,
      sz: stat.size,                       // ⚠️ from the DISK, not the row: file_size can be stale
      dg: row.byte_digest || null,
      dur: row.duration_sec ?? null,
      w: row.width ?? null,
      h: row.height ?? null,
    });

    const secret = crypto.randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO mesh_pull_tickets (id, token_hash, edge_id, filepath, size, digest,
                                               created_at, expires_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), hashToken(secret), edge.id, path.basename(row.filepath),
           stat.size, row.byte_digest || null, nowSec, nowSec + TICKET_TTL_SECONDS);
    tickets[row.id] = secret;
  }

  if (!content.length) {
    return { ok: false, reason: 'None of that content can be sent.', skipped };
  }
  return { ok: true, manifest: { content }, tickets, skipped };
}

/*
 * ⚠️ HASHED AT REST, like every other credential here. A ticket is a bearer secret for one file: a
 * readable copy in the database is a readable copy in every backup of it.
 */
function hashToken(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/**
 * Redeem a ticket. Returns the row, or a reason.
 *
 * ⚠️ NOT MARKED USED ON REDEMPTION. A resumable download makes several requests against the same
 * ticket by design — that is the whole point of the Range support on the other side — so
 * single-use would break exactly the transfers this exists for. The bound is the short expiry and
 * the fact that a ticket names one file on one edge.
 */
function redeemTicket(db, secret, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM mesh_pull_tickets WHERE token_hash = ?').get(hashToken(secret));
  // Same answer for "no such ticket" and "expired": a caller learns nothing from the difference.
  if (!row || row.expires_at < now) return { ok: false, reason: 'That link is not valid.' };

  const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(row.edge_id);
  /*
   * ⚠️ THE EDGE IS RE-READ LIVE, so a link severed a moment ago cannot still be pulling files. A
   * ticket minted while a relationship existed must not outlive the relationship.
   */
  if (!edge || edge.revoked_at) return { ok: false, reason: 'That link is not valid.' };

  return { ok: true, ticket: row, edge };
}

module.exports = { buildOffer, redeemTicket, hashToken, TICKET_TTL_SECONDS, MAX_OFFER_ENTRIES };
