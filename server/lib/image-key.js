'use strict';

/*
 * Cutting a generated object off its backdrop, in pure JavaScript.
 *
 * ⚠️ WHY KEYING AND NOT SEGMENTATION. The obvious reading of "put the pumpkin from that poster on a
 * slide" is: segment the object out of a finished image. That needs a model — SAM or similar —
 * which means onnxruntime, a native dependency and a ~100MB asset, on a project that deliberately
 * DROPPED sharp so that better-sqlite3 would be the last native dep, and that has to keep running
 * on a BrightSign. It is also worse at the job: an object composited onto a bokeh gradient has no
 * clean boundary to find, so the edges come back ragged around exactly the thin features — stems,
 * serrations — that a viewer looks at.
 *
 * So the pieces are GENERATED individually on a flat backdrop instead, and this file keys that
 * backdrop out. Measured against real Grok output: asked for a flat chroma backdrop it returned
 * one whose border pixels sit inside a couple of units of each other, which is a far easier and far
 * more reliable thing to remove than a segmentation boundary. Three leaves with serrated edges,
 * hairline stems and gaps between them cut out cleanly with 0.25% of pixels in the feathered band.
 *
 * Everything here is arithmetic on an RGBA bitmap, so it needs no decoder and no dependency of its
 * own — the caller supplies the bitmap. That also makes it testable against a synthetic image
 * rather than a fixture, which matters: a keyer that is wrong at the EDGES is the failure mode, and
 * a hand-built bitmap can state exactly where the edge is.
 */

/** Alpha at or below this counts as background when measuring or trimming. */
const CLEAR = 8;

/**
 * The backdrop colour, as the median of the border ring.
 *
 * ⚠️ THE MEDIAN OF A RING, NOT ONE CORNER. A single corner sample is one pixel of JPEG noise away
 * from being wrong, and the whole key is derived from it — a bad sample does not degrade the
 * result, it destroys it, taking either the entire object or none of the backdrop. The median of
 * the border is immune to a few stray pixels, and if the generator did put something in a corner
 * it is still the majority colour that wins.
 */
function sampleKey(bm, step = 8) {
  const px = [];
  const at = (x, y) => {
    const i = (y * bm.width + x) * 4;
    return [bm.data[i], bm.data[i + 1], bm.data[i + 2]];
  };
  for (let x = 0; x < bm.width; x += step) { px.push(at(x, 0)); px.push(at(x, bm.height - 1)); }
  for (let y = 0; y < bm.height; y += step) { px.push(at(0, y)); px.push(at(bm.width - 1, y)); }
  const med = (k) => {
    const v = px.map((p) => p[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return [med(0), med(1), med(2)];
}

/**
 * How uniform the backdrop actually is — the spread of the border ring around its median.
 *
 * ⚠️ THE CALLER NEEDS THIS TO KNOW WHETHER TO TRUST THE RESULT. A generator asked for a flat
 * backdrop usually gives one, but not always: ask twice and one reply may come back with a gradient
 * or a vignette. Keying that produces a cut-out with a torn edge or a ghost of the backdrop still
 * attached, and it LOOKS like a cut-out, so nothing downstream notices. A number here lets the
 * caller reject the image and ask again instead of laying a ruined object onto somebody's slide.
 */
function backdropSpread(bm, keyRgb, step = 8) {
  const [kr, kg, kb] = keyRgb;
  let worst = 0;
  const check = (x, y) => {
    const i = (y * bm.width + x) * 4;
    const d = Math.sqrt((bm.data[i] - kr) ** 2 + (bm.data[i + 1] - kg) ** 2 + (bm.data[i + 2] - kb) ** 2);
    if (d > worst) worst = d;
  };
  for (let x = 0; x < bm.width; x += step) { check(x, 0); check(x, bm.height - 1); }
  for (let y = 0; y < bm.height; y += step) { check(0, y); check(bm.width - 1, y); }
  return worst;
}

/**
 * Replace the backdrop with transparency, in place.
 *
 * tol     — distance from the key below which a pixel is entirely backdrop
 * soft    — width of the band above tol over which alpha ramps up, i.e. the feathered edge
 * despill — pull the backdrop's own hue out of edge pixels
 *
 * ⚠️ THE FEATHER IS THE POINT, NOT A REFINEMENT. A hard threshold gives every edge a one-pixel
 * staircase, and on a 4K panel showing a 2048px cut-out scaled up, that staircase is what the eye
 * lands on. The ramp costs nothing and is the difference between "a cut-out" and "a sticker".
 */
function keyOut(bm, keyRgb, opts = {}) {
  const tol = opts.tol == null ? 70 : opts.tol;
  const soft = opts.soft == null ? 50 : opts.soft;
  const despill = opts.despill !== false;
  const [kr, kg, kb] = keyRgb;
  // Which channel the backdrop leads on; only a dominant one can spill. A white or grey backdrop
  // has no dominant channel and nothing to suppress, which is why this can be null.
  const lead = (kr > kg && kr > kb) ? 0 : (kg > kr && kg > kb) ? 1 : (kb > kr && kb > kg) ? 2 : null;
  const d = bm.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i] - kr) ** 2 + (d[i + 1] - kg) ** 2 + (d[i + 2] - kb) ** 2);
    let a;
    if (dist <= tol) a = 0;
    else if (dist < tol + soft) a = Math.round(((dist - tol) / soft) * 255);
    else a = 255;
    d[i + 3] = a;
    /*
     * ⚠️ DESPILL RUNS ON THE WHOLE EDGE BAND, not only on partially transparent pixels.
     *
     * The first version only touched pixels with fractional alpha, and a spike against real
     * generated leaves showed a faint green line surviving along the serrations: the pixels just
     * INSIDE the object are fully opaque and still carry the backdrop's bounce light. Opaque is
     * exactly where a fringe is most visible, because nothing behind it dilutes the colour.
     */
    if (lead != null && a > 0 && dist < tol + soft * 3) {
      const other = lead === 0 ? Math.max(d[i + 1], d[i + 2])
        : lead === 1 ? Math.max(d[i], d[i + 2])
          : Math.max(d[i], d[i + 1]);
      if (d[i + lead] > other) d[i + lead] = other;
    }
  }
}

/**
 * The bounding box of what survived, or null if nothing did.
 *
 * ⚠️ NULL RATHER THAN AN EMPTY BOX, because "the key removed the entire image" is a real outcome —
 * an object whose colour happens to match its backdrop — and it must reach the caller as a refusal.
 * Returning a 0x0 crop instead would store an empty PNG in somebody's content library and lay an
 * invisible element on their slide.
 */
function contentBounds(bm) {
  let x0 = bm.width; let y0 = bm.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if (bm.data[(y * bm.width + x) * 4 + 3] > CLEAR) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** What fraction of the bitmap is opaque / feathered / clear — the caller's sanity check. */
function coverage(bm) {
  let opaque = 0; let feathered = 0; let clear = 0;
  for (let i = 3; i < bm.data.length; i += 4) {
    const a = bm.data[i];
    if (a <= CLEAR) clear++;
    else if (a === 255) opaque++;
    else feathered++;
  }
  const total = opaque + feathered + clear || 1;
  return {
    opaque: opaque / total,
    feathered: feathered / total,
    clear: clear / total,
  };
}

module.exports = { sampleKey, backdropSpread, keyOut, contentBounds, coverage, CLEAR };
