'use strict';

/*
 * The native Windows player as the SERVER sees it — the twin of pi-native-player.test.js. Same
 * engine as the Pi, a Windows OS backend: client_type 'win', platform 'Windows/<edition> (<model>)',
 * android_version ''. Same trap: platformFamily()'s Android arm is a fallback that claims any
 * non-empty, non-"Web/" android_version, so 'windows' is matched first, on two independent signals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-winnative-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const caps = require('../lib/player-capabilities');

const WIN = { client_type: 'win', platform: 'Windows/11 Pro 25H2 (OptiPlex 7010)', android_version: '' };

test('a Windows player is family windows — by client_type, by platform, and ahead of the Android fallback', () => {
  assert.equal(caps.platformFamily(WIN), 'windows');
  assert.equal(caps.platformFamily({ client_type: 'win' }), 'windows', 'client_type alone');
  assert.equal(caps.platformFamily({ platform: 'Windows/10 Enterprise LTSC 2021 (NUC11)' }), 'windows', 'platform alone');
  assert.equal(caps.platformFamily({ platform: 'WINDOWS/11 Home (x)' }), 'windows', 'case-insensitive like linux/');
  assert.equal(caps.platformFamily({ ...WIN, android_version: 'Windows 11 Pro' }), 'windows', '⚠️ never android');
  assert.equal(caps.platformFamily({ ...WIN, android_version: '14' }), 'windows');
});

test('nothing else moved: the Pi, Android and browsers on Windows classify as before', () => {
  assert.equal(caps.platformFamily({ client_type: 'pi', platform: 'Linux/Debian 12 (Raspberry Pi 5)' }), 'linux');
  assert.equal(caps.platformFamily({ client_type: 'apk', android_version: '13' }), 'android');
  // The kiosk-browser shortcut from windows-setup.bat is a BROWSER: navigator.platform 'Win32' is not
  // our 'Windows/' prefix.
  assert.equal(caps.platformFamily({ client_type: 'player', platform: 'Win32', android_version: 'Web/Mozilla/5.0 (Windows NT 10.0)' }), 'web');
  assert.equal(caps.platformFamily({ platform: 'Windows', android_version: 'Web/Chrome' }), 'web', 'no slash, no family');
});

test('an undeclared Windows row gets BASELINE.windows: engine controls only, no OS control, no privilege', () => {
  const row = { ...WIN, capabilities: null };
  for (const c of ['playback.video', 'playback.zones', 'audio.mute', 'display.rotation', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input', 'system.restart_player', 'sync.clock', 'offline.cache']) {
    assert.equal(caps.supports(row, c), true, `baseline should grant ${c}`);
  }
  // OS-specific and still being brought up on Windows (docs/player-parity.md) — a released build must
  // prove them before an undeclared row is offered them.
  for (const c of ['display.power', 'audio.volume', 'system.reboot', 'system.self_update',
    // privilege-conditional, as for every family
    'system.shell', 'system.pty', 'system.kiosk', 'system.time', 'system.install_apk', 'system.brightness',
    'system.screen_timeout', 'system.device_owner',
    // brand new: in no baseline
    'playback.rtsp', 'playback.hls', 'net.http_request', 'display.power_schedule', 'remote.set_server_url']) {
    assert.equal(caps.supports(row, c), false, `baseline must not grant ${c}`);
  }
});

test('BASELINE.windows is no wider than BASELINE.linux — the same engine, fewer proven OS rows', () => {
  for (const c of caps.BASELINE.windows) {
    assert.ok(caps.BASELINE.linux.includes(c), `BASELINE.windows claims ${c}, which even the Pi baseline does not`);
  }
});

test('command gating for a declaring Windows player', () => {
  const declared = { ...WIN, capabilities: JSON.stringify(['playback.video', 'system.shell', 'system.pty', 'system.kiosk',
    'system.time', 'system.reboot', 'system.install_apk', 'system.screen_timeout', 'display.power']) };
  for (const cmd of ['shell', 'kiosk_lock', 'kiosk_unlock', 'lock_now', 'power_menu', 'set_time', 'set_timezone',
    'reboot', 'install_apk', 'screen_off', 'screen_on']) {
    assert.equal(caps.commandAllowed(declared, cmd).ok, true, `${cmd} must reach a Windows player that declared its capability`);
  }
  const undeclared = { ...WIN, capabilities: null };
  assert.deepEqual(caps.commandAllowed(undeclared, 'shell'), { ok: false, capability: 'system.shell' });
  assert.deepEqual(caps.commandAllowed(undeclared, 'install_apk'), { ok: false, capability: 'system.install_apk' });
  assert.equal(caps.commandAllowed(undeclared, 'reboot').ok, false, 'reboot needs the helper, so it must be declared');
});

test('set_server_url to a Windows player does not mint a web-player enrol key', () => {
  const { deliverCommand } = require('../lib/device-command');
  const sent = [];
  const deviceNs = {
    adapter: { rooms: new Map([['win-x', new Set(['s1'])]]) },
    to: () => ({ emit: (ev, p) => sent.push({ ev, p }) }),
  };
  const r = deliverCommand(deviceNs, { id: 'win-x', ...WIN, capabilities: JSON.stringify(['remote.set_server_url']) },
    'set_server_url', { url: 'https://new.example.com' });
  assert.equal(r.status, 'sent');
  assert.equal(sent[0].p.payload.enrol_key, undefined);
});

test('identity preservation keeps client_type win across a register that omits it', () => {
  const { preserveKnownIdentity } = require('../lib/liveness');
  const out = preserveKnownIdentity({ client_type: 'win', platform: WIN.platform }, { client_type: 'legacy', platform: 'unknown' });
  assert.equal(out.client_type, 'win');
  assert.equal(caps.platformFamily(out), 'windows');
});

/*
 * What the Windows build declares: the shared CAPABILITIES_ALWAYS (native/screentinker_native/
 * capabilities.py) plus whatever platform/windows/*.py can add (ops.extra_capabilities). Skipped
 * cleanly while the Windows backend is not in the tree.
 */
