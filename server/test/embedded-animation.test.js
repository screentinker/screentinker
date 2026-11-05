'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GifWriter } = require('omggif');
const anim = require('../lib/embedded-animation');
const { fitImageOntoCanvas } = require('../lib/embedded-render');
const { cacheKey } = require('../lib/embedded-cache');

const LED = { width: 32, height: 8, rotation: 0, colorDepth: '24bit-rgb888', dither: 'none', outputFormat: 'raw' };
const LCD = { width: 48, height: 27, rotation: 0, colorDepth: '16bit-rgb565', dither: 'none', outputFormat: 'raw' };
const ASK = { 'x-st-animation': '1' };

/* A GIF of `frames` frames: blue background, one red pixel at (frame*4, 3). */
function movingDotGif({ w = 32, h = 8, frames = 8, delay = 10, loop = 0, dispose } = {}) {
  const buf = Buffer.alloc(64 * 1024);
  const gw = new GifWriter(buf, w, h, { loop, palette: [0x0000ff, 0xff0000] });
  for (let f = 0; f < frames; f++) {
    const px = new Array(w * h).fill(0);
    px[3 * w + ((f * 4) % w)] = 1;
    gw.addFrame(0, 0, w, h, px, { delay, disposal: dispose });
  }
  return buf.subarray(0, gw.end());
}

const build = (gif, profile = LED, headers = ASK) =>
  anim.buildAnimation(gif, profile, anim.animationCapability(headers, profile), { fitMode: 'cover' }, fitImageOntoCanvas);

test('only firmware that asks gets an animation, and only on raw RGB888/RGB565 profiles', () => {
  assert.equal(anim.animationCapability({}, LED), null, 'no header: old firmware keeps getting stills');
  assert.equal(anim.animationCapability({ 'x-st-animation': '0' }, LED), null);
  assert.ok(anim.animationCapability(ASK, LED));
  assert.ok(anim.animationCapability(ASK, LCD));
  assert.equal(anim.animationCapability(ASK, { colorDepth: '1bit', outputFormat: 'x-epd-packed' }), null, 'e-paper never animates');
  assert.equal(anim.animationCapability(ASK, { ...LED, outputFormat: 'png' }), null);
  assert.equal(anim.animationCapability(ASK, { ...LCD, mcuTranspose: true }), null);
});

test('the budget and fps headers are clamped', () => {
  const c = anim.animationCapability({ ...ASK, 'x-st-animation-budget': '999999999', 'x-st-animation-max-fps': '500' }, LED);
  assert.equal(c.budget, 4 * 1024 * 1024);
  assert.equal(c.maxFps, 60);
  const d = anim.animationCapability({ ...ASK, 'x-st-animation-budget': '5', 'x-st-animation-max-fps': 'x' }, LED);
  assert.equal(d.budget, 16 * 1024);
  assert.equal(d.maxFps, 30);
});

test('an 8-frame GIF becomes 8 frames: one whole, then just the changed box', async () => {
  const r = await build(movingDotGif());
  const d = anim.decode(r.buffer);
  assert.equal(d.format, anim.FORMAT_RGB888);
  assert.equal(d.width, 32);
  assert.equal(d.height, 8);
  assert.equal(d.frameCount, 8);
  assert.equal(d.loops, 0, 'NETSCAPE loop 0 = forever');
  assert.deepEqual(d.frames[0].rect, { x: 0, y: 0, w: 32, h: 8 });
  assert.equal(d.frames[0].data.length, 32 * 8 * 3);
  // frame 1 moves the dot from x=0 to x=4: the box spans both, on row 3 only
  assert.deepEqual(d.frames[1].rect, { x: 0, y: 3, w: 5, h: 1 });
  for (const f of d.frames) assert.equal(f.delay, 100);
});

test('pixel art at the matrix size lands 1:1 (no resample smear, no shifted pixels)', async () => {
  const d = anim.decode((await build(movingDotGif())).buffer);
  const px = (x, y) => [...d.frames[0].data.subarray((y * 32 + x) * 3, (y * 32 + x) * 3 + 3)];
  assert.deepEqual(px(0, 3), [255, 0, 0], 'the red dot is exactly at (0,3)');
  assert.deepEqual(px(1, 3), [0, 0, 255], 'its neighbour is untouched blue');
  assert.deepEqual(px(0, 0), [0, 0, 255]);
});

test('replaying the rectangles reproduces every source frame', async () => {
  const d = anim.decode((await build(movingDotGif())).buffer);
  const fb = Buffer.alloc(32 * 8 * 3);
  d.frames.forEach((f, i) => {
    for (let y = 0; y < f.rect.h; y++) {
      f.data.copy(fb, ((f.rect.y + y) * 32 + f.rect.x) * 3, y * f.rect.w * 3, (y + 1) * f.rect.w * 3);
    }
    const red = [];
    for (let p = 0; p < 32 * 8; p++) if (fb[p * 3] === 255) red.push(p);
    assert.deepEqual(red, [3 * 32 + i * 4], `frame ${i}: only the dot at x=${i * 4} is red`);
  });
});

test('a still GIF is not an animation (the caller serves the normal frame)', async () => {
  assert.equal(await build(movingDotGif({ frames: 1 })), null);
});

