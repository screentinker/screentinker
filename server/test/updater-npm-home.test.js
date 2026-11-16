'use strict';

/*
 * The instance updater runs npm ci as the checkout's owner. The documented install creates that
 * user with `useradd -r`, which records /home/<user> in passwd but never creates it, and npm with
 * an unusable HOME fails part-way through unpacking ("TAR_ENTRY_ERROR ENOENT", exit 243). The
 * rollback ran the same npm ci and failed too, leaving a server that could not start (3.2.1, a
 * self-hoster's git + systemd install). Reproduced in node:22-bookworm; a writable HOME fixes it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'updater', 'st-updater.sh'), 'utf8');
const fn = (name) => (SRC.match(new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];

test('the owner\'s passwd home is used only when the owner can write it', () => {
  const f = fn('owner_home');
  assert.ok(f, 'owner_home exists');
  assert.match(f, /\[ -d "\$_home" \] && runuser -u "\$APP_USER" -- test -w "\$_home"/);
});

test('otherwise a private home the updater creates for the owner (0700, owned by them)', () => {
  const f = fn('owner_home');
  assert.match(f, /install -d -m 700 -o "\$APP_USER"/);
  assert.match(f, /\/var\/cache\/screentinker-updater\/home-\$APP_USER/);
});

test('every command run as the owner gets that home, npm ci included', () => {
  const f = fn('as_owner');
  assert.match(f, /HOME="\$OWNER_HOME"/);
  assert.doesNotMatch(f, /HOME="\$\{_home:-\/tmp\}"/, 'no longer the bare passwd home');
  assert.match(fn('git_install'), /as_owner npm ci/);
});
