'use strict';

/*
 * Google Drive for an organization: its OWN Google Cloud service account (bring-your-own), used to
 * read folders that were shared with it. The Drive counterpart of lib/m365.js, with the same three
 * calls lib/cloud-folders.js needs (resolveFolder, listFolder, downloadFile), so a Drive folder syncs
 * exactly like a SharePoint/OneDrive one.
 *
 * Per ORGANIZATION (org_google_drive): the service account's client_email and private key. The key is
 * stored with lib/secretbox and never returned: the API answers has_private_key, like org SSO.
 *
 * How a customer grants access: share the Drive folder with the service account's address (Viewer is
 * enough), or add the account to a shared drive. No domain-wide delegation and no Google app review:
 * the account reads only what was shared with it. Scope: drive.readonly.
 *
 * ⚠️ HOSTS ARE FIXED. Tokens come from oauth2.googleapis.com and every API call goes to
 * www.googleapis.com/drive/v3; the key's own token_uri is ignored (see lib/rooms/http.js for why).
 * The one host taken from a response is a file download's redirect, which must be https on
 * *.googleusercontent.com and pass lib/remote-url validateRemoteUrl, and is fetched WITHOUT the token.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TIMEOUT_MS = 20000;
// Drive file and folder ids: letters, digits, - and _. Checked before one goes into a query string.
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

function dbOf() { return require('../db/database').db; }

class GDriveError extends Error {
  constructor(message, { status = 400, code = 'gdrive_error' } = {}) { super(message); this.status = status; this.code = code; }
}

/* ============================== stored account ============================== */

function appRow(orgId) {
  try { return dbOf().prepare('SELECT * FROM org_google_drive WHERE organization_id = ?').get(orgId) || null; }
  catch (e) { if (/no such table/i.test(e.message)) return null; throw e; }
}

/** What the API may show: never the key. */
function present(row) {
  if (!row) return { configured: false };
  return {
    configured: true,
    client_email: row.client_email,
    has_private_key: !!row.private_key_enc,
    last_test_at: row.last_test_at || null,
    last_test_ok: row.last_test_ok == null ? null : !!row.last_test_ok,
    last_error: row.last_error || null,
    updated_at: row.updated_at,
  };
}

/** client_email and private_key from a pasted service-account JSON key, or { error }. */
function parseKey(text) {
  return require('./rooms/google').parseKey(text);
}

/** Decrypted credentials, or throws. Fails CLOSED when the key cannot be decrypted. */
function credentialsFor(orgId) {
  const row = appRow(orgId);
  if (!row || !row.private_key_enc) throw new GDriveError('Google Drive is not set up for this organization. An org admin can add it in Settings → Google Drive.', { status: 409, code: 'gdrive_not_configured' });
  const key = require('./secretbox').decrypt(row.private_key_enc);
  if (key == null) throw new GDriveError('The Google service account key could not be decrypted. An org admin needs to enter it again.', { status: 409, code: 'gdrive_key_unreadable' });
  return { clientEmail: row.client_email, privateKey: key, version: row.updated_at };
}

/* ============================== tokens ============================== */

const tokenCache = new Map();   // orgId -> { token, expiresAt, key }
let fetchImpl = null;
const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a);
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function timed(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS);
  try { return await doFetch(url, { ...opts, signal: ac.signal }); }
  catch (e) {
    if (e && e.name === 'AbortError') throw new GDriveError('Google did not answer in time.', { status: 504, code: 'gdrive_timeout' });
    throw new GDriveError(`Could not reach Google: ${e && e.message}`, { status: 502, code: 'gdrive_unreachable' });
  }
  finally { clearTimeout(t); }
}

