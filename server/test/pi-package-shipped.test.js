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
