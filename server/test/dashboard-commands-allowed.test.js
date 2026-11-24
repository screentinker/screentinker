'use strict';

/*
 * EVERY COMMAND THE DASHBOARD SENDS MUST BE ONE THE SERVER ACCEPTS.
 *
 * #396 made the dashboard socket check lib/device-command.js ALLOWED_COMMANDS. Four commands the
 * device page had always sent over that socket (set_debug, enable_system_capture, settings,
 * clear_update_cache) were not on the list, so from 2026-09-19 the server answered "invalid command
 * type": the live debug log panel opened and stayed empty, and nobody noticed for two months.
 *
 * This reads the command names the frontend sends, as literals to sendCommand() and to the device
 * page's helpers (_sendCmd, t2, sendWithFeedback, bindLevel), and requires each one on the list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_COMMANDS } = require('../lib/device-command');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'i18n') out.push(...jsFiles(p)); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function sentCommands() {
  const found = new Map();
  const patterns = [
    /\bsendCommand\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*'([a-z_]+)'/g,
    /\b(?:_sendCmd|t2|sendWithFeedback)\(\s*\\?'([a-z_]+)\\?'/g,
    /\bbindLevel\(\s*'[^']*',\s*'([a-z_]+)'/g,
  ];
  for (const file of jsFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) found.set(m[1], path.relative(FRONTEND, file));
  }
  return found;
}

module.exports = { sentCommands };

test('the scan finds the dashboard\'s commands (guards the guard)', () => {
  const sent = sentCommands();
  for (const known of ['set_debug', 'screen_on', 'reboot', 'set_volume', 'shell']) {
    assert.ok(sent.has(known), `expected the frontend to send ${known}; the patterns above stopped matching`);
  }
});

test('every command the dashboard sends is in ALLOWED_COMMANDS', () => {
  const missing = [...sentCommands()].filter(([cmd]) => !ALLOWED_COMMANDS.includes(cmd)).map(([cmd, file]) => `${cmd} (${file})`);
  assert.deepEqual(missing, [], 'the server refuses these as "invalid command type"');
});

test('the live debug log, screen-capture consent, settings and update-cache buttons are accepted', () => {
  for (const cmd of ['set_debug', 'enable_system_capture', 'settings', 'clear_update_cache']) {
    assert.ok(ALLOWED_COMMANDS.includes(cmd), cmd);
  }
});

test('a command sent without a callback still reports a refusal (frontend/js/socket.js)', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'socket.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function sendCommand'), src.indexOf('export function sendCommand') + 600);
  assert.match(fn, /if \(typeof callback !== 'function'\) callback = \(ack\) => \{ reportCommandRefusal\(type, ack\); \};/,
    'sendCommand must give a callback-less send the refusal reporter, or a refused command is silent again');
  const rep = src.slice(src.indexOf('export function reportCommandRefusal'), src.indexOf('export function sendCommand'));
  for (const reason of ['invalid', 'forbidden', 'unsupported', 'refused', 'rejected', 'no_ack']) {
    assert.ok(src.includes(`'${reason}'`), `${reason} counts as a refusal`);
  }
  assert.match(rep, /showToast/);
});

test('"Clear update cache" goes only to players that implement it, whatever capabilities a web player declares', () => {
  const caps = require('../lib/player-capabilities');
  const withSelfUpdate = (d) => ({ ...d, capabilities: JSON.stringify([...caps.capabilitiesFor(d), 'system.self_update']) });
  // BrightSign with storage and SCAP webOS declare system.self_update at runtime; the web player has
  // no clear_update_cache handler, so the dashboard reported a success the panel never had.
  for (const d of [
    { platform: 'BrightSign XD1035', client_type: 'web' },
    { platform: 'webOS 6.0', android_version: 'Web/webOS', client_type: 'web' },
  ]) {
    const v = caps.commandAllowed(withSelfUpdate(d), 'clear_update_cache');
    assert.equal(v.ok, false, d.platform);
    assert.equal(v.capability, 'system.self_update');
  }
  for (const d of [
    { platform: 'Android 13', client_type: 'apk', android_version: '13' },
    { platform: 'Linux/Debian (Raspberry Pi 5)', client_type: 'pi' },
    { platform: 'Windows/11 Pro (Legion)', client_type: 'win' },
  ]) {
    assert.equal(caps.commandAllowed(withSelfUpdate(d), 'clear_update_cache').ok, true, d.platform);
  }
});
