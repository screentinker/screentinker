'use strict';

/*
 * Canva (Connect API): import designs into the content library, and keep them in step with Canva.
 *
 * WHO HOLDS WHAT
 *   - The INTEGRATION (a Canva developer app: client id + secret) belongs to an organization
 *     (canva_integrations, set in Settings by an org admin) or, failing that, to the instance
 *     (CANVA_CLIENT_ID / CANVA_CLIENT_SECRET). An org's own integration wins, so a customer can
 *     use their Canva Enterprise app without the operator's.
 *   - Each PERSON connects their own Canva account to that integration with OAuth 2.0 + PKCE
 *     (canva_connections, keyed by user and integration). Access and refresh tokens are
 *     secretbox-encrypted, refreshed when they expire or Canva answers 401, and revoked on
 *     disconnect. Nothing here ever returns a token or a client secret to a browser.
 *   - A LINK (canva_links) ties one library item to the page(s) of the design it was exported from,
 *     and to the person whose connection exported it. Sync re-exports through that connection.
 *
 * WHAT A SYNC DOES
 *   Reads the design's updated_at. If it moved since the last export, the linked pages are exported
 *   again and each item's bytes are replaced through lib/content-replace — the same path as a manual
 *   "Replace file", so the revision bumps (players re-download), version history keeps the old
 *   bytes, and with approval on the new export waits as a draft. Unchanged designs write nothing.
 *
 * ⚠️ DOWNLOADS ARE CONFINED. Canva hands back short-lived export URLs; they are fetched only if
 * they are https on canva.com (or on the configured API origin, which only an operator can set —
 * it exists for tests and proxies), and always through the SSRF guard. A hostile or compromised
 * response cannot point the server at an internal address.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

function dbOf() { return require('../db/database').db; }
const secretbox = () => require('./secretbox');

const API_BASE = () => (process.env.CANVA_API_BASE || 'https://api.canva.com/rest').replace(/\/+$/, '');
const AUTHORIZE_URL = () => process.env.CANVA_AUTHORIZE_URL || 'https://www.canva.com/api/oauth/authorize';
const SCOPES = 'design:meta:read design:content:read profile:read';
const SYNC_EVERY_MS = 30 * 60 * 1000;
const EXPORT_BUDGET_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_PAGES = 50;

class CanvaError extends Error {
  constructor(message, code = 'canva', status = 502) {
    super(message);
    this.name = 'CanvaError';
    this.code = code;
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);

/* ============================== integration ============================== */

/**
 * The Canva integration that applies to a workspace, or null. { key, source, clientId, clientSecret }.
 * The secret is decrypted here and goes no further than the token endpoint.
 */
function integrationForOrg(orgId) {
  if (orgId) {
    let row = null;
    try { row = dbOf().prepare('SELECT * FROM canva_integrations WHERE organization_id = ?').get(orgId); } catch { row = null; }
    if (row && row.client_id) {
      let secret = null;
      if (row.client_secret_enc) {
        secret = secretbox().decrypt(row.client_secret_enc);
        if (secret == null) throw new CanvaError('The Canva client secret could not be decrypted. An org admin must enter it again.', 'secret', 500);
      }
      return { key: `org:${orgId}`, source: 'org', clientId: row.client_id, clientSecret: secret };
    }
  }
  const id = (process.env.CANVA_CLIENT_ID || '').trim();
  const secret = (process.env.CANVA_CLIENT_SECRET || '').trim();
  if (id && secret) return { key: 'instance', source: 'instance', clientId: id, clientSecret: secret };
  return null;
}

function orgOfWorkspace(workspaceId) {
  const r = workspaceId ? dbOf().prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId) : null;
  return r ? r.organization_id : null;
}

function integrationForWorkspace(workspaceId) { return integrationForOrg(orgOfWorkspace(workspaceId)); }

/** The integration a stored key names (a link or connection remembers which one it used). */
function integrationByKey(key) {
  if (key === 'instance') { const i = integrationForOrg(null); return i && i.key === 'instance' ? i : null; }
  if (String(key).startsWith('org:')) { const i = integrationForOrg(String(key).slice(4)); return i && i.key === key ? i : null; }
  return null;
}

function redirectUri(origin) { return `${origin}/api/canva/callback`; }

/* ============================== OAuth ============================== */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function newPkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(crypto.randomBytes(24)) };
}

