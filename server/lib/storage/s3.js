'use strict';

const fs = require('fs');
const { classify, StorageError } = require('./errors');
const { agentsFor, vetRequestHost } = require('./endpoint-guard');
const { presignGetUrl, encodeKeyPath } = require('./sigv4');

/*
 * ONE S3 CLIENT FOR AWS AND EVERY S3-COMPATIBLE STORE. There is no MinIO client, no R2 client, no
 * B2 client — each of those is this one with an endpoint, and every special case written for one
 * of them is a special case the others silently lack.
 *
 * What makes the compatible stores work, all of it load-bearing:
 *
 *   ⚠️ requestChecksumCalculation / responseChecksumValidation = 'WHEN_REQUIRED'. AWS SDK v3
 *      (since 3.729) defaults both to WHEN_SUPPORTED and sends x-amz-checksum-crc32 / trailer
 *      checksums on every PUT. MinIO (older), R2, Spaces and B2 answer those with 400/501 — the
 *      upload "fails for no reason" on exactly the stores people self-host. Set on EVERY client;
 *      test/storage-s3.test.js asserts it.
 *   ⚠️ A custom endpoint means path-style (bucket in the path) unless the operator says otherwise.
 *      Virtual-hosted style needs wildcard DNS for <bucket>.<endpoint>, which a compose network and
 *      most LAN installs do not have. AWS with no endpoint stays virtual-hosted.
 *   ⚠️ Region is required by the SDK even when the store ignores it: us-east-1 by default, `auto`
 *      for an R2 endpoint.
 *   ⚠️ No Object Lock, no multipart checksums, no Transfer Acceleration. A single PUT with a known
 *      Content-Length; the largest object this product stores is MAX_FILE_SIZE (500 MB default),
 *      far inside S3's 5 GB single-PUT ceiling.
 *
 * The SDK is required lazily: an instance that never configures S3 never loads it.
 */

function sdk() {
  try { return require('@aws-sdk/client-s3'); }
  catch (e) { throw new StorageError('unavailable', 'The storage SDK for this provider is not installed on this server.'); }
}

const isR2 = (endpoint) => /\.r2\.cloudflarestorage\.com$/i.test(hostOf(endpoint) || '');
function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return null; } }

function defaultRegion(profile) {
  if (profile.region) return profile.region;
  return isR2(profile.endpoint) ? 'auto' : 'us-east-1';
}

/** forcePathStyle: explicit setting wins; otherwise true exactly when there is a custom endpoint. */
function pathStyle(profile) {
  if (profile.force_path_style === 0 || profile.force_path_style === false) return false;
  if (profile.force_path_style === 1 || profile.force_path_style === true) return true;
  return !!profile.endpoint;
}

