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

/*
 * Both packaging paths. CI packages with LG's ares-package; a machine without it gets the script's
 * own archive, which must be the SAME shape: plain ar member names, LG's control field names, the
 * app under usr/palm/applications/<id>/ with no "./" prefix. A panel reads one format, and a package
 * in any other was the kind of thing "it still failed to install" came back about.
 */
function checkIpk(out, id) {
  const members = execFileSync('ar', ['t', out]).toString().trim().split('\n');
  assert.deepEqual(members, ['debian-binary', 'control.tar.gz', 'data.tar.gz'], 'the ar members, in this order');
  // Plain member names, as ares-package and dpkg write them, never GNU ar's "name/" spelling.
  const raw = fs.readFileSync(out);
  assert.equal(raw.toString('latin1', 0, 8), '!<arch>\n');
  assert.equal(raw.toString('latin1', 8, 24), 'debian-binary   ', 'plain ar member name');
  assert.equal(execFileSync('bash', ['-c', `ar p "${out}" debian-binary`]).toString(), '2.0\n');
  const data = execFileSync('bash', ['-c', `ar p "${out}" data.tar.gz | tar tzf -`]).toString().trim().split('\n');
  for (const entry of data) assert.match(entry, /^usr\//, `every data entry is a plain usr/ path, got ${entry}`);
  const esc = id.replace(/\./g, '\\.');
  assert.ok(data.some((e) => new RegExp(`^usr/palm/applications/${esc}/appinfo\\.json$`).test(e)));
  assert.ok(data.some((e) => new RegExp(`^usr/palm/packages/${esc}/packageinfo\\.json$`).test(e)));
  assert.ok(data.some((e) => new RegExp(`^usr/palm/applications/${esc}/js/app\\.js$`).test(e)));
  assert.ok(data.some((e) => new RegExp(`^usr/palm/applications/${esc}/js/device-control\\.js$`).test(e)));
  const controlMembers = execFileSync('bash', ['-c', `ar p "${out}" control.tar.gz | tar tzf -`]).toString().trim().split('\n');
  assert.ok(controlMembers.includes('control'), 'control.tar.gz holds `control` at its root, not ./control');
  const control = execFileSync('bash', ['-c', `ar p "${out}" control.tar.gz | tar xzf - -O control`]).toString();
  assert.match(control, new RegExp(`^Package: ${esc}$`, 'm'));
  assert.match(control, new RegExp(`^Version: ${appinfo.version}$`, 'm'));
  assert.match(control, /^Architecture: all$/m);
  assert.match(control, /^webOS-Package-Format-Version: 2$/m, "LG's spelling of the field");
  const read = (member) => execFileSync('bash', ['-c', `ar p "${out}" data.tar.gz | tar xzf - -O "${member}"`]).toString();
  const packaged = JSON.parse(read(`usr/palm/applications/${id}/appinfo.json`));
  assert.equal(packaged.id, id);
  assert.equal(packaged.version, appinfo.version);
  const pkginfo = JSON.parse(read(`usr/palm/packages/${id}/packageinfo.json`));
  assert.equal(pkginfo.id, id);
  assert.equal(pkginfo.app, id);
  assert.equal(pkginfo.version, appinfo.version);
  // Not minified: the shell is hand-written ES5 for a webOS 4 panel's Chrome 53, and the stamps
  // the server and the tests look for must survive packaging.
  const app = read(`usr/palm/applications/${id}/js/app.js`);
  assert.match(app, new RegExp(`var APP_VERSION_FALLBACK = '${appinfo.version}';`));
  assert.match(app, /^\(function \(\) \{$/m, 'app.js is packaged as written, not minified');
  // And the server's reader (lib/ipk-cache.js) reads this archive as what it is.
  const ipk = require('../lib/ipk-cache');
  assert.deepEqual(ipk.readIpk(out), { id, version: appinfo.version });
  return { data, control, read };
}

const HAVE_ARES = (() => { try { execFileSync('bash', ['-c', 'command -v ares-package']); return true; } catch { return false; } })();

test('webos: the build script is valid bash and assembles an installable-looking .ipk', () => {
  const script = path.join(WEBOS, 'build-ipk.sh');
  execFileSync('bash', ['-n', script]);
  const out = path.join(os.tmpdir(), `st-webos-${process.pid}.ipk`);
  try {
    const log = execFileSync('bash', [script, out], { cwd: WEBOS, stdio: 'pipe' }).toString();
    assert.match(log, /verified\)/, 'the build checks its own output');
    assert.match(log, HAVE_ARES ? /with ares-package/ : /without ares-package/);
    checkIpk(out, appinfo.id);
    // The build stamps js/app.js from appinfo.json, exactly as the Tizen build stamps from config.xml.
    assert.match(fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8'),
      new RegExp(`var APP_VERSION_FALLBACK = '${appinfo.version}';`));
  } finally {
    try { fs.unlinkSync(out); } catch { /* */ }
  }
});

test('webos: the fallback packager (no ares-package on PATH) writes the same archive shape', () => {
  const script = path.join(WEBOS, 'build-ipk.sh');
  const out = path.join(os.tmpdir(), `st-webos-fallback-${process.pid}.ipk`);
  try {
    const log = execFileSync('bash', [script, out], { cwd: WEBOS, stdio: 'pipe', env: { ...process.env, PATH: '/usr/bin:/bin' } }).toString();
    assert.match(log, /without ares-package/);
    assert.match(log, /verified\)/);
    checkIpk(out, appinfo.id);
    if (HAVE_ARES) {
      // LG's own tool reads the hand-assembled archive exactly as it reads its own.
      const info = execFileSync('ares-package', ['-i', out]).toString();
      assert.match(info, new RegExp(`^Package: ${appinfo.id.replace(/\./g, '\\.')}$`, 'm'));
      assert.match(info, new RegExp(`^Version: ${appinfo.version}$`, 'm'));
    }
  } finally {
    try { fs.unlinkSync(out); } catch { /* */ }
  }
});

test('webos: the release workflow packages with a pinned ares-package', () => {
  const rel = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(rel, /npm i -g @webos-tools\/cli@\d+\.\d+\.\d+/, 'pinned, so a release is reproducible');
  assert.ok(rel.indexOf('@webos-tools/cli') < rel.indexOf('webos/build-ipk.sh'), 'installed before the build runs');
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
  const v = ipk.versionJson({ version: '2.1.0', exists: true, size: 12345 }, { exists: false });
  assert.deepEqual(v, {
    version: '2.1.0', available: true, size: 12345, url: '/webos/ScreenTinker.ipk',
    files: { 'ScreenTinker.ipk': true, 'com.lg.app.signage.ipk': false },
    versions: { 'ScreenTinker.ipk': '2.1.0' },
  });
  // Each build reports its own version: the two files on an instance can differ, and a Local mode
  // panel must compare itself against com.lg.app.signage.ipk, not against ScreenTinker.ipk.
  const both = ipk.versionJson({ version: '2.5.1', exists: true, size: 1 }, { version: '3.1.2', exists: true, size: 2 });
  assert.deepEqual(both.versions, { 'ScreenTinker.ipk': '2.5.1', 'com.lg.app.signage.ipk': '3.1.2' });
  const shell = fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8');
  assert.match(shell, /j\.versions && j\.versions\[IPK_FILE]\) \|\| j\.version/, 'the shell reads its own entry');
  assert.equal(ipk.versionJson({ version: '2.1.0', exists: false, size: 0 }).available, false,
    'a version with no file behind it must not send a panel to download nothing');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ["'/webos/version.json'", "'/webos/ScreenTinker.ipk'", "'/webos/com.lg.app.signage.ipk'", "['/webos', '/webos/']"]) {
    assert.ok(server.includes(`app.get(${route}`), `server.js registers ${route}`);
  }
  assert.match(server, /ipkCache\.start\(\)/, 'the cache is started at boot like the .wgt one');
});

