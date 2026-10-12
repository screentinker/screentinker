'use strict';

/*
 * The SSO that shipped before this verified nothing that mattered, and had no tests at all.
 *
 * Google's path asked `tokeninfo?access_token=` whether a token was valid and trusted the email in
 * the answer; Microsoft's handed a bearer token to Graph /me and trusted that. Neither asked WHO
 * THE TOKEN WAS ISSUED FOR. An access token is a bearer credential for a resource, minted for some
 * application — so any site a user signed into that requested `email` or `User.Read` could replay
 * their token and be handed a session as them.
 *
 * These tests exist so that cannot come back. Every one of them describes an attack that the old
 * code would have waved through, and they run against a REAL RSA keypair and a REAL JWKS document
 * so the verifier is exercised the way a provider would exercise it — not against a stub that
 * agrees with us.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const oidc = require('../lib/oidc');
const providers = require('../lib/oidc-providers');

// ---------------------------------------------------------------------------------------------
// A pretend identity provider: one keypair, one JWKS, one discovery document.

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'screentinker-test-client';
const KID = 'test-key-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] };

// A second keypair nobody should trust — the "signed by someone else" case.
const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function discoveryDoc(issuer = ISSUER) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
}

/** Point the OIDC transport at the pretend provider. Returns a restore function. */
function mockProvider({ doc = discoveryDoc(), jwks = JWKS } = {}) {
  oidc._setTransport(async (url) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) {
      return { ok: true, status: 200, json: async () => doc };
    }
    if (u.endsWith('/jwks')) {
      return { ok: true, status: 200, json: async () => jwks };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  oidc._resetCaches();
  return () => { oidc._setTransport(null); oidc._resetCaches(); };
}

const idToken = (claims = {}, { key = privateKey, alg = 'RS256', kid = KID } = {}) => jwt.sign(
  { iss: ISSUER, aud: CLIENT_ID, sub: 'user-123', email: 'a@example.com', nonce: 'NONCE', ...claims },
  key, { algorithm: alg, keyid: kid, expiresIn: '5m' },
);

const verify = (token, over = {}) =>
  oidc.verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, nonce: 'NONCE', ...over });

// ---------------------------------------------------------------------------------------------

test('a well-formed token from the right provider verifies', async () => {
  const restore = mockProvider();
  try {
    const claims = await verify(idToken());
    assert.equal(claims.sub, 'user-123');
    assert.equal(claims.email, 'a@example.com');
  } finally { restore(); }
});

test('THE OLD BUG: a token minted for a DIFFERENT application is refused', async () => {
  // This is the whole reason the previous implementation was unsafe. Same provider, same user,
  // real signature — but issued to somebody else's client. It must not buy a session here.
  const restore = mockProvider();
  try {
    await assert.rejects(() => verify(idToken({ aud: 'someone-elses-client' })), /audience/i);
  } finally { restore(); }
});

test('...and neither is one that merely LISTS us alongside its real audience', async () => {
  // aud can be an array. azp names who it was actually issued to, and if that is not us then we
  // are a bystander in someone else's token — the confused-deputy case.
  const restore = mockProvider();
  try {
    await assert.rejects(
      () => verify(idToken({ aud: [CLIENT_ID, 'other'], azp: 'other' })),
      /issued to a different application/i,
    );
  } finally { restore(); }
});

test('a token captured from an earlier login cannot be replayed', async () => {
  // The nonce is minted per login and kept in a signed cookie. Without this check a correctly
  // audienced token, obtained any way at all, would be reusable forever.
  const restore = mockProvider();
  try {
    await assert.rejects(() => verify(idToken({ nonce: 'A-DIFFERENT-LOGIN' })), /nonce/i);
  } finally { restore(); }
});

test('alg:none is refused', async () => {
  const restore = mockProvider();
  try {
    // Hand-built, because jsonwebtoken will not sign 'none' for you.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      iss: ISSUER, aud: CLIENT_ID, sub: 'x', email: 'a@example.com', nonce: 'NONCE',
      exp: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url');
    await assert.rejects(() => verify(`${header}.${body}.`), /algorithm/i);
  } finally { restore(); }
});

test('an HMAC-signed token is refused even though the "key" is public', async () => {
  // HS256 verifies with a shared secret. The only key we hold for a provider is its PUBLIC one,
  // which the attacker also has — so accepting HMAC would let anyone sign their own identity.
  const restore = mockProvider();
  try {
    const forged = jwt.sign(
      { iss: ISSUER, aud: CLIENT_ID, sub: 'x', email: 'admin@example.com', nonce: 'NONCE' },
      publicKey.export({ type: 'spki', format: 'pem' }),
      { algorithm: 'HS256', keyid: KID, expiresIn: '5m' },
    );
    await assert.rejects(() => verify(forged), /algorithm/i);
  } finally { restore(); }
});

