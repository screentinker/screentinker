'use strict';

/*
 * OpenID Connect — discovery, key handling and ID-token verification.
 *
 * This exists because the previous "OAuth" support verified nothing that mattered. The Google path
 * asked Google's tokeninfo endpoint whether an ACCESS token was valid and then trusted the email in
 * the reply; the Microsoft path handed a bearer token to Graph /me and trusted that. Neither ever
 * checked WHO THE TOKEN WAS ISSUED FOR, and an access token is not a proof of identity — it is a
 * bearer credential for some resource, minted for some application, and Graph will happily describe
 * the user behind a token issued to somebody else's app. Any site a user signs into that asks for
 * `email` or `User.Read` could replay that token here and be issued a session as that user.
 *
 * So identity now comes from an ID TOKEN and nothing else, and the token has to survive:
 *
 *   signature   against the provider's published JWKS, restricted to asymmetric algorithms
 *   iss         exactly the issuer discovery advertised
 *   aud         contains our client_id (and azp === client_id when the token carries one)
 *   exp/nbf     inside a small clock skew
 *   nonce       equal to the one WE generated for this login, which is what stops a token
 *               obtained elsewhere — even a correctly-audienced one — being replayed here
 *
 * Deliberately dependency-free beyond `jsonwebtoken`: Node can import a JWK straight into a
 * KeyObject, so there is no need for jwks-rsa and no second opinion about what a key is.
 */

const crypto = require('crypto');
const net = require('net');
const jwt = require('jsonwebtoken');

/*
 * `alg: "none"` is the oldest JWT attack there is, and HMAC is nearly as bad here: an HS256 token is
 * verified with a SHARED SECRET, and the only "key" we have for a provider is its PUBLIC one — which
 * an attacker also has, and could sign with. Only asymmetric families are ever acceptable.
 */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];

// Providers rotate keys and publish new ones ahead of use, so a short cache is safe and a miss is
// cheap. Discovery changes far less often but is cached the same way for one reason: a provider
// outage should not be able to stall every login for as long as it lasts.
const DISCOVERY_TTL_MS = 60 * 60 * 1000;   // 1 hour
const JWKS_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const FETCH_TIMEOUT_MS = 8000;

const discoveryCache = new Map();  // issuer -> { at, doc }
const jwksCache = new Map();       // jwks_uri -> { at, keys }

/*
 * Every URL this module fetches is ultimately chosen by whoever configured the provider — and since
 * per-org SSO, that is a CUSTOMER, not the operator. Discovery, JWKS and the token endpoint are
 * therefore server-side request forgery primitives unless they are constrained.
 *
 * Two rules, both cheap:
 *   https only        — an http:// target is a plaintext credential leak as well as a way to reach
 *                       services that never expected a request from inside the network.
 *   public hosts only — loopback, RFC1918, CGNAT, link-local (169.254.169.254 is cloud metadata),
 *                       multicast and reserved ranges, in BOTH address families, including the
 *                       IPv4-mapped IPv6 forms that a prefix match misses.
 *
 * ⚠️ This is a literal-address check, not full SSRF protection: a hostname that RESOLVES to a
 * private address still passes, because refusing that needs resolve-then-pin plumbing that Node's
 * fetch does not expose. It raises the bar from "type an internal URL" to "control public DNS".
 * README.md documents this limitation under per-organization SSO.
 */
