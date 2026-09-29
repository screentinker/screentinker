'use strict';

/*
 * lib/package-cache.js — the factory behind lib/deb-cache.js (Pi) and lib/win-cache.js (Windows).
 * Every directory here is a fresh temp dir: the in-repo fallback (<repo>/native/dist) is never read,
 * because each instance's env override points at an empty dir, so a developer's local build cannot
 * change a result.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(os.tmpdir(), 'st-pkgcache-' + crypto.randomBytes(4).toString('hex'));
const DATA_DIR = path.join(ROOT, 'data');
const PI_DIST = path.join(ROOT, 'pi-dist');
const WIN_DIST = path.join(ROOT, 'win-dist');
for (const d of [DATA_DIR, PI_DIST, WIN_DIST]) fs.mkdirSync(d, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.PI_DIST_DIR = PI_DIST;
process.env.WIN_DIST_DIR = WIN_DIST;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { createPackageCache, REPO_DIST } = require('../lib/package-cache');
const debCache = require('../lib/deb-cache');
const winCache = require('../lib/win-cache');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('the factory validates its regex and reads the env override at refresh time', () => {
  assert.throws(() => createPackageCache({ name: 'x', filenameRe: 'nope', envDirVar: 'X' }), TypeError);
  const c = createPackageCache({ name: 'x', filenameRe: /^x-(\d+\.\d+\.\d+)\.bin$/, envDirVar: 'ST_TEST_X_DIR', repoDir: '/nonexistent' });
  assert.deepEqual(c.candidateDirs(), [DATA_DIR, '/nonexistent']);
  process.env.ST_TEST_X_DIR = path.join(ROOT, 'x');
  try { assert.deepEqual(c.candidateDirs(), [DATA_DIR, path.join(ROOT, 'x')]); } finally { delete process.env.ST_TEST_X_DIR; }
  assert.ok(REPO_DIST.endsWith(path.join('native', 'dist')));
});

test('both instances are hermetic here — neither searches the real <repo>/native/dist', () => {
  assert.deepEqual(debCache.candidateDirs(), [DATA_DIR, PI_DIST]);
  assert.deepEqual(winCache.candidateDirs(), [DATA_DIR, WIN_DIST]);
  for (const c of [debCache, winCache]) assert.ok(!c.candidateDirs().includes(REPO_DIST));
});

test('the Windows installer regex: X.Y.Z and X.Y.Z~rcN / -rcN, nothing else', () => {
  const ok = { 'ScreenTinker-Setup-1.2.3.exe': '1.2.3', 'ScreenTinker-Setup-1.2.3~rc1.exe': '1.2.3~rc1', 'ScreenTinker-Setup-1.2.3-rc2.exe': '1.2.3-rc2' };
  for (const [n, v] of Object.entries(ok)) assert.equal(winCache.EXE_RE.exec(n)[1], v, n);
  for (const n of ['ScreenTinker-Setup-1.2.exe', 'screentinker-setup-1.2.3.exe', 'ScreenTinker-Setup-1.2.3.msi',
    'ScreenTinker-Setup-1.2.3.exe.part', 'ScreenTinker-Setup-v1.2.3.exe', 'screentinker-pi_1.2.3_all.deb']) {
    assert.equal(winCache.EXE_RE.exec(n), null, n);
  }
  // And the two instances do not see each other's packages.
  assert.equal(debCache.pickNewest(['ScreenTinker-Setup-9.9.9.exe']), null);
  assert.equal(winCache.pickNewest(['screentinker-pi_9.9.9_all.deb']), null);
});

test('win pickNewest: by version, and ⚠️ a release beats any prerelease', () => {
  assert.deepEqual(winCache.pickNewest(['ScreenTinker-Setup-1.9.0.exe', 'ScreenTinker-Setup-1.10.0.exe', 'ScreenTinker-Setup-1.2.3.exe']),
    { name: 'ScreenTinker-Setup-1.10.0.exe', version: '1.10.0' });
  assert.equal(winCache.pickNewest(['ScreenTinker-Setup-1.2.0.exe', 'ScreenTinker-Setup-1.3.0~rc1.exe']).version, '1.2.0');
  assert.deepEqual(winCache.pickNewest(['ScreenTinker-Setup-1.3.0~rc2.exe', 'ScreenTinker-Setup-1.3.0~rc10.exe']),
    { name: 'ScreenTinker-Setup-1.3.0~rc10.exe', version: '1.3.0-rc10' }, '`~` normalised to `-` for the comparison');
});

test('win-cache: DATA_DIR beats the override dir, hashes once, and never advertises a stale hash', async () => {
  const inDist = path.join(WIN_DIST, 'ScreenTinker-Setup-9.0.0.exe');
  fs.writeFileSync(inDist, Buffer.from('dist build'));
  winCache.refresh();
  let r = await winCache.ready();
  assert.equal(r.path, inDist, 'the override dir is searched when DATA_DIR has nothing');
  assert.equal(r.sha256, sha('dist build'));

  const f = path.join(DATA_DIR, 'ScreenTinker-Setup-3.0.0.exe');
  fs.writeFileSync(f, Buffer.from('first build'));
  winCache.refresh();
  r = await winCache.ready();
  assert.equal(r.path, f, 'an operator mount wins even over a NEWER version in the build dir');
  assert.equal(r.version, '3.0.0');
  assert.equal(r.filename, 'ScreenTinker-Setup-3.0.0.exe');
  assert.equal(r.sha256, sha('first build'));
  // Hash-once: an unchanged file refreshes straight to the cached hash, no pending state.
  assert.equal(winCache.refresh().sha256, sha('first build'));

  fs.writeFileSync(f, Buffer.from('second build, longer'));
  const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
  assert.equal(winCache.refresh().sha256, null, 'exists-but-unhashed until the new hash lands');
  assert.equal((await winCache.ready()).sha256, sha('second build, longer'));

  fs.unlinkSync(f); fs.unlinkSync(inDist);
  assert.equal(winCache.refresh().exists, false);
});

test('the two caches are independent instances', async () => {
  fs.writeFileSync(path.join(DATA_DIR, 'screentinker-pi_4.0.0_all.deb'), Buffer.from('deb'));
  debCache.refresh(); winCache.refresh();
  await debCache.ready();
  assert.equal(debCache.get().version, '4.0.0');
  assert.equal(winCache.get().exists, false, 'a .deb is not a Windows installer');
  fs.unlinkSync(path.join(DATA_DIR, 'screentinker-pi_4.0.0_all.deb'));
  debCache.refresh();
});
