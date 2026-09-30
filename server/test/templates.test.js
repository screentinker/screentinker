'use strict';

// Templates library: the trust chain from a catalog key to a document on a screen.
//
// Every property here is one an attacker would try to break: a package whose bytes differ from
// what was signed, a signature made for something else, an old index replayed, an index from one
// catalog passed off as another, a revoked template that keeps rendering, a template reaching the
// dashboard's origin. The happy paths are here to prove the refusals are not refusing everything.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-templates-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-templates-' + crypto.randomBytes(4).toString('hex');

// Test keys only: nothing here depends on, or could ever sign with, the real catalog key.
const official = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
process.env.TEMPLATE_CATALOG_PUBLIC_KEY = official.publicKey.export({ type: 'spki', format: 'pem' });

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
const appSettings = require('../lib/app-settings');

db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES ('u1','u1@test.local','platform_admin','x')").run();

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');

function slideTemplate(over = {}) {
  const manifest = {
    id: 'lobby-welcome', name: 'Lobby welcome', version: '1.0.0', kind: 'slide', license: 'MIT',
    thumbnail: 'thumbnail.png',
    params: [
      { name: 'headline', type: 'text', label: 'Headline', default: 'Welcome' },
      { name: 'accent', type: 'color', label: 'Accent', default: '#E8A33D' },
      { name: 'logo', type: 'image', label: 'Logo', default: 'tpl:logo.png' },
      { name: 'tz', type: 'timezone', label: 'Timezone', default: 'Europe/London' },
    ],
    ...over.manifest,
  };
  const doc = {
    template: {
      background: '#101418',
      elements: [
        { slot: 'headline', kind: 'head', box: { x: 5, y: 10, w: 90 }, style: { color: '{{param:accent}}', size_cqw: 6 } },
        { slot: 'logo', kind: 'image', box: { x: 80, y: 70, w: 15, h: 20 }, content_id: '{{param:logo}}' },
        { slot: 'clock', kind: 'clock', box: { x: 5, y: 80, w: 30 }, tz: '{{param:tz}}' },
      ],
    },
    fields: { headline: '{{param:headline}}' },
  };
  const files = { 'template.json': Buffer.from(JSON.stringify(doc)), 'thumbnail.png': PNG, 'logo.png': PNG, ...over.files };
  return pkg.buildPackageBytes(manifest, files);
}

function htmlTemplate(over = {}) {
  const manifest = {
    id: 'news-ticker', name: 'News ticker', version: '1.0.0', kind: 'html', license: 'MIT',
    network: ['api.example.com'],
    params: [{ name: 'title', type: 'text', label: 'Title', default: 'News' }, { name: 'bg', type: 'color', default: '#000000' }],
    ...over.manifest,
  };
  const files = {
    'index.html': Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t"></h1><img src="img/dot.png"><script src="app.js"></script></body></html>'),
    'style.css': Buffer.from('body{background:url(img/dot.png)}'),
    'app.js': Buffer.from('ST.ready(function(){document.getElementById("t").textContent=ST.values.title});'),
    'img/dot.png': PNG,
    ...over.files,
  };
  return pkg.buildPackageBytes(manifest, files);
}

function signedEnvelope(bytes, key = official.privateKey) {
  return pkg.buildEnvelope(bytes, signing.signPackage(bytes, key));
}

function makeIndex(entries, { serial = 100, catalogId = 'official', revoked = [], expires } = {}) {
  const index = {
    schema: 1, catalog: catalogId, serial, generated: new Date().toISOString(),
    expires: expires || new Date(Date.now() + 30 * 86400e3).toISOString(), revoked,
    templates: entries.map(({ bytes }) => {
      const { manifest, sha256 } = pkg.parsePackageBytes(bytes);
      return {
        id: manifest.id, name: manifest.name, kind: manifest.kind, license: manifest.license,
        versions: [{ version: manifest.version, sha256, url: `packages/${manifest.id}-${manifest.version}.sttemplate`, network: manifest.network }],
      };
    }),
  };
  const b = Buffer.from(JSON.stringify(index));
  return { bytes: b, sig: signing.formatIndexSignature(signing.signIndex(b, official.privateKey)) };
}

