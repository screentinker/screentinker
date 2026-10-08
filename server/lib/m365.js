'use strict';

/*
 * Microsoft 365 for an organization: its OWN Entra ID app registration (bring-your-own), used with the
 * client-credentials grant to read files from SharePoint and OneDrive through Microsoft Graph.
 *
 * Per ORGANIZATION (org_m365_apps): tenant ID, client ID, client secret. The secret is stored with
 * lib/secretbox and never returned — the API answers has_client_secret, exactly like org SSO.
 *
 * Permissions the app needs (application, admin-consented): Files.Read.All, or Sites.Selected with the
 * sites granted individually (the narrower choice, and the one docs/cloud-documents.md recommends).
 *
 * ⚠️ HOSTS ARE FIXED. The token endpoint is login.microsoftonline.com and every API call goes to
 * graph.microsoft.com; nothing here takes a host from a user or from a response, with one exception
 * that is checked: the pre-authenticated @microsoft.graph.downloadUrl Graph hands back for a file's
 * bytes, which must be https and pass lib/remote-url validateRemoteUrl (no private addresses).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A tenant may also be given as its primary domain (contoso.onmicrosoft.com, contoso.com).
const TENANT_DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function dbOf() { return require('../db/database').db; }

class M365Error extends Error {
  constructor(message, { status = 400, code = 'm365_error' } = {}) { super(message); this.status = status; this.code = code; }
}

/* ============================== stored app ============================== */

function validateTenant(t) {
  const s = String(t || '').trim().toLowerCase();
  if (GUID_RE.test(s) || TENANT_DOMAIN_RE.test(s)) {
    // The multi-tenant endpoints accept any tenant's tokens; an org's app must be its own tenant.
    if (['common', 'organizations', 'consumers'].includes(s)) return null;
    return s;
  }
  return null;
}

function appRow(orgId) {
  try { return dbOf().prepare('SELECT * FROM org_m365_apps WHERE organization_id = ?').get(orgId) || null; }
  catch (e) { if (/no such table/i.test(e.message)) return null; throw e; }
}

/** What the API may show: never the secret. */
function present(row) {
  if (!row) return { configured: false };
  return {
    configured: true,
    tenant_id: row.tenant_id,
    client_id: row.client_id,
    has_client_secret: !!row.client_secret_enc,
    last_test_at: row.last_test_at || null,
    last_test_ok: row.last_test_ok == null ? null : !!row.last_test_ok,
    last_error: row.last_error || null,
    updated_at: row.updated_at,
  };
}

/** Decrypted credentials, or throws. Fails CLOSED when the secret cannot be decrypted. */
function credentialsFor(orgId) {
  const row = appRow(orgId);
  if (!row || !row.client_secret_enc) throw new M365Error('Microsoft 365 is not set up for this organization. An org admin can add it in Settings → Microsoft 365.', { status: 409, code: 'm365_not_configured' });
  const secret = require('./secretbox').decrypt(row.client_secret_enc);
  if (secret == null) throw new M365Error('The Microsoft 365 client secret could not be decrypted. An org admin needs to enter it again.', { status: 409, code: 'm365_secret_unreadable' });
  return { tenantId: row.tenant_id, clientId: row.client_id, clientSecret: secret, version: row.updated_at };
}

/* ============================== tokens ============================== */

// orgId -> { token, expiresAt, key }. `key` changes when the app is edited, so an old token is never reused.
const tokenCache = new Map();
let fetchImpl = null;
const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a);

async function timed(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS);
  try { return await doFetch(url, { ...opts, signal: ac.signal }); }
  catch (e) {
    if (e && e.name === 'AbortError') throw new M365Error('Microsoft did not answer in time.', { status: 504, code: 'm365_timeout' });
    throw new M365Error(`Could not reach Microsoft: ${e && e.message}`, { status: 502, code: 'm365_unreachable' });
  }
  finally { clearTimeout(t); }
}