test('a token signed by the wrong key is refused', async () => {
  const restore = mockProvider();
  try {
    await assert.rejects(() => verify(idToken({}, { key: rogue.privateKey })), /signature/i);
  } finally { restore(); }
});

test('an expired token is refused', async () => {
  const restore = mockProvider();
  try {
    const stale = jwt.sign(
      { iss: ISSUER, aud: CLIENT_ID, sub: 'x', email: 'a@example.com', nonce: 'NONCE',
        exp: Math.floor(Date.now() / 1000) - 3600 },
      privateKey, { algorithm: 'RS256', keyid: KID },
    );
    await assert.rejects(() => verify(stale), /expired/i);
  } finally { restore(); }
});

test('a provider whose discovery claims a different issuer is refused', async () => {
  // Discovery is fetched from a URL derived from the configured issuer, so a document naming a
  // DIFFERENT one is either broken or hostile. Either way its tokens must not be accepted under a
  // name it does not own.
  const restore = mockProvider({ doc: discoveryDoc('https://evil.example.com') });
  try {
    await assert.rejects(() => verify(idToken()), /issuer mismatch/i);
  } finally { restore(); }
});

test('verification cannot be skipped by omitting the nonce', async () => {
  // Belt and braces: the caller must always have a nonce to compare, so a coding mistake that
  // forgets to pass one fails closed rather than accepting anything.
  const restore = mockProvider();
  try {
    await assert.rejects(() => verify(idToken(), { nonce: undefined }), /nonce/i);
  } finally { restore(); }
});

test('an unknown kid triggers exactly one JWKS refresh, then gives up', async () => {
  // Key rotation is normal and must not fail every login until a cache expires; a token quoting
  // nonsense must not become a way to hammer the provider either.
  let jwksFetches = 0;
  oidc._setTransport(async (url) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) return { ok: true, status: 200, json: async () => discoveryDoc() };
    if (u.endsWith('/jwks')) { jwksFetches++; return { ok: true, status: 200, json: async () => JWKS }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  oidc._resetCaches();
  try {
    await assert.rejects(() => verify(idToken({}, { kid: 'no-such-kid' })), /no signing key/i);
    assert.equal(jwksFetches, 1, 'one refresh, not a loop');
  } finally { oidc._setTransport(null); oidc._resetCaches(); }
});

// ---------------------------------------------------------------------------------------------
// PKCE

test('PKCE uses S256 and never sends the verifier', () => {
  const { verifier, challenge, method } = oidc.createPkce();
  assert.equal(method, 'S256');
  assert.notEqual(verifier, challenge, 'a plain challenge would make PKCE pointless');
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43, 'RFC 7636 wants at least 43 characters of entropy');
});

test('every login gets fresh values', () => {
  const a = oidc.createPkce(); const b = oidc.createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(oidc.randomToken(), oidc.randomToken());
});

// ---------------------------------------------------------------------------------------------
// The provider registry

test('Google registers from the variable the README always documented', () => {
  const [g] = providers.list({ GOOGLE_CLIENT_ID: 'g' });
  assert.equal(g.issuer, 'https://accounts.google.com');
});

test('a single-tenant Microsoft app narrows the issuer, so another tenant fails iss', () => {
  const [ms] = providers.list({ MICROSOFT_CLIENT_ID: 'm', MICROSOFT_TENANT_ID: 'abc-123' });
  assert.equal(ms.issuer, 'https://login.microsoftonline.com/abc-123/v2.0');
});

test('MULTI-TENANT MICROSOFT IS REFUSED, not silently broken', () => {
  /*
   * Two reasons pointing the same way. It cannot work: Microsoft's `common` metadata advertises the
   * literal template `https://login.microsoftonline.com/{tenantid}/v2.0`, so the issuer can never
   * equal the configured URL and every login fails at /start anyway.
   *
   * And the obvious patch is dangerous: loosening the iss comparison accepts tokens from EVERY
   * Azure tenant, which is nOAuth — any tenant admin can set an arbitrary unverified `email` on
   * their own user and be issued a session as that address here.
   */
  for (const tenant of ['common', 'organizations', 'consumers', '']) {
    assert.deepEqual(providers.list({ MICROSOFT_CLIENT_ID: 'm', MICROSOFT_TENANT_ID: tenant }), [],
      `MICROSOFT_TENANT_ID=${tenant || '(unset)'} must not register a provider`);
  }
});

