'use strict';

/*
 * http_request is admin-only (lib/device-command.js ADMIN_ONLY_COMMANDS), and its answer is a response
 * body from inside the customer's network. It went to every dashboard socket in the screen's workspace,
 * viewers included: the same class as the shell output fixed in 3.2.3. It now goes only to the sockets
 * that could have sent the request (emitToShellUsers), and a screen's Wi-Fi is an admin's change too.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOCKET = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
const WIFI = fs.readFileSync(path.join(__dirname, '..', 'routes', 'device-wifi.js'), 'utf8');

test('http-result is relayed only to the people who could have sent the request', () => {
  const i = SOCKET.indexOf("'http-result'(deviceId, data, ctx) {");
  assert.ok(i > 0);
  const body = SOCKET.slice(i, SOCKET.indexOf('});', i));
  assert.match(body, /emitToShellUsers\(_dashboardNsRef, device_id, 'dashboard:http-result'/);
  assert.doesNotMatch(body, /emitToDeviceWorkspace/);
});

test('the commands that reach past the player are admin-only', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'st-aoc-'));
  const { ADMIN_ONLY_COMMANDS } = require('../lib/device-command');
  for (const t of ['shell', 'install_apk', 'set_server_url', 'http_request', 'kiosk_unlock', 'unblock_uninstall', 'status_bar', 'set_time', 'update']) {
    assert.ok(ADMIN_ONLY_COMMANDS.includes(t), t);
  }
  for (const t of ['reboot', 'refresh', 'screen_on', 'screen_off', 'set_volume', 'kiosk_lock', 'block_uninstall']) {
    assert.ok(!ADMIN_ONLY_COMMANDS.includes(t), `${t} stays an editor's`);
  }
});

test('changing a screen\'s Wi-Fi needs a workspace admin', () => {
  assert.match(WIFI, /canRunAdminCommands\(require\('\.\.\/lib\/corporate\/actor'\)\.fromReq\(req\), device\)/);
});
