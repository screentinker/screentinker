'use strict';

/*
 * Pure-JavaScript image operations — the two things the ingest path ever asked sharp for:
 * measure an image, and write a thumbnail.
 *
 * WHY NOT SHARP: sharp is a native module wrapping libvips. That costs us a prebuilt binary per
 * platform/ABI, and when there isn't one (or Node moves ABI) the failure is
 * ERR_DLOPEN_FAILED/NODE_MODULE_VERSION at require time — the same class of breakage
 * lib/preflight-deps.js exists to explain for better-sqlite3. Nothing in here is native, so the
 * server runs anywhere Node runs, including the embedded targets that have no toolchain.
 *
 * FORMAT COVERAGE vs the sharp it replaces:
 *   jpeg png gif tiff bmp   Jimp, natively
 *   webp avif               @jsquash/* — WebAssembly, bundled, no network (see wasmDecode below)
 *   svg                     never reaches here; callers thumbnail an SVG with itself
 *   heic                    unsupported — and it already was. sharp lists `heif`, but its
 *                           prebuilt libvips has AV1 only and refuses HEVC ("Unsupported
 *                           compression"), so .heic uploads have never produced a thumbnail.
 *
 * ORIENTATION (#170): Jimp applies EXIF orientation when it decodes and rewrites the tag to 1,
 * so what comes back is already DISPLAY dimensions — the rotation sharp needed an explicit
 * .rotate() for. metadata() therefore reports orientation 1 and lets imageDisplayDims() run as a
 * no-op rather than swapping W/H a second time. Report the tag honestly and that helper stays
 * correct for any future decoder that does NOT auto-orient.
 */

const path = require('path');
const fs = require('fs');
const { sniffMime } = require('./upload-sniff');

// Jimp is ESM-first but ships a CJS entry; require() is fine and keeps this file loadable from
// the CommonJS server. Deferred so a caller that never touches an image never pays for it.
let _jimp = null;
function jimp() {
  if (!_jimp) _jimp = require('jimp');
  return _jimp;
}

/*
 * @jsquash's decoders are browser-first: they locate their .wasm with
 * `fetch(new URL('...wasm', import.meta.url))`. Under Node that URL is a file:// one and Node's
 * fetch does not implement file://, so the bundled binary never loads and the only symptom is a
 * bare "fetch failed". The binary IS on disk in the package — read and compile it ourselves, then
 * hand the Module to init(). No network, at install time or after.
 */
const WASM_CODECS = {
  'image/webp': { pkg: '@jsquash/webp', wasm: '@jsquash/webp/codec/dec/webp_dec.wasm' },
  'image/avif': { pkg: '@jsquash/avif', wasm: '@jsquash/avif/codec/dec/avif_dec.wasm' },
};
const decoderCache = new Map();

async function wasmDecode(mime, buf) {
  const spec = WASM_CODECS[mime];
  if (!spec) return null;
  if (!decoderCache.has(mime)) {
    decoderCache.set(mime, (async () => {
      const mod = await import(`${spec.pkg}/decode.js`);
      await mod.init(await WebAssembly.compile(fs.readFileSync(require.resolve(spec.wasm))));
      return mod.default;
    })());
  }
  const decode = await decoderCache.get(mime);
  return decode(buf);   // -> ImageData-ish { data, width, height }
}

/*
 * Decode to a Jimp image whatever the format. Reuses sniffMime rather than carrying a second copy
 * of the magic-byte table — routes/media.js already duplicating it once is noted there as a smell.
 * Throws on anything undecodable, which is the contract callers already handle (a failure yields
 * null metadata and no thumbnail, never a lost upload).
 */
async function readImage(src) {
  const buf = await fs.promises.readFile(src);
  const mime = sniffMime(buf);

  if (WASM_CODECS[mime]) {
    const raw = await wasmDecode(mime, buf);
    if (!raw) throw new Error(`no decoder for ${mime}`);
    return jimp().Jimp.fromBitmap({ data: Buffer.from(raw.data), width: raw.width, height: raw.height });
  }
  return jimp().Jimp.read(buf);
}

/*
 * Display dimensions, shaped like the sharp metadata the callers already destructure.
 * orientation is 1 because the decode above already applied it — see ORIENTATION note at the top.
 */
async function metadata(src) {
  const img = await readImage(src);
  return { width: img.bitmap.width, height: img.bitmap.height, orientation: 1 };
}

/*
 * Write a JPEG thumbnail `width` px wide, aspect preserved — sharp's
 * .rotate().resize(width).jpeg({quality}).toFile(). Rotation is implicit in the decode.
 * Never upscales: sharp's resize() would enlarge a small source, but a thumbnail bigger than its
 * original is pure waste, and the callers only ever shrink.
 */
async function writeThumbnail(src, destPath, width, quality = 70) {
  const img = await readImage(src);
  if (img.bitmap.width > width) img.resize({ w: width });
  await fs.promises.writeFile(destPath, await img.getBuffer('image/jpeg', { quality }));
}

module.exports = { metadata, writeThumbnail, readImage };
