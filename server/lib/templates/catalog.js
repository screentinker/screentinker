'use strict';

/*
 * Template catalogs: where installable templates come from, and every rule about trusting them.
 *
 * ⚠️ OFF UNTIL AN ADMIN TURNS IT ON. This server never contacts a catalog on its own initiative
 * unless `templates_catalog_enabled` is set — the same "no phone home" promise the plugin loader
 * makes (docs/plugins.md P4). Everything below also works with the network switch off: a signed
 * package or an offline bundle, imported by hand, is verified against the same keys.
 *
 * The trust chain, end to end:
 *   catalog public key (compiled in, or added by a platform admin)
 *     → signs index.json (domain-separated, key_id-bound)          verifyIndex
 *       → index.catalog must equal the catalog's own id            (no cross-catalog replay)
 *       → index.serial must not go below the highest seen          (no rollback)
 *       → index.expires in the past = shown as STALE               (freeze is visible)
 *       → each version pins a sha256 of the canonical package      (no substitution)
 *         → the package bytes must hash to it before install, and again at every load (store.js)
 *     → revoked[] disables matching installs, whatever the auto-update setting
 */

const path = require('path');
const { db } = require('../../db/database');
const appSettings = require('../app-settings');
const pkgLib = require('./package');
const signing = require('./signing');
const store = require('./store');
const paramsLib = require('./params');
const { readZip } = require('./zip');

const OFFICIAL_ID = 'official';
const DEFAULT_OFFICIAL_URL = 'https://screentinker.github.io/templates/';
const CATALOG_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATES = 2000;
const SETTING_ENABLED = 'templates_catalog_enabled';
const SETTING_UNSIGNED_CODE = 'templates_allow_unsigned_code';

class CatalogError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'CatalogError'; this.status = status; }
}

function serverVersion() {
  try { return require('../../package.json').version; } catch { return '0.0.0'; }
}

