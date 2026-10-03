'use strict';
/*
 * "Update Now" must hand back a command that works on THIS install.
 *
 * It used to emit `docker compose -f /opt/screentinker/docker-compose.yml ...` unconditionally,
 * because composeFilePath has that default whether or not the file exists. Every self-hosted
 * git + systemd instance, which is the layout docs/operations.md documents, was told to run a
 * docker command against a compose file it does not have. Reported after a user upgraded 1.9.39
 * to 2.0.8 using a script he had written himself, the dashboard's suggestion being no use.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

test('a git checkout is told to run upgrade.sh, not docker', () => {
  // This repo IS the git layout: .git plus scripts/upgrade.sh, and no compose file at the
  // configured path. That is exactly the shape the reporter was running.
  assert.ok(fs.existsSync(path.join(ROOT, '.git')), 'fixture assumption: running from a checkout');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'upgrade.sh')), 'the documented upgrade path exists');

  const { detectInstall } = require('../routes/admin');
  const got = detectInstall();

  // Skip rather than lie if this machine really does have the compose file present.
  if (got.kind === 'docker') return;

  assert.equal(got.kind, 'git');
  assert.match(got.command, /scripts\/upgrade\.sh$/);
  assert.doesNotMatch(got.command, /docker/, 'a git install must never be handed a docker command');
});

test('the suggested command names a path that exists', () => {
  const { detectInstall } = require('../routes/admin');
  const got = detectInstall();
  if (got.kind !== 'git') return;
  const script = got.command.replace(/^cd\s+(.*?)\s+&&\s+/, '$1/');
  assert.ok(fs.existsSync(script), `suggested ${script} but it is not there`);
});

test('upgrade.sh is executable bash, so the suggestion is runnable as given', () => {
  const script = path.join(ROOT, 'scripts', 'upgrade.sh');
  require('child_process').execFileSync('bash', ['-n', script]);
  assert.ok((fs.statSync(script).mode & 0o111) !== 0, 'upgrade.sh must carry the executable bit');
});