function authorizeUrl(integration, { challenge, state }, origin) {
  const u = new URL(AUTHORIZE_URL());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', integration.clientId);
  u.searchParams.set('redirect_uri', redirectUri(origin));
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 's256');
  return u.toString();
}

async function tokenRequest(integration, form) {
  const basic = Buffer.from(`${integration.clientId}:${integration.clientSecret || ''}`).toString('base64');
  let res;
  try {
    res = await fetch(`${API_BASE()}/v1/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new CanvaError('Canva could not be reached.', 'unreachable'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new CanvaError(body.error_description || body.message || `Canva refused the request (${res.status}).`, body.error || body.code || 'token', res.status === 401 ? 401 : 502);
    err.oauthError = body.error || body.code || null;
    err.httpStatus = res.status;
    throw err;
  }
  return body;
}

function storeTokens(userId, integration, tok, profile = {}) {
  const enc = secretbox().encrypt;
  const expiresAt = now() + Math.max(60, Number(tok.expires_in) || 3600);
  dbOf().prepare(`INSERT INTO canva_connections (user_id, integration_key, canva_user_id, display_name, access_enc, refresh_enc, expires_at, scopes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(user_id, integration_key) DO UPDATE SET
        canva_user_id = COALESCE(excluded.canva_user_id, canva_user_id),
        display_name = COALESCE(excluded.display_name, display_name),
        access_enc = excluded.access_enc,
        refresh_enc = COALESCE(excluded.refresh_enc, refresh_enc),
        expires_at = excluded.expires_at, scopes = COALESCE(excluded.scopes, scopes),
        updated_at = strftime('%s','now')`)
    .run(userId, integration.key, profile.canvaUserId || null, profile.displayName || null,
      enc(String(tok.access_token)), tok.refresh_token ? enc(String(tok.refresh_token)) : null, expiresAt, tok.scope || null);
}

/** Finish the OAuth round trip: trade the code, learn who connected, store the tokens. */
async function completeConnect(userId, integration, { code, verifier, origin }) {
  const tok = await tokenRequest(integration, {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri(origin),
  });
  if (!tok.access_token) throw new CanvaError('Canva did not return an access token.', 'token');
  const profile = {};
  try {
    const me = await rawApi(tok.access_token, 'GET', '/v1/users/me');
    profile.canvaUserId = me && me.team_user ? me.team_user.user_id : null;
  } catch { /* optional */ }
  try {
    const p = await rawApi(tok.access_token, 'GET', '/v1/users/me/profile');
    profile.displayName = p && p.profile ? p.profile.display_name : null;
  } catch { /* optional */ }
  storeTokens(userId, integration, tok, profile);
  return profile;
}

function connectionRow(userId, key) {
  return dbOf().prepare('SELECT * FROM canva_connections WHERE user_id = ? AND integration_key = ?').get(userId, key);
}

// One refresh at a time per connection: Canva refresh tokens are single-use, so two concurrent
// refreshes would leave the loser holding a spent token and the connection broken.
const refreshing = new Map();

async function refreshConnection(userId, integration) {
  const k = `${userId}|${integration.key}`;
  if (refreshing.has(k)) return refreshing.get(k);
  const p = (async () => {
    const row = connectionRow(userId, integration.key);
    if (!row || !row.refresh_enc) throw new CanvaError('Your Canva connection has expired. Connect Canva again.', 'reconnect', 401);
    const refresh = secretbox().decrypt(row.refresh_enc);
    if (!refresh) throw new CanvaError('Your Canva connection has expired. Connect Canva again.', 'reconnect', 401);
    let tok;
    try {
      tok = await tokenRequest(integration, { grant_type: 'refresh_token', refresh_token: refresh });
    } catch (e) {
      if (e.httpStatus === 400 || e.httpStatus === 401) {
        throw new CanvaError('Canva no longer accepts this connection. Connect Canva again.', 'reconnect', 401);
      }
      throw e;
    }
    storeTokens(userId, integration, tok);
    return secretbox().decrypt(connectionRow(userId, integration.key).access_enc);
  })();
  refreshing.set(k, p);
  try { return await p; } finally { refreshing.delete(k); }
}

async function accessToken(userId, integration) {
  const row = connectionRow(userId, integration.key);
  if (!row) throw new CanvaError('Connect your Canva account first.', 'not_connected', 401);
  if (row.expires_at - 60 <= now()) return refreshConnection(userId, integration);
  const tok = secretbox().decrypt(row.access_enc);
  if (!tok) return refreshConnection(userId, integration);
  return tok;
}

async function revoke(userId, integration) {
  const row = connectionRow(userId, integration.key);
  if (!row) return false;
  for (const enc of [row.refresh_enc, row.access_enc]) {
    const token = enc ? secretbox().decrypt(enc) : null;
    if (!token) continue;
    try { await tokenRequestRevoke(integration, token); } catch { /* best effort; the row goes regardless */ }
  }
  dbOf().prepare('DELETE FROM canva_connections WHERE user_id = ? AND integration_key = ?').run(userId, integration.key);
  return true;
}

async function tokenRequestRevoke(integration, token) {
  const basic = Buffer.from(`${integration.clientId}:${integration.clientSecret || ''}`).toString('base64');
  await fetch(`${API_BASE()}/v1/oauth/revoke`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10000),
  });
}

/* ============================== API ============================== */

async function rawApi(token, method, p, body) {
  let res;
  try {
    res = await fetch(`${API_BASE()}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new CanvaError('Canva could not be reached.', 'unreachable'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new CanvaError(
      res.status === 404 ? 'That Canva design no longer exists, or you no longer have access to it.'
        : res.status === 429 ? 'Canva is rate-limiting requests. Try again in a minute.'
          : res.status === 403 ? 'Canva refused: the connection lacks permission for this. Connect Canva again.'
            : (data.message || `Canva answered ${res.status}.`),
      data.code || `http_${res.status}`, res.status === 404 ? 404 : 502);
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

/** Call the API as a user, refreshing once on 401. */
async function api(userId, integration, method, p, body) {
  let token = await accessToken(userId, integration);
  try {
    return await rawApi(token, method, p, body);
  } catch (e) {
    if (e.httpStatus !== 401) throw e;
    token = await refreshConnection(userId, integration);
    return rawApi(token, method, p, body);
  }
}

const designSummary = (d) => ({
  id: String(d.id),
  title: d.title || 'Untitled design',
  thumbnail: d.thumbnail && /^https:\/\//.test(d.thumbnail.url || '') ? d.thumbnail.url : null,
  page_count: Number.isInteger(d.page_count) ? d.page_count : null,
  updated_at: Number(d.updated_at) || null,
});

async function listDesigns(userId, integration, { query = '', continuation = '' } = {}) {
  const qs = new URLSearchParams({ ownership: 'any', sort_by: 'modified_descending' });
  if (query) qs.set('query', String(query).slice(0, 255));
  if (continuation) qs.set('continuation', String(continuation).slice(0, 2000));
  const data = await api(userId, integration, 'GET', `/v1/designs?${qs}`);
  return { items: (data.items || []).map(designSummary), continuation: data.continuation || null };
}

async function getDesign(userId, integration, designId) {
  const data = await api(userId, integration, 'GET', `/v1/designs/${encodeURIComponent(designId)}`);
  if (!data.design) throw new CanvaError('Canva returned no design.', 'design');
  return designSummary(data.design);
}

async function listPages(userId, integration, designId) {
  const data = await api(userId, integration, 'GET', `/v1/designs/${encodeURIComponent(designId)}/pages?limit=${MAX_PAGES}`);
  return (data.items || []).map((p) => ({
    index: Number(p.index),
    thumbnail: p.thumbnail && /^https:\/\//.test(p.thumbnail.url || '') ? p.thumbnail.url : null,
  })).filter((p) => Number.isInteger(p.index) && p.index > 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Export pages of a design; resolves to the download URLs, in page order. */
async function exportDesign(userId, integration, designId, { format, pages }) {
  const fmt = format === 'mp4' ? { type: 'mp4', quality: 'horizontal_1080p', pages } : { type: 'png', pages };
  const created = await api(userId, integration, 'POST', '/v1/exports', { design_id: designId, format: fmt });
  let job = created.job;
  if (!job || !job.id) throw new CanvaError('Canva did not start the export.', 'export');
  const deadline = Date.now() + EXPORT_BUDGET_MS;
  let wait = Number(process.env.CANVA_POLL_MS) || 1000;
  while (job.status === 'in_progress') {
    if (Date.now() > deadline) throw new CanvaError('The Canva export took too long. Try again.', 'export_timeout');
    await sleep(wait);
    wait = Math.min(wait * 1.5, 5000);
    job = (await api(userId, integration, 'GET', `/v1/exports/${encodeURIComponent(job.id)}`)).job || {};
  }
  if (job.status !== 'success') {
    const msg = job.error && job.error.message ? job.error.message : 'Canva could not export the design.';
    throw new CanvaError(`Canva could not export the design: ${msg}`, (job.error && job.error.code) || 'export_failed');
  }
  const urls = Array.isArray(job.urls) ? job.urls : [];
  if (!urls.length) throw new CanvaError('Canva finished the export without any files.', 'export_empty');
  return urls;
}

/* ============================== download ============================== */

/** Whether the server may fetch this export URL. Returns the parsed URL or throws. */
function checkExportUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new CanvaError('Canva returned an invalid download address.', 'bad_url'); }
  let apiOrigin = null;
  try { apiOrigin = new URL(API_BASE()).origin; } catch { /* default */ }
  if (u.origin === apiOrigin) return { url: u, trusted: true };
  const host = u.hostname.toLowerCase();
  const canva = host === 'canva.com' || host.endsWith('.canva.com');
  if (u.protocol !== 'https:' || !canva || u.username || u.password) {
    throw new CanvaError('Canva returned a download address outside canva.com; it was not fetched.', 'bad_url');
  }
  return { url: u, trusted: false };
}

/** Download one export into contentDir as `<uuid>.part`, multer-shaped for ingest/replace. */
async function downloadExport(rawUrl, filename) {
  const { url, trusted } = checkExportUrl(rawUrl);
  const tmp = path.join(config.contentDir, `${uuidv4()}.part`);
  let size = 0;
  try {
    if (trusted) {
      const res = await fetch(url, { signal: AbortSignal.timeout(EXPORT_BUDGET_MS) });
      if (!res.ok) throw new CanvaError(`The export download failed (${res.status}).`, 'download');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new CanvaError('The export is too large.', 'download');
      fs.writeFileSync(tmp, buf);
      size = buf.length;
    } else {
      const { guardedRequest } = require('./ssrf-guard');
      const r = await guardedRequest(url.toString(), { timeoutMs: EXPORT_BUDGET_MS, idleTimeoutMs: 30000, responseType: 'stream', maxRedirects: 2 });
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        r.res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_DOWNLOAD_BYTES) r.res.destroy(new CanvaError('The export is too large.', 'download'));
        });
        r.res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        r.res.pipe(out);
      });
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
    if (e instanceof CanvaError) throw e;
    throw new CanvaError('The export could not be downloaded from Canva.', 'download');
  }
  return { path: tmp, size, originalname: filename };
}

/* ============================== import & sync ============================== */

function safeTitle(t) {
  return String(t || 'Canva design').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 120) || 'Canva design';
}

