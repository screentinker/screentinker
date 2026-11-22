'use strict';

/*
 * Ephemeral store for dashboard bundle previews.
 *
 * ⚠️ A MODULE RATHER THAN A LOCAL MAP BECAUSE THE TWO HALVES LIVE ON OPPOSITE SIDES OF AUTH. The
 * mint is authenticated (routes/content.js, behind requireAuth, so it can check the caller may see
 * this content); the read is not and cannot be, because the iframe that loads it sends no
 * credentials — it is served from server.js alongside the other public content routes.
 *
 * The id is the capability. It is unguessable, single-purpose, expires, and is bound to one content
 * id so a stolen one cannot be pointed at a different archive. Nothing sensitive is in the URL,
 * which is the property a `?token=<session jwt>` scheme would have thrown away.
 *
 * ⚠️ BOUNDED BY COUNT AND BY SIZE, not only by TTL. Each entry is a whole inlined document (up to
 * ~11M characters), and a signed-in user could mint them in a loop: five minutes of mints with no
 * cap was unbounded memory. Past either cap the OLDEST previews go first (Map order is insertion
 * order). An evicted preview's frame just shows "Preview expired"; the dashboard mints a new one.
 */

const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 64;
const MAX_TOTAL_CHARS = 96 * 1024 * 1024;
const entries = new Map();
let totalChars = 0;

function drop(k) {
  const v = entries.get(k);
  if (!v) return;
  entries.delete(k);
  totalChars -= v.html.length;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of entries) if (now - v.created > TTL_MS) drop(k);
}
setInterval(sweep, 60 * 1000).unref();

function put(contentId, html) {
  sweep();
  const token = crypto.randomBytes(24).toString('hex');
  html = String(html);
  entries.set(token, { contentId, html, created: Date.now() });
  totalChars += html.length;
  // Evict oldest first, never the one just added (a single preview is always under the total cap:
  // the inliner refuses anything near it).
  for (const k of entries.keys()) {
    if (entries.size <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) break;
    if (k === token) break;
    drop(k);
  }
  return token;
}

/** The stored HTML, or null when the token is unknown, expired, or for a different content id. */
function get(token, contentId) {
  const e = entries.get(token);
  if (!e) return null;
  if (Date.now() - e.created > TTL_MS) { drop(token); return null; }
  if (e.contentId !== contentId) return null;
  return e.html;
}

const _stats = () => ({ entries: entries.size, chars: totalChars });

module.exports = { put, get, TTL_MS, MAX_ENTRIES, MAX_TOTAL_CHARS, _stats };
