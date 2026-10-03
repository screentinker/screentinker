'use strict';

/*
 * The fonts a slide can be set in, bundled with the product.
 *
 * ⚠️ WHY BUNDLE ANYTHING AT ALL. Until now there was no font pipeline at any layer of ScreenTinker:
 * no @font-face anywhere, no font files, and lib/upload-sniff.js accepts only image, video and audio magic
 * bytes, so a font could not even be uploaded. The Content Designer offered "Impact" — a face that
 * exists on none of Android, Tizen or BrightSign — so the same slide rendered as something
 * different on every panel, and differently again on each. For a feature whose entire pitch is
 * "it looks designed", that is the defect most likely to make it feel cheap.
 *
 * ⚠️ WHY THESE FIVE, AND WHY OFL. Every family here is under the SIL Open Font License, which exists
 * precisely to permit bundling and redistribution — including inside a commercial product, and
 * including serving the file to a browser. That matters more than it sounds: when a slide plays,
 * THIS SERVER ships the font to every player, so we are a redistributor. A commercially-licensed
 * webfont would make that a licence question on every install, hosted or self-hosted. OFL makes it
 * a non-question.
 *
 *   OFL obligations we meet, and must keep meeting:
 *     - the licence travels with the fonts (server/fonts/OFL-<family>.txt, shipped in the tarball
 *       and in the BrightSign payload because both stage server/ wholesale)
 *     - Reserved Font Names are not used on modified versions, so these files are NOT subsetted,
 *       renamed or re-instanced. If subsetting is ever added, the output must be renamed.
 *     - the fonts are not sold on their own, which is not a thing this product does
 *
 * ⚠️ AND THE LICENCE GATE DOES NOT COVER THIS. scripts/license-check.js scans npm DEPENDENCIES; a
 * font file in server/fonts is invisible to it. Adding a family here is a licence decision a human
 * has to make, and the test suite asserts every family has its OFL.txt present as the closest
 * thing to a mechanical check.
 *
 * ⚠️ NOT SUBSETTED BY CHARACTER, only by script. latin AND latin-ext ship, because latin alone drops
 * the accented characters half of Europe writes its own place names in — a slide reading "Zurich"
 * for "Zürich" is worse than 30KB. Anything beyond that (Cyrillic, Greek, Vietnamese) is a language
 * pack decision, not a default, and is deliberately absent.
 */

const path = require('path');

/** Where the .woff2 and OFL.txt files live. Served by the /fonts mount in server.js. */
const FONT_DIR = path.join(__dirname, '..', 'fonts');

/*
 * Google's own subset definitions, copied verbatim from the css2 API rather than hand-written —
 * they are what the shipped files were cut against, so inventing our own would claim coverage the
 * bytes do not have. Identical across all five families, which is why they are constants.
 */
const RANGE_LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
  + 'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, '
  + 'U+FEFF, U+FFFD';
const RANGE_LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, '
  + 'U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, '
  + 'U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

/*
 * ⚠️ VARIABLE FONTS, ONE FILE PER FAMILY. A static set would be one file per weight — five families
 * at four weights is twenty requests and twenty cache entries on a player fetching over a site
 * link. One variable file covers the whole range, and `font-weight: 400 800` in the @font-face is
 * what tells the browser it may interpolate rather than synthesise a fake bold.
 *
 * The `weights` here are the axis bounds of the actual file. Getting them wrong is not cosmetic:
 * declare a range wider than the file has and the browser clamps silently, so a slide set in 900
 * renders at 800 and nothing says why.
 */
const FAMILIES = Object.freeze({
  inter: {
    css: 'Inter', label: 'Inter', role: 'Text',
    note: 'Neutral and highly legible at distance — the safe default for body copy.',
    weights: [400, 800], stack: 'sans-serif', file: 'inter', ofl: 'OFL-inter.txt',
  },
  archivo: {
    css: 'Archivo', label: 'Archivo', role: 'Display',
    note: 'A grotesque with presence. Made for headlines rather than paragraphs.',
    weights: [400, 800], stack: 'sans-serif', file: 'archivo', ofl: 'OFL-archivo.txt',
  },
  oswald: {
    css: 'Oswald', label: 'Oswald', role: 'Condensed',
    note: 'Narrow, so a long headline fits a wide screen without shrinking.',
    weights: [300, 700], stack: 'sans-serif', file: 'oswald', ofl: 'OFL-oswald.txt',
  },
  bitter: {
    css: 'Bitter', label: 'Bitter', role: 'Serif',
    note: 'A slab serif — warmer than the sans faces, still solid at size.',
    weights: [400, 800], stack: 'serif', file: 'bitter', ofl: 'OFL-bitter.txt',
  },
  'jetbrains-mono': {
    css: 'JetBrains Mono', label: 'JetBrains Mono', role: 'Monospace',
    note: 'Fixed width, so columns of numbers line up. Good for times and counts.',
    weights: [400, 700], stack: 'monospace', file: 'jetbrains-mono', ofl: 'OFL-jetbrains-mono.txt',
  },
});

/*
 * ⚠️ THE OLD GENERIC NAMES STILL RESOLVE, AND MUST.
 *
 * Slides authored before the fonts existed carry font: 'sans' | 'serif' | 'mono' | 'condensed'.
 * Those are real documents on real screens; dropping the names would silently reset every one of
 * them to the default. Each alias points at the family that best matches what the generic used to
 * produce, so an existing slide gets better rather than different.
 */
