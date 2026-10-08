'use strict';

/*
 * Social connections: an organization's own API credentials for the networks that need one.
 *
 *   instagram — an Instagram professional account's long-lived access token. Two flavours, because
 *               Meta has two APIs: "Instagram Login" (graph.instagram.com — the account's own posts,
 *               token refreshed automatically) and "Facebook Login" (graph.facebook.com — also
 *               hashtag search, needs the Instagram account's id).
 *   facebook  — a Facebook Page access token and the Page id.
 *   youtube   — a YouTube Data API v3 key.
 *   x         — the organization's own X API bearer token (X's API is paid; see docs/social-feeds.md).
 *
 * Bluesky and Mastodon are public and need no connection.
 *
 * ⚠️ THE SECRET NEVER LEAVES THIS SERVER: encrypted at rest (lib/secretbox), never returned by the
 * API (present() says has_secret), never logged, never in a widget page. Screens get posts and
 * images this server fetched — they never talk to a social network.
 *
 * ⚠️ AN ORGANIZATION'S CONNECTION SERVES ONLY ITS OWN FEEDS: forOrg() refuses another tenant's id.
 */

const crypto = require('crypto');

const KINDS = ['instagram', 'facebook', 'youtube', 'x'];
const NUMERIC_ID = /^[0-9]{1,32}$/;

class InputError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

/**
 * Validate a create/update body. `existing` is the stored row on an update: fields left out keep
 * their values, and a secret left out is kept. Returns { kind, name, config, secretEnc, secretChanged }.
 */
function normaliseInput(body, existing = null) {
  const b = body || {};
  const kind = existing ? existing.kind : String(b.kind || '');
  if (!KINDS.includes(kind)) throw new InputError('kind must be instagram, facebook, youtube or x.');
  const prev = existing ? parseConfig(existing.config) : {};
  const pick = (k) => (b[k] !== undefined ? b[k] : prev[k]);
  const name = String(b.name !== undefined ? b.name : (existing ? existing.name : '')).trim().slice(0, 80);
  if (!name) throw new InputError('A name is required.');

  let config = {};
  if (kind === 'instagram') {
    const api = pick('api') === 'facebook_login' ? 'facebook_login' : 'instagram_login';
    config = { api };
    if (api === 'facebook_login') {
      const ig = String(pick('ig_user_id') || '').trim();
      if (!NUMERIC_ID.test(ig)) throw new InputError('Enter the Instagram account id (a number) — Facebook Login needs it.');
      config.ig_user_id = ig;
    }
  } else if (kind === 'facebook') {
    const page = String(pick('page_id') || '').trim();
    if (!NUMERIC_ID.test(page)) throw new InputError('Enter the Facebook Page id (a number).');
    config = { page_id: page };
  }

  let secretEnc = existing ? existing.secret_enc : null;
  let secretChanged = false;
  if (b.secret !== undefined && b.secret !== null && b.secret !== '') {
    const s = String(b.secret).trim();
    if (s.length > 4096 || /\s/.test(s)) throw new InputError('That token does not look right (no spaces, at most 4096 characters).');
    secretEnc = require('../secretbox').encrypt(s);
    secretChanged = true;
  }
  if (!secretEnc) {
    throw new InputError(kind === 'youtube' ? 'An API key is required.' : kind === 'x' ? 'A bearer token is required.' : 'An access token is required.');
  }
  return { kind, name, config, secretEnc, secretChanged };
}

/** What the API may say about a connection. Never the secret. */
function present(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: parseConfig(row.config),
    has_secret: !!row.secret_enc,
    token_expires_at: row.token_expires_at || null,
    last_error: row.last_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The decrypted secret. Fails CLOSED: a rotated key is an error, not an empty token. */
function secretOf(row) {
  const s = row && row.secret_enc ? require('../secretbox').decrypt(row.secret_enc) : null;
  if (!s) throw new Error('The connection token could not be decrypted — re-enter it.');
  return s;
}

function forOrg(db, orgId, id) {
  if (!orgId || !id) return null;
  const row = db.prepare('SELECT * FROM social_connections WHERE id = ? AND organization_id = ?').get(String(id), orgId);
  return row ? { ...row, config: parseConfig(row.config) } : null;
}

function orgOfWorkspace(db, workspaceId) {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  return r ? r.organization_id : null;
}

function create(db, orgId, userId, input) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO social_connections (id, organization_id, created_by, kind, name, config, secret_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, userId || null, input.kind, input.name, JSON.stringify(input.config), input.secretEnc);
  return db.prepare('SELECT * FROM social_connections WHERE id = ?').get(id);
}

function update(db, row, input) {
  db.prepare(`UPDATE social_connections SET name = ?, config = ?, secret_enc = ?,
      token_expires_at = CASE WHEN ? THEN NULL ELSE token_expires_at END,
      token_refreshed_at = CASE WHEN ? THEN NULL ELSE token_refreshed_at END,
      last_error = CASE WHEN ? THEN NULL ELSE last_error END,
      updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?`)
    .run(input.name, JSON.stringify(input.config), input.secretEnc,
      input.secretChanged ? 1 : 0, input.secretChanged ? 1 : 0, input.secretChanged ? 1 : 0, row.id);
  return db.prepare('SELECT * FROM social_connections WHERE id = ?').get(row.id);
}

module.exports = { KINDS, InputError, normaliseInput, parseConfig, present, secretOf, forOrg, orgOfWorkspace, create, update };