/** The client configuration. Exported so the tests can assert it without touching the network. */
function buildS3ClientConfig(profile) {
  const creds = profile.credentials || {};
  const agents = agentsFor({ allowPrivate: !!profile.allow_private });
  const cfg = {
    region: defaultRegion(profile),
    credentials: {
      accessKeyId: creds.accessKeyId || '',
      secretAccessKey: creds.secretAccessKey || '',
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
    forcePathStyle: pathStyle(profile),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
    requestHandler: { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent, connectionTimeout: 5000, requestTimeout: 30000 },
  };
  if (profile.endpoint) cfg.endpoint = String(profile.endpoint).replace(/\/+$/, '');
  return cfg;
}

class S3Backend {
  constructor(profile, { clientFactory } = {}) {
    this.profile = profile;
    this.provider = 's3';
    this.bucket = profile.bucket;
    this.prefix = profile.prefix ? String(profile.prefix).replace(/\/+$/, '') : '';
    this._clientFactory = clientFactory || ((cfg) => new (sdk().S3Client)(cfg));
    this._client = null;
  }

  get client() {
    if (!this._client) {
      this._client = this._clientFactory(buildS3ClientConfig(this.profile));
      // The literal-IP half of the SSRF guard (endpoint-guard.vetRequestHost): checked on the final
      // request, after the SDK has resolved bucket style and endpoint, before anything is sent.
      const allowPrivate = !!this.profile.allow_private;
      if (this._client.middlewareStack) {
        this._client.middlewareStack.add((next) => async (args) => {
          vetRequestHost(args.request && args.request.hostname, { allowPrivate });
          return next(args);
        }, { step: 'finalizeRequest', name: 'screentinkerEndpointGuard' });
      }
    }
    return this._client;
  }

  full(key) { return this.prefix ? `${this.prefix}/${key}` : String(key); }
  strip(fullKey) { return this.prefix && fullKey.startsWith(this.prefix + '/') ? fullKey.slice(this.prefix.length + 1) : fullKey; }

  async send(command, key) {
    try { return await this.client.send(command); }
    catch (e) { throw classify(e, { profileId: this.profile.id, key }); }
  }

  cmd(name, input) {
    const C = sdk()[name];
    return new C(input);
  }

  async put(key, body, opts = {}) {
    const input = { Bucket: this.bucket, Key: this.full(key), Body: body };
    if (opts.contentType) input.ContentType = opts.contentType;
    if (opts.contentLength != null) input.ContentLength = opts.contentLength;
    if (opts.sha256) input.Metadata = { sha256: opts.sha256 };
    const out = await this.send(this.cmd('PutObjectCommand', input), key);
    return { etag: out && out.ETag ? String(out.ETag).replace(/"/g, '') : null, size: opts.contentLength != null ? opts.contentLength : (Buffer.isBuffer(body) ? body.length : null) };
  }

  async putFile(key, filePath, opts = {}) {
    const size = fs.statSync(filePath).size;
    return this.put(key, fs.createReadStream(filePath), { ...opts, contentLength: size });
  }

  async getStream(key, { range } = {}) {
    const input = { Bucket: this.bucket, Key: this.full(key) };
    if (range) input.Range = range.start == null ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end == null ? '' : range.end}`;
    const out = await this.send(this.cmd('GetObjectCommand', input), key);
    let size = out.ContentLength != null ? Number(out.ContentLength) : null;
    let start = 0, end = size != null ? size - 1 : null, partial = false;
    const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(out.ContentRange || '');
    if (m) { start = +m[1]; end = +m[2]; size = m[3] === '*' ? null : +m[3]; partial = true; }
    return { stream: out.Body, size, start, end, partial, contentType: out.ContentType || null, etag: out.ETag ? String(out.ETag).replace(/"/g, '') : null };
  }

  async head(key) {
    try {
      const out = await this.client.send(this.cmd('HeadObjectCommand', { Bucket: this.bucket, Key: this.full(key) }));
      return { size: out.ContentLength != null ? Number(out.ContentLength) : null, etag: out.ETag ? String(out.ETag).replace(/"/g, '') : null, contentType: out.ContentType || null, lastModified: out.LastModified || null };
    } catch (e) {
      const err = classify(e, { profileId: this.profile.id, key });
      if (err.code === 'not_found') return null;
      throw err;
    }
  }

  async exists(key) { return (await this.head(key)) !== null; }

  async delete(key) {
    await this.send(this.cmd('DeleteObjectCommand', { Bucket: this.bucket, Key: this.full(key) }), key);
    return true;
  }

  async list(prefix = '', { cursor = null, limit = 200, delimiter = '/' } = {}) {
    const out = await this.send(this.cmd('ListObjectsV2Command', {
      Bucket: this.bucket, Prefix: this.full(prefix || '').replace(/^\/+/, ''), MaxKeys: Math.min(200, Math.max(1, limit)),
      ...(delimiter ? { Delimiter: delimiter } : {}), ...(cursor ? { ContinuationToken: cursor } : {}),
    }), prefix);
    return {
      items: (out.Contents || []).map((o) => ({ key: this.strip(o.Key), size: Number(o.Size || 0), lastModified: o.LastModified || null, etag: o.ETag ? String(o.ETag).replace(/"/g, '') : null })),
      prefixes: (out.CommonPrefixes || []).map((p) => this.strip(p.Prefix)),
      cursor: out.IsTruncated ? out.NextContinuationToken || null : null,
    };
  }

  /** Server-side within one bucket. */
  async copy(fromKey, toKey) {
    await this.send(this.cmd('CopyObjectCommand', {
      Bucket: this.bucket, Key: this.full(toKey), CopySource: `${this.bucket}/${encodeKeyPath(this.full(fromKey))}`,
    }), toKey);
    return { size: null };
  }

  /** Lightest call that proves credentials + bucket: list one key. */
  async probe() {
    await this.send(this.cmd('ListObjectsV2Command', { Bucket: this.bucket, MaxKeys: 1, ...(this.prefix ? { Prefix: this.prefix + '/' } : {}) }), '(probe)');
    return true;
  }

  /*
   * Where a SCREEN can fetch this object, or null when there is no such place.
   *
   * ⚠️ NEVER the internal endpoint. If the server talks to http://minio:9000, that name means
   * nothing to a TV on the shop LAN — presigning it would hand every screen a URL that fails, and
   * a player has no way to know it should try something else. So:
   *   public_base_url set  -> an UNSIGNED url under it (a CDN / custom domain on a public bucket)
   *   public_endpoint set  -> signed for that host (the same store, by a name screens resolve)
   *   no custom endpoint   -> AWS itself, which every internet-connected screen can reach
   *   otherwise            -> null: the caller serves it through the origin proxy instead
   */
  presignGet(key, { expiresSec = 900, contentType = null, filename = null, now = new Date() } = {}) {
    const p = this.profile;
    const fullKey = this.full(key);
    if (p.public_base_url) return `${String(p.public_base_url).replace(/\/+$/, '')}/${encodeKeyPath(fullKey)}`;
    const creds = p.credentials || {};
    if (!creds.accessKeyId || !creds.secretAccessKey) return null;
    let base;
    if (p.public_endpoint) base = new URL(p.public_endpoint);
    else if (!p.endpoint) base = null;
    else return null;
    const region = defaultRegion(p);
    let protocol, host, path;
    if (base) {
      protocol = base.protocol; host = base.host;
      const basePath = base.pathname.replace(/\/+$/, '');
      if (pathStyle({ ...p, endpoint: p.public_endpoint })) path = `${basePath}/${encodeKeyPath(this.bucket)}/${encodeKeyPath(fullKey)}`;
      else { host = `${this.bucket}.${host}`; path = `${basePath}/${encodeKeyPath(fullKey)}`; }
    } else {
      protocol = 'https:';
      const awsHost = `s3.${region}.amazonaws.com`;
      if (p.force_path_style === 1 || p.force_path_style === true || this.bucket.includes('.')) { host = awsHost; path = `/${encodeKeyPath(this.bucket)}/${encodeKeyPath(fullKey)}`; }
      else { host = `${this.bucket}.${awsHost}`; path = `/${encodeKeyPath(fullKey)}`; }
    }
    const query = { 'x-id': 'GetObject' };
    if (contentType) query['response-content-type'] = contentType;
    if (filename) query['response-content-disposition'] = `inline; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"`;
    return presignGetUrl({
      accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken,
      region, protocol, host, path, query, expiresSec, date: now,
    });
  }

  presignPut() { return null; }   // phase 2
}

module.exports = { S3Backend, buildS3ClientConfig, defaultRegion, pathStyle };
