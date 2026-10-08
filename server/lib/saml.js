'use strict';

/*
 * SAML 2.0 for organization SSO providers (org_sso_providers.kind = 'saml').
 *
 * We are the Service Provider. The flow is SP-initiated only: /api/auth/saml/<slug>/start sends the
 * browser to the IdP with a signed-request-free AuthnRequest (HTTP-Redirect), and the IdP posts a
 * SAMLResponse back to /api/auth/saml/<slug>/acs. Everything after the assertion is verified is the
 * same code OIDC uses (routes/auth.js completeFederatedLogin), so domain confinement, SSO-only,
 * account linking rules, org membership and the cookie hand-off cannot drift between protocols.
 *
 * ⚠️ WHAT IS REQUIRED OF A RESPONSE (node-saml does the XML work; these are our choices):
 *   - the ASSERTION is signed by the IdP certificate we were given (wantAssertionsSigned); a signed
 *     Response wrapping an unsigned assertion is not enough, which closes the classic wrapping hole
 *   - its Issuer is the IdP entityID we were given, its Audience is our SP entityID
 *   - it answers an AuthnRequest WE sent (InResponseTo, kept in saml_requests for 10 minutes so a
 *     scaled-out node can finish a login another began) — so IdP-initiated logins are refused
 *   - it is current (NotBefore/NotOnOrAfter, 3 minutes of clock skew)
 *   - its assertion id has not been used before (saml_used_assertions; a unique insert, so two
 *     copies of one response racing each other cannot both succeed)
 *
 * Only HTTP-Redirect SSO is supported: posting the AuthnRequest would need an auto-submitting form to
 * another origin, which the app's CSP (form-action 'self') rightly forbids.
 */

const crypto = require('crypto');

function dbOf() { return require('../db/database').db; }

const REQUEST_TTL_MS = 10 * 60 * 1000;
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const EMAIL_ATTRS = [
  'email', 'mail', 'emailAddress', 'Email', 'EmailAddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/claims/EmailAddress',
];
const NAME_ATTRS = [
  'displayName', 'name', 'cn',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
];

/* ============================== certificates & metadata ============================== */

/** One or more certificates as PEM strings; accepts PEM blocks or bare base64. false if none valid. */
function normaliseCerts(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  const blocks = raw.includes('-----BEGIN CERTIFICATE-----')
    ? raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []
    : raw.split(/\s*\n\s*\n\s*|\s*,\s*/).filter(Boolean);
  const out = [];
  for (const b of blocks.slice(0, 4)) {
    const b64 = b.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]{200,}$/.test(b64)) return false;
    const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    try { new crypto.X509Certificate(pem); } catch { return false; }
    out.push(pem);
  }
  return out.length ? out : false;
}

/** When the first certificate expires, for the admin screen. */
function certInfo(pems) {
  try {
    const c = new crypto.X509Certificate(pems[0]);
    return { subject: c.subject, valid_to: c.validTo, fingerprint256: c.fingerprint256 };
  } catch { return null; }
}

/**
 * Read an IdP's metadata XML: entityID, the HTTP-Redirect SSO address, and its signing certificates.
 * Returns { entityId, ssoUrl, certs } or { error }.
 */
function parseIdpMetadata(xml) {
  const text = String(xml || '');
  if (text.length > 512 * 1024) return { error: 'The metadata is too large.' };
  if (/<!DOCTYPE/i.test(text)) return { error: 'Metadata with a DOCTYPE is not accepted.' };
  let doc;
  try {
    const { DOMParser } = require('@xmldom/xmldom');
    let parseError = null;
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') parseError = msg; } }).parseFromString(text, 'text/xml');
    if (parseError) return { error: 'The metadata is not valid XML.' };
  } catch { return { error: 'The metadata is not valid XML.' }; }
  const byLocal = (node, name) => {
    const out = [];
    const walk = (n) => { for (let c = n.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) { if (c.localName === name) out.push(c); walk(c); } } };
    walk(node);
    return out;
  };
  const entity = byLocal(doc, 'EntityDescriptor')[0];
  if (!entity) return { error: 'No EntityDescriptor in the metadata.' };
  const idp = byLocal(entity, 'IDPSSODescriptor')[0];
  if (!idp) return { error: 'This metadata does not describe an identity provider (no IDPSSODescriptor).' };
  const sso = byLocal(idp, 'SingleSignOnService').find((e) => e.getAttribute('Binding') === REDIRECT_BINDING);
  if (!sso) return { error: 'The identity provider has no HTTP-Redirect sign-in address. Only HTTP-Redirect is supported.' };
  const certTexts = byLocal(idp, 'KeyDescriptor')
    .filter((k) => !k.getAttribute('use') || k.getAttribute('use') === 'signing')
    .flatMap((k) => byLocal(k, 'X509Certificate').map((c) => c.textContent || ''));
  const certs = normaliseCerts(certTexts.join('\n\n'));
  if (!certs) return { error: 'No usable signing certificate in the metadata.' };
  return { entityId: entity.getAttribute('entityID') || '', ssoUrl: sso.getAttribute('Location') || '', certs };
}

