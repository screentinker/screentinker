'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { StorageError, StorageRefusedError } = require('./errors');

/*
 * The local backend: config.contentDir, byte-for-byte what this product has always done.
 *
 * ⚠️ A KEY HERE IS A BASENAME, NOT AN st/... PATH. Every existing row names its file by basename
 * under contentDir, every player builds /uploads/content/<basename>, and a downgrade to a release
 * without this layer must still find the files — so local writes stay flat. A key with a slash is
 * reduced to its basename (the remote scheme's st/<org>/<ws>/<sha>.mp4 lands as <sha>.mp4) and a
 * name that could escape the directory or hide in it (`..`, a leading dot) is refused outright.
 *
 * presignGet is null by definition: local bytes are served by /uploads/content and
 * /api/content/:id/file, exactly as before.
 */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

class LocalBackend {
  constructor({ dir }) {
    this.dir = dir;
    this.provider = 'local';
  }

  resolve(key) {
    const base = path.basename(String(key || ''));
    if (!SAFE_NAME.test(base) || base.includes('..')) throw new StorageRefusedError('Refusing an unsafe local file name.', { key: base });
    const abs = path.resolve(this.dir, base);
    if (path.dirname(abs) !== path.resolve(this.dir)) throw new StorageRefusedError('Refusing a path outside the content directory.', { key: base });
    return abs;
  }

  async put(key, body, opts = {}) {
    const dest = this.resolve(key);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.st-put-${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      if (Buffer.isBuffer(body)) fs.writeFileSync(tmp, body);
      else await pipeline(body, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
      throw new StorageError('unknown', 'The file could not be written to local storage.', { sdkCode: e.code, key });
    }
    const size = fs.statSync(dest).size;
    return { etag: opts.sha256 || null, size };
  }

  /** `move: true` renames instead of copying — the ingest path, where the source is ours to consume. */
  async putFile(key, filePath, opts = {}) {
    const dest = this.resolve(key);
    if (path.resolve(filePath) === dest) return { etag: opts.sha256 || null, size: fs.statSync(dest).size };
    fs.mkdirSync(this.dir, { recursive: true });
    if (opts.move) {
      try { fs.renameSync(filePath, dest); return { etag: opts.sha256 || null, size: fs.statSync(dest).size }; }
      catch (e) { if (e.code !== 'EXDEV') throw new StorageError('unknown', 'The file could not be moved into local storage.', { sdkCode: e.code, key }); }
    }
    return this.put(key, fs.createReadStream(filePath), opts);
  }

  async getStream(key, { range } = {}) {
    const abs = this.resolve(key);
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new StorageError('not_found', 'The object does not exist.', { key }); }
    const size = st.size;
    let start = 0, end = size - 1, partial = false;
    if (range) {
      start = range.start == null ? Math.max(0, size - range.suffix) : range.start;
      end = range.end == null || range.end >= size ? size - 1 : range.end;
      partial = true;
    }
    return { stream: fs.createReadStream(abs, { start, end }), size, start, end, partial, contentType: null, etag: null };
  }

  async head(key) {
    try {
      const st = fs.statSync(this.resolve(key));
      return { size: st.size, etag: null, contentType: null, lastModified: st.mtime };
    } catch (e) {
      if (e instanceof StorageError) throw e;
      return null;
    }
  }

  async exists(key) { return (await this.head(key)) !== null; }

  /** Synchronous existence, for the read picker (which never awaits). */
  existsSync(key) {
    try { return fs.existsSync(this.resolve(key)); } catch (_) { return false; }
  }

  async delete(key) {
    try { fs.unlinkSync(this.resolve(key)); } catch (e) {
      if (e instanceof StorageError) throw e;
      if (e.code !== 'ENOENT') throw new StorageError('unknown', 'The local file could not be removed.', { sdkCode: e.code, key });
    }
    return true;
  }

  presignGet() { return null; }
  presignPut() { return null; }

  async list(prefix = '', { limit = 200 } = {}) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { names = []; }
    const items = names.filter((n) => !n.startsWith('.') && n.startsWith(prefix)).sort().slice(0, limit)
      .map((n) => { try { const st = fs.statSync(path.join(this.dir, n)); return st.isFile() ? { key: n, size: st.size, lastModified: st.mtime } : null; } catch (_) { return null; } })
      .filter(Boolean);
    return { items, prefixes: [], cursor: null };
  }

  async copy(fromKey, toKey) {
    const src = this.resolve(fromKey);
    const dest = this.resolve(toKey);
    if (src === dest) return { size: fs.statSync(dest).size };
    fs.copyFileSync(src, dest);
    return { size: fs.statSync(dest).size };
  }
}

module.exports = { LocalBackend, SAFE_NAME };
