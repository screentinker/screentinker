'use strict';
/*
 * The instance updater (docs/instance-updater.md): the app queues, a separate host-side script
 * upgrades. Three layers, each against the real thing it ships:
 *   1. lib/instance-updater.js — availability, queueing, the status the dashboard polls;
 *   2. scripts/updater/st-updater.sh in GIT mode — a real git repo with real tags, real sqlite3
 *      backups, stubbed systemctl/npm/curl so "restart" and "is it up?" are controllable;
 *   3. the same script in DOCKER mode under busybox sh (what the docker:cli sidecar runs), with a
 *      stub `docker` that "recreates" the app from whatever image the compose file names.
 * The point of 2 and 3 is the failure paths: a release that never comes up must be rolled back,
 * and a request the app could have forged must change nothing.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'updater', 'st-updater.sh');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `st-upd-${p}-`));
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

/* ------------------------------------------------------------------ 1. the app side */

describe('lib/instance-updater', () => {
  const statusDir = tmp('status');
  const requestDir = path.join(tmp('data'), 'updater', 'requests');
  process.env.UPDATER_STATUS_DIR = statusDir;
  process.env.UPDATER_REQUEST_DIR = requestDir;
  const updater = require('../lib/instance-updater');
  const now = () => Math.floor(Date.now() / 1000);
  const marker = (o) => fs.writeFileSync(path.join(statusDir, 'updater.json'), JSON.stringify(o));
  const job = (o) => fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify(o));
  const clearRequests = () => fs.rmSync(requestDir, { recursive: true, force: true });

  test('no marker = not installed, and nothing can be queued', () => {
    assert.deepEqual(updater.info(), { available: false, reason: 'not_installed' });
    assert.throws(() => updater.requestUpdate({ target: '2.3.3', current: '2.3.2' }), { code: 'not_installed' });
  });

  test('a docker sidecar must be heartbeating; a git (systemd) updater need not be', () => {
    marker({ kind: 'docker', heartbeat_at: now() - 600 });
    assert.equal(updater.info().reason, 'not_running');
    marker({ kind: 'docker', heartbeat_at: now() });
    assert.deepEqual(updater.info(), { available: true, kind: 'docker' });
    marker({ kind: 'git', heartbeat_at: 1 });
    assert.deepEqual(updater.info(), { available: true, kind: 'git' });
    marker({ kind: 'rm -rf', heartbeat_at: now() });
    assert.equal(updater.info().available, false);
  });

  test('only a newer X.Y.Z is queued', () => {
    marker({ kind: 'git' });
    for (const bad of ['', 'latest', '2.3.3-rc1', '2.3.3; reboot', '../2.3.3']) {
      assert.throws(() => updater.requestUpdate({ target: bad, current: '2.3.2' }), { code: 'bad_target' }, bad);
    }
    assert.throws(() => updater.requestUpdate({ target: '2.3.2', current: '2.3.2' }), { code: 'not_newer' });
    assert.throws(() => updater.requestUpdate({ target: '2.2.9', current: '2.3.2' }), { code: 'not_newer' });
    assert.ok(!fs.existsSync(requestDir) || fs.readdirSync(requestDir).length === 0, 'nothing written');
  });

  test('a queued request is one complete file; a second is refused while it waits or runs', () => {
    clearRequests();
    const r = updater.requestUpdate({ target: 'v2.3.3', current: '2.3.2', userId: 'u1' });
    assert.equal(r.target, '2.3.3');
    const files = fs.readdirSync(requestDir);
    assert.deepEqual(files, [`${r.id}.json`], 'renamed into place, no .tmp left');
    const body = JSON.parse(fs.readFileSync(path.join(requestDir, files[0]), 'utf8'));
    assert.equal(body.target, '2.3.3');
    assert.throws(() => updater.requestUpdate({ target: '2.3.3', current: '2.3.2' }), { code: 'busy' });

    clearRequests();
    job({ id: r.id, state: 'install', updated_at: now() });
    assert.throws(() => updater.requestUpdate({ target: '2.3.3', current: '2.3.2' }), { code: 'busy' });
    // A "running" job nobody has touched in an hour is a dead updater, not a live upgrade.
    job({ id: r.id, state: 'install', updated_at: now() - 3600 });
    assert.ok(updater.requestUpdate({ target: '2.3.3', current: '2.3.2' }).id);
    clearRequests();
  });

  test('status reports the job, pending requests and the log tail', () => {
    job({ id: 'abc', state: 'verify', updated_at: now(), message: 'waiting' });
    fs.writeFileSync(path.join(statusDir, 'log.txt'), Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    const s = updater.status();
    assert.equal(s.job.state, 'verify');
    assert.equal(s.running, true);
    assert.ok(s.log.endsWith('line 199'));
    assert.ok(!s.log.includes('line 100\n'), 'tail only');
  });
});

