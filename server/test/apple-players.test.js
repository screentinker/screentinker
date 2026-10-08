'use strict';

/*
 * The macOS native player (native/screentinker_native/platform/macos) and the iPad/iPhone app (ios/).
 *
 * What has to hold on the server's side of them:
 *   - each is its own family, recognised on the signals it really sends and AHEAD of the Android and
 *     browser fallbacks that would otherwise swallow it;
 *   - their baselines claim nothing those players cannot do (a Mac never updates itself; an iOS web
 *     view has no media volume and no service worker for a server it cannot list in advance);
 *   - the web player knows the iOS shell exactly as it knows Vega's — shell identity, restart, platform
 *     'ios' — WITHOUT inheriting Vega's Fire TV rendering concessions, and withdraws audio.volume there;
 *   - /download/mac serves the .dmg and nothing else: no update check, and no rollback branch that could
 *     create an OTA rollout row for a family that never takes part in one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const caps = require('../lib/player-capabilities');
const di = require('../lib/download-index');

const ROOT = path.join(__dirname, '..', '..');
const PLAYER = fs.readFileSync(path.join(ROOT, 'server', 'player', 'index.html'), 'utf8');
const NATIVE = path.join(ROOT, 'native', 'screentinker_native');

function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is not in the player`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

/* ---- families ---------------------------------------------------------------------------- */

test('a Mac is family macos — by client_type, by platform, and ahead of the Android fallback', () => {
  const MAC = { client_type: 'mac', platform: 'macOS/15.1 (Mac mini (Mac14,3))', android_version: '' };
  assert.equal(caps.platformFamily(MAC), 'macos');
  assert.equal(caps.platformFamily({ client_type: 'mac' }), 'macos', 'client_type alone');
  assert.equal(caps.platformFamily({ platform: 'macOS/14.6 (iMac)' }), 'macos', 'platform alone');
  assert.equal(caps.platformFamily({ ...MAC, android_version: 'macOS 15.1' }), 'macos', '⚠️ never android');
  // Safari or Chrome opening /player on a Mac is a browser, and says so.
  assert.equal(caps.platformFamily({ client_type: 'player', platform: 'Safari 18', android_version: 'Web/Safari/605.1.15' }), 'web');
});

test('the iOS app is family ios; a Safari tab with the same URL stays a browser', () => {
  const IOS = { client_type: 'player', platform: 'ios', android_version: 'Web/Mobile/15E148' };
  assert.equal(caps.platformFamily(IOS), 'ios');
  assert.equal(caps.platformFamily({ ...IOS, platform: 'Safari 17' }), 'web');
  // 'ios' must not be found inside other platform strings.
  assert.equal(caps.platformFamily({ platform: 'Linux/Debian 13 (Raspberry Pi 5 bios)' }), 'linux');
});

/* ---- baselines --------------------------------------------------------------------------- */

test('BASELINE.macos is the Windows one: the shared engine only, and never self-update', () => {
  assert.deepEqual([...caps.BASELINE.macos].sort(), [...caps.BASELINE.windows].sort());
  for (const c of caps.BASELINE.macos) assert.ok(caps.BASELINE.linux.includes(c), `macos claims ${c}, which even the Pi baseline does not`);
  for (const c of ['system.self_update', 'system.reboot', 'system.install_apk', 'system.time']) {
    assert.equal(caps.BASELINE.macos.includes(c), false, `macos must not claim ${c}`);
  }
});