function freshCatalogState() {
  db.prepare('DELETE FROM templates_installed').run();
  db.prepare('DELETE FROM template_catalogs').run();
  db.prepare("DELETE FROM widgets WHERE widget_type = 'template'").run();
  store._clearCache();
  catalog.ensureOfficial();
}

/* =================================================================== package format */

test('package bytes are canonical: one package, one encoding, one hash', () => {
  const bytes = slideTemplate();
  const a = pkg.parsePackageBytes(bytes);
  // Same content, keys reordered / whitespace added -> refused, not re-hashed.
  const obj = JSON.parse(bytes.toString());
  const reordered = Buffer.from(JSON.stringify({ manifest: obj.manifest, files: obj.files }, null, 1));
  assert.throws(() => pkg.parsePackageBytes(reordered), /not canonical/);
  // A duplicate key (JSON.parse keeps the last one) is a second encoding too.
  const dup = Buffer.from(bytes.toString().replace('{"files":{', '{"files":{"x.txt":"eA==",').replace(/^/, ''));
  assert.throws(() => pkg.parsePackageBytes(dup));
  assert.equal(a.sha256, pkg.sha256Hex(bytes));
});

test('non-canonical base64 is refused (two strings must not decode to the same file)', () => {
  const obj = JSON.parse(slideTemplate().toString());
  obj.files['logo.png'] = obj.files['logo.png'].replace(/=*$/, '') + '\n';
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(pkg.canonicalJson(obj))), /base64/);
});

test('hostile file paths are refused', () => {
  const bad = ['../x.png', 'a/../../x.png', '.hidden.png', 'a/.git/config.txt', '/abs.png', 'C:/x.png', 'a\\b.png',
    'a/b/c/d/e/f.png', 'noext', 'x.exe', 'x.php', 'x.html/..', 'con\u0000.png', `${'a'.repeat(70)}.png`];
  for (const p of bad) {
    const obj = JSON.parse(slideTemplate().toString());
    obj.files[p] = PNG.toString('base64');
    assert.throws(() => pkg.parsePackageBytes(Buffer.from(pkg.canonicalJson(obj))), undefined, p);
  }
  // Case-insensitive duplicates mean different things on different filesystems.
  const obj = JSON.parse(slideTemplate().toString());
  obj.files['Logo.png'] = obj.files['logo.png'];
  assert.throws(() => pkg.parsePackageBytes(Buffer.from(pkg.canonicalJson(obj))), /case-insensitive/);
});

test('size caps are enforced on decoded bytes', () => {
  const big = Buffer.alloc(pkg.MAX_FILE_BYTES + 1, 1);
  assert.throws(() => slideTemplate({ files: { 'big.png': big } }), /larger than/);
  const files = {};
  for (let i = 0; i < 3; i++) files[`b${i}.png`] = Buffer.alloc(900 * 1024, i);
  assert.throws(() => slideTemplate({ files }), /larger than/);
});

test('manifest refusals: licences, hosts, ids, unknown keys, control characters', () => {
  // The parser only insists the licence is NAMED; which licences the catalog will list is the CLI's
  // rule (see the "catalog build refuses GPL" test), because it is about what we redistribute.
  assert.doesNotThrow(() => slideTemplate({ manifest: { license: 'GPL-2.0-only' } }));
  assert.throws(() => slideTemplate({ manifest: { license: 'GPL 3 or whatever' } }), /SPDX/);
  assert.throws(() => slideTemplate({ manifest: { license: '' } }), /required/);
  assert.throws(() => slideTemplate({ manifest: { network: ['x.com'] } }), /only html templates/);
  for (const h of ['https://x.com', 'x.com:443', '10.0.0.1', 'localhost', 'x.com/path', "x.com'; script-src *", 'X.COM']) {
    assert.throws(() => htmlTemplate({ manifest: { network: [h] } }), /not a hostname/, h);
  }
  assert.throws(() => slideTemplate({ manifest: { id: 'Bad_Id' } }), /manifest.id/);
  assert.throws(() => slideTemplate({ manifest: { version: '1.0' } }), /x.y.z/);
  assert.throws(() => slideTemplate({ manifest: { name: 'evil\u202Eexe.txt' } }), /control characters/);
  assert.throws(() => slideTemplate({ manifest: { sandbox: false } }), /unknown key/);
  assert.throws(() => slideTemplate({ manifest: { params: [{ name: 'x', type: 'password' }] } }), /not a known type/);
  assert.throws(() => slideTemplate({ manifest: { entry: 'missing.json' } }), /not in the package/);
});

