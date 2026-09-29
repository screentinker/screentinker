'use strict';

/*
 * The native Raspberry Pi player as the SERVER sees it: which family it is, what an undeclared row
 * falls back to, which commands it can be sent, and — when the Pi source is in the tree — that what
 * it declares is vocabulary this server understands.
 *
 * The trap this file exists for: platformFamily()'s Android arm is a FALLBACK that claims any
 * non-empty android_version that is not "Web/…". The Pi sends '' today, so it would merely fall to
 * the web baseline; one field away, it becomes an Android panel and is offered MediaProjection and
 * device-owner provisioning. So 'linux' is matched first, on two independent signals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pinative-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const caps = require('../lib/player-capabilities');

const PI = { client_type: 'pi', platform: 'Linux/Debian 12 (Raspberry Pi 5 Model B Rev 1.0)', android_version: '' };

test('a Pi is family linux — by client_type, by platform, and ahead of the Android fallback', () => {
  assert.equal(caps.platformFamily(PI), 'linux');
  assert.equal(caps.platformFamily({ client_type: 'pi' }), 'linux', 'client_type alone (platform erased by an old register)');
  assert.equal(caps.platformFamily({ platform: 'Linux/Raspbian 11 (Raspberry Pi 4 Model B Rev 1.4)' }), 'linux', 'platform alone');
  assert.equal(caps.platformFamily({ ...PI, android_version: 'Linux 6.6.31' }), 'linux', '⚠️ never android, whatever android_version says');
  assert.equal(caps.platformFamily({ ...PI, android_version: '14' }), 'linux');
});

test('nothing else moved: the other families classify exactly as before', () => {
  assert.equal(caps.platformFamily({ client_type: 'apk', android_version: '13' }), 'android');
  assert.equal(caps.platformFamily({ android_version: '9' }), 'android');
  assert.equal(caps.platformFamily({ platform: 'Tizen 6.5', client_type: 'wgt', android_version: 'Tizen 6.5' }), 'tizen');
  assert.equal(caps.platformFamily({ platform: 'brightsign' }), 'brightsign');
  assert.equal(caps.platformFamily({ platform: 'vega', android_version: 'Web/Chrome' }), 'vega');
  // The Chromium-kiosk install on a Pi is a BROWSER and must stay one.
  assert.equal(caps.platformFamily({ client_type: 'player', platform: 'Chrome 120', android_version: 'Web/Mozilla/5.0 (X11; Linux aarch64)' }), 'web');
  assert.equal(caps.platformFamily({ platform: 'Linux x86_64', android_version: 'Web/Chrome' }), 'web', 'navigator.platform is not our "Linux/" prefix');
});

test('an undeclared Pi row gets the linux baseline: working controls, no privilege', () => {
  const row = { ...PI, capabilities: null };
  for (const c of ['playback.video', 'audio.volume', 'display.power', 'remote.screenshot', 'remote.input', 'system.reboot', 'system.self_update', 'offline.cache']) {
    assert.equal(caps.supports(row, c), true, `baseline should grant ${c}`);
  }
  for (const c of ['system.shell', 'system.pty', 'system.kiosk', 'system.time', 'system.install_apk', 'system.device_owner', 'playback.rtsp', 'net.http_request']) {
    assert.equal(caps.supports(row, c), false, `baseline must not grant ${c}`);
  }
});

test('command gating for a declaring Pi', () => {
  const declared = { ...PI, capabilities: JSON.stringify(['playback.video', 'system.shell', 'system.pty', 'system.kiosk', 'system.time', 'system.reboot']) };
  for (const cmd of ['shell', 'kiosk_lock', 'kiosk_unlock', 'lock_now', 'power_menu', 'set_time', 'set_timezone', 'reboot']) {
    assert.equal(caps.commandAllowed(declared, cmd).ok, true, `${cmd} must reach a Pi that declared its capability`);
  }
  assert.deepEqual(caps.commandAllowed(declared, 'install_apk'), { ok: false, capability: 'system.install_apk' },
    'the .deb installer rides install_apk and needs system.install_apk declared');
  const undeclared = { ...PI, capabilities: null };
  assert.deepEqual(caps.commandAllowed(undeclared, 'shell'), { ok: false, capability: 'system.shell' });
  assert.deepEqual(caps.commandAllowed(undeclared, 'kiosk_lock'), { ok: false, capability: 'system.kiosk' });
});

test('system.pty gates no device:command — it is an event protocol, not a command', () => {
  assert.equal(Object.values(caps.COMMAND_CAPABILITY).flat().includes('system.pty'), false);
  const { ALLOWED_COMMANDS, MESH_COMMANDS } = require('../lib/device-command');
  for (const list of [ALLOWED_COMMANDS, MESH_COMMANDS]) {
    assert.equal(list.some((c) => /pty/.test(c)), false, 'no pty command name in either allowlist');
  }
});

test('set_server_url to a Pi does not mint a web-player enrol key', () => {
  // The enrol-key branch is keyed on client_type 'player' (a browser, whose storage is origin-
  // scoped). A Pi keeps its own token file and must not be handed a URL-carried identity.
  const { deliverCommand } = require('../lib/device-command');
  const sent = [];
  const deviceNs = {
    adapter: { rooms: new Map([['pi-x', new Set(['s1'])]]) },
    to: () => ({ emit: (ev, p) => sent.push({ ev, p }) }),
  };
  const r = deliverCommand(deviceNs, { id: 'pi-x', ...PI, capabilities: JSON.stringify(['remote.set_server_url']) },
    'set_server_url', { url: 'https://new.example.com' });
  assert.equal(r.status, 'sent');
  assert.equal(sent[0].p.payload.enrol_key, undefined);
});

/*
 * The Pi's own declaration, when it is in the tree. The expected shape (native/screentinker_native/capabilities.py):
 *
 *   CAPABILITIES_ALWAYS = [
 *       'playback.video',
 *       ...
 *   ]
 *   def declared_capabilities(...): ...
 *
 * Only the string literals inside the CAPABILITIES_ALWAYS [...] are read; strings elsewhere in the
 * file (conditional ones added by declared_capabilities) are collected separately as "may declare".
 * Skipped cleanly while the file does not exist yet.
 */