const NATIVE = path.join(__dirname, '..', '..', 'native', 'screentinker_native');
const WIN_OPS = path.join(NATIVE, 'platform', 'windows', 'ops.py');
function readWinCaps() {
  const strings = (s) => [...s.matchAll(/['"]([a-z]+\.[a-z_]+)['"]/g)].map((m) => m[1]);
  const anywhere = new Set(strings(fs.readFileSync(path.join(NATIVE, 'capabilities.py'), 'utf8')));
  for (const f of fs.readdirSync(path.dirname(WIN_OPS))) {
    if (f.endsWith('.py')) for (const c of strings(fs.readFileSync(path.join(path.dirname(WIN_OPS), f), 'utf8'))) anywhere.add(c);
  }
  return anywhere;
}

test('the Windows player declares only vocabulary this server knows', (t) => {
  if (!fs.existsSync(WIN_OPS)) return t.skip('native/screentinker_native/platform/windows/ops.py not in the tree yet');
  for (const c of readWinCaps()) {
    if (/^(playback|audio|display|remote|system|net|sync|offline)\./.test(c)) {
      assert.ok(caps.CAP_SET.has(c), `the Windows player names '${c}', which this server would silently drop (parseDeclared)`);
    }
  }
});

test('BASELINE.windows claims nothing the Windows player cannot declare', (t) => {
  if (!fs.existsSync(WIN_OPS)) return t.skip('native/screentinker_native/platform/windows/ops.py not in the tree yet');
  const anywhere = readWinCaps();
  for (const c of caps.BASELINE.windows) {
    assert.ok(anywhere.has(c), `BASELINE.windows claims ${c}, which neither capabilities.py nor platform/windows/ names`);
  }
});