test('envelope: unknown keys, bad signature shapes, oversized input', () => {
  const bytes = slideTemplate();
  const env = JSON.parse(pkg.buildEnvelope(bytes).toString());
  assert.throws(() => pkg.parseEnvelope(Buffer.from(JSON.stringify({ ...env, trusted: true }))), /unknown key/);
  assert.throws(() => pkg.parseEnvelope(Buffer.from(JSON.stringify({ ...env, format: 'x' }))), /unknown template format/);
  assert.throws(() => pkg.parseEnvelope(Buffer.from(JSON.stringify({ ...env, signature: { key_id: 'zz', sig: 'AA==' } }))), /key_id/);
  assert.throws(() => pkg.parseEnvelope(Buffer.alloc(pkg.MAX_ENVELOPE_BYTES * 2 + 1, 0x20)), /too large/);
});

/* =================================================================== signatures */

test('package signatures: verified by the right key only, and bound to the exact bytes', () => {
  const bytes = slideTemplate();
  const sig = signing.signPackage(bytes, official.privateKey);
  const trusted = [{ id: 'official', label: 'ScreenTinker', key: official.publicKey }];
  assert.equal(signing.verifyPackage(bytes, sig, trusted).id, 'official');
  // Different key.
  assert.equal(signing.verifyPackage(bytes, signing.signPackage(bytes, other.privateKey), trusted), null);
  // One flipped byte in the package.
  const tampered = Buffer.from(bytes); tampered[tampered.length - 5] ^= 1;
  assert.equal(signing.verifyPackage(tampered, sig, trusted), null);
  // Right signature, lying key_id.
  assert.equal(signing.verifyPackage(bytes, { ...sig, key_id: '0000000000000000' }, trusted), null);
});

test('domain separation: an index signature never verifies as a package signature, or vice versa', () => {
  const bytes = slideTemplate();
  const idxSig = signing.signIndex(bytes, official.privateKey);
  assert.equal(signing.verifyPackage(bytes, idxSig, [{ id: 'o', label: 'o', key: official.publicKey }]), null);
  const pkgSig = signing.signPackage(bytes, official.privateKey);
  assert.equal(signing.verifyIndex(bytes, signing.formatIndexSignature(pkgSig), official.publicKey), false);
  // And a raw Ed25519 signature over the bare bytes (no context) is not accepted as either.
  const raw = { key_id: signing.keyId(official.publicKey), sig: crypto.sign(null, bytes, official.privateKey) };
  assert.equal(signing.verifyPackage(bytes, raw, [{ id: 'o', label: 'o', key: official.publicKey }]), null);
  assert.equal(signing.verifyIndex(bytes, signing.formatIndexSignature(raw), official.publicKey), false);
});

test('the compiled-in official key is a real Ed25519 key and is NOT the support key', () => {
  const pem = signing.OFFICIAL_PUBLIC_KEY_PEM;
  const k = crypto.createPublicKey(pem);
  assert.equal(k.asymmetricKeyType, 'ed25519');
  const supportSrc = fs.readFileSync(path.join(__dirname, '../lib/support-access.js'), 'utf8');
  const b64 = pem.split('\n')[1];
  assert.ok(!supportSrc.includes(b64), 'the catalog key must be a separate key from the support desk key');
});

/* =================================================================== catalogs */