test('identical frames fold into the previous delay instead of being sent', async () => {
  const buf = Buffer.alloc(8192);
  const gw = new GifWriter(buf, 32, 8, { loop: 0, palette: [0x000000, 0xffffff] });
  const a = new Array(256).fill(0); const b = new Array(256).fill(0); b[0] = 1;
  for (const px of [a, a, a, b]) gw.addFrame(0, 0, 32, 8, px, { delay: 10 });
  const d = anim.decode((await build(buf.subarray(0, gw.end()))).buffer);
  assert.equal(d.frameCount, 2);
  assert.equal(d.frames[0].delay, 300);
});

test('GIF delays: 0/1 cs play as 100 ms like browsers; the fps cap and LED wire time are floors', async () => {
  assert.equal(anim.normaliseDelayMs(0, 0), 100);
  assert.equal(anim.normaliseDelayMs(1, 0), 100);
  assert.equal(anim.normaliseDelayMs(2, 0), 20);
  assert.equal(anim.normaliseDelayMs(2, 50), 50);
  // A 128x64 matrix (8192 LEDs at ~30 us each) cannot refresh faster than ~250 ms.
  const big = { ...LED, width: 128, height: 64 };
  const r = await anim.buildAnimation(movingDotGif({ w: 128, h: 64, delay: 2 }), big,
    anim.animationCapability({ ...ASK, 'x-st-animation-budget': '4194304' }, big), { fitMode: 'cover' }, fitImageOntoCanvas);
  for (const f of anim.decode(r.buffer).frames) assert.ok(f.delay >= 250, `delay ${f.delay}`);
});

test('over budget, frames are dropped and their time is kept', async () => {
  const gif = movingDotGif({ w: 48, h: 27, frames: 12, delay: 10 });
  const full = anim.decode((await build(gif, LCD, { ...ASK, 'x-st-animation-budget': '4194304' })).buffer);
  const tight = await build(gif, LCD, { ...ASK, 'x-st-animation-budget': String(16 * 1024) });
  assert.ok(tight.buffer.length <= 16 * 1024);
  const t = anim.decode(tight.buffer);
  const total = (x) => x.frames.reduce((n, f) => n + f.delay, 0);
  assert.ok(t.frameCount <= full.frameCount);
  assert.equal(total(t), total(full), 'same overall running time');
});

test('a budget smaller than one frame gives no animation', async () => {
  const lcd = { ...LCD, width: 480, height: 272 };
  const r = await anim.buildAnimation(movingDotGif({ w: 480, h: 272 }), lcd,
    anim.animationCapability({ ...ASK, 'x-st-animation-budget': '16384' }, lcd), { fitMode: 'cover' }, fitImageOntoCanvas);
  assert.equal(r, null);
});

test('RGB565 frames are 2 bytes per pixel, little-endian', async () => {
  const d = anim.decode((await build(movingDotGif({ w: 48, h: 27 }), LCD)).buffer);
  assert.equal(d.format, anim.FORMAT_RGB565);
  assert.equal(d.frames[0].data.length, 48 * 27 * 2);
  assert.equal(d.frames[0].data.readUInt16LE(0), 0x001f, 'pure blue in RGB565');
});

test('disposal 2 clears the previous frame instead of leaving a trail', () => {
  const buf = Buffer.alloc(8192);
  const gw = new GifWriter(buf, 4, 1, { loop: 0, palette: [0x000000, 0xff0000] });
  gw.addFrame(0, 0, 1, 1, [1], { delay: 10, disposal: 2, transparent: 0 });
  gw.addFrame(2, 0, 1, 1, [1], { delay: 10, disposal: 2, transparent: 0 });
  const g = anim.decodeGif(buf.subarray(0, gw.end()));
  assert.equal(g.frames[1].rgba[0 * 4 + 3], 0, 'pixel 0 cleared by disposal 2');
  assert.equal(g.frames[1].rgba[2 * 4], 255, 'pixel 2 drawn');
});

test('the STA1 container is self-consistent and rejects anything else', async () => {
  const r = await build(movingDotGif());
  assert.ok(anim.isAnimationBuffer(r.buffer));
  assert.equal(r.buffer.subarray(0, 4).toString('ascii'), 'STA1');
  assert.equal(r.buffer.readUInt8(4), 1);
  assert.equal(anim.isAnimationBuffer(Buffer.alloc(768)), false, 'a raw LED frame is not an animation');
  assert.throws(() => anim.decode(Buffer.from('nope')));
});

test('a still keeps its exact cache key; only a GIF to an animating device gets a new one', () => {
  const base = cacheKey('dev', 'item', 1, LED, {});
  assert.equal(cacheKey('dev', 'item', 1, LED, { animation: null }), base, 'no fleet-wide ETag change');
  const cap = anim.animationCapability(ASK, LED);
  assert.notEqual(cacheKey('dev', 'item', 1, LED, { animation: anim.capabilityKey(cap) }), base);
});

test('isGifSource recognises GIF content by type or name', () => {
  assert.ok(anim.isGifSource({ mime_type: 'image/gif' }));
  assert.ok(anim.isGifSource({ filepath: 'abc.GIF' }));
  assert.ok(anim.isGifSource({ remote_url: 'https://x.test/a.gif?v=2' }));
  assert.equal(anim.isGifSource({ mime_type: 'image/png', filepath: 'a.png' }), false);
  assert.equal(anim.isGifSource(null), false);
});
