'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error && !spawnSync('ffprobe', ['-version']).error;

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sssp3-fit-source-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
const { vf, canvasFor, ffmpegArgs } = require('../lib/sssp3-fit-rendition');

test('vf encodes contain as pad, cover as crop, fill as stretch', () => {
  assert.match(vf('contain', 1920, 1080), /force_original_aspect_ratio=decrease/);
  assert.match(vf('contain', 1920, 1080), /pad=1920:1080/);
  assert.match(vf('cover', 1920, 1080), /force_original_aspect_ratio=increase/);
  assert.match(vf('cover', 1920, 1080), /crop=1920:1080/);
  assert.match(vf('fill', 1920, 1080), /force_original_aspect_ratio=disable/);
});
test('portrait output swaps a landscape panel into its logical canvas', () => {
  assert.deepEqual(canvasFor({ screen_width: 1920, screen_height: 1080, orientation: 'portrait' }), { width: 1080, height: 1920 });
  assert.deepEqual(canvasFor({ screen_width: 1920, screen_height: 1080, orientation: 'landscape' }), { width: 1920, height: 1080 });
});

test('canvas scaling preserves aspect ratio under 4K safety limits', () => {
  const canvas = canvasFor({ screen_width: 3840, screen_height: 2160, orientation: 'landscape' });
  assert.deepEqual(canvas, { width: 1920, height: 1080 });
});
test('ffmpeg accepts only the expected local media container family', () => {
  const video = ffmpegArgs('/tmp/input.mp4', '/tmp/output.mp4', { source_file: 'input.mp4', output_ext: '.mp4', fit: 'contain', width: 640, height: 360 });
  const image = ffmpegArgs('/tmp/input.png', '/tmp/output.png', { source_file: 'input.png', output_ext: '.png', fit: 'contain', width: 640, height: 360 });
  assert.deepEqual(video.slice(video.indexOf('-f'), video.indexOf('-f') + 2), ['-f', 'mov']);
  assert.deepEqual(image.slice(image.indexOf('-f'), image.indexOf('-f') + 2), ['-f', 'image2']);
  assert.doesNotMatch(image.join(' '), /format=yuv420p/);
  assert.match(ffmpegArgs('/tmp/input.jpg', '/tmp/output.jpg', { source_file: 'input.jpg', output_ext: '.jpg', fit: 'contain', width: 640, height: 360 }).join(' '), /-q:v 2/);
});

test('a transparent WebP rendition retains an alpha-capable pixel format', { skip: !hasFfmpeg }, () => {
  // Run the actual generated command: checking an argument list alone cannot
  // prove that an encoder did not silently flatten alpha.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-webp-alpha-'));
  const source = path.join(dir, 'source.png');
  const output = path.join(dir, 'output.webp');
  try {
    // Construct pixels with both opaque and fully-transparent columns.  The
    // colour source's "@alpha" spelling is not sufficient here: some ffmpeg
    // versions emit an RGBA frame whose alpha plane is nevertheless opaque.
    let result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=4x4', '-vf', "format=rgba,geq=r='255':g='0':b='0':a='if(lt(X,2),255,0)'", '-frames:v', '1', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync('ffmpeg', ffmpegArgs(source, output, { source_file: 'source.png', output_ext: '.webp', fit: 'contain', width: 8, height: 8 }), { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'default=nw=1', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pix_fmt=yuva/, 'transparent WebP must not be encoded as opaque yuv420p');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('the public uploads mount cannot create renditions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.doesNotMatch(source, /sssp3-fit-rendition'\)\.tryServe/);
  assert.match(source, /app\.get\('\/api\/content\/:id\/sssp3-fit\/:renditionId'/);
  assert.match(source, /isReferencedForPlayers\(db, content\).*requesterCanAccessContent/);
  assert.match(source, /resolveReady\(content\.id, req\.params\.renditionId\)/);
});

test('payload approval is server-side and forecast payloads cannot queue work', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ws/deviceSocket.js'), 'utf8');
  assert.match(source, /sssp3-fit-rendition'\)\.stampItems\(assignments, layout, device, \{ lazy: !opts\.forecast \}\)/);
  const replacement = fs.readFileSync(path.join(__dirname, '../lib/content-replace.js'), 'utf8');
  assert.match(replacement, /sssp3-fit-rendition'\)\.removeFor\(content\.id\)/);
});