function semverCmp(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/* ------------------------------------------------------------------ settings */

const networkEnabled = () => appSettings.getBool(SETTING_ENABLED, false);
const unsignedCodeAllowed = () => appSettings.getBool(SETTING_UNSIGNED_CODE, false);

/* ------------------------------------------------------------------ catalogs */

function officialUrl() {
  return process.env.TEMPLATE_CATALOG_URL || DEFAULT_OFFICIAL_URL;
}

/*
 * ⚠️ THE BUILT-IN ROW IS REWRITTEN FROM CODE AT EVERY BOOT. Its key is whatever this build
 * compiled in (or TEMPLATE_CATALOG_PUBLIC_KEY), never whatever the database happens to say — a
 * database row is not where a trust anchor may live, because anything that can write the
 * database could then swap it.
 */
function ensureOfficial() {
  const pem = signing.officialPublicKey().export({ type: 'spki', format: 'pem' });
  const row = db.prepare('SELECT * FROM template_catalogs WHERE id = ?').get(OFFICIAL_ID);
  if (!row) {
    db.prepare('INSERT INTO template_catalogs (id, label, url, public_key, builtin, enabled) VALUES (?, ?, ?, ?, 1, 1)')
      .run(OFFICIAL_ID, 'ScreenTinker', officialUrl(), pem);
  } else if (row.public_key !== pem || row.url !== officialUrl() || !row.builtin) {
    // A changed key invalidates the cached index: it was verified under the old one.
    const keyChanged = row.public_key !== pem;
    db.prepare(`UPDATE template_catalogs SET public_key = ?, url = ?, builtin = 1${keyChanged ? ', index_json = NULL, index_expires = NULL, last_serial = 0' : ''} WHERE id = ?`)
      .run(pem, officialUrl(), OFFICIAL_ID);
  }
}

function listCatalogs() {
  ensureOfficial();
  return db.prepare('SELECT * FROM template_catalogs ORDER BY builtin DESC, label COLLATE NOCASE').all();
}

function getCatalog(id) {
  ensureOfficial();
  return db.prepare('SELECT * FROM template_catalogs WHERE id = ?').get(String(id));
}

/** Trusted keys = every ENABLED catalog. */
function trustedKeys() {
  const out = [];
  for (const c of listCatalogs()) {
    if (!c.enabled) continue;
    try { out.push({ id: c.id, label: c.label, key: signing.toPublicKey(c.public_key) }); } catch { /* bad row */ }
  }
  return out;
}

function addCatalog({ id, label, url, publicKey }) {
  if (typeof id !== 'string' || !CATALOG_ID_RE.test(id) || id === OFFICIAL_ID || id === 'local') {
    throw new CatalogError('catalog id must be 2-32 lower-case letters, digits or dashes (not "official" or "local")');
  }
  if (typeof label !== 'string' || !label.trim() || label.length > 60) throw new CatalogError('label is required (max 60 characters)');
  if (url != null && url !== '') {
    let u;
    try { u = new URL(url); } catch { throw new CatalogError('url is not a URL'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw new CatalogError('url must be http(s)');
    if (u.username || u.password) throw new CatalogError('url must not contain credentials');
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    url = u.toString();
  } else url = null;
  let key;
  try { key = signing.toPublicKey(String(publicKey || '')); } catch { throw new CatalogError('public key must be an Ed25519 public key in PEM form'); }
  const pem = key.export({ type: 'spki', format: 'pem' });
  if (listCatalogs().some((c) => c.public_key === pem)) throw new CatalogError('a catalog with this key already exists');
  if (getCatalog(id)) throw new CatalogError('a catalog with this id already exists', 409);
  db.prepare('INSERT INTO template_catalogs (id, label, url, public_key, builtin, enabled) VALUES (?, ?, ?, ?, 0, 1)')
    .run(id, label.trim(), url, pem);
  return getCatalog(id);
}

function setCatalogEnabled(id, enabled) {
  const c = getCatalog(id);
  if (!c) throw new CatalogError('no such catalog', 404);
  db.prepare('UPDATE template_catalogs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getCatalog(id);
}

function removeCatalog(id) {
  const c = getCatalog(id);
  if (!c) throw new CatalogError('no such catalog', 404);
  if (c.builtin) throw new CatalogError('the built-in catalog can be disabled but not removed');
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM templates_installed WHERE catalog = ?').get(id).n;
  if (inUse) throw new CatalogError(`${inUse} installed template(s) came from this catalog — uninstall them first`, 409);
  db.prepare('DELETE FROM template_catalogs WHERE id = ?').run(id);
  return 1;
}

/* ------------------------------------------------------------------ index */

function isPlain(v) { return pkgLib.isPlainObject(v); }

/** Shape-check a (signature-verified) index. Returns a normalised copy. */
function validateIndex(obj) {
  if (!isPlain(obj) || obj.schema !== 1) throw new CatalogError('index has an unknown schema');
  if (typeof obj.catalog !== 'string' || !CATALOG_ID_RE.test(obj.catalog)) throw new CatalogError('index.catalog is invalid');
  if (!Number.isSafeInteger(obj.serial) || obj.serial < 1) throw new CatalogError('index.serial is invalid');
  const expires = Date.parse(obj.expires);
  if (!Number.isFinite(expires)) throw new CatalogError('index.expires is invalid');
  if (!Array.isArray(obj.templates) || obj.templates.length > MAX_TEMPLATES) throw new CatalogError('index.templates is invalid');
  // ⚠️ REVOCATIONS FAIL CLOSED. An entry this server cannot parse ("v1.0.0", "1.0.*", "Bad-Id")
  // used to be filtered out silently — so a revocation the catalog meant to publish revoked
  // nothing. A malformed revocation now refuses the whole index: the operator sees the error,
  // and the previous (still valid) index stays in force.
  if (obj.revoked !== undefined && !Array.isArray(obj.revoked)) throw new CatalogError('index.revoked must be an array');
  const revoked = obj.revoked || [];
  if (revoked.length > 5000) throw new CatalogError('index.revoked is too long');
  revoked.forEach((r, i) => {
    if (!isPlain(r)) throw new CatalogError(`index.revoked[${i}] is not an object`);
    if (r.id !== undefined && r.id !== null && (typeof r.id !== 'string' || !pkgLib.ID_RE.test(r.id))) throw new CatalogError(`index.revoked[${i}].id is invalid`);
    if (r.versions !== undefined && (!Array.isArray(r.versions) || r.versions.some((v) => v !== '*' && !(typeof v === 'string' && pkgLib.SEMVER_RE.test(v))))) {
      throw new CatalogError(`index.revoked[${i}].versions must be "*" or x.y.z versions`);
    }
    if (r.sha256 !== undefined && (!Array.isArray(r.sha256) || r.sha256.some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)))) {
      throw new CatalogError(`index.revoked[${i}].sha256 must be lower-case sha256 hex strings`);
    }
    if (!r.id && !(r.sha256 && r.sha256.length)) throw new CatalogError(`index.revoked[${i}] names nothing`);
  });
  const templates = [];
  const seen = new Set();
  for (const t of obj.templates) {
    if (!isPlain(t) || typeof t.id !== 'string' || !pkgLib.ID_RE.test(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    const versions = (Array.isArray(t.versions) ? t.versions : []).filter((v) => isPlain(v)
      && typeof v.version === 'string' && pkgLib.SEMVER_RE.test(v.version)
      && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
      && typeof v.url === 'string' && v.url.length <= 300 && !/^[a-z][a-z0-9+.-]*:/i.test(v.url) && !v.url.startsWith('/') && !v.url.includes('..'))
      .map((v) => ({
        version: v.version, sha256: v.sha256, url: v.url,
        size: Number.isSafeInteger(v.size) ? v.size : null,
        min_server: typeof v.min_server === 'string' && pkgLib.SEMVER_RE.test(v.min_server) ? v.min_server : '0.0.0',
        network: Array.isArray(v.network) ? v.network.filter((h) => typeof h === 'string' && pkgLib.HOST_RE.test(h)).slice(0, 8) : [],
        published: typeof v.published === 'string' ? v.published.slice(0, 32) : null,
      }))
      .sort((a, b) => semverCmp(b.version, a.version));
    if (!versions.length) continue;
    const s = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').slice(0, n) : '');
    templates.push({
      id: t.id, name: s(t.name, 80) || t.id, description: s(t.description, 500), author: s(t.author, 80),
      license: s(t.license, 40), kind: t.kind === 'html' ? 'html' : 'slide',
      tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string').map((x) => s(x, 24)).slice(0, 12) : [],
      orientation: Array.isArray(t.orientation) ? t.orientation.filter((o) => o === 'landscape' || o === 'portrait') : ['landscape'],
      homepage: typeof t.homepage === 'string' && /^https:\/\/[^\s"'<>]+$/.test(t.homepage) ? t.homepage.slice(0, 200) : '',
      thumbnail: typeof t.thumbnail === 'string' && /^thumbs\/[a-z0-9.-]{1,100}\.(png|jpe?g|webp)$/.test(t.thumbnail) && !t.thumbnail.includes('..') ? t.thumbnail : null,
      versions,
    });
  }
  return {
    schema: 1, catalog: obj.catalog, serial: obj.serial,
    generated: typeof obj.generated === 'string' ? obj.generated.slice(0, 40) : null,
    expires: new Date(expires).toISOString(),
    revoked: revoked.map((r) => ({
      id: r.id || null,
      versions: Array.isArray(r.versions) && r.versions.length ? r.versions : ['*'],
      sha256: Array.isArray(r.sha256) ? r.sha256 : [],
      reason: typeof r.reason === 'string' ? r.reason.replace(/[\u0000-\u001f]/g, '').slice(0, 300) : '',
    })),
    templates,
  };
}

/**
 * Verify and store an index for a catalog. `indexBytes` + `sigText` exactly as served.
 * Returns { index, changed }. Throws CatalogError on any failure (and records it).
 */
function acceptIndex(catalogId, indexBytes, sigText) {
  const c = getCatalog(catalogId);
  if (!c) throw new CatalogError('no such catalog', 404);
  if (!c.enabled) throw new CatalogError('this catalog is disabled');
  if (!Buffer.isBuffer(indexBytes) || indexBytes.length > MAX_INDEX_BYTES) throw new CatalogError('index is too large');
  if (!signing.verifyIndex(indexBytes, sigText, c.public_key)) {
    throw new CatalogError(`the index is not signed by the "${c.label}" catalog key`);
  }
  let raw;
  try { raw = JSON.parse(indexBytes.toString('utf8')); } catch { throw new CatalogError('index is not valid JSON'); }
  const index = validateIndex(raw);
  // ⚠️ BOUND TO THIS CATALOG. Two catalogs could share a key (or a key could be reused by
  // mistake); an index signed for one must not be accepted as the other.
  if (index.catalog !== c.id) throw new CatalogError(`the index is for catalog "${index.catalog}", not "${c.id}"`);
  if (index.serial < c.last_serial) {
    throw new CatalogError(`the index is older (serial ${index.serial}) than one already accepted (${c.last_serial}) — refusing a rollback`);
  }
  const canonical = JSON.stringify(index);
  if (index.serial === c.last_serial && c.index_json && c.index_json !== canonical) {
    throw new CatalogError('the index changed without a new serial — refusing it');
  }
  const changed = c.index_json !== canonical;
  db.prepare(`UPDATE template_catalogs SET index_json = ?, index_expires = ?, last_serial = ?, last_ok = strftime('%s','now'), last_error = NULL WHERE id = ?`)
    .run(canonical, index.expires, index.serial, c.id);
  applyRevocations(c.id, index);
  return { index, changed };
}

function cachedIndex(catalogId) {
  const c = getCatalog(catalogId);
  if (!c || !c.index_json) return null;
  try { return JSON.parse(c.index_json); } catch { return null; }
}

function isRevoked(index, catalogId, templateId, version, sha256) {
  if (!index) return null;
  for (const r of index.revoked || []) {
    if (sha256 && (r.sha256 || []).includes(sha256)) return r;
    if (catalogId === index.catalog && r.id === templateId
      && (r.versions.includes('*') || r.versions.includes(version))) return r;
  }
  return null;
}

/*
 * ⚠️ A REVOCATION REACHES INSTALLS THAT DO NOT AUTO-UPDATE. That is the whole point of it: the
 * install that most needs pulling is the one nobody is looking at. A revoked template renders a
 * black page (render.js blankPage) until an admin installs a version that is not revoked.
 * sha256 entries match installs from ANY catalog, including unverified local imports of the same
 * bytes.
 */
function applyRevocations(catalogId, index) {
  const changed = [];
  for (const row of store.listInstalled()) {
    const hit = isRevoked(index, row.catalog, row.template_id, row.version, row.sha256);
    if (hit && row.status !== 'revoked') {
      store.setStatus(row.id, 'revoked', `Revoked by the ${catalogId} catalog${hit.reason ? `: ${hit.reason}` : ''}`);
      changed.push(row.id);
    } else if (!hit && row.status === 'revoked'
      && String(row.status_reason || '').startsWith(`Revoked by the ${catalogId} catalog`)) {
      // Lifted by the SAME catalog that revoked it (whichever catalog the install came from — a
      // sha256 revocation can reach another catalog's install or a local import).
      // A newer signed index no longer lists it (serial cannot go backwards, so this is the
      // catalog's own decision, not a replay of an old index).
      store.setStatus(row.id, 'active', null);
      changed.push(row.id);
    }
  }
  if (changed.length) {
    try { require('../activity').logActivity?.(null, 'templates.revocation', JSON.stringify({ catalog: catalogId, templates: changed })); } catch { /* optional */ }
  }
  return changed;
}

/* ------------------------------------------------------------------ fetching */

function resolveUrl(base, rel) {
  // The base is a DIRECTORY. Without the trailing slash "https://h/templates" would accept
  // "https://h/templates-evil/x" by prefix, and relative urls would resolve against the parent.
  const b = new URL(base);
  if (!b.pathname.endsWith('/')) b.pathname += '/';
  const u = new URL(rel, b);
  // A relative url in the index must stay under the catalog's own base — never another host.
  if (u.origin !== b.origin || !u.pathname.startsWith(b.pathname) || u.username || u.password) throw new CatalogError('index points outside the catalog');
  return u.toString();
}

let fetcher = null;
/** For tests: replace the network. fn(url, {maxBytes}) -> Promise<Buffer>. */
function setFetcher(fn) { fetcher = fn; }

async function fetchBytes(url, maxBytes) {
  if (fetcher) return fetcher(url, { maxBytes });
  const allowPrivate = ['1', 'true', 'yes'].includes(String(process.env.TEMPLATE_CATALOG_ALLOW_PRIVATE || '').toLowerCase());
  if (!allowPrivate) {
    const { guardedRequest } = require('../ssrf-guard');
    const r = await guardedRequest(url, { timeoutMs: 20000, maxBytes, responseType: 'buffer', maxRedirects: 3 });
    if (r.statusCode !== 200) throw new CatalogError(`catalog responded HTTP ${r.statusCode}`);
    return r.buffer;
  }
  // A LAN mirror (docs/templates.md "Air-gapped"). The SSRF guard exists to stop a URL pointing at
  // internal hosts; this switch is an operator saying that is exactly where their mirror lives.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'error' });
    if (res.status !== 200) throw new CatalogError(`catalog responded HTTP ${res.status}`);
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > maxBytes) throw new CatalogError('response too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(t); }
}

async function refreshCatalog(catalogId) {
  const c = getCatalog(catalogId);
  if (!c) throw new CatalogError('no such catalog', 404);
  if (!c.url) throw new CatalogError('this catalog has no URL — import an offline bundle instead');
  db.prepare("UPDATE template_catalogs SET last_checked = strftime('%s','now') WHERE id = ?").run(c.id);
  try {
    const [idx, sig] = await Promise.all([
      fetchBytes(resolveUrl(c.url, 'index.json'), MAX_INDEX_BYTES),
      fetchBytes(resolveUrl(c.url, 'index.json.sig'), 1024),
    ]);
    return acceptIndex(c.id, idx, sig.toString('utf8'));
  } catch (e) {
    const msg = e instanceof CatalogError ? e.message : 'the catalog could not be reached';
    db.prepare('UPDATE template_catalogs SET last_error = ? WHERE id = ?').run(msg, c.id);
    if (!(e instanceof CatalogError)) console.warn(`[templates] catalog ${c.id} fetch failed: ${e.message}`);
    throw e instanceof CatalogError ? e : new CatalogError(msg, 502);
  }
}

async function refreshAll() {
  if (!networkEnabled()) return [];
  const out = [];
  for (const c of listCatalogs()) {
    if (!c.enabled || !c.url) continue;
    try { await refreshCatalog(c.id); out.push({ id: c.id, ok: true }); } catch (e) { out.push({ id: c.id, ok: false, error: e.message }); }
  }
  return out;
}

let pollTimer = null;
function startPoller() {
  if (pollTimer) return;
  const first = setTimeout(() => { refreshAll().catch(() => {}); }, 5 * 60 * 1000);
  first.unref?.();
  pollTimer = setInterval(() => { refreshAll().catch(() => {}); }, 24 * 3600 * 1000);
  pollTimer.unref?.();
}
function stopPoller() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

/* ------------------------------------------------------------------ installing */

function checkInstallable(env) {
  if (semverCmp(env.manifest.min_server, serverVersion()) > 0) {
    throw new CatalogError(`this template needs ScreenTinker ${env.manifest.min_server} or newer`);
  }
  const bad = paramsLib.checkDefaults(env.manifest, env.files);
  if (bad) throw new CatalogError(`the template's own defaults are invalid: ${bad}`);
  // A trial render with the defaults: a template that cannot be rendered within the budget (or at
  // all) is refused at the door, rather than discovered as a black screen on a wall.
  if (env.manifest.kind === 'html') {
    const render = require('./render');
    const values = render.lenientValues(env.manifest, {}, { files: env.files });
    const t0 = Date.now();
    let out;
    try { out = render.buildHtmlDocument(env, values, {}); } catch (e) { throw new CatalogError(`the template cannot be rendered: ${e.message}`); }
    if (/Template is too large to render/.test(out.html)) throw new CatalogError('the template is too large to render');
    if (Date.now() - t0 > 2000) throw new CatalogError('the template takes too long to render');
  }
}

/*
 * ⚠️ THE INDEX DESCRIBES A PACKAGE; IT DOES NOT GET TO DISAGREE WITH IT. The library shows the
 * index's kind and network hosts to the admin deciding whether to install — so an index saying
 * "slide, no network" over a package that is html code talking to a host would be a lie told at
 * exactly the moment of consent. The manifest is the truth; a mismatch refuses the install.
 */
function checkIndexMatchesManifest(t, v, manifest) {
  if (t.kind !== manifest.kind) throw new CatalogError('the catalog index describes this template as a different kind than the package is');
  const a = [...(v.network || [])].sort().join(',');
  const b = [...(manifest.network || [])].sort().join(',');
  if (a !== b) throw new CatalogError('the catalog index lists different network hosts than the package declares');
  if ((v.min_server || '0.0.0') !== (manifest.min_server || '0.0.0')) throw new CatalogError('the catalog index and the package disagree on the minimum server version');
}

/** Any enabled catalog's index revoking these bytes (by sha256), whichever catalog they came from. */
function revokedByHashAnywhere(sha256) {
  for (const c of listCatalogs()) {
    if (!c.enabled) continue;
    const idx = cachedIndex(c.id);
    for (const r of (idx ? idx.revoked : [])) if ((r.sha256 || []).includes(sha256)) return { catalog: c, r };
  }
  return null;
}

async function installFromCatalog(catalogId, templateId, version, userId) {
  const c = getCatalog(catalogId);
  if (!c || !c.enabled) throw new CatalogError('no such catalog', 404);
  const index = cachedIndex(catalogId);
  if (!index) throw new CatalogError('this catalog has no index yet — check for updates or import an offline bundle');
  const t = index.templates.find((x) => x.id === templateId);
  if (!t) throw new CatalogError('no such template in this catalog', 404);
  const v = version ? t.versions.find((x) => x.version === version) : t.versions[0];
  if (!v) throw new CatalogError('no such version', 404);
  const rev = isRevoked(index, catalogId, templateId, v.version, v.sha256);
  if (rev) throw new CatalogError(`this version has been revoked${rev.reason ? `: ${rev.reason}` : ''}`, 409);

  let bytes = null;
  if (store.hasPackageFile(v.sha256)) {
    try { bytes = require('fs').readFileSync(store.packagePath(v.sha256)); } catch { bytes = null; }
  }
  if (!bytes) {
    if (!c.url) throw new CatalogError('this package is not in the offline bundle and the catalog has no URL');
    if (!networkEnabled()) throw new CatalogError('the community library is switched off — enable it, or import the package file', 409);
    bytes = await fetchBytes(resolveUrl(c.url, v.url), pkgLib.MAX_ENVELOPE_BYTES * 2);
  }
  let env;
  try { env = pkgLib.parseEnvelope(bytes); } catch (e) { throw new CatalogError(`the downloaded package is invalid: ${e.message}`); }
  // ⚠️ THE SIGNED INDEX PINS THE BYTES. A package that does not hash to what the index says is
  // refused, whoever signed the package itself.
  if (env.sha256 !== v.sha256) throw new CatalogError('the downloaded package does not match the catalog index — refusing it');
  if (env.manifest.id !== templateId || env.manifest.version !== v.version) throw new CatalogError('the package is not the template the index describes');
  checkIndexMatchesManifest(t, v, env.manifest);
  const anywhere = revokedByHashAnywhere(env.sha256);
  if (anywhere) throw new CatalogError(`these bytes have been revoked by the ${anywhere.catalog.label} catalog${anywhere.r.reason ? `: ${anywhere.r.reason}` : ''}`, 409);
  checkInstallable(env);
  return store.recordInstall({ env, envelopeBytes: bytes, catalog: c.id, trust: 'verified', signer: c.label, signerKeyId: signing.keyId(c.public_key), userId });
}

/**
 * A .sttemplate uploaded by an admin. Signed by a trusted catalog key → verified, under that
 * catalog; otherwise → unverified, under "local".
 */
function importPackage(bytes, userId, { allowUnverifiedCode = unsignedCodeAllowed() } = {}) {
  let env;
  try { env = pkgLib.parseEnvelope(bytes); } catch (e) { throw new CatalogError(e.message); }
  const signer = signing.verifyPackage(env.packageBytes, env.signature, trustedKeys());
  let catalog = 'local';
  let trust = 'unverified';
  if (signer) {
    catalog = signer.id;
    trust = 'verified';
    const index = cachedIndex(signer.id);
    const rev = isRevoked(index, signer.id, env.manifest.id, env.manifest.version, env.sha256);
    if (rev) throw new CatalogError(`this template version has been revoked${rev.reason ? `: ${rev.reason}` : ''}`, 409);
    const listed = index && index.templates.find((t) => t.id === env.manifest.id);
    const lv = listed && listed.versions.find((x) => x.version === env.manifest.version);
    if (lv && lv.sha256 !== env.sha256) throw new CatalogError('this package does not match the catalog index for the same version — refusing it');
    if (lv) checkIndexMatchesManifest(listed, lv, env.manifest);
  }
  // Revocations by hash apply to every copy of the bytes, signed or not, from any catalog.
  const anywhere = revokedByHashAnywhere(env.sha256);
  if (anywhere) throw new CatalogError(`this template has been revoked by the ${anywhere.catalog.label} catalog${anywhere.r.reason ? `: ${anywhere.r.reason}` : ''}`, 409);
  if (!signer) {
    if (env.manifest.kind === 'html' && !allowUnverifiedCode) {
      throw new CatalogError('this is an UNSIGNED code template. Unsigned code templates are off on this server (Settings → Templates → "Allow unsigned code templates").', 403);
    }
  }
  checkInstallable(env);
  const existing = store.getInstalled(`${catalog}/${env.manifest.id}`);
  if (existing && existing.trust === 'verified' && trust === 'unverified') {
    throw new CatalogError('a verified copy of this template is installed; an unsigned file cannot replace it', 409);
  }
  return store.recordInstall({
    env, envelopeBytes: pkgLib.buildEnvelope(env.packageBytes, env.signature), catalog, trust,
    signer: signer ? signer.label : null, signerKeyId: signer ? signing.keyId(signer.key) : null, userId,
  });
}

async function importTemplateZip(buf, userId, opts) {
  const { readTemplateZip } = require('./zip');
  const { manifest, files } = await readTemplateZip(buf);
  let bytes;
  try { bytes = pkgLib.buildPackageBytes(manifest, files); } catch (e) { throw new CatalogError(e.message); }
  return importPackage(pkgLib.buildEnvelope(bytes, null), userId, opts);
}

/**
 * The air-gapped path: a zip of index.json + index.json.sig + packages/*. The index is verified
 * exactly as if it had been fetched; packages are kept (content-addressed) only when their hash
 * is one the verified index pins.
 */
async function importOfflineBundle(buf) {
  const files = await readZip(buf, {
    maxArchiveBytes: 256 * 1024 * 1024, maxEntries: 4000, maxFileBytes: pkgLib.MAX_ENVELOPE_BYTES * 2,
    maxTotalBytes: 300 * 1024 * 1024, stripWrapper: true,
    allow: (p) => p === 'index.json' || p === 'index.json.sig' || /^packages\/[a-z0-9.-]{1,120}\.sttemplate$/.test(p),
  });
  if (!files['index.json'] || !files['index.json.sig']) throw new CatalogError('the bundle has no signed index');
  let claimed;
  try { claimed = JSON.parse(files['index.json'].toString('utf8')).catalog; } catch { throw new CatalogError('the bundle index is not valid JSON'); }
  if (typeof claimed !== 'string' || !getCatalog(claimed)) throw new CatalogError(`the bundle is for an unknown catalog "${String(claimed).slice(0, 32)}" — add that catalog first`);
  const { index } = acceptIndex(claimed, files['index.json'], files['index.json.sig'].toString('utf8'));
  const pinned = new Map();
  for (const t of index.templates) for (const v of t.versions) pinned.set(v.url, v.sha256);
  let kept = 0;
  for (const [p, bytes] of Object.entries(files)) {
    if (!p.startsWith('packages/')) continue;
    const want = pinned.get(p);
    if (!want) continue;
    try {
      const env = pkgLib.parseEnvelope(bytes);
      if (env.sha256 !== want) continue;
      store.putPackageFile(env.sha256, bytes);
      kept++;
    } catch { /* not a valid package: ignore it, the index is what matters */ }
  }
  return { catalog: claimed, serial: index.serial, templates: index.templates.length, packages: kept };
}

/* ------------------------------------------------------------------ library view */

function library(userId) {
  const installed = store.listInstalled();
  const seen = new Map(db.prepare('SELECT template_key, version FROM template_seen WHERE user_id = ?').all(String(userId || '')).map((r) => [r.template_key, r.version]));
  const out = [];
  const now = Date.now();
  for (const c of listCatalogs()) {
    const index = c.enabled ? cachedIndex(c.id) : null;
    const entries = [];
    for (const t of (index ? index.templates : [])) {
      const key = `${c.id}/${t.id}`;
      const inst = installed.find((r) => r.id === key);
      const latest = t.versions.find((v) => !isRevoked(index, c.id, t.id, v.version, v.sha256)) || null;
      if (!latest) continue;
      entries.push({
        key, catalog: c.id, id: t.id, name: t.name, description: t.description, author: t.author, license: t.license,
        kind: t.kind, tags: t.tags, orientation: t.orientation, homepage: t.homepage,
        latest: latest.version, network: latest.network, min_server: latest.min_server,
        compatible: semverCmp(latest.min_server, serverVersion()) <= 0,
        installed: inst ? inst.version : null,
        update_available: !!(inst && semverCmp(latest.version, inst.version) > 0),
        is_new: !seen.has(key),
        is_updated: seen.has(key) && semverCmp(latest.version, seen.get(key)) > 0,
        package_cached: store.hasPackageFile(latest.sha256),
        // Local first (works offline, and needs nothing from the catalog host); otherwise the
        // catalog's own copy, https only — the dashboard CSP allows https: images.
        thumbnail: t.thumbnail && store.hasPackageFile(latest.sha256)
          ? `/api/templates/thumb/${latest.sha256}`
          : (t.thumbnail && c.url && c.url.startsWith('https://') ? (() => { try { return resolveUrl(c.url, t.thumbnail); } catch { return null; } })() : null),
      });
    }
    out.push({
      id: c.id, label: c.label, builtin: !!c.builtin, enabled: !!c.enabled, url: c.url,
      key_id: (() => { try { return signing.keyId(c.public_key); } catch { return null; } })(),
      serial: c.last_serial, expires: c.index_expires,
      stale: !!(c.index_expires && Date.parse(c.index_expires) < now),
      last_checked: c.last_checked, last_ok: c.last_ok, last_error: c.last_error,
      templates: entries,
    });
  }
  return { network_enabled: networkEnabled(), unsigned_code_allowed: unsignedCodeAllowed(), catalogs: out };
}

function markSeen(userId, keys) {
  const stmt = db.prepare('INSERT INTO template_seen (user_id, template_key, version) VALUES (?, ?, ?) ON CONFLICT(user_id, template_key) DO UPDATE SET version = excluded.version');
  let n = 0;
  for (const c of listCatalogs()) {
    const index = cachedIndex(c.id);
    for (const t of (index ? index.templates : [])) {
      const key = `${c.id}/${t.id}`;
      if (keys && !keys.includes(key)) continue;
      stmt.run(String(userId), key, t.versions[0].version);
      n++;
    }
  }
  return n;
}

module.exports = {
  OFFICIAL_ID, CatalogError, SETTING_ENABLED, SETTING_UNSIGNED_CODE,
  networkEnabled, unsignedCodeAllowed, semverCmp, serverVersion,
  ensureOfficial, listCatalogs, getCatalog, trustedKeys, addCatalog, setCatalogEnabled, removeCatalog,
  validateIndex, acceptIndex, cachedIndex, isRevoked, applyRevocations, resolveUrl,
  setFetcher, refreshCatalog, refreshAll, startPoller, stopPoller,
  installFromCatalog, importPackage, importTemplateZip, importOfflineBundle,
  library, markSeen,
};
