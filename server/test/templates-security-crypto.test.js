'use strict';

// Adversarial tests for the Templates library: package format, signatures, catalog index trust,
// offline bundles, zip parsing, the store, render-time resource use, and the maintainer CLI.
//
// Every test asserts the SAFE behaviour. A test whose name starts with "[BUG-" is a real defect
// found by this review: it FAILS until the fix described in research/security/crypto-and-packages.md
// lands. "[SAFE]" tests pin properties that were attacked and held.
//
// Test keys only — generated here, never the real catalog key.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-templates-sec-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-templates-sec-' + crypto.randomBytes(4).toString('hex');

const official = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const OFFICIAL_PEM = official.publicKey.export({ type: 'spki', format: 'pem' });
const OTHER_PEM = other.publicKey.export({ type: 'spki', format: 'pem' });
process.env.TEMPLATE_CATALOG_PUBLIC_KEY = OFFICIAL_PEM;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const pkg = require('../lib/templates/package');
const signing = require('../lib/templates/signing');
const params = require('../lib/templates/params');
const render = require('../lib/templates/render');
const store = require('../lib/templates/store');
const catalog = require('../lib/templates/catalog');
const tplWidget = require('../lib/templates/widget');
const zipLib = require('../lib/templates/zip');
const appSettings = require('../lib/app-settings');
const archiver = require('archiver');

db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES ('u1','u1@test.local','platform_admin','x')").run();

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'scripts', 'template-catalog.js');

/* ------------------------------------------------------------------ helpers */

function slideTemplate(over = {}) {
  const manifest = {
    id: 'lobby-welcome', name: 'Lobby welcome', version: '1.0.0', kind: 'slide', license: 'MIT',
    params: [{ name: 'headline', type: 'text', label: 'Headline', default: 'Welcome' }],
    ...over.manifest,
  };
  const doc = { template: { background: '#101418', elements: [{ slot: 'headline', kind: 'head', box: { x: 5, y: 10, w: 90 } }] }, fields: { headline: '{{param:headline}}' } };
  return pkg.buildPackageBytes(manifest, { 'template.json': Buffer.from(JSON.stringify(doc)), 'logo.png': PNG, ...over.files });
}

function htmlTemplate(over = {}) {
  const manifest = {
    id: 'news-ticker', name: 'News ticker', version: '1.0.0', kind: 'html', license: 'MIT',
    network: ['api.example.com'], params: [{ name: 'title', type: 'text', default: 'News' }],
    ...over.manifest,
  };
  return pkg.buildPackageBytes(manifest, { 'index.html': Buffer.from('<!doctype html><h1>hi</h1>'), ...over.files });
}

const signedEnvelope = (bytes, key = official.privateKey) => pkg.buildEnvelope(bytes, signing.signPackage(bytes, key));

function signIndexObj(index, key = official.privateKey) {
  const bytes = Buffer.from(JSON.stringify(index));
  return { bytes, sig: signing.formatIndexSignature(signing.signIndex(bytes, key)) };
}

function indexFor(entries, { serial = 100, catalogId = 'official', revoked = [], mutate } = {}) {
  const index = {
    schema: 1, catalog: catalogId, serial, generated: new Date().toISOString(),
    expires: new Date(Date.now() + 30 * 86400e3).toISOString(), revoked,
    templates: entries.map((bytes) => {
      const { manifest, sha256 } = pkg.parsePackageBytes(bytes);
      return {
        id: manifest.id, name: manifest.name, kind: manifest.kind, license: manifest.license,
        versions: [{ version: manifest.version, sha256, url: `packages/${manifest.id}-${manifest.version}.sttemplate`, network: manifest.network }],
      };
    }),
  };
  if (mutate) mutate(index);
  return signIndexObj(index);
}

function freshCatalogState() {
  db.prepare('DELETE FROM templates_installed').run();
  db.prepare('DELETE FROM template_catalogs').run();
  db.prepare("DELETE FROM widgets WHERE widget_type = 'template'").run();
  store._clearCache();
  catalog.ensureOfficial();
  appSettings.setBool(catalog.SETTING_UNSIGNED_CODE, false);
}

function serveFiles(files) {
  catalog.setFetcher(async (url) => {
    const rel = url.replace('https://screentinker.github.io/templates/', '');
    if (files[rel]) return files[rel];
    throw new Error('404 ' + rel);
  });
  appSettings.setBool(catalog.SETTING_ENABLED, true);
}

async function zipOf(entries, { level = 6 } = {}) {
  const a = archiver('zip', { zlib: { level } });
  const chunks = [];
  a.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => a.on('end', r));
  for (const [n, b] of Object.entries(entries)) a.append(b, { name: n });
  a.finalize();
  await done;
  return Buffer.concat(chunks);
}

function ms(fn) {
  const t = process.hrtime.bigint();
  try { fn(); } catch { /* timing only */ }
  return Number(process.hrtime.bigint() - t) / 1e6;
}

// Raw 32-byte Ed25519 public key -> KeyObject (via the fixed SPKI prefix).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const rawKeyToPem = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' });

/* =================================================================== signatures */

test('[SAFE] Ed25519 malleability: S + L (non-canonical scalar) is rejected', () => {
  const bytes = slideTemplate();
  const sig = signing.signPackage(bytes, official.privateKey);
  const trusted = [{ id: 'official', label: 'o', key: official.publicKey }];
  assert.ok(signing.verifyPackage(bytes, sig, trusted));
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let S = 0n;
  for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(sig.sig[i]);
  const mal = Buffer.from(sig.sig);
  const S2 = S + L;
  for (let i = 0; i < 32; i++) mal[32 + i] = Number((S2 >> BigInt(8 * i)) & 0xffn);
  assert.equal(signing.verifyPackage(bytes, { key_id: sig.key_id, sig: mal }, trusted), null);
  // All-zero and all-FF signatures.
  assert.equal(signing.verifyPackage(bytes, { key_id: sig.key_id, sig: Buffer.alloc(64) }, trusted), null);
  assert.equal(signing.verifyPackage(bytes, { key_id: sig.key_id, sig: Buffer.alloc(64, 0xff) }, trusted), null);
});

test('[SAFE] key_id: uppercase, long, short, binary and non-hex ids are refused at parse', () => {
  const bytes = slideTemplate();
  const env = JSON.parse(signedEnvelope(bytes).toString());
  for (const kid of [env.signature.key_id.toUpperCase(), env.signature.key_id + '00', 'abc', '\u0000'.repeat(16), 'g'.repeat(16), 'a'.repeat(100000), 123]) {
    const e = { ...env, signature: { ...env.signature, key_id: kid } };
    assert.throws(() => pkg.parseEnvelope(Buffer.from(JSON.stringify(e))), /key_id/, String(kid).slice(0, 20));
  }
});

