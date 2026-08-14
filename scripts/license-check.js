#!/usr/bin/env node
'use strict';

/*
 * Licence gate for the dependencies that actually SHIP.
 *
 *   node scripts/license-check.js [--sbom <path>] [--include-dev]
 *
 * Run from a PRODUCTION install (`npm ci --omit=dev`). That is the whole point: a developer
 * checkout carries `sharp`, whose `@img/sharp-wasm32` declares LGPL-3.0-or-later. It is a test
 * fixture generator, it is devDependencies-only, and it never reaches a server — but a scanner
 * pointed at a dev tree reports LGPL and contradicts the answer we give customers. Auditing the
 * installed production tree is what makes the answer defensible.
 *
 * Exits non-zero on anything denied or unresolved, so CI fails before a licence can arrive
 * unnoticed through a transitive bump.
 *
 * No dependencies, deliberately — a gate that needs its own supply chain audited is worth less.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const INCLUDE_DEV = args.includes('--include-dev');
const SBOM_OUT = args.includes('--sbom') ? args[args.indexOf('--sbom') + 1] : null;
const SERVER_DIR = path.join(__dirname, '..', 'server');

/* ── policy ───────────────────────────────────────────────────────────────────
 * ALLOW: permissive, no distribution obligation beyond keeping the notice.
 * DENY:  strong/network copyleft, plus licences we will not ship for other reasons.
 * Anything matching neither is REVIEW — it fails, and a human decides. Failing closed
 * matters more than being clever: the risk is a licence arriving that nobody looked at.
 */
const ALLOW = [
  /^MIT$/i, /^MIT-0$/i, /^ISC$/i, /^0BSD$/i, /^BSD-2-Clause$/i, /^BSD-3-Clause$/i,
  /^Apache-2\.0$/i, /^BlueOak-1\.0\.0$/i, /^Unlicense$/i, /^CC0-1\.0$/i, /^Python-2\.0$/i,
  /^WTFPL$/i, /^Zlib$/i, /^CC-BY-4\.0$/i,
];

const DENY = [
  { re: /\bAGPL/i,               why: 'network copyleft — obligations trigger on serving, not distributing' },
  { re: /\bGPL-[123]|\bGPLv[123]|(^|[^L])\bGPL\b/i, why: 'strong copyleft — links into a product we distribute commercially' },
  { re: /\bSSPL/i,               why: 'server-side public licence — not OSI-approved, service-scope obligations' },
  { re: /\bCommons-Clause/i,     why: 'commercial-use restriction' },
  { re: /\bBUSL|Business Source/i, why: 'source-available, not open source' },
  { re: /Good, not Evil|^JSON$/i,  why: 'JSON Licence — field-of-use clause, Apache Category X, non-free per Debian/Fedora' },
];

// Weak copyleft: file- or library-scoped, generally fine when merely linked, but never silently.
const REVIEW = [/\bLGPL/i, /\bMPL/i, /\bEPL/i, /\bCDDL/i, /\bOSL/i, /\bEUPL/i, /\bCPL/i];

/*
 * Packages that ship a real licence FILE but declare no `license` field in package.json.
 * Each entry records what was read off disk, so this is a documented finding rather than a
 * blanket exemption. Re-verify if the version changes.
 */
const EXCEPTIONS = {
  'exif-parser': { license: 'MIT', evidence: 'LICENSE.md — "The MIT License"' },
  'thirty-two':  { license: 'MIT', evidence: 'LICENSE.txt — MIT, Copyright (c) 2011 Chris Umbel' },
  'screentinker': { license: 'MIT', evidence: 'repository root LICENSE' },
};

function classify(id) {
  if (!id) return { verdict: 'UNKNOWN' };
  for (const d of DENY) if (d.re.test(id)) return { verdict: 'DENY', why: d.why };
  // A GPL-with-exception (Classpath, linking) is not the thing we are guarding against.
  if (/WITH .*exception/i.test(id)) return { verdict: 'REVIEW', why: 'copyleft with a linking exception' };
  for (const r of REVIEW) if (r.test(id)) return { verdict: 'REVIEW', why: 'weak copyleft' };
  // Composite expressions: every term must be allowed.
  const terms = id.split(/\s+(?:OR|AND)\s+|[()]/).map(s => s.trim()).filter(Boolean);
  if (terms.length && terms.every(t => ALLOW.some(a => a.test(t)))) return { verdict: 'ALLOW' };
  return { verdict: 'UNKNOWN' };
}

