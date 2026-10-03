#!/usr/bin/env node
'use strict';

/*
 * The template catalog maintainer tool. Everything that touches the catalog's PRIVATE key is here,
 * and this runs on a maintainer's machine — never on a ScreenTinker server, never in CI.
 *
 *   keygen  <private-key.pem>                     make the catalog key pair (prints only the public key)
 *   pack    <template-dir|template.zip> [-o file]  folder/zip -> unsigned .sttemplate (author + CI)
 *   build   <templates-root> -o <dist> [--catalog official] [--previous <signed-old-dist> [--pubkey pem]]
 *                                                 CI: pack every template, write dist/index.json (unsigned)
 *   sign    <dist> --key <pem> --source <root>    maintainer: rebuild from reviewed source, then sign, in place
 *   verify  <dist|file.sttemplate> [--pubkey <pem>] check signatures and hashes (defaults to the official key)
 *   bundle  <dist> -o <offline.zip>               the air-gapped offline bundle of a signed dist
 *
 * ⚠️ BUILD AND SIGN ARE SEPARATE ON PURPOSE. A package's identity is sha256 of its canonical bytes,
 * not of the signed envelope, so CI can build and publish hashes from reviewed source without ever
 * holding the key, and a maintainer then signs exactly those bytes — `sign` refuses a dist whose
 * packages do not match the hashes in its own index. The key never needs to be a CI secret.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'server/lib/templates/package.js'));
const signing = require(path.join(ROOT, 'server/lib/templates/signing.js'));

function die(msg, code = 1) { console.error(msg); process.exit(code); }

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/* ---------------------------------------------------------------- reading an author's source */

const SKIP = new Set(['manifest.json', '.DS_Store', 'Thumbs.db']);

function readDirFiles(dir) {
  const files = {};
  (function walk(d, rel) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ent.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(d, ent.name);
      if (ent.isSymbolicLink()) die(`refusing symlink ${r}`);
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile()) {
        if (!rel && SKIP.has(ent.name)) continue;
        files[r] = fs.readFileSync(full);
      }
    }
  })(dir, '');
  return files;
}

async function readZipFiles(zipPath) {
  // Authors' zips only ever reach this CLI (and the dashboard's unverified import, which uses the
  // same caps via lib/templates/zip.js). One wrapper folder is stripped.
  const { readTemplateZip } = require(path.join(ROOT, 'server/lib/templates/zip.js'));
  return readTemplateZip(fs.readFileSync(zipPath));
}

async function packSource(src) {
  let manifest;
  let files;
  if (fs.statSync(src).isDirectory()) {
    const mf = path.join(src, 'manifest.json');
    if (!fs.existsSync(mf)) die(`${src}: no manifest.json`);
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { die(`${mf}: ${e.message}`); }
    files = readDirFiles(src);
  } else {
    ({ manifest, files } = await readZipFiles(src));
  }
  try {
    return pkg.buildPackageBytes(manifest, files);
  } catch (e) {
    die(`${src}: ${e.message}`);
  }
}

/* ---------------------------------------------------------------- dist safety */

const URL_RE = /^packages\/[a-z0-9][a-z0-9.-]{0,120}\.sttemplate$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/* An index url as a path inside the dist — and ONLY inside it. A `../` url in a tampered index
 * used to make `sign` read and rewrite a file outside the dist. */
function inDist(dist, rel) {
  if (typeof rel !== 'string' || !URL_RE.test(rel)) die(`index url ${JSON.stringify(String(rel).slice(0, 80))} is not a packages/<name>.sttemplate path`);
  const full = path.resolve(dist, rel);
  if (!full.startsWith(path.resolve(dist) + path.sep)) die(`index url ${rel} escapes the dist`);
  return full;
}

/* The same rules the server applies (lib/templates/catalog.js validateIndex), so the CLI never
 * calls "OK" an entry a server would silently drop, and never publishes a revocation a server
 * would refuse. */
function checkIndexShape(index) {
  const problems = [];
  if (index.schema !== 1) problems.push('schema must be 1');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(index.catalog))) problems.push('catalog id is invalid');
  if (!Number.isSafeInteger(index.serial) || index.serial < 1) problems.push('serial is invalid');
  if (!Number.isFinite(Date.parse(index.expires))) problems.push('expires is invalid');
  (index.revoked || []).forEach((r, i) => problems.push(...checkRevocation(r, i)));
  for (const t of index.templates || []) {
    if (!pkg.ID_RE.test(String(t.id))) problems.push(`template id ${JSON.stringify(t.id)} is invalid`);
    for (const v of t.versions || []) {
      if (!pkg.SEMVER_RE.test(String(v.version))) problems.push(`${t.id}: version ${JSON.stringify(v.version)} is invalid`);
      if (!SHA_RE.test(String(v.sha256))) problems.push(`${t.id}@${v.version}: sha256 is invalid`);
      if (!URL_RE.test(String(v.url))) problems.push(`${t.id}@${v.version}: url is invalid`);
    }
  }
  return problems;
}