test('[SAFE] a signature over the envelope, or over another package with the same id/version, does not verify', () => {
  freshCatalogState();
  const a = slideTemplate();
  const b = slideTemplate({ files: { 'extra.txt': Buffer.from('evil') } });
  // Swap: envelope carries package B but the signature made for A.
  const swapped = pkg.buildEnvelope(b, signing.signPackage(a, official.privateKey));
  const row = catalog.importPackage(swapped, 'u1');
  assert.equal(row.trust, 'unverified');
  assert.equal(row.catalog, 'local');
  // Signature over the envelope bytes of A.
  const envBytes = pkg.buildEnvelope(a, null);
  const overEnv = { key_id: signing.keyId(official.publicKey), sig: crypto.sign(null, Buffer.concat([Buffer.from(signing.PACKAGE_CONTEXT), envBytes]), official.privateKey) };
  assert.equal(signing.verifyPackage(a, overEnv, [{ id: 'o', label: 'o', key: official.publicKey }]), null);
});

test('[SAFE] a package signed by a DISABLED catalog key imports as unverified/local', () => {
  freshCatalogState();
  catalog.addCatalog({ id: 'community', label: 'Community', url: 'https://c.example/', publicKey: OTHER_PEM });
  catalog.setCatalogEnabled('community', false);
  const row = catalog.importPackage(signedEnvelope(slideTemplate({ manifest: { id: 'comm-one' } }), other.privateKey), 'u1');
  assert.equal(row.trust, 'unverified');
  assert.equal(row.id, 'local/comm-one');
  // And the disabled catalog cannot accept an index.
  const idx = indexFor([], { catalogId: 'community' });
  const idx2 = signIndexObj({ ...JSON.parse(idx.bytes), catalog: 'community' }, other.privateKey);
  assert.throws(() => catalog.acceptIndex('community', idx2.bytes, idx2.sig), /disabled/);
});

test('[BUG-02 MEDIUM] a small-order (identity) Ed25519 public key must be refused as a catalog key — it verifies a forged signature over ANY message', (t) => {
  freshCatalogState();
  // The identity point (y = 1). Node/OpenSSL accept it as a public key, and (R = identity, S = 0)
  // then "verifies" for every message: anyone, not just the key holder, can sign for this catalog.
  const identity = Buffer.alloc(32); identity[0] = 1;
  const pem = rawKeyToPem(identity);
  const forged = Buffer.alloc(64); forged[0] = 1;
  // Whether the forgery verifies is the CRYPTO LIBRARY's behaviour, and it differs by version:
  // Node 20's OpenSSL accepts it; Node 24's rejects it. The catalog must not depend on which one a
  // server happens to run, so the refusal below is asserted either way and the primitive is only
  // recorded.
  let forgeryVerifies = false;
  try { forgeryVerifies = crypto.verify(null, Buffer.from('anything at all'), crypto.createPublicKey(pem), forged); } catch { /* rejected outright */ }
  t.diagnostic(`this OpenSSL ${forgeryVerifies ? 'ACCEPTS' : 'rejects'} the small-order forgery`);
  // The safe behaviour: the catalog layer refuses such a key, whatever OpenSSL does.
  assert.throws(() => catalog.addCatalog({ id: 'weak', label: 'Weak', url: 'https://w.example/', publicKey: pem }), /key/,
    'addCatalog accepted a small-order public key: any index/package "signed" by anyone verifies for this catalog');
});

test('[BUG-02 MEDIUM] (consequence) with a small-order catalog key, an attacker forges a verified package and index', () => {
  freshCatalogState();
  const identity = Buffer.alloc(32); identity[0] = 1;
  let added = false;
  try { catalog.addCatalog({ id: 'weak', label: 'Weak', url: 'https://w.example/', publicKey: rawKeyToPem(identity) }); added = true; } catch { /* fixed */ }
  if (!added) return;   // once BUG-02 is fixed there is nothing to forge against
  const forged = Buffer.alloc(64); forged[0] = 1;
  const kid = signing.keyId(rawKeyToPem(identity));
  const env = pkg.buildEnvelope(htmlTemplate({ manifest: { id: 'forged-code' } }), { key_id: kid, sig: forged });
  let row = null;
  try { row = catalog.importPackage(env, 'u1'); } catch { /* refused */ }
  assert.ok(!row || row.trust !== 'verified', 'a package with a forged all-zero signature was installed as VERIFIED html code');
});

/* =================================================================== package format / canonical JSON */

test('[SAFE] base64 edge cases: whitespace, URL-safe alphabet, missing/extra padding, non-canonical tail bits', () => {
  const good = Buffer.from('hello world!!').toString('base64');
  assert.ok(pkg.strictBase64(good, 'x'));
  for (const s of [good + '\n', ' ' + good, good.replace(/=+$/, ''), good + '==', 'aGk-', 'aGk_', 'aGk=a', 'QR==', 'QQ=', '====', 'QQ==QQ==']) {
    assert.throws(() => pkg.strictBase64(s, 'x'), /base64/, JSON.stringify(s));
  }
});

test('[SAFE] canonical JSON: -0, 1.0, 1e21 spellings, \\u escapes, "\\/" and duplicate keys are all second encodings and refused', () => {
  const bytes = slideTemplate({ manifest: { params: [{ name: 'n', type: 'number', min: 0, max: 1e21 > 1e9 ? 5 : 5, default: 1 }] } });
  const s = bytes.toString();
  assert.doesNotThrow(() => pkg.parsePackageBytes(bytes));
  const variants = [
    s.replace('"default":1', '"default":1.0'),
    s.replace('"default":1', '"default":1e0'),
    s.replace('"min":0', '"min":-0'),
    s.replace('"Lobby welcome"', '"\\u004cobby welcome"'),
    s.replace('"MIT"', '"M\\/IT"'),
    s.replace('"license":"MIT"', '"license":"MIT","license":"MIT"'),
    '\uFEFF' + s,
    s + '\n',
  ];
  for (const v of variants) {
    assert.notEqual(v, s);
    assert.throws(() => pkg.parsePackageBytes(Buffer.from(v)), undefined, v.slice(0, 60));
  }
  // Non-finite numbers cannot be canonicalised at all.
  assert.throws(() => pkg.canonicalJson({ a: Infinity }), /non-finite/);
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(s.replace('"default":1', '"default":1e400'))));
});

test('[BUG-06 LOW] package canonicality must be checked on BYTES: invalid UTF-8 gives one package many sha256s', () => {
  // A description containing U+FFFD. Replacing its 3-byte encoding (EF BF BD) with any single invalid
  // byte (0xFF) decodes to the same string, so the string-level canonical check passes, but the
  // sha256 — the package's identity, what indexes pin and revocations name — is different.
  const bytes = slideTemplate({ manifest: { description: 'broken \uFFFD glyph' } });
  const i = bytes.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  assert.ok(i > 0);
  const variant = Buffer.concat([bytes.subarray(0, i), Buffer.from([0xff]), bytes.subarray(i + 3)]);
  assert.notEqual(pkg.sha256Hex(variant), pkg.sha256Hex(bytes));
  assert.throws(() => pkg.parsePackageBytes(variant), /canonical|UTF-8|utf-8/,
    'a non-UTF-8 re-encoding of the same package was accepted under a different sha256');
});

