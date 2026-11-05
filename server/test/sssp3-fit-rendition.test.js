'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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
