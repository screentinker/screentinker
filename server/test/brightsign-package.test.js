'use strict';

// The manifest and the download must describe the SAME bytes.
//
// Advertising a version whose checksum does not match the file actually served is the classic
// OTA-loop condition: the player downloads, fails verification, retries, forever. It is also the
// easiest mistake to make, because the natural implementation computes the manifest from one source
// (a VERSION file, a build record) and serves the file from another (a path on disk that some
// deploy replaced). These tests pin the invariant that makes that impossible here: one buffer,
// hashed once, read by both routes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pkgLib = require('../lib/brightsign-package');

test('THE OTA LOOP: the advertised checksum is the hash of the bytes that are served', async () => {
  const pkg = await pkgLib.getPackage();
  assert.ok(pkg, 'package should build from brightsign/');
  // sha256 because that is what BrightScript's roMessageDigest can compute — a checksum the player
  // cannot verify is an unverifiable package.
  const actual = crypto.createHash('sha256').update(pkg.buffer).digest('hex');
  assert.equal(pkg.sha256, actual, 'a mismatch here loops every player in the fleet');
  assert.equal(pkg.size, pkg.buffer.length);
});

test('the package is byte-identical on rebuild — otherwise every deploy re-flashes the fleet', async () => {
  // Zip entries carry timestamps. Left at "now" the archive changes on every server restart, the
  // checksum changes with it, and every player decides it has an update waiting.
  const first = await pkgLib.getPackage();
  pkgLib._reset();
  const second = await pkgLib.getPackage();
  assert.equal(second.sha1, first.sha1);
});

test('the archive contains exactly the payload, at its ROOT with no wrapper directory', async () => {
  // A player extracts to the storage root. A wrapper folder puts autorun.brs where the player never
  // looks and the card silently does nothing — the failure mode is "blank screen", not an error.
  const pkg = await pkgLib.getPackage();
  const names = [];
  // Minimal central-directory walk: entry names follow the 0x02014b50 signature at offset +46.
  const buf = pkg.buffer;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const nameLen = buf.readUInt16LE(i + 28);
      names.push(buf.slice(i + 46, i + 46 + nameLen).toString('utf8'));
    }
  }
  assert.deepEqual(names.sort(), pkgLib.PACKAGE_FILES.slice().sort());
  for (const n of names) {
    assert.ok(!n.includes('/'), `${n} must be at the archive root, not nested`);
  }
});

test('autorun.brs and autozip.brs are both present — either missing is a dead panel', async () => {
  // autorun.brs missing: nothing to run after extraction.
  // autozip.brs missing: nothing extracts the archive in the first place.
  assert.ok(pkgLib.PACKAGE_FILES.includes('autorun.brs'));
  assert.ok(pkgLib.PACKAGE_FILES.includes('autozip.brs'));
});

test('THE BACK-DOOR LOOP: the shipped autorun.brs reports the version the manifest advertises', async () => {
  // Ship it unstamped and the player applies the update, still reports the old version, and is
  // offered the same package on every check — forever. The loop arrives even though the checksum
  // was correct and the download was clean.
  const unzipper = require('unzipper');
  const pkg = await pkgLib.getPackage();
  const dir = await unzipper.Open.buffer(pkg.buffer);
  const entry = dir.files.find((f) => f.path === 'autorun.brs');
  assert.ok(entry, 'autorun.brs must be in the package');
  const text = (await entry.buffer()).toString('utf8');
  const m = text.match(/return "([^"]*)"\s*' ST_PACKAGE_VERSION/);
  assert.ok(m, 'the ST_PACKAGE_VERSION marker must survive — it is what the stamp anchors on');
  assert.equal(m[1], pkg.version, 'stamped version must equal the advertised version');
});

test('the version comes from VERSION, so the manifest matches the release it shipped with', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const expected = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
  const pkg = await pkgLib.getPackage();
  assert.equal(pkg.version, expected);
});

// A BrightSign consultant's automated deployment copied our first autorun.zip onto a player and
// then reported it invalid. Two causes: the archive was DEFLATED, and we opened it with roUnzip
// rather than roBrightPackage. The player bootstrap extracts autozip.brs by itself before any
// script runs, and roBrightPackage supports a specific set of methods — "no compression" is the
// universally safe one.
//
// This is the failure mode that hurts: a compressed package uploads, downloads and deploys
// perfectly, then fails to open on the player. It reads as a broken deployment, not a broken zip,
// so it gets debugged everywhere except where the bug is.
test('THE DEPLOYMENT BUG: every member of the package is STORED, never deflated', async () => {
  const pkg = await pkgLib.getPackage();
  const buf = Buffer.isBuffer(pkg) ? pkg : (pkg && (pkg.buffer || pkg.bytes || pkg.zip));
  assert.ok(Buffer.isBuffer(buf), 'getPackage must yield the archive bytes');

  // Walk the local file headers: signature PK\x03\x04, compression method at offset +8.
  let found = 0;
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    assert.equal(method, 0, `${name} is compressed (method ${method}); the player cannot open it`);
    found++;
  }
  assert.ok(found > 0, 'no entries found — the walk itself is wrong, not the archive');
});

// ---------------------------------------------------------------------------------------------
// The package points at the server it was FETCHED FROM
//
// A zip pulled from alpha must provision against alpha. Before this, every package carried the
// committed default (prod) regardless of origin, so provisioning a self-hosted or alpha player
// from its own server silently pointed it at screentinker.com — which surfaces as a pairing bug,
// miles from the packaging code that caused it.
//
// The invariant at the top of this file becomes PER ORIGIN: different URL, different bytes,
// different checksum — and the manifest and download routes must derive the same one.
// ---------------------------------------------------------------------------------------------