test('[SAFE] prototype keys: __proto__ / constructor in manifest, files and params do not pollute or pass', () => {
  const base = JSON.parse(slideTemplate().toString());
  const withProtoManifest = JSON.parse(JSON.stringify(base));
  withProtoManifest.manifest = JSON.parse(JSON.stringify(base.manifest).replace('{', '{"__proto__":{"polluted":1},'));
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(pkg.canonicalJson(withProtoManifest))), /unknown key|not canonical/);
  const withProtoFile = JSON.parse(JSON.stringify(base));
  withProtoFile.files = JSON.parse(JSON.stringify(base.files).replace('{', '{"__proto__":"eA==",'));
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(pkg.canonicalJson(withProtoFile))));
  // Param named "constructor" is a legal name and must stay an own, validated value.
  const b = slideTemplate({ manifest: { params: [{ name: 'constructor', type: 'text', default: 'x' }, { name: 'headline', type: 'text' }] } });
  const env = pkg.parsePackageBytes(b);
  const vals = params.resolveValues(env.manifest.params, JSON.parse('{"__proto__":{"polluted":1},"constructor":"ok"}'));
  assert.equal(vals.constructor, 'ok');
  const sub = params.substitute(JSON.parse('{"a":"{{param:constructor}}","__proto__":{"polluted":"y"},"b":"{{param:tostring}}"}'), env.manifest.params, vals);
  assert.equal(sub.a, 'ok');
  assert.equal(sub.b, '');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('[SAFE] deep nesting in manifest/template.json fails fast and cleanly (no hang, no crash)', () => {
  const depth = 200000;
  const s = slideTemplate().toString().replace('"params":[', `"params":[${'['.repeat(depth)}${']'.repeat(depth)},`);
  const t = ms(() => pkg.parsePackageBytes(Buffer.from(s)));
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(s)));
  assert.ok(t < 2000, `deep nesting took ${t} ms`);
  // Through the public import path the error becomes a CatalogError (a 400), not a crash.
  assert.throws(() => catalog.importPackage(pkg.buildEnvelope(Buffer.from(s)), 'u1'), (e) => e instanceof catalog.CatalogError);
  // Deep template.json is capped by substitute's depth limit.
  let deep = '"x"'; for (let i = 0; i < 5000; i++) deep = `[${deep}]`;
  const out = params.substitute(JSON.parse(`{"template":${deep}}`), [], {});
  assert.ok(JSON.stringify(out).length < 200);
});

test('[BUG-07 LOW] an oversized envelope must fail with a PackageError, not a V8 RangeError from the base64 regex', () => {
  // B64_RE backtracks once per 4-char group; around 4.47 M characters V8's regexp stack overflows.
  // Unreachable for a VALID package (≤ ~3 MB of package bytes), but an 8 MB upload hits it and the
  // raw "Maximum call stack size exceeded" becomes the API's error message.
  const env = Buffer.from(JSON.stringify({ format: pkg.FORMAT, package: 'A'.repeat(7.5e6), signature: null }));
  assert.ok(env.length <= pkg.MAX_ENVELOPE_BYTES * 2);
  const t = ms(() => pkg.parseEnvelope(env));
  assert.ok(t < 2000, `8 MB envelope took ${t} ms`);
  assert.throws(() => pkg.parseEnvelope(env), (e) => e instanceof pkg.PackageError, 'got a RangeError instead of a PackageError');
});

/* =================================================================== ReDoS / render resource use */

test('[SAFE] regex timing: HOST_RE, PATH_RE, resolveRef, src/href rewrite, doctype strip on 1 MB pathological input < 100 ms', () => {
  const cases = {
    'HOST_RE many labels': () => pkg.HOST_RE.test('a.'.repeat(500000) + '!'),
    'HOST_RE hyphen labels': () => pkg.HOST_RE.test(('a-'.repeat(30) + 'a.').repeat(15000) + '1'),
    'HOST_RE long label': () => pkg.HOST_RE.test('a'.repeat(1e6) + '.'),
    'resolveRef long path': () => render.resolveRef('index.html', 'a/'.repeat(4e5) + 'x'),
    'resolveRef scheme-like': () => render.resolveRef('index.html', 'a'.repeat(1e6) + '!'),
    'src rewrite unterminated': () => (' src="' + ' src='.repeat(200000)).replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, 'x'),
    'src rewrite whitespace': () => (' src' + ' '.repeat(1e6)).replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, 'x'),
    'src rewrite mixed quotes': () => (' src= src= src=\''.repeat(60000)).replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, 'x'),
    'doctype strip': () => ('<!doctype' + 'a'.repeat(1e6)).replace(/^\uFEFF?\s*<!doctype[^>]*>/i, ''),
    'strictBase64 junk tail 1MB': () => pkg.strictBase64('A'.repeat(1e6) + '!', 'x'),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const t = ms(fn);
    assert.ok(t < 100, `${name}: ${t.toFixed(1)} ms`);
  }
});

test('[BUG-01a HIGH] ReDoS: the CSS url() rewrite is quadratic — 64 KB of "url(" must not take > 100 ms', () => {
  // /url\(\s*(['"]?)([^'")]+)\1\s*\)/g : with no ")" anywhere, every "url(" start scans to the end
  // of the string. Measured on Node 20: 100 KB = 2.8 s, 200 KB = 13 s, so a 1 MB file (the per-file
  // cap) is ~5 minutes of blocked event loop — on EVERY render of the widget (no render cache),
  // and it runs over the entry HTML too, not only over .css files.
  const env = pkg.parseEnvelope(pkg.buildEnvelope(pkg.buildPackageBytes(
    { id: 'redos-css', name: 'x', version: '1.0.0', kind: 'html', license: 'MIT' },
    { 'index.html': Buffer.from('<!doctype html><link rel="stylesheet" href="s.css">'), 's.css': Buffer.from('url('.repeat(16 * 1024)) },
  )));
  const t = ms(() => render.buildHtmlDocument(env, {}, {}));
  assert.ok(t < 100, `buildHtmlDocument spent ${t.toFixed(0)} ms on a 64 KB css file`);
});

