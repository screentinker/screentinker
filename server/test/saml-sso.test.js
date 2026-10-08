'use strict';

/*
 * SAML 2.0 org SSO, end to end against a real server and a mock IdP that signs real assertions.
 *
 * What has to hold:
 *   - an org admin can add a SAML provider from IdP metadata; the API shows what the IdP needs from
 *     us and never a certificate body
 *   - /sso/start routes a SAML org's domain to the SAML start, which redirects to the IdP with an
 *     AuthnRequest; a response to THAT request signs the person in through the same cookie hand-off
 *     as OIDC, and they join the org
 *   - refused: a replay, an unsolicited (IdP-initiated) response, a tampered assertion, one signed
 *     by another key, one for another audience, an expired one, and an email outside the org's
 *     verified domains
 *
 * The IdP keys are generated per run with openssl, so no private key lives in the repository.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { SignedXml } = require('xml-crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
let ADMIN, ORG, PROVIDER;
const IDP_ENTITY = 'https://idp.acme.test/saml';
const KEYS = {};

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q1 = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).get(...a); } finally { r.close(); } };
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...opts });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}
const auth = (body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN.token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function keypair(name) {
  const dir = path.join(DATA_DIR, 'idp');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`),
    '-subj', `/CN=test-idp-${name}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8') };
}
const certBody = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');

function metadataXml(cert) {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody(cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/sso/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.test/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

/** Start a login and return the AuthnRequest id the server minted. */
async function startLogin() {
  const r = await api(`/api/auth/saml/${PROVIDER.slug}/start`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://idp.acme.test/sso');
  const xml = zlib.inflateRawSync(Buffer.from(loc.searchParams.get('SAMLRequest'), 'base64')).toString();
  return /\sID="([^"]+)"/.exec(xml)[1];
}

/** A SAMLResponse as an IdP would post it, with the assertion signed. */
function samlResponse({ inResponseTo, email = 'pat@acme.test', nameId = 'pat-0001', key = KEYS.idp.key,
  audience = PROVIDER.sp_entity_id, notOnOrAfterMs = 5 * 60 * 1000, tamper = null } = {}) {
  const now = new Date();
  const later = new Date(now.getTime() + notOnOrAfterMs).toISOString();
  const before = new Date(now.getTime() - 60 * 1000).toISOString();
  const aid = `_a${crypto.randomBytes(12).toString('hex')}`;
  const irt = inResponseTo ? ` InResponseTo="${inResponseTo}"` : '';
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${later}" Recipient="${PROVIDER.acs_url}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Pat Example</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
  const sig = new SignedXml({ privateKey: key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  let signed = sig.getSignedXml();
  if (tamper) signed = tamper(signed);
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(12).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${PROVIDER.acs_url}"${irt}><saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

async function postAcs(b64) {
  const r = await api(`/api/auth/saml/${PROVIDER.slug}/acs`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: b64 }).toString(),
  });
  assert.equal(r.status, 302);
  return { location: r.headers.get('location'), cookie: r.headers.get('set-cookie') || '' };
}
const ssoError = (loc) => new URLSearchParams(loc.split('?')[1] || '').get('sso_error');

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-sso-'));
  KEYS.idp = keypair('idp');
  KEYS.other = keypair('other');
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', APP_URL: BASE },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'Passw0rd123', name: 'Owner' }) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  ADMIN = { token: reg.body.token, id: reg.body.user.id, ws: reg.body.current_workspace_id };
  run('UPDATE users SET email_verified = 1 WHERE id = ?', ADMIN.id);
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', ADMIN.ws).organization_id;
});

