'use strict';

/*
 * The LG webOS Signage shell (webos/). It wraps the web player in an installed app and bridges
 * the panel's power and update services to it over postMessage. Nothing here can run on a panel;
 * these check what a repo can check: the manifest is what LG's packager needs, the package the
 * build script assembles has the layout ares-package writes, the shell's JavaScript is valid and
 * degrades cleanly with no SCAP present, the server serves the artifact and the version the
 * shell polls, and the player's side of the bridge exists and declares only what the host said.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const WEBOS = path.join(ROOT, 'webos');
const appinfo = JSON.parse(fs.readFileSync(path.join(WEBOS, 'appinfo.json'), 'utf8'));

test('webos: appinfo.json carries what ares-package requires', () => {
  for (const k of ['id', 'version', 'vendor', 'type', 'main', 'title', 'icon', 'largeIcon']) {
    assert.ok(appinfo[k], `appinfo.json must set ${k}`);
  }
  assert.equal(appinfo.type, 'web');
  assert.match(appinfo.id, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'reverse-DNS id');
  assert.match(appinfo.version, /^\d+\.\d+\.\d+$/, 'webOS wants a strictly numeric x.y.z');
  for (const f of [appinfo.main, appinfo.icon, appinfo.largeIcon]) {
    assert.ok(fs.existsSync(path.join(WEBOS, f)), `${f} must exist next to appinfo.json`);
  }
});

test('webos: the app version is the server version, so bump-version keeps them together', () => {
  const pkg = require('../package.json').version.split('-')[0];
  assert.equal(appinfo.version, pkg, 'scripts/bump-version.sh stamps appinfo.json from VERSION');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'bump-version.sh'), 'utf8'), /webos\/appinfo\.json/);
});

test('webos: the build script is valid bash and assembles an installable-looking .ipk', () => {
  const script = path.join(WEBOS, 'build-ipk.sh');
  execFileSync('bash', ['-n', script]);
  const out = path.join(os.tmpdir(), `st-webos-${process.pid}.ipk`);
  try {
    execFileSync('bash', [script, out], { cwd: WEBOS, stdio: 'pipe' });
    const members = execFileSync('ar', ['t', out]).toString().trim().split('\n');
    assert.deepEqual(members, ['debian-binary', 'control.tar.gz', 'data.tar.gz'], 'the ar members, in this order');
    const data = execFileSync('bash', ['-c', `ar p "${out}" data.tar.gz | tar tzf -`]).toString();
    assert.match(data, new RegExp(`usr/palm/applications/${appinfo.id.replace(/\\./g, '\\\\.')}/appinfo\\.json`));
    assert.match(data, new RegExp(`usr/palm/packages/${appinfo.id.replace(/\\./g, '\\\\.')}/packageinfo\\.json`));
    assert.match(data, /applications\/[^/]+\/js\/app\.js/);
    assert.match(data, /applications\/[^/]+\/js\/device-control\.js/);
    const controlMembers = execFileSync('bash', ['-c', `ar p "${out}" control.tar.gz | tar tzf -`]).toString().trim().split('\n');
    const controlName = controlMembers.includes('./control') ? './control' : 'control';
    assert.ok(controlMembers.includes(controlName), 'control.tar.gz contains its control file');
    const control = execFileSync('bash', ['-c', `ar p "${out}" control.tar.gz | tar xzf - -O "${controlName}"`]).toString();
    assert.match(control, new RegExp(`^Package: ${appinfo.id}$`, 'm'));
    assert.match(control, new RegExp(`^Version: ${appinfo.version}$`, 'm'));
    assert.match(control, /^webOS(?:_package_format_version|-Package-Format-Version): 2$/m);
    // The build stamps js/app.js from appinfo.json, exactly as the Tizen build stamps from config.xml.
    assert.match(fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8'),
      new RegExp(`var APP_VERSION_FALLBACK = '${appinfo.version}';`));
  } finally {
    try { fs.unlinkSync(out); } catch { /* */ }
  }
});

test('webos: the shell scripts parse, and device-control degrades to nothing without SCAP', () => {
  for (const f of ['js/app.js', 'js/device-control.js']) {
    new vm.Script(fs.readFileSync(path.join(WEBOS, f), 'utf8'), { filename: f });
  }
  // A window with no cordova, no Power, no Storage: every capability must be absent and every
  // action must reject rather than throw, so the dashboard shows nothing that cannot work.
  const sandbox = { console: { log() {} }, Promise, JSON };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(WEBOS, 'js', 'device-control.js'), 'utf8'), sandbox);
  assert.ok(sandbox.STWebOS, 'the shell API is installed on window');
  assert.equal(sandbox.STWebOS.available(), false);
  assert.equal(sandbox.STWebOS.capabilities().length, 0, 'no capabilities without SCAP (cross-realm array, so compare length)');
  return sandbox.STWebOS.run('reboot').then(
    () => assert.fail('reboot with no SCAP must not succeed'),
    (e) => assert.match(String(e.message), /unsupported/));
});

