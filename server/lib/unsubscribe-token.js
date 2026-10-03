'use strict';

/*
 * The token in an unsubscribe link.
 *
 * An unsubscribe URL is handed to a mail client, forwarded, logged by relays and sometimes pasted
 * into a ticket. So it must carry exactly one power — "turn this one account's alert emails off" —
 * and it must not be guessable from a user id, which appears in plenty of places a link does not.
 *
 * HMAC over the id with a PURPOSE PREFIX. The prefix is the part that matters: the same secret signs
 * session tokens and other links, and a bare HMAC(secret, id) would be the same string in every one
 * of those contexts, so a token minted for one could be replayed as another. Domain-separating them
 * costs one string concatenation.
 *
 * ⚠️ DELIBERATELY NO EXPIRY. A link in an eighteen-month-old email is exactly the link someone
 * clicks — that is when they have finally had enough of the emails — and an expired unsubscribe is
 * both a support ticket and, in several jurisdictions, a compliance problem. The token grants no read
 * access and its only effect is one a recipient is entitled to at any time, so there is nothing an
 * old one can do that a new one could not.
 */

const crypto = require('crypto');
const config = require('../config');

const PURPOSE = 'unsubscribe:v1:';

function tokenFor(userId) {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(PURPOSE + String(userId))
    .digest('base64url');
}

/*
 * Constant-time compare, and never throw.
 *
 * timingSafeEqual requires equal-length buffers and throws otherwise, so a token of the wrong length
 * — which is what an attacker probing the endpoint sends, and what a mail client that truncated a
 * long URL sends — would become a 500 instead of a clean refusal. Length is compared first, which
 * leaks only the length, a value already visible in the URL.
 */
function verify(userId, token) {
  if (!userId || typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(tokenFor(userId));
  const given = Buffer.from(token);
  if (expected.length !== given.length) return false;
  try {
    return crypto.timingSafeEqual(expected, given);
  } catch (e) {
    return false;
  }
}

/*
 * The absolute URL to put in an email. Absolute because a mail client has no origin to resolve a
 * relative path against.
 *
 * APP_URL pins the canonical origin, matching how invites and verification links are built. There is
 * no request to fall back on here — these are sent from background services — so an instance with no
 * APP_URL gets null and the caller omits the link rather than emitting a broken one. A link to
 * `undefined/unsubscribe` is worse than no link: it reads as contempt for the recipient.
 */
function unsubscribeUrl(userId) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/unsubscribe?u=${encodeURIComponent(userId)}&t=${tokenFor(userId)}`;
}

module.exports = { tokenFor, verify, unsubscribeUrl, PURPOSE };