test('[BUG-01b HIGH] render amplification: one 1 MB asset referenced N times must not be base64-encoded N times', () => {
  // Every src/href/url() reference re-encodes the file, and MAX_DOC_BYTES is only checked AFTER the
  // whole document string is built. Measured: 300 refs (5 KB of HTML) → +1.2 GB RSS; 20 000 refs
  // (340 KB of HTML) → the Node process ABORTS (fatal OOM) — a crash loop, since players re-fetch.
  const big = Buffer.alloc(900 * 1024, 7);
  const env = pkg.parseEnvelope(pkg.buildEnvelope(pkg.buildPackageBytes(
    { id: 'amplify', name: 'x', version: '1.0.0', kind: 'html', license: 'MIT' },
    { 'index.html': Buffer.from('<!doctype html>' + '<img src="a.png">'.repeat(200)), 'a.png': big },
  )));
  // Count base64 bytes produced during the render (deterministic, unlike RSS).
  const orig = Buffer.prototype.toString;
  let produced = 0;
  Buffer.prototype.toString = function (enc, ...rest) {
    const s = orig.call(this, enc, ...rest);
    if (enc === 'base64') produced += s.length;
    return s;
  };
  let out;
  try { out = render.buildHtmlDocument(env, {}, {}); } catch (e) { out = { error: e }; } finally { Buffer.prototype.toString = orig; }
  assert.ok(produced <= 16 * 1024 * 1024, `render produced ${(produced / 1e6).toFixed(0)} MB of base64 for a 3.4 KB HTML file`);
  assert.ok(out && !out.error);
});

/* =================================================================== index trust */

test('[SAFE] serial: non-integers, strings, > 2^53, 0 and negative are refused', () => {
  freshCatalogState();
  for (const serial of [1.5, '5', 2 ** 53, 2 ** 53 + 2, 1e300, 0, -1, null, true]) {
    const idx = indexFor([], { mutate: (i) => { i.serial = serial; } });
    assert.throws(() => catalog.acceptIndex('official', idx.bytes, idx.sig), /serial/, String(serial));
  }
});

test('[SAFE] equal serial: identical is a re-fetch, different content is refused; lower is a rollback (also via offline bundle)', async () => {
  freshCatalogState();
  const a = indexFor([slideTemplate()], { serial: 700 });
  catalog.acceptIndex('official', a.bytes, a.sig);
  const reformatted = signIndexObj(JSON.parse(a.bytes), official.privateKey);   // same content, fresh sig
  assert.doesNotThrow(() => catalog.acceptIndex('official', reformatted.bytes, reformatted.sig));
  const b = indexFor([slideTemplate(), htmlTemplate()], { serial: 700 });
  assert.throws(() => catalog.acceptIndex('official', b.bytes, b.sig), /without a new serial/);
  const old = indexFor([], { serial: 699 });
  const z = await zipOf({ 'index.json': old.bytes, 'index.json.sig': old.sig });
  await assert.rejects(catalog.importOfflineBundle(z), /rollback/);
});

test('[SAFE] index signature file: other key / other catalog / package-domain signature / junk text are refused', () => {
  freshCatalogState();
  const idx = indexFor([]);
  const pkgDomain = signing.formatIndexSignature(signing.signPackage(idx.bytes, official.privateKey));
  for (const sig of [pkgDomain, signing.formatIndexSignature(signing.signIndex(idx.bytes, other.privateKey)), '', 'x', idx.sig.replace(':', ': '), idx.sig.toUpperCase(), idx.sig + idx.sig]) {
    assert.throws(() => catalog.acceptIndex('official', idx.bytes, sig), /not signed/);
  }
  // Trailing whitespace/newlines are tolerated (the file ends in \n).
  assert.doesNotThrow(() => catalog.acceptIndex('official', idx.bytes, idx.sig.trim() + '\r\n'));
});

test('[SAFE] resolveUrl: backslashes, tabs, %2e%2e, userinfo, uppercase scheme and fullwidth dots never leave the catalog base', () => {
  const base = 'https://screentinker.github.io/templates/';
  const attacks = ['\\\\evil.example\\x', '\t//evil.example/x', '\n//evil.example/x', '%2e%2e/%2e%2e/x', 'packages/%2E%2E/%2e%2E/other/x',
    '.%2e/x', '%2e./x', 'HTTPS://evil.example/x', '/\\evil.example/x', 'https:evil.example/x'];
  for (const rel of attacks) {
    let u = null;
    try { u = catalog.resolveUrl(base, rel); } catch { continue; }
    const p = new URL(u);
    assert.equal(p.origin, 'https://screentinker.github.io', rel);
    assert.ok(p.pathname.startsWith('/templates/'), `${JSON.stringify(rel)} -> ${u}`);
  }
  for (const rel of ['@evil.example/x', 'packages/\uFF0E\uFF0E/\uFF0E\uFF0E/x']) {
    const p = new URL(catalog.resolveUrl(base, rel));
    assert.equal(p.origin, 'https://screentinker.github.io');
    assert.ok(p.pathname.startsWith('/templates/'));
  }
  // validateIndex also drops the obviously hostile ones before resolveUrl ever runs.
  const v = catalog.validateIndex({ schema: 1, catalog: 'official', serial: 1, expires: new Date().toISOString(), templates: [
    { id: 'a-b', versions: ['HTTPS://evil/x', '/abs', '../x', 'a/../../x', 'x'.repeat(301)].map((url, i) => ({ version: `1.0.${i}`, sha256: 'a'.repeat(64), url })) },
  ] });
  assert.equal(v.templates.length, 0);
});

test('[BUG-12 LOW] a catalog base URL without a trailing slash must not allow a sibling-prefix escape', () => {
  // TEMPLATE_CATALOG_URL is used verbatim (addCatalog normalises, officialUrl() does not), and
  // resolveUrl's check is a plain string prefix: "/templates-evil/x".startsWith("/templates").
  const base = 'https://mirror.example/templates';
  let u = null;
  try { u = catalog.resolveUrl(base, '%2e%2e/templates-evil/x.sttemplate'); } catch { /* refused: safe */ }
  assert.ok(!u || new URL(u).pathname.startsWith('/templates/'), `escaped to ${u}`);
});

test('[BUG-04 MEDIUM] revocations fail OPEN: a malformed revoked entry in a signed index must not silently revoke nothing', () => {
  freshCatalogState();
  catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  const cases = [
    { id: 'lobby-welcome', versions: ['v1.0.0'], reason: 'typo in version' },     // -> versions: [] -> matches nothing
    { id: 'Lobby-Welcome', versions: ['*'], reason: 'wrong case id' },           // -> id: null -> matches nothing
    { id: 'lobby-welcome', versions: ['1.0.*'], reason: 'wildcard form' },       // -> versions: [] -> matches nothing
  ];
  let serial = 800;
  for (const r of cases) {
    db.prepare("UPDATE templates_installed SET status = 'active', status_reason = NULL").run();
    const idx = indexFor([slideTemplate()], { serial: ++serial, revoked: [r] });
    let refused = false;
    try { catalog.acceptIndex('official', idx.bytes, idx.sig); } catch { refused = true; }
    const st = store.getInstalled('official/lobby-welcome').status;
    assert.ok(refused || st === 'revoked', `revocation ${JSON.stringify(r)} was silently dropped (status ${st})`);
  }
});

