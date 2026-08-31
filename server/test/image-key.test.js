'use strict';

/*
 * The keyer, against SYNTHETIC bitmaps rather than fixtures.
 *
 * ⚠️ THAT IS THE POINT, not a convenience. A keyer's failure mode is at the EDGE — a pixel too
 * greedy and thin features dissolve, a pixel too shy and every object wears a halo of its backdrop.
 * A photograph cannot say where the true edge is, so a test against one can only assert that
 * something came out. A bitmap built here knows its own boundary to the pixel, so these can state
 * what should happen at it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const K = require('../lib/image-key');

/** A w*h RGBA bitmap in the shape jimp exposes. */
function bitmap(w, h, fill) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function rect(bm, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * bm.width + x) * 4;
      bm.data[i] = rgb[0]; bm.data[i + 1] = rgb[1]; bm.data[i + 2] = rgb[2];
    }
  }
}

const alphaAt = (bm, x, y) => bm.data[(y * bm.width + x) * 4 + 3];
const GREEN = [11, 195, 20];
const ORANGE = [237, 125, 26];

/* ============ finding the backdrop ============ */

test('the key is the median of the border, so a stray corner pixel cannot set it', () => {
  /*
   * THE FAILURE THIS PREVENTS. Every alpha value is derived from this one colour, so a sample taken
   * from a single noisy corner does not degrade the cut-out — it destroys it, removing either the
   * whole object or none of the backdrop.
   */
  const bm = bitmap(64, 64, GREEN);
  rect(bm, 0, 0, 3, 3, [255, 0, 255]);      // a magenta speck in the corner
  rect(bm, 0, 60, 4, 4, [0, 0, 0]);          // and a black one on another edge
  assert.deepEqual(K.sampleKey(bm), GREEN);
});

test('the spread of a flat backdrop is small; a gradient is not', () => {
  // The caller needs to know whether the generator actually produced a flat backdrop this time.
  const flat = bitmap(64, 64, GREEN);
  assert.ok(K.backdropSpread(flat, K.sampleKey(flat)) < 4, 'a flat backdrop should read as flat');

  const grad = bitmap(64, 64, GREEN);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      grad.data[i + 1] = Math.max(0, GREEN[1] - y * 2);   // fades down the frame
    }
  }
  assert.ok(K.backdropSpread(grad, K.sampleKey(grad)) > 40, 'a gradient must be reported as one');
});

/* ============ the edge, which is the whole job ============ */

test('the backdrop goes fully transparent and the object stays fully opaque', () => {
  const bm = bitmap(64, 64, GREEN);
  rect(bm, 20, 20, 24, 24, ORANGE);
  K.keyOut(bm, K.sampleKey(bm), {});
  assert.equal(alphaAt(bm, 2, 2), 0, 'backdrop must be gone');
  assert.equal(alphaAt(bm, 32, 32), 255, 'the middle of the object must be untouched');
  assert.equal(alphaAt(bm, 20, 20), 255, 'the object edge itself must survive');
});

test('⚠️ a one-pixel feature survives', () => {
  /*
   * Stems and leaf serrations come down to this. A keyer with any spatial blur, or a tolerance
   * tuned by eye on a big soft object, eats them — and the loss is invisible in a thumbnail.
   */
  const bm = bitmap(32, 32, GREEN);
  rect(bm, 16, 0, 1, 32, ORANGE);
  K.keyOut(bm, K.sampleKey(bm), {});
  for (let y = 0; y < 32; y++) assert.equal(alphaAt(bm, 16, y), 255, `the hairline broke at y=${y}`);
});

test('⚠️ a hole INSIDE the object is transparent, not filled', () => {
  // The curl of a pumpkin stem encloses a gap. A flood-fill from the border would leave it opaque,
  // and the object would carry a lump of backdrop around on every slide it appears on.
  const bm = bitmap(64, 64, GREEN);
  rect(bm, 10, 10, 44, 44, ORANGE);
  rect(bm, 28, 28, 8, 8, GREEN);
  K.keyOut(bm, K.sampleKey(bm), {});
  assert.equal(alphaAt(bm, 32, 32), 0, 'the enclosed hole must be transparent');
  assert.equal(alphaAt(bm, 12, 12), 255, 'and the body around it must not be');
});

test('the edge is feathered rather than a staircase', () => {
  // A colour part-way between object and backdrop should come out part-way transparent.
  const bm = bitmap(32, 32, GREEN);
  rect(bm, 10, 10, 12, 12, ORANGE);
  const mid = [Math.round((GREEN[0] + ORANGE[0]) / 2), Math.round((GREEN[1] + ORANGE[1]) / 2),
    Math.round((GREEN[2] + ORANGE[2]) / 2)];
  rect(bm, 9, 10, 1, 12, mid);
  K.keyOut(bm, K.sampleKey(bm), { tol: 70, soft: 90 });
  const a = alphaAt(bm, 9, 15);
  assert.ok(a > 0 && a < 255, `a blended pixel should be partly transparent, got ${a}`);
});

