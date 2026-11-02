'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseFitName, vf, ensureRendition } = require('../lib/sssp3-fit-rendition');

let ffmpegOk = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
catch { ffmpegOk = false; }

test('parseFitName accepts even contain/cover/fill names and rejects garbage', () => {
  assert.deepEqual(parseFitName('clip.contain-1920x1080.mp4'), {
    original: 'clip.mp4', sourceExt: '.mp4', fit: 'contain', width: 1920, height: 1080, ext: '.mp4', name: 'clip.contain-1920x1080.mp4',
  });
  assert.equal(parseFitName('clip.cover-640x360.jpg').fit, 'cover');
  assert.equal(parseFitName('photo.fill-1920x1080.png').original, 'photo.png');
  assert.equal(parseFitName('clip.mp4'), null);
  assert.equal(parseFitName('clip.contain-1921x1080.mp4'), null);
  assert.equal(parseFitName('clip.stretch-1920x1080.mp4'), null);
  assert.equal(parseFitName('../clip.contain-1920x1080.mp4').original, 'clip.mp4');
});

test('vf encodes contain as pad, cover as crop, fill as stretch', () => {
  assert.match(vf('contain', 1920, 1080), /force_original_aspect_ratio=decrease/);
  assert.match(vf('contain', 1920, 1080), /pad=1920:1080/);
  assert.match(vf('cover', 1920, 1080), /force_original_aspect_ratio=increase/);
  assert.match(vf('cover', 1920, 1080), /crop=1920:1080/);
  assert.match(vf('fill', 1920, 1080), /force_original_aspect_ratio=disable/);
  assert.match(vf('fill', 1920, 1080), /setsar=1/);
});

test('ensureRendition writes contain/cover/fill of a portrait probe', { skip: !ffmpegOk && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sssp3-fit-'));
  try {
    const src = path.join(dir, 'probe.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=576x704:d=0.4:r=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
    ], { stdio: 'ignore' });
    const contain = await ensureRendition(dir, 'probe.contain-640x360.mp4', { timeoutMs: 30000 });
    const cover = await ensureRendition(dir, 'probe.cover-640x360.mp4', { timeoutMs: 30000 });
    const fill = await ensureRendition(dir, 'probe.fill-640x360.mp4', { timeoutMs: 30000 });
    assert.ok(contain && fs.statSync(contain).size > 32);
    assert.ok(cover && fs.statSync(cover).size > 32);
    assert.ok(fill && fs.statSync(fill).size > 32);
    const again = await ensureRendition(dir, 'probe.contain-640x360.mp4');
    assert.equal(again, contain);
    assert.equal(await ensureRendition(dir, 'missing.contain-640x360.mp4'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('SVG fit rendition names preserve the SVG source and rasterize to PNG', () => {
  const spec = parseFitName('zone.svg.fill-960x540.png');
  assert.deepEqual(spec, { original: 'zone.svg', sourceExt: '.svg', fit: 'fill', width: 960, height: 540, ext: '.png', name: 'zone.svg.fill-960x540.png' });
});