after(() => { if (proc) proc.kill('SIGKILL'); try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('an org admin adds a SAML provider from IdP metadata', async () => {
  const bad = await api(`/api/organizations/${ORG}/sso`, auth({ kind: 'saml', name: 'Acme', metadata_xml: '<nope', email_domains: 'acme.test' }));
  assert.equal(bad.status, 400);
  const noRedirect = await api(`/api/organizations/${ORG}/sso`, auth({ kind: 'saml', name: 'Acme',
    metadata_xml: metadataXml(KEYS.idp.cert).replace(/<md:SingleSignOnService Binding="[^"]*HTTP-Redirect"[^>]*\/>/, ''), email_domains: 'acme.test' }));
  assert.equal(noRedirect.status, 400, 'POST-only IdPs are refused with a reason');
  assert.match(noRedirect.body.error, /HTTP-Redirect/);

  const r = await api(`/api/organizations/${ORG}/sso`, auth({ kind: 'saml', name: 'Acme SAML', metadata_xml: metadataXml(KEYS.idp.cert), email_domains: 'acme.test' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  PROVIDER = r.body;
  assert.equal(PROVIDER.kind, 'saml');
  assert.equal(PROVIDER.idp_entity_id, IDP_ENTITY);
  assert.equal(PROVIDER.sso_url, 'https://idp.acme.test/sso', 'the HTTP-Redirect address, not the POST one');
  assert.equal(PROVIDER.acs_url, `${BASE}/api/auth/saml/${PROVIDER.slug}/acs`);
  assert.equal(PROVIDER.sp_entity_id, `${BASE}/api/auth/saml/${PROVIDER.slug}/metadata`);
  assert.match(PROVIDER.cert.subject, /test-idp-idp/);
  assert.ok(!JSON.stringify(PROVIDER).includes(certBody(KEYS.idp.cert).slice(0, 40)), 'the certificate body is not echoed');

  // DNS proof cannot happen in a test; record it as the verify route would.
  run('UPDATE org_sso_domains SET verified_at = ? WHERE provider_id = ?', Math.floor(Date.now() / 1000), PROVIDER.id);

  const t = await api(`/api/organizations/${ORG}/sso/${PROVIDER.id}/test`, auth({}));
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.equal(t.body.acs_url, PROVIDER.acs_url);
});

test('the SP metadata tells the IdP our entity ID and ACS address', async () => {
  const r = await api(`/api/auth/saml/${PROVIDER.slug}/metadata`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /samlmetadata\+xml/);
  assert.ok(r.body.includes(`entityID="${PROVIDER.sp_entity_id}"`));
  assert.ok(r.body.includes(`Location="${PROVIDER.acs_url}"`));
  assert.equal((await api('/api/auth/saml/orgnotthere0/metadata')).status, 404);
});

test('email routing sends a SAML org domain to the SAML start', async () => {
  const r = await api('/api/auth/sso/start', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'email=pat%40acme.test' });
  assert.equal(r.status, 200);
  assert.equal(r.body.start_url, `/api/auth/saml/${PROVIDER.slug}/start`);
  // The OIDC start for a SAML slug forwards rather than trying discovery on an entityID.
  const o = await api(`/api/auth/oidc/${PROVIDER.slug}/start`);
  assert.equal(o.headers.get('location'), `/api/auth/saml/${PROVIDER.slug}/start`);
});

test('a signed response to our request signs the person in and joins them to the org', async () => {
  const id = await startLogin();
  const resp = samlResponse({ inResponseTo: id });
  const { location, cookie } = await postAcs(resp);
  assert.equal(location, '/app#/login?sso=1', location);
  const claim = /st_sso_claim=([^;]+)/.exec(cookie);
  assert.ok(claim, 'the one-shot claim cookie is set');
  assert.ok(!location.includes('token'), 'no token in the URL');

  const c = await api('/api/auth/sso/claim', { method: 'POST', headers: { Cookie: `st_sso_claim=${claim[1]}` } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.user.email, 'pat@acme.test');
  const u = q1('SELECT id, auth_provider, provider_id, name FROM users WHERE email = ?', 'pat@acme.test');
  assert.equal(u.auth_provider, PROVIDER.slug);
  assert.equal(u.provider_id, 'pat-0001');
  assert.equal(u.name, 'Pat Example');
  assert.ok(q1('SELECT 1 AS x FROM organization_members WHERE organization_id = ? AND user_id = ?', ORG, u.id), 'joined the org');

  // REPLAY: the same response again fails — the request id is spent and the assertion id is used.
  assert.equal(ssoError((await postAcs(resp)).location), 'verification_failed');

  // ...and the assertion ledger alone stops it too: even with the request id put back (two nodes
  // racing, or a cache that lost a delete), a used assertion is not accepted twice.
  run('INSERT INTO saml_requests (id, value, created_at) VALUES (?, ?, ?)', id, new Date().toISOString(), Date.now());
  assert.equal(ssoError((await postAcs(resp)).location), 'verification_failed');
  assert.ok(q1('SELECT 1 AS x FROM saml_used_assertions'), 'the assertion was recorded');
});

test('an unsolicited (IdP-initiated) response is refused', async () => {
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: null }))).location), 'verification_failed');
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: '_madeup' }))).location), 'verification_failed');
});

test('a tampered assertion, or one signed by another key, is refused', async () => {
  let id = await startLogin();
  const tampered = samlResponse({ inResponseTo: id, tamper: (x) => x.replace('pat@acme.test', 'owner@example.test') });
  assert.equal(ssoError((await postAcs(tampered)).location), 'verification_failed');
  id = await startLogin();
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: id, key: KEYS.other.key }))).location), 'verification_failed');
  // Stripping the signature entirely does not fall back to "unsigned is fine".
  id = await startLogin();
  const unsigned = samlResponse({ inResponseTo: id, tamper: (x) => x.replace(/<(ds:)?Signature[\s\S]*<\/(ds:)?Signature>/, '') });
  assert.equal(ssoError((await postAcs(unsigned)).location), 'verification_failed');
});

test('another audience, or an expired assertion, is refused', async () => {
  let id = await startLogin();
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: id, audience: 'https://elsewhere.test/sp' }))).location), 'verification_failed');
  id = await startLogin();
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: id, notOnOrAfterMs: -10 * 60 * 1000 }))).location), 'verification_failed');
});

test('a validly signed assertion outside the org verified domains is refused (no takeover)', async () => {
  const id = await startLogin();
  const r = await postAcs(samlResponse({ inResponseTo: id, email: 'owner@example.test', nameId: 'evil' }));
  assert.equal(ssoError(r.location), 'domain_not_allowed');
  assert.equal(q1('SELECT auth_provider FROM users WHERE id = ?', ADMIN.id).auth_provider, 'local');
});

test('a certificate can be replaced, and the old key stops working', async () => {
  const r = await api(`/api/organizations/${ORG}/sso/${PROVIDER.id}`, auth({ cert: KEYS.other.cert }, 'PUT'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.cert.subject, /test-idp-other/);
  assert.equal(r.body.sso_url, 'https://idp.acme.test/sso', 'unsupplied fields are kept');
  let id = await startLogin();
  assert.equal(ssoError((await postAcs(samlResponse({ inResponseTo: id, nameId: 'pat-0001' }))).location), 'verification_failed');
  id = await startLogin();
  assert.equal((await postAcs(samlResponse({ inResponseTo: id, nameId: 'pat-0001', key: KEYS.other.key }))).location, '/app#/login?sso=1');
  const bad = await api(`/api/organizations/${ORG}/sso/${PROVIDER.id}`, auth({ cert: 'not a certificate' }, 'PUT'));
  assert.equal(bad.status, 400);
});