function readLicense(dir) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  let lic = pkg.license;
  if (lic && typeof lic === 'object') lic = lic.type;
  if (!lic && Array.isArray(pkg.licenses)) lic = pkg.licenses.map(l => l.type || l).join(' OR ');
  return { name: pkg.name, version: pkg.version, license: lic || null };
}

/*
 * `npm ls` exits non-zero for any tree problem — an extraneous package, a peer-dep complaint —
 * while still printing the full listing. Treating that as fatal would turn a routine tree quirk
 * into an unexplained CI failure, and worse, a licence check that never actually ran. Read the
 * output either way; a genuinely empty result is the only thing worth aborting on.
 */
function listInstalled() {
  const argv = ['ls', ...(INCLUDE_DEV ? [] : ['--omit=dev']), '--all', '--parseable'];
  const opts = { cwd: SERVER_DIR, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' };
  try {
    return execFileSync('npm', argv, opts);
  } catch (e) {
    if (e.stdout && e.stdout.trim()) return e.stdout;
    console.error('npm ls produced no output:\n' + (e.stderr || e.message));
    process.exit(2);
  }
}

const dirs = listInstalled().split('\n').filter(Boolean);

const pkgs = [];
const seen = new Set();
for (const d of dirs) {
  const info = readLicense(d);
  if (!info || !info.name) continue;
  const key = `${info.name}@${info.version}`;
  if (seen.has(key)) continue;
  seen.add(key);

  let license = info.license;
  let note = null;
  if (!license && EXCEPTIONS[info.name]) {
    license = EXCEPTIONS[info.name].license;
    note = `no license field; ${EXCEPTIONS[info.name].evidence}`;
  }
  pkgs.push({ ...info, license, note, ...classify(license) });
}

const denied = pkgs.filter(p => p.verdict === 'DENY');
const review = pkgs.filter(p => p.verdict === 'REVIEW');
const unknown = pkgs.filter(p => p.verdict === 'UNKNOWN');

const counts = pkgs.reduce((m, p) => (m[p.license || '(none)'] = (m[p.license || '(none)'] || 0) + 1, m), {});
console.log(`\nScope: ${pkgs.length} packages (${INCLUDE_DEV ? 'INCLUDING dev' : 'production only, --omit=dev'})\n`);
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([l, n]) => console.log(`  ${String(n).padStart(4)}  ${l}`));

if (SBOM_OUT) {
  // CycloneDX 1.5, hand-built. A standard format customers and underwriters recognise, without
  // taking a dependency on a generator to produce it.
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: 'screentinker',
        version: fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(),
        licenses: [{ license: { id: 'MIT' } }],
      },
      properties: [{ name: 'screentinker:scope', value: INCLUDE_DEV ? 'all' : 'production' }],
    },
    components: pkgs
      .filter(p => p.name !== 'screentinker')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        type: 'library',
        name: p.name,
        version: p.version,
        purl: `pkg:npm/${p.name.replace('@', '%40')}@${p.version}`,
        licenses: p.license ? [{ license: /[()]| OR | AND /.test(p.license) ? { name: p.license } : { id: p.license } }] : [],
      })),
  };
  fs.mkdirSync(path.dirname(SBOM_OUT), { recursive: true });
  fs.writeFileSync(SBOM_OUT, JSON.stringify(sbom, null, 2));
  console.log(`\nSBOM: ${SBOM_OUT} (${sbom.components.length} components, CycloneDX 1.5)`);
}

let failed = false;
if (denied.length) {
  failed = true;
  console.log('\nDENIED');
  denied.forEach(p => console.log(`  ${p.name}@${p.version}  ->  ${p.license}\n      ${p.why}`));
}
if (unknown.length) {
  failed = true;
  console.log('\nUNRESOLVED — no recognised licence. Read the package, then add it to EXCEPTIONS');
  console.log('with the evidence, or remove the dependency.');
  unknown.forEach(p => console.log(`  ${p.name}@${p.version}  ->  ${p.license || '(no license field)'}`));
}
if (review.length) {
  // Not fatal, but never silent — weak copyleft is a judgement call, and the judgement should be
  // made by a person who knows it is being made.
  console.log('\nREVIEW (not failing)');
  review.forEach(p => console.log(`  ${p.name}@${p.version}  ->  ${p.license}   ${p.why}`));
}

console.log(failed ? '\nFAIL: licence policy violated.\n' : '\nOK: no denied or unresolved licences.\n');
process.exit(failed ? 1 : 0);
