'use strict';

/*
 * Per-organization SSO — the customer-facing half of single sign-on.
 *
 * Instance-wide providers live in the environment and belong to whoever runs the server. These
 * belong to a CUSTOMER: an organization points ScreenTinker at its own identity provider, and its
 * people sign in with it without the operator editing a config file.
 *
 * The login flow is unchanged. A provider configured here is resolved by exactly the same
 * oidc-providers.get(slug) the environment ones go through, so there is one authorization request
 * builder, one token exchange and one verifier — not a second, less-tested path for tenants.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const secretbox = require('../lib/secretbox');
const oidc = require('../lib/oidc');
const { logActivity, getClientIp } = require('../services/activity');
const { isPublicEmailDomain } = require('../lib/public-email-domains');
const domainVerify = require('../lib/domain-verify');
const emailSvc = require('../services/email');

/*
 * Only an org owner/admin may configure how their people sign in — it is the most security-relevant
 * setting a tenant has. Platform staff are deliberately NOT given a bypass here: this is customer
 * configuration, and an operator who needs to change it can do so as a member of that organization.
 */
function requireOrgAdmin(req, res, next) {
  const orgId = req.params.orgId;
  if (!orgId) return res.status(400).json({ error: 'organization required' });
  const row = db.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(orgId, req.user.id);
  if (!row || (row.role !== 'org_owner' && row.role !== 'org_admin')) {
    // 404 rather than 403: an outsider should not learn that an organization id exists.
    return res.status(404).json({ error: 'Not found' });
  }
  req.orgId = orgId;
  next();
}

/*
 * Configuring SSO requires a VERIFIED email address, on top of being an org admin.
 *
 * Everything else here rests on the identity of the person doing it: they claim domains, they point
 * the organization at an identity provider, and they are who the operator's claim notification
 * names. An unverified address is an assertion nobody has checked, so without this the entire
 * feature — including domain claims — is reachable by anyone who can type an address into the
 * signup form and never open the mail.
 *
 * Reads are deliberately NOT gated: seeing your own organization's configuration changes nothing,
 * and locking an admin out of the screen that explains why sign-in is broken helps no one.
 */
function requireVerifiedAdmin(req, res, next) {
  const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
  if (!row || !row.email_verified) {
    return res.status(403).json({
      error: 'Verify your email address before configuring single sign-on.',
      code: 'email_unverified',
    });
  }
  next();
}

/*
 * The slug is a URL path segment and is generated, never chosen.
 *
 * Two customers both wanting "okta" must not collide, and one must not be able to guess or squat
 * another's. It is random and globally unique; the admin only ever sees the display name.
 */
const newSlug = () => `org${crypto.randomBytes(6).toString('hex')}`;

/*
 * SAML fields from a create/update body (lib/saml.js): IdP metadata XML, or the three values by hand.
 * Returns { issuer, ssoUrl, cert } (only what was supplied, for an update) or { error }.
 */