test('a signed index is accepted; a tampered or wrongly signed one is not', () => {
  freshCatalogState();
  const { bytes, sig } = makeIndex([{ bytes: slideTemplate() }]);
  const tampered = Buffer.from(bytes.toString().replace('Lobby welcome', 'Lobby welcomE'));
  assert.throws(() => catalog.acceptIndex('official', tampered, sig), /not signed/);
  const otherSig = signing.formatIndexSignature(signing.signIndex(bytes, other.privateKey));
  assert.throws(() => catalog.acceptIndex('official', bytes, otherSig), /not signed/);
  assert.equal(catalog.acceptIndex('official', bytes, sig).index.templates.length, 1);
});

test('rollback: an older serial is refused, and a changed index needs a new serial', () => {
  freshCatalogState();
  const newer = makeIndex([{ bytes: slideTemplate() }], { serial: 200 });
  catalog.acceptIndex('official', newer.bytes, newer.sig);
  const older = makeIndex([{ bytes: slideTemplate() }], { serial: 150 });
  assert.throws(() => catalog.acceptIndex('official', older.bytes, older.sig), /rollback/);
  const sameSerialDifferent = makeIndex([{ bytes: slideTemplate() }, { bytes: htmlTemplate() }], { serial: 200 });
  assert.throws(() => catalog.acceptIndex('official', sameSerialDifferent.bytes, sameSerialDifferent.sig), /without a new serial/);
  // The identical index again is fine (a re-fetch).
  assert.doesNotThrow(() => catalog.acceptIndex('official', newer.bytes, newer.sig));
});

test('an index signed for another catalog is refused even under the same key', () => {
  freshCatalogState();
  // An admin adds a second catalog that (by mistake) reuses a key... we refuse duplicate keys:
  assert.throws(() => catalog.addCatalog({ id: 'mirror', label: 'Mirror', url: 'https://m.example/', publicKey: process.env.TEMPLATE_CATALOG_PUBLIC_KEY }), /already exists/);
  // ...so prove the binding with a catalog that has its own key but is fed the official index.
  catalog.addCatalog({ id: 'community', label: 'Community', url: 'https://c.example/', publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) });
  const idx = { schema: 1, catalog: 'official', serial: 5, expires: new Date(Date.now() + 1e9).toISOString(), templates: [] };
  const b = Buffer.from(JSON.stringify(idx));
  assert.throws(() => catalog.acceptIndex('community', b, signing.formatIndexSignature(signing.signIndex(b, other.privateKey))), /is for catalog "official"/);
});