const PI_CAPS = path.join(__dirname, '..', '..', 'native', 'screentinker_native', 'capabilities.py');
function readPiCaps() {
  const src = fs.readFileSync(PI_CAPS, 'utf8');
  const block = /CAPABILITIES_ALWAYS\s*(?::[^=]*)?=\s*[[(]([\s\S]*?)[\])]/.exec(src);
  const strings = (s) => [...s.matchAll(/['"]([a-z]+\.[a-z_]+)['"]/g)].map((m) => m[1]);
  const anywhere = new Set(strings(src));
  // The engine now serves two OSes: what depends on privilege/hardware (reboot, time, install,
  // screen_timeout, brightness) moved to platform/linux/ops.extra_capabilities(), so "may declare"
  // is capabilities.py PLUS the Linux backend.
  const linuxDir = path.join(path.dirname(PI_CAPS), 'platform', 'linux');
  try {
    for (const f of fs.readdirSync(linuxDir)) {
      if (f.endsWith('.py')) for (const c of strings(fs.readFileSync(path.join(linuxDir, f), 'utf8'))) anywhere.add(c);
    }
  } catch (_) { /* pre-split tree: capabilities.py alone */ }
  return { always: block ? strings(block[1]) : null, anywhere };
}

test('the Pi declares only vocabulary this server knows', (t) => {
  if (!fs.existsSync(PI_CAPS)) return t.skip('native/screentinker_native/capabilities.py not in the tree yet');
  const { always, anywhere } = readPiCaps();
  assert.ok(always && always.length, 'CAPABILITIES_ALWAYS = [...] not found (or empty) in capabilities.py');
  for (const c of anywhere) {
    if (/^(playback|audio|display|remote|system|net|sync|offline)\./.test(c)) {
      assert.ok(caps.CAP_SET.has(c), `the Pi names '${c}', which this server would silently drop (parseDeclared)`);
    }
  }
});

test('BASELINE.linux claims nothing the Pi player cannot declare', (t) => {
  // The over-claim direction, as for every device-artifact baseline: an undeclared row must never be
  // offered a control the player has no code for.
  if (!fs.existsSync(PI_CAPS)) return t.skip('native/screentinker_native/capabilities.py not in the tree yet');
  const { anywhere } = readPiCaps();
  for (const c of caps.BASELINE.linux) {
    assert.ok(anywhere.has(c), `BASELINE.linux claims ${c}, which neither native/screentinker_native/capabilities.py nor platform/linux/ names`);
  }
});
