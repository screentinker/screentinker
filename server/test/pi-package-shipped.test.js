'use strict';

/*
 * #634 — every way of installing a server ships the native Raspberry Pi player.
 *
 * `raspberry-pi-setup.sh --native <server>` installs the .deb from <server>/download/pi, so a Pi
 * always runs the build that matches its server. But the .deb is not in git (native/dist/ is
 * ignored) and no install path built it: a self-hosted server answered 404, and the setup script
 * blamed the server version ("is the server 2.3 or later?") on a 2.6.2 server. These guards keep
 * each path building it; the last test builds the package for real in a scratch copy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const VERSION = read('VERSION').trim();

test('the Docker image builds the package and puts it where /download/pi looks', () => {
  const df = read('Dockerfile');
  assert.match(df, /AS pi-deb\b/, 'a pi-deb build stage');
  assert.match(df, /RUN [^\n]*native\/packaging\/linux\/build-deb\.sh/, 'the stage runs build-deb.sh');
  assert.match(df, /COPY --from=pi-deb \/build\/native\/dist\/ \/app\/native\/dist\//);
  // lib/package-cache.js resolves <repo>/native/dist from server/lib; in the image that is /app.
  assert.equal(path.posix.join('/app/server/lib', '..', '..', 'native', 'dist'), '/app/native/dist');
  const ignore = read('.dockerignore').split('\n').map((l) => l.trim());
  for (const p of ['native', 'native/', 'shared', 'shared/', 'VERSION']) {
    assert.ok(!ignore.includes(p), `.dockerignore must not drop ${p}: the stage copies it`);
  }
});

test('upgrade.sh builds it for the release it checked out, after npm ci, and never fails on it', () => {
  const s = read('scripts/upgrade.sh');
  const npm = s.indexOf('( cd server && npm ci --omit=dev )');
  const build = s.indexOf('native/packaging/linux/build-deb.sh');
  const restart = s.indexOf('STEP="restarting the server"');
  assert.ok(npm > 0 && build > npm && restart > build, 'npm ci, then the package, then the restart');
  const block = s.slice(build - 400, build + 400);
  assert.match(block, /command -v dpkg-deb/, 'skipped, with a note, where dpkg-deb is missing');
  assert.doesNotMatch(block, /\bexit 1\b/, 'a server upgrade must not fail on the Pi package');
});

test('a fresh Debian install builds it too', () => {
  const s = read('scripts/debian-13-setup.sh');
  const npm = s.indexOf('npm ci --omit=dev');
  const build = s.indexOf('native/packaging/linux/build-deb.sh');
  const chown = s.indexOf('chown -R "$RUNTIME_USER"', npm);
  assert.ok(npm > 0 && build > npm && chown > build, 'built before the checkout is handed to the runtime user');
});

test('finalize bundles it in the release tarball and attaches it to the release', () => {
  const s = read('scripts/finalize-release.sh');
  assert.match(s, /PI_DEB="native\/dist\/screentinker-pi_\$\{VERSION\}_all\.deb"/);
  assert.match(s, /native\/packaging\/linux\/build-deb\.sh "\$VERSION"/);
  assert.match(s, /ScreenTinker\.wgt "\$PI_DEB"\n/, 'in the tar list');
  assert.match(s, /gh release upload "\$TAG" [^\n]*"\$PI_DEB" --clobber/, 'and uploaded');
});

test('the setup script says what a 404 means instead of blaming the server version', () => {
  const s = read('scripts/raspberry-pi-setup.sh');
  assert.doesNotMatch(s, /is the server 2\.3 or later/);
  assert.match(s, /\$PI_HTTP" = 404/);
  assert.match(s, /does not host the native Raspberry Pi player/);
  assert.match(s, /without --native for the browser player/);
});

const haveTools = ['dpkg-deb', 'rsync'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0);

test('build-deb.sh produces screentinker-pi_<VERSION>_all.deb', { skip: !haveTools && 'needs dpkg-deb and rsync' }, () => {
  // A scratch copy of exactly what the Docker stage copies, so the checkout's native/dist is untouched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pi-deb-'));
  try {
    fs.cpSync(path.join(REPO, 'native'), path.join(tmp, 'native'), {
      recursive: true, filter: (src) => !/[\\/](dist|__pycache__|\.venv)([\\/]|$)/.test(src),
    });
    fs.mkdirSync(path.join(tmp, 'shared'));
    fs.cpSync(path.join(REPO, 'shared', 'Transitions'), path.join(tmp, 'shared', 'Transitions'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'VERSION'), path.join(tmp, 'VERSION'));
    const out = execFileSync(path.join(tmp, 'native', 'packaging', 'linux', 'build-deb.sh'), { encoding: 'utf8' }).trim().split('\n').pop();
    assert.equal(out, path.join(tmp, 'native', 'dist', `screentinker-pi_${VERSION}_all.deb`));
    const field = (f) => execFileSync('dpkg-deb', ['-f', out, f], { encoding: 'utf8' }).trim();
    assert.equal(field('Package'), 'screentinker-pi');
    assert.equal(field('Version'), VERSION);
    assert.equal(field('Architecture'), 'all');
    // The name is what lib/deb-cache.js matches, so /download/pi will find it.
    assert.match(path.basename(out), /^screentinker-pi_\d+\.\d+\.\d+(~[0-9A-Za-z.]+)?_all\.deb$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ── upgrade.sh downloads the release's player packages ─────────────────────────────────────── */

