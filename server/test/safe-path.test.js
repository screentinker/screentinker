'use strict';

/*
 * lib/safe-path.resolveWithin and the places that now rely on it. Each assertion is about the
 * boundary: a `../`, an absolute path elsewhere, and a sibling that merely shares the root's prefix
 * are all refused, while the names the product actually produces (a multer `<uuid>.part`, a
 * `<sha256>.sttemplate`, a uuid content directory) still resolve exactly where they always did.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-safepath-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;
process.env.TEMPLATES_DIR = path.join(DATA_DIR, 'templates');

const { resolveWithin } = require('../lib/safe-path');
const config = require('../config');

before(() => { fs.mkdirSync(config.contentDir, { recursive: true }); });
after(() => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('resolveWithin: a plain name resolves inside root', () => {
  const root = path.join(DATA_DIR, 'r');
  assert.equal(resolveWithin(root, 'a.png'), path.join(root, 'a.png'));
  assert.equal(resolveWithin(root, 'sub', 'a.png'), path.join(root, 'sub', 'a.png'));
  // An absolute path that IS inside root is accepted as itself (multer hands over absolute paths).
  assert.equal(resolveWithin(root, path.join(root, 'x.part')), path.join(root, 'x.part'));
  // `..` that stays inside is fine; the result is normalised.
  assert.equal(resolveWithin(root, 'sub/../b.png'), path.join(root, 'b.png'));
});

test('resolveWithin: traversal, absolute paths elsewhere and prefix siblings are refused', () => {
  const root = path.join(DATA_DIR, 'r');
  assert.equal(resolveWithin(root, '../escape.png'), null);
  assert.equal(resolveWithin(root, 'sub/../../escape.png'), null);
  assert.equal(resolveWithin(root, '/etc/passwd'), null);
  assert.equal(resolveWithin(root, root + '-old', 'x.png'), null);   // shares the prefix, not the dir
  assert.equal(resolveWithin(root, '..'), null);
  // Root itself is never a valid target: an unlink/rmSync of the whole tree is only ever a bug.
  assert.equal(resolveWithin(root, ''), null);
  assert.equal(resolveWithin(root, '.'), null);
  assert.equal(resolveWithin('', 'a'), null);
});

test('finalizeUpload: a staged part in contentDir is renamed by its bytes', () => {
  const { finalizeUpload } = require('../lib/upload-sniff');
  const name = `${crypto.randomUUID()}.part`;
  const p = path.join(config.contentDir, name);
  // Minimal PNG signature + IHDR is enough for the sniffer.
  fs.writeFileSync(p, Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(32)]));
  const file = { path: p };
  const out = finalizeUpload(file);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.filepath, name.replace(/\.part$/, '.png'));
  assert.equal(out.abs, path.join(config.contentDir, out.filepath));
  assert.equal(file.path, out.abs);
  assert.ok(fs.existsSync(out.abs));
});

test('finalizeUpload: a file outside contentDir is refused and left untouched', () => {
  const { finalizeUpload, UnsupportedUploadError } = require('../lib/upload-sniff');
  const outside = path.join(DATA_DIR, 'outside.part');
  fs.writeFileSync(outside, Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.throws(() => finalizeUpload({ path: outside }), UnsupportedUploadError);
  assert.throws(() => finalizeUpload({ path: path.join(config.contentDir, '..', 'outside.part') }), UnsupportedUploadError);
  assert.ok(fs.existsSync(outside), 'a refused path is never unlinked or renamed');
});

test('templates/store.packagePath: sha256 only, always under packages/', () => {
  const store = require('../lib/templates/store');
  const sha = 'a'.repeat(64);
  assert.equal(store.packagePath(sha), path.join(store.packagesDir(), `${sha}.sttemplate`));
  assert.throws(() => store.packagePath('../../etc/passwd'), /bad sha256/);
  assert.throws(() => store.packagePath('/' + 'a'.repeat(64)), /bad sha256/);
});

test('revisions.retainContentFile: a malformed content id never names a directory', () => {
  const revisions = require('../lib/revisions');
  const live = path.join(config.contentDir, `${crypto.randomUUID()}.png`);
  fs.writeFileSync(live, 'x');
  const fakeDb = { prepare: () => ({ get: () => ({ n: 0 }) }) };
  for (const bad of ['../escape', '..', '/abs', 'a/b']) {
    assert.throws(() => revisions.retainContentFile(fakeDb, bad, path.basename(live), 'old'), /invalid content id/);
  }
  assert.ok(fs.existsSync(live), 'the live file stays put when the id is refused');
  assert.ok(!fs.existsSync(path.join(config.contentDir, 'escape')));

  // A real uuid still retains into .history/<id>/.
  const id = crypto.randomUUID();
  const rel = revisions.retainContentFile(fakeDb, id, path.basename(live), 'old');
  assert.equal(rel, path.join('.history', id, `old__${path.basename(live)}`));
  assert.ok(fs.existsSync(path.join(config.contentDir, rel)));
});