test('any OIDC provider can be added by env', () => {
  const list = providers.list({
    OIDC_PROVIDERS: 'authentik',
    OIDC_AUTHENTIK_ISSUER: 'https://id.example.com/application/o/st/',
    OIDC_AUTHENTIK_CLIENT_ID: 'abc',
    OIDC_AUTHENTIK_NAME: 'Company SSO',
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, 'authentik');
  assert.equal(list[0].name, 'Company SSO');
  assert.equal(list[0].issuer, 'https://id.example.com/application/o/st', 'trailing slash normalised');
  assert.equal(list[0].clientSecret, null, 'PKCE means a public client is fine');
});

test('an incomplete or malformed provider is ignored rather than crashing boot', () => {
  assert.equal(providers.list({ OIDC_PROVIDERS: 'broken' }).length, 0, 'no issuer/client id');
  assert.equal(providers.list({
    OIDC_PROVIDERS: '../etc/passwd',
    OIDC_ISSUER: 'https://x', OIDC_CLIENT_ID: 'y',
  }).length, 0, 'a slug that is not URL-safe never becomes a route');
});

test('the browser is told slugs and names only — never a client id or secret', () => {
  const pub = providers.publicList({
    GOOGLE_CLIENT_ID: 'super-secret-id',
    OIDC_PROVIDERS: 'okta', OIDC_OKTA_ISSUER: 'https://x.okta.com',
    OIDC_OKTA_CLIENT_ID: 'id', OIDC_OKTA_CLIENT_SECRET: 'shh',
  });
  const serialised = JSON.stringify(pub);
  assert.ok(!serialised.includes('super-secret-id'));
  assert.ok(!serialised.includes('shh'));
  assert.deepEqual(Object.keys(pub[0]).sort(), ['name', 'slug']);
});

// ---------------------------------------------------------------------------------------------
// Per-organization SSO.
//
// Instance providers belong to whoever runs the server; these belong to a CUSTOMER. Two properties
// matter more than the feature itself: one organization must not be able to capture another's
// logins, and the login page must not become a way to enumerate who the customers are.

const Database = require('better-sqlite3');

function orgDb() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE org_sso_providers (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_enc TEXT,
      scopes TEXT NOT NULL DEFAULT 'openid email profile', email_domains TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, sso_only INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE org_sso_domains (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider_id TEXT, domain TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL, token_issued_at INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
      last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL DEFAULT 0);
  `);
  return d;
}

/*
 * `domains` are VERIFIED (DNS proof recorded); `pending` are claimed but unproven. The distinction
 * is the whole point of the domain table, so the harness makes it impossible to write a test that
 * blurs the two: a test that wants routing must say which state it is testing.
 */
function withOrgDb(rows, fn) {
  const d = orgDb();
  let n = 0;
  for (const r of rows) {
    d.prepare('INSERT OR IGNORE INTO organizations (id, name, sso_only) VALUES (?, ?, ?)')
      .run(r.org, r.org, r.ssoOnly ? 1 : 0);
    const typed = [...(r.domains || '').split(','), ...(r.pending || '').split(',')].filter(Boolean).join(',');
    d.prepare(`INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id, email_domains, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.org, r.slug, r.name, r.issuer || ISSUER, r.clientId || 'cid', typed, r.enabled === undefined ? 1 : r.enabled);
    const addDomain = (dom, verifiedAt) => d.prepare(
      `INSERT INTO org_sso_domains (id, organization_id, provider_id, domain, token, token_issued_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(`dom${++n}`, r.org, r.id, dom, `tok${n}`, Math.floor(Date.now() / 1000), verifiedAt);
    // Verified in claim order unless the test pins it, so "who proved it first" stays testable.
    for (const dom of (r.domains || '').split(',').filter(Boolean)) addDomain(dom, (r.verifiedAt || 1000) + n);
    for (const dom of (r.pending || '').split(',').filter(Boolean)) addDomain(dom, null);
  }
  // Swap the module's lazily-resolved connection for this in-memory one.
  const real = require('../db/database');
  const saved = real.db;
  real.db = d;
  delete require.cache[require.resolve('../lib/oidc-providers')];
  const mod = require('../lib/oidc-providers');
  try { return fn(mod); } finally {
    real.db = saved;
    delete require.cache[require.resolve('../lib/oidc-providers')];
  }
}

test('an org provider is found by the email DOMAIN', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme SSO', domains: 'acme.com,acme.co.uk' }], (m) => {
    assert.equal(m.forEmail('someone@acme.com').name, 'Acme SSO');
    assert.equal(m.forEmail('someone@ACME.CO.UK').name, 'Acme SSO', 'case-insensitive');
    assert.equal(m.forEmail('someone@other.com'), null);
    assert.equal(m.forEmail('not-an-email'), null);
  });
});

test('a disabled provider stops answering for its domain', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme', domains: 'acme.com', enabled: 0 }], (m) => {
    assert.equal(m.forEmail('x@acme.com'), null);
    assert.equal(m.getOrgProvider('orgaaa'), null, 'and cannot be started directly either');
  });
});

test('ORG PROVIDERS ARE NEVER PUBLISHED to the whole internet', () => {
  // The login page lists instance-wide providers only. Listing a customer's IdP would both offer it
  // to people it does not belong to and leak the customer list.
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme SSO', domains: 'acme.com' }], (m) => {
    const pub = m.publicList({ GOOGLE_CLIENT_ID: 'g' });
    assert.deepEqual(pub.map((p) => p.slug), ['google']);
    assert.ok(!JSON.stringify(pub).includes('Acme'), 'no customer name anywhere in the public list');
  });
});

test('an org provider is still resolvable by slug, so the shared login flow can run it', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme SSO', domains: 'acme.com' }], (m) => {
    const p = m.get('orgaaa', {});
    assert.equal(p.name, 'Acme SSO');
    assert.equal(p.organizationId, 'org-a', 'carries its org so the callback can grant membership');
    assert.equal(p.source, 'org');
  });
});

test('an instance provider wins a slug clash with an org one', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'google', name: 'Impostor', domains: 'evil.com' }], (m) => {
    // Org slugs are randomly generated so this cannot happen by accident — but if it ever did, a
    // tenant must not be able to shadow the platform's own Google button.
    assert.equal(m.get('google', { GOOGLE_CLIENT_ID: 'real' }).name, 'Google');
  });
});

test('THE SHIPPED SCHEMA makes one domain, one organization a constraint', () => {
  /*
   * Uniqueness was enforced only by a check in the route, which a race defeated twice in review.
   * It is now a UNIQUE constraint, so a second claim cannot exist even if the check is bypassed.
   *
   * ⚠️ Read from server/db/database.js, NOT from the test harness. The earlier version of this
   * test asserted against the harness's own CREATE TABLE and therefore stayed green when UNIQUE was
   * removed from the shipped schema — it tested a copy of the thing it was named after.
   */
  const schema = fs.readFileSync(require.resolve('../db/database.js'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS org_sso_domains'));
  const body = table.slice(0, table.indexOf('`,'));
  assert.match(body, /domain\s+TEXT\s+NOT NULL\s+UNIQUE/, 'org_sso_domains.domain must be UNIQUE');
  // And the row must not outlive its provider: a verified row never expires, so an orphan would
  // block its domain for every organization, forever, while being invisible in the API.
  assert.match(body, /FOREIGN KEY \(provider_id\) REFERENCES org_sso_providers\(id\) ON DELETE CASCADE/,
    'a domain row must be removed with its provider');
});