// Entries are STORED (no compression), so screentinker.json sits verbatim in the archive and can be
// read without a zip library. Matched on the "key": "value" form specifically: autorun.brs also
// mentions server_url, but only as reg.Exists("server_url") / SaveRegistry("server_url", …), which
// this pattern cannot match.
const packagedServerUrl = (buffer) => {
  const m = buffer.toString('latin1').match(/"server_url"\s*:\s*"([^"]*)"/);
  assert.ok(m, 'screentinker.json should be readable in the stored archive');
  return m[1];
};

test('a package fetched from alpha points at alpha, not the committed default', async () => {
  pkgLib._reset();
  const alpha = await pkgLib.getPackage('https://alpha.screentinker.com');
  assert.equal(packagedServerUrl(alpha.buffer), 'https://alpha.screentinker.com');
  pkgLib._reset();
  const plain = await pkgLib.getPackage();
  assert.equal(packagedServerUrl(plain.buffer), 'https://screentinker.com',
    'with no URL to stamp, the committed default ships unchanged');
});

test('THE OTA LOOP, per origin: each package hashes its OWN bytes', async () => {
  pkgLib._reset();
  const a = await pkgLib.getPackage('https://alpha.screentinker.com');
  const b = await pkgLib.getPackage('https://screentinker.com');
  assert.notEqual(a.sha256, b.sha256, 'different URLs must produce different bytes');
  for (const p of [a, b]) {
    assert.equal(p.sha256, crypto.createHash('sha256').update(p.buffer).digest('hex'));
    assert.equal(p.size, p.buffer.length, 'Content-Length must match the body');
  }
});

test('reproducibility survives: the same URL yields byte-identical packages', async () => {
  // The whole reason entry timestamps are fixed. Per-origin caching must not reintroduce the
  // churn — a player that sees a new checksum every poll re-downloads forever.
  pkgLib._reset();
  const first = await pkgLib.getPackage('https://alpha.screentinker.com');
  pkgLib._reset();
  const second = await pkgLib.getPackage('https://alpha.screentinker.com');
  assert.equal(first.sha256, second.sha256);
});

test('the URL is not taken on trust — APP_URL wins, and a hostile Host is sanitised', () => {
  const req = (host, protocol = 'https') => ({ protocol, get: (h) => (h === 'host' ? host : null) });
  const saved = process.env.APP_URL;
  try {
    process.env.APP_URL = 'https://configured.example/';
    assert.equal(pkgLib.packageServerUrl(req('evil.example')), 'https://configured.example',
      'a configured APP_URL must win over the request header, and lose its trailing slash');

    delete process.env.APP_URL;
    assert.equal(pkgLib.packageServerUrl(req('alpha.screentinker.com')),
      'https://alpha.screentinker.com', 'otherwise fall back to the host, so self-hosting needs no config');
    for (const bad of ['a.example"; rm -rf /', 'a.example/../x', 'a b.example', 'x'.repeat(200),
                       'http://a.example', 'a.example:notaport']) {
      assert.equal(pkgLib.packageServerUrl(req(bad)), null,
        `a host that is not a clean hostname[:port] must ship the default, got it from ${bad}`);
    }
    assert.equal(pkgLib.packageServerUrl(req('a.example:3001', 'http')), 'http://a.example:3001',
      'a port and plain http are legitimate for a self-hosted box');
    assert.equal(pkgLib.packageServerUrl(req('')), null, 'no host, no stamp — ship the default');
    assert.equal(pkgLib.packageServerUrl(null), null);
  } finally {
    if (saved === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved;
  }
});

test('a corrupt config ships as-is rather than shipping corrupt', async () => {
  // autorun.brs reads screentinker.json at boot. A package that cannot be parsed there is a player
  // that never starts — strictly worse than one pointing at the wrong server.
  const pkgSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'brightsign-package.js'), 'utf8');
  assert.match(pkgSrc, /catch \(e\) \{\s*return source;/,
    'stampServerUrl must fall back to the original text on a parse failure');
});

test('the per-origin cache is bounded — the key comes from a request header', async () => {
  pkgLib._reset();
  for (let i = 0; i < 40; i++) await pkgLib.getPackage(`https://h${i}.example`);
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'brightsign-package.js'), 'utf8');
  const m = src.match(/MAX_CACHED_PACKAGES\s*=\s*(\d+)/);
  assert.ok(m, 'the bound must be a named constant, not a magic number');
  assert.ok(Number(m[1]) <= 32, 'a ~73KB buffer per entry keyed on a header needs a small bound');
});

test('BOTH routes derive the stamped URL the same way, or the manifest lies about the bytes', () => {
  // The lib tests above prove one buffer hashes to one checksum PER URL. That guarantee is only
  // useful if the manifest route and the download route ask for the SAME url — if one stamps and
  // the other does not, the player verifies a checksum against bytes it was never sent and retries
  // forever. Asserted on the source because both routes live in server.js behind an Express app
  // this file does not boot.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  const total = (src.match(/bsPackage\.getPackage\(/g) || []).length;
  const viaHelper = (src.match(/bsPackage\.getPackage\(bsPackage\.packageServerUrl\(/g) || []).length;
  assert.equal(viaHelper, total,
    `every getPackage call must route through packageServerUrl; ${total - viaHelper} do not`);

  // The two REQUEST-driven routes must both use (req). The boot warm-up legitimately passes null —
  // there is no request at boot — and it shares the cache key with APP_URL-configured deployments,
  // so it warms the very entry those requests will hit.
  const fromRequest = (src.match(/bsPackage\.getPackage\(bsPackage\.packageServerUrl\(req\)\)/g) || []).length;
  assert.ok(fromRequest >= 2,
    `the manifest and download routes must both derive from the request; found ${fromRequest}`);
});