test('[SAFE] revocation cannot be lifted by replaying an older (or equal-serial, different) index', () => {
  freshCatalogState();
  catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  const rev = indexFor([slideTemplate()], { serial: 900, revoked: [{ id: 'lobby-welcome', versions: ['*'], reason: 'bad' }] });
  catalog.acceptIndex('official', rev.bytes, rev.sig);
  assert.equal(store.getInstalled('official/lobby-welcome').status, 'revoked');
  for (const serial of [899, 900]) {
    const lift = indexFor([slideTemplate()], { serial });
    assert.throws(() => catalog.acceptIndex('official', lift.bytes, lift.sig));
    assert.equal(store.getInstalled('official/lobby-welcome').status, 'revoked');
  }
  // Re-importing the revoked signed file is refused too.
  assert.throws(() => catalog.importPackage(signedEnvelope(slideTemplate()), 'u1'), /revoked/);
  // A foreign catalog's index cannot lift the official revocation.
  catalog.addCatalog({ id: 'community', label: 'Community', url: 'https://c.example/', publicKey: OTHER_PEM });
  const c = signIndexObj({ schema: 1, catalog: 'community', serial: 5, expires: new Date(Date.now() + 1e9).toISOString(), templates: [], revoked: [] }, other.privateKey);
  catalog.acceptIndex('community', c.bytes, c.sig);
  assert.equal(store.getInstalled('official/lobby-welcome').status, 'revoked');
});

test('[BUG-09 LOW] a signed import must honour sha256 revocations from EVERY catalog, as the unsigned path does', () => {
  freshCatalogState();
  const bytes = slideTemplate();
  const sha = pkg.parsePackageBytes(bytes).sha256;
  catalog.addCatalog({ id: 'community', label: 'Community', url: 'https://c.example/', publicKey: OTHER_PEM });
  const c = signIndexObj({ schema: 1, catalog: 'community', serial: 5, expires: new Date(Date.now() + 1e9).toISOString(), templates: [], revoked: [{ id: 'xx', versions: ['*'], sha256: [sha], reason: 'malware' }] }, other.privateKey);
  catalog.acceptIndex('community', c.bytes, c.sig);
  // Unsigned copy: refused (checks all catalogs).
  assert.throws(() => catalog.importPackage(pkg.buildEnvelope(bytes), 'u1'), /revoked/);
  // Signed copy of the SAME bytes: only the signer's own index is consulted.
  let row = null;
  try { row = catalog.importPackage(signedEnvelope(bytes), 'u1'); } catch { /* refused: safe */ }
  assert.ok(!row || row.status === 'revoked', 'the signed copy of a sha-revoked package was installed ACTIVE');
});

test('[BUG-03 MEDIUM] disabling a catalog (e.g. after a key compromise) must stop its installed CODE templates running as verified', () => {
  freshCatalogState();
  catalog.addCatalog({ id: 'community', label: 'Community', url: 'https://c.example/', publicKey: OTHER_PEM });
  const row = catalog.importPackage(signedEnvelope(htmlTemplate({ manifest: { id: 'comm-code' } }), other.privateKey), 'u1');
  assert.equal(row.trust, 'verified');
  assert.equal(tplWidget.usable(store.getInstalled('community/comm-code')), null);
  catalog.setCatalogEnabled('community', false);
  // Its key is no longer trusted: a NEW import of the same file would be unverified (and, as html
  // code, refused). The existing install is still "verified" and keeps rendering.
  assert.throws(() => catalog.importPackage(signedEnvelope(htmlTemplate({ manifest: { id: 'comm-code2' } }), other.privateKey), 'u1'), /UNSIGNED/);
  const still = tplWidget.usable(store.getInstalled('community/comm-code'));
  assert.notEqual(still, null, 'an html template from a DISABLED catalog is still usable as verified code');
});

test('[BUG-05 MEDIUM] install must cross-check the signed index entry (kind, network) against the package manifest', async () => {
  freshCatalogState();
  // The library/consent view is built from the INDEX: here it says "slide, no network" while the
  // package is html code that talks to api.example.com. Nothing compares the two.
  const bytes = htmlTemplate();
  const idx = indexFor([bytes], { serial: 1000, mutate: (i) => { i.templates[0].kind = 'slide'; i.templates[0].versions[0].network = []; } });
  catalog.acceptIndex('official', idx.bytes, idx.sig);
  serveFiles({ 'packages/news-ticker-1.0.0.sttemplate': signedEnvelope(bytes) });
  const lib = catalog.library('u1').catalogs.find((c) => c.id === 'official').templates[0];
  assert.equal(lib.kind, 'slide');
  assert.deepEqual(lib.network, []);
  let row = null;
  try { row = await catalog.installFromCatalog('official', 'news-ticker', null, 'u1'); } catch { /* refused: safe */ }
  assert.ok(!row, `installed ${row && row.kind} code with network ${row && JSON.stringify(row.manifest.network)} while the index advertised a slide with no network`);
});

test('[SAFE/LOW-TIMING] a 2 MB signed index built to maximise revocation scanning keeps library() under 1.5 s', () => {
  freshCatalogState();
  const shas = Array.from({ length: 14000 }, (_, i) => crypto.createHash('sha256').update(String(i)).digest('hex'));
  const versions = Array.from({ length: 6500 }, (_, i) => ({ version: `1.${Math.floor(i / 1000)}.${i % 1000}`, sha256: 'c'.repeat(64), url: `p/${i}` }));
  const index = { schema: 1, catalog: 'official', serial: 1100, expires: new Date(Date.now() + 1e9).toISOString(),
    revoked: [{ id: 'x', versions: [], sha256: shas }, { id: 'heavy', versions: ['*'] }], templates: [{ id: 'heavy', versions }] };
  const s = signIndexObj(index);
  assert.ok(s.bytes.length < 2 * 1024 * 1024, `index is ${s.bytes.length} bytes`);
  const tAccept = ms(() => catalog.acceptIndex('official', s.bytes, s.sig));
  const tLib = ms(() => catalog.library('u1'));
  console.log(`# 2 MB index: acceptIndex ${tAccept.toFixed(0)} ms, library() ${tLib.toFixed(0)} ms`);
  assert.ok(tLib < 1500, `library() took ${tLib.toFixed(0)} ms`);
});

/* =================================================================== offline bundle + zip */

// archiver sanitises hostile names ("../x" -> "x"), so write same-length placeholders and patch
// the raw name bytes in both the local headers and the central directory.
async function zipRawNames(pairs) {
  const entries = {};
  const map = [];
  pairs.forEach(([name, buf], i) => {
    const n = Buffer.byteLength(name);
    const ph = (String(i) + '#'.repeat(n)).slice(0, n);
    entries[ph] = buf;
    map.push([Buffer.from(ph), Buffer.from(name)]);
  });
  const z = await zipOf(entries, { level: 0 });
  for (const [ph, real] of map) {
    let i = -1;
    while ((i = z.indexOf(ph, i + 1)) >= 0) real.copy(z, i);
  }
  return z;
}