test('no database means no org providers, and no crash', () => {
  // The env-only paths must keep working on an instance where the table has not been migrated yet.
  const m = require('../lib/oidc-providers');
  assert.doesNotThrow(() => m.publicList({ GOOGLE_CLIENT_ID: 'g' }));
});


// ---------------------------------------------------------------------------------------------
// Regressions for defects found in security review. Each one was demonstrated end to end against a
// running server before it was fixed; none of them was hypothetical.

test('TAKEOVER: an org provider may not assert an email outside its own domains', () => {
  /*
   * The worst defect in this feature. An org admin supplies the issuer and client id, so they
   * control the IdP completely and can mint a token asserting ANY email with email_verified:true —
   * including a platform_admin's. Every cryptographic check passes honestly, because the attacker
   * IS the issuer. Three reviewers demonstrated a full session as the victim independently.
   *
   * The confinement lives in the callback; this pins the data it depends on, so a provider loaded
   * from the database always carries the domains its assertions are checked against.
   */
  withOrgDb([{ id: '1', org: 'org-evil', slug: 'orgevil', name: 'Evil', domains: 'evil.test' }], (m) => {
    const p = m.getOrgProvider('orgevil');
    assert.equal(p.emailDomains, 'evil.test', 'the callback cannot confine what it cannot see');
    assert.ok(!p.emailDomains.includes('victim'), 'and only ever the domains that were PROVED');
    assert.equal(p.organizationId, 'org-evil', 'and must know this is a tenant provider, not the operator\'s');
  });
});

test('an INSTANCE provider carries no organization, so it is not domain-confined', () => {
  // Operator-chosen providers keep the trust they have always had; confinement targets tenants.
  const [g] = providers.list({ GOOGLE_CLIENT_ID: 'g' });
  assert.equal(g.organizationId, undefined);
  assert.equal(g.source, 'env');
});

