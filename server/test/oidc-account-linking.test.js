'use strict';

/*
 * Linking an existing account to an instance-wide provider (#258).
 *
 * Signing in with a provider never adopts an account that already has a password — that is the
 * takeover the login path exists to refuse. The README promised an escape hatch ("the owner signs
 * in locally and links from Settings") that was never built, so an account created with a password
 * could never use SSO at all.
 *
 * The rules this pins down, all of which are load-bearing:
 *   - the account being linked comes from the SIGNED TRANSACTION (i.e. the session that started the
 *     link), never from the email in the returned token. Otherwise "linking" is the same email-keyed
 *     takeover under a friendlier name;
 *   - the provider's email must still equal the account's, because login resolves accounts by the
 *     asserted address;
 *   - one provider subject may not be linked to two accounts;
 *   - linking DELETES the password: one credential at a time;
 *   - unlinking SETS a password in the same statement, so the account is never between credentials;
 *   - ORG providers are not linkable at all.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

/** Body of a route handler, from its `router.<verb>('<route>'` to the next `router.`. */
function handler(verb, route) {
  const start = AUTH.indexOf(`router.${verb}('${route}'`);
  assert.notEqual(start, -1, `route ${verb.toUpperCase()} ${route} not found`);
  const rest = AUTH.slice(start + 1);
  const end = rest.indexOf('\nrouter.');
  return end === -1 ? rest : rest.slice(0, end);
}

test('link start requires authentication and refuses org providers', () => {
  const body = handler('get', '/oidc/:slug/link/start');
  assert.match(AUTH, /router\.get\('\/oidc\/:slug\/link\/start', requireAuth/,
    'the link must be startable only by someone already signed in — that is the proof of ownership');
  assert.match(body, /provider\.organizationId[\s\S]{0,160}status\(400\)/,
    "an organization's provider must never attach itself to a platform account");
  assert.match(body, /link: req\.user\.id/,
    'the account must come from the session, not from anything the browser can set');
});

test('the linked account is taken from the transaction, never from the returned email', () => {
  const cb = handler('get', '/oidc/:slug/callback');
  // The callback hands the transaction's link target to the shared post-login path
  // (completeFederatedLogin), which looks the account up by THAT, never by the returned email.
  assert.match(cb, /completeFederatedLogin\(req, res, \{ provider, claims, link: tx\.link \|\| null \}\)/,
    'the callback passes tx.link (the session that started it) as the link target');
  assert.match(cb, /WHERE id = \?'\)\.get\(link\)/,
    'the target account is looked up by that link target');
  // The email is still checked, but as a constraint on the link — not as the way the account is found.
  assert.match(cb, /target\.email\.toLowerCase\(\) !== email/, 'email must match the account being linked');
  assert.match(cb, /link_email_mismatch/);
});

test('one provider subject cannot be linked to two accounts', () => {
  const cb = handler('get', '/oidc/:slug/callback');
  assert.match(cb, /provider_id = \? AND auth_provider = \? AND id != \?/,
    'must check whether this provider identity already belongs to another account');
  assert.match(cb, /link_already_used/);
});

test('linking deletes the password — one credential at a time', () => {
  const cb = handler('get', '/oidc/:slug/callback');
  assert.match(cb, /UPDATE users SET auth_provider = \?, provider_id = \?, password_hash = NULL/,
    'the password must be cleared in the same statement that attaches the provider');
});

test('unlinking sets a password in the SAME statement', () => {
  const body = handler('post', '/oidc/unlink');
  assert.match(body, /UPDATE users SET auth_provider = 'local', provider_id = NULL, password_hash = \?/,
    'unlink and set-password must be one write — never unlink first and set a password after');
  assert.match(body, /password\.length < passwordReset\.MIN_PASSWORD_LENGTH/,
    'the replacement password must meet the same minimum as a reset');
  assert.match(body, /auth_provider === 'local'/, 'refuse unlinking an account that has no provider');
});

test('both link and unlink are recorded in the activity log', () => {
  assert.match(handler('get', '/oidc/:slug/callback'), /logActivity\([^)]*'auth:sso_linked'/);
  assert.match(handler('post', '/oidc/unlink'), /logActivity\([^)]*'auth:sso_unlinked'/);
});

test('link failures return to Settings, not the login page', () => {
  const cb = handler('get', '/oidc/:slug/callback');
  assert.match(cb, /const fail = linking \? backToSettings : backToApp/,
    'an authenticated user must not be bounced to a login screen to be told the link failed');
  assert.match(AUTH, /function backToSettings\(res, params\)[\s\S]{0,200}#\/settings/);
});

test('link start answers with JSON, because a navigation cannot carry a bearer token', () => {
  /*
   * Shipped broken once: the Settings button did `location.href = .../link/start`, which is a
   * top-level navigation. The session lives in localStorage and travels as an Authorization header,
   * so the request arrived anonymous and requireAuth refused it — "Authentication required" on
   * every click. The client must FETCH this with its token and navigate to the returned URL.
   */
  const body = handler('get', '/oidc/:slug/link/start');
  assert.match(body, /beginOidc\([^)]*backToSettings, true\)/,
    'link start must run in JSON mode');
  assert.match(AUTH, /if \(asJson\) return res\.json\(\{ url: url\.toString\(\) \}\);/,
    'JSON mode must return the authorize URL rather than a 302');

  const settings = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'frontend', 'js', 'views', 'settings.js'), 'utf8');
  assert.match(settings, /await api\.ssoLinkStart\(slug\)/,
    'the client must fetch the start route so its Authorization header is sent');
  assert.doesNotMatch(settings, /location\.href = `\/api\/auth\/oidc/,
    'never navigate straight at the authenticated start route');
});

test('login and link share one flow, so verification cannot drift between them', () => {
  // beginOidc is the single place PKCE/state/nonce are minted; both entry points call it.
  assert.match(AUTH, /async function beginOidc\(req, res, provider, extra = \{\}/);
  const login = handler('get', '/oidc/:slug/start');
  const link = handler('get', '/oidc/:slug/link/start');
  assert.match(login, /beginOidc\(req, res, provider\)/);
  assert.match(link, /beginOidc\(req, res, provider, \{ link: req\.user\.id \}/);
});