/** The signed JWT exchanged for an access token (RS256, Node's crypto: no googleapis dependency). */
function assertion(cred, nowSec = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: cred.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 })}`;
  return `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(cred.privateKey).toString('base64url')}`;
}

async function getToken(orgId, { force = false } = {}) {
  const cred = credentialsFor(orgId);
  const key = crypto.createHash('sha256').update(`${cred.clientEmail}|${cred.version}`).digest('hex');
  const hit = tokenCache.get(orgId);
  if (!force && hit && hit.key === key && hit.expiresAt > Date.now() + 60000) return hit.token;
  let jwt;
  try { jwt = assertion(cred); } catch { throw new GDriveError('The service account key could not sign a request. Paste the JSON key again.', { status: 409, code: 'gdrive_key_invalid' }); }
  const res = await timed(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.access_token) {
    const why = String(body.error_description || body.error || `HTTP ${res.status}`).slice(0, 300);
    throw new GDriveError(`Google refused the service account: ${why}`, { status: 502, code: 'gdrive_token_refused' });
  }
  const expiresIn = Math.max(60, Math.min(Number(body.expires_in) || 3600, 86400));
  tokenCache.set(orgId, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000, key });
  return body.access_token;
}

function forgetToken(orgId) { tokenCache.delete(orgId); }

/* ============================== Drive API ============================== */

function apiErrorMessage(status, body) {
  const reason = body && body.error && Array.isArray(body.error.errors) && body.error.errors[0] && body.error.errors[0].reason;
  if (status === 401) return 'Google rejected the service account token.';
  if (status === 403 && /rateLimit|userRateLimit/i.test(reason || '')) return 'Google is rate-limiting requests; the next sync will try again.';
  if (status === 403) return 'The service account is not allowed to read this. Share the folder with its address (Viewer is enough), and check the Google Drive API is enabled in its project.';
  if (status === 404) return 'Google could not find that folder. Share it with the service account\'s address (Viewer is enough), then try again.';
  if (status === 429 || status === 503) return 'Google is rate-limiting requests; the next sync will try again.';
  return `Google Drive answered ${status}${reason ? ` (${reason})` : ''}.`;
}

async function apiGet(orgId, pathAndQuery) {
  const url = `${API}${pathAndQuery}`;
  const attempt = async (force) => {
    const token = await getToken(orgId, { force });
    return timed(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  };
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new GDriveError(apiErrorMessage(res.status, body), { status: res.status === 404 ? 404 : 502, code: `gdrive_${res.status}` });
  return body;
}

/**
 * The folder id in a Drive folder link. Accepts drive.google.com/drive/folders/<id> (also under
 * /drive/u/<n>/ and with ?usp=sharing), and drive.google.com/open?id=<id>. Only Google's own host;
 * the link itself is never fetched.
 */
function folderIdFrom(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new GDriveError('Paste the folder\'s link (in Drive: Share → Copy link).'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'drive.google.com') throw new GDriveError('That is not a Google Drive folder link.');
  const m = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
  const id = m ? m[1] : (u.pathname === '/open' ? u.searchParams.get('id') : null);
  if (!id || !ID_RE.test(id)) throw new GDriveError('That is not a Google Drive folder link. Open the folder in Drive and copy its link.');
  return id;
}

/** Canonical form of a folder link, stored as the folder's share_url. */
function validateShareUrl(input) {
  return `https://drive.google.com/drive/folders/${folderIdFrom(input)}`;
}

/**
 * Resolve a folder link: { driveId, itemId, name, webUrl }. driveId is the shared drive's id, or
 * 'my-drive' for a folder in someone's My Drive (the column is required; Drive itself needs only the
 * folder id).
 */
async function resolveFolder(orgId, shareUrl) {
  const id = folderIdFrom(shareUrl);
  const item = await apiGet(orgId, `/files/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink,driveId,trashed&supportsAllDrives=true`);
  if (!item || item.mimeType !== FOLDER_MIME) throw new GDriveError('That link is to a file, not a folder. Share the folder instead (or use a Cloud document widget for a single Google Slides, Docs or Sheets file).');
  if (item.trashed) throw new GDriveError('That folder is in the trash.');
  return { driveId: item.driveId || 'my-drive', itemId: String(item.id), name: item.name || 'Folder', webUrl: item.webViewLink || `https://drive.google.com/drive/folders/${id}` };
}

const MEDIA_MIME_RE = /^(image\/(jpeg|png|gif|webp|bmp|svg\+xml)|video\/(mp4|webm|quicktime|x-matroska)|audio\/(mpeg|mp4|aac|ogg|wav|x-wav))$/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|wav)$/i;

/**
 * Every file directly in a folder (not recursive, not trashed), following paging. Same contract as
 * m365.listFolder: { files, complete }, stopping once `maxMedia` media files are listed. Google's own
 * Docs/Sheets/Slides have no bytes to download, so they are listed as not media (skipped, counted).
 */