test('[SAFE] zip: traversal, absolute, drive, backslash, NUL, deep paths, dot-dup and case-dup names are refused', async () => {
  const { readZip } = zipLib;
  const opts = { maxArchiveBytes: 1e7, maxEntries: 100, maxFileBytes: 1e6, maxTotalBytes: 1e7 };
  for (const name of ['../x', 'a/../../x', '/abs', 'C:/x', 'a/b/c/d/e/f/g', 'a\u0001b', '..\\..\\x', 'a\\..\\..\\x']) {
    const z = await zipRawNames([[name, Buffer.from('x')]]);
    await assert.rejects(readZip(z, opts), /unsafe path|not a readable/, JSON.stringify(name));
  }
  for (const pair of [['index.json', './index.json'], ['index.json', 'INDEX.json'], ['a/b.txt', 'a//b.txt'], ['a/b.txt', 'a\\b.txt']]) {
    const z = await zipRawNames([[pair[0], Buffer.from('1')], [pair[1], Buffer.from('2')]]);
    await assert.rejects(readZip(z, opts), /two entries/, pair.join(' + '));
  }
  // The same name twice in the central directory.
  const z = await zipRawNames([['aaaa.txt', Buffer.from('1')], ['aaaa.txt', Buffer.from('2')]]);
  await assert.rejects(readZip(z, opts), /two entries/);
  // Offline bundle: the pinned package path present twice (once via "./").
  freshCatalogState();
  const good = slideTemplate();
  const idx = indexFor([good], { serial: 1250 });
  const p = 'packages/lobby-welcome-1.0.0.sttemplate';
  const dupe = await zipRawNames([['index.json', idx.bytes], ['index.json.sig', Buffer.from(idx.sig)], [p, signedEnvelope(good)],
    ['./' + p, signedEnvelope(slideTemplate({ files: { 'x.txt': Buffer.from('evil') } }))]]);
  await assert.rejects(catalog.importOfflineBundle(dupe), /two entries/);
});

test('[SAFE] zip: symlink entries, encrypted flag and unsupported methods are refused', async () => {
  const { readZip } = zipLib;
  const opts = { maxArchiveBytes: 1e7, maxEntries: 100, maxFileBytes: 1e6, maxTotalBytes: 1e7 };
  const a = archiver('zip');
  const chunks = []; a.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => a.on('end', r));
  a.symlink('link.txt', '/etc/passwd');
  a.finalize(); await done;
  await assert.rejects(readZip(Buffer.concat(chunks), opts), /symlink/);
  const cdFlag = async (patch) => {
    const zz = await zipOf({ 'x.txt': Buffer.from('hello hello hello') });
    const cd = zz.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const lh = zz.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    patch(zz, cd, lh);
    return zz;
  };
  await assert.rejects(readZip(await cdFlag((zz, cd, lh) => { zz.writeUInt16LE(zz.readUInt16LE(cd + 8) | 1, cd + 8); zz.writeUInt16LE(zz.readUInt16LE(lh + 6) | 1, lh + 6); }), opts), /encrypted|corrupt/);
  await assert.rejects(readZip(await cdFlag((zz, cd, lh) => { zz.writeUInt16LE(12, cd + 10); zz.writeUInt16LE(12, lh + 8); }), opts), /unsupported compression|corrupt/);
  // Central directory says "stored", local header says "deflate" (and vice versa): never more than the cap.
  const lie = await cdFlag((zz, cd) => { zz.writeUInt16LE(0, cd + 10); });
  try { const out = await readZip(lie, opts); assert.ok(out['x.txt'].length <= 1e6); } catch (e) { assert.ok(e instanceof zipLib.ZipError); }
  // Truncated archive.
  const full = await zipOf({ 'x.txt': Buffer.from('x') });
  await assert.rejects(readZip(full.subarray(0, full.length - 10), opts));
});

test('[BUG-08 LOW] zip: an entry that inflates past its CLAIMED size (but under the per-file cap) must be refused', async () => {
  // readZip bounds the total by summing CLAIMED sizes, then caps each entry only at maxFileBytes.
  // An offline bundle may hold 4000 entries at 8 MB each, so a ~600 KB upload of entries that
  // claim 0 bytes inflates to maxTotalBytes (512 MB) in memory. Refusing entries that exceed
  // their own claim makes the claimed total a real bound.
  const z = await zipOf({ 'x.txt': Buffer.alloc(1024 * 1024, 0) }, { level: 9 });
  const cd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(10, cd + 24);
  const lh = z.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  z.writeUInt32LE(10, lh + 22);
  let out = null;
  try { out = await zipLib.readZip(z, { maxArchiveBytes: 1e7, maxEntries: 10, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 1e8 }); } catch { /* refused: safe */ }
  assert.ok(!out || out['x.txt'].length <= 10, `an entry claiming 10 bytes inflated to ${out && out['x.txt'].length}`);
});

test('[SAFE] zip: an entry named __proto__ does not pollute Object.prototype', async () => {
  const z = await zipOf({ '__proto__': Buffer.from('x'), 'constructor': Buffer.from('y'), 'manifest.json': Buffer.from('{}') });
  try { await zipLib.readZip(z, { maxArchiveBytes: 1e7, maxEntries: 10, maxFileBytes: 1e6, maxTotalBytes: 1e7 }); } catch { /* either way */ }
  assert.equal(Object.prototype.length, undefined);
  assert.equal(typeof ({}).readUInt8, 'undefined');
});

test('[BUG-11 LOW/functional] a template zipped by macOS Finder (folder + __MACOSX/) must still be found', async () => {
  const manifest = { id: 'mac-zip', name: 'Mac', version: '1.0.0', kind: 'slide', license: 'MIT' };
  const z = await zipOf({
    'mac-zip/manifest.json': Buffer.from(JSON.stringify(manifest)),
    'mac-zip/template.json': Buffer.from('{"template":{},"fields":{}}'),
    '__MACOSX/mac-zip/._template.json': Buffer.from('junk'),
  });
  const r = await zipLib.readTemplateZip(z).catch((e) => e);
  assert.ok(!(r instanceof Error), `readTemplateZip: ${r && r.message}`);
});