/*
 * Addresses are parsed as ADDRESSES and compared by range. This started life as a prefix regex,
 * which was wrong in both directions: it missed `[::ffff:127.0.0.1]` — the entire IPv4 space
 * re-encoded, which WHATWG URL normalises to `[::ffff:7f00:1]` so no dotted-quad prefix can match,
 * and a review reached a loopback service straight through it — while also matching plain TEXT, so
 * every hostname beginning "fc" or "fd" was refused (fcm.googleapis.com, fcps.edu).
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT / Tailscale
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local — 169.254.169.254 is cloud metadata
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // benchmarking
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);

function isBlockedV4(ip) {
  const addr = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (addr & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
  });
}

function isBlockedV6(ip) {
  const low = ip.toLowerCase();
  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a hat — judge the IPv4.
  const mapped = low.match(/^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
    || low.match(/^::(ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    if (mapped[2] && mapped[2].includes('.')) return isBlockedV4(mapped[2]);
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isBlockedV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'));
  }
  if (low === '::' || low === '::1') return true;              // unspecified (= loopback on Linux), loopback
  if (/^f[cd]/.test(low)) return true;                          // fc00::/7 unique-local
  if (/^fe[89ab]/.test(low)) return true;                       // fe80::/10 link-local
  if (/^ff/.test(low)) return true;                             // multicast
  return false;
}

/*
 * ⚠️ assertFetchable() sees the URL, not where it resolves: a provider NAME that resolves to a
 * private address passed it. guardedFetch vets the address the socket actually connects to, and
 * like `redirect: 'manual'` it never follows a 3xx (the status checks below still refuse one).
 */
const { guardedFetch } = require('./ai-fetch');
let transport = guardedFetch;
/** Tests point this at a pretend provider; null restores the guarded transport. */
function _setTransport(fn) { transport = fn || guardedFetch; }

function assertFetchable(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (u.protocol !== 'https:') throw new Error('provider URLs must use https');

  /*
   * A trailing root dot is a legal, fully-qualified spelling of the same name, and WHATWG URL keeps
   * it — so `https://localhost./` matched neither alternative below and was ALLOWED. The parser
   * normalises the literal-IP forms itself (`127.0.0.1.` becomes `127.0.0.1`), so only the name
   * form slipped, and on a resolver that synthesizes `localhost.` it resolves to loopback.
   */
  const host = u.hostname.replace(/\.$/, '');
  // URL keeps IPv6 literals in brackets; net.isIP does not want them.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = net.isIP(bare);

  const blocked = family === 4 ? isBlockedV4(bare)
    : family === 6 ? isBlockedV6(bare)
      : /^(localhost|.*\.localhost)$/i.test(host);

  if (blocked) throw new Error('provider host is not publicly routable');
  return u;
}

