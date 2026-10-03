'use strict';

/*
 * HTML bundles: an uploaded `.wgt` or `.zip` containing index.html and its assets, played as an
 * ordinary playlist item.
 *
 * ⚠️ THE SERVER READS THIS ARCHIVE AND NEVER EXTRACTS IT. Every function here works from the zip's
 * CENTRAL DIRECTORY, or streams one entry into memory. Nothing writes an attacker-named path to
 * disk, which removes the entire zip-slip class from the server — the archive is stored exactly as
 * uploaded, as an ordinary content row, and travels to players as opaque bytes.
 *
 * ⚠️ THE CENTRAL DIRECTORY IS A CLAIM, NOT A FACT. `uncompressedSize` is written by whoever built
 * the archive and need not match what inflating actually produces. So the caps below are a POLICY
 * FILTER ("we do not accept archives that claim to be bombs"), and anything that actually inflates
 * — the inliner, and every player — must count real bytes as they come out and stop at its own
 * ceiling. Treating these numbers as enforcement is the mistake this comment exists to prevent.
 *
 * Why unzipper rather than the hand-written reader in brightsign/server/bs-payload-install.js: that
 * one exists because it runs BEFORE node_modules exists and can have no dependencies, a constraint
 * that does not apply here. It also parses no `externalFileAttributes`, so a symlink entry is
 * invisible to it — and a symlink is one of the two ways out of an extraction root. Its RULES are
 * ported below; its code is not.
 */

const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

/*
 * ⚠️ A SYNTHETIC MIME, AND IT MUST MATCH NOTHING ELSE.
 *
 * `mime_type` is the routing key across this product — the ?type= buckets in routes/content.js, the
 * thumbnail backfill, the players' dispatch chains. A bundle must fall into none of the image/video
 * patterns by accident. `video/youtube` is the existing precedent for a synthetic mime marking a
 * content kind that is not really that media type.
 *
 * The `.wgt` flavour is NOT a second mime. Players switch on one string; which container it arrived
 * in is recorded in the bundle's own metadata, not in the type.
 */
const BUNDLE_MIME = 'application/vnd.screentinker.bundle+zip';

/* Caps. Deliberately conservative — an HTML bundle that needs more than this is a website. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;   // the .zip itself
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;    // claimed sum of uncompressed entries
const MAX_ENTRIES = 512;                      // cf. mesh MAX_MANIFEST_ENTRIES = 500
const MAX_RATIO_ARCHIVE = 100;                // whole-archive compression ratio
const MAX_RATIO_ENTRY = 200;                  // one entry; a file of whitespace is legitimately high
const MAX_PATH_LEN = 255;
const MAX_DEPTH = 16;
const MAX_CONFIG_BYTES = 64 * 1024;           // config.xml is a manifest, not a document

/* Compression methods Node's zlib (and every player's) can actually do. */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

class BundleError extends Error {
  constructor(msg) { super(msg); this.name = 'BundleError'; this.status = 400; }
}

/*
 * One entry name, or null when it must be refused.
 *
 * Both separators are normalised first: some Windows zippers write `img\logo.png`, which on Linux
 * is a single file literally called "img\logo.png" — so `index.html`'s `img/logo.png` 404s, and the
 * bundle is subtly broken rather than refused. Refusing the traversal AFTER normalising is the only
 * order that is correct; checking the raw name lets `..\..\x` through.
 */
function normalizeEntryPath(name) {
  if (typeof name !== 'string' || !name) return null;
  const slashed = name.replace(/\\/g, '/');
  if (slashed.length > MAX_PATH_LEN) return null;
  if (slashed.startsWith('/')) return null;              // absolute
  if (/^[A-Za-z]:/.test(slashed)) return null;           // drive letter
  if (slashed.startsWith('//')) return null;             // UNC
  const parts = slashed.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) return null;
  if (parts.length > MAX_DEPTH) return null;
  if (parts.some((p) => p === '..')) return null;        // zip slip
  return parts.join('/');
}

/* A symlink entry. The unix mode lives in the HIGH 16 bits of externalFileAttributes; S_IFLNK is
 * 0xA000. A name-only check cannot see this, which is exactly how a symlink escapes an extractor
 * that only validates names. */
function isSymlink(entry) {
  const mode = (Number(entry.externalFileAttributes) || 0) >>> 16;
  return (mode & 0xF000) === 0xA000;
}

/*
 * The entry point, from a W3C widget's config.xml.
 *
 * ⚠️ A BOUNDED REGEX, NOT AN XML PARSER, AND THAT IS THE DECISION. This repo has no XML dependency
 * (lib/wgt-cache.js emits XML by string template), and adding one on the UPLOAD path brings XXE and
 * entity-expansion surface with it. A regex over a size-capped buffer cannot expand an entity
 * because it never resolves one. If a parser is ever added here, entity expansion must be off and
 * that must be said out loud in review.
 */
function entryPointFromConfigXml(buf) {
  const xml = buf.toString('utf8', 0, Math.min(buf.length, MAX_CONFIG_BYTES));
  const m = xml.match(/<content\b[^>]*\bsrc\s*=\s*["']([^"']{1,255})["']/i);
  return m ? m[1] : null;
}