test('webos: the release pipeline builds and ships the .ipk, and finalize refuses a release without it', () => {
  const rel = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(rel, /webos\/build-ipk\.sh/);
  assert.match(rel, /ScreenTinker\.ipk com\.lg\.app\.signage\.ipk brightsign/, 'both builds bundled into the source tarball');
  assert.match(rel, /build-ipk\.sh --app-id com\.lg\.app\.signage/, 'the Local mode build is built');
  assert.equal((rel.match(/^\s+com\.lg\.app\.signage\.ipk( \\)?$/gm) || []).length, 2, 'attached to the release and covered by provenance');
  const fin = fs.readFileSync(path.join(ROOT, 'scripts', 'finalize-release.sh'), 'utf8');
  assert.match(fin, /^ScreenTinker\.ipk$/m, 'in the explicit EXPECTED list');
  assert.match(fin, /^com\.lg\.app\.signage\.ipk$/m, 'and the Local mode build too');
});

test('webos: the player only forms a host bridge when a shell asks for one', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const bridge = player.slice(player.indexOf('const HOST = (() => {'), player.indexOf('h.send({ type: \'host:hello\' });'));
  assert.ok(bridge.length > 0, 'the HOST bridge exists');
  assert.match(bridge, /get\('host'\)/, 'it is opt-in via ?host=');
  assert.match(bridge, /window\.parent === window && !topLevelVega\)\) return null/, 'and only inside a frame, unless this is the Vega top window');
  // The top-window exception is the two shells whose page IS the top window: Vega and the iOS app.
  assert.match(bridge, /\(platform === 'vega' \|\| platform === 'ios'\) && window\.parent === window/, 'the top-window exception is Vega and iOS only');
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

/*
 * A panel in Local application launch mode installs only a package whose id is com.lg.app.signage,
 * named com.lg.app.signage.ipk, from the application/ folder of a USB stick (confirmed on real LG
 * panels by a customer, 2026-10). --app-id builds that without changing the committed manifest,
 * and the shell inside updates itself from that same file, never from ScreenTinker.ipk, which is
 * a different app to the panel.
 */
