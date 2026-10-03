'use strict';

/*
 * Plugin-package inspection. A zip that arrives over the dashboard is untrusted
 * bytes. This module reads the central directory, refuses anything that is not
 * a plugin-shaped tree, and never extracts onto a require() path.
 *
 * ⚠️ THE LOADER NEVER SEES THE INBOX. `$DATA_DIR/plugin-inbox` is not a plugin
 * root (P2). Extraction into `$DATA_DIR/plugins/<id>` happens only in
 * submissions.approve, after a platform admin has accepted this exact sha256.
 *
 * Caps and the central-directory-is-a-claim warning are the same shape as
 * lib/html-bundle.js: claimed sizes are a policy filter, and anything that
 * actually inflates counts real bytes as they come out.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const { validateManifest } = require('./validate-manifest');
const { RESERVED_WIDGET_TYPES, RESERVED_DATA_SOURCE_TYPES } = require('./reserved');
const { isInside } = require('./paths');

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;
const MAX_DEPTH = 6;
const MAX_PATH_LEN = 180;
const MAX_RATIO_ARCHIVE = 100;
const MAX_RATIO_ENTRY = 200;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ALLOWED_EXT = new Set([
  '.js', '.json', '.md', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp',
  '.woff2', '.txt', '.map',
]);

const ROOT_ALLOW = new Set([
  'plugin.json',
  'index.js',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'LICENCE',
  'LICENCE.md',
  'COPYING',
  'CHANGELOG.md',
]);

class InboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxError';
    this.status = 400;
  }
}

function isSymlink(entry) {
  const mode = (Number(entry.externalFileAttributes) || 0) >>> 16;
  return (mode & 0xF000) === 0xA000;
}

function normalizeEntryPath(name) {
  if (typeof name !== 'string' || !name) return null;
  const slashed = name.replace(/\\/g, '/');
  if (slashed.length > MAX_PATH_LEN) return null;
  if (slashed.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;
  if (slashed.startsWith('//')) return null;
  const parts = slashed.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) return null;
  if (parts.length > MAX_DEPTH) return null;
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null;
  return parts.join('/');
}

function stripWrapper(names) {
  const firsts = new Set(names.map((n) => n.split('/')[0]));
  if (firsts.size !== 1) return { names, wrapper: null };
  const wrap = [...firsts][0];
  if (wrap === 'plugin.json' || wrap === 'public') return { names, wrapper: null };
  const stripped = names.map((n) => n.slice(wrap.length + 1)).filter(Boolean);
  if (!stripped.includes('plugin.json')) return { names, wrapper: null };
  return { names: stripped, wrapper: wrap };
}

function allowedFile(rel) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (parts[0] === 'node_modules' || parts[0] === '.git') return false;
  if (base === 'package.json' || base === 'package-lock.json') return false;
  if (parts[0] === 'public') {
    if (parts.length < 2) return false;
    const ext = path.extname(base).toLowerCase();
    return ALLOWED_EXT.has(ext);
  }
  if (parts.length !== 1) return false;
  if (ROOT_ALLOW.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  return ext === '.js' && /^[a-zA-Z0-9._-]{1,64}\.js$/.test(base);
}

/*
 * ⚠️ NEVER `entry.buffer()`. It inflates the whole entry and only then lets anyone look at the
 * size, so the caps above were checked against the CLAIMED sizes and the real bytes were counted
 * after they were already in memory. A 300 KB archive whose headers claimed 10 bytes grew the
 * process by ~600 MB before inspectZip refused it; at the 2 MB upload cap that is ~2 GB, from any
 * editor who can submit a plugin. Count as it inflates and stop at the cap.
 */
function inflateCapped(entry, cap, name) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const s = entry.stream();
    s.on('data', (c) => {
      n += c.length;
      if (n > cap) {
        s.destroy();
        reject(new InboxError(`Plugin file inflated past the per-file cap: ${name}`));
        return;
      }
      chunks.push(c);
    });
    s.on('error', () => reject(new InboxError(`Plugin entry is corrupt: ${name}`)));
    s.on('end', () => resolve(Buffer.concat(chunks, n)));
  });
}

function hashFile(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function hashTree(root) {
  const files = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + ent.name : ent.name;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, r);
      else files.push(r);
    }
  }
  walk(root, '');
  files.sort();
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\n');
  }
  return h.digest('hex');
}

