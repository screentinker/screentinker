'use strict';

/*
 * scripts/upgrade.sh warn_pinned_packages: a package in DATA_DIR pins its family (lib/package-cache.js,
 * first directory with ANY match wins). Prod kept offering Pi players 3.0.0 for six releases because
 * old .debs sat in DATA_DIR while every upgrade built the new one into native/dist. The upgrade must
 * SAY so (never move files: a pin can be deliberate), and stay quiet when nothing is hidden.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'upgrade.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');
const fn = src.match(/^warn_pinned_packages\(\) \{[\s\S]*?^\}$/m)[0];

function run(dataFiles, distFiles, { sameDir = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pin-'));
  const app = path.join(root, 'app');
  const data = path.join(app, 'server');
  const dist = path.join(app, 'native', 'dist');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const f of dataFiles) fs.writeFileSync(path.join(data, f), '');
  for (const f of distFiles) fs.writeFileSync(path.join(dist, f), '');
  const harness = `unit_env(){ :; }\n${fn}\nAPP_DIR=${JSON.stringify(app)}\n${sameDir ? `DATA_DIR=${JSON.stringify(dist)}\n` : ''}warn_pinned_packages\n`;
  const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.rmSync(root, { recursive: true, force: true });
  return { code: r.status, err: r.stderr };
}

test('an older Pi package in DATA_DIR is named as pinning the newer one in native/dist', () => {
  const r = run(['screentinker-pi_2.5.0_all.deb', 'screentinker-pi_3.0.0_all.deb'],
    ['screentinker-pi_3.2.5_all.deb', 'screentinker-pi_3.2.6_all.deb']);
  assert.equal(r.code, 0);
  assert.match(r.err, /Raspberry Pi player.*holds 3\.0\.0, which PINS it: the newer 3\.2\.6/);
  assert.match(r.err, /move the old copies out of/);
});

test('the Windows and macOS installers are checked the same way', () => {
  const r = run(['ScreenTinker-Setup-2.5.0.exe', 'ScreenTinker-3.0.0.dmg'],
    ['ScreenTinker-Setup-3.2.6.exe', 'ScreenTinker-3.2.6.dmg']);
  assert.match(r.err, /Windows player.*holds 2\.5\.0.*newer 3\.2\.6/);
  assert.match(r.err, /macOS player.*holds 3\.0\.0.*newer 3\.2\.6/);
});

test('quiet when DATA_DIR is as new or newer, empty, or the same directory', () => {
  assert.equal(run(['ScreenTinker-Setup-3.2.6.exe', 'ScreenTinker-Setup-2.5.0.exe'], ['ScreenTinker-Setup-3.2.6.exe']).err, '');
  assert.equal(run(['screentinker-pi_4.0.0_all.deb'], ['screentinker-pi_3.2.6_all.deb']).err, '', 'a newer pin is deliberate');
  assert.equal(run([], ['screentinker-pi_3.2.6_all.deb']).err, '');
  assert.equal(run([], ['screentinker-pi_3.2.6_all.deb'], { sameDir: true }).err, '');
});

test('a prerelease in native/dist does not count as newer than a release', () => {
  // 3.3.0~rc1 is never offered over a release (package-cache), so 3.2.6 in DATA_DIR hides nothing.
  assert.equal(run(['screentinker-pi_3.2.6_all.deb'], ['screentinker-pi_3.3.0~rc1_all.deb', 'screentinker-pi_3.2.6_all.deb']).err, '');
});