/* ------------------------------------------------------------------ stubs shared by 2 and 3 */

function writeStub(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// `curl $STATUS_URL` answers with whatever version $STATE/running holds; empty = down.
function curlStub(bin, state) {
  writeStub(bin, 'curl', `v="$(cat "${state}/running" 2>/dev/null)"; [ -n "$v" ] || exit 7; printf '{"status":"ok","version":"%s"}' "$v"`);
}

function run(env, shell = 'sh') {
  const args = shell === 'busybox' ? ['sh', SCRIPT, 'once'] : [SCRIPT, 'once'];
  const r = spawnSync(shell, args, { env: { ...env, VERIFY_TIMEOUT: '4' }, encoding: 'utf8', timeout: 60000 });
  return { ...r, status_json: JSON.parse(fs.readFileSync(path.join(env.UPDATER_STATUS_DIR, 'status.json'), 'utf8')) };
}

function request(reqDir, target, id = `req-${Math.random().toString(36).slice(2, 10)}`) {
  fs.mkdirSync(reqDir, { recursive: true });
  fs.writeFileSync(path.join(reqDir, `${id}.json`), JSON.stringify({ id, target }));
  return id;
}

/* ------------------------------------------------------------------ 2. git + systemd */

describe('st-updater.sh, git mode', { skip: !has('git') || !has('sqlite3') ? 'needs git + sqlite3' : false }, () => {
  let root, app, env, state;
  const git = (...a) => execFileSync('git', ['-C', app, ...a], { encoding: 'utf8' }).trim();
  const head = () => git('describe', '--tags', '--exact-match');

  before(() => {
    root = tmp('git');
    app = path.join(root, 'app');
    state = path.join(root, 'state');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(app, 'server'), { recursive: true });
    fs.mkdirSync(state); fs.mkdirSync(bin);
    const g = (...a) => execFileSync('git', ['-C', app, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
    execFileSync('git', ['init', '-q', app]);
    const release = (v, extra = {}) => {
      fs.writeFileSync(path.join(app, 'VERSION'), `${v}\n`);
      fs.mkdirSync(path.join(app, 'server'), { recursive: true });
      fs.writeFileSync(path.join(app, 'server', 'package.json'), `{"version":"${v}"}\n`);  // npm ci runs here
      for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(app, f), c);
      g('add', '-A'); g('commit', '-qm', v); g('tag', `v${v}`);
    };
    release('1.0.0');
    release('1.1.0');
    release('1.2.0', { 'server/WONT_START': 'x' });     // a release that never comes up
    // `origin` so `git fetch --tags origin` is the real command, not a stub.
    execFileSync('git', ['clone', '-q', '--bare', app, path.join(root, 'origin.git')]);
    g('remote', 'add', 'origin', path.join(root, 'origin.git'));
    g('checkout', '-q', 'v1.0.0');

    // The live database, made with the real driver; the backup is checked with real sqlite3.
    const Database = require('better-sqlite3');
    const dbPath = path.join(root, 'live.db');
    const db = new Database(dbPath); db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)'); db.close();

    // systemctl restart = "the service now runs whatever the checkout holds", unless that release
    // is the broken one.
    writeStub(bin, 'systemctl', `case "$1" in
  restart) if [ -f "${app}/server/WONT_START" ]; then sqlite3 "${root}/live.db" 'INSERT INTO t VALUES (99)'; : > "${state}/running"; else tr -d '\\n' < "${app}/VERSION" > "${state}/running"; fi ;;
  stop) : > "${state}/running" ;;
  is-active) exit 0 ;;
esac`);
    writeStub(bin, 'npm', 'exit 0');
    curlStub(bin, state);
    fs.writeFileSync(path.join(state, 'running'), '1.0.0');

    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      UPDATER_MODE: 'git',
      UPDATER_REQUEST_DIR: path.join(root, 'requests'),
      UPDATER_STATUS_DIR: path.join(root, 'out'),
      APP_DIR: app,
      APP_USER: os.userInfo().username,
      DB: dbPath,
      BACKUP_DIR: path.join(root, 'backups'),
      STATUS_URL: 'http://stub/api/status',
    };
  });

  test('upgrades: backup verified, tag checked out, service restarted, version confirmed', () => {
    request(env.UPDATER_REQUEST_DIR, '1.1.0');
    const r = run(env);
    assert.equal(r.status_json.state, 'done', r.status_json.message);
    assert.equal(r.status_json.from, '1.0.0');
    assert.equal(head(), 'v1.1.0');
    const bk = r.status_json.backup;
    assert.ok(bk.startsWith(env.BACKUP_DIR) && fs.existsSync(bk), 'backup written');
    assert.equal(execFileSync('sqlite3', [bk, 'SELECT x FROM t'], { encoding: 'utf8' }).trim(), '1');
    assert.deepEqual(fs.readdirSync(env.UPDATER_REQUEST_DIR), [], 'request consumed');
    const marker = JSON.parse(fs.readFileSync(path.join(env.UPDATER_STATUS_DIR, 'updater.json'), 'utf8'));
    assert.equal(marker.kind, 'git');
  });

  test('a release that never comes up is rolled back to the one that was running', () => {
    request(env.UPDATER_REQUEST_DIR, '1.2.0');
    const r = run(env);
    assert.equal(r.status_json.state, 'rolled_back', r.status_json.message);
    assert.equal(head(), 'v1.1.0');
    assert.equal(fs.readFileSync(path.join(state, 'running'), 'utf8'), '1.1.0');
  });

  test('THE BUG: the rollback puts the DATABASE back too, and keeps the one the new release left', () => {
    // 1.2.0 wrote to the database (as a migration would) before it failed to come up.
    const q = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
    assert.equal(q(env.DB, 'SELECT COUNT(*) FROM t WHERE x = 99'), '0', 'the old release runs on the pre-upgrade data');
    const failed = fs.readdirSync(root).filter((f) => f.startsWith('live.db.failed-v1.2.0-'));
    assert.equal(failed.filter((f) => !/-(wal|shm)$/.test(f)).length, 1, 'the new release\'s database is kept');
    assert.equal(q(path.join(root, failed.find((f) => !/-(wal|shm)$/.test(f))), 'SELECT COUNT(*) FROM t WHERE x = 99'), '1');
  });

  test('THE BUG: "newer than running" is measured against the installed release, not what the app reports', () => {
    // A compromised app reports 1.0.0 to make 1.0.0 < 1.1.0 look like an upgrade... to an OLDER tag.
    fs.writeFileSync(path.join(state, 'running'), '0.9.0');
    request(env.UPDATER_REQUEST_DIR, '1.0.0');
    const r = run(env);
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /reports v0\.9\.0 but v1\.1\.0 is installed/);
    assert.equal(head(), 'v1.1.0');
    fs.writeFileSync(path.join(state, 'running'), '1.1.0');
  });

  test('THE BUG: a request directory swapped for a symlink is refused; root acts in no other directory', () => {
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'important.conf'), 'keep me');
    fs.writeFileSync(path.join(victim, 'abcdefgh.json'), '{"target":"1.2.0"}');
    const real = env.UPDATER_REQUEST_DIR;
    fs.rmSync(real, { recursive: true, force: true });
    fs.symlinkSync(victim, real);
    try {
      const before = fs.readFileSync(path.join(env.UPDATER_STATUS_DIR, 'status.json'), 'utf8');
      spawnSync('sh', [SCRIPT, 'once'], { env: { ...env, VERIFY_TIMEOUT: '4' }, encoding: 'utf8', timeout: 60000 });
      assert.deepEqual(fs.readdirSync(victim).sort(), ['abcdefgh.json', 'important.conf'], 'nothing read, nothing removed');
      assert.equal(fs.readFileSync(path.join(env.UPDATER_STATUS_DIR, 'status.json'), 'utf8'), before, 'no job ran');
      assert.match(fs.readFileSync(path.join(env.UPDATER_STATUS_DIR, 'log.txt'), 'utf8'), /Refusing the request directory/);
      assert.equal(head(), 'v1.1.0');
    } finally {
      fs.unlinkSync(real); fs.mkdirSync(real);
    }
  });

  test('a forged or stale request changes nothing', () => {
    for (const [target, why] of [['1.1.0', /not newer/], ['1.0.0', /not newer/], ['1.1.0"; touch /tmp/x; "', /valid X\.Y\.Z/], ['9.9.9', /no release tag/]]) {
      request(env.UPDATER_REQUEST_DIR, target);
      const r = run(env);
      assert.equal(r.status_json.state, 'failed', target);
      assert.match(r.status_json.message, why, target);
      assert.equal(head(), 'v1.1.0', `${target}: checkout untouched`);
    }
    // A badly named file is never read or removed; a symlinked request is removed (the link
    // only) without being read.
    fs.writeFileSync(path.join(env.UPDATER_REQUEST_DIR, 'x.json'), '{"target":"1.2.0"}');
    fs.symlinkSync('/etc/passwd', path.join(env.UPDATER_REQUEST_DIR, 'abcdefgh-link.json'));
    const r = run(env);
    assert.deepEqual(fs.readdirSync(env.UPDATER_REQUEST_DIR), ['x.json']);
    fs.unlinkSync(path.join(env.UPDATER_REQUEST_DIR, 'x.json'));
    assert.equal(r.status_json.state, 'failed');
    assert.equal(head(), 'v1.1.0');
  });

  test('no database at DB = refuse (the studiolab no-backup trap), checkout untouched', () => {
    request(env.UPDATER_REQUEST_DIR, '1.2.0');
    const r = run({ ...env, DB: path.join(root, 'nope.db') });
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /No database/);
    assert.equal(head(), 'v1.1.0');
  });

  test('local changes in the checkout = refuse, nothing changed', () => {
    fs.appendFileSync(path.join(app, 'VERSION'), 'hotfix\n');
    request(env.UPDATER_REQUEST_DIR, '1.2.0');
    const r = run(env);
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /local changes/);
    git('checkout', '--', 'VERSION');
    assert.equal(head(), 'v1.1.0');
  });
});