test('a domain routes to exactly the provider that verified it', () => {
  /*
   * forEmail used an unordered SELECT over a comma column, so deleting and re-adding a provider
   * silently flipped which IdP a whole domain routed to.
   *
   * Two earlier versions of this test were hollow: one asserted only that two calls agreed with
   * each other (an unordered scan satisfies that within a process), the next used two DIFFERENT
   * domains so no ordering was exercised at all. The property that actually matters is that a
   * domain reaches its OWN provider and never a sibling's, so assert that.
   */
  withOrgDb([
    { id: 'a', org: 'org-a', slug: 'orgaaa', name: 'Alpha', domains: 'alpha.test' },
    { id: 'b', org: 'org-b', slug: 'orgbbb', name: 'Beta', domains: 'beta.test', pending: 'gamma.test' },
  ], (m) => {
    assert.equal(m.forEmail('x@alpha.test').name, 'Alpha');
    assert.equal(m.forEmail('x@beta.test').name, 'Beta');
    assert.equal(m.forEmail('x@gamma.test'), null, 'unverified, so it belongs to nobody');
    // Beta must not inherit Alpha's domain through a join or an ordering accident.
    assert.equal(m.getOrgProvider('orgbbb').emailDomains, 'beta.test');
    assert.equal(m.getOrgProvider('orgaaa').emailDomains, 'alpha.test');
  });
});

test('AN UNVERIFIED DOMAIN ROUTES NOBODY', () => {
  /*
   * The point of DNS verification. A tenant may type any domain — including a company they have
   * nothing to do with — and until a record proves control it must buy them nothing: no routing,
   * and (see the callback tests) no ability to assert an address inside it.
   */
  withOrgDb([{ id: '1', org: 'org-x', slug: 'orgxxx', name: 'Squatter', pending: 'victim-corp.test' }], (m) => {
    assert.equal(m.forEmail('ceo@victim-corp.test'), null, 'a claim is not a proof');
    const p = m.getOrgProvider('orgxxx');
    assert.equal(p.emailDomains, '', 'and the callback is given nothing it may confine to');
  });
});

test('verifying one domain does not carry over to the others claimed with it', () => {
  withOrgDb([{
    id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme',
    domains: 'acme.test', pending: 'acme-partner.test',
  }], (m) => {
    assert.equal(m.forEmail('x@acme.test').name, 'Acme');
    assert.equal(m.forEmail('x@acme-partner.test'), null);
    assert.equal(m.getOrgProvider('orgaaa').emailDomains, 'acme.test');
  });
});

test('a secret that cannot be decrypted fails CLOSED', () => {
  // decrypt() returns null after a JWT_SECRET rotation, which silently downgraded a confidential
  // client to a public one — the login then failed at the provider with an error nobody could act
  // on, while the admin screen still said "a secret is set".
  withOrgDb([{ id: '1', org: 'o', slug: 'orgsec', name: 'X', domains: 'x.test' }], (m) => {
    const real = require('../db/database');
    real.db.prepare('UPDATE org_sso_providers SET client_secret_enc = ? WHERE id = ?').run('not-decryptable', '1');
    assert.throws(() => m.getOrgProvider('orgsec'), /could not be decrypted/);
  });
});

test('a tenant cannot claim a public email provider as its sign-in domain', () => {
  /*
   * Demonstrated in review: a tenant claimed gmail.com, after which /sso/discover answered
   * {"sso":true} for every Gmail address and the login page offered "sign in with your
   * organization" — a phishing hop launched from the vendor's own login screen, pointed at
   * infrastructure the tenant controls. First-claim-wins also meant one cheap account could deny a
   * public domain to everyone else.
   */
  const { isPublicEmailDomain } = require('../lib/public-email-domains');
  for (const d of ['gmail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.com', 'icloud.com',
    'proton.me', 'qq.com', 'mail.ru', 'comcast.net', 'gmx.de']) {
    assert.ok(isPublicEmailDomain(d), `${d} must be refused as an org sign-in domain`);
  }
  // ...and a real company domain is still fine, or the feature would be pointless.
  for (const d of ['acme.com', 'bigcorp.io', 'my-company.co.uk', 'mail.acme.com']) {
    assert.equal(isPublicEmailDomain(d), false, `${d} must remain claimable`);
  }
});