function checkRevocation(r, i) {
  const out = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [`revoked[${i}] is not an object`];
  if (r.id != null && !pkg.ID_RE.test(String(r.id))) out.push(`revoked[${i}].id is invalid`);
  if (r.versions !== undefined && (!Array.isArray(r.versions) || r.versions.some((v) => v !== '*' && !pkg.SEMVER_RE.test(String(v))))) out.push(`revoked[${i}].versions must be "*" or x.y.z`);
  if (r.sha256 !== undefined && (!Array.isArray(r.sha256) || r.sha256.some((h) => !SHA_RE.test(String(h))))) out.push(`revoked[${i}].sha256 must be sha256 hex`);
  if (!r.id && !(Array.isArray(r.sha256) && r.sha256.length)) out.push(`revoked[${i}] names nothing`);
  return out;
}

function checkIndexAgainstManifest(t, v, manifest) {
  const out = [];
  if (t.kind !== manifest.kind) out.push(`${t.id}@${v.version}: index kind "${t.kind}" but the package is "${manifest.kind}"`);
  if ([...(v.network || [])].sort().join(',') !== [...(manifest.network || [])].sort().join(',')) out.push(`${t.id}@${v.version}: index network hosts differ from the package`);
  if ((v.min_server || '0.0.0') !== (manifest.min_server || '0.0.0')) out.push(`${t.id}@${v.version}: index min_server differs from the package`);
  return out;
}

/* ---------------------------------------------------------------- commands */

