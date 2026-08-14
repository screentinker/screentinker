#!/usr/bin/env node
'use strict';

/*
 * Licence gate for the APK.
 *
 *   node scripts/android-license-check.js [--sbom <path>]
 *
 * Resolves the real `releaseRuntimeClasspath` — every artifact that can end up inside the APK a
 * customer installs, transitive ones included — and checks each against android/licenses.json.
 *
 * Fails on an artifact nobody has recorded a licence for. That is the case worth catching:
 * org.json:json:20090211 reached customers because it arrived as a transitive dependency of
 * socket.io-client and nothing ever asked what licence it carried.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const POLICY = JSON.parse(fs.readFileSync(path.join(ANDROID, 'licenses.json'), 'utf8'));
const SBOM_OUT = process.argv.includes('--sbom') ? process.argv[process.argv.indexOf('--sbom') + 1] : null;

function resolveClasspath() {
  const out = execFileSync('./gradlew', ['-q', 'app:dependencies', '--configuration', 'releaseRuntimeClasspath'],
    { cwd: ANDROID, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const found = new Map();
  for (const raw of out.split('\n')) {
    // Gradle prints "group:name:requested -> resolved" when a version is upgraded; the resolved
    // one is what ships, so prefer the right-hand side.
    const m = raw.match(/([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+):([0-9][a-zA-Z0-9._-]*)(?:\s*->\s*([0-9][a-zA-Z0-9._-]*))?/);
    if (!m) continue;
    const [, group, name, requested, upgraded] = m;
    found.set(`${group}:${name}`, { group, name, version: upgraded || requested });
  }
  return [...found.values()].sort((a, b) => `${a.group}:${a.name}`.localeCompare(`${b.group}:${b.name}`));
}

function licenceFor(a) {
  const coord = `${a.group}:${a.name}`;
  if (POLICY.denied[coord]) return { verdict: 'DENY', why: POLICY.denied[coord].why };
  if (POLICY.artifacts[coord]) return { verdict: 'ALLOW', ...POLICY.artifacts[coord] };
  // Longest matching group prefix wins, so a specific rule beats a broad one.
  const groups = Object.keys(POLICY.groups)
    .filter(g => a.group === g || a.group.startsWith(g + '.'))
    .sort((x, y) => y.length - x.length);
  if (groups.length) return { verdict: 'ALLOW', ...POLICY.groups[groups[0]] };
  return { verdict: 'UNKNOWN' };
}

const artifacts = resolveClasspath();
if (!artifacts.length) {
  console.error('Resolved no artifacts — the gradle task did not run properly. Refusing to pass.');
  process.exit(2);
}

const results = artifacts.map(a => ({ ...a, ...licenceFor(a) }));
const denied = results.filter(r => r.verdict === 'DENY');
const unknown = results.filter(r => r.verdict === 'UNKNOWN');

for (const r of results.filter(r => r.verdict === 'ALLOW')) {
  for (const d of POLICY.denied_licenses) {
    if (new RegExp(d.match, 'i').test(r.license)) { denied.push({ ...r, why: `${r.license}: ${d.why}` }); }
  }
}

const counts = results.reduce((m, r) => (m[r.license || '(unrecorded)'] = (m[r.license || '(unrecorded)'] || 0) + 1, m), {});
console.log(`\nScope: ${results.length} artifacts on releaseRuntimeClasspath (everything that can enter the APK)\n`);
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([l, n]) => console.log(`  ${String(n).padStart(4)}  ${l}`));

if (SBOM_OUT) {
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: 'screentinker-android-player',
        version: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(),
        licenses: [{ license: { id: 'MIT' } }],
      },
    },
    components: results.map(r => ({
      type: 'library',
      name: `${r.group}:${r.name}`,
      version: r.version,
      purl: `pkg:maven/${r.group}/${r.name}@${r.version}`,
      licenses: r.license ? [{ license: { id: r.license } }] : [],
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
  denied.forEach(r => console.log(`  ${r.group}:${r.name}:${r.version}\n      ${r.why}`));
}
if (unknown.length) {
  failed = true;
  console.log('\nUNRECORDED — a new dependency reached the APK with no licence on file.');
  console.log('Look it up, then add it to android/licenses.json with evidence, or exclude it.');
  unknown.forEach(r => console.log(`  ${r.group}:${r.name}:${r.version}`));
}
console.log(failed ? '\nFAIL: licence policy violated.\n' : '\nOK: every artifact in the APK has a recorded, permitted licence.\n');
process.exit(failed ? 1 : 0);