test('webos: the server serves the artifact and the version the shell polls', () => {
  const ipk = require('../lib/ipk-cache');
  const v = ipk.versionJson({ version: '2.1.0', exists: true, size: 12345 });
  assert.deepEqual(v, { version: '2.1.0', available: true, size: 12345, url: '/webos/ScreenTinker.ipk' });
  assert.equal(ipk.versionJson({ version: '2.1.0', exists: false, size: 0 }).available, false,
    'a version with no file behind it must not send a panel to download nothing');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ["'/webos/version.json'", "'/webos/ScreenTinker.ipk'", "['/webos', '/webos/']"]) {
    assert.ok(server.includes(`app.get(${route}`), `server.js registers ${route}`);
  }
  assert.match(server, /ipkCache\.start\(\)/, 'the cache is started at boot like the .wgt one');
});

test('webos: the release pipeline builds and ships the .ipk, and finalize refuses a release without it', () => {
  const rel = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(rel, /webos\/build-ipk\.sh/);
  assert.match(rel, /ScreenTinker\.ipk brightsign/, 'bundled into the source tarball');
  const fin = fs.readFileSync(path.join(ROOT, 'scripts', 'finalize-release.sh'), 'utf8');
  assert.match(fin, /^ScreenTinker\.ipk$/m, 'in the explicit EXPECTED list');
});

test('webos: the player only forms a host bridge when a shell asks for one', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const bridge = player.slice(player.indexOf('const HOST = (() => {'), player.indexOf('h.send({ type: \'host:hello\' });'));
  assert.ok(bridge.length > 0, 'the HOST bridge exists');
  assert.match(bridge, /get\('host'\)/, 'it is opt-in via ?host=');
  assert.match(bridge, /window\.parent === window && !topLevelVega\)\) return null/, 'and only inside a frame, unless this is the Vega top window');
  assert.match(bridge, /platform === 'vega' && window\.parent === window/, 'the top-window exception is Vega-only');
  assert.match(bridge, /ev\.source !== window\.parent\) return/, 'it listens to the embedding window and nobody else');
  assert.match(bridge, /d\.source !== 'screentinker-host'\) return/);
});

test('webos: old browser engines keep the shell and load the legacy player in its iframe', () => {
  const shell = fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8');
  assert.match(shell, /supportsModernPlayer\(\) \? '\/player' : '\/player\/legacy'/);
  assert.match(shell, /function supportsLegacyPlayer\(\)/);
  assert.match(shell, /if \(!supportsLegacyPlayer\(\)\) \{ showUnsupported\(\); return; \}/,
    'pre-Chrome-53 panels receive an explanation before an incompatible player is mounted');
  assert.match(shell, /webOS 4 or newer is required/);
  assert.match(shell, /frame\.src = playerUrl\(\)/);
  assert.doesNotMatch(shell, /window\.location\.replace\(serverUrl \+ '\/player\/legacy'/);
});

test('webos: the player declares the host capabilities it was told about, and routes commands to them', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const start = player.indexOf('function declaredCapabilities()');
  const caps = player.slice(start, player.indexOf('return caps;', start) + 'return caps;'.length);
  assert.match(caps, /typeof HOST !== 'undefined' && HOST && HOST\.ready/, 'only after host:ready');
  assert.match(caps, /for \(const c of HOST\.caps\)/, 'and only what the shell listed');
  // Every command the dashboard can send for those capabilities reaches the shell.
  assert.match(player, /HOST\.can\('system\.reboot'\) && HOST\.command\('reboot'\)/);
  assert.match(player, /HOST\.can\('system\.reboot'\) && HOST\.command\('shutdown'\)/);
  assert.match(player, /HOST\.can\('system\.self_update'\) && HOST\.command\('update'\)/);
  assert.match(player, /HOST\.can\('display\.power'\)\) return HOST\.command\(on \? 'screen_on' : 'screen_off'\)/);
});

test('webos: the shell speaks the same vocabulary the dashboard gates its buttons on', () => {
  const dc = fs.readFileSync(path.join(WEBOS, 'js', 'device-control.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  for (const cap of ['system.reboot', 'display.power', 'system.self_update']) {
    assert.ok(dc.includes(`'${cap}'`), `shell announces ${cap}`);
    assert.ok(dashboard.includes(`can('${cap}')`), `dashboard gates on ${cap}`);
  }
  // And handles every command those capabilities unlock.
  for (const action of ['reboot', 'shutdown', 'screen_off', 'screen_on', 'update']) {
    assert.ok(dc.includes(`case '${action}':`), `shell handles ${action}`);
  }
});