/* ------------------------------------------------------------------ 3. docker sidecar */

describe('st-updater.sh, docker mode under busybox sh', { skip: !has('busybox') ? 'needs busybox' : false }, () => {
  let root, env, state, compose;
  const IMAGE = 'ghcr.io/screentinker/screentinker';

  before(() => {
    root = tmp('docker');
    state = path.join(root, 'state');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(state); fs.mkdirSync(bin);
    // Busybox applets first, as in the alpine-based docker:cli image. (flock comes from the host
    // where the local busybox lacks the applet; alpine's has it.)
    const applets = new Set(execFileSync('busybox', ['--list'], { encoding: 'utf8' }).split('\n'));
    for (const a of ['sed', 'grep', 'sort', 'tr', 'head', 'tail', 'cut', 'date', 'mkdir', 'mv', 'cp', 'rm', 'chmod', 'basename', 'cat', 'sleep', 'env', 'wc', 'id', 'flock']) {
      if (applets.has(a)) fs.symlinkSync(execFileSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' }).trim(), path.join(bin, a));
    }
    curlStub(bin, state);
    // The fake docker: `compose up` runs whatever image tag the compose file now names (9.0.0 never
    // gets healthy); `pull` of 8.0.0 fails; `exec` is the in-container backup and must get its
    // paths through -e, never in the script text.
    writeStub(bin, 'docker', `echo "docker $*" >> "${state}/calls"
case "$1" in
  compose)
    shift 2; f="$1"; shift
    case "$1" in
      ps) echo cid123 ;;
      up) tag="$(sed -n 's|.*image:[[:space:]]*${IMAGE}:\\([^[:space:]]*\\).*|\\1|p' "$f")"
          [ "$tag" = latest ] || printf '%s' "$tag" > "${state}/imagever"
          if [ "$tag" = 9.0.0 ]; then : > "${state}/running"; else cp "${state}/imagever" "${state}/running"; fi ;;
      stop) : > "${state}/running" ;;
      run) : ;;
    esac ;;
  run) cat "${state}/imagever" ;;
  exec) case "$*" in *"DST=/data/db/pre-v"*) echo ok ;; *) echo bad ;; esac ;;
  pull) case "$2" in *:8.0.0) exit 1 ;; esac ;;
  inspect) case "$*" in *.Image*) echo sha256:img ;; *) echo healthy ;; esac ;;
esac`);
    compose = path.join(root, 'docker-compose.yml');
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      UPDATER_MODE: 'docker',
      UPDATER_REQUEST_DIR: path.join(root, 'requests'),
      UPDATER_STATUS_DIR: path.join(root, 'out'),
      COMPOSE_FILE: compose,
      STATUS_URL: 'http://stub/api/status',
    };
  });

  const writeCompose = (image) => fs.writeFileSync(compose, `services:\n  screentinker:\n    image: ${image}\n    restart: unless-stopped\n  updater:\n    image: screentinker-updater\n`);

  test('pins the compose file to the release, recreates the app, keeps the old file', () => {
    writeCompose(`${IMAGE}:latest`);
    fs.writeFileSync(path.join(state, 'running'), '2.3.2');
    fs.writeFileSync(path.join(state, 'imagever'), '2.3.2');   // what /app/VERSION in the running image says
    request(env.UPDATER_REQUEST_DIR, '2.3.3');
    const r = run(env, 'busybox');
    assert.equal(r.status_json.state, 'done', `${r.status_json.message}\n${r.stderr}`);
    assert.match(fs.readFileSync(compose, 'utf8'), new RegExp(`image: ${IMAGE}:2\\.3\\.3\\n`));
    assert.match(fs.readFileSync(compose, 'utf8'), /image: screentinker-updater\n/, 'the updater service is left alone');
    assert.match(fs.readFileSync(`${compose}.bak-pre-v2.3.3`, 'utf8'), /:latest/);
    const calls = fs.readFileSync(path.join(state, 'calls'), 'utf8');
    assert.match(calls, /up -d --no-deps --force-recreate screentinker/);
    assert.match(calls, /pull ghcr\.io\/screentinker\/screentinker:2\.3\.3/);
  });

  test('a release that never gets healthy is rolled back, compose file restored', () => {
    request(env.UPDATER_REQUEST_DIR, '9.0.0');
    const r = run(env, 'busybox');
    assert.equal(r.status_json.state, 'rolled_back', r.status_json.message);
    assert.match(fs.readFileSync(compose, 'utf8'), /:2\.3\.3\n/);
    assert.equal(fs.readFileSync(path.join(state, 'running'), 'utf8'), '2.3.3');
    // The database comes back too: app stopped, then a one-off container of the OLD release swaps
    // the backup in, paths through -e only.
    const calls = fs.readFileSync(path.join(state, 'calls'), 'utf8');
    assert.match(calls, /compose -f \S+ stop screentinker/);
    assert.match(calls, /compose -f \S+ run --rm --no-deps -T -e SRC=\/data\/db\/pre-v9\.0\.0-\S+ -e DST=\/data\/db\/remote_display\.db -e TAG=v9\.0\.0-\S+ --entrypoint sh screentinker -c/);
    assert.match(r.status_json.message, /database was restored/);
  });

  test('THE BUG (docker): the version floor is the running image\'s own VERSION, not the app\'s answer', () => {
    fs.writeFileSync(path.join(state, 'running'), '1.0.0');   // the app lies
    request(env.UPDATER_REQUEST_DIR, '2.0.0');
    const r = run(env, 'busybox');
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /reports v1\.0\.0 but v2\.3\.3 is installed/);
    fs.writeFileSync(path.join(state, 'running'), '2.3.3');
  });

  test('a failed pull or a compose file not running the published image changes nothing', () => {
    request(env.UPDATER_REQUEST_DIR, '8.0.0');
    let r = run(env, 'busybox');
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /Could not pull/);
    assert.match(fs.readFileSync(compose, 'utf8'), /:2\.3\.3\n/);

    writeCompose('screentinker:local-0f38baf');
    request(env.UPDATER_REQUEST_DIR, '2.4.0');
    r = run(env, 'busybox');
    assert.equal(r.status_json.state, 'failed');
    assert.match(r.status_json.message, /does not run ghcr\.io\/screentinker\/screentinker:<version> exactly once/);
    assert.match(fs.readFileSync(compose, 'utf8'), /screentinker:local-0f38baf/);
  });
});
