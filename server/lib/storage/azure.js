'use strict';

const fs = require('fs');
const { classify, StorageError } = require('./errors');
const { agentsFor, vetRequestHost } = require('./endpoint-guard');

/*
 * Azure Blob. Credentials, one of:
 *   { connectionString }              — what the portal hands out; also carries the endpoint
 *   { accountName, accountKey }       — shared key
 *   { accountName, sasToken }         — an account/container SAS the operator minted
 *
 * Endpoint override (profile.endpoint) is the ACCOUNT url, for Azurite
 * (http://azurite:10000/devstoreaccount1) and sovereign clouds (https://<acct>.blob.core.usgovcloudapi.net).
 *
 * ⚠️ WHAT A SCREEN IS HANDED: a SERVICE SAS scoped to ONE blob, read-only, short-lived, signed with
 * the account key on this server. Never the key, never the operator's own SAS — that one may well
 * carry write or list rights over the whole container, and a screen URL ends up in proxy logs,
 * player debug logs and bug reports. With a SAS-only credential there is no key to sign a narrower
 * one, so presignGet returns null and screens are served through the origin proxy. (A user-
 * delegation SAS needs Entra ID credentials this layer does not hold; see docs/storage.md.)
 *
 * ⚠️ Every request carries the guarded agent (lib/storage/endpoint-guard.js) through a policy at
 * the front of the pipeline, so a connection string whose BlobEndpoint names a refused address is
 * refused at connect time — the connection string is operator input like any other URL.
 */

function sdk() {
  try { return require('@azure/storage-blob'); }
  catch (e) { throw new StorageError('unavailable', 'The storage SDK for this provider is not installed on this server.'); }
}