test('webos: --app-id builds the Local application mode package under its own id and file name', () => {
  const script = path.join(WEBOS, 'build-ipk.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-webos-local-'));
  const before = fs.readFileSync(path.join(WEBOS, 'appinfo.json'), 'utf8');
  try {
    const out = path.join(dir, 'com.lg.app.signage.ipk');
    execFileSync('bash', [script, '--app-id', 'com.lg.app.signage', out], { cwd: WEBOS, stdio: 'pipe' });
    const { data, read } = checkIpk(out, 'com.lg.app.signage');
    assert.ok(!data.some((e) => /com\.screentinker\.player/.test(e)), 'nothing left under the other id');
    assert.match(read('usr/palm/applications/com.lg.app.signage/js/app.js'), /var IPK_FILE = 'com\.lg\.app\.signage\.ipk';/,
      'it updates itself from the file it was installed as');

    // The default build is unchanged, and the committed manifest was never touched.
    const def = path.join(dir, 'ScreenTinker.ipk');
    execFileSync('bash', [script, def], { cwd: WEBOS, stdio: 'pipe' });
    const defData = execFileSync('bash', ['-c', `ar p "${def}" data.tar.gz | tar tzf -`]).toString();
    assert.match(defData, new RegExp(`applications/${appinfo.id.replace(/\./g, '\\.')}/`));
    assert.equal(fs.readFileSync(path.join(WEBOS, 'appinfo.json'), 'utf8'), before);
    assert.match(fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8'), /var IPK_FILE = 'ScreenTinker\.ipk';/,
      'the source keeps the default; only the packaged copy is stamped');

    assert.throws(() => execFileSync('bash', [script, '--app-id', 'Not An Id', out], { cwd: WEBOS, stdio: 'pipe' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('webos: the shell self-updates on the capability it announces, from its own file only', () => {
  const shell = fs.readFileSync(path.join(WEBOS, 'js', 'app.js'), 'utf8');
  const dc = fs.readFileSync(path.join(WEBOS, 'js', 'device-control.js'), 'utf8');
  // It asked for 'system.update', which nothing announces, so the poll never installed anything.
  assert.match(shell, /capabilities\(\)\.indexOf\('system\.self_update'\) < 0\) return;/);
  assert.ok(dc.includes("'system.self_update'"));
  assert.doesNotMatch(shell, /'system\.update'/);
  assert.doesNotMatch(shell, /\/webos\/ScreenTinker\.ipk/, 'the update URL comes from IPK_FILE');
  assert.match(shell, /serverUrl \+ '\/webos\/' \+ IPK_FILE/);
  // A Local mode build must not chase a file the server does not have, and an old server
  // (no `files`) only ever published ScreenTinker.ipk.
  assert.match(shell, /j\.files \? !j\.files\[IPK_FILE\] : IPK_FILE !== 'ScreenTinker\.ipk'/);
});

test('webos: the downloads page offers the Local mode build, and only when a file is behind it', () => {
  const di = require('../lib/download-index');
  const bare = di.entries({}).find((e) => e.id === 'webos-local');
  assert.ok(bare, 'a row exists');
  assert.equal(bare.available, false);
  assert.ok(bare.absent);
  const full = di.entries({ ipkLocal: { exists: true, size: 2048, version: '3.0.3' } }).find((e) => e.id === 'webos-local');
  assert.equal(full.available, true);
  assert.equal(full.url, '/webos/com.lg.app.signage.ipk');
  assert.equal(full.file, 'com.lg.app.signage.ipk');
});

test('webos: an SI server in Local mode is sent to com.lg.app.signage.ipk by its full https address, never ScreenTinker.ipk', () => {
  // A panel in Local launch mode upgrades its one Local app (id com.lg.app.signage) from the SI
  // server address and refuses any other id with "failed to upgrade IPK". The /webos page used to
  // point SI servers at ScreenTinker.ipk (reported from a real panel, 2026-11).
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const page = src.slice(src.indexOf("app.get(['/webos', '/webos/']"), src.indexOf("app.get(['/tizen', '/tizen/']"));
  assert.match(page, /SI server, Local application mode/);
  assert.match(page, /Fully Qualified Domain Name[\s\S]{0,120}\$\{base\}\/webos\/com\.lg\.app\.signage\.ipk/);
  assert.match(page, /Local Application Upgrade<\/b>: <b>Remote/);
  assert.match(page, /needs <code>com\.lg\.app\.signage\.ipk<\/code> instead/);
  const di = require('../lib/download-index');
  const rows = di.entries({ ipk: { exists: true }, ipkLocal: { exists: true } });
  assert.doesNotMatch(rows.find((e) => e.id === 'webos').what, /or an SI server\./);
  assert.match(rows.find((e) => e.id === 'webos-local').what, /SI server/);
});