const crypto = require('node:crypto');
const UPGRADE = read('scripts/upgrade.sh');
const FETCH = UPGRADE.slice(UPGRADE.indexOf('fetch_players() {'), UPGRADE.indexOf('\n}\n', UPGRADE.indexOf('fetch_players() {')) + 3);

test('upgrade.sh downloads the player packages after the checkout and before the restart, and can be told not to', () => {
  const at = UPGRADE.indexOf('\n  fetch_players\n');
  assert.ok(FETCH.length > 100 && at > UPGRADE.indexOf('git checkout -q "$TARGET"') && at < UPGRADE.indexOf('STEP="restarting the server"'));
  assert.match(UPGRADE, /if \[ "\$\{UPGRADE_SKIP_PLAYERS:-0\}" = 1 \]; then\n\s+echo "==> Player packages: left as they are/);
  assert.match(FETCH, /sha256sum/, 'every file is checked against the release digest');
  assert.doesNotMatch(FETCH, /\bexit\b/, 'never ends the upgrade');
});

const haveSha = spawnSync('sh', ['-c', 'command -v sha256sum && command -v curl']).status === 0;

/**
 * Run fetch_players in a scratch checkout under the script's own shell options, with `curl`
 * answering the GitHub API from a fake release whose assets are local files.
 */
function runFetch(t, { assets, before = {}, digestOverride = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fetch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); const files = path.join(root, 'files'); const bin = path.join(root, 'bin');
  for (const d of [app, files, bin]) fs.mkdirSync(d);
  for (const [name, body] of Object.entries(before)) {
    fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
    fs.writeFileSync(path.join(app, name), body);
  }
  const release = { assets: Object.entries(assets).map(([name, body]) => {
    fs.writeFileSync(path.join(files, name), body);
    const digest = 'sha256:' + (digestOverride[name] || crypto.createHash('sha256').update(body).digest('hex'));
    return { name, digest, browser_download_url: 'file://' + path.join(files, name) };
  }) };
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(release));
  const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nfor a in "$@"; do case "$a" in https://api.github.com/*) cat '${root}/release.json'; exit 0;; esac; done\nexec '${realCurl}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'run.sh'), `set -Eeuo pipefail\ntrap 'echo "ERR TRAP" >&2; exit 9' ERR\ncd '${app}'\nTARGET=v9.0.0\n${FETCH}\nfetch_players\necho FETCH-DONE\n`);
  const r = spawnSync('bash', [path.join(root, 'run.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, UPGRADE_RELEASE_REPO: 'o/r' } });
  const has = (name) => fs.existsSync(path.join(app, name));
  const body = (name) => fs.readFileSync(path.join(app, name), 'utf8');
  return { r, out: r.stdout + r.stderr, has, body };
}

test('a verified package replaces the old one, which is kept as .bak-pre-<tag>; the installers go to native/dist', { skip: !haveSha && 'needs curl and sha256sum' }, (t) => {
  const f = runFetch(t, {
    before: { 'ScreenTinker.apk': 'old apk', 'ScreenTinker.apk.version': '8.0.0\n' },
    assets: {
      'ScreenTinker.apk': 'new apk', 'ScreenTinker.apk.version': '9.0.0\n', 'ScreenTinker.ipk': 'ipk',
      'ScreenTinker-Setup-9.0.0.exe': 'exe', 'screentinker-9.0.0.tar.gz': 'not a player', 'autorun.zip': 'built by the server',
    },
  });
  assert.equal(f.r.status, 0, f.out);
  assert.match(f.out, /FETCH-DONE/);
  assert.equal(f.body('ScreenTinker.apk'), 'new apk');
  assert.equal(f.body('ScreenTinker.apk.version'), '9.0.0\n');
  assert.equal(f.body('ScreenTinker.apk.bak-pre-v9.0.0'), 'old apk');
  assert.equal(f.body('ScreenTinker.ipk'), 'ipk');
  assert.equal(f.body('native/dist/ScreenTinker-Setup-9.0.0.exe'), 'exe');
  assert.ok(!f.has('screentinker-9.0.0.tar.gz') && !f.has('autorun.zip'), 'only player packages');
});

test('a file that fails its checksum is not used, and the APK\'s .version never moves without the APK', { skip: !haveSha && 'needs curl and sha256sum' }, (t) => {
  const f = runFetch(t, {
    before: { 'ScreenTinker.apk': 'old apk', 'ScreenTinker.apk.version': '8.0.0\n' },
    assets: { 'ScreenTinker.apk': 'tampered', 'ScreenTinker.apk.version': '9.0.0\n', 'ScreenTinker.ipk': 'ipk' },
    digestOverride: { 'ScreenTinker.apk': '0'.repeat(64) },
  });
  assert.equal(f.r.status, 0, 'a bad file never fails the upgrade:\n' + f.out);
  assert.match(f.out, /ScreenTinker\.apk does not match the release checksum/);
  assert.equal(f.body('ScreenTinker.apk'), 'old apk');
  assert.equal(f.body('ScreenTinker.apk.version'), '8.0.0\n', 'a sidecar ahead of its APK is a reinstall loop');
  assert.equal(f.body('ScreenTinker.ipk'), 'ipk', 'the others still update');
  assert.ok(!f.has('ScreenTinker.apk.new'), 'no partial file left');
});

test('a release with nothing attached yet changes nothing', { skip: !haveSha && 'needs curl and sha256sum' }, (t) => {
  const f = runFetch(t, { before: { 'ScreenTinker.apk': 'old apk' }, assets: {} });
  assert.equal(f.r.status, 0, f.out);
  assert.match(f.out, /none attached to v9\.0\.0 yet/);
  assert.equal(f.body('ScreenTinker.apk'), 'old apk');
});
