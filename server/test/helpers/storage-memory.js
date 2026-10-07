'use strict';

/*
 * An in-memory storage backend with the StorageBackend contract, for tests. It records every call
 * so a test can assert what was (and, more often, what was NOT) done — "import by reference never
 * puts or deletes" is a statement about calls, not about end state.
 *
 * `down = true` makes every call fail the way an unreachable store does (code 'network'), which is
 * what feeds the breaker.
 */
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { StorageError } = require('../../lib/storage/errors');

class MemoryBackend {
  constructor({ id = 'mem', presignBase = null } = {}) {
    this.id = id;
    this.provider = 's3';
    this.objects = new Map();          // key -> { body: Buffer, contentType }
    this.calls = [];
    this.down = false;
    this.presignBase = presignBase;    // null = cannot presign (an internal endpoint)
  }

  _fail(op, key) {
    this.calls.push({ op, key, failed: true });
    throw new StorageError('network', 'The storage endpoint could not be reached.', { profileId: this.id, key, sdkCode: 'ECONNREFUSED' });
  }

  async put(key, body, opts = {}) {
    if (this.down) this._fail('put', key);
    const buf = Buffer.isBuffer(body) ? body : await new Promise((res, rej) => { const c = []; body.on('data', (d) => c.push(d)); body.on('end', () => res(Buffer.concat(c))); body.on('error', rej); });
    this.objects.set(key, { body: buf, contentType: opts.contentType || null });
    this.calls.push({ op: 'put', key, size: buf.length });
    return { etag: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length };
  }

  async putFile(key, filePath, opts) {
    return this.put(key, require('node:fs').readFileSync(filePath), opts);
  }

  async getStream(key, { range } = {}) {
    if (this.down) this._fail('get', key);
    this.calls.push({ op: 'get', key, range: range || null });
    const o = this.objects.get(key);
    if (!o) throw new StorageError('not_found', 'The object does not exist.', { profileId: this.id, key });
    const size = o.body.length;
    let start = 0, end = size - 1, partial = false;
    if (range) {
      start = range.start == null ? Math.max(0, size - range.suffix) : range.start;
      end = range.end == null || range.end >= size ? size - 1 : range.end;
      partial = true;
    }
    return { stream: Readable.from([o.body.subarray(start, end + 1)]), size, start, end, partial, contentType: o.contentType, etag: null };
  }

  async head(key) {
    if (this.down) this._fail('head', key);
    this.calls.push({ op: 'head', key });
    const o = this.objects.get(key);
    return o ? { size: o.body.length, etag: null, contentType: o.contentType, lastModified: null } : null;
  }

  async exists(key) { return (await this.head(key)) !== null; }

  async delete(key) {
    if (this.down) this._fail('delete', key);
    this.calls.push({ op: 'delete', key });
    this.objects.delete(key);
    return true;
  }

  async list(prefix = '', { limit = 200 } = {}) {
    if (this.down) this._fail('list', prefix);
    this.calls.push({ op: 'list', key: prefix, limit });
    const items = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)
      .map((k) => ({ key: k, size: this.objects.get(k).body.length, lastModified: null }));
    return { items, prefixes: [], cursor: null };
  }

  async copy(from, to) {
    const o = this.objects.get(from);
    this.calls.push({ op: 'copy', key: to });
    this.objects.set(to, { ...o });
    return { size: o.body.length };
  }

  async probe() { if (this.down) this._fail('probe', ''); return true; }

  presignGet(key, { expiresSec = 900, now = new Date() } = {}) {
    if (!this.presignBase) return null;
    return `${this.presignBase}/${key}?X-Amz-Expires=${expiresSec}&t=${Math.floor(now.getTime() / 1000)}`;
  }

  presignPut() { return null; }

  ops(op) { return this.calls.filter((c) => c.op === op && !c.failed); }
}

/** Install a factory mapping profile id -> MemoryBackend; returns the registry. */
function installMemoryBackends(storage, specs = {}) {
  const reg = new Map();
  storage._setBackendFactory((profile) => {
    if (!reg.has(profile.id)) reg.set(profile.id, new MemoryBackend({ id: profile.id, ...(specs[profile.id] || {}) }));
    return reg.get(profile.id);
  });
  return reg;
}

module.exports = { MemoryBackend, installMemoryBackends };