test('[SAFE] offline bundle: stray, duplicated and case-variant package paths are refused; unpinned packages ignored', async () => {
  freshCatalogState();
  const good = slideTemplate();
  const idx = indexFor([good], { serial: 1200 });
  const p = 'packages/lobby-welcome-1.0.0.sttemplate';
  await assert.rejects(catalog.importOfflineBundle(await zipOf({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, 'packages/Lobby-welcome-1.0.0.sttemplate': signedEnvelope(good) })), /unexpected file/);
  await assert.rejects(catalog.importOfflineBundle(await zipOf({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, [p]: signedEnvelope(good), ['./' + p]: signedEnvelope(slideTemplate({ files: { 'x.txt': Buffer.from('evil') } })) })), /two entries/);
  await assert.rejects(catalog.importOfflineBundle(await zipOf({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, 'packages/../index.json': Buffer.from('x') })), /unsafe path|two entries/);
  // A pinned path whose bytes do not hash to the pin is dropped, not stored.
  freshCatalogState();
  const r = await catalog.importOfflineBundle(await zipOf({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, [p]: signedEnvelope(slideTemplate({ files: { 'x.txt': Buffer.from('evil') } })) }));
  assert.equal(r.packages, 0);
  // A bundle for an unknown catalog is refused before anything is stored.
  const foreign = indexFor([], { catalogId: 'nope' });
  await assert.rejects(catalog.importOfflineBundle(await zipOf({ 'index.json': foreign.bytes, 'index.json.sig': foreign.sig })), /unknown catalog/);
});

test('[SAFE/TIMING] offline bundle with 4000 entries completes in < 10 s', async () => {
  freshCatalogState();
  const idx = indexFor([], { serial: 1300 });
  const entries = { 'index.json': idx.bytes, 'index.json.sig': idx.sig };
  for (let i = 0; i < 3998; i++) entries[`packages/p${i}.sttemplate`] = Buffer.from('{}');
  const z = await zipOf(entries, { level: 1 });
  const t0 = Date.now();
  const r = await catalog.importOfflineBundle(z);
  const t = Date.now() - t0;
  console.log(`# 4000-entry bundle (${z.length} bytes) imported in ${t} ms`);
  assert.equal(r.packages, 0);
  assert.ok(t < 10000);
  const tooMany = { ...entries, 'packages/p3998.sttemplate': Buffer.from('{}'), 'packages/p3999.sttemplate': Buffer.from('{}'), 'packages/p4000.sttemplate': Buffer.from('{}') };
  await assert.rejects(catalog.importOfflineBundle(await zipOf(tooMany, { level: 1 })), /more than 4000/);
});

/* =================================================================== store */

test('[SAFE] packagePath refuses anything but 64 lower-case hex', () => {
  for (const s of ['../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '/x', 'a'.repeat(64) + '\u0000', null, undefined]) {
    assert.throws(() => store.packagePath(s), /bad sha256/, String(s));
  }
  assert.ok(store.packagePath('a'.repeat(64)).endsWith(`${'a'.repeat(64)}.sttemplate`));
  assert.equal(store.loadPackage('../../../etc/passwd'), null);
});

test('[SAFE] a package file swapped on disk: the cached verified copy keeps serving; a cold load refuses the swap; no tmp files left', async () => {
  freshCatalogState();
  const row = catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  const first = store.loadPackage(row.sha256);
  assert.ok(first);
  fs.writeFileSync(store.packagePath(row.sha256), pkg.buildEnvelope(slideTemplate({ manifest: { name: 'Swapped' } })));
  // Stricter than a cache that keeps serving: a changed file stat drops the cached copy, and the
  // swapped bytes fail their hash, so nothing is served at all until the package is reinstalled.
  assert.equal(store.loadPackage(row.sha256), null, 'a swap on disk is noticed even while cached');
  store._clearCache();
  assert.equal(store.loadPackage(row.sha256), null);
  assert.deepEqual(fs.readdirSync(store.packagesDir()).filter((f) => f.endsWith('.tmp')), []);
});

test('[SAFE] uninstall keeps a package file still referenced by another catalog key', () => {
  freshCatalogState();
  appSettings.setBool(catalog.SETTING_UNSIGNED_CODE, false);
  const bytes = slideTemplate();
  const signed = catalog.importPackage(signedEnvelope(bytes), 'u1');
  const local = catalog.importPackage(pkg.buildEnvelope(bytes), 'u1');   // same sha, "local/…"
  assert.equal(signed.sha256, local.sha256);
  assert.equal(store.uninstall('local/lobby-welcome'), 1);
  store._clearCache();
  assert.ok(store.loadPackage(signed.sha256), 'the official install still loads');
});

test('[BUG-10 LOW/functional] uninstalling must not delete a package the offline bundle cached (air-gapped reinstall)', async () => {
  freshCatalogState();
  const good = slideTemplate();
  const idx = indexFor([good], { serial: 1400 });
  await catalog.importOfflineBundle(await zipOf({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, 'packages/lobby-welcome-1.0.0.sttemplate': signedEnvelope(good) }));
  appSettings.setBool(catalog.SETTING_ENABLED, false);
  catalog.setFetcher(async () => { throw new Error('air-gapped'); });
  await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1');
  store.uninstall('official/lobby-welcome');
  const again = await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1').catch((e) => e);
  assert.ok(!(again instanceof Error), `reinstall after uninstall: ${again && again.message}`);
});

/* =================================================================== maintainer CLI */

const NODE = process.execPath;
function cli(args, cwd) {
  const r = spawnSync(NODE, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function cliSandbox() {
  const dir = fs.mkdtempSync(path.join(TMP, 'cli-'));
  const keyFile = path.join(dir, 'test-catalog-key.pem');
  fs.writeFileSync(keyFile, official.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pubFile = path.join(dir, 'test-catalog-pub.pem');
  fs.writeFileSync(pubFile, OFFICIAL_PEM);
  const root = path.join(dir, 'templates');
  const t = path.join(root, 'news');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'manifest.json'), JSON.stringify({ id: 'news', name: 'News', version: '1.0.0', kind: 'html', license: 'MIT', network: ['api.example.com'] }));
  fs.writeFileSync(path.join(t, 'index.html'), '<!doctype html><p>news</p>');
  const dist = path.join(dir, 'dist');
  const b = cli(['build', root, '-o', dist], dir);
  assert.equal(b.code, 0, b.out);
  return { dir, keyFile, pubFile, root, dist, indexPath: path.join(dist, 'index.json') };
}
const readIndex = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeIndex = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

test('[SAFE] CLI sign refuses: package bytes ≠ index sha; a package of another id placed at the listed url', () => {
  const s = cliSandbox();
  const idx = readIndex(s.indexPath);
  const url = path.join(s.dist, idx.templates[0].versions[0].url);
  // (a) index lists sha A, file contains B.
  const orig = fs.readFileSync(url);
  fs.writeFileSync(url, pkg.buildEnvelope(htmlTemplate({ manifest: { id: 'news', network: ['evil.example.com'] } })));
  let r = cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir);
  assert.notEqual(r.code, 0); assert.match(r.out, /does not match the index/);
  // (b) the index sha updated to match, but the package is a different template id.
  const otherBytes = htmlTemplate({ manifest: { id: 'other-one' } });
  fs.writeFileSync(url, pkg.buildEnvelope(otherBytes));
  idx.templates[0].versions[0].sha256 = pkg.sha256Hex(otherBytes);
  writeIndex(s.indexPath, idx);
  r = cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir);
  assert.notEqual(r.code, 0); assert.match(r.out, /manifest says other-one/);
  fs.writeFileSync(url, orig);
});