/** Parse the bits of a connection string we need ourselves (account name/key for signing). */
function parseConnectionString(cs) {
  const out = {};
  for (const part of String(cs || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function azClassify(e, profileId, key) {
  if (e && e.details && e.details.errorCode && !e.code) e.code = e.details.errorCode;
  if (e && e.code && /ContainerNotFound/.test(e.code)) e.name = 'ContainerNotFound';
  else if (e && e.code && /BlobNotFound/.test(e.code)) e.name = 'BlobNotFound';
  else if (e && e.code && /Authoriz|Authentic/.test(e.code)) e.name = e.code;
  return classify(e, { profileId, key });
}

class AzureBackend {
  constructor(profile) {
    this.profile = profile;
    this.provider = 'azure';
    this.container = profile.bucket;
    this.prefix = profile.prefix ? String(profile.prefix).replace(/\/+$/, '') : '';
    this._cc = null;
    const c = profile.credentials || {};
    const cs = c.connectionString ? parseConnectionString(c.connectionString) : {};
    this.accountName = c.accountName || cs.AccountName || null;
    this.accountKey = c.accountKey || cs.AccountKey || null;
    this.sasToken = (c.sasToken || cs.SharedAccessSignature || '').replace(/^\?/, '') || null;
    this.accountUrl = (profile.endpoint || cs.BlobEndpoint || (this.accountName ? `https://${this.accountName}.blob.core.windows.net` : '')).replace(/\/+$/, '');
  }

  /** The endpoint actually connected to; endpoint-guard vets it like any typed URL. */
  endpointUrl() { return this.accountUrl; }

  pipeline() {
    const az = sdk();
    const cred = this.accountKey && this.accountName ? new az.StorageSharedKeyCredential(this.accountName, this.accountKey) : new az.AnonymousCredential();
    const p = az.newPipeline(cred, { retryOptions: { maxTries: 2, tryTimeoutInMs: 30000 } });
    const { httpAgent, httpsAgent } = agentsFor({ allowPrivate: !!this.profile.allow_private });
    p.factories.unshift({
      create: (next) => ({
        sendRequest: (wr) => {
          try { vetRequestHost(new URL(wr.url).hostname, { allowPrivate: !!this.profile.allow_private }); }
          catch (e) { return Promise.reject(Object.assign(new Error('storage endpoint address refused'), { name: 'SsrfError' })); }
          wr.agent = /^http:/i.test(wr.url) ? httpAgent : httpsAgent;
          return next.sendRequest(wr);
        },
      }),
    });
    return p;
  }

  get containerClient() {
    if (!this._cc) {
      if (!this.accountUrl) throw new StorageError('auth', 'The storage credentials were rejected.', { profileId: this.profile.id });
      const az = sdk();
      const url = this.sasToken && !this.accountKey ? `${this.accountUrl}?${this.sasToken}` : this.accountUrl;
      this._cc = new az.BlobServiceClient(url, this.pipeline()).getContainerClient(this.container);
    }
    return this._cc;
  }

  full(key) { return this.prefix ? `${this.prefix}/${key}` : String(key); }
  strip(k) { return this.prefix && k.startsWith(this.prefix + '/') ? k.slice(this.prefix.length + 1) : k; }
  blob(key) { return this.containerClient.getBlockBlobClient(this.full(key)); }

  async put(key, body, opts = {}) {
    const headers = { blobHTTPHeaders: opts.contentType ? { blobContentType: opts.contentType } : undefined, metadata: opts.sha256 ? { sha256: opts.sha256 } : undefined };
    try {
      const out = Buffer.isBuffer(body)
        ? await this.blob(key).uploadData(body, headers)
        : await this.blob(key).uploadStream(body, 4 * 1024 * 1024, 4, headers);
      return { etag: out.etag ? String(out.etag).replace(/"/g, '') : null, size: opts.contentLength != null ? opts.contentLength : (Buffer.isBuffer(body) ? body.length : null) };
    } catch (e) { throw azClassify(e, this.profile.id, key); }
  }

  async putFile(key, filePath, opts = {}) {
    const size = fs.statSync(filePath).size;
    return this.put(key, fs.createReadStream(filePath), { ...opts, contentLength: size });
  }

  async getStream(key, { range } = {}) {
    try {
      let offset = 0, count;
      if (range) {
        if (range.start == null) {
          const h = await this.head(key);
          if (!h) throw new StorageError('not_found', 'The object does not exist.', { key });
          offset = Math.max(0, h.size - range.suffix);
        } else {
          offset = range.start;
          if (range.end != null) count = range.end - range.start + 1;
        }
      }
      const out = await this.blob(key).download(offset, count);
      let size = out.contentLength != null ? Number(out.contentLength) : null;
      let start = 0, end = size != null ? size - 1 : null, partial = false;
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(out.contentRange || '');
      if (m) { start = +m[1]; end = +m[2]; size = m[3] === '*' ? null : +m[3]; partial = true; }
      return { stream: out.readableStreamBody, size, start, end, partial, contentType: out.contentType || null, etag: out.etag ? String(out.etag).replace(/"/g, '') : null };
    } catch (e) { throw azClassify(e, this.profile.id, key); }
  }

  async head(key) {
    try {
      const p = await this.blob(key).getProperties();
      return { size: p.contentLength != null ? Number(p.contentLength) : null, etag: p.etag ? String(p.etag).replace(/"/g, '') : null, contentType: p.contentType || null, lastModified: p.lastModified || null };
    } catch (e) {
      const err = azClassify(e, this.profile.id, key);
      if (err.code === 'not_found') return null;
      throw err;
    }
  }

  async exists(key) { return (await this.head(key)) !== null; }

  async delete(key) {
    try { await this.blob(key).deleteIfExists(); return true; }
    catch (e) { throw azClassify(e, this.profile.id, key); }
  }

  async list(prefix = '', { cursor = null, limit = 200, delimiter = '/' } = {}) {
    try {
      const pages = delimiter
        ? this.containerClient.listBlobsByHierarchy(delimiter, { prefix: this.full(prefix || '') })
        : this.containerClient.listBlobsFlat({ prefix: this.full(prefix || '') });
      const it = pages.byPage({ maxPageSize: Math.min(200, Math.max(1, limit)), ...(cursor ? { continuationToken: cursor } : {}) });
      const { value: page } = await it.next();
      const seg = (page && page.segment) || {};
      return {
        items: (seg.blobItems || []).map((b) => ({ key: this.strip(b.name), size: Number((b.properties && b.properties.contentLength) || 0), lastModified: (b.properties && b.properties.lastModified) || null, etag: b.properties && b.properties.etag ? String(b.properties.etag).replace(/"/g, '') : null })),
        prefixes: (seg.blobPrefixes || []).map((p) => this.strip(p.name)),
        cursor: (page && page.continuationToken) || null,
      };
    } catch (e) { throw azClassify(e, this.profile.id, prefix); }
  }

  async copy(fromKey, toKey) {
    try {
      const src = this.blob(fromKey);
      const srcUrl = this.accountKey ? this._sasUrl(this.full(fromKey), 300, {}) : src.url;
      await this.blob(toKey).syncCopyFromURL(srcUrl);
      return { size: null };
    } catch (e) { throw azClassify(e, this.profile.id, toKey); }
  }

  async probe() {
    try {
      const it = this.containerClient.listBlobsFlat({ prefix: this.prefix ? this.prefix + '/' : undefined }).byPage({ maxPageSize: 1 });
      await it.next();
      return true;
    } catch (e) { throw azClassify(e, this.profile.id, '(probe)'); }
  }

  _sasUrl(fullKey, expiresSec, { contentType = null, filename = null, now = new Date(), base = null } = {}) {
    const az = sdk();
    const cred = new az.StorageSharedKeyCredential(this.accountName, this.accountKey);
    const qp = az.generateBlobSASQueryParameters({
      containerName: this.container,
      blobName: fullKey,
      permissions: az.BlobSASPermissions.parse('r'),
      startsOn: new Date(now.getTime() - 5 * 60 * 1000),   // clock skew between this server and Azure
      expiresOn: new Date(now.getTime() + expiresSec * 1000),
      protocol: /^https:/i.test(base || this.accountUrl) ? az.SASProtocol.Https : az.SASProtocol.HttpsAndHttp,
      ...(contentType ? { contentType } : {}),
      ...(filename ? { contentDisposition: `inline; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"` } : {}),
    }, cred).toString();
    const encKey = fullKey.split('/').map(encodeURIComponent).join('/');
    return `${(base || this.accountUrl).replace(/\/+$/, '')}/${encodeURIComponent(this.container)}/${encKey}?${qp}`;
  }

  presignGet(key, { expiresSec = 900, contentType = null, filename = null, now = new Date() } = {}) {
    if (!this.accountKey || !this.accountName) return null;
    let base;
    if (this.profile.public_endpoint) base = this.profile.public_endpoint;
    else if (!this.profile.endpoint && /\.blob\.core\.windows\.net$/i.test(new URL(this.accountUrl).hostname)) base = this.accountUrl;
    else return null;
    return this._sasUrl(this.full(key), expiresSec, { contentType, filename, now, base });
  }

  presignPut() { return null; }
}

module.exports = { AzureBackend, parseConnectionString };