/** An app-only Graph token for the organization, cached until a minute before it expires. */
async function getToken(orgId, { force = false } = {}) {
  const cred = credentialsFor(orgId);
  const key = crypto.createHash('sha256').update(`${cred.tenantId}|${cred.clientId}|${cred.version}`).digest('hex');
  const hit = tokenCache.get(orgId);
  if (!force && hit && hit.key === key && hit.expiresAt > Date.now() + 60000) return hit.token;
  const res = await timed(`${LOGIN_HOST}/${encodeURIComponent(cred.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.clientId, client_secret: cred.clientSecret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.access_token) {
    // Entra's error_description starts with an AADSTS code an admin can look up; it never echoes the secret.
    const why = String(body.error_description || body.error || `HTTP ${res.status}`).split('\r\n')[0].slice(0, 300);
    throw new M365Error(`Microsoft refused the app credentials: ${why}`, { status: 502, code: 'm365_token_refused' });
  }
  const expiresIn = Math.max(60, Math.min(Number(body.expires_in) || 3600, 86400));
  tokenCache.set(orgId, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000, key });
  return body.access_token;
}

function forgetToken(orgId) { tokenCache.delete(orgId); }

/* ============================== Graph ============================== */

function graphErrorMessage(status, body) {
  const code = body && body.error && body.error.code;
  if (status === 401) return 'Microsoft rejected the app token.';
  if (status === 403) return 'The app is not allowed to read this. Grant it Files.Read.All, or add this site to Sites.Selected, and have an admin consent.';
  if (status === 404) return 'Microsoft could not find that item. Check the link, and that the app has access to the site.';
  if (status === 429 || status === 503) return 'Microsoft is throttling requests; the next sync will try again.';
  return `Microsoft Graph answered ${status}${code ? ` (${code})` : ''}.`;
}

/** GET a Graph path (or a nextLink, which must itself be on graph.microsoft.com). */
async function graphGet(orgId, pathOrUrl) {
  const url = /^https:\/\//.test(pathOrUrl) ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  if (!url.startsWith(`${GRAPH}/`)) throw new M365Error('Refusing a Graph link that is not on graph.microsoft.com.', { status: 502, code: 'm365_bad_link' });
  const attempt = async (force) => {
    const token = await getToken(orgId, { force });
    return timed(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  };
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);   // a token revoked early: one fresh try
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new M365Error(graphErrorMessage(res.status, body), { status: res.status === 404 ? 404 : 502, code: `graph_${res.status}` });
  return body;
}

/** The Graph share id for a sharing URL: "u!" + unpadded base64url of the URL. */
function shareIdFor(url) {
  return 'u!' + Buffer.from(String(url), 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/** Accept only sharing links on Microsoft's own hosts; the link itself never becomes a fetch target. */
function validateShareUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new M365Error('Paste the folder\'s sharing link (Share → Copy link).'); }
  const h = u.hostname.toLowerCase();
  const ok = u.protocol === 'https:' && (/^[a-z0-9-]+(-my)?\.sharepoint\.com$/.test(h) || h === 'onedrive.live.com' || h === '1drv.ms');
  if (!ok) throw new M365Error('That is not a SharePoint or OneDrive link.');
  return u.toString();
}

/** Resolve a sharing link to its folder: { driveId, itemId, name, webUrl }. */
async function resolveFolder(orgId, shareUrl) {
  const url = validateShareUrl(shareUrl);
  const item = await graphGet(orgId, `/shares/${shareIdFor(url)}/driveItem?$select=id,name,folder,webUrl,parentReference`);
  if (!item || !item.folder) throw new M365Error('That link is to a file, not a folder. Share the folder instead (or use an Embed link in a cloud document widget for a single file).');
  const driveId = item.parentReference && item.parentReference.driveId;
  if (!driveId || !item.id) throw new M365Error('Microsoft did not say which drive that folder is in.', { status: 502 });
  return { driveId, itemId: item.id, name: item.name || 'Folder', webUrl: item.webUrl || null };
}

const MEDIA_MIME_RE = /^(image\/(jpeg|png|gif|webp|bmp|svg\+xml)|video\/(mp4|webm|quicktime|x-matroska)|audio\/(mpeg|mp4|aac|ogg|wav|x-wav))$/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|wav)$/i;

/** Every file directly in a folder (not recursive), following paging. Capped at `max`. */
async function listFolder(orgId, driveId, itemId, { max = 1000 } = {}) {
  const out = [];
  let next = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$top=200&$select=id,name,size,file,folder,cTag,eTag,lastModifiedDateTime`;
  let pages = 0;
  while (next && pages++ < 50 && out.length < max) {
    const body = await graphGet(orgId, next);
    for (const it of (body && body.value) || []) {
      if (!it || it.folder || !it.file) continue;
      const mime = String((it.file && it.file.mimeType) || '');
      out.push({
        id: String(it.id), name: String(it.name || ''), size: Number(it.size) || 0,
        tag: String(it.cTag || it.eTag || it.lastModifiedDateTime || ''),
        mime, media: MEDIA_MIME_RE.test(mime) || MEDIA_EXT_RE.test(it.name || ''),
      });
      if (out.length >= max) break;
    }
    next = body && body['@odata.nextLink'] ? String(body['@odata.nextLink']) : null;
  }
  return out;
}

/**
 * Download one file's bytes to `destDir`, refusing anything over `maxBytes`. Returns the temp path.
 * Asks Graph for a fresh item (the downloadUrl is short-lived) and checks that URL before using it.
 */
async function downloadFile(orgId, driveId, itemId, { destDir, maxBytes }) {
  const item = await graphGet(orgId, `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,size,@microsoft.graph.downloadUrl`);
  const dl = item && item['@microsoft.graph.downloadUrl'];
  if (!dl) throw new M365Error('Microsoft did not offer a download for that file.', { status: 502 });
  checkDownloadUrl(dl);
  if (maxBytes && Number(item.size) > maxBytes) throw new M365Error('The file is larger than this server accepts.', { status: 413, code: 'too_large' });
  // No redirects: a pre-authenticated download URL answers with the bytes. A redirect would be a
  // second, unchecked destination.
  const res = await timed(dl, { redirect: 'manual', timeoutMs: 10 * 60 * 1000 });
  if (res.status !== 200 || !res.body) throw new M365Error(`The download failed (HTTP ${res.status}).`, { status: 502 });
  const dest = path.join(destDir, `${crypto.randomUUID()}.part`);
  const out = fs.createWriteStream(dest);
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) throw new M365Error('The file is larger than this server accepts.', { status: 413, code: 'too_large' });
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(dest); } catch { /* */ }
    throw e;
  }
  return { path: dest, size: total };
}

function checkDownloadUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new M365Error('Microsoft returned an unreadable download link.', { status: 502 }); }
  if (u.protocol !== 'https:') throw new M365Error('Refusing a download link that is not https.', { status: 502, code: 'ssrf_refused' });
  const bad = require('./remote-url').validateRemoteUrl(u.toString());
  if (bad) throw new M365Error('Refusing a download link to a private address.', { status: 502, code: 'ssrf_refused' });
  return u;
}

/** Test the app: a token, then one cheap call that needs no particular permission beyond the token. */
async function testApp(orgId) {
  forgetToken(orgId);
  await getToken(orgId, { force: true });
  return { ok: true };
}

function _setFetch(fn) { fetchImpl = fn || null; tokenCache.clear(); }

module.exports = {
  M365Error, validateTenant, appRow, present, credentialsFor, getToken, forgetToken, graphGet,
  shareIdFor, validateShareUrl, resolveFolder, listFolder, downloadFile, checkDownloadUrl, testApp,
  GUID_RE, _setFetch,
};
