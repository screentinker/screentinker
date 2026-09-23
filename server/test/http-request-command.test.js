'use strict';

/*
 * The device-side http_request command: what may send it, and what may not.
 *
 * ⚠️ THE LOAD-BEARING ASSERTION IS THE MESH EXCLUSION, and it is here because I got it wrong once.
 * A single careless edit put http_request into BOTH the operator allowlist and MESH_COMMANDS,
 * which would have let a hub aim someone else's panel at any address on their private network.
 * The panel is by design the one thing standing on the private side of the customer's firewall;
 * a third-party server must not get to point it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ALLOWED_COMMANDS, MESH_COMMANDS, isMeshCommand, validateCommand } = require('../lib/device-command');
const caps = require('../lib/player-capabilities');
const guard = require('../lib/http-target-guard');

test('http_request: an operator may send it from their OWN dashboard', () => {
  assert.ok(ALLOWED_COMMANDS.includes('http_request'));
});

test('⚠️ http_request is NOT a mesh command, and this test exists because it once was', () => {
  assert.equal(MESH_COMMANDS.includes('http_request'), false,
    'a hub must not be able to make a customer\'s panel fetch an address inside their LAN');
  assert.equal(isMeshCommand('http_request'), false);

  // The same argument excludes these, and they are asserted together so a future "tidy up" of the
  // mesh list has to confront all of them at once.
  for (const t of ['shell', 'install_apk', 'http_request']) {
    assert.equal(isMeshCommand(t), false, `${t} must never be reachable from another server`);
  }
});

test('http_request is capability-gated, and no fielded player has it', () => {
  assert.equal(caps.capabilityForCommand('http_request'), 'net.http_request');
  // In no baseline: an un-updated panel is refused rather than sent something it will drop.
  for (const platform of ['android', 'web', 'tizen', 'brightsign', 'webos']) {
    const verdict = caps.commandAllowed({ platform, capabilities: null }, 'http_request');
    assert.equal(verdict.ok, false, `${platform} baseline must not claim net.http_request`);
  }
  assert.equal(caps.commandAllowed({ platform: 'android', capabilities: JSON.stringify(['net.http_request']) }, 'http_request').ok, true);
});

test('http_request payload is validated at the door, not only on the panel', () => {
  /*
   * Same split as set_server_url and the power windows: strict where it is saved, forgiving where
   * it is enforced. The panel refuses a bad target too — it has to, since a stored endpoint can be
   * edited in the database — but an operator typing file:/// deserves a 400 with a reason, not a
   * silent no-op on a screen they cannot see.
   */
  assert.equal(validateCommand('http_request', { url: 'https://192.168.1.50/x' }).ok, true);
  assert.equal(validateCommand('http_request', { url: 'http://10.0.0.1/x', method: 'POST' }).ok, true);

  for (const bad of ['file:///etc/passwd', 'content://x/y', 'http://169.254.169.254/', '', 'nonsense']) {
    const v = validateCommand('http_request', { url: bad });
    assert.equal(v.ok, false, `${bad} must be refused at the door`);
    assert.ok(typeof v.error === 'string' && v.error.length > 0, 'and must say why');
  }
  assert.equal(validateCommand('http_request', {}).ok, false, 'a missing url is refused');
  assert.equal(validateCommand('http_request', { url: 'https://x.test/', method: 'TRACE' }).ok, false,
    'the method is allowlisted too');
});

test('the server and the player share ONE definition of a legal target', () => {
  // validateCommand must not grow its own opinion; it defers to the shared guard.
  for (const v of [{ u: 'https://api.example.com/x', ok: true }, { u: 'file:///x', ok: false }]) {
    assert.equal(validateCommand('http_request', { url: v.u }).ok, guard.check(v.u).allow, v.u);
  }
});
