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
 */

const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const entries = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of entries) if (now - v.created > TTL_MS) entries.delete(k);
}
setInterval(sweep, 60 * 1000).unref();

function put(contentId, html) {
  sweep();
  const token = crypto.randomBytes(24).toString('hex');
  entries.set(token, { contentId, html, created: Date.now() });
  return token;
}

/** The stored HTML, or null when the token is unknown, expired, or for a different content id. */
function get(token, contentId) {
  const e = entries.get(token);
  if (!e) return null;
  if (Date.now() - e.created > TTL_MS) { entries.delete(token); return null; }
  if (e.contentId !== contentId) return null;
  return e.html;
}

module.exports = { put, get, TTL_MS };