test('the blocklist is case- and whitespace-insensitive', () => {
  // Domains arrive from a form. `  GMAIL.COM ` must not slip through a lowercase-only comparison.
  const { isPublicEmailDomain } = require('../lib/public-email-domains');
  assert.ok(isPublicEmailDomain('  GMAIL.COM '));
  assert.ok(isPublicEmailDomain('Outlook.Com'));
});

// ---------------------------------------------------------------------------------------------
// The confinement itself.
//
// Everything above tests the DATA the callback confines against. These test the DECISION, which is
// what actually stops the takeover — and each one below was checked by reverting the guard and
// confirming the test goes red. A security test that passes against the vulnerable code is worse
// than no test, because it is read as coverage.

const authRoutes = require('../routes/auth');
const { emailAllowedForProvider } = authRoutes;

const orgProvider = (domains) => ({ slug: 'orgabc', organizationId: 'org-a', emailDomains: domains });

test('CONFINEMENT: an org provider may only assert inside its verified domains', () => {
  const p = orgProvider('acme.test');
  assert.equal(emailAllowedForProvider(p, 'staff@acme.test'), true);
  assert.equal(emailAllowedForProvider(p, 'victim@other.test'), false, 'THE TAKEOVER');
  assert.equal(emailAllowedForProvider(p, 'admin@screentinker.com'), false);
});

test('CONFINEMENT: a provider with nothing verified may assert NOTHING', () => {
  // The squatting case. A tenant types a domain, proves nothing, and must get nowhere — including
  // for the domain they typed.
  const p = orgProvider('');
  assert.equal(emailAllowedForProvider(p, 'ceo@victim-corp.test'), false);
  assert.equal(emailAllowedForProvider(p, 'anyone@anywhere.test'), false);
});

test('CONFINEMENT: the domain cannot be smuggled past the check', () => {
  const p = orgProvider('acme.test');
  for (const evil of [
    'victim@other.test',                 // plainly outside
    'victim@acme.test.evil.test',        // suffix, not the domain
    'victim@evil.test@acme.test\n',      // trailing newline
    'victim@sub.acme.test',              // subdomain is a different domain
    'victim@acme.test.',                 // trailing dot
    'victim@ACME.TEST.EVIL.TEST',
    'no-at-sign',
    'victim@',
    '',
  ]) {
    assert.equal(emailAllowedForProvider(p, evil), false, `must refuse: ${JSON.stringify(evil)}`);
  }
  // ...while the legitimate forms still work, including the ones case normalisation must handle.
  assert.equal(emailAllowedForProvider(p, 'Staff@Acme.Test'), true);
  assert.equal(emailAllowedForProvider(p, 'a.b+tag@acme.test'), true);
});

test('CONFINEMENT: an INSTANCE provider is exempt, because the operator chose it', () => {
  // Per-org verification is for tenant-supplied providers only. The instance's own Google or Okta
  // is the operator's decision and is not domain-restricted — the same trust it has always had.
  const instance = { slug: 'google', emailDomains: '' };
  assert.equal(emailAllowedForProvider(instance, 'anyone@anywhere.test'), true);
  assert.equal(emailAllowedForProvider(instance, 'admin@gmail.com'), true);
});

// ---------------------------------------------------------------------------------------------
// Domain ownership.
//
// A claim is not a proof. These pin the part that makes that true: an unverified domain routes
// nobody, a claim lapses so it cannot be held forever, and a lapsed claim's token is dead so a
// record left behind from an earlier attempt cannot satisfy a later one.

const domainVerify = require('../lib/domain-verify');
const NOW = 1800000000;

test('an unverified claim lapses after 8 hours; a verified one never does', () => {
  const claim = (agoS, verified) => ({ token_issued_at: NOW - agoS, verified_at: verified ? NOW - 99 : null });
  assert.equal(domainVerify.isClaimExpired(claim(60, false), NOW), false, 'a minute old');
  assert.equal(domainVerify.isClaimExpired(claim(8 * 3600 - 30, false), NOW), false, 'just inside');
  assert.equal(domainVerify.isClaimExpired(claim(8 * 3600 + 1, false), NOW), true, 'just outside');
  // Proof does not rot. Re-verifying on a timer would log a customer out over a DNS edit made
  // months after they legitimately proved the domain.
  assert.equal(domainVerify.isClaimExpired(claim(365 * 86400, true), NOW), false, 'verified, a year old');
});

