'use strict';

/*
 * #313 — enrolment keys: how a player with no durable storage says which display it is.
 *
 * ⚠️ THE PROBLEM. A vMix browser input deletes its entire CEF profile when vMix closes — vMix
 * staff, on their own forum: "The Web Browser input cache is automatically cleared when closing
 * vMix". localStorage, cookies and IndexedDB live in that profile, so they all go together. The
 * web player therefore comes back with nothing at all, and a player with no identity provisions a
 * NEW display row: a fresh unpaired screen after every restart of the production PC, and an
 * operator's dashboard filling with dead rows.
 *
 * The URL is the only thing that survives, so the identity has to travel in the URL.
 *
 * ⚠️ WHY NOT JUST PUT THE DEVICE TOKEN IN THE URL. It would work, and it would be wrong. The
 * device token authenticates every message the display sends; there is no way to rotate it without
 * re-pairing the screen, and a URL ends up in config files, screenshots, support threads and proxy
 * logs. An enrolment key does ONE thing — names a display and proves you are allowed to be it —
 * and an operator can roll it from the display's page and paste a new URL, with the screen never
 * touched. Same blast radius while it is secret; a completely different recovery when it is not.
 *
 * ⚠️ AND WHY NOT THE PAIRING CODE. Six digits is fine for something shown on a screen for a few
 * minutes behind lib/pair-lockout. As a permanent secret sitting in a URL it is a million guesses.
 *
 * ⚠️ STORED IN PLAIN TEXT, deliberately, like devices.device_token beside it. The operator has to
 * be able to re-read the URL months later to rebuild a machine; a hash would mean rotating the key
 * (and editing every vMix input) every time somebody lost the link. The row is already the crown
 * jewels — it holds device_token — so this changes nothing about how the table must be protected.
 */

const crypto = require('crypto');

/*
 * 32 bytes, base64url. This is a bearer credential that lives in a URL for years, so it is sized
 * against offline guessing rather than against the rate limiter in front of it.
 */
function generateEnrolKey() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Cheap shape check before touching the database, so junk in a URL costs nothing. */
function looksLikeEnrolKey(key) {
  return typeof key === 'string' && key.length >= 32 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * Resolve an enrolment key to the display it belongs to.
 *
 * Returns the row's id AND its device_token, because the caller's whole job is to hand those to
 * the existing register path — see ws/deviceSocket. Nothing here authenticates anything on its
 * own; it exchanges one credential for the pair the server already knows how to check.
 *
 * @returns {{id: string, device_token: string|null}|null}
 */
function resolveEnrolKey(db, key) {
  if (!looksLikeEnrolKey(key)) return null;
  try {
    /*
     * Rides idx_devices_enrol_key (unique, partial). A plain equality lookup on a 256-bit random
     * value is not a timing oracle worth defending: there is nothing to walk toward.
     */
    const row = db.prepare('SELECT id, device_token FROM devices WHERE enrol_key = ?').get(key);
    return row || null;
  } catch {
    return null;   // column missing on a half-migrated database: behave as "no such key"
  }
}

/** Mint (or roll) the key for a display. Returns the new key. */
function setEnrolKey(db, deviceId) {
  const key = generateEnrolKey();
  db.prepare("UPDATE devices SET enrol_key = ?, updated_at = strftime('%s','now') WHERE id = ?").run(key, deviceId);
  return key;
}

/** Withdraw the key. Any URL carrying it stops working on the display's next connect. */
function clearEnrolKey(db, deviceId) {
  db.prepare("UPDATE devices SET enrol_key = NULL, updated_at = strftime('%s','now') WHERE id = ?").run(deviceId);
}

/**
 * The URL an operator pastes into vMix.
 *
 * `k` rather than anything descriptive: it is read by a human copying it between two applications,
 * and a shorter query string is a smaller chance of a truncated paste.
 */
function playerUrl(origin, key) {
  return `${String(origin).replace(/\/+$/, '')}/player?k=${encodeURIComponent(key)}`;
}

module.exports = {
  generateEnrolKey,
  looksLikeEnrolKey,
  resolveEnrolKey,
  setEnrolKey,
  clearEnrolKey,
  playerUrl,
};