test('an index cannot point packages at another host or outside its directory', () => {
  assert.throws(() => catalog.resolveUrl('https://screentinker.github.io/templates/', 'https://evil.example/x'), /outside/);
  assert.throws(() => catalog.resolveUrl('https://screentinker.github.io/templates/', '//evil.example/x'), /outside/);
  assert.throws(() => catalog.resolveUrl('https://screentinker.github.io/templates/', '../other-repo/x'), /outside/);
  const v = catalog.validateIndex({ schema: 1, catalog: 'official', serial: 1, expires: new Date().toISOString(), templates: [
    { id: 'a-b', versions: [{ version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://evil/x' }, { version: '1.0.1', sha256: 'b'.repeat(64), url: '../x' }] },
  ] });
  assert.equal(v.templates.length, 0, 'versions with absolute or escaping urls are dropped');
});

test('the database cannot swap the official trust anchor', () => {
  freshCatalogState();
  db.prepare("UPDATE template_catalogs SET public_key = ? WHERE id = 'official'").run(other.publicKey.export({ type: 'spki', format: 'pem' }));
  catalog.ensureOfficial();
  const row = catalog.getCatalog('official');
  assert.equal(row.public_key, process.env.TEMPLATE_CATALOG_PUBLIC_KEY);
});

/* =================================================================== installing */

async function installOfficial(bytesList, opts) {
  const idx = makeIndex(bytesList.map((b) => ({ bytes: b })), opts);
  catalog.acceptIndex('official', idx.bytes, idx.sig);
  const files = {};
  for (const b of bytesList) {
    const { manifest } = pkg.parsePackageBytes(b);
    files[`packages/${manifest.id}-${manifest.version}.sttemplate`] = signedEnvelope(b);
  }
  catalog.setFetcher(async (url) => {
    const rel = url.replace('https://screentinker.github.io/templates/', '');
    if (files[rel]) return files[rel];
    throw new Error('404 ' + rel);
  });
  appSettings.setBool(catalog.SETTING_ENABLED, true);
  return files;
}

test('install from a catalog: the package must hash to what the signed index pins', async () => {
  freshCatalogState();
  const good = slideTemplate();
  const files = await installOfficial([good]);
  // Swap the served bytes for a different (even validly signed) package of the same id+version.
  const evil = slideTemplate({ files: { 'extra.txt': Buffer.from('x') } });
  files['packages/lobby-welcome-1.0.0.sttemplate'] = signedEnvelope(evil);
  await assert.rejects(catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1'), /does not match the catalog index/);
  files['packages/lobby-welcome-1.0.0.sttemplate'] = signedEnvelope(good);
  const row = await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1');
  assert.equal(row.trust, 'verified');
  assert.equal(row.id, 'official/lobby-welcome');
});

test('a package edited on disk after install is refused at load', async () => {
  freshCatalogState();
  const good = slideTemplate();
  await installOfficial([good]);
  const row = await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1');
  store._clearCache();
  const file = store.packagePath(row.sha256);
  const env = pkg.parseEnvelope(fs.readFileSync(file));
  const altered = pkg.buildPackageBytes({ ...env.manifest, name: 'Altered', params: env.manifest.params.map((p) => ({ ...p })) }, Object.fromEntries(env.files));
  fs.writeFileSync(file, pkg.buildEnvelope(altered, null));
  assert.equal(store.loadPackage(row.sha256), null);
});

test('import: a signed package is verified under its catalog; an unsigned one is "local" and unverified', () => {
  freshCatalogState();
  const signed = catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  assert.equal(signed.id, 'official/lobby-welcome');
  assert.equal(signed.trust, 'verified');
  const unsigned = catalog.importPackage(pkg.buildEnvelope(slideTemplate({ manifest: { id: 'my-slide' } })), 'u1');
  assert.equal(unsigned.id, 'local/my-slide');
  assert.equal(unsigned.trust, 'unverified');
  // A package signed by an unknown key is simply unverified, never "official".
  const foreign = catalog.importPackage(signedEnvelope(slideTemplate({ manifest: { id: 'foreign' } }), other.privateKey), 'u1');
  assert.equal(foreign.id, 'local/foreign');
  assert.equal(foreign.trust, 'unverified');
});

test('unsigned CODE templates are refused unless the admin switched that on', () => {
  freshCatalogState();
  appSettings.setBool(catalog.SETTING_UNSIGNED_CODE, false);
  assert.throws(() => catalog.importPackage(pkg.buildEnvelope(htmlTemplate()), 'u1'), /UNSIGNED code template/);
  assert.equal(catalog.importPackage(signedEnvelope(htmlTemplate()), 'u1').trust, 'verified');
});

test('an unsigned file cannot replace a verified install of the same template', () => {
  freshCatalogState();
  catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  // Unsigned lands under "local", so it cannot even address official/lobby-welcome:
  const r = catalog.importPackage(pkg.buildEnvelope(slideTemplate({ manifest: { version: '9.9.9' } })), 'u1');
  assert.equal(r.id, 'local/lobby-welcome');
  assert.equal(store.getInstalled('official/lobby-welcome').version, '1.0.0');
});

test('revocation reaches an existing install, renders it black, and a newer index can lift it', async () => {
  freshCatalogState();
  const good = slideTemplate();
  await installOfficial([good], { serial: 300 });
  await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1');
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES ('w-rev', 'u1', NULL, 'template', 'x', ?)")
    .run(JSON.stringify({ template: 'official/lobby-welcome', values: {} }));
  const before = tplWidget.renderTemplateWidget(db.prepare("SELECT * FROM widgets WHERE id='w-rev'").get());
  assert.match(before.html, /Welcome/);
  const revIdx = makeIndex([{ bytes: good }], { serial: 301, revoked: [{ id: 'lobby-welcome', versions: ['*'], reason: 'malicious' }] });
  catalog.acceptIndex('official', revIdx.bytes, revIdx.sig);
  assert.equal(store.getInstalled('official/lobby-welcome').status, 'revoked');
  const after = tplWidget.renderTemplateWidget(db.prepare("SELECT * FROM widgets WHERE id='w-rev'").get());
  assert.doesNotMatch(after.html, /Welcome/);
  await assert.rejects(catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1'), /revoked/);
  // Replaying the pre-revocation index to un-revoke it is a rollback.
  const replay = makeIndex([{ bytes: good }], { serial: 300 });
  assert.throws(() => catalog.acceptIndex('official', replay.bytes, replay.sig), /rollback/);
  const lifted = makeIndex([{ bytes: good }], { serial: 302 });
  catalog.acceptIndex('official', lifted.bytes, lifted.sig);
  assert.equal(store.getInstalled('official/lobby-welcome').status, 'active');
});

test('revocation by sha256 also catches unverified local copies of the same bytes', async () => {
  freshCatalogState();
  const bad = slideTemplate({ manifest: { id: 'copied' } });
  catalog.importPackage(pkg.buildEnvelope(bad), 'u1');
  const idx = makeIndex([], { serial: 400, revoked: [{ id: 'whatever', versions: ['*'], sha256: [pkg.parsePackageBytes(bad).sha256], reason: 'x' }] });
  catalog.acceptIndex('official', idx.bytes, idx.sig);
  assert.equal(store.getInstalled('local/copied').status, 'revoked');
  assert.throws(() => catalog.importPackage(pkg.buildEnvelope(bad), 'u1'), /revoked/);
});

test('offline bundle: verified exactly like an online index, packages kept only when pinned', async () => {
  freshCatalogState();
  const archiver = require('archiver');
  const good = slideTemplate();
  const idx = makeIndex([{ bytes: good }], { serial: 500 });
  async function zip(entries) {
    const a = archiver('zip');
    const chunks = [];
    a.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => a.on('end', r));
    for (const [n, b] of Object.entries(entries)) a.append(b, { name: n });
    a.finalize();
    await done;
    return Buffer.concat(chunks);
  }
  const unsignedZip = await zip({ 'index.json': idx.bytes, 'index.json.sig': signing.formatIndexSignature(signing.signIndex(idx.bytes, other.privateKey)) });
  await assert.rejects(catalog.importOfflineBundle(unsignedZip), /not signed/);
  const stray = await zip({ 'index.json': idx.bytes, 'index.json.sig': idx.sig, 'evil.js': Buffer.from('x') });
  await assert.rejects(catalog.importOfflineBundle(stray), /unexpected file/);
  const ok = await zip({
    'index.json': idx.bytes, 'index.json.sig': idx.sig,
    'packages/lobby-welcome-1.0.0.sttemplate': signedEnvelope(good),
    'packages/extra-1.0.0.sttemplate': signedEnvelope(slideTemplate({ manifest: { id: 'extra' } })),
  });
  const r = await catalog.importOfflineBundle(ok);
  assert.equal(r.packages, 1, 'only the pinned package is kept');
  appSettings.setBool(catalog.SETTING_ENABLED, false);   // air-gapped: no network at all
  catalog.setFetcher(async () => { throw new Error('network must not be used'); });
  const row = await catalog.installFromCatalog('official', 'lobby-welcome', null, 'u1');
  assert.equal(row.trust, 'verified');
});

test('zip bombs: real inflated bytes are counted, not the claimed sizes', async () => {
  const { readZip } = require('../lib/templates/zip');
  const archiver = require('archiver');
  const a = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  a.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => a.on('end', r));
  a.append(Buffer.alloc(20 * 1024 * 1024, 0), { name: 'big.txt' });
  a.finalize();
  await done;
  const buf = Buffer.concat(chunks);
  // Lie in the central directory: claim 10 bytes uncompressed.
  const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(10, cd + 24);
  const lh = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  buf.writeUInt32LE(10, lh + 22);
  await assert.rejects(readZip(buf, { maxArchiveBytes: 1e8, maxEntries: 10, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 }), /inflates past|larger than|corrupt/);
});

/* =================================================================== params */

test('param values are checked per type', () => {
  const p = (type, extra = {}) => ({ name: 'x', type, label: 'X', ...extra });
  assert.throws(() => params.checkValue(p('color'), 'red'), /hex colour/);
  assert.throws(() => params.checkValue(p('color'), '#fff;background:url(x)'), /hex colour/);
  assert.throws(() => params.checkValue(p('text', { max: 5 }), 'too long'), /at most 5/);
  assert.throws(() => params.checkValue(p('text'), 'a\nb'), /not allowed/);
  assert.throws(() => params.checkValue(p('timezone'), 'Europe/London"><script>'), /timezone/);
  assert.throws(() => params.checkValue(p('data_source'), 'a.b'), /data source/);
  assert.throws(() => params.checkValue(p('image'), 'tpl:../../etc/passwd'), /not in the template/);
  assert.throws(() => params.checkValue(p('image'), 'https://evil/x.png'), /content library/);
  assert.throws(() => params.checkValue(p('select', { options: [{ value: 'a', label: 'A' }] }), 'b'), /choices/);
  assert.equal(params.checkValue(p('number', { min: 0, max: 10 }), '7'), 7);
});

test('substitution walks the document: a value can never change its structure', () => {
  const ps = [{ name: 't', type: 'text' }];
  const doc = { a: '{{param:t}}', b: 'x {{param:t}} y', c: [{ d: '{{param:t}}' }], ['__proto__']: { polluted: '{{param:t}}' } };
  const out = params.substitute(JSON.parse(JSON.stringify(doc)), ps, { t: '", "evil": "1' });
  assert.equal(out.a, '", "evil": "1');
  assert.equal(out.evil, undefined);
  assert.equal({}.polluted, undefined);
});

/* =================================================================== rendering */

test('html render: sandbox CSP, declared hosts only, assets inlined, values unable to close the script', () => {
  const env = pkg.parseEnvelope(signedEnvelope(htmlTemplate()));
  const { html, csp } = render.buildHtmlDocument(env, { title: '</script><script>alert(1)</script>\u2028', bg: '#000000' }, {});
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src https:\/\/api\.example\.com wss:\/\/api\.example\.com/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  assert.ok(html.startsWith('<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'), 'the fence comes before any author byte');
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /src="data:text\/javascript;base64,/);
  assert.match(html, /href="data:text\/css;base64,/);
  assert.doesNotMatch(html, /src="app\.js"/);
  const valuesBlock = html.match(/<script id="st-values" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(valuesBlock).values.title, '</script><script>alert(1)</script>\u2028');
});

test('html render with no declared hosts: connect-src none', () => {
  const env = pkg.parseEnvelope(signedEnvelope(htmlTemplate({ manifest: { network: [] } })));
  assert.match(render.buildHtmlDocument(env, { title: 'x', bg: '#000' }, {}).csp, /connect-src 'none'/);
});

test('slide render: params land through normalizeSlide, tpl: images inline, no author script', () => {
  freshCatalogState();
  catalog.importPackage(signedEnvelope(slideTemplate()), 'u1');
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES ('w-s', 'u1', NULL, 'template', 'x', ?)")
    .run(JSON.stringify({ template: 'official/lobby-welcome', values: { headline: '<img src=x onerror=alert(1)>', accent: 'red;position:fixed', tz: 'Asia/Tokyo' } }));
  const out = tplWidget.renderTemplateWidget(db.prepare("SELECT * FROM widgets WHERE id='w-s'").get());
  assert.equal(out.csp, 'sandbox allow-scripts');
  assert.match(out.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out.html, /position:fixed/, 'an invalid colour falls back to the default');
  assert.match(out.html, /#E8A33D/i);
  assert.match(out.html, /data-tz="Asia\/Tokyo"|Asia\/Tokyo/);
  assert.match(out.html, /data:image\/png;base64,/);
});

test('a widget pointing at a template that is not installed renders black, not an error page', () => {
  const out = tplWidget.renderTemplateWidget({ id: 'x', workspace_id: null, config: JSON.stringify({ template: 'official/nope' }) });
  assert.match(out.html, /background:#000/);
  assert.match(out.csp, /sandbox/);
});

test('an empty data_source param never paints a raw {{ds:...}} token on the wall', () => {
  const bytes = pkg.buildPackageBytes({
    id: 'wx', name: 'Weather', version: '1.0.0', kind: 'slide', license: 'MIT',
    params: [{ name: 'weather', type: 'data_source', label: 'Weather' }],
  }, { 'template.json': Buffer.from(JSON.stringify({
    template: { elements: [{ slot: 't', kind: 'head', box: { x: 0, y: 0, w: 50 } }] },
    fields: { t: 'Now {{ds:{{param:weather}}.temperature}}°' },
  })) });
  const env = pkg.parseEnvelope(pkg.buildEnvelope(bytes));
  const cfg = render.buildSlideConfig(env, { weather: '' });
  assert.equal(cfg.fields.t, 'Now °');
  const bound = render.buildSlideConfig(env, { weather: 'office' });
  assert.equal(bound.fields.t, 'Now {{ds:office.temperature}}°');
});

test('the catalog build refuses a GPL template (what we list), though a server may import one', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(TMP, 'gpl-'));
  const t = path.join(dir, 'templates', 'gpl-thing');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'manifest.json'), JSON.stringify({ id: 'gpl-thing', name: 'G', version: '1.0.0', kind: 'html', license: 'GPL-2.0-only' }));
  fs.writeFileSync(path.join(t, 'index.html'), '<p>x</p>');
  const r = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/template-catalog.js'), 'build', path.join(dir, 'templates'), '-o', path.join(dir, 'dist')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /cannot be listed in the catalog/);
});

test('binary assets: never inlined, served by URL from a path-restricted CSP source, wasm allowed only when shipped', () => {
  const wasm = Buffer.from('0061736d01000000', 'hex');   // an empty but valid WebAssembly module
  const bytes = htmlTemplate({ manifest: { id: 'wasmy', network: [] }, files: { 'engine.wasm': wasm, 'index.html': Buffer.from('<script src="app.js"></script><img src="engine.wasm">') } });
  const env = pkg.parseEnvelope(pkg.buildEnvelope(bytes));
  const out = render.buildHtmlDocument(env, { title: 'x', bg: '#000' }, { origin: 'http://10.0.0.5:3000' });
  const base = `http://10.0.0.5:3000/api/templates/asset/${env.sha256}/`;
  assert.match(out.csp, new RegExp(`connect-src ${base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(out.csp, /script-src 'unsafe-inline' data: 'wasm-unsafe-eval'/);
  assert.doesNotMatch(out.html, /data:application\/wasm/, 'a binary asset is never inlined');
  assert.match(out.html, /"assets":\{"engine.wasm":"http:\/\/10\.0\.0\.5:3000\/api\/templates\/asset\//);
  // No .wasm in the package -> no wasm-unsafe-eval.
  const plain = pkg.parseEnvelope(pkg.buildEnvelope(htmlTemplate({ manifest: { network: [] } })));
  assert.doesNotMatch(render.buildHtmlDocument(plain, { title: 'x', bg: '#000' }, { origin: 'http://h' }).csp, /wasm-unsafe-eval/);
  // A hostile Host header cannot inject into the policy.
  for (const origin of ["http://evil; script-src *", 'http://a b', "http://x/'", 'javascript:alert(1)']) {
    const o = render.buildHtmlDocument(env, { title: 'x', bg: '#000' }, { origin });
    assert.doesNotMatch(o.csp, /evil|script-src \*|javascript/);
    assert.match(o.csp, /connect-src 'none'/);
  }
  // Binary assets are html-only and keep their own, larger cap.
  assert.throws(() => slideTemplate({ files: { 'x.wasm': wasm } }), /only html templates/);
  assert.throws(() => htmlTemplate({ files: { 'big.wasm': Buffer.alloc(pkg.MAX_ASSET_FILE_BYTES + 1) } }), /larger than/);
  assert.doesNotThrow(() => htmlTemplate({ files: { 'big.wasm': Buffer.alloc(3 * 1024 * 1024) } }));
});
