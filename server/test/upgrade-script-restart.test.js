'use strict';

/*
 * scripts/upgrade.sh, run for real against a throwaway checkout, with npm, systemctl, pm2, sudo and
 * curl replaced by stubs on PATH. Covers how the server gets restarted, and what the operator is
 * told when something stops the upgrade.
 *
 * ⚠️ Why this exists: a self-hoster ran the README quick start under pm2. The script's last step was
 * a hard-coded `sudo systemctl restart screentinker`, so it died at the end with no explanation; the
 * last line on screen was "Backup verified", they reported it as "crashed after the backup", and
 * finished with a `git pull` that put them on main instead of the release.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'upgrade.sh');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function stub(bin, name, body) {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
}

/*
 * A checkout with a release tag and an origin to fetch it from. Stubs record what they were asked
 * to do in calls.log. `systemd` says whether `systemctl cat <unit>` finds the unit; `pm2List` is what
 * `pm2 jlist` prints (with APP_SERVER standing for this checkout's server/ directory).
 */
function setup({ systemd = false, pm2List = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-upgrade-'));
  const origin = path.join(root, 'origin.git');
  const app = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  fs.writeFileSync(path.join(app, 'server', 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(app, 'server', 'server.js'), '// v1\n');
  git(app, 'init', '-q');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'v1');
  git(app, 'tag', 'v1.0.0');
  fs.writeFileSync(path.join(app, 'server', 'server.js'), '// v2\n');
  git(app, 'commit', '-qam', 'v2');
  git(app, 'tag', 'v2.0.0');
  git(app, 'checkout', '-q', 'v1.0.0');
  git(root, 'clone', '-q', '--bare', app, origin);
  git(app, 'remote', 'add', 'origin', origin);

  const log = path.join(root, 'calls.log');
  const serverDir = path.join(app, 'server');
  stub(bin, 'npm', `echo "npm $*" >> '${log}'`);
  stub(bin, 'sudo', `echo "sudo $*" >> '${log}'; exec "$@"`);
  stub(bin, 'systemctl', `echo "systemctl $*" >> '${log}'
case "$1" in
  cat) ${systemd ? 'exit 0' : 'exit 1'} ;;
  is-active) exit 3 ;;
  show) exit 0 ;;
  restart) exit 0 ;;
esac`);
  if (pm2List) {
    fs.writeFileSync(path.join(root, 'pm2.json'), JSON.stringify(pm2List).replaceAll('APP_SERVER', serverDir));
    stub(bin, 'pm2', `echo "pm2 $*" >> '${log}'
[ "$1" = jlist ] && cat '${path.join(root, 'pm2.json')}'
exit 0`);
  }
  stub(bin, 'curl', `echo '{"version":"2.0.0"}'`);

  const run = (env = {}) => {
    const r = spawnSync('bash', [SCRIPT, 'v2.0.0'], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root, APP_DIR: app, STATUS_URL: 'http://stub/api/status',
        GIT_CONFIG_NOSYSTEM: '1', ...env,
      },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return { ...r, out: r.stdout + r.stderr, calls };
  };
  return { root, app, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const headAt = (app) => git(app, 'describe', '--tags').trim();

test('a systemd unit is restarted with systemctl', () => {
  const s = setup({ systemd: true });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.calls, /sudo systemctl restart screentinker/);
    assert.match(r.calls, /npm ci --omit=dev/);
    assert.equal(headAt(s.app), 'v2.0.0');
    assert.match(r.out, /Upgrade to v2\.0\.0 complete/);
  } finally { s.cleanup(); }
});

test('⚠️ a pm2 install is restarted through pm2, matched to this checkout', () => {
  const s = setup({
    pm2List: [
      { pm_id: 3, name: 'something-else', pm2_env: { pm_cwd: '/srv/other', pm_exec_path: '/srv/other/app.js' } },
      { pm_id: 0, name: 'screentinker-server', pm2_env: { pm_cwd: 'APP_SERVER', pm_exec_path: 'APP_SERVER/server.js' } },
    ],
  });
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.calls, /^pm2 restart 0$/m, 'restarts the process for THIS checkout, not another app');
    assert.doesNotMatch(r.calls, /--update-env/, 'keeps the environment pm2 saved for the process');
    assert.doesNotMatch(r.calls, /systemctl restart/);
    assert.match(r.out, /Restarting pm2 process 0/);
  } finally { s.cleanup(); }
});

test('RESTART_CMD wins over everything else', () => {
  const s = setup({ systemd: true });
  try {
    const marker = path.join(s.root, 'restarted');
    const r = s.run({ RESTART_CMD: `touch '${marker}'` });
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(marker), 'the custom command ran');
    assert.doesNotMatch(r.calls, /systemctl restart/);
  } finally { s.cleanup(); }
});

test('⚠️ with no way to restart, it says the old version is still running, and exits non-zero', () => {
  const s = setup({ systemd: false, pm2List: [{ pm_id: 5, name: 'unrelated', pm2_env: { pm_cwd: '/srv/x', pm_exec_path: '/srv/x/a.js' } }] });
  try {
    const r = s.run();
    assert.equal(r.status, 2, r.out);
    assert.equal(headAt(s.app), 'v2.0.0', 'the new code is installed');
    assert.match(r.out, /server was NOT restarted, so the old version is still/);
    assert.match(r.out, /RESTART_CMD/);
    assert.doesNotMatch(r.calls, /pm2 restart|systemctl restart/, 'never restarts a process it did not match');
    assert.doesNotMatch(r.out, /Upgrade to v2\.0\.0 complete/);
  } finally { s.cleanup(); }
});

test('⚠️ local changes stop it before anything is touched, naming the files', () => {
  const s = setup({ systemd: true });
  try {
    fs.writeFileSync(path.join(s.app, 'server', 'server.js'), '// edited by hand\n');
    const r = s.run();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /server\/server\.js/);
    assert.match(r.out, /Nothing has been changed/);
    assert.equal(headAt(s.app), 'v1.0.0', 'still on the old release');
    assert.doesNotMatch(r.calls, /npm ci|restart/);
  } finally { s.cleanup(); }
});

test('⚠️ a failing step is named, with the advice not to finish by git pull', () => {
  const s = setup({ systemd: true });
  try {
    fs.writeFileSync(path.join(s.root, 'bin', 'npm'), '#!/bin/sh\necho "npm ERR! gyp failed" >&2\nexit 1\n');
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.match(r.out, /stopped while installing server dependencies \(npm ci\)/);
    assert.match(r.out, /git pull/);
    assert.doesNotMatch(r.calls, /restart/, 'nothing after the failed step ran');
  } finally { s.cleanup(); }
});