test('the DNS record is per-domain and per-claim, so an old record proves nothing', () => {
  const a = domainVerify.newToken();
  const b = domainVerify.newToken();
  assert.notEqual(a, b, 'two claims never share a token');
  assert.ok(a.length >= 32, 'not guessable');

  const one = domainVerify.instructions('acme.test', a);
  const two = domainVerify.instructions('acme.test', b);
  assert.equal(one.record_name, '_screentinker-verify.acme.test');
  assert.notEqual(one.txt_value, two.txt_value, 'reissuing changes what must be published');
  // TXT is the only accepted form: a CNAME alternative would need a wildcard zone this project
  // does not operate, so offering one would document a check that could never pass.
  assert.equal(one.cname_value, undefined, 'no CNAME form is advertised');
  // The record lives at a dedicated name, never the apex, where it would sit beside SPF and DMARC.
  assert.ok(!domainVerify.instructions('acme.test', a).record_name.startsWith('acme.test'));
});

test('a lapsed claim frees the domain for someone else', () => {
  // The anti-squat property: a domain nobody can prove cannot be held indefinitely by whoever typed
  // it first. Modelled here on the same predicate the route uses to decide whether a row blocks.
  const squatter = { domain: 'victim-corp.test', token_issued_at: NOW - (9 * 3600), verified_at: null };
  const owner = { domain: 'victim-corp.test', token_issued_at: NOW - 60, verified_at: NOW };
  assert.equal(domainVerify.isClaimExpired(squatter, NOW), true, 'the squatter no longer blocks it');
  assert.equal(domainVerify.isClaimExpired(owner, NOW), false, 'the real owner, having proved it, does');
});

/*
 * The proof name must not be delegated.
 *
 * A TXT lookup follows CNAMEs transparently, and RFC 4592 means a wildcard `*.victim.com`
 * synthesizes `_screentinker-verify.victim.com` as well. So a wildcard CNAME pointing at anything
 * the attacker controls lets them publish the token in THEIR zone and prove a domain they do not
 * own — turning an ordinary subdomain takeover into the whole company's sign-in. A review did
 * exactly this against a real authoritative zone.
 *
 * The resolver is stubbed rather than mocked at the network layer: `dns.promises` is a singleton,
 * so replacing the two methods is enough and the real check() runs unmodified.
 */
const dnsPromises = require('node:dns').promises;

function withStubbedDns({ cname, txt }, fn) {
  const realCname = dnsPromises.resolveCname;
  const realTxt = dnsPromises.resolveTxt;
  const nx = () => { const e = new Error('queryTxt ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
  dnsPromises.resolveCname = async () => (cname ? cname : nx());
  dnsPromises.resolveTxt = async () => (txt ? txt : nx());
  return Promise.resolve(fn()).finally(() => {
    dnsPromises.resolveCname = realCname;
    dnsPromises.resolveTxt = realTxt;
  });
}

test('DELEGATION: a CNAME at the proof name is refused, even when the TXT matches', async () => {
  const token = 'deadbeefdeadbeefdeadbeefdeadbeef';
  // The attacker owns takeover.attacker.test and publishes a perfect token there; victim.test has
  // a wildcard CNAME pointing at it. Without the refusal this returns ok:true.
  const r = await withStubbedDns(
    { cname: ['takeover.attacker.test'], txt: [[`st-verify=${token}`]] },
    () => domainVerify.check('victim.test', token),
  );
  assert.equal(r.ok, false, 'a delegated proof name must never verify');
  assert.match(r.error, /CNAME/, 'and the admin is told exactly why');
});

test('an ordinary TXT proof in the domain\'s own zone still verifies', async () => {
  const token = 'cafebabecafebabecafebabecafebabe';
  const r = await withStubbedDns({ cname: null, txt: [[`st-verify=${token}`]] },
    () => domainVerify.check('acme.test', token));
  assert.equal(r.ok, true);
  assert.equal(r.via, 'TXT');
});

test('a wildcard TXT answers with its own value, which is not a proof', async () => {
  const r = await withStubbedDns({ cname: null, txt: [['v=spf1 -all']] },
    () => domainVerify.check('victim.test', 'sometoken'));
  assert.equal(r.ok, false);
  assert.match(r.error, /does not match/);
});

test('a 255-byte-split TXT record is joined before comparing', async () => {
  // resolveTxt returns one array of chunks per record; a long value arrives split.
  const token = 'a'.repeat(32);
  const full = `st-verify=${token}`;
  const r = await withStubbedDns({ cname: null, txt: [[full.slice(0, 5), full.slice(5)]] },
    () => domainVerify.check('acme.test', token));
  assert.equal(r.ok, true, 'chunks of ONE record are concatenated');
});

test('chunks are never joined ACROSS records', async () => {
  const token = 'b'.repeat(32);
  const full = `st-verify=${token}`;
  const r = await withStubbedDns({ cname: null, txt: [[full.slice(0, 5)], [full.slice(5)]] },
    () => domainVerify.check('acme.test', token));
  assert.equal(r.ok, false, 'two unrelated records must not add up to a proof');
});

test('SSRF: a trailing root dot is the same host, and does not slip the guard', () => {
  // `https://localhost./` is a legal fully-qualified spelling that WHATWG URL preserves, so it
  // matched neither `localhost` nor `*.localhost` and was allowed. The literal-IP forms were never
  // affected — the parser normalises those itself.
  for (const u of ['https://localhost./', 'https://LOCALHOST./', 'https://foo.localhost./']) {
    assert.throws(() => oidc.assertFetchable(u), /not publicly routable/, u);
  }
  // and a real host that merely ends in a dot is still fine
  for (const u of ['https://accounts.google.com./', 'https://fcm.googleapis.com./']) {
    assert.doesNotThrow(() => oidc.assertFetchable(u), u);
  }
});

test('a user object never leaves the server carrying a reset or verify hash', () => {
  /*
   * Two call sites each stripped three columns and stopped, so every login response also carried
   * `password_reset_hash` and `email_verify_hash` — live credentials for taking the account over.
   * The sanitiser is one function now; this pins the list so the next column added to `users` has
   * to be considered rather than shipped.
   */
  const src = fs.readFileSync(require.resolve('../routes/auth.js'), 'utf8');
  const block = src.slice(src.indexOf('const PRIVATE_USER_FIELDS'), src.indexOf('function publicUser'));
  for (const field of ['password_hash', 'totp_secret_enc', 'totp_last_step',
    'password_reset_hash', 'password_reset_expires', 'email_verify_hash', 'email_verify_expires']) {
    assert.ok(block.includes(`'${field}'`), `${field} must never be serialised to a client`);
  }
  // And nothing may hand-roll the old partial strip again.
  assert.ok(!/totp_last_step,\s*\.\.\.safeUser/.test(src), 'use publicUser(), not an inline destructure');
});

// ---------------------------------------------------------------------------------------------
// SSO-only: an organization requiring its own identity provider.

test('SSO-ONLY applies to a VERIFIED domain', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme', domains: 'acme.test', ssoOnly: true }], (m) => {
    const hit = m.ssoOnlyForEmail('staff@acme.test');
    assert.ok(hit, 'password login must be refused for this address');
    assert.equal(hit.organization_id, 'org-a');
    assert.equal(m.ssoOnlyForEmail('staff@ACME.TEST').organization_id, 'org-a', 'case-insensitive');
    assert.equal(m.ssoOnlyForEmail('someone@elsewhere.test'), null, 'and nobody else is affected');
  });
});