async function listFolder(orgId, driveId, itemId, { maxMedia = 1000 } = {}) {
  if (!ID_RE.test(String(itemId))) throw new GDriveError('The stored folder id is not valid.', { status: 500 });
  const out = [];
  let media = 0;
  let pageToken = null;
  let pages = 0;
  let complete = true;
  const q = encodeURIComponent(`'${itemId}' in parents and trashed = false`);
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,md5Checksum,version,modifiedTime)');
  do {
    if (pages++ >= 50 || media >= maxMedia) { complete = false; break; }
    const body = await apiGet(orgId, `/files?q=${q}&fields=${fields}&pageSize=200&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    const value = (body && body.files) || [];
    let i = 0;
    for (; i < value.length && media < maxMedia; i++) {
      const it = value[i];
      if (!it || it.mimeType === FOLDER_MIME || !it.id) continue;
      const mime = String(it.mimeType || '');
      const native = mime.startsWith('application/vnd.google-apps.');
      const f = {
        id: String(it.id), name: String(it.name || ''), size: Number(it.size) || 0,
        // md5 changes exactly when the bytes do; version/modifiedTime as a fallback.
        tag: String(it.md5Checksum || it.version || it.modifiedTime || ''),
        mime, media: !native && (MEDIA_MIME_RE.test(mime) || MEDIA_EXT_RE.test(it.name || '')),
      };
      out.push(f);
      if (f.media) media++;
    }
    if (i < value.length) { complete = false; break; }
    pageToken = body && body.nextPageToken ? String(body.nextPageToken) : null;
  } while (pageToken);
  return { files: out, complete };
}

function checkDownloadUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new GDriveError('Google returned an unreadable download link.', { status: 502 }); }
  if (u.protocol !== 'https:' || !/(^|\.)googleusercontent\.com$/i.test(u.hostname)) throw new GDriveError('Refusing a download link that is not on googleusercontent.com.', { status: 502, code: 'ssrf_refused' });
  if (require('./remote-url').validateRemoteUrl(u.toString())) throw new GDriveError('Refusing a download link to a private address.', { status: 502, code: 'ssrf_refused' });
  return u;
}

/** Download one file's bytes to `destDir`, refusing anything over `maxBytes`. Returns { path, size }. */
async function downloadFile(orgId, driveId, itemId, { destDir, maxBytes }) {
  if (!ID_RE.test(String(itemId))) throw new GDriveError('Not a Drive file id.', { status: 400 });
  const url = `${API}/files/${encodeURIComponent(itemId)}?alt=media&supportsAllDrives=true`;
  const get = async (force) => timed(url, { headers: { Authorization: `Bearer ${await getToken(orgId, { force })}` }, redirect: 'manual', timeoutMs: 10 * 60 * 1000 });
  let res = await get(false);
  if (res.status === 401) res = await get(true);
  // Drive may hand the bytes off to googleusercontent.com. Followed once, checked, and without the token.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new GDriveError('Google redirected the download without a destination.', { status: 502 });
    res = await timed(checkDownloadUrl(new URL(loc, url).toString()).toString(), { redirect: 'manual', timeoutMs: 10 * 60 * 1000 });
  }
  if (res.status !== 200 || !res.body) {
    let body = null;
    try { body = await res.json(); } catch { /* */ }
    throw new GDriveError(res.status >= 400 ? apiErrorMessage(res.status, body) : `The download failed (HTTP ${res.status}).`, { status: 502 });
  }
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && declared > maxBytes) throw new GDriveError('The file is larger than this server accepts.', { status: 413, code: 'too_large' });
  const dest = path.join(destDir, `${crypto.randomUUID()}.part`);
  const out = fs.createWriteStream(dest);
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) throw new GDriveError('The file is larger than this server accepts.', { status: 413, code: 'too_large' });
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

/** Test the account: a token from Google (proves the key and that the account exists). */
async function testApp(orgId) {
  forgetToken(orgId);
  await getToken(orgId, { force: true });
  return { ok: true };
}

function _setFetch(fn) { fetchImpl = fn || null; tokenCache.clear(); }

module.exports = {
  GDriveError, appRow, present, parseKey, credentialsFor, assertion, getToken, forgetToken, apiGet,
  folderIdFrom, validateShareUrl, resolveFolder, listFolder, downloadFile, checkDownloadUrl, testApp,
  TOKEN_URL, API, SCOPE, FOLDER_MIME, _setFetch,
};