/**
 * Import pages of a design as library items (one per page for PNG, one video for MP4).
 * opts: { workspaceId, userId, designId, pages: [1..], format: 'png'|'mp4', folderId, playlistName, actor }
 * Resolves { content: [rows], playlist_id }.
 */
async function importDesign(opts) {
  const { workspaceId, userId, designId, folderId = null, actor = null } = opts;
  const format = opts.format === 'mp4' ? 'mp4' : 'png';
  const integration = integrationForWorkspace(workspaceId);
  if (!integration) throw new CanvaError('Canva is not set up for this workspace.', 'not_configured', 400);
  const design = await getDesign(userId, integration, designId);
  let pages = [...new Set((opts.pages || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!pages.length) pages = Array.from({ length: Math.min(design.page_count || 1, MAX_PAGES) }, (_, i) => i + 1);
  if (pages.length > MAX_PAGES) throw new CanvaError(`At most ${MAX_PAGES} pages can be imported at once.`, 'too_many', 400);

  const urls = await exportDesign(userId, integration, designId, { format, pages });
  // PNG: one file per page, in the order asked. MP4: one video for every page asked.
  const groups = format === 'mp4' ? [{ pages, url: urls[0] }] : pages.map((p, i) => ({ pages: [p], url: urls[i] }));
  if (groups.some((g) => !g.url)) throw new CanvaError('Canva returned fewer files than pages asked for.', 'export_short');

  const { ingestUploadedFile } = require('./content-ingest');
  const db = dbOf();
  const title = safeTitle(design.title);
  const made = [];
  for (const g of groups) {
    const name = format === 'mp4' ? `${title}.mp4` : (groups.length > 1 ? `${title} — page ${g.pages[0]}.png` : `${title}.png`);
    const file = await downloadExport(g.url, name);
    const row = await ingestUploadedFile({ file, userId, workspaceId, folderId });
    db.prepare(`INSERT OR REPLACE INTO canva_links (content_id, workspace_id, user_id, integration_key, design_id, design_title, pages, format, design_updated_at, last_synced_at, last_checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, workspaceId, userId, integration.key, design.id, title, JSON.stringify(g.pages), format, design.updated_at, now(), now());
    try { require('./revisions').recordCurrent(db, 'content', row.id, { actor, summary: 'Imported from Canva' }); } catch { /* history is best effort */ }
    made.push(db.prepare('SELECT * FROM content WHERE id = ?').get(row.id));
  }

  let playlistId = null;
  if (opts.playlistName && made.length) {
    playlistId = uuidv4();
    const { contentDefaultDuration } = require('./item-duration');
    db.transaction(() => {
      db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description) VALUES (?, ?, ?, ?, ?)')
        .run(playlistId, userId, workspaceId, String(opts.playlistName).trim().slice(0, 120), `Imported from Canva: ${title}`);
      made.forEach((c, i) => {
        let dur = 10;
        try { dur = contentDefaultDuration(c) || 10; } catch { /* default */ }
        db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)').run(playlistId, c.id, i, Math.round(dur));
      });
    })();
  }
  return { content: made, playlist_id: playlistId };
}

/**
 * Refresh every link of one design (for one person and format) if the design changed.
 * Resolves { checked, replaced, unchanged, errors }.
 */
async function syncDesign(links, { force = false, reqOrIo = null } = {}) {
  const db = dbOf();
  const out = { checked: links.length, replaced: 0, unchanged: 0, errors: 0 };
  if (!links.length) return out;
  const first = links[0];
  const fail = (msg) => {
    for (const l of links) db.prepare('UPDATE canva_links SET last_error = ?, last_checked_at = ? WHERE content_id = ?').run(msg, now(), l.content_id);
    out.errors = links.length;
    return out;
  };
  const integration = integrationByKey(first.integration_key);
  if (!integration) return fail('The Canva integration this was imported with is no longer set up.');
  let design;
  try { design = await getDesign(first.user_id, integration, first.design_id); } catch (e) { return fail(e.message); }

  const stale = links.filter((l) => force || !l.design_updated_at || design.updated_at !== l.design_updated_at);
  for (const l of links.filter((x) => !stale.includes(x))) {
    db.prepare('UPDATE canva_links SET last_checked_at = ?, last_error = NULL WHERE content_id = ?').run(now(), l.content_id);
    out.unchanged++;
  }
  if (!stale.length) return out;

  const format = first.format === 'mp4' ? 'mp4' : 'png';
  // PNG links share one export of every page they need; an MP4 link exports its own page set.
  const batches = format === 'png'
    ? [{ links: stale, pages: [...new Set(stale.flatMap((l) => JSON.parse(l.pages)))].sort((a, b) => a - b) }]
    : stale.map((l) => ({ links: [l], pages: JSON.parse(l.pages) }));
  const { replaceContentBytes } = require('./content-replace');
  for (const b of batches) {
    let urls;
    try { urls = await exportDesign(first.user_id, integration, first.design_id, { format, pages: b.pages }); }
    catch (e) {
      const msg = /page/i.test(e.message) ? 'A linked page no longer exists in the Canva design.' : e.message;
      for (const l of b.links) db.prepare('UPDATE canva_links SET last_error = ?, last_checked_at = ? WHERE content_id = ?').run(msg, now(), l.content_id);
      out.errors += b.links.length;
      continue;
    }
    for (const l of b.links) {
      const content = db.prepare('SELECT * FROM content WHERE id = ?').get(l.content_id);
      if (!content) { db.prepare('DELETE FROM canva_links WHERE content_id = ?').run(l.content_id); continue; }
      const url = format === 'png' ? urls[b.pages.indexOf(JSON.parse(l.pages)[0])] : urls[0];
      try {
        if (!url) throw new CanvaError('Canva returned fewer files than pages asked for.', 'export_short');
        const file = await downloadExport(url, content.filename);
        const r = await replaceContentBytes({ content, file, actor: { userId: l.user_id, kind: 'import', label: 'Canva sync' }, reqOrIo });
        if (r.status >= 400) throw new CanvaError((r.body && r.body.error) || 'The item could not be replaced.', 'replace');
        db.prepare('UPDATE canva_links SET design_updated_at = ?, design_title = ?, last_synced_at = ?, last_checked_at = ?, last_error = NULL WHERE content_id = ?')
          .run(design.updated_at, safeTitle(design.title), now(), now(), l.content_id);
        out.replaced++;
      } catch (e) {
        db.prepare('UPDATE canva_links SET last_error = ?, last_checked_at = ? WHERE content_id = ?').run(e.message, now(), l.content_id);
        out.errors++;
      }
    }
  }
  return out;
}

/** Group links so one design costs one metadata read and (for PNG) one export. */
function groupLinks(links) {
  const by = new Map();
  for (const l of links) {
    const k = `${l.user_id}|${l.integration_key}|${l.design_id}|${l.format}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(l);
  }
  return [...by.values()];
}

async function syncContent(contentIds, opts = {}) {
  const db = dbOf();
  const links = contentIds.map((id) => db.prepare('SELECT * FROM canva_links WHERE content_id = ?').get(id)).filter(Boolean);
  const total = { checked: 0, replaced: 0, unchanged: 0, errors: 0 };
  for (const g of groupLinks(links)) {
    const r = await syncDesign(g, opts);
    for (const k of Object.keys(total)) total[k] += r[k];
  }
  return total;
}

let sweeping = false;
async function sweep(io) {
  if (sweeping) return;
  sweeping = true;
  try {
    const due = dbOf().prepare('SELECT * FROM canva_links WHERE COALESCE(last_checked_at, 0) < ? ORDER BY COALESCE(last_checked_at, 0) LIMIT 200')
      .all(now() - Math.floor(SYNC_EVERY_MS / 1000));
    for (const g of groupLinks(due)) {
      try { await syncDesign(g, { reqOrIo: io }); } catch (e) { console.warn(`[canva] sync failed: ${e.message}`); }
    }
  } catch (e) {
    if (!/no such table/i.test(e.message)) console.warn(`[canva] sweep failed: ${e.message}`);
  } finally { sweeping = false; }
}

function start(io) {
  const t = setInterval(() => { sweep(io); }, Math.min(SYNC_EVERY_MS, 5 * 60 * 1000));
  if (t.unref) t.unref();
}

/* ============================== jobs ============================== */

// Imports and syncs can take minutes (Canva renders the export), longer than a proxy will hold a
// request. They run as jobs in the database, which any node can answer a status poll from.
function runJob({ workspaceId, userId, kind }, work) {
  const id = uuidv4();
  const db = dbOf();
  db.prepare("INSERT INTO canva_jobs (id, workspace_id, user_id, kind, status) VALUES (?, ?, ?, ?, 'running')").run(id, workspaceId, userId, kind);
  db.prepare('DELETE FROM canva_jobs WHERE created_at < ?').run(now() - 7 * 86400);
  Promise.resolve().then(work).then(
    (result) => db.prepare("UPDATE canva_jobs SET status = 'done', result = ?, updated_at = strftime('%s','now') WHERE id = ?").run(JSON.stringify(result || {}), id),
    (err) => {
      if (!(err instanceof CanvaError)) console.error(`[canva] ${kind} failed:`, err);
      const msg = err instanceof CanvaError || (err && err.name === 'UnsupportedUploadError') ? err.message : 'The Canva import failed.';
      db.prepare("UPDATE canva_jobs SET status = 'failed', error = ?, updated_at = strftime('%s','now') WHERE id = ?").run(msg, id);
    },
  );
  return id;
}

module.exports = {
  SCOPES, CanvaError, integrationForOrg, integrationForWorkspace, integrationByKey, redirectUri, newPkce, authorizeUrl,
  tokenRequest, completeConnect, connectionRow, accessToken, refreshConnection, revoke, api, listDesigns, getDesign,
  listPages, exportDesign, checkExportUrl, downloadExport, importDesign, syncDesign, syncContent, sweep, start, runJob,
};