test('neither Apple player has audience counting: not in either baseline, and neither declares it', () => {
  assert.equal(caps.BASELINE.macos.includes('audience.camera'), false);
  assert.equal(caps.BASELINE.ios.includes('audience.camera'), false);
  assert.equal(caps.capabilitiesFor({ client_type: 'mac' }).includes('audience.camera'), false);
  assert.equal(caps.capabilitiesFor({ platform: 'ios' }).includes('audience.camera'), false);
  const nativeSrc = fs.readFileSync(path.join(NATIVE, 'capabilities.py'), 'utf8')
    + fs.readdirSync(path.join(NATIVE, 'platform', 'macos')).filter((f) => f.endsWith('.py'))
      .map((f) => fs.readFileSync(path.join(NATIVE, 'platform', 'macos', f), 'utf8')).join('\n');
  assert.doesNotMatch(nativeSrc, /audience\.camera/, 'the Mac player has no detector and must not declare one');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'ios', 'ScreenTinker', 'Core', 'HostProtocol.swift'), 'utf8'), /audience/);
});

test('BASELINE.ios is the web baseline minus media volume and the offline cache', () => {
  for (const c of caps.BASELINE.ios) assert.ok(caps.BASELINE.web.includes(c), `ios claims ${c}, which a browser does not have`);
  assert.equal(caps.BASELINE.ios.includes('audio.volume'), false, 'HTMLMediaElement.volume is read-only on iOS');
  assert.equal(caps.BASELINE.ios.includes('offline.cache'), false, 'no service worker for a server not listed at build time');
  assert.ok(caps.BASELINE.ios.includes('audio.mute'));
  assert.ok(caps.BASELINE.ios.includes('playback.video'));
});

