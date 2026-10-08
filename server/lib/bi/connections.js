'use strict';

/*
 * BI connections: an organization's credentials into Grafana, Power BI or Tableau, used by the
 * 'bi-dashboard' widget (lib/bi/widget.js).
 *
 * ⚠️ THE SECRET NEVER LEAVES THIS SERVER. It is encrypted at rest (lib/secretbox), never returned by
 * the API (present() says has_secret and nothing more), never logged, and never put in a widget
 * page: a screen gets a rendered PNG (Grafana) or a short-lived, view-only embed token minted here
 * (Power BI, Tableau) — never the service-account token, client secret or connected-app secret.
 *
 * ⚠️ AN ORGANIZATION'S CONNECTION SERVES ONLY THAT ORGANIZATION'S WIDGETS. A widget names its
 * connection by id, and that id is a value a workspace editor typed into a config blob; forOrg()
 * and forWidget() refuse a connection owned by anyone else, so pasting another tenant's id buys
 * nothing.
 */

const crypto = require('crypto');

const KINDS = ['grafana', 'powerbi', 'tableau'];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Entra tenant: a GUID or a verified domain. The multi-tenant aliases are refused — a service
// principal belongs to ONE tenant, and 'common' would only fail later with a worse message.
const TENANT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
const SITE_RE = /^[A-Za-z0-9_-]{0,64}$/;

class InputError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

function cleanUrl(raw, label) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new InputError(`${label} is not a valid URL.`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InputError(`${label} must start with https://.`);
  if (url.username || url.password) throw new InputError(`${label} must not contain a user name or password.`);
  if (url.search || url.hash) throw new InputError(`${label} must not contain ? or #.`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Validate a create/update body. `existing` is the stored row on an update (fields left out keep
 * their stored values; a secret left out is kept). Returns { kind, name, config, secretEnc, allowPrivate }.
 * Throws InputError.
 */
function normaliseInput(body, existing = null, { canAllowPrivate = false } = {}) {
  const b = body || {};
  const kind = existing ? existing.kind : String(b.kind || '');
  if (!KINDS.includes(kind)) throw new InputError('kind must be grafana, powerbi or tableau.');
  const prev = existing ? parseConfig(existing.config) : {};
  const pick = (k) => (b[k] !== undefined ? b[k] : prev[k]);

  const name = String(b.name !== undefined ? b.name : (existing ? existing.name : '')).trim().slice(0, 80);
  if (!name) throw new InputError('A name is required.');

  let config;
  if (kind === 'grafana') {
    config = { base_url: cleanUrl(pick('base_url'), 'The Grafana address') };
  } else if (kind === 'powerbi') {
    const tenant = String(pick('tenant_id') || '').trim();
    if (!TENANT_RE.test(tenant) || /^(common|organizations|consumers)$/i.test(tenant)) {
      throw new InputError('The tenant must be your Entra tenant ID (a GUID) or its domain — not common or organizations.');
    }
    const clientId = String(pick('client_id') || '').trim();
    if (!GUID_RE.test(clientId)) throw new InputError('The application (client) ID must be a GUID.');
    config = { tenant_id: tenant, client_id: clientId };
  } else {
    const site = String(pick('site') || '').trim();
    if (!SITE_RE.test(site)) throw new InputError('The site must be its content URL (letters, digits, - and _), or empty for the default site.');
    const clientId = String(pick('client_id') || '').trim();
    const secretId = String(pick('secret_id') || '').trim();
    if (!GUID_RE.test(clientId)) throw new InputError('The connected app client ID must be a GUID.');
    if (!GUID_RE.test(secretId)) throw new InputError('The connected app secret ID must be a GUID.');
    const username = String(pick('username') || '').trim();
    if (!username || username.length > 256 || /[\s<>"]/.test(username)) throw new InputError('Enter the Tableau user the screens view as.');
    config = { server_url: cleanUrl(pick('server_url'), 'The Tableau address'), site, client_id: clientId, secret_id: secretId, username };
  }

  // Secret: absent keeps the stored one. It cannot be cleared: every kind needs it to work at all.
  let secretEnc = existing ? existing.secret_enc : null;
  if (b.secret !== undefined && b.secret !== null && b.secret !== '') {
    const s = String(b.secret);
    if (s.length > 4096) throw new InputError('That secret is too long.');
    secretEnc = require('../secretbox').encrypt(s);
  }
  if (!secretEnc) throw new InputError(kind === 'grafana' ? 'A service account token is required.'
    : kind === 'powerbi' ? 'A client secret is required.' : 'The connected app secret value is required.');

  /*
   * ⚠️ PRIVATE ADDRESSES ARE AN OPERATOR'S DECISION. Grafana and Tableau Server are often on a LAN,
   * and the server connects to the address typed here — on a hosted instance that is SSRF into our
   * own network. Same rule as storage profiles: only a platform admin, or anyone on a self-hosted
   * instance, may switch it on. Power BI talks to fixed Microsoft hosts and never needs it.
   */
  let allowPrivate = existing ? !!existing.allow_private : false;
  if (b.allow_private !== undefined && kind !== 'powerbi') {
    const want = b.allow_private === true || b.allow_private === 1 || b.allow_private === '1';
    if (want && !allowPrivate && !canAllowPrivate) {
      throw new InputError('Only a platform administrator can allow private network addresses on this server.', 403, 'BI_PRIVATE_FORBIDDEN');
    }
    allowPrivate = want;
  }
  return { kind, name, config, secretEnc, allowPrivate };
}

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

/** What the API may say about a connection. Never the secret. */
function present(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: parseConfig(row.config),
    has_secret: !!row.secret_enc,
    allow_private: !!row.allow_private,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The decrypted secret. Fails CLOSED: a key that has rotated is an error, not an empty secret. */
function secretOf(row) {
  const s = row && row.secret_enc ? require('../secretbox').decrypt(row.secret_enc) : null;
  if (!s) throw new Error('The connection secret could not be decrypted — re-enter it.');
  return s;
}

/** A connection of this organization, with `config` parsed; null for anyone else's. */
function forOrg(db, orgId, id) {
  if (!orgId || !id) return null;
  const row = db.prepare('SELECT * FROM bi_connections WHERE id = ? AND organization_id = ?').get(String(id), orgId);
  return row ? { ...row, config: parseConfig(row.config) } : null;
}

function orgOfWorkspace(db, workspaceId) {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  return r ? r.organization_id : null;
}

/** The connection a widget names — only if it belongs to the widget's own organization. */
function forWidget(db, widget, config) {
  const orgId = orgOfWorkspace(db, widget && widget.workspace_id);
  return forOrg(db, orgId, config && config.connection_id);
}

function create(db, orgId, userId, input) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO bi_connections (id, organization_id, created_by, kind, name, config, secret_enc, allow_private)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, userId || null, input.kind, input.name, JSON.stringify(input.config), input.secretEnc, input.allowPrivate ? 1 : 0);
  return db.prepare('SELECT * FROM bi_connections WHERE id = ?').get(id);
}

function update(db, row, input) {
  db.prepare(`UPDATE bi_connections SET name = ?, config = ?, secret_enc = ?, allow_private = ?,
    updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?`)
    .run(input.name, JSON.stringify(input.config), input.secretEnc, input.allowPrivate ? 1 : 0, row.id);
  return db.prepare('SELECT * FROM bi_connections WHERE id = ?').get(row.id);
}

module.exports = { KINDS, GUID_RE, InputError, normaliseInput, parseConfig, present, secretOf, forOrg, forWidget, orgOfWorkspace, create, update };
