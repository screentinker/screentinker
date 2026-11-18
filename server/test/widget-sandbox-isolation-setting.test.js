'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workspaces.js'), 'utf8');
const WIDGETS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
const DEVICE_SOCKET = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');

test('backend requires exact confirmation phrase when disabling sandbox isolation', () => {
  assert.match(WORKSPACES, /I understand I am enabling a security hole/);
  assert.match(WORKSPACES, /String\(req\.body\?\.confirmationPhrase \|\| ''\)\.trim\(\)/);
  assert.match(WORKSPACES, /typed !== WIDGET_SANDBOX_CONFIRM_PHRASE/);
  assert.match(WORKSPACES, /status\(400\)\.json\(\{ error: 'Exact confirmation phrase required' \}\)/);
});

test('backend keeps safe default sandbox and only opts into allow-same-origin via org setting', () => {
  assert.match(WIDGETS, /function widgetIframeSandboxForWorkspace\(workspaceId\)/);
  assert.match(WIDGETS, /if \(!workspaceId\) return 'allow-scripts'/);
  assert.match(WIDGETS, /\? 'allow-scripts allow-same-origin'/);
  assert.match(DEVICE_SOCKET, /COALESCE\(o\.widget_sandbox_isolation_disabled, 0\)/);
  assert.match(DEVICE_SOCKET, /a\.widget_allow_same_origin = \(config\.selfHosted && Number\(facts\.same_origin \|\| 0\) === 1\)/);
});

// Flipping the setting must reach screens that already hold the widgets: the render page is cached
// for a year under ?rev=<updated_at> with the sandbox baked in, and the player's own frame sandbox
// comes from the payload. Without a rev bump and a push, turning isolation off left a page that needs
// its own origin (localStorage) white until each widget was edited by hand.
test('toggling sandbox isolation bumps widget revs in the org and pushes screens', () => {
  const route = WORKSPACES.slice(WORKSPACES.indexOf("router.put('/:id/security-settings'"), WORKSPACES.indexOf("router.put('/:id/live-field-patch'"));
  assert.match(route, /UPDATE widgets SET updated_at = strftime\('%s','now'\) WHERE workspace_id IN \(SELECT id FROM workspaces WHERE organization_id = \?\)/);
  assert.match(route, /devicesPlayingWidget\(id\)/);
  assert.match(route, /queueOrEmitPlaylistUpdate\(io\.of\('\/device'\), d, buildPlaylistPayload\)/);
  assert.match(route, /Number\(current\.v \|\| 0\) !== next/);
});
