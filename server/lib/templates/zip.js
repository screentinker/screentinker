'use strict';

/*
 * The two places a zip reaches the templates code: an author's template folder zipped up (local,
 * unverified import) and the offline catalog bundle (air-gapped servers). Both are untrusted.
 *
 * ⚠️ CLAIMED SIZES ARE A CLAIM. The central directory says how big each entry inflates to, and a
 * hostile archive says "1 KB" and inflates to gigabytes. So the claims are used only to refuse
 * early, and the real bytes are COUNTED AS THEY INFLATE, with the stream destroyed the moment an
 * entry passes its cap — never `entry.buffer()`, which inflates the whole thing first and checks
 * afterwards.
 */

const unzipper = require('unzipper');

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; this.status = 400; }
}

function normalizeEntryPath(name) {
  if (typeof name !== 'string' || !name || name.length > 240) return null;
  const s = name.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.length > 6) return null;
  if (parts.some((p) => p === '..' || /[\u0000-\u001f]/.test(p))) return null;
  return parts.join('/');
}

function isSymlink(e) {
  return ((((Number(e.externalFileAttributes) || 0) >>> 16) & 0xF000) === 0xA000);
}

function inflateCapped(entry, cap, name) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const s = entry.stream();
    s.on('data', (c) => {
      n += c.length;
      if (n > cap) {
        s.destroy();
        reject(new ZipError(`zip entry "${name.slice(0, 80)}" inflates past ${cap} bytes`));
        return;
      }
      chunks.push(c);
    });
    s.on('error', () => reject(new ZipError(`zip entry "${name.slice(0, 80)}" is corrupt`)));
    s.on('end', () => resolve(Buffer.concat(chunks, n)));
  });
}

/**
 * Read an archive into { path: Buffer }.
 * opts: maxArchiveBytes, maxEntries, maxFileBytes, maxTotalBytes, stripWrapper (bool), allow(path) -> bool
 */
async function readZip(buf, opts) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('not a zip archive');
  if (buf.length > opts.maxArchiveBytes) throw new ZipError(`archive is larger than ${opts.maxArchiveBytes} bytes`);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new ZipError('not a zip archive');
  let dir;
  try { dir = await unzipper.Open.buffer(buf); } catch { throw new ZipError('not a readable zip archive'); }
  const all = (dir.files || []).filter((e) => e.type !== 'Directory');
  if (!all.length) throw new ZipError('archive is empty');
  if (all.length > opts.maxEntries) throw new ZipError(`archive has more than ${opts.maxEntries} entries`);

  const entries = [];
  const seen = new Set();
  let claimed = 0;
  for (const e of all) {
    if (!e.isUnicode && e.pathBuffer && e.pathBuffer.some((b) => b >= 0x80)) throw new ZipError('archive has a non-UTF-8 file name');
    const name = normalizeEntryPath(e.path);
    if (!name) throw new ZipError(`unsafe path in archive: ${JSON.stringify(String(e.path).slice(0, 60))}`);
    if (isSymlink(e)) throw new ZipError(`archive contains a symlink: ${name}`);
    if (Number(e.flags) & 0x1) throw new ZipError(`archive entry is encrypted: ${name}`);
    if (e.compressionMethod !== METHOD_STORED && e.compressionMethod !== METHOD_DEFLATE) throw new ZipError(`unsupported compression in ${name}`);
    if (seen.has(name.toLowerCase())) throw new ZipError(`archive contains two entries named ${name}`);
    seen.add(name.toLowerCase());
    const un = Number(e.uncompressedSize) || 0;
    if (un > opts.maxFileBytes) throw new ZipError(`${name} is larger than ${opts.maxFileBytes} bytes`);
    claimed += un;
    // Junk the OS adds when zipping a folder is dropped HERE, before the wrapper folder is worked
    // out — a Finder zip carries __MACOSX/ beside the real folder, which used to defeat the strip.
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(name) || name.split('/').some((p) => p.startsWith('.'))) continue;
    entries.push({ name, e, claimed: un });
  }
  if (claimed > opts.maxTotalBytes) throw new ZipError('archive unpacks larger than the cap');

  // One wrapper folder ("my-template/manifest.json") is what zipping a folder produces everywhere.
  let prefix = '';
  if (opts.stripWrapper) {
    const firsts = new Set(entries.map(({ name }) => name.split('/')[0]));
    if (firsts.size === 1 && entries.every(({ name }) => name.includes('/'))) prefix = [...firsts][0] + '/';
  }

  const out = {};
  let total = 0;
  for (const { name, e, claimed: un } of entries) {
    const rel = name.slice(prefix.length);
    if (opts.allow && !opts.allow(rel)) throw new ZipError(`unexpected file in archive: ${rel}`);
    // Capped at what the entry CLAIMED (and the per-file cap): an entry that inflates past its own
    // declared size is lying, and is stopped there rather than at the much larger per-file cap.
    const b = await inflateCapped(e, Math.min(opts.maxFileBytes, un), rel);
    total += b.length;
    if (total > opts.maxTotalBytes) throw new ZipError('archive unpacks larger than the cap');
    out[rel] = b;
  }
  return out;
}

/** An author's template as a zip: manifest.json plus the package files. */
async function readTemplateZip(buf) {
  const pkg = require('./package');
  const files = await readZip(buf, {
    // The per-type caps (inlined files vs binary assets) are package.js's to enforce; the zip only
    // has to be no bigger than the largest package could be.
    maxArchiveBytes: pkg.MAX_PACKAGE_BYTES + 512 * 1024,
    maxEntries: pkg.MAX_FILES + 1,
    maxFileBytes: pkg.MAX_ASSET_FILE_BYTES,
    maxTotalBytes: pkg.MAX_PACKAGE_BYTES + 64 * 1024,
    stripWrapper: true,
  });
  const mf = files['manifest.json'];
  if (!mf) throw new ZipError('the zip has no manifest.json');
  if (mf.length > 64 * 1024) throw new ZipError('manifest.json is too large');
  let manifest;
  try { manifest = JSON.parse(mf.toString('utf8')); } catch { throw new ZipError('manifest.json is not valid JSON'); }
  delete files['manifest.json'];
  return { manifest, files };
}

module.exports = { ZipError, readZip, readTemplateZip, normalizeEntryPath };