test('SSO-ONLY CANNOT be imposed through a domain that was only claimed', () => {
  /*
   * The dangerous shape: switching off password login for a domain the tenant never proved would
   * be a denial-of-service against a company they have nothing to do with — every account at that
   * address locked out of a product the squatter does not own.
   */
  withOrgDb([{ id: '1', org: 'org-x', slug: 'orgxxx', name: 'Squatter', pending: 'victim-corp.test', ssoOnly: true }], (m) => {
    assert.equal(m.ssoOnlyForEmail('ceo@victim-corp.test'), null, 'an unproved domain compels nobody');
  });
});

test('SSO-ONLY stops applying when the provider is disabled', () => {
  // Otherwise disabling a broken provider would leave its users with no way in at all: no SSO
  // (disabled) and no password (still enforced).
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme', domains: 'acme.test', enabled: 0, ssoOnly: true }], (m) => {
    assert.equal(m.ssoOnlyForEmail('staff@acme.test'), null);
  });
});

test('SSO-ONLY is off unless the organization turned it on', () => {
  withOrgDb([{ id: '1', org: 'org-a', slug: 'orgaaa', name: 'Acme', domains: 'acme.test' }], (m) => {
    assert.equal(m.ssoOnlyForEmail('staff@acme.test'), null, 'having SSO is not the same as requiring it');
  });
});

test('the login gate exempts platform_admin, and that exemption is deliberate', () => {
  /*
   * The operator approves turning SSO-only OFF. If the operator's own address sat at an SSO-only
   * domain and that identity provider broke, nobody could sign in to approve anything and the
   * instance would be bricked. Pinned as source because it is a security-relevant exemption that
   * must not be "tidied away" by someone who reads it as a convenience.
   */
  const src = fs.readFileSync(require.resolve('../routes/auth.js'), 'utf8');
  assert.match(src, /user\.role !== 'platform_admin'[\s\S]{0,600}ssoOnlyForUser/,
    'the break-glass exemption must guard the SSO-only check');
  assert.match(src, /code: 'sso_required'/, 'and the refusal must be distinguishable from a bad password');
});
