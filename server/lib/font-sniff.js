'use strict';

/*
 * Deciding whether an uploaded file is a font, from its bytes.
 *
 * ⚠️ A SEPARATE SNIFFER FROM lib/upload-sniff.js, ON PURPOSE. That module decides what may be served
 * INLINE from the content mount, and its INLINE_SAFE_EXTS set is a security control: anything
 * outside it is forced to octet-stream + attachment so an uploaded file cannot be rendered as a
 * document. Adding font extensions there would have been the smaller diff and would have widened
 * that control to make a font work — the wrong trade. Fonts are not playable content, they are not
 * served from that mount, and they get their own rules here.
 *
 * ⚠️ WHAT THIS DOES NOT DO: validate the font's internal tables. The magic tells us the container
 * is what it claims; it does not tell us the glyf table is well-formed. A malformed font is
 * ultimately parsed by the PLAYER's font engine, and font parsers have a long CVE history.
 *
 * That is the same trust level as every other upload here — an image goes to a decoder with its own
 * history, and both require an authenticated workspace editor to get in. It is called out rather
 * than left implicit because a font reaches a wider set of parsers than an image does: every panel
 * OS in the estate rather than a browser. If that trade ever needs narrowing, the answer is to
 * restrict uploads to woff2 and re-pack server-side, not to add a partial table validator here.
 */

/*
 * ⚠️ ONLY FORMATS @font-face CAN ACTUALLY USE.
 *
 * TrueType Collections (`ttcf`) are deliberately absent: they are a valid font container and
 * @font-face cannot load one, so accepting them would store a file that silently never renders and
 * leave the operator to work out why.
 */
const FORMATS = Object.freeze({
  woff2: { ext: '.woff2', mime: 'font/woff2', css: 'woff2', label: 'WOFF2' },
  woff:  { ext: '.woff',  mime: 'font/woff',  css: 'woff',  label: 'WOFF'  },
  ttf:   { ext: '.ttf',   mime: 'font/ttf',   css: 'truetype', label: 'TrueType' },
  otf:   { ext: '.otf',   mime: 'font/otf',   css: 'opentype', label: 'OpenType' },
});

/*
 * ⚠️ 12 MB, and the number is about CJK rather than generosity. A Latin webfont is 20–100 KB; a
 * full CJK face is routinely 5–15 MB because it carries thousands of glyphs. Capping at something
 * Latin-shaped would refuse exactly the users with the least chance of finding an alternative.
 *
 * The cost lands on players: this file is fetched by every screen that renders a slide using it.
 * The editor is expected to say so when an upload is large, rather than the limit being the only
 * feedback anybody gets.
 */
const MAX_FONT_BYTES = 12 * 1024 * 1024;
const SNIFF_BYTES = 8;

class UnsupportedFontError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedFontError'; }
}

/**
 * Identify a font container from its leading bytes, or null.
 *
 * ⚠️ MAGIC ONLY — the filename is never consulted. An uploaded name is attacker-controlled and
 * carries no information about the bytes; `brand.woff2` containing a ZIP is exactly the case this
 * exists to refuse.
 */
function sniffFont(buf) {
  if (!buf || buf.length < 4) return null;
  const tag = buf.subarray(0, 4).toString('latin1');
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  // 0x00010000 is the TrueType/OpenType version tag; 'true' is the legacy Mac form.
  if (tag === 'true') return 'ttf';
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return 'ttf';
  /*
   * Named rather than lumped in with "not a font", because the difference is actionable: a
   * collection IS a font and the operator needs to know to extract one face from it, not to go
   * looking for a different file.
   */
  if (tag === 'ttcf') throw new UnsupportedFontError(
    'That is a TrueType Collection, which holds several fonts in one file. Browsers cannot load '
    + 'one directly — export a single face as .woff2, .ttf or .otf and upload that.');
  return null;
}

/**
 * Validate a buffer as an uploadable font. Throws UnsupportedFontError with a message meant for
 * an operator, never a stack trace.
 */
function validateFont(buf, declaredSize) {
  const size = declaredSize == null ? (buf ? buf.length : 0) : declaredSize;
  if (!size) throw new UnsupportedFontError('That file is empty.');
  if (size > MAX_FONT_BYTES) {
    throw new UnsupportedFontError(
      `That font is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is `
      + `${MAX_FONT_BYTES / 1024 / 1024} MB — every screen showing a slide in it downloads the whole `
      + 'file, so a smaller build (a .woff2, or a subset of the characters you need) is worth making.');
  }
  const format = sniffFont(buf);
  if (!format) {
    throw new UnsupportedFontError(
      'That does not look like a font file. Upload a .woff2, .woff, .ttf or .otf — '
      + 'the file is checked by its contents, not its name.');
  }
  return { format, ...FORMATS[format], size };
}

module.exports = { FORMATS, MAX_FONT_BYTES, SNIFF_BYTES, UnsupportedFontError, sniffFont, validateFont };