/**
 * Validate an uploaded archive as an HTML bundle, reading only its central directory (plus
 * config.xml when present).
 *
 * Resolves to { entryPoint, flavour, entries, files, totalBytes } or throws BundleError.
 * `entryPoint` is a normalised path inside the archive; `flavour` is 'wgt' or 'zip'.
 */
async function validateBundle(archivePath) {
  let stat;
  try { stat = fs.statSync(archivePath); } catch (e) { throw new BundleError('Bundle file is unreadable'); }
  if (!stat.isFile() || stat.size === 0) throw new BundleError('Bundle file is empty');
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new BundleError(`Bundle archive is larger than ${Math.round(MAX_ARCHIVE_BYTES / 1048576)}MB`);
  }

  let directory;
  try {
    directory = await unzipper.Open.file(archivePath);
  } catch (e) {
    throw new BundleError('Not a readable zip archive');
  }

  const all = (directory.files || []);
  if (all.length > MAX_ENTRIES) throw new BundleError(`Bundle has more than ${MAX_ENTRIES} entries`);

  const names = new Map();   // normalised name -> entry
  let totalBytes = 0;
  let compressedBytes = 0;
  let fileCount = 0;

  for (const e of all) {
    if (e.type === 'Directory') continue;
    fileCount++;

    // ⚠️ A non-UTF8 name without the UTF-8 flag is REFUSED rather than guessed at. CP437 is the
    // other legal encoding, and decoding ambiguously is one of the ways a `..` gets in.
    if (!e.isUnicode && e.pathBuffer && e.pathBuffer.some((b) => b >= 0x80)) {
      throw new BundleError(`Bundle entry has a non-UTF8 name: ${JSON.stringify(String(e.path).slice(0, 60))}`);
    }
    const name = normalizeEntryPath(e.path);
    if (!name) throw new BundleError(`Bundle entry has an unsafe path: ${JSON.stringify(String(e.path).slice(0, 60))}`);
    if (isSymlink(e)) throw new BundleError(`Bundle contains a symlink: ${name}`);
    if (Number(e.flags) & 0x1) throw new BundleError(`Bundle entry is encrypted: ${name}`);
    if (e.compressionMethod !== METHOD_STORED && e.compressionMethod !== METHOD_DEFLATE) {
      throw new BundleError(`Bundle entry uses an unsupported compression method (${e.compressionMethod}): ${name}`);
    }
    // Last-write-wins on a duplicate name is how a second, hidden index.html gets past review.
    if (names.has(name)) throw new BundleError(`Bundle contains two entries named ${name}`);
    names.set(name, e);

    const un = Number(e.uncompressedSize) || 0;
    const co = Number(e.compressedSize) || 0;
    totalBytes += un;
    compressedBytes += co;
    if (co > 0 && un / co > MAX_RATIO_ENTRY) {
      throw new BundleError(`Bundle entry claims a ${Math.round(un / co)}:1 compression ratio: ${name}`);
    }
  }

  if (!fileCount) throw new BundleError('Bundle contains no files');
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new BundleError(`Bundle unpacks to more than ${Math.round(MAX_TOTAL_BYTES / 1048576)}MB`);
  }
  if (compressedBytes > 0 && totalBytes / compressedBytes > MAX_RATIO_ARCHIVE) {
    throw new BundleError(`Bundle claims a ${Math.round(totalBytes / compressedBytes)}:1 compression ratio`);
  }

  /*
   * Entry point: a real .wgt declares one, a plain zip is expected to have index.html at the root.
   * A declared src that is not in the archive is refused rather than fallen back on — a bundle
   * whose manifest points at a file it does not ship is broken, and saying so at upload is the
   * whole reason this validation runs here rather than on a wall.
   */
  let entryPoint = null;
  let flavour = 'zip';
  const config = names.get('config.xml');
  if (config) {
    flavour = 'wgt';
    if ((Number(config.uncompressedSize) || 0) > MAX_CONFIG_BYTES) {
      throw new BundleError('Bundle config.xml is implausibly large');
    }
    const declared = entryPointFromConfigXml(await config.buffer());
    if (declared) {
      const norm = normalizeEntryPath(declared);
      if (!norm) throw new BundleError(`config.xml declares an unsafe start file: ${declared}`);
      if (!names.has(norm)) throw new BundleError(`config.xml declares a start file the bundle does not contain: ${norm}`);
      entryPoint = norm;
    }
  }
  if (!entryPoint && names.has('index.html')) entryPoint = 'index.html';
  if (!entryPoint) {
    throw new BundleError('Bundle has no entry point — expected index.html at the root, or a config.xml declaring one');
  }

  return { entryPoint, flavour, entries: fileCount, files: [...names.keys()], totalBytes };
}

/** Read one entry out of an archive by its normalised name. Returns null when it is not there. */
async function readBundleEntry(archivePath, name) {
  const wanted = normalizeEntryPath(name);
  if (!wanted) return null;
  const directory = await unzipper.Open.file(archivePath);
  for (const e of (directory.files || [])) {
    if (e.type === 'Directory') continue;
    if (normalizeEntryPath(e.path) === wanted) return e.buffer();
  }
  return null;
}

module.exports = {
  BUNDLE_MIME, BundleError,
  validateBundle, readBundleEntry, normalizeEntryPath,
  MAX_ARCHIVE_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES, MAX_RATIO_ARCHIVE, MAX_RATIO_ENTRY,
};
