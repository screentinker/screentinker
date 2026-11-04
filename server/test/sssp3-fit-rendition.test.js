'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sssp3-fit-source-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
const { vf } = require('../lib/sssp3-fit-rendition');

test('vf encodes contain as pad, cover as crop, fill as stretch', () => {
  assert.match(vf('contain', 1920, 1080), /force_original_aspect_ratio=decrease/);
  assert.match(vf('contain', 1920, 1080), /pad=1920:1080/);
  assert.match(vf('cover', 1920, 1080), /force_original_aspect_ratio=increase/);
  assert.match(vf('cover', 1920, 1080), /crop=1920:1080/);
  assert.match(vf('fill', 1920, 1080), /force_original_aspect_ratio=disable/);
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