test('[SAFE] CLI build refuses symlinks in a template folder and a re-published version with new bytes', () => {
  const s = cliSandbox();
  fs.symlinkSync('/etc/hostname', path.join(s.root, 'news', 'leak.txt'));
  let r = cli(['build', s.root, '-o', path.join(s.dir, 'dist2')], s.dir);
  assert.notEqual(r.code, 0); assert.match(r.out, /symlink/);
  fs.unlinkSync(path.join(s.root, 'news', 'leak.txt'));
  // --previous must be a SIGNED dist (verified with --pubkey).
  assert.equal(cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir).code, 0);
  fs.writeFileSync(path.join(s.root, 'news', 'index.html'), '<!doctype html><p>changed</p>');
  r = cli(['build', s.root, '-o', path.join(s.dir, 'dist3'), '--previous', s.dist, '--pubkey', s.pubFile], s.dir);
  assert.notEqual(r.code, 0); assert.match(r.out, /already published with different contents/);
});

test('[SAFE] CLI build --previous: a tampered previous package is carried over but then refused by sign', () => {
  const s = cliSandbox();
  assert.equal(cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir).code, 0);
  const idx = readIndex(s.indexPath);
  const rel = idx.templates[0].versions[0].url;
  fs.writeFileSync(path.join(s.dist, rel), pkg.buildEnvelope(htmlTemplate({ manifest: { id: 'news', network: ['evil.example.com'] } })));
  const dist2 = path.join(s.dir, 'dist-next');
  const b = cli(['build', s.root, '-o', dist2, '--previous', s.dist, '--pubkey', s.pubFile], s.dir);
  assert.equal(b.code, 0, b.out);
  const r = cli(['sign', dist2, '--key', s.keyFile, '--source', s.root], s.dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not match the index|NOT what the source builds/);
});

test('[BUG-05b MEDIUM] CLI sign must refuse an index whose kind/network disagree with the package manifest', () => {
  const s = cliSandbox();
  const idx = readIndex(s.indexPath);
  idx.templates[0].kind = 'slide';
  idx.templates[0].versions[0].network = [];
  writeIndex(s.indexPath, idx);
  const r = cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir);
  assert.notEqual(r.code, 0, `sign signed an index advertising "slide, no network" for an html package with network hosts:\n${r.out}`);
});

test('[BUG-13 LOW] CLI sign must refuse a version url outside packages/ (it currently reads AND rewrites a file outside the dist)', () => {
  const s = cliSandbox();
  const idx = readIndex(s.indexPath);
  const rel = idx.templates[0].versions[0].url;
  const outside = path.join(s.dir, 'outside');
  fs.mkdirSync(outside);
  fs.renameSync(path.join(s.dist, rel), path.join(outside, 'news-1.0.0.sttemplate'));
  idx.templates[0].versions[0].url = '../outside/news-1.0.0.sttemplate';
  writeIndex(s.indexPath, idx);
  const before = fs.readFileSync(path.join(outside, 'news-1.0.0.sttemplate'));
  const r = cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir);
  const after = fs.readFileSync(path.join(outside, 'news-1.0.0.sttemplate'));
  assert.ok(r.code !== 0 && before.equals(after), `sign exited ${r.code} and ${before.equals(after) ? 'left' : 'REWROTE'} a file outside the dist`);
});

test('[BUG-14 LOW] CLI build --previous must not copy files to paths outside the new dist', () => {
  const s = cliSandbox();
  const base = path.join(s.dir, 'trav');
  const prev = path.join(base, 'a', 'prev');
  const dist = path.join(base, 'b', 'c', 'dist');
  fs.mkdirSync(prev, { recursive: true });
  fs.writeFileSync(path.join(base, 'payload.sttemplate'), 'attacker bytes');
  writeIndex(path.join(prev, 'index.json'), { schema: 1, catalog: 'official', serial: 5, templates: [
    { id: 'ghost', versions: [{ version: '1.0.0', sha256: 'a'.repeat(64), url: '../../payload.sttemplate' }] },
  ] });
  cli(['build', s.root, '-o', dist, '--previous', prev], s.dir);
  const escaped = path.join(base, 'b', 'payload.sttemplate');
  assert.ok(!fs.existsSync(escaped), `build --previous wrote ${escaped}`);
});

test('[BUG-15 LOW] CLI verify must not report OK for a signed dist whose entries the server will silently drop', () => {
  const s = cliSandbox();
  assert.equal(cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir).code, 0);
  const idx = readIndex(s.indexPath);
  idx.templates[0].versions[0].url = 'packages/sub/../' + path.basename(idx.templates[0].versions[0].url);
  idx.serial += 1;
  const bytes = Buffer.from(JSON.stringify(idx, null, 2));
  fs.writeFileSync(s.indexPath, bytes);
  fs.writeFileSync(path.join(s.dist, 'index.json.sig'), signing.formatIndexSignature(signing.signIndex(bytes, official.privateKey)));
  assert.equal(catalog.validateIndex(idx).templates.length, 0, 'precondition: the server drops this entry');
  const r = cli(['verify', s.dist, '--pubkey', s.pubFile], s.dir);
  assert.notEqual(r.code, 0, `verify said OK for a dist the server would show as empty:\n${r.out}`);
});

test('[SAFE] CLI verify fails a tampered signed dist (package bytes or index bytes)', () => {
  const s = cliSandbox();
  assert.equal(cli(['sign', s.dist, '--key', s.keyFile, '--source', s.root], s.dir).code, 0);
  assert.equal(cli(['verify', s.dist, '--pubkey', s.pubFile], s.dir).code, 0);
  const idx = readIndex(s.indexPath);
  const url = path.join(s.dist, idx.templates[0].versions[0].url);
  const orig = fs.readFileSync(url);
  const env = pkg.parseEnvelope(orig);
  // Re-sign a different package with an OTHER key and drop it in: hash + signature both fail.
  fs.writeFileSync(url, signedEnvelope(htmlTemplate({ manifest: { id: 'news' } }), other.privateKey));
  assert.notEqual(cli(['verify', s.dist, '--pubkey', s.pubFile], s.dir).code, 0);
  fs.writeFileSync(url, orig);
  fs.appendFileSync(s.indexPath, ' ');
  assert.notEqual(cli(['verify', s.dist, '--pubkey', s.pubFile], s.dir).code, 0);
  assert.ok(env.signature);
});

test('[SAFE] CLI build --previous refuses a previous dist that is not signed', () => {
  const s = cliSandbox();   // built, never signed
  const r = cli(['build', s.root, '-o', path.join(s.dir, 'dist-x'), '--previous', s.dist, '--pubkey', s.pubFile], s.dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not signed by the catalog key/);
});