/* ============================== the SP ============================== */

const cacheProvider = {
  async saveAsync(key, value) {
    const now = Date.now();
    dbOf().prepare('INSERT OR REPLACE INTO saml_requests (id, value, created_at) VALUES (?, ?, ?)').run(key, String(value), now);
    dbOf().prepare('DELETE FROM saml_requests WHERE created_at < ?').run(now - REQUEST_TTL_MS);
    return { value: String(value), createdAt: now };
  },
  async getAsync(key) {
    const r = dbOf().prepare('SELECT value, created_at FROM saml_requests WHERE id = ?').get(String(key));
    if (!r || Date.now() - r.created_at > REQUEST_TTL_MS) return null;
    return r.value;
  },
  async removeAsync(key) {
    if (!key) return null;
    const r = dbOf().prepare('DELETE FROM saml_requests WHERE id = ?').run(String(key));
    return r.changes ? String(key) : null;
  },
};

const spEntityIdFor = (origin, slug) => `${origin}/api/auth/saml/${slug}/metadata`;
const acsUrlFor = (origin, slug) => `${origin}/api/auth/saml/${slug}/acs`;

function samlFor(provider, origin) {
  const { SAML, ValidateInResponseTo } = require('@node-saml/node-saml');
  const certs = normaliseCerts(provider.samlCert);
  if (!certs) throw new Error('This provider has no valid signing certificate.');
  return new SAML({
    entryPoint: provider.samlSsoUrl,
    issuer: spEntityIdFor(origin, provider.slug),
    callbackUrl: acsUrlFor(origin, provider.slug),
    audience: spEntityIdFor(origin, provider.slug),
    idpCert: certs,
    idpIssuer: provider.issuer,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,          // many IdPs sign only the assertion; that is what we require
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    acceptedClockSkewMs: 3 * 60 * 1000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider,
    identifierFormat: null,                   // let the IdP choose; we key on the NameID it sends
    disableRequestedAuthnContext: true,       // requesting one breaks Entra ID and ADFS with MFA
    authnRequestBinding: 'HTTP-Redirect',
  });
}

function pick(profile, keys) {
  for (const k of keys) {
    const v = profile[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return '';
}

/** The claims completeFederatedLogin expects, from a verified profile. */
function profileToClaims(profile) {
  const nameId = String(profile.nameID || '').trim();
  let email = pick(profile, EMAIL_ATTRS);
  if (!email && /@/.test(nameId)) email = nameId;
  let name = pick(profile, NAME_ATTRS);
  if (!name) {
    const given = pick(profile, ['givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']);
    const sur = pick(profile, ['sn', 'surname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']);
    name = [given, sur].filter(Boolean).join(' ');
  }
  return { sub: nameId, email, name: name || null };
}

/** The verified assertion's own ID attribute (what a replay would repeat). */
function assertionIdOf(profile) {
  try {
    const xml = typeof profile.getAssertionXml === 'function' ? profile.getAssertionXml() : '';
    const m = /<(?:[\w-]+:)?Assertion\b[^>]*\sID="([^"]+)"/.exec(xml || '');
    return m ? m[1] : null;
  } catch { return null; }
}

/** Record an assertion as used; false when it already was (a replay). */
function consumeAssertion(id) {
  if (!id) return false;
  const db = dbOf();
  try {
    db.prepare('INSERT INTO saml_used_assertions (id, used_at) VALUES (?, ?)').run(String(id).slice(0, 200), Date.now());
    db.prepare('DELETE FROM saml_used_assertions WHERE used_at < ?').run(Date.now() - 24 * 3600 * 1000);
    return true;
  } catch { return false; }
}

module.exports = { assertionIdOf, normaliseCerts, certInfo, parseIdpMetadata, samlFor, profileToClaims, consumeAssertion, spEntityIdFor, acsUrlFor, cacheProvider };