function cmdKeygen(a) {
  const out = a._[0];
  if (!out) die('usage: template-catalog.js keygen <private-key.pem>', 2);
  if (fs.existsSync(out)) die(`refusing to overwrite ${out}`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`private key written to ${out} (mode 0600) — keep it OFFLINE; see catalog/SIGNING.md\n`);
  console.log(`key_id ${signing.keyId(publicKey)}`);
  console.log('public key — embed as OFFICIAL_PUBLIC_KEY_PEM in server/lib/templates/signing.js:\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
}

async function cmdPack(a) {
  const src = a._[0];
  if (!src) die('usage: template-catalog.js pack <dir|zip> [-o out.sttemplate]', 2);
  const bytes = await packSource(src);
  const { manifest, sha256 } = pkg.parsePackageBytes(bytes);
  const out = a.out || `${manifest.id}-${manifest.version}.sttemplate`;
  fs.writeFileSync(out, pkg.buildEnvelope(bytes, null));
  console.log(`${out}  ${manifest.kind}  ${manifest.id}@${manifest.version}  sha256 ${sha256}  (unsigned)`);
}

function semverCmp(x, y) {
  const a = x.split('.').map(Number); const b = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function cmdBuild(a) {
  const root = a._[0];
  const dist = a.out;
  if (!root || !dist) die('usage: template-catalog.js build <templates-root> -o <dist> [--catalog id] [--previous <old-dist>]', 2);
  const catalog = typeof a.catalog === 'string' ? a.catalog : 'official';
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(catalog)) die('--catalog must be a short lower-case id');
  fs.mkdirSync(path.join(dist, 'packages'), { recursive: true });

  // Previously published versions stay listed (installed servers pin a version, and an update
  // prompt needs the history), unless revoked.
  let prev = { templates: [], serial: 0 };
  if (a.previous) {
    // The previous dist is only trusted as far as its signature: an unsigned or tampered one would
    // otherwise carry its versions (and bytes) straight into the next signed release.
    const prevBytes = fs.readFileSync(path.join(a.previous, 'index.json'));
    const sigFile = path.join(a.previous, 'index.json.sig');
    if (!fs.existsSync(sigFile) || !signing.verifyIndex(prevBytes, fs.readFileSync(sigFile, 'utf8'), pubFrom(a))) {
      die('--previous: its index.json is not signed by the catalog key (use --pubkey for a non-official catalog)');
    }
    prev = JSON.parse(prevBytes.toString('utf8'));
    const problems = checkIndexShape(prev);
    if (problems.length) die('--previous index is malformed:\n  ' + problems.join('\n  '));
    for (const t of prev.templates) for (const v of t.versions) inDist(a.previous, v.url);
  }
  const byId = new Map();
  for (const t of prev.templates || []) byId.set(t.id, { ...t, versions: [...t.versions] });

  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  for (const d of dirs) {
    const bytes = await packSource(path.join(root, d));
    const { manifest, sha256 } = pkg.parsePackageBytes(bytes);
    if (manifest.id !== d) die(`${d}: manifest.id "${manifest.id}" must equal the folder name`);
    // The catalog's licence rule (what WE redistribute): permissive only, never GPL/AGPL. A server
    // accepts other licences for a local import; the catalog never lists them.
    if (!pkg.SPDX_ALLOWED.has(manifest.license)) die(`${d}: licence "${manifest.license}" cannot be listed in the catalog (allowed: ${[...pkg.SPDX_ALLOWED].join(', ')})`);
    const rel = `packages/${manifest.id}-${manifest.version}.sttemplate`;
    const t = byId.get(manifest.id) || { id: manifest.id, versions: [] };
    const existing = t.versions.find((v) => v.version === manifest.version);
    if (existing && existing.sha256 !== sha256) {
      die(`${d}: version ${manifest.version} was already published with different contents — bump the version`);
    }
    const newest = t.versions.map((v) => v.version).sort(semverCmp).pop();
    if (!existing && newest && semverCmp(manifest.version, newest) <= 0) {
      die(`${d}: version ${manifest.version} must be greater than the published ${newest}`);
    }
    if (a.previous && existing && fs.existsSync(inDist(a.previous, rel))) {
      fs.copyFileSync(inDist(a.previous, rel), inDist(dist, rel));   // keep its signature
    } else {
      fs.writeFileSync(path.join(dist, rel), pkg.buildEnvelope(bytes, null));
    }
    Object.assign(t, {
      name: manifest.name, description: manifest.description, author: manifest.author, license: manifest.license,
      kind: manifest.kind, tags: manifest.tags, orientation: manifest.orientation, homepage: manifest.homepage,
    });
    // The library shows a thumbnail before anything is installed, so it is published beside the
    // package (catalog-relative, like the package url). It is only a picture: the dashboard loads
    // it as an <img>, and the package itself is what the signature and hash protect.
    if (manifest.thumbnail) {
      const { files } = pkg.parsePackageBytes(bytes);
      const ext = manifest.thumbnail.slice(manifest.thumbnail.lastIndexOf('.'));
      const thumbRel = `thumbs/${manifest.id}-${manifest.version}${ext}`;
      fs.mkdirSync(path.join(dist, 'thumbs'), { recursive: true });
      fs.writeFileSync(path.join(dist, thumbRel), files.get(manifest.thumbnail));
      t.thumbnail = thumbRel;
    }
    if (!existing) {
      t.versions.push({
        version: manifest.version, min_server: manifest.min_server, sha256, size: bytes.length, url: rel,
        network: manifest.network, params: manifest.params.length, published: new Date().toISOString().slice(0, 10),
      });
    }
    t.versions.sort((x, y) => semverCmp(y.version, x.version));
    byId.set(manifest.id, t);
    console.log(`packed ${rel}  ${sha256.slice(0, 16)}…`);
  }
  // Older versions from --previous that are not in this source tree still need their files.
  if (a.previous) {
    for (const t of byId.values()) for (const v of t.versions) {
      const dst = inDist(dist, v.url);
      const src = inDist(a.previous, v.url);
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
    // ...and so do the thumbnails of templates that exist only in the previous release.
    for (const t of byId.values()) {
      if (!t.thumbnail) continue;
      if (!/^thumbs\/[a-z0-9.-]{1,100}\.(png|jpe?g|webp)$/.test(t.thumbnail)) { delete t.thumbnail; continue; }
      const dst = path.join(dist, t.thumbnail);
      const src = path.join(a.previous, t.thumbnail);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.mkdirSync(path.join(dist, 'thumbs'), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }

  let revoked = [];
  const revFile = path.join(root, '..', 'revoked.json');
  if (fs.existsSync(revFile)) revoked = JSON.parse(fs.readFileSync(revFile, 'utf8'));
  // A revocation a server cannot parse makes it refuse the whole index — catch it here instead.
  if (!Array.isArray(revoked)) die('revoked.json must be an array');
  const revProblems = revoked.flatMap((r, i) => checkRevocation(r, i));
  if (revProblems.length) die('revoked.json:\n  ' + revProblems.join('\n  '));

  const now = new Date();
  const index = {
    schema: 1,
    catalog,
    // ⚠️ MONOTONIC. Servers refuse an index whose serial is lower than one they have already
    // accepted (rollback), so it is seconds since the epoch and can only go up.
    serial: Math.max(Math.floor(now.getTime() / 1000), (prev.serial || 0) + 1),
    generated: now.toISOString(),
    expires: new Date(now.getTime() + 45 * 86400e3).toISOString(),
    revoked,
    templates: [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
  };
  fs.writeFileSync(path.join(dist, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  try { fs.unlinkSync(path.join(dist, 'index.json.sig')); } catch { /* not signed yet */ }
  console.log(`index.json: ${index.templates.length} templates, serial ${index.serial} (UNSIGNED — run "sign")`);
}

/*
 * ⚠️ SIGN CHECKS THE DIST AGAINST THE REVIEWED SOURCE, not only against itself. Comparing a CI
 * dist's packages with the same dist's index proves the two agree — and an altered artifact whose
 * hashes were altered consistently agrees perfectly. So every version that is not already signed
 * must be rebuilt, here, from the reviewed source tree (--source, the merged checkout) and come out
 * byte-identical; versions that ARE already signed must verify under this key. Nothing else is
 * signed, and the summary is printed before anything is written.
 */
async function cmdSign(a) {
  const dist = a._[0];
  if (!dist || typeof a.key !== 'string' || typeof a.source !== 'string') {
    die('usage: template-catalog.js sign <dist> --key <private-key.pem> --source <reviewed templates-root>', 2);
  }
  const key = signing.loadPrivateKey(fs.readFileSync(a.key, 'utf8'));
  const pub = crypto.createPublicKey(key);
  const indexBytes = fs.readFileSync(path.join(dist, 'index.json'));
  const index = JSON.parse(indexBytes.toString('utf8'));
  const problems = checkIndexShape(index);

  // What the reviewed source builds to, by id.
  const fromSource = new Map();
  for (const d of fs.readdirSync(a.source, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.'))) {
    const bytes = await packSource(path.join(a.source, d.name));
    const p = pkg.parsePackageBytes(bytes);
    if (!pkg.SPDX_ALLOWED.has(p.manifest.license)) die(`${d.name}: licence "${p.manifest.license}" cannot be listed in the catalog`);
    fromSource.set(p.manifest.id, p);
  }

  const toSign = [];
  const plan = [];
  for (const t of index.templates) for (const v of t.versions) {
    const file = inDist(dist, v.url);
    const env = pkg.parseEnvelope(fs.readFileSync(file));
    if (env.sha256 !== v.sha256) problems.push(`${v.url}: sha256 ${env.sha256} does not match the index (${v.sha256})`);
    if (env.manifest.id !== t.id || env.manifest.version !== v.version) problems.push(`${v.url}: manifest says ${env.manifest.id}@${env.manifest.version}`);
    problems.push(...checkIndexAgainstManifest(t, v, env.manifest));
    const alreadySigned = !!signing.verifyPackage(env.packageBytes, env.signature, [{ id: 'k', label: 'k', key: pub }]);
    if (alreadySigned) { plan.push(`  keep    ${t.id}@${v.version} (already signed)`); continue; }
    const src = fromSource.get(t.id);
    if (!src || src.manifest.version !== v.version) {
      problems.push(`${t.id}@${v.version}: not signed yet, and the source tree does not contain this version — refusing to sign bytes nobody reviewed`);
      continue;
    }
    if (src.sha256 !== env.sha256) {
      problems.push(`${t.id}@${v.version}: the dist package (${env.sha256.slice(0, 16)}…) is NOT what the source builds to (${src.sha256.slice(0, 16)}…)`);
      continue;
    }
    plan.push(`  SIGN    ${t.id}@${v.version} ${t.kind}${(v.network || []).length ? ' network=' + v.network.join(',') : ''} sha256 ${env.sha256}`);
    toSign.push({ file, env });
  }
  if (problems.length) die('refusing to sign:\n  ' + problems.join('\n  '));
  console.log(`catalog "${index.catalog}" serial ${index.serial}, ${(index.revoked || []).length} revocation(s):`);
  console.log(plan.join('\n'));
  for (const { file, env } of toSign) fs.writeFileSync(file, pkg.buildEnvelope(env.packageBytes, signing.signPackage(env.packageBytes, key)));
  fs.writeFileSync(path.join(dist, 'index.json.sig'), signing.formatIndexSignature(signing.signIndex(indexBytes, key)));
  console.log(`signed ${toSign.length} new package(s) and index.json (key_id ${signing.keyId(pub)})`);
}

function pubFrom(a) {
  return typeof a.pubkey === 'string' ? signing.toPublicKey(fs.readFileSync(a.pubkey, 'utf8')) : signing.officialPublicKey();
}

function cmdVerify(a) {
  const target = a._[0];
  if (!target) die('usage: template-catalog.js verify <dist|file.sttemplate> [--pubkey pem]', 2);
  const key = pubFrom(a);
  const trusted = [{ id: 'cli', label: 'given key', key }];
  if (!fs.statSync(target).isDirectory()) {
    const env = pkg.parseEnvelope(fs.readFileSync(target));
    const ok = signing.verifyPackage(env.packageBytes, env.signature, trusted);
    console.log(`${env.manifest.id}@${env.manifest.version} sha256 ${env.sha256}: ${ok ? 'SIGNATURE OK' : env.signature ? 'BAD SIGNATURE / UNKNOWN KEY' : 'UNSIGNED'}`);
    process.exit(ok ? 0 : 1);
  }
  const indexBytes = fs.readFileSync(path.join(target, 'index.json'));
  const sigPath = path.join(target, 'index.json.sig');
  const idxOk = fs.existsSync(sigPath) && signing.verifyIndex(indexBytes, fs.readFileSync(sigPath, 'utf8'), key);
  console.log(`index.json: ${idxOk ? 'SIGNATURE OK' : 'NOT VERIFIED'}`);
  let bad = idxOk ? 0 : 1;
  const index = JSON.parse(indexBytes.toString('utf8'));
  const shape = checkIndexShape(index);
  for (const p of shape) { bad++; console.log(`  INDEX: ${p}`); }
  for (const t of index.templates) for (const v of t.versions) {
    try {
      if (!URL_RE.test(String(v.url))) throw new Error('url is not a packages/<name>.sttemplate path');
      const env = pkg.parseEnvelope(fs.readFileSync(inDist(target, v.url)));
      const hashOk = env.sha256 === v.sha256;
      const sigOk = !!signing.verifyPackage(env.packageBytes, env.signature, trusted);
      const mismatch = checkIndexAgainstManifest(t, v, env.manifest);
      if (!hashOk || !sigOk || mismatch.length) bad++;
      console.log(`  ${v.url}: hash ${hashOk ? 'ok' : 'MISMATCH'}, signature ${sigOk ? 'ok' : 'NOT VERIFIED'}${mismatch.length ? ', ' + mismatch.join('; ') : ''}`);
    } catch (e) { bad++; console.log(`  ${v.url}: ${e.message}`); }
  }
  process.exit(bad ? 1 : 0);
}

async function cmdBundle(a) {
  const dist = a._[0];
  if (!dist || !a.out) die('usage: template-catalog.js bundle <dist> -o <offline.zip>', 2);
  if (!fs.existsSync(path.join(dist, 'index.json.sig'))) die('the dist is not signed — run "sign" first');
  const archiver = require(path.join(ROOT, 'server/node_modules/archiver'));
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'index.json'), 'utf8'));
  const out = fs.createWriteStream(a.out);
  const zip = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((res, rej) => { out.on('close', res); zip.on('error', rej); });
  zip.pipe(out);
  const fixed = new Date('2000-01-01T00:00:00Z');
  zip.file(path.join(dist, 'index.json'), { name: 'index.json', date: fixed });
  zip.file(path.join(dist, 'index.json.sig'), { name: 'index.json.sig', date: fixed });
  // No thumbs/ in the bundle: an offline server reads thumbnails out of the packages it holds.
  for (const t of index.templates) for (const v of t.versions) {
    const f = inDist(dist, v.url);
    if (fs.existsSync(f)) zip.file(f, { name: v.url, date: fixed });
  }
  await zip.finalize();
  await done;
  console.log(`${a.out}: offline bundle (${fs.statSync(a.out).size} bytes)`);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  switch (cmd) {
    case 'keygen': return cmdKeygen(a);
    case 'pack': return cmdPack(a);
    case 'build': return cmdBuild(a);
    case 'sign': return cmdSign(a);
    case 'verify': return cmdVerify(a);
    case 'bundle': return cmdBundle(a);
    default: die('usage: template-catalog.js keygen|pack|build|sign|verify|bundle …  (see the header of this file)', 2);
  }
})().catch((e) => die(e.stack || e.message));
