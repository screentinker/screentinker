'use strict';

/*
 * The Vega OS shell (vega/) and the two lines in the web player that exist only for it.
 *
 * Nothing here runs on a stick. These check what a repo can check: the manifest names the
 * component the runtime will launch, the versions bump-version.sh stamps stay in lockstep,
 * the page only treats itself as Vega when the WebView bridge is actually there, and the
 * capability floor does not grant an Android power to a stick that has no such API.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
// Read from VERSION rather than pinning a literal: the point of the check below is that all three
// copies agree with the release, and a pinned literal only ever fails after the bump script has
// already done the right thing.
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const VERSION_RE = VERSION.replace(/\./g, '\\.');
const VEGA = path.join(ROOT, 'vega');
const pkg = JSON.parse(fs.readFileSync(path.join(VEGA, 'package.json'), 'utf8'));
const app = JSON.parse(fs.readFileSync(path.join(VEGA, 'app.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(VEGA, 'manifest.toml'), 'utf8');
const player = fs.readFileSync(path.join(ROOT, 'server/player/index.html'), 'utf8');
const caps = require('../lib/player-capabilities');

function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() missing`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name}() unbalanced`);
}

test('vega: the build targets the stick, not the simulator, and can actually bundle', () => {
  // OS 1.2 sticks are armv7 / KeplerScript 2. react-native-kepler does not register a build
  // command; kepler-cli-platform does, and on current SDKs that command is build-vega.
  // `vega build` alone archives a package with no JavaScript.
  assert.equal(pkg.dependencies['react-native'], '0.72.0');
  assert.equal(pkg.dependencies['@amazon-devices/react-native-kepler'], '~2.0.0');
  assert.equal(pkg.dependencies['@amazon-devices/kepler-file-system'], '~0.0.7');
  assert.equal(pkg.devDependencies['@amazon-devices/kepler-cli-platform'], '~0.22.14');
  assert.match(pkg.scripts['build:release'], /react-native build-vega --build-type Release --target armv7/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /build-kepler/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /vega build/);
  // Stock Metro 0.76 throws "Helpers are not supported by the default hub" on App.tsx.
  const metro = fs.readFileSync(path.join(VEGA, 'metro.config.js'), 'utf8');
  const seam = fs.readFileSync(path.join(VEGA, 'metro-babel-transformer.js'), 'utf8');
  assert.match(metro, /metro-babel-transformer\.js/);
  assert.match(seam, /cloneInputAst: true/);
  assert.equal(pkg.devDependencies['metro-react-native-babel-transformer'], '0.76.5');
  assert.equal(pkg.devDependencies['@babel/runtime'], '^7.20.0');
});

test('vega: manifest, app.json and package.json name the same component', () => {
  assert.equal(pkg.version, VERSION);
  assert.match(manifest, /^id = "com\.screentinker\.vega"$/m);
  assert.match(manifest, new RegExp(`^version = "${VERSION_RE}"$`, 'm'));
  assert.match(manifest, /id = "com\.screentinker\.vega\.main"/);
  assert.equal(app.name, 'com.screentinker.vega.main', 'AppRegistry name must be the interactive component id');
  assert.match(manifest, /com\.amazon\.webview\.renderer_service/);
  assert.match(manifest, /min = "1\.2"/);
  assert.match(manifest, /target = "1\.2"/);
  assert.match(manifest, /\/com\.amazon\.vega\.os@IVega_1_2/);
  assert.match(manifest, /com\.amazon\.media\.server/);
  assert.match(manifest, /com\.amazon\.audio\.control/);
  // A required privilege we do not have would make the package uninstallable. DRM is wants.
  assert.doesNotMatch(manifest, /^\[needs\]\n[\s\S]*privilege/m);
  assert.ok(fs.existsSync(path.join(VEGA, 'assets/image/app_icon.png')));
  assert.match(fs.readFileSync(path.join(VEGA, 'src/deviceInfo.ts'), 'utf8'),
    new RegExp(`APP_VERSION = '${VERSION_RE}'`));
});

test('vega: bump-version.sh stamps every copy of the version, and stages them', () => {
  const bump = fs.readFileSync(path.join(ROOT, 'scripts/bump-version.sh'), 'utf8');
  // The webOS/Tizen shells are here and not in their own suites because the failure is the same
  // one: a version literal the bump script does not stamp AND stage is stale in the tagged tree.
  for (const f of ['vega/package.json', 'vega/manifest.toml', 'vega/src/deviceInfo.ts',
    'webos/js/app.js', 'tizen/js/app.js']) {
    assert.match(bump, new RegExp(f.replace(/\//g, '\\/')), `bump-version.sh must stamp ${f}`);
    const staged = bump.slice(bump.indexOf('git add '));
    assert.match(staged, new RegExp(f.replace(/\//g, '\\/')));
  }
});

test('vega: finalize-release.sh ships the .vpkg, and refuses a stale one', () => {
  const fin = fs.readFileSync(path.join(ROOT, 'scripts/finalize-release.sh'), 'utf8');
  // It must UPLOAD the package, not merely expect it: an EXPECTED entry nothing uploads turns
  // every future finalize into a failure AFTER the APK has already gone up.
  assert.match(fin, /gh release upload[^\n]*"\$VPKG"/, 'finalize must upload the .vpkg');
  assert.match(fin, /screentinker-vega_armv7\.vpkg/);
  // vega/build/ is gitignored and nothing ever clears it, so the file sitting there may belong to
  // an older release. The version comes from vpkg-info.json, and a mismatch has to be fatal.
  assert.match(fin, /vpkg-info\.json/);
  assert.match(fin, /\[ "\$VPKG_VERSION" != "\$VERSION" \]/, 'finalize must compare the declared version');
});

test('the webOS and Tizen shells carry this release\'s version literal', () => {
  // Both builds stamp these from appinfo.json / config.xml, so a stale literal never reaches a
  // shipped package - it reaches the SOURCE TARBALL, and a test run rewrites it under you.
  for (const f of ['webos/js/app.js', 'tizen/js/app.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'),
      new RegExp(`var APP_VERSION_FALLBACK = '${VERSION_RE}';`), `${f} is not on ${VERSION}`);
  }
});

test('vega: the page is Vega only when the WebView bridge exists', () => {
  assert.match(player, /function onVega\(\)/);
  assert.match(player, /ReactNativeWebView/);
  assert.match(player, /onVega\(\) \? 'vega'/);
  // The second decoder is the concession, and it is gated on the shell, not the query string.
  assert.match(player, /if \(onVega\(\)\) \{ groupPreloadIdx = idx;/);
  assert.match(bodyOf(player, 'groupPreloadNext'), /CMA/);
  // Transitions are not withheld. The image path that ran on the stick is not gated, and the
  // video path uses the same wantsWipe a browser does. The CMA bound is the capture size.
  assert.match(player, /const wantsWipe = !!\(t && Array\.isArray\(t\.effects\) && t\.effects\.length && transitionRuntimeReady\(\)\)/);
  assert.doesNotMatch(player, /const wantsWipe = !\(typeof onVega/);
  assert.doesNotMatch(bodyOf(player, 'renderImageBuffered'), /onVega/);
  assert.match(player, /function vegaWipeSize\(/);
  assert.match(bodyOf(player, 'fitToCanvas'), /vegaWipeSize\(/);
  assert.match(bodyOf(player, 'runGlWipe'), /releaseWipeBitmap\(/);
  assert.match(bodyOf(player, 'vegaWipeSize'), /longEdge = 960/);
  assert.match(bodyOf(player, 'vegaWipeSize'), /typeof onVega === 'function' && onVega\(\)/);
  // Video wipes run, but the outgoing decoder does not stay up next to the incoming warm-play.
  assert.match(player, /if \(!wantsWipe \|\| \(typeof onVega === 'function' && onVega\(\)\)\) outgoing\.pause\(\)/);
});

test('vega: pairing in /data survives a WebView clear, and a reset forgets it', () => {
  const storage = fs.readFileSync(path.join(VEGA, 'src/storage.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(VEGA, 'src/App.tsx'), 'utf8');
  // The URL write merges. Replacing the file would drop a pairing that had already survived one clear.
  assert.match(storage, /saved\.serverUrl = serverUrl/);
  assert.match(storage, /saved\.deviceId = deviceId/);
  assert.match(storage, /delete saved\.deviceId/);
  assert.match(storage, /delete saved\.deviceToken/);
  assert.match(appSrc, /action === 'set-identity'/);
  assert.match(appSrc, /action === 'clear-identity'/);
  assert.match(appSrc, /deviceId: pairing\.deviceId, deviceToken: pairing\.deviceToken/);
  // The page adopts only when the shell has actually spoken, and it mirrors both halves or neither.
  assert.match(player, /function vegaShellIdentity\(\)/);
  assert.match(player, /HOST\.command\('set-identity'/);
  assert.match(player, /HOST\.command\('clear-identity'\)/);
  assert.match(player, /clearVegaIdentity\(\)/);
  // An id without its token is not adopted. That is the duplicate-row bug.
  const fn = bodyOf(player, 'vegaShellIdentity');
  const run = (scope) => new Function(...Object.keys(scope), `${fn} return vegaShellIdentity();`)(...Object.values(scope));
  const both = { deviceId: 'dev-1', deviceToken: 'tok-1' };
  assert.deepEqual(run({ vegaIdentityCleared: false, onVega: () => true, HOST: { ready: true, info: both } }), both);
  assert.equal(run({ vegaIdentityCleared: true, onVega: () => true, HOST: { ready: true, info: both } }), null, 'a reset this session wins');
  assert.equal(run({ vegaIdentityCleared: false, onVega: () => false, HOST: { ready: true, info: both } }), null, 'a browser is not a stick');
  assert.equal(run({ vegaIdentityCleared: false, onVega: () => true, HOST: { ready: true, info: { deviceId: 'dev-1' } } }), null, 'id without token');
  assert.equal(run({ vegaIdentityCleared: false, onVega: () => true, HOST: { ready: false, info: both } }), null, 'not before the shell speaks');
  // The protocol comment used to say the bridge carries no secrets. It now carries deviceToken.
  // That sentence is what a later change would trust before logging a message whole.
  assert.doesNotMatch(player, /Messages carry no secrets/);
  assert.match(player, /The bridge does carry one secret: the pairing/);
  assert.match(player, /buildDeviceInfo copies/);
});

test('vega: the capability floor is the web player minus Android powers these sticks do not have', () => {
  assert.equal(caps.platformFamily({ platform: 'vega', android_version: 'Web/Chrome' }), 'vega');
  const floor = caps.BASELINE.vega;
  for (const c of ['playback.video', 'playback.zones', 'playback.youtube', 'playback.transitions', 'offline.cache', 'audio.volume', 'audio.mute', 'system.restart_player']) {
    assert.ok(floor.includes(c), `vega floor should include ${c}`);
  }
  for (const c of ['system.reboot', 'system.kiosk', 'display.power', 'system.self_update', 'playback.rtsp']) {
    assert.equal(floor.includes(c), false, `vega floor must not include ${c}`);
  }
  // Transitions and the worker cache were measured on an AFTCA002. They are not the omission.
  assert.ok(floor.includes('playback.transitions'));
  assert.ok(floor.includes('offline.cache'));
  // A declared stick still wins over the floor.
  const declared = caps.capabilitiesFor({ platform: 'vega', capabilities: JSON.stringify(['playback.video']) });
  assert.deepEqual(declared, ['playback.video']);
});

test('vega: the shell speaks the host protocol and does not announce a power it lacks', () => {
  const appSrc = fs.readFileSync(path.join(VEGA, 'src/App.tsx'), 'utf8');
  assert.match(appSrc, /screentinker-player/);
  assert.match(appSrc, /screentinker-host/);
  assert.match(appSrc, /host:hello/);
  assert.match(appSrc, /host:ready/);
  assert.match(appSrc, /action === 'restart'/);
  assert.match(appSrc, /mediaPlaybackRequiresUserAction=\{false\}/);
  assert.match(appSrc, /useSetLifespanCallback\(\)/);
  assert.match(appSrc, /LIFESPAN_POLICY\.PERMANENT/);
  assert.match(appSrc, /useSetTimeoutCallback\(\)/);
  assert.doesNotMatch(appSrc, /display\.power/);
  assert.match(appSrc, /domStorageEnabled=\{true\}/);
  assert.doesNotMatch(appSrc, /system\.reboot/);
  assert.doesNotMatch(appSrc, /system\.kiosk/);
  // The URL the shell opens is the modern player, with the host tag the page checks.
  assert.match(appSrc, /\/player\?host=vega/);
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^vega\/buildinfo\.json$/m);
});
