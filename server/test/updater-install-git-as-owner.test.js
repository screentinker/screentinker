'use strict';

/*
 * scripts/updater/install-systemd.sh runs as root, and the documented install chowns the checkout
 * to the service user. git 2.35.2+ refuses a repository owned by someone else ("detected dubious
 * ownership"), so a bare `git rev-parse` as root failed (silently, 2>/dev/null) and the installer
 * called a good checkout "not inside a ScreenTinker git checkout". Reported by a self-hoster.
 * Every git call there must go through git_as_owner, like st-updater.sh's as_owner.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'updater', 'install-systemd.sh'), 'utf8');
// Code only: full-line comments dropped, trailing "  # ..." comments cut (none of the lines checked
// here has a # inside a string).
const CODE = SRC.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');

test('the installer never runs git as root on the checkout', () => {
  const body = CODE.replace(/git_as_owner\(\) \{[\s\S]*?\n\}/, '');   // the helper itself may call git
  const bare = body.split('\n').filter((l) => /(^|[\s;(|&])git\s/.test(l) && !/git_as_owner/.test(l) && !/echo /.test(l));
  assert.deepEqual(bare, [], 'every git call goes through git_as_owner');
  assert.match(SRC, /APP_DIR="\$\(git_as_owner "\$WORKDIR" rev-parse --show-toplevel/);
});

test('git_as_owner runs git as the directory owner, never adds a safe.directory exception', () => {
  const fn = SRC.match(/git_as_owner\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /stat -c %U "\$dir"/);
  assert.match(fn, /runuser -u "\$owner" --/);
  assert.doesNotMatch(CODE, /safe\.directory/);
});

test('runuser is checked before it is first needed', () => {
  assert.ok(SRC.indexOf('command -v runuser') < SRC.indexOf('APP_DIR="$(git_as_owner'));
});

/*
 * The service name. The README makes screentinker.service; scripts/install-service.sh made
 * remotedisplay.service, so install-systemd.sh and upgrade.sh (default screentinker) could not find
 * an install made with it. New installs are screentinker; an existing remotedisplay unit is kept
 * and found. Reported by the same self-hoster.
 */
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
test('install-service.sh creates screentinker.service, and keeps an existing remotedisplay unit', () => {
  const s = read('scripts/install-service.sh');
  assert.match(s, /SERVICE_NAME=screentinker\n/);
  assert.match(s, /systemctl cat remotedisplay[^\n]*\n\s*SERVICE_NAME=remotedisplay/);
  assert.match(s, /sudo tee "\/etc\/systemd\/system\/\$SERVICE_NAME\.service"/);
  assert.doesNotMatch(s.replace(/^\s*#.*$/gm, ''), /systemctl (enable|start|status) remotedisplay/);
  assert.match(read('scripts/remotedisplay.service'), /SyslogIdentifier=@NAME@/);
});
for (const rel of ['scripts/updater/install-systemd.sh', 'scripts/upgrade.sh']) {
  test(`${rel} finds screentinker.service, else remotedisplay.service, when SERVICE_NAME is unset`, () => {
    const s = read(rel);
    assert.doesNotMatch(s, /SERVICE_NAME="\$\{SERVICE_NAME:-screentinker\}"/, 'no fixed default');
    assert.match(s, /if \[ -z "\$\{SERVICE_NAME:-\}" \]; then\n\s*SERVICE_NAME=screentinker\n[\s\S]{0,200}systemctl cat remotedisplay[\s\S]{0,60}SERVICE_NAME=remotedisplay/);
  });
}
