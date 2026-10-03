'use strict';

/*
 * "OpenAI-compatible" is a spectrum, and `size` is where it breaks first.
 *
 * ⚠️ MEASURED AGAINST THE REAL xAI API, not imagined: a request carrying `size` came back
 *
 *     400 {"code":"400","error":"Argument not supported: size"}
 *
 * It rejects the ARGUMENT, not the value — the model decides its own dimensions — so every image
 * generation against Grok failed outright. One bounded retry without the offending argument turns
 * that into a working request, instead of each operator discovering it per provider.
 *
 * ⚠️ BOUNDED ON PURPOSE. One retry, only for a 400 that names `size` AND phrases it as
 * unsupported. A general "retry without whatever it complained about" would paper over real errors
 * — a bad prompt, a wrong model, an expired key — and turn a clear failure into a confusing one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateImage } = require('../lib/image-gen');

/** A 1x1 PNG is enough: nothing here decodes it, the transport is what is under test. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url, body });
    return handler(body, calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

test('THE BUG: an endpoint that refuses `size` still produces an image', async () => {
  const s = stubFetch((body) => {
    if ('size' in body) return jsonRes(400, { code: '400', error: 'Argument not supported: size' });
    return jsonRes(200, { data: [{ b64_json: PNG_B64 }] });
  });
  try {
    const out = await generateImage({
      provider: 'openai', baseUrl: 'https://api.x.ai/v1', apiKey: 'k',
      model: 'grok-imagine-image-2.0', prompt: 'autumn leaves', width: 1792, height: 1024,
    });
    assert.ok(String(out).startsWith('data:image/png;base64,'), 'should return an image');
    assert.equal(s.calls.length, 2, 'exactly one retry');
    assert.ok('size' in s.calls[0].body, 'the first attempt carries size');
    assert.ok(!('size' in s.calls[1].body), 'the retry drops it');
    /*
     * ⚠️ AND STATES THE SHAPE IN THE OTHER DIALECT. Dropping `size` alone got a picture but
     * surrendered its shape: a 16:9 request came back 832x1248 PORTRAIT from the real API, which
     * on a 16:9 slide crops to a middle band. xAI's equivalent is aspect_ratio + resolution.
     */
    assert.equal(s.calls[1].body.aspect_ratio, '16:9', 'the retry must ask for the shape it wanted');
    assert.equal(s.calls[1].body.resolution, '2k');
    assert.equal(s.calls[1].body.model, 'grok-imagine-image-2.0', 'the model must survive the retry');
    assert.equal(s.calls[1].body.prompt, 'autumn leaves');
  } finally { s.restore(); }
});

test('an endpoint that accepts size is not retried', async () => {
  const s = stubFetch(() => jsonRes(200, { data: [{ b64_json: PNG_B64 }] }));
  try {
    await generateImage({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', prompt: 'p' });
    assert.equal(s.calls.length, 1, 'a working request must not cost a second call');
    assert.ok('size' in s.calls[0].body);
  } finally { s.restore(); }
});

test('⚠️ a REAL error is not retried away', async () => {
  /*
   * The failure this guard exists for. Retrying on any 400 would hide a bad model, a rejected
   * prompt or a dead key behind a second identical failure, and the operator would see a generic
   * error instead of the endpoint's own words.
   */
  const s = stubFetch(() => jsonRes(400, { error: 'model `nope` does not exist' }));
  try {
    await assert.rejects(
      () => generateImage({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'nope', prompt: 'p' }),
      /does not exist/,
      'the endpoint\'s reason must reach the caller',
    );
    assert.equal(s.calls.length, 1, 'no retry for an unrelated 400');
  } finally { s.restore(); }
});

test('a 401 is not retried either', async () => {
  const s = stubFetch(() => jsonRes(401, { error: 'invalid api key' }));
  try {
    await assert.rejects(() => generateImage({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'bad', model: 'm', prompt: 'p' }), /401/);
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test('a url response is fetched and inlined', async () => {
  // Some endpoints ignore response_format and hand back a link instead of bytes.
  let n = 0;
  const original = global.fetch;
  global.fetch = async (url) => {
    n++;
    if (String(url).includes('/images/generations')) {
      return jsonRes(200, { data: [{ url: 'https://cdn.example/img.png' }] });
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(PNG_B64, 'base64') };
  };
  try {
    const out = await generateImage({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', prompt: 'p' });
    assert.ok(String(out).startsWith('data:image/png;base64,'));
    assert.equal(n, 2, 'one generate call plus one download');
  } finally { global.fetch = original; }
});

test('an empty response is an error, not an empty image', async () => {
  const s = stubFetch(() => jsonRes(200, { data: [] }));
  try {
    await assert.rejects(() => generateImage({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', prompt: 'p' }), /no image/i);
  } finally { s.restore(); }
});

/* ============ picking the nearest supported ratio ============ */

const { nearestAspect } = require('../lib/image-gen');

test('a slide stage maps to 16:9', () => {
  assert.equal(nearestAspect(1792, 1024), '16:9');
  assert.equal(nearestAspect(1920, 1080), '16:9');
});

test('portrait and square map to their own ratios, not a landscape one', () => {
  assert.equal(nearestAspect(1024, 1024), '1:1');
  assert.equal(nearestAspect(1080, 1920), '9:16');
  assert.equal(nearestAspect(768, 1024), '3:4');
});

test('⚠️ distance is measured in LOG space, so mirrored ratios are equally far', () => {
  /*
   * With linear distance, 2:1 (=2.0) and 1:2 (=0.5) sit at wildly different distances from 1:1,
   * so a tall request would drift toward square while a wide one would not. The asymmetry is
   * invisible until somebody's portrait poster comes back nearly square.
   */
  assert.equal(nearestAspect(2000, 1000), '2:1');
  assert.equal(nearestAspect(1000, 2000), '1:2');
});

test('an unusual ratio picks the closest supported one rather than failing', () => {
  assert.equal(nearestAspect(2100, 900), '21:9');
  assert.ok(nearestAspect(1234, 567));
});

test('junk dimensions still yield a valid ratio', () => {
  for (const [w, h] of [[0, 0], [undefined, undefined], [null, 100], [NaN, NaN]]) {
    const a = nearestAspect(w, h);
    assert.ok(typeof a === 'string' && a.includes(':'), `got ${a} for ${w}x${h}`);
  }
});