const ALIASES = Object.freeze({
  sans: 'inter',
  serif: 'bitter',
  mono: 'jetbrains-mono',
  condensed: 'oswald',
});

const DEFAULT_FAMILY = 'inter';

/** Resolve a stored font id (new name or legacy generic) to a family key, always successfully. */
function resolveFamily(id) {
  if (typeof id !== 'string') return DEFAULT_FAMILY;
  if (Object.prototype.hasOwnProperty.call(FAMILIES, id)) return id;
  if (Object.prototype.hasOwnProperty.call(ALIASES, id)) return ALIASES[id];
  return DEFAULT_FAMILY;
}

/** The CSS font-family value for a family key — the bundled face, then a generic that always exists. */
function fontStack(key) {
  const f = FAMILIES[resolveFamily(key)];
  return `'${f.css}', ${f.stack}`;
}

/**
 * @font-face rules for exactly the families a slide uses.
 *
 * ⚠️ ONLY THE ONES USED. Emitting all five would make every slide reference ten files; a browser
 * only downloads a face it actually needs, but a BrightSign parsing ten unicode-range blocks per
 * slide render is work for nothing, and it obscures what a slide actually depends on.
 *
 * ⚠️ font-display: swap, chosen against the alternatives. `block` hides the text for up to three
 * seconds — on a ten-second slide that is most of its life, and on a wall invisible text reads as a
 * broken screen. `optional` never swaps, which means the FIRST render of a slide silently uses the
 * fallback and a slide that plays once is simply wrong. `swap` shows the words immediately and
 * corrects them; because these files are same-origin and served immutable, the correction is
 * imperceptible after the first fetch.
 */
function fontFaceCss(familyKeys, opts = {}) {
  const base = opts.base || '/fonts';
  const seen = new Set();
  const out = [];
  for (const key of familyKeys || []) {
    const k = resolveFamily(key);
    if (seen.has(k)) continue;
    seen.add(k);
    const f = FAMILIES[k];
    for (const [suffix, range] of [['', RANGE_LATIN], ['-ext', RANGE_LATIN_EXT]]) {
      out.push(
        `@font-face{font-family:'${f.css}';font-style:normal;`
        + `font-weight:${f.weights[0]} ${f.weights[1]};font-display:swap;`
        + `src:url(${base}/${f.file}${suffix}.woff2) format('woff2');`
        + `unicode-range:${range}}`);
    }
  }
  return out.join('\n  ');
}

/*
 * ⚠️ HOW AN UPLOADED FONT IS NAMED IN A SLIDE. `u:<id>` — a namespace the bundled keys cannot enter,
 * so resolveFamily can tell them apart without a lookup, and a stored id can never silently become
 * a bundled family (or the reverse) if either set changes.
 */
const CUSTOM_PREFIX = 'u:';
const isCustom = (id) => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX);
const customId = (id) => (isCustom(id) ? id.slice(CUSTOM_PREFIX.length) : null);

/**
 * One @font-face for an uploaded font.
 *
 * ⚠️ NO unicode-range, deliberately. The bundled files are Google's own script subsets, declared
 * with the ranges they were cut against. An upload is whatever the operator had and its coverage is
 * unknown — claiming a range it does not have would make the browser SKIP the file for characters it
 * can actually render. Absent means "use it for anything", the only honest declaration available.
 *
 * ⚠️ font-weight:normal, one file. Declaring a variable range we have not read out of the font would
 * make the browser clamp or synthesise. The editor says the weight control does not apply to an
 * uploaded face rather than pretending it does.
 */
function customFace(font, opts = {}) {
  const base = opts.base || '/fonts/u';
  /*
   * ⚠️ hasOwnProperty, NOT `map[fmt] || default`. A mutation run exposed this: `constructor` and
   * `__proto__` are inherited keys, so the lookup returns the Object constructor — truthy, so the
   * `||` fallback never fires — and `function Object() { [native code] }` is interpolated straight
   * into the CSS rule. A character filter happened to mask it, which made the real defect invisible
   * and the sanitiser look like the guard. This is the guard.
   */
  const FORMAT_CSS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
  const fmt = String(font.format || 'woff2');
  const cssFormat = Object.prototype.hasOwnProperty.call(FORMAT_CSS, fmt) ? FORMAT_CSS[fmt] : 'woff2';
  return `@font-face{font-family:'${font.css_family}';font-style:normal;font-weight:normal;`
    + `font-display:swap;src:url(${base}/${encodeURIComponent(font.filepath)}) format('${cssFormat}')}`;
}

/**
 * What the editor offers, in the order it should offer it.
 *
 * ⚠️ Carries `file` and `stack` as well as the labels, so the editor can build the SAME @font-face
 * rules and the SAME font-family value the renderer emits. Deriving either of those on the client
 * (by guessing a generic from the name, say) is how a preview drifts from what plays.
 */
function catalogue() {
  return Object.entries(FAMILIES).map(([id, f]) => ({
    id, label: f.label, role: f.role, note: f.note,
    weights: f.weights, file: f.file, css: f.css, stack: f.stack,
  }));
}

module.exports = {
  FAMILIES, ALIASES, DEFAULT_FAMILY, FONT_DIR,
  CUSTOM_PREFIX, isCustom, customId, customFace,
  RANGE_LATIN, RANGE_LATIN_EXT,
  resolveFamily, fontStack, fontFaceCss, catalogue,
};