test('the Mac player declares only vocabulary this server knows, and its baseline only what it declares', () => {
  const strings = (s) => [...s.matchAll(/['"]([a-z]+\.[a-z_]+)['"]/g)].map((m) => m[1]);
  const always = strings(fs.readFileSync(path.join(NATIVE, 'capabilities.py'), 'utf8'));
  const macDir = path.join(NATIVE, 'platform', 'macos');
  const opsSrc = fs.readFileSync(path.join(macDir, 'ops.py'), 'utf8');
  const withdrawn = strings((opsSrc.match(/UNSUPPORTED_CAPABILITIES = \(([^)]*)\)/) || [])[1] || '');
  assert.deepEqual(withdrawn, ['system.self_update']);
  const declared = new Set(always.filter((c) => !withdrawn.includes(c)));
  for (const f of fs.readdirSync(macDir).filter((f) => f.endsWith('.py'))) {
    if (f === 'ops.py') { for (const c of strings((opsSrc.split('def extra_capabilities')[1] || '').split('\ndef ')[0])) declared.add(c); continue; }
  }
  for (const c of declared) {
    if (/^(playback|audio|display|remote|system|net|sync|offline)\./.test(c)) {
      assert.ok(caps.CAP_SET.has(c), `the Mac player names '${c}', which this server would silently drop`);
    }
  }
  for (const c of caps.BASELINE.macos) assert.ok(declared.has(c), `BASELINE.macos claims ${c}, which the Mac player never declares`);
  assert.equal(declared.has('system.self_update'), false);
});

/* ---- the web player and the iOS shell ---------------------------------------------------- */

test('the page is the iOS app only when the WKWebView handler exists', () => {
  const fn = bodyOf(PLAYER, 'onIOS');
  const run = (search, webkit) => new Function('window', `${fn} return onIOS();`)({ location: { search }, webkit });
  const handler = { messageHandlers: { screentinker: { postMessage() {} } } };
  assert.equal(run('?host=ios', handler), true);
  assert.equal(run('?host=ios', undefined), false, 'Safari with a copied URL is a browser');
  assert.equal(run('?host=vega', handler), false);
  assert.equal(run('', handler), false);
  // And the register says so.
  assert.match(PLAYER, /onVega\(\) \? 'vega' : \(onIOS\(\) \? 'ios' : browserPlatform\(\)\)/);
});

test('the iOS shell keeps the pairing like Vega, and an id without its token is still refused', () => {
  const fn = bodyOf(PLAYER, 'vegaShellIdentity');
  const run = (scope) => new Function(...Object.keys(scope), `${fn} return vegaShellIdentity();`)(...Object.values(scope));
  const both = { deviceId: 'dev-1', deviceToken: 'tok-1' };
  assert.deepEqual(run({ vegaIdentityCleared: false, onIOS: () => true, HOST: { ready: true, info: both } }), both);
  assert.equal(run({ vegaIdentityCleared: false, onIOS: () => false, HOST: { ready: true, info: both } }), null, 'a browser is not the app');
  assert.equal(run({ vegaIdentityCleared: false, onIOS: () => true, HOST: { ready: true, info: { deviceId: 'dev-1' } } }), null);
  assert.equal(run({ vegaIdentityCleared: true, onIOS: () => true, HOST: { ready: true, info: both } }), null, 'a reset wins');
  // The shell-generic paths take iOS too: restart through the shell, mirror the identity, wait for host:ready.
  assert.match(bodyOf(PLAYER, 'clearVegaIdentity'), /typeof onIOS === 'function' && onIOS\(\)/);
  assert.match(PLAYER, /\(onVega\(\) \|\| onIOS\(\)\) && HOST && HOST\.command\('restart'\)/);
  assert.match(PLAYER, /HOST\.command\('set-identity'/);
});

test("iOS does NOT inherit Vega's Fire TV rendering concessions", () => {
  // These are about the stick's decoder and CMA, not about being a shell.
  assert.match(PLAYER, /if \(onVega\(\)\) \{ groupPreloadIdx = idx;/);
  assert.doesNotMatch(bodyOf(PLAYER, 'vegaWipeSize'), /onIOS/);
  assert.doesNotMatch(bodyOf(PLAYER, 'groupPreloadNext'), /onIOS/);
});

test('on iOS the player withdraws audio.volume from its own declaration', () => {
  const src = bodyOf(PLAYER, 'declaredCapabilities');
  const run = (ios) => {
    const sandbox = {
      console: { log() {}, warn() {} },
      navigator: {},
      document: { createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:,' }) },
      BS: null,
      swRegistrationFailed: false,
    };
    sandbox.window = sandbox;
    if (ios) sandbox.onIOS = () => true;
    vm.createContext(sandbox);
    vm.runInContext(`function transitionRuntimeReady() { return false; }\n${src}\nvar __out = declaredCapabilities();`, sandbox);
    return sandbox.__out;
  };
  assert.ok(run(false).includes('audio.volume'), 'a browser keeps it');
  assert.equal(run(true).includes('audio.volume'), false);
  assert.ok(run(true).includes('audio.mute'), 'mute works on iOS');
});

test('the iOS app speaks the host protocol, keeps the sign awake and autoplays', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, 'ios', p), 'utf8');
  const proto = read('ScreenTinker/Core/HostProtocol.swift');
  const screen = read('ScreenTinker/Player/PlayerScreen.swift');
  const url = read('ScreenTinker/Core/PlayerURL.swift');
  const app = read('ScreenTinker/App/ScreenTinkerApp.swift');
  assert.match(proto, /screentinker-player/);
  assert.match(proto, /screentinker-host/);
  assert.match(proto, /host:ready/);
  assert.match(proto, /"set-identity"/);
  assert.match(proto, /"clear-identity"/);
  assert.match(proto, /static let capabilities: \[String\] = \[\]/, 'the shell announces no powers iOS does not give it');
  assert.match(url, /name: "host", value: "ios"/);
  assert.match(screen, /name: Coordinator\.handlerName/);
  assert.match(screen, /static let handlerName = "screentinker"/);
  assert.match(screen, /mediaTypesRequiringUserActionForPlayback = \[\]/);
  assert.match(screen, /allowsInlineMediaPlayback = true/);
  assert.match(screen, /webViewWebContentProcessDidTerminate/);
  assert.match(app, /isIdleTimerDisabled = true/);
  // The project is generated, never committed.
  assert.ok(fs.existsSync(path.join(ROOT, 'ios', 'project.yml')));
  assert.equal(fs.existsSync(path.join(ROOT, 'ios', 'ScreenTinker.xcodeproj')), false);
});

/* ---- /download/mac ----------------------------------------------------------------------- */

test('/download/mac serves the .dmg, and there is no Mac update check or rollback path', async () => {
  const express = require('express');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mac-'));
  const file = path.join(dir, 'ScreenTinker-2.5.0.dmg');
  fs.writeFileSync(file, Buffer.from('dmg-bytes'));
  const fake = { get: () => ({ exists: true, version: '2.5.0', sha256: 'ab'.repeat(32), size: 9, path: file, filename: 'ScreenTinker-2.5.0.dmg' }) };
  const { createNativeUpdateRoutes } = require('../routes/native-update');
  let rolloutTouched = false;
  const rollout = require('../lib/ota-rollout');
  const savedGate = rollout.gate;
  rollout.gate = (...a) => { rolloutTouched = true; return savedGate(...a); };
  const mount = createNativeUpdateRoutes({ kind: 'mac', cache: fake, label: 'macOS disk image', contentType: 'application/x-apple-diskimage',
    missingReason: 'dmg-missing', hashingReason: 'dmg-hashing', selfUpdate: false });
  assert.equal(mount.CHECK_URL, null);
  assert.equal(mount.DOWNLOAD_URL, '/download/mac');
  const app = express();
  mount(app, { db: { prepare: () => ({ get: () => null }) }, getBand: () => 'normal' });
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const dl = await fetch(`http://127.0.0.1:${port}/download/mac`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'dmg-bytes');
    assert.match(dl.headers.get('content-disposition'), /ScreenTinker-2\.5\.0\.dmg/);
    assert.equal(dl.headers.get('x-package-sha256'), 'ab'.repeat(32));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/mac/update/check?version=1.0.0`)).status, 404, 'no update check for a Mac');
    assert.equal((await fetch(`http://127.0.0.1:${port}/download/mac?version=2.4.0`)).status, 404, 'no rollback package');
    assert.equal(rolloutTouched, false, 'the OTA rollout machinery is never consulted for a Mac');
  } finally {
    srv.close();
    rollout.gate = savedGate;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real mac route is the download-only factory, and the .dmg name is what build.sh produces', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mac-update.js'), 'utf8');
  assert.match(src, /selfUpdate: false/);
  const { DMG_RE } = require('../lib/mac-cache');
  assert.ok(DMG_RE.test('ScreenTinker-2.5.0.dmg'));
  assert.ok(DMG_RE.test('ScreenTinker-2.5.0~rc1.dmg'));
  assert.equal(DMG_RE.test('ScreenTinker-Setup-2.5.0.exe'), false);
  const build = fs.readFileSync(path.join(ROOT, 'native', 'packaging', 'macos', 'build.sh'), 'utf8');
  assert.match(build, /ScreenTinker-\$VERSION\.dmg/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/routes\/mac-update'\)\(app\)/);
  assert.match(server, /dmg: macCache\.get\(\)/);
});

test('the download hub offers the Mac .dmg only when one is hosted, and never offers the iOS app as a file', () => {
  const none = di.entries({});
  const mac = none.find((e) => e.id === 'macos-native');
  assert.ok(mac && mac.available === false && mac.absent && mac.fallback === '/player');
  const hosted = di.entries({ dmg: { exists: true, version: '2.5.0', size: 120_000_000, filename: 'ScreenTinker-2.5.0.dmg' } })
    .find((e) => e.id === 'macos-native');
  assert.equal(hosted.available, true);
  assert.equal(hosted.url, '/download/mac');
  assert.equal(hosted.file, 'ScreenTinker-2.5.0.dmg');
  const ios = none.find((e) => e.id === 'ios');
  assert.ok(ios && ios.available === false && ios.url === null, 'an iOS app installs only through Apple');
  assert.doesNotMatch(di.renderPage({}), /href="\/download\/ios/);
});
