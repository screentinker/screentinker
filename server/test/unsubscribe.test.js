'use strict';

/*
 * Unsubscribe: the token, which mail carries a link, and which HTTP verb may act.
 *
 * ⚠️ THE ONE THAT MATTERS IS "GET NEVER UNSUBSCRIBES". Mail clients, corporate scanners and
 * link-safety services fetch the links in a message with no human involved. Wire the state change to
 * GET and one message can silence an account nobody touched — and it presents as the alert system
 * being broken, because the recipient never knowingly did anything. That property is asserted at the
 * source level here and end-to-end by hand against a running server.
 *
 * The second is that TRANSACTIONAL MAIL MUST NOT CARRY A LINK. "Stop sending me these" applied to a
 * password reset is an account nobody can recover.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unsubscribe-test-secret';

const tok = require('../lib/unsubscribe-token');

// ───────────────────────────── the token ─────────────────────────────

test('a token is per-user and verifies only for its own user', () => {
  const a = tok.tokenFor('user-a');
  const b = tok.tokenFor('user-b');
  assert.notEqual(a, b);
  assert.equal(tok.verify('user-a', a), true);
  assert.equal(tok.verify('user-b', a), false, 'a token must not unsubscribe another account');
});

test('verify refuses junk without throwing', () => {
  // These are what an endpoint in an email actually receives: truncated URLs from a mail client that
  // wrapped the line, and probes. timingSafeEqual throws on a length mismatch, so a wrong-length
  // token would be a 500 instead of a clean refusal.
  for (const bad of ['', 'x', 'a'.repeat(43), null, undefined, 42, {}, []]) {
    assert.equal(tok.verify('user-a', bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(tok.verify('', tok.tokenFor('')), false, 'an empty user id is never valid');
  assert.equal(tok.verify(null, 'anything'), false);
});

test('the token is domain-separated from anything else signed with the same secret', () => {
  // The same secret signs sessions and other links. A bare HMAC(secret, id) would be an identical
  // string in every one of those contexts, so a token minted for one could be replayed as another.
  const crypto = require('node:crypto');
  const bare = crypto.createHmac('sha256', process.env.JWT_SECRET).update('user-a').digest('base64url');
  assert.notEqual(tok.tokenFor('user-a'), bare, 'the purpose prefix must be in the digest');
  assert.match(tok.PURPOSE, /unsubscribe/);
});

test('unsubscribeUrl needs an absolute origin and refuses to invent one', () => {
  const prev = process.env.APP_URL;
  try {
    process.env.APP_URL = 'https://screentinker.com/';   // trailing slash
    const url = tok.unsubscribeUrl('user-a');
    assert.match(url, /^https:\/\/screentinker\.com\/unsubscribe\?u=user-a&t=[A-Za-z0-9_-]+$/,
      'no doubled slash, and both params present');
    delete process.env.APP_URL;
    // A link to `undefined/unsubscribe` is worse than no link at all.
    assert.equal(tok.unsubscribeUrl('user-a'), null);
    process.env.APP_URL = '   ';
    assert.equal(tok.unsubscribeUrl('user-a'), null, 'whitespace is not an origin');
  } finally {
    if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
  }
});

test('a user id with URL-significant characters is encoded', () => {
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://x.test';
  try {
    const url = tok.unsubscribeUrl('a&b=c');
    assert.ok(url.includes('u=a%26b%3Dc'), `id must be encoded, got ${url}`);
  } finally {
    if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
  }
});

// ───────────────────────── which mail gets a link ─────────────────────────

test('the footer and headers appear only when a caller opts in', () => {
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://screentinker.com';
  try {
    const email = require('../services/email');
    const off = email.unsubscribeParts(null);
    assert.equal(off.footerHtml, '', 'no footer without an opt-in');
    assert.equal(off.headers, null);

    const on = email.unsubscribeParts('u-1');
    assert.match(on.footerHtml, /https:\/\/screentinker\.com\/unsubscribe\?u=u-1&t=/);
    assert.match(on.footerText, /Unsubscribe: https:\/\/screentinker\.com\/unsubscribe/);
    // RFC 8058. Paired with the route refusing to act on GET, this is what makes a mail client's own
    // unsubscribe button safe to wire up.
    assert.equal(on.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(on.headers['List-Unsubscribe'], /^<https:\/\/.+>$/, 'must be angle-bracketed');
  } finally {
    if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
  }
});

test('no APP_URL means no footer rather than a broken link', () => {
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    const parts = require('../services/email').unsubscribeParts('u-1');
    assert.equal(parts.footerHtml, '');
    assert.equal(parts.headers, null);
  } finally {
    if (prev !== undefined) process.env.APP_URL = prev;
  }
});

test('ONLY the senders gated by email_alerts pass unsubscribeUserId', () => {
  /*
   * The allow-list is the test. An unsubscribe link on a password reset, an email-verification link,
   * a workspace invite or a pairing code is an account the recipient can no longer recover — and it
   * would be added by someone copying a nearby sendEmail call, which is why this is asserted rather
   * than left to review.
   */
  const SERVICES = path.join(__dirname, '..', 'services');
  const ROUTES = path.join(__dirname, '..', 'routes');
  const MAY = new Set(['alerts.js', 'trialExpiry.js', 'activationNudge.js']);

  const files = [
    ...fs.readdirSync(SERVICES).filter((f) => f.endsWith('.js')).map((f) => ['services', f, path.join(SERVICES, f)]),
    ...fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js')).map((f) => ['routes', f, path.join(ROUTES, f)]),
  ];
  let found = 0;
  for (const [dir, name, full] of files) {
    if (dir === 'services' && name === 'email.js') continue;   // the implementation itself
    const src = fs.readFileSync(full, 'utf8');
    const uses = /unsubscribeUserId\s*:/.test(src);
    if (uses) found++;
    assert.equal(uses, MAY.has(name) && dir === 'services',
      uses
        ? `${dir}/${name} sends an unsubscribe link but is not one of the email_alerts-gated senders`
        : `${dir}/${name} is expected to send an unsubscribe link and does not`);
  }
  assert.equal(found, MAY.size, 'every allow-listed sender wires it up');
});