test('tolerance widens what counts as backdrop', () => {
  const near = [30, 180, 40];        // close to the key, but not it
  const mk = () => { const b = bitmap(32, 32, GREEN); rect(b, 8, 8, 16, 16, near); return b; };
  const tight = mk(); K.keyOut(tight, GREEN, { tol: 5, soft: 5 });
  const loose = mk(); K.keyOut(loose, GREEN, { tol: 90, soft: 10 });
  assert.equal(alphaAt(tight, 16, 16), 255, 'a tight key should keep it');
  assert.equal(alphaAt(loose, 16, 16), 0, 'a loose key should drop it');
});

/* ============ despill ============ */

test('⚠️ despill runs on OPAQUE edge pixels, not only translucent ones', () => {
  /*
   * THE BUG A SPIKE FOUND ON REAL LEAVES. The first version only touched pixels with fractional
   * alpha, and a faint green line survived along every serration — because the pixels just INSIDE
   * the object are fully opaque and still carry the backdrop's bounce light. Opaque is where a
   * fringe shows most, since nothing behind it dilutes the colour.
   */
  const bm = bitmap(32, 32, GREEN);
  rect(bm, 8, 8, 16, 16, ORANGE);
  /*
   * Far enough from the key to be FULLY opaque (distance ~156 against tol+soft=120) while still
   * green-dominant — which is precisely the population the first version missed. A closer colour
   * lands in the feather band and would test the easy case by accident.
   */
  rect(bm, 8, 8, 16, 1, [150, 210, 90]);
  K.keyOut(bm, K.sampleKey(bm), {});
  const i = (8 * 32 + 12) * 4;
  assert.equal(bm.data[i + 3], 255, 'this pixel is inside the object');
  assert.ok(bm.data[i + 1] <= Math.max(bm.data[i], bm.data[i + 2]),
    `green still dominates after despill: ${[bm.data[i], bm.data[i + 1], bm.data[i + 2]]}`);
});

test('despill leaves the interior alone', () => {
  // A genuinely green object on a green backdrop is a losing proposition, but a green DETAIL well
  // inside an orange object must not be desaturated just because the backdrop was green.
  const bm = bitmap(64, 64, GREEN);
  rect(bm, 8, 8, 48, 48, ORANGE);
  rect(bm, 28, 28, 8, 8, [40, 160, 50]);
  K.keyOut(bm, K.sampleKey(bm), {});
  const i = (32 * 64 + 32) * 4;
  assert.equal(bm.data[i + 1], 160, 'an interior green detail must be preserved');
});

test('a colourless backdrop has nothing to despill and is left alone', () => {
  // White and grey have no dominant channel; suppressing one would tint every edge.
  const bm = bitmap(32, 32, [255, 255, 255]);
  rect(bm, 8, 8, 16, 16, ORANGE);
  rect(bm, 8, 8, 16, 1, [250, 250, 250]);
  assert.doesNotThrow(() => K.keyOut(bm, K.sampleKey(bm), {}));
  assert.equal(alphaAt(bm, 2, 2), 0);
});

/* ============ bounds and refusal ============ */

test('bounds are the object, not the frame', () => {
  const bm = bitmap(64, 64, GREEN);
  rect(bm, 20, 12, 10, 30, ORANGE);
  K.keyOut(bm, K.sampleKey(bm), {});
  assert.deepEqual(K.contentBounds(bm), { x: 20, y: 12, w: 10, h: 30 });
});

test('⚠️ an image the key ate entirely reports null rather than an empty box', () => {
  /*
   * A real outcome: an object whose colour matches its backdrop. It has to reach the caller as a
   * refusal, or an empty PNG lands in somebody's content library and an invisible element lands on
   * their slide — both of which look like the feature working.
   */
  const bm = bitmap(32, 32, GREEN);
  K.keyOut(bm, K.sampleKey(bm), {});
  assert.equal(K.contentBounds(bm), null);
});

test('coverage reports the three populations and they sum to one', () => {
  const bm = bitmap(40, 40, GREEN);
  rect(bm, 10, 10, 20, 20, ORANGE);
  K.keyOut(bm, K.sampleKey(bm), {});
  const c = K.coverage(bm);
  assert.ok(Math.abs(c.opaque + c.feathered + c.clear - 1) < 1e-9);
  assert.ok(Math.abs(c.opaque - 0.25) < 0.02, `expected a quarter opaque, got ${c.opaque}`);
});

test('keying is idempotent — running it twice changes nothing', () => {
  // The route may retry around this; a second pass must not eat the edge it already feathered.
  const bm = bitmap(48, 48, GREEN);
  rect(bm, 12, 12, 24, 24, ORANGE);
  const k = K.sampleKey(bm);
  K.keyOut(bm, k, {});
  const first = Buffer.from(bm.data);
  K.keyOut(bm, k, {});
  assert.deepEqual(bm.data, first);
});
