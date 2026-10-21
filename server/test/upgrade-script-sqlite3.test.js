'use strict';

/*
 * scripts/upgrade.sh on a host WITHOUT the sqlite3 command-line tool.
 *
 * ⚠️ THE BUG THIS PINS. The server has SQLite built in, so a host can run ScreenTinker for years
 * without the sqlite3 shell, but the pre-upgrade backup uses it. The first thing to run it was the
 * version probe, inside an assignment under `set -euo pipefail` with stderr discarded, so the
 * script ended right after "==> Backing up db" with no message at all. A self-hoster on 2.5.1
 * reported it as "stops after it backs up the database and doesn't upgrade".
 *
 * Run for real against a throwaway checkout, with a PATH built from this machine's tools minus
 * sqlite3 and apt-get, and stubs for npm, sudo, systemctl and curl (as upgrade-script-restart.test.js).
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

// This machine's tools, without the ones the test takes away.
function systemPath(root, without) {
  const sys = path.join(root, 'sys');
  fs.mkdirSync(sys);
  for (const dir of ['/usr/bin', '/bin']) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (without.includes(n) || fs.existsSync(path.join(sys, n))) continue;
      try { fs.symlinkSync(path.join(dir, n), path.join(sys, n)); } catch { /* skip */ }
    }
  }
  return sys;
}

// A stand-in sqlite3 that does what the backup asks of it.
const FAKE_SQLITE3 = `case "$1" in
  --version) echo "3.45.1 2024-01-30 stub"; exit 0 ;;
esac
case "$2" in
  "VACUUM INTO "*) dest=$(printf '%s' "$2" | sed "s/^VACUUM INTO '\\(.*\\)'$/\\1/"); cp "$1" "$dest" ;;
  "PRAGMA integrity_check") echo ok ;;
esac`;

function setup({ aptInstallsSqlite = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-upgrade-sqlite3-'));
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
  // A database to back up (untracked, so the checkout stays clean).
  fs.mkdirSync(path.join(app, 'server', 'db'));
  fs.writeFileSync(path.join(app, 'server', 'db', 'remote_display.db'), 'not really sqlite\n');

  const log = path.join(root, 'calls.log');
  stub(bin, 'npm', `echo "npm $*" >> '${log}'`);
  stub(bin, 'sudo', `echo "sudo $*" >> '${log}'; exec "$@"`);
  stub(bin, 'systemctl', `echo "systemctl $*" >> '${log}'
case "$1" in cat) exit 0 ;; is-active) exit 3 ;; *) exit 0 ;; esac`);
  stub(bin, 'curl', `echo '{"version":"2.0.0"}'`);
  if (aptInstallsSqlite) {
    fs.writeFileSync(path.join(root, 'fake-sqlite3'), `#!/bin/sh\n${FAKE_SQLITE3}\n`);
    stub(bin, 'apt-get', `echo "apt-get $*" >> '${log}'
case " $* " in *" install "*sqlite3*) cp '${path.join(root, 'fake-sqlite3')}' '${path.join(bin, 'sqlite3')}'; chmod 755 '${path.join(bin, 'sqlite3')}' ;; esac
exit 0`);
  }
  const sys = systemPath(root, ['sqlite3', 'apt-get']);

  const run = (env = {}) => {
    const r = spawnSync('bash', [SCRIPT, 'v2.0.0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // no terminal: nobody can answer a question
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:${sys}`,
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

test('⚠️ without sqlite3 the upgrade stops with a message, before changing anything', () => {
  const s = setup();
  try {
    const r = s.run();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sqlite3 is not installed/);
    assert.match(r.out, /sudo apt install sqlite3/, 'it says how to fix it');
    assert.match(r.out, /Nothing has been changed/);
    assert.equal(headAt(s.app), 'v1.0.0', 'the checkout did not move');
    assert.doesNotMatch(r.calls, /npm ci/);
    const history = fs.readFileSync(path.join(s.app, 'backups', 'upgrade-history.jsonl'), 'utf8');
    assert.match(history, /"result":"refused".*sqlite3 is not installed/);
  } finally { s.cleanup(); }
});

test('with a yes, sqlite3 is installed through apt and the upgrade carries on', () => {
  const s = setup({ aptInstallsSqlite: true });
  try {
    const r = s.run({ ST_AUTO_INSTALL_PREREQS: '1' });
    assert.match(r.calls, /apt-get install -y -qq sqlite3/, r.out);
    assert.match(r.out, /Backup verified/, r.out);
    const backups = fs.readdirSync(path.join(s.app, 'backups')).filter((f) => f.startsWith('remote_display-pre-v2.0.0-'));
    assert.equal(backups.length, 1, 'the backup was taken');
    assert.equal(headAt(s.app), 'v2.0.0', r.out);
    const history = fs.readFileSync(path.join(s.app, 'backups', 'upgrade-history.jsonl'), 'utf8');
    assert.match(history, /installed the sqlite3 package/);
  } finally { s.cleanup(); }
});
