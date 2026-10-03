'use strict';

// #312 follow-up: the server-side URL rewrite. An operator can push a new server URL to one device,
// a group, or a whole workspace, so a relocated server does not mean visiting every panel. The
// command is fleet-affecting — a bad address is exactly the "panel never comes back" failure #312
// is about — so it is gated three ways: an allow-list, a per-device capability, and a payload
// validation that rejects a malformed URL before anything is fanned out. This pins all three, plus
// the deliberate exclusion from the mesh (a hub must not relocate a customer's fleet).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_COMMANDS, MESH_COMMANDS, validateCommand } = require('../lib/device-command');
const caps = require('../lib/player-capabilities');

test('set_server_url is an operator command but NOT a mesh command', () => {
  assert.ok(ALLOWED_COMMANDS.includes('set_server_url'), 'operators can send it from their own dashboard');
  assert.ok(!MESH_COMMANDS.includes('set_server_url'),
    'a hub relocating a customer fleet to a new address is not covered by the device-command consent');
});

test('set_server_url is gated on remote.set_server_url, which only a verify-then-commit player declares', () => {
  assert.equal(caps.capabilityForCommand('set_server_url'), 'remote.set_server_url');

  const android = { client_type: 'apk', android_version: '13', capabilities: ['remote.set_server_url'] };
  assert.equal(caps.commandAllowed(android, 'set_server_url').ok, true);

  // A web player's "server" is its page origin; it does not declare the capability and is refused,
  // which is exactly what makes a group/workspace push skip it instead of stranding it.
  const web = { android_version: 'Web/Chrome', capabilities: ['playback.video', 'remote.stream'] };
  const verdict = caps.commandAllowed(web, 'set_server_url');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.capability, 'remote.set_server_url');
});

test('a legacy device that declares nothing is NOT force-fed the URL rewrite', () => {
  // Brand-new capability, in no baseline: the several hundred displays that declare nothing must
  // not silently accept a server move they have no verify-then-commit path for.
  const legacy = { client_type: 'apk', android_version: '9' };
  assert.equal(caps.commandAllowed(legacy, 'set_server_url').ok, false);
});

test('validateCommand rejects a malformed URL before it can reach a fleet', () => {
  assert.equal(validateCommand('set_server_url', {}).ok, false, 'no url');
  assert.equal(validateCommand('set_server_url', { url: '' }).ok, false, 'empty url');
  assert.equal(validateCommand('set_server_url', { url: '   ' }).ok, false, 'whitespace url');
  assert.equal(validateCommand('set_server_url', { url: 'not a url' }).ok, false, 'unparseable');
  assert.equal(validateCommand('set_server_url', { url: 'ftp://host:21' }).ok, false, 'wrong scheme');
  assert.equal(validateCommand('set_server_url', { url: 'https://' }).ok, false, 'no host');
});

test('validateCommand accepts a well-formed http(s) URL and leaves other commands alone', () => {
  assert.equal(validateCommand('set_server_url', { url: 'http://10.0.0.5:3001' }).ok, true);
  assert.equal(validateCommand('set_server_url', { url: 'https://sign.example.com' }).ok, true);
  assert.equal(validateCommand('set_server_url', { url: 'https://sign.example.com:3001/' }).ok, true);
  // A command with no dangerous payload passes through untouched.
  assert.equal(validateCommand('reboot', {}).ok, true);
  assert.equal(validateCommand('set_volume', { level: 50 }).ok, true);
});