// ───────────────────────── the verb that may act ─────────────────────────

const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'unsubscribe.js'), 'utf8');

test('⚠️ the GET handler contains no write, and the POST handler does', () => {
  // Source-level, because the consequence of getting this wrong is silent and arrives through a
  // third party's link scanner rather than through anything we run.
  const get = ROUTE.slice(ROUTE.indexOf("router.get('/'"), ROUTE.indexOf("router.post('/'"));
  const post = ROUTE.slice(ROUTE.indexOf("router.post('/'"));

  assert.ok(!/UPDATE\s+users/i.test(get), 'the GET handler must never write');
  assert.ok(!/\baudit\(/.test(get), 'the GET handler must not record an action it did not take');
  assert.match(post, /UPDATE users SET email_alerts = 0/);
  assert.match(post, /audit\('email_alerts_unsubscribed'/);
});

test('the landing page offers a POST form, not a link that acts', () => {
  assert.match(ROUTE, /<form method="POST" action="\/unsubscribe">/);
  // The address is shown, because somebody with several accounts, or who was forwarded the mail, is
  // otherwise guessing which one they are about to silence.
  assert.match(ROUTE, /esc\(user\.email\)/);
});

test('a bad token and an unknown user give the SAME answer', () => {
  // Otherwise the endpoint is an oracle for "is this id a customer", and it is public by design.
  assert.equal((ROUTE.match(/REFUSAL/g) || []).length >= 3, true, 'one shared refusal, used by both handlers');
  const resolve = ROUTE.slice(ROUTE.indexOf('function resolve'), ROUTE.indexOf('const REFUSAL'));
  assert.match(resolve, /if \(!verify\(userId, token\)\) return null;/);
  assert.match(resolve, /\|\| null;/, 'a missing user resolves to the same null as a bad token');
});

test('the pages are noindex and uncached', () => {
  assert.match(ROUTE, /name="robots" content="noindex"/);
  assert.match(ROUTE, /'Cache-Control', 'no-store'/);
});

test('the route is mounted with a urlencoded parser and a rate limit', () => {
  // ⚠️ Both callers post a FORM body and that parser is not global, so without it req.body is
  // undefined and the token silently never arrives — the feature would appear to work in review and
  // fail for every real click.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = server.slice(server.indexOf("app.use('/unsubscribe'"));
  const decl = mount.slice(0, mount.indexOf(';') + 1);
  assert.match(decl, /express\.urlencoded/);
  assert.match(decl, /rateLimit\(/);
  assert.match(decl, /require\('\.\/routes\/unsubscribe'\)/);
});

test('⚠️ on a replica the write is proxied to the primary, not applied to the copy', () => {
  /*
   * `users` is copied to a replica and `email_alerts` is NOT on the replication blocklist, so a local
   * UPDATE would set the flag on the copy. The primary is what sends those alerts — its sweeps use
   * LOCAL_USERS_SQL to skip copied users, so a replica never sends them — and it would never hear
   * about the unsubscribe. The page would say "done" and the mail would keep arriving, which is how a
   * recipient learns to press the spam button instead.
   */
  assert.match(ROUTE, /function isCopiedUser/);
  assert.match(ROUTE, /origin_node_id IS NOT NULL/, 'the same definition of a copy as login uses');

  const post = ROUTE.slice(ROUTE.indexOf("router.post('/'"));
  const proxyAt = post.indexOf('proxyToPrimary');
  const writeAt = post.indexOf('UPDATE users SET email_alerts');
  assert.notEqual(proxyAt, -1, 'the POST must be able to proxy');
  assert.ok(proxyAt < writeAt, 'the proxy branch must come BEFORE the local write');
  // A standalone instance (no PRIMARY_URL) must take the local path unchanged — that is every
  // self-hosted deployment.
  assert.match(post, /config\.primaryUrl && isCopiedUser/);

  // And email_alerts really is absent from the blocklist, which is what makes the copy writable at
  // all. If it is ever added there, this proxy becomes unnecessary and this test should be revisited.
  const repl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'replication.js'), 'utf8');
  const users = repl.slice(repl.indexOf('users: ['), repl.indexOf(']', repl.indexOf('users: [')));
  assert.ok(!users.includes('email_alerts'),
    'email_alerts is now blocklisted from replication — re-check whether the proxy is still needed');
});