async function inspectZip(archivePath) {
  let stat;
  try { stat = fs.statSync(archivePath); }
  catch { throw new InboxError('Plugin archive is unreadable'); }
  if (!stat.isFile() || stat.size === 0) throw new InboxError('Plugin archive is empty');
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new InboxError(`Plugin archive is larger than ${Math.round(MAX_ARCHIVE_BYTES / 1024)}KiB`);
  }
  const head = Buffer.alloc(4);
  const fd = fs.openSync(archivePath, 'r');
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new InboxError('Not a zip archive');

  let directory;
  try { directory = await unzipper.Open.file(archivePath); }
  catch { throw new InboxError('Not a readable zip archive'); }

  const all = directory.files || [];
  if (all.length > MAX_ENTRIES) throw new InboxError(`Plugin archive has more than ${MAX_ENTRIES} entries`);

  const rawNames = [];
  const byRaw = new Map();
  let claimedTotal = 0;
  let compressedBytes = 0;
  let fileCount = 0;

  for (const e of all) {
    if (e.type === 'Directory') continue;
    fileCount++;
    if (!e.isUnicode && e.pathBuffer && e.pathBuffer.some((b) => b >= 0x80)) {
      throw new InboxError(`Plugin entry has a non-UTF8 name: ${JSON.stringify(String(e.path).slice(0, 60))}`);
    }
    const name = normalizeEntryPath(e.path);
    if (!name) {
      throw new InboxError(`Plugin entry has an unsafe path: ${JSON.stringify(String(e.path).slice(0, 60))}`);
    }
    if (isSymlink(e)) throw new InboxError(`Plugin archive contains a symlink: ${name}`);
    if (Number(e.flags) & 0x1) throw new InboxError(`Plugin entry is encrypted: ${name}`);
    if (e.compressionMethod !== METHOD_STORED && e.compressionMethod !== METHOD_DEFLATE) {
      throw new InboxError(`Plugin entry uses an unsupported compression method: ${name}`);
    }
    if (byRaw.has(name)) throw new InboxError(`Plugin archive contains two entries named ${name}`);
    byRaw.set(name, e);
    rawNames.push(name);
    const un = Number(e.uncompressedSize) || 0;
    const co = Number(e.compressedSize) || 0;
    claimedTotal += un;
    compressedBytes += co;
    if (un > MAX_FILE_BYTES) throw new InboxError(`Plugin file is larger than ${MAX_FILE_BYTES} bytes: ${name}`);
    if (co > 0 && un / co > MAX_RATIO_ENTRY) {
      throw new InboxError(`Plugin entry claims a ${Math.round(un / co)}:1 compression ratio: ${name}`);
    }
  }

  if (!fileCount) throw new InboxError('Plugin archive contains no files');
  if (claimedTotal > MAX_TOTAL_BYTES) throw new InboxError('Plugin archive unpacks larger than the cap');
  if (compressedBytes > 0 && claimedTotal / compressedBytes > MAX_RATIO_ARCHIVE) {
    throw new InboxError('Plugin archive claims an implausible compression ratio');
  }

  const { names, wrapper } = stripWrapper(rawNames);
  const mapped = new Map();
  for (const raw of rawNames) {
    const rel = wrapper ? raw.slice(wrapper.length + 1) : raw;
    if (!rel) continue;
    mapped.set(rel, byRaw.get(raw));
  }

  for (const rel of mapped.keys()) {
    if (!allowedFile(rel)) {
      throw new InboxError(`Plugin archive contains a file that is not on the allowlist: ${rel}`);
    }
  }

  const manifestEntry = mapped.get('plugin.json');
  if (!manifestEntry) throw new InboxError('Plugin archive has no plugin.json');

  let rawManifest;
  try {
    const buf = await inflateCapped(manifestEntry, 32 * 1024, 'plugin.json');
    rawManifest = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e instanceof InboxError) throw e;
    throw new InboxError('plugin.json is not valid JSON');
  }

  const { manifest, error } = validateManifest(rawManifest, null);
  if (error) throw new InboxError(error);
  if (manifest.widget && RESERVED_WIDGET_TYPES.has(manifest.widget.type)) {
    throw new InboxError(`widget type "${manifest.widget.type}" is reserved`);
  }
  if (manifest.dataSource && RESERVED_DATA_SOURCE_TYPES.has(manifest.dataSource.type)) {
    throw new InboxError(`data-source type "${manifest.dataSource.type}" is reserved`);
  }

  const main = manifest.main || 'index.js';
  if (!mapped.has(main)) throw new InboxError(`plugin.json main "${main}" is not in the archive`);

  const files = [];
  let realTotal = 0;
  for (const [rel, entry] of mapped) {
    const buf = await inflateCapped(entry, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - realTotal), rel);
    realTotal += buf.length;
    if (realTotal > MAX_TOTAL_BYTES) throw new InboxError('Plugin archive unpacks larger than the cap');
    if (buf.length > MAX_FILE_BYTES) throw new InboxError(`Plugin file inflated past the per-file cap: ${rel}`);
    files.push({ name: rel, size: buf.length });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  return {
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    manifest,
    files,
    wrapper,
    sha256: hashFile(archivePath),
    archiveBytes: stat.size,
    uncompressedBytes: realTotal,
  };
}

async function extractZip(archivePath, destDir, inspected) {
  if (!inspected || !inspected.pluginId) throw new InboxError('extract requires a prior inspect');
  fs.mkdirSync(destDir, { recursive: true });
  const destReal = fs.realpathSync(destDir);

  const directory = await unzipper.Open.file(archivePath);
  const wanted = new Set((inspected.files || []).map((f) => f.name));
  const wrapper = inspected.wrapper || null;

  for (const e of (directory.files || [])) {
    if (e.type === 'Directory') continue;
    const raw = normalizeEntryPath(e.path);
    if (!raw) continue;
    const rel = wrapper ? (raw.startsWith(wrapper + '/') ? raw.slice(wrapper.length + 1) : raw) : raw;
    if (!wanted.has(rel)) continue;
    if (!allowedFile(rel)) throw new InboxError(`refusing to extract ${rel}`);
    const buf = await inflateCapped(e, MAX_FILE_BYTES, rel);
    const target = path.resolve(destDir, rel);
    if (!isInside(destReal, target)) {
      throw new InboxError(`extract escaped the destination: ${rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
}

module.exports = {
  InboxError,
  inspectZip,
  extractZip,
  hashFile,
  hashTree,
  normalizeEntryPath,
  allowedFile,
  MAX_ARCHIVE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ENTRIES,
};