/** fetch with a timeout, because a hanging IdP must not hang a login forever. */
async function getJson(url) {
  assertFetchable(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    /*
     * redirect: 'manual' — following redirects would let an allowlisted host bounce us to a blocked
     * one, which defeats the check above entirely. A provider that redirects its own well-known
     * document is misconfigured, and saying so is more useful than quietly following it.
     */
    const res = await transport(url, { signal: ctl.signal });
    if (res.status >= 300 && res.status < 400) throw new Error(`${url} redirected; provider URLs must be final`);
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The provider's own description of itself.
 *
 * ⚠️ The discovered `issuer` is checked against the configured one. Discovery is fetched over TLS
 * from a URL derived from the issuer, so this is belt-and-braces — but a provider whose document
 * claims a DIFFERENT issuer is either misconfigured or hostile, and either way its tokens must not
 * be accepted under a name it does not own.
 */
async function discover(issuer) {
  const key = String(issuer).replace(/\/+$/, '');
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;

  const url = `${key}/.well-known/openid-configuration`;
  const doc = await getJson(url);

  const advertised = String(doc.issuer || '').replace(/\/+$/, '');
  if (advertised !== key) {
    throw new Error(`discovery issuer mismatch: configured ${key}, document says ${doc.issuer}`);
  }
  for (const required of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[required]) throw new Error(`discovery for ${key} is missing ${required}`);
  }

  discoveryCache.set(key, { at: Date.now(), doc });
  return doc;
}

/**
 * The signing key for one token.
 *
 * An unknown `kid` forces ONE refresh: that is the normal shape of a key rotation, and refusing to
 * refetch would fail every login until the cache expired. It is bounded to one refresh per call so
 * a token quoting nonsense cannot be used to hammer the provider.
 */
async function keyForKid(jwksUri, kid) {
  let entry = jwksCache.get(jwksUri);
  const fresh = entry && Date.now() - entry.at < JWKS_TTL_MS;

  if (!fresh || !entry.keys.some((k) => k.kid === kid)) {
    const doc = await getJson(jwksUri);
    entry = { at: Date.now(), keys: Array.isArray(doc.keys) ? doc.keys : [] };
    jwksCache.set(jwksUri, entry);
  }

  const jwk = entry.keys.find((k) => k.kid === kid)
    // A provider with exactly one key may omit kid entirely; anything ambiguous is refused rather
    // than guessed, because "try each key until one verifies" is how you accept a key you did not mean to.
    || (!kid && entry.keys.length === 1 ? entry.keys[0] : null);
  if (!jwk) throw new Error(`no signing key for kid ${kid || '(none)'}`);

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify an ID token and return its claims.
 *
 * `nonce` is REQUIRED by this function even though the spec makes it conditional. Every flow here
 * is a browser login we initiated, so we always have one to compare — and it is the single check
 * that distinguishes "a token minted for us, now" from "a token minted for us at some point,
 * captured, and replayed".
 */
async function verifyIdToken(idToken, { issuer, clientId, nonce }) {
  if (!idToken || typeof idToken !== 'string') throw new Error('no id_token');
  if (!nonce) throw new Error('no nonce to verify against');

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header) throw new Error('id_token is not a JWT');
  if (!ALLOWED_ALGS.includes(decoded.header.alg)) {
    throw new Error(`refusing id_token algorithm ${decoded.header.alg}`);
  }

  const doc = await discover(issuer);
  const key = await keyForKid(doc.jwks_uri, decoded.header.kid);

  // jsonwebtoken checks signature, exp, nbf, iss and aud. The algorithm allowlist is passed
  // explicitly so the header cannot choose how it is verified.
  const claims = jwt.verify(idToken, key, {
    algorithms: ALLOWED_ALGS,
    issuer: doc.issuer,
    audience: clientId,
    clockTolerance: 60,
  });

  if (claims.nonce !== nonce) throw new Error('id_token nonce does not match this login');

  /*
   * azp names the party the token was issued TO when it differs from the audience. If it is present
   * it must be us: a token with our client_id merely in a multi-valued `aud`, issued to a different
   * application, is exactly the confused-deputy case this whole file exists to prevent.
   */
  if (claims.azp && claims.azp !== clientId) {
    throw new Error('id_token was issued to a different application');
  }
  if (!claims.sub) throw new Error('id_token has no subject');

  return claims;
}

/** PKCE S256. The verifier never leaves us; only its hash goes to the provider. */
function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Exchange the authorization code.
 *
 * PKCE means a public client needs no secret, which is what lets a self-hoster configure a provider
 * without one. A secret is still sent when configured, because some providers (and some admins)
 * require confidential clients.
 */
async function exchangeCode({ issuer, clientId, clientSecret, code, redirectUri, verifier }) {
  const doc = await discover(issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret) {
    // client_secret_basic is the form every provider accepts; client_secret_post is not universal.
    headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let payload;
  try {
    assertFetchable(doc.token_endpoint);
    const res = await transport(doc.token_endpoint, { method: 'POST', headers, body, signal: ctl.signal });
    payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The provider's own error is far more useful than "exchange failed" — a wrong redirect_uri
      // or an unregistered client is the overwhelmingly common setup mistake and it says so here.
      throw new Error(payload.error_description || payload.error || `token endpoint responded ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!payload.id_token) throw new Error('provider returned no id_token — is the openid scope requested?');
  return payload;
}

/** Test seam: drop cached discovery/JWKS so a test can change what a provider claims. */
function _resetCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

/**
 * The provider's published keys, straight from the document. Used by the configuration test so an
 * admin learns at setup time that a provider publishes no signing keys, rather than at first login.
 */
async function fetchJwks(jwksUri) {
  return getJson(jwksUri);
}

module.exports = { _setTransport,
  discover,
  assertFetchable,
  fetchJwks,
  verifyIdToken,
  exchangeCode,
  createPkce,
  randomToken,
  ALLOWED_ALGS,
  _resetCaches,
};