function samlFieldsFrom(body, existing = null) {
  const saml = require('../lib/saml');
  const b = body || {};
  let issuer = b.idp_entity_id !== undefined ? String(b.idp_entity_id || '').trim() : undefined;
  let ssoUrl = b.sso_url !== undefined ? String(b.sso_url || '').trim() : undefined;
  let certs = b.cert !== undefined ? saml.normaliseCerts(b.cert) : undefined;
  if (b.metadata_xml) {
    const m = saml.parseIdpMetadata(b.metadata_xml);
    if (m.error) return { error: m.error };
    issuer = m.entityId; ssoUrl = m.ssoUrl; certs = m.certs;
  }
  if (!existing || issuer !== undefined) { if (!issuer) return { error: 'The identity provider entity ID is required (paste its metadata, or enter it).' }; }
  if (!existing || ssoUrl !== undefined) {
    let u; try { u = new URL(ssoUrl); } catch { return { error: 'The sign-in (SSO) address is not a valid URL.' }; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return { error: 'The sign-in (SSO) address must use https.' };
  }
  if (!existing || certs !== undefined) { if (!certs) return { error: 'A valid signing certificate (PEM) is required.' }; }
  return { issuer, ssoUrl, cert: certs ? certs.join('\n') : undefined };
}

function publicOrigin(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

/** Never let a secret out of the API, in either direction of a round trip. */
function toPublic(row, req = null) {
  if (row.kind === 'saml') {
    const saml = require('../lib/saml');
    const origin = req ? publicOrigin(req) : '';
    const certs = saml.normaliseCerts(row.saml_cert);
    return {
      id: row.id, slug: row.slug, name: row.name, kind: 'saml',
      idp_entity_id: row.issuer, sso_url: row.saml_sso_url,
      cert: certs ? saml.certInfo(certs) : null,
      email_domains: row.email_domains, enabled: !!row.enabled,
      login_url: `/api/auth/saml/${row.slug}/start`,
      // What the admin gives their IdP.
      sp_entity_id: saml.spEntityIdFor(origin, row.slug),
      acs_url: saml.acsUrlFor(origin, row.slug),
      metadata_url: `${origin}/api/auth/saml/${row.slug}/metadata`,
      domains: domainsFor(row.id),
    };
  }
  return {
    kind: 'oidc',
    id: row.id,
    slug: row.slug,
    name: row.name,
    issuer: row.issuer,
    client_id: row.client_id,
    has_client_secret: !!row.client_secret_enc,
    scopes: row.scopes,
    email_domains: row.email_domains,
    enabled: !!row.enabled,
    login_url: `/api/auth/oidc/${row.slug}/start`,
    callback_url: `/api/auth/oidc/${row.slug}/callback`,
    // Domains and their proof state. A provider whose domains are all unverified can be saved and
    // looks configured, but routes nobody — the UI needs this to say so rather than imply success.
    domains: domainsFor(row.id),
  };
}

/*
 * Domains are the routing key, so they are normalised hard: lowercased, de-duplicated, stripped of
 * a leading @ or scheme someone pasted, and validated as something that can actually be the right
 * hand side of an address. A wildcard is refused — "*" would route every unrecognised address at
 * one customer's IdP.
 */
const MAX_DOMAINS = 50;

function normaliseDomains(raw) {
  const seen = new Set();
  for (const part of String(raw || '').split(/[,\s]+/)) {
    /*
     * Capped. Uncapped, one verified org admin could POST 20,000 domains inside the 12 MB body
     * limit: 20,000 rows inserted under a single write lock (stalling every other query on the
     * instance) and 20,000 notification emails per platform admin. No real organization signs in
     * from fifty domains, and an org that does can create a second provider.
     */
    if (seen.size >= MAX_DOMAINS) {
      const e = new Error(`at most ${MAX_DOMAINS} sign-in domains per provider`);
      e.status = 400;
      throw e;
    }
    let d = part.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      throw new Error(`"${part.trim()}" is not a valid email domain`);
    }
    /*
     * A consumer mailbox provider is never an organization's sign-in domain, and claiming one is an
     * attack rather than a mistake: every Gmail or Outlook user typing their address into this
     * product's login page would be offered a "sign in with your organization" button pointing at
     * one tenant's infrastructure. It also lets one cheap account deny a public domain to everyone.
     */
    if (isPublicEmailDomain(d)) {
      const e = new Error(`${d} is a public email provider and cannot be used as a sign-in domain. `
        + 'Use a domain your organization owns.');
      e.status = 400;
      throw e;
    }
    seen.add(d);
  }
  return [...seen].join(',');
}

/**
 * A domain may belong to ONE organization.
 *
 * Without this, a second tenant could claim a domain already routed elsewhere and quietly capture
 * that company's logins — the worst failure this feature could have. First claim wins; the loser is
 * told which domain clashed and nothing about who holds it.
 */
function assertDomainsFree(domains, orgId, excludeProviderId) {
  if (!domains) return;
  for (const d of domains.split(',')) {
    const row = db.prepare('SELECT * FROM org_sso_domains WHERE domain = ?').get(d);
    if (!row) continue;
    if (row.provider_id && row.provider_id === excludeProviderId) continue;
    /*
     * A lapsed unverified claim reserves nothing. Clearing it here rather than on a timer means the
     * domain frees itself the moment someone else asks for it, and there is no sweeper to forget to
     * run — a squatter's unprovable claim simply stops being an obstacle.
     */
    if (domainVerify.isClaimExpired(row)) {
      db.prepare('DELETE FROM org_sso_domains WHERE id = ?').run(row.id);
      continue;
    }
    // Same-org duplicates were allowed and should not have been: two providers claiming one
    // domain makes routing depend on table-scan order, so half a company's staff get sent to an
    // identity provider that has never heard of them.
    const e = new Error(row.organization_id === orgId
      ? `the domain ${d} is already used by another of your providers`
      : `the domain ${d} is already used for sign-in by another organization`);
    e.status = 409;
    throw e;
  }
}

/*
 * Bring the claimed-domain rows in line with what the admin typed.
 *
 * A newly claimed domain arrives UNVERIFIED and stays inert until DNS proves the claim — it routes
 * nobody and the login callback refuses assertions for it. Re-typing an existing domain must not
 * reset that proof, which is why this diffs rather than deleting and re-inserting: a save on the
 * name field would otherwise silently un-verify every domain the customer had already proved, and
 * log their whole company out.
 *
 * Runs inside the caller's transaction so a domain cannot be reserved by two organizations at once.
 */
function syncDomains(providerId, orgId, domains) {
  const wanted = domains ? domains.split(',').filter(Boolean) : [];
  const existing = db.prepare('SELECT * FROM org_sso_domains WHERE provider_id = ?').all(providerId);
  const stale = new Map(existing.map((r) => [r.domain, r]));
  const claimed = [];   // newly claimed, for the operator notification — sent AFTER the transaction

  for (const d of wanted) {
    const mine = stale.get(d);
    if (mine && !domainVerify.isClaimExpired(mine)) {
      stale.delete(d);            // already ours and still live — keep any proof that happened
      continue;
    }
    if (mine) {
      /*
       * A LAPSED claim is not renewed in place. Renewing silently is what made the 8-hour limit
       * meaningless: a review held a domain indefinitely at one request per window, and because a
       * renewal was not a new claim, the operator was told exactly once, on day zero.
       *
       * So the row is dropped and re-created: the token changes (a record left over from the
       * abandoned attempt cannot satisfy the new one), and it counts as a fresh claim, which means
       * it is notified again. Squatting is not made impossible — it is made loud.
       */
      stale.delete(d);
      db.prepare('DELETE FROM org_sso_domains WHERE id = ?').run(mine.id);
    }
    assertDomainsFree(d, orgId, providerId);
    db.prepare(`INSERT INTO org_sso_domains (id, organization_id, provider_id, domain, token)
                VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), orgId, providerId, d, domainVerify.newToken());
    claimed.push(d);
  }
  for (const row of stale.values()) {
    db.prepare('DELETE FROM org_sso_domains WHERE id = ?').run(row.id);
  }
  return claimed;
}

/*
 * Tell the operator that a tenant has claimed a domain.
 *
 * DNS verification makes a claim worthless without control of the domain, so this is not what stops
 * abuse — it is what makes abuse VISIBLE. A tenant claiming `microsoft.com` will never verify it,
 * but an operator still wants to know somebody tried, and the notification is the difference
 * between finding that out now and finding it out from the company involved.
 *
 * Deliberately NOT sent to postmaster@ the claimed domain. That would mean this product emails
 * third parties who never signed up for it, on input any tenant can supply — a spam cannon with a
 * ScreenTinker return address. The operator can contact a domain owner; the server should not do it
 * unprompted.
 *
 * Failure to send is logged and swallowed: a mail outage must not stop a customer configuring SSO.
 */
function notifyOperatorOfClaim(req, { domains, orgId, providerName }) {
  try {
    if (!domains || !domains.length) return;
    // Always log, even with no mail transport — otherwise an instance without email has no record
    // of a claim at all, and those are exactly the instances least likely to notice.
    console.log(`[org-sso] domain(s) claimed by org ${orgId} (${providerName}): ${domains.join(', ')}`);
    if (!emailSvc.isConfigured()) return;
    // COALESCE, because email_alerts is nullable in practice on older rows and `= 1` silently
    // excludes NULL — the activation-nudge query already defends this way.
    const admins = db.prepare("SELECT email FROM users WHERE role = 'platform_admin' AND COALESCE(email_alerts, 1) = 1").all();
    if (!admins.length) return;
    const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
    const who = req.user && req.user.email ? req.user.email : 'an administrator';
    // ONE message per save listing every domain, not one per domain per admin — fifty admins
    // claiming ten domains was five hundred messages from a single request.
    const body = [
      `${who} claimed ${domains.length} sign-in domain(s):`,
      '',
      ...domains.map((d) => `  ${d}`),
      '',
      `Organization: ${org ? org.name : orgId} (${orgId})`,
      `Provider:     ${providerName}`,
      '',
      'A claimed domain routes nobody until a DNS TXT record proves it, and the claim lapses after',
      '8 hours if it is not proved. No action is needed unless this looks wrong.',
    ].join('\n');
    const subject = domains.length === 1
      ? `SSO domain claimed: ${domains[0]}`
      : `${domains.length} SSO domains claimed`;   // services/email.js adds the [ScreenTinker] prefix
    for (const a of admins) {
      Promise.resolve(emailSvc.sendEmail({ to: a.email, subject, text: body }))
        .catch((e) => console.error('[org-sso] claim notification failed:', e && e.message));
    }
  } catch (e) {
    console.error('[org-sso] claim notification failed:', e && e.message);
  }
}

/*
 * Tell the operator that a customer wants password login re-opened.
 *
 * The mail deliberately carries NO action link. A token that acts on its own turns every forwarded,
 * archived or auto-previewed copy of this message into a way to switch off a customer's single
 * sign-on; the decision belongs to a signed-in platform admin, so the mail only says where to make
 * it. Logged unconditionally, because an instance with no mail transport still needs a record that
 * somebody asked.
 */
function notifyOperatorOfRemovalRequest(req, { id, orgId, orgName, reason }) {
  try {
    const who = req.user && req.user.email ? req.user.email : 'an administrator';
    console.warn(`[org-sso] SSO-ONLY REMOVAL REQUESTED for org ${orgName || orgId} (${orgId}) by ${who} — request ${id}`);
    if (!emailSvc.isConfigured()) return;
    const admins = db.prepare("SELECT email FROM users WHERE role = 'platform_admin' AND COALESCE(email_alerts, 1) = 1").all();
    if (!admins.length) return;
    const body = [
      `${who} has asked to stop requiring single sign-on for ${orgName || orgId}.`,
      '',
      'Approving this RE-OPENS password sign-in for everyone at that organization\u2019s verified',
      'domains. Until it is approved, nothing changes.',
      '',
      reason ? `Reason given: ${reason}` : 'No reason was given.',
      '',
      `Organization: ${orgName || ''} (${orgId})`,
      `Request:      ${id}`,
      '',
      'Review it in ScreenTinker under Admin. There is no link in this email on purpose — the',
      'decision has to be made while signed in as a platform admin, so a forwarded copy of this',
      'message cannot turn off a customer\u2019s single sign-on.',
    ].join('\n');
    for (const a of admins) {
      Promise.resolve(emailSvc.sendEmail({
        to: a.email,
        subject: `Approval needed: stop requiring SSO for ${orgName || orgId}`,
        text: body,
      })).catch((e) => console.error('[org-sso] removal notification failed:', e && e.message));
    }
  } catch (e) {
    console.error('[org-sso] removal notification failed:', e && e.message);
  }
}

/*
 * An SSO-only organization may not dismantle its own enforcement sideways.
 *
 * `sso_only` is honoured only while a provider is enabled AND a domain is verified, so disabling
 * the provider, clearing its domains, or deleting it all switch enforcement off — with `sso_only`
 * still reading `true`, no request filed and the operator never told. A review used each of the
 * three, and the delete variant additionally rewrites every federated account to `local`, after
 * which a password reset takes over accounts the identity provider was supposed to own.
 *
 * That made the approval workflow decorative: anyone who could file a request could instead just
 * turn the provider off. So the same interlock guards every route that would leave the tenant with
 * nothing enforcing, and points at the request as the way through.
 */
/** The domains that currently ENFORCE for an organization: verified, on an enabled provider. */
function enforcingDomains(orgId, excludeProviderId = null) {
  return db.prepare(`
    SELECT d.domain FROM org_sso_domains d
      JOIN org_sso_providers p ON p.id = d.provider_id
     WHERE d.organization_id = ? AND d.verified_at IS NOT NULL AND p.enabled = 1
       AND (? IS NULL OR p.id != ?)
  `).all(orgId, excludeProviderId, excludeProviderId).map((r) => r.domain);
}

/*
 * An SSO-only organization may not shrink the set of domains that enforce.
 *
 * The first version of this asked "would ANY provider still enforce?", which was the wrong
 * question twice over, and a review defeated it both ways:
 *
 *   SWAP     it only fired when the resulting domain list was EMPTY, so replacing
 *            `acme.test` with `decoy.test` removed every proof and sailed through — two PUTs
 *            and the customer's domain no longer required anything.
 *   SIBLING  it counted PROVIDERS, so with two configured you could disable the one that owns
 *            your staff's domain while the other, covering a domain nobody signs in at, kept the
 *            answer "yes, something still enforces".
 *
 * The question that matters is per-DOMAIN: after this change, is every domain that enforces today
 * still enforcing? Losing one is exactly what needs the operator, whichever route gets you there.
 */
function assertEnforcementNotReduced(orgId, providerId, nextDomainsFor, what) {
  const org = db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(orgId);
  if (!org || !org.sso_only) return;

  const before = new Set(enforcingDomains(orgId));
  const after = new Set(enforcingDomains(orgId, providerId));
  // Whatever this provider will still contribute afterwards, as VERIFIED domains only — a domain
  // being re-added is unverified, so it does not count as still enforcing.
  for (const d of nextDomainsFor) after.add(d);

  const lost = [...before].filter((d) => !after.has(d));
  if (!lost.length) return;

  const e = new Error(`Your organization requires single sign-on, so ${what} would stop `
    + `${lost.join(', ')} from being covered and leave those people unable to sign in. `
    + 'Ask the people who run this server to approve stopping the requirement first.');
  e.status = 409;
  e.code = 'sso_only_locked';
  throw e;
}

/** A provider's domains, with the DNS record each unverified one still needs. *//** A provider's domains, with the DNS record each unverified one still needs. */
function domainsFor(providerId) {
  return db.prepare('SELECT * FROM org_sso_domains WHERE provider_id = ? ORDER BY domain').all(providerId)
    .map((r) => ({
      domain: r.domain,
      verified: !!r.verified_at,
      verified_at: r.verified_at,
      last_checked_at: r.last_checked_at,
      last_error: r.verified_at ? null : r.last_error,
      // The token is not a secret — it only means anything published in that domain's own DNS.
      ...domainVerify.instructions(r.domain, r.token),
    }));
}

/*
 * What an admin is told when discovery fails.
 *
 * The temptation is to hand back the underlying message, because it is genuinely the most useful
 * thing for a real misconfiguration. But the issuer is caller-supplied and fetched server-side, so
 * that message is an SSRF read primitive: `https://internal-host:8080 responded 403` and
 * `discovery issuer mismatch: … document says <X>` both report on services the caller cannot reach
 * directly. The jwks branch of the /test endpoint was already genericised for exactly this reason;
 * these paths were not, which left the scanner intact one line above the comment saying not to.
 *
 * So: the shape of the failure, never the upstream's answer. The full message goes to the log.
 */
function discoveryErrorMessage(e, issuer) {
  const raw = String((e && e.message) || '');
  console.warn(`[org-sso] discovery failed for ${issuer}: ${raw}`);
  if (/must use https|not publicly routable|not a URL/i.test(raw)) return raw;   // our own guard, no upstream data
  if (/issuer mismatch/i.test(raw)) return 'that URL is not the OpenID issuer it claims to be';
  if (/is missing /i.test(raw)) return 'that issuer published an incomplete OpenID configuration';
  if (/redirected/i.test(raw)) return 'that issuer redirected; the URL must be the final one';
  if (/abort|timeout/i.test(raw)) return 'that issuer did not respond in time';
  return 'no OpenID configuration could be read from that URL';
}

/*
 * Wrap an async handler so a rejection is a 500 rather than a dead server. Express 4 does not await
 * handlers and server.js turns an unhandled rejection into process.exit — see the longer note on
 * asyncRoute in routes/auth.js, which is the same guard for the same reason.
 */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((err) => {
    console.error(`[org-sso] unhandled error in ${req.method} ${req.path}:`, err && err.message);
    // Wrapped for the same reason as in routes/auth.js: a throw while REPORTING an error would
    // become an unhandled rejection and take the process down.
    try {
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
    } catch (e2) {
      console.error('[org-sso] failed to report an error:', e2 && e2.message);
    }
  });
}

router.use(requireAuth, resolveTenancy);

// List an organization's providers.
router.get('/:orgId/sso', requireOrgAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM org_sso_providers WHERE organization_id = ? ORDER BY created_at').all(req.orgId);
  res.json({ providers: rows.map((r) => toPublic(r, req)) });
});

router.post('/:orgId/sso', requireOrgAdmin, requireVerifiedAdmin, asyncRoute(async (req, res) => {
  if ((req.body || {}).kind === 'saml') return createSamlProvider(req, res);
  const { name, issuer, client_id: clientId, client_secret: clientSecret, scopes, email_domains: domains } = req.body || {};
  if (!name || !issuer || !clientId) {
    return res.status(400).json({ error: 'name, issuer and client_id are required' });
  }

  let cleanDomains;
  try {
    cleanDomains = normaliseDomains(domains);
    assertDomainsFree(cleanDomains, req.orgId, null);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  /*
   * The issuer is checked against the live provider BEFORE anything is stored. A typo here would
   * otherwise be discovered by a user staring at a failed login, and the error they would see says
   * nothing useful. Discovery also proves the URL is an OIDC issuer at all rather than a company
   * home page someone pasted.
   */
  try {
    await oidc.discover(String(issuer).trim().replace(/\/+$/, ''));
  } catch (e) {
    return res.status(400).json({ error: `Could not read OpenID configuration from that issuer: ${discoveryErrorMessage(e, issuer)}` });
  }

  const id = crypto.randomUUID();
  const slug = newSlug();
  let newlyClaimed = [];
  /*
   * Re-check the domains INSIDE the transaction. The first check happened before `await
   * oidc.discover()`, which yields the event loop for a network round trip the caller's own IdP
   * controls the length of — two admins racing that window both passed and both got the domain,
   * after which routing became whichever row the scan reached first.
   */
  try {
    db.transaction(() => {
      assertDomainsFree(cleanDomains, req.orgId, null);
      db.prepare(`
        INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id, client_secret_enc, scopes, email_domains, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, req.orgId, slug, String(name).trim(), String(issuer).trim().replace(/\/+$/, ''), String(clientId).trim(),
        clientSecret ? secretbox.encrypt(String(clientSecret)) : null,
        String(scopes || 'openid email profile').trim(), cleanDomains);
      newlyClaimed = syncDomains(id, req.orgId, cleanDomains);
    })();
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[org-sso] create failed:', e.message);
    return res.status(500).json({ error: 'Could not save that provider' });
  }

  // Notified after the transaction commits, so an operator is never told about a claim that rolled
  // back — and never inside it, where a slow mail path would hold a write lock.
  notifyOperatorOfClaim(req, { domains: newlyClaimed, orgId: req.orgId, providerName: String(name).trim() });

  // (userId, action, details, deviceId, ipAddress, workspaceId) — the org id is NOT the 4th arg.
  logActivity(req.user.id, 'org_sso_created', `${name} (${slug}) org=${req.orgId}`, null, getClientIp(req));
  res.status(201).json(toPublic(db.prepare('SELECT * FROM org_sso_providers WHERE id = ?').get(id), req));
}));

/** Create a SAML provider: same domain claiming, transaction and audit trail as an OIDC one. */
function createSamlProvider(req, res) {
  const { name, email_domains: domains } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const f = samlFieldsFrom(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  let cleanDomains;
  try { cleanDomains = normaliseDomains(domains); assertDomainsFree(cleanDomains, req.orgId, null); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const id = crypto.randomUUID();
  const slug = newSlug();
  let newlyClaimed = [];
  try {
    db.transaction(() => {
      assertDomainsFree(cleanDomains, req.orgId, null);
      db.prepare(`INSERT INTO org_sso_providers (id, organization_id, slug, name, issuer, client_id, client_secret_enc, scopes, email_domains, enabled, kind, saml_sso_url, saml_cert)
        VALUES (?, ?, ?, ?, ?, '', NULL, '', ?, 1, 'saml', ?, ?)`)
        .run(id, req.orgId, slug, String(name).trim(), f.issuer, cleanDomains, f.ssoUrl, f.cert);
      newlyClaimed = syncDomains(id, req.orgId, cleanDomains);
    })();
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[org-sso] SAML create failed:', e.message);
    return res.status(500).json({ error: 'Could not save that provider' });
  }
  notifyOperatorOfClaim(req, { domains: newlyClaimed, orgId: req.orgId, providerName: String(name).trim() });
  logActivity(req.user.id, 'org_sso_created', `${name} (${slug}, SAML) org=${req.orgId}`, null, getClientIp(req));
  res.status(201).json(toPublic(db.prepare('SELECT * FROM org_sso_providers WHERE id = ?').get(id), req));
}

router.put('/:orgId/sso/:id', requireOrgAdmin, requireVerifiedAdmin, asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM org_sso_providers WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, issuer, client_id: clientId, client_secret: clientSecret, scopes, email_domains: domains, enabled } = req.body || {};

  let cleanDomains = existing.email_domains;
  // `!== undefined` let a null through, and null took the destructive branch: normaliseDomains(null)
  // is '', which deleted every claimed domain and every DNS proof with it. A client that sends the
  // field as null on an unrelated save must not log a customer's whole company out.
  const domainsSupplied = domains !== undefined && domains !== null;
  if (domainsSupplied) {
    try {
      cleanDomains = normaliseDomains(domains);
      assertDomainsFree(cleanDomains, req.orgId, existing.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
  }

  const isSaml = existing.kind === 'saml';
  let samlNext = null;
  if (isSaml) {
    samlNext = samlFieldsFrom(req.body, existing);
    if (samlNext.error) return res.status(400).json({ error: samlNext.error });
  }
  const nextIssuer = isSaml ? (samlNext.issuer !== undefined ? samlNext.issuer : existing.issuer)
    : (issuer !== undefined ? String(issuer).trim().replace(/\/+$/, '') : existing.issuer);
  if (!isSaml && nextIssuer !== existing.issuer) {
    try { await oidc.discover(nextIssuer); }
    catch (e) { return res.status(400).json({ error: `Could not read OpenID configuration from that issuer: ${discoveryErrorMessage(e, nextIssuer)}` }); }
  }

  /*
   * An absent client_secret LEAVES THE STORED ONE ALONE; an empty string clears it. The API never
   * returns the secret, so a UI that round-trips a form would otherwise blank it on every save —
   * the classic way a settings page silently breaks the thing it is editing.
   */
  // Disabling this provider, or removing the domains it enforces through, is the same act as
  // turning the requirement off — and that needs the operator.
  try {
    const willBeEnabled = enabled === undefined ? !!existing.enabled : !!enabled;
    /*
     * What this provider still covers afterwards: nothing if it is being disabled, otherwise the
     * domains it keeps that are ALREADY verified. A domain typed back in arrives unverified and
     * enforces nobody, which is precisely how the swap bypass worked.
     */
    let keeps = [];
    if (willBeEnabled) {
      const kept = domainsSupplied ? new Set(cleanDomains.split(',').filter(Boolean)) : null;
      keeps = db.prepare("SELECT domain FROM org_sso_domains WHERE provider_id = ? AND verified_at IS NOT NULL")
        .all(existing.id).map((r) => r.domain)
        .filter((d) => (kept ? kept.has(d) : true));
    }
    const what = !willBeEnabled ? 'disabling this provider' : 'changing its sign-in domains';
    assertEnforcementNotReduced(req.orgId, existing.id, keeps, what);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  let newlyClaimed = [];
  const secretEnc = clientSecret === undefined ? existing.client_secret_enc
    : (clientSecret === '' ? null : secretbox.encrypt(String(clientSecret)));

  /*
   * Same transaction, same re-check, and for the same reason as the create path above — this one was
   * missed when that was fixed, which left the race fully open on the route an attacker would
   * actually pick: `await oidc.discover()` on a CHANGED issuer is a round trip whose length the
   * caller's own IdP decides, so it can be held open for the full fetch timeout while a victim
   * organization claims the domain legitimately. The UNIQUE constraint on `domain` is the hard
   * backstop now; this keeps the failure a clean 409 rather than a constraint error.
   */
  try {
    db.transaction(() => {
      if (domainsSupplied) assertDomainsFree(cleanDomains, req.orgId, existing.id);
      db.prepare(`
        UPDATE org_sso_providers
           SET name = ?, issuer = ?, client_id = ?, client_secret_enc = ?, scopes = ?, email_domains = ?, enabled = ?,
               updated_at = strftime('%s','now')
         WHERE id = ?
      `).run(
        name !== undefined ? String(name).trim() : existing.name,
        nextIssuer,
        clientId !== undefined ? String(clientId).trim() : existing.client_id,
        secretEnc,
        scopes !== undefined ? String(scopes).trim() : existing.scopes,
        cleanDomains,
        enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
        existing.id,
      );
      if (isSaml) {
        db.prepare('UPDATE org_sso_providers SET saml_sso_url = ?, saml_cert = ? WHERE id = ?').run(
          samlNext.ssoUrl !== undefined ? samlNext.ssoUrl : existing.saml_sso_url,
          samlNext.cert !== undefined ? samlNext.cert : existing.saml_cert, existing.id);
      }
      if (domainsSupplied) newlyClaimed = syncDomains(existing.id, req.orgId, cleanDomains);
    })();
  } catch (e) {
    // A thrown assertDomainsFree carries its own status; anything else is ours and stays generic
    // rather than returning a raw SQLite message to the caller.
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[org-sso] update failed:', e.message);
    return res.status(500).json({ error: 'Could not save that provider' });
  }

  notifyOperatorOfClaim(req, { domains: newlyClaimed, orgId: req.orgId, providerName: existing.name });

  logActivity(req.user.id, 'org_sso_updated', `${existing.name} (${existing.slug}) org=${req.orgId}`, null, getClientIp(req));
  res.json(toPublic(db.prepare('SELECT * FROM org_sso_providers WHERE id = ?').get(existing.id), req));
}));

/*
 * Check a provider without making anyone log in.
 *
 * The overwhelmingly common failure is a configuration one — an issuer that is a company home page
 * rather than an OIDC issuer, a provider that is unreachable from the server, a JWKS with no signing
 * keys — and every one of those currently surfaces as a user staring at a failed login with an
 * error that says nothing useful. This turns that into an answer at configuration time.
 *
 * ⚠️ It is deliberately honest about its limits. Discovery and JWKS prove the provider EXISTS and
 * that we could verify a token it signed. They cannot prove the client id is right, that the secret
 * matches, or that the redirect URI is registered — only a real authorization round trip does that,
 * and the response says so rather than implying a green tick means "SSO works".
 */
router.post('/:orgId/sso/:id/test', requireOrgAdmin, requireVerifiedAdmin, asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM org_sso_providers WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.kind === 'saml') {
    // SAML has nothing to discover: check what we hold, and hand back what the IdP needs from us.
    const saml = require('../lib/saml');
    const certs = saml.normaliseCerts(row.saml_cert);
    const info = certs ? saml.certInfo(certs) : null;
    const expired = info && Date.parse(info.valid_to) < Date.now();
    const checks = [
      { name: 'certificate', ok: !!certs && !expired, detail: info ? `${info.subject} — valid to ${info.valid_to}` : 'no valid certificate' },
      { name: 'sso_url', ok: /^https:\/\//.test(row.saml_sso_url || '') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(row.saml_sso_url || ''), detail: row.saml_sso_url || 'missing' },
    ];
    const pub = toPublic(row, req);
    return res.json({ ok: checks.every((c) => c.ok), checks, sp_entity_id: pub.sp_entity_id, acs_url: pub.acs_url, metadata_url: pub.metadata_url, note: 'unverifiable_by_test' });
  }

  const checks = [];
  let doc = null;
  try {
    doc = await oidc.discover(row.issuer);
    checks.push({ name: 'discovery', ok: true, detail: doc.issuer });
  } catch (e) {
    checks.push({ name: 'discovery', ok: false, detail: discoveryErrorMessage(e, row.issuer) });
    return res.json({ ok: false, checks });
  }

  checks.push({
    name: 'endpoints',
    ok: !!(doc.authorization_endpoint && doc.token_endpoint),
    detail: doc.authorization_endpoint || 'missing authorization_endpoint',
  });

  try {
    const jwks = await oidc.fetchJwks(doc.jwks_uri);
    const signing = (jwks.keys || []).filter((k) => !k.use || k.use === 'sig');
    checks.push({
      name: 'signing_keys',
      ok: signing.length > 0,
      detail: signing.length ? `${signing.length} key(s)` : 'the provider published no signing keys',
    });
  } catch (e) {
    // Deliberately generic. `jwks_uri` comes from the CALLER'S OWN discovery document, so echoing
    // the upstream status here turned this endpoint into a readable internal port scanner.
    checks.push({ name: 'signing_keys', ok: false, detail: 'could not read the provider keys' });
  }

  // What the admin must have registered at the provider — the single most common thing to get
  // wrong, and something we can state exactly rather than ask them to guess.
  const origin = (process.env.APP_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: checks.every((c) => c.ok),
    checks,
    redirect_uri: `${origin}/api/auth/oidc/${row.slug}/callback`,
    // Said plainly so a passing test is not mistaken for a working login.
    note: 'unverifiable_by_test',
  });
}));

/*
 * Check DNS for the proof, and record the answer.
 *
 * Verification is the whole point of the domain table: until this succeeds the domain routes nobody
 * and the login callback refuses to accept an assertion for it, so a claim on a domain the tenant
 * does not control buys them nothing at all.
 *
 * Deliberately pull-based rather than a background sweep. The admin has just edited DNS and wants to
 * know now, and a per-request check means there is no scheduler to fall over quietly and no window
 * where a verified domain sits unnoticed.
 */
router.post('/:orgId/sso/:id/domains/:domain/verify', requireOrgAdmin, requireVerifiedAdmin, asyncRoute(async (req, res) => {
  const provider = db.prepare('SELECT * FROM org_sso_providers WHERE id = ? AND organization_id = ?')
    .get(req.params.id, req.orgId);
  if (!provider) return res.status(404).json({ error: 'Not found' });

  const row = db.prepare('SELECT * FROM org_sso_domains WHERE provider_id = ? AND domain = ?')
    .get(provider.id, String(req.params.domain).toLowerCase());
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (row.verified_at) return res.json({ ok: true, domain: row.domain, verified: true, already: true });

  /*
   * A lapsed claim is RELEASED, not reissued.
   *
   * Reissuing here renewed the clock, so pressing Verify once per window held a domain forever —
   * the exact squatting the time limit exists to stop, performed through the endpoint meant to
   * enforce it. Releasing it frees the domain for anyone else, and re-adding it is an ordinary new
   * claim: new token, and the operator is notified again.
   */
  if (domainVerify.isClaimExpired(row)) {
    db.prepare('DELETE FROM org_sso_domains WHERE id = ?').run(row.id);
    logActivity(req.user.id, 'org_sso_domain_lapsed', `${row.domain} org=${req.orgId}`, null, getClientIp(req));
    return res.status(409).json({
      ok: false,
      domain: row.domain,
      verified: false,
      expired: true,
      error: 'That claim expired and has been released. Add the domain again to get a new record.',
    });
  }

  const result = await domainVerify.check(row.domain, row.token);

  if (result.ok) {
    db.prepare("UPDATE org_sso_domains SET verified_at = strftime('%s','now'), last_checked_at = strftime('%s','now'), last_error = NULL WHERE id = ?")
      .run(row.id);
    logActivity(req.user.id, 'org_sso_domain_verified', `${row.domain} via ${result.via} org=${req.orgId}`, null, getClientIp(req));
    console.log(`[org-sso] ${row.domain} verified via ${result.via} for org ${req.orgId}`);
    return res.json({ ok: true, domain: row.domain, verified: true, via: result.via });
  }

  db.prepare("UPDATE org_sso_domains SET last_checked_at = strftime('%s','now'), last_error = ? WHERE id = ?")
    .run(result.error, row.id);
  res.status(400).json({
    ok: false,
    domain: row.domain,
    verified: false,
    error: result.error,
    ...domainVerify.instructions(row.domain, row.token),
  });
}));

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * SSO-only: requiring the organization's identity provider.
 */

/** Only a VERIFIED domain can compel anyone — see the note on ssoOnlyForEmail. */
function verifiedDomainCount(orgId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM org_sso_domains d
      JOIN org_sso_providers p ON p.id = d.provider_id
     WHERE d.organization_id = ? AND d.verified_at IS NOT NULL AND p.enabled = 1
  `).get(orgId).n;
}

router.get('/:orgId/sso-only', requireOrgAdmin, (req, res) => {
  const org = db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(req.orgId);
  const pending = db.prepare(
    "SELECT id, requested_by, reason, created_at FROM org_sso_only_requests WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC"
  ).get(req.orgId);
  res.json({
    sso_only: !!(org && org.sso_only),
    verified_domains: verifiedDomainCount(req.orgId),
    pending_removal_request: pending || null,
  });
});

/*
 * Turn it ON. An org admin does this alone: it can only ever reduce the ways into their own tenant,
 * and the people affected are their own.
 */
router.post('/:orgId/sso-only', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  /*
   * Refuse when nothing is proved. Otherwise an organization could switch off password login for
   * accounts it cannot offer any other way in for — locking its own people out of a product they
   * can then only reach by asking the operator to undo it.
   */
  if (!verifiedDomainCount(req.orgId)) {
    return res.status(400).json({
      error: 'Verify at least one sign-in domain before requiring single sign-on — otherwise nobody could sign in.',
      code: 'no_verified_domain',
    });
  }

  /*
   * ⚠️ Do not let the person pressing this button lock themselves out.
   *
   * The commonest onboarding shape is: sign up with a personal or consultancy address, create the
   * organization, verify the company domain, turn this on. Enforcement then covers them (they are
   * a member) while their own address is outside the verified domains — so passwords are refused
   * AND their org's provider will not assert for them either, because assertions are confined to
   * verified domains. There is no self-service way back: no route removes a membership, and
   * password reset succeeds but login still refuses. A review walked into it on the happy path.
   *
   * They are told exactly which address is the problem, and what to do about it.
   */
  const domains = enforcingDomains(req.orgId);
  const at = String(req.user.email || '').lastIndexOf('@');
  const ownDomain = at === -1 ? '' : String(req.user.email).slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (!domains.includes(ownDomain)) {
    return res.status(400).json({
      error: `Your own address (${req.user.email}) is not at a verified domain (${domains.join(', ')}), `
        + 'so requiring single sign-on would lock you out with no way back. Verify that domain first, '
        + 'or hand ownership to someone whose address is covered.',
      code: 'would_lock_out_actor',
    });
  }

  /*
   * Everyone ELSE in the same position is reported rather than refused — they may be exactly the
   * contractors this is meant to shut out. But the admin must find out here, not from a support
   * ticket after the fact.
   */
  const stranded = db.prepare(`
    SELECT DISTINCT u.email FROM users u
     WHERE u.id IN (
       SELECT m.user_id FROM organization_members m WHERE m.organization_id = ?
       UNION
       SELECT wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
        WHERE w.organization_id = ?
     )
  `).all(req.orgId, req.orgId)
    .map((r) => r.email)
    .filter((e) => {
      const i = String(e).lastIndexOf('@');
      return i === -1 || !domains.includes(String(e).slice(i + 1).toLowerCase().replace(/\.+$/, ''));
    });
  db.prepare('UPDATE organizations SET sso_only = 1 WHERE id = ?').run(req.orgId);
  logActivity(req.user.id, 'org_sso_only_enabled',
    `org=${req.orgId} stranded=${stranded.length}`, null, getClientIp(req));
  console.log(`[org-sso] SSO-only ENABLED for org ${req.orgId} by ${req.user.email}`
    + (stranded.length ? ` — ${stranded.length} member(s) outside the verified domains: ${stranded.join(', ')}` : ''));
  res.json({ sso_only: true, stranded_members: stranded });
});

/*
 * Turning it OFF is a REQUEST, not a switch.
 *
 * This is the direction that re-opens password login, so it is the direction an attacker who has
 * taken an org admin would take, and it is also what a customer will demand at their worst moment —
 * identity provider down, nobody can work — which is precisely when a self-service toggle gets
 * flipped without thinking. A platform admin has to approve it.
 */
router.post('/:orgId/sso-only/removal-request', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const org = db.prepare('SELECT sso_only, name FROM organizations WHERE id = ?').get(req.orgId);
  if (!org || !org.sso_only) return res.status(400).json({ error: 'Single sign-on is not required for this organization' });

  const existing = db.prepare("SELECT id FROM org_sso_only_requests WHERE organization_id = ? AND status = 'pending'").get(req.orgId);
  if (existing) return res.status(409).json({ error: 'A removal request is already awaiting approval', request_id: existing.id });

  const id = crypto.randomUUID();
  const reason = String((req.body && req.body.reason) || '').slice(0, 500);
  db.prepare('INSERT INTO org_sso_only_requests (id, organization_id, requested_by, reason) VALUES (?, ?, ?, ?)')
    .run(id, req.orgId, req.user.id, reason);

  notifyOperatorOfRemovalRequest(req, { id, orgId: req.orgId, orgName: org.name, reason });
  logActivity(req.user.id, 'org_sso_only_removal_requested', `org=${req.orgId} id=${id}`, null, getClientIp(req));
  res.status(202).json({ status: 'pending', request_id: id });
});

/** Withdrawing your own request needs nobody's approval — it only ever keeps SSO required. */
router.delete('/:orgId/sso-only/removal-request/:id', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM org_sso_only_requests WHERE id = ? AND organization_id = ? AND status = 'pending'")
    .get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE org_sso_only_requests SET status = 'cancelled', decided_at = strftime('%s','now'), decided_by = ? WHERE id = ?")
    .run(req.user.id, row.id);
  res.json({ status: 'cancelled' });
});

/*
 * The operator's side.
 *
 * Approval is an authenticated platform_admin action, NOT a link in an email: a token that acts on
 * its own turns every forwarded or archived message into a way to re-open password login for a
 * customer. The mail says what happened and where to go; the decision is made signed in.
 */
function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'platform_admin') return res.status(404).json({ error: 'Not found' });
  next();
}

router.get('/sso-only/removal-requests', requirePlatformAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.organization_id, r.reason, r.created_at, o.name AS organization_name, u.email AS requested_by_email
      FROM org_sso_only_requests r
      LEFT JOIN organizations o ON o.id = r.organization_id
      LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.status = 'pending'
     ORDER BY r.created_at
  `).all();
  res.json({ requests: rows });
});

router.post('/sso-only/removal-requests/:id/:decision', requirePlatformAdmin, (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved'
    : req.params.decision === 'reject' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: 'decision must be approve or reject' });

  const row = db.prepare("SELECT * FROM org_sso_only_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const note = String((req.body && req.body.note) || '').slice(0, 500);
  db.transaction(() => {
    db.prepare("UPDATE org_sso_only_requests SET status = ?, decided_by = ?, decided_at = strftime('%s','now'), decision_note = ? WHERE id = ?")
      .run(decision, req.user.id, note, row.id);
    // Only an approval changes anything. A rejection leaves SSO required, which is the safe state.
    if (decision === 'approved') db.prepare('UPDATE organizations SET sso_only = 0 WHERE id = ?').run(row.organization_id);
  })();

  logActivity(req.user.id, `org_sso_only_${decision}`, `org=${row.organization_id} id=${row.id}`, null, getClientIp(req));
  console.log(`[org-sso] SSO-only removal ${decision} for org ${row.organization_id} by ${req.user.email}`);
  res.json({ status: decision, organization_id: row.organization_id });
});

router.delete('/:orgId/sso/:id', requireOrgAdmin, requireVerifiedAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM org_sso_providers WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  /*
   * Take the domain rows and the accounts with it, in one transaction.
   *
   * Deleting only the provider left both behind, and both were unrecoverable in the product:
   *
   *   - `domain` is globally UNIQUE and a VERIFIED row never expires, so an orphaned row blocked
   *     its own domain forever — for this organization and for every other one — while being
   *     invisible in the API and routing nobody. Re-claiming your own domain returned 409. The only
   *     way out was SQL.
   *   - the users this provider established kept pointing at a slug nothing answers to. They could
   *     not sign in (no provider), could not use a password (auth_provider is not 'local') and
   *     could not register (address taken).
   *
   * Both are handled here, at the moment the intent is known, rather than inferred later from the
   * absence of configuration — which is what made an unset GOOGLE_CLIENT_ID look like a deletion.
   */
  try {
    assertEnforcementNotReduced(req.orgId, existing.id, [], 'deleting this provider');
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const freed = db.transaction(() => {
    const domains = db.prepare('DELETE FROM org_sso_domains WHERE provider_id = ?').run(existing.id).changes;
    // Back to a local account, so the owner can recover it by proving the mailbox — strictly
    // stronger evidence than the identity-provider assertion that created it.
    const users = db.prepare("UPDATE users SET auth_provider = 'local', provider_id = NULL WHERE auth_provider = ?")
      .run(existing.slug).changes;
    db.prepare('DELETE FROM org_sso_providers WHERE id = ?').run(existing.id);
    return { domains, users };
  })();

  logActivity(req.user.id, 'org_sso_deleted',
    `${existing.name} (${existing.slug}) org=${req.orgId} domains=${freed.domains} users_reset=${freed.users}`,
    null, getClientIp(req));
  console.log(`[org-sso] deleted ${existing.slug}: released ${freed.domains} domain(s), returned ${freed.users} account(s) to local`);
  res.json({ success: true, domains_released: freed.domains, accounts_returned_to_local: freed.users });
});

module.exports = router;
