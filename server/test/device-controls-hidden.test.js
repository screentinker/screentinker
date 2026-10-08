'use strict';

// The dashboard offered every control to every display. "Reboot device" on a browser tab, screen
// power on a Tizen TV, a Remote tab whose live view is a permanently black canvas on a player with
// no framebuffer read. Every one of them looked like a working button and did nothing — the
// "reports success and changes nothing" shape that keeps costing people days.
//
// Controls are now HIDDEN, not disabled: a greyed-out button on a panel that will never gain the
// capability is a permanent unanswerable question. Which makes the opposite failure the dangerous
// one — a gate that is slightly too strict strips controls from the several hundred displays
// already in the field, none of which declare anything. That case gets its own test below, and it
// is the one to read first if this file ever goes red.
//
// This renders the real device-detail template out of the source file rather than asserting on a
// copy of it, so a control added later without a gate shows up here instead of in production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

// The template is one tagged region inside loadDevice(). Pull it out and evaluate it against
// stubbed helpers — the point is which controls appear, not how they are styled.
const START = 'contentEl.innerHTML = `';
const template = (() => {
  const i = SRC.indexOf(START);
  assert.ok(i > 0, 'device-detail.js no longer has the innerHTML template this test renders');
  const j = SRC.indexOf('\n    `;', i);
  assert.ok(j > i, 'could not find the end of the template');
  return SRC.slice(i + START.length, j);
})();

function render(device, telemetry) {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : null;
  const sandbox = {
    device,
    caps,
    can: (cap) => (caps ? caps.includes(cap) : true),
    // #go2rtc: the server master switch for live video, resolved in loadDevice() OUTSIDE the sliced
    // template. It gates the per-device live-video toggle in the Settings tab (a dashboard setting,
    // not a device capability, so it is platform-independent). Rendered here so the branch is
    // exercised; it is not one of the platform-gated controls this file is about.
    liveVideoAvailable: true,
    // #talk master switch (features.talk), resolved in loadDevice() outside the slice like
    // liveVideoAvailable. True here so the Talk controls render and their capability gating (the
    // subject of this file) is what decides visibility; the per-org flag is enforced server-side.
    talkAvailable: true,
    latestTelemetry: telemetry || {},
    diagWidget: null,
    // Stubs. Each returns something recognisable so a control cannot be "found" by accident.
    t: (key) => key,
    esc: (s) => String(s == null ? '' : s),
    formatBytes: () => '0 MB',
    formatUptime: () => '0m',
    ssidLabel: () => 'ssid',
    livenessBadge: () => ({ state: 'online', label: 'online', title: '' }),
    renderDiagPanel: () => '',
    renderDeviceClock: () => '',
    renderPlaylist: () => '',
    isBrightSignDevice: (d) => String(d.platform || '').toLowerCase().includes('brightsign'),
    // Same four signals, same order, as the real helper in device-detail.js and platformFamily()
    // in server/lib/player-capabilities.js. Kept as a stub rather than imported because this file
    // renders the template in a bare VM context — but if the real rule changes, change it here too.
    // The brightsign/tizen/wgt short-circuits come FIRST and are load-bearing: a Tizen TV registers
    // android_version 'Tizen 6.5', which satisfies the Android test below.
    isAndroidDevice: (d) => {
      if (!d) return false;
      const p = String(d.platform || '').toLowerCase();
      if (p.includes('brightsign') || p.includes('tizen')) return false;
      if (d.client_type === 'wgt') return false;
      if (d.client_type === 'pi' || p.startsWith('linux/')) return false;   // the native Pi player
      if (d.client_type === 'win' || p.startsWith('windows/')) return false;   // the native Windows player
      if (d.client_type === 'mac' || p.startsWith('macos/')) return false;   // the native macOS player
      if (d.client_type === 'apk') return true;
      const av = String(d.android_version || '');
      return av !== '' && !av.startsWith('Web/');
    },
    TERMINAL_PRESETS: [],
    LINUX_TERMINAL_PRESETS: [{ label: 'SoC temp', cmd: 'vcgencmd measure_temp' }],
    // Mirrors isLinuxDevice() in device-detail.js (and the 'linux' arm of platformFamily()).
    isLinuxDevice: (d) => !!d && (d.client_type === 'pi' || String(d.platform || '').toLowerCase().startsWith('linux/')),
    // Mirrors isWindowsDevice() / isNativeDevice() / terminalPresets() in device-detail.js.
    isWindowsDevice: (d) => !!d && (d.client_type === 'win' || String(d.platform || '').toLowerCase().startsWith('windows/')),
    isNativeDevice: (d) => !!d && (d.client_type === 'pi' || d.client_type === 'win' || d.client_type === 'mac'
      || /^(linux|windows|macos)\//.test(String(d.platform || '').toLowerCase())),
    terminalPresets: (d) => {
      const p = String((d && d.platform) || '').toLowerCase();
      if (d && (d.client_type === 'win' || p.startsWith('windows/'))) return [{ label: 'Helper service', cmd: 'Get-Service ScreenTinkerHelper' }];
      if (d && (d.client_type === 'pi' || p.startsWith('linux/'))) return [{ label: 'SoC temp', cmd: 'vcgencmd measure_temp' }];
      return [];
    },
    // Panels rendered by helpers OUTSIDE the sliced template are stubbed to empty: this file is
    // about which CONTROLS a platform is offered, and a diagnostics panel is not a control. Stubbing
    // keeps the slice honest — the alternative is widening it until the test is about the whole page.
    renderTriggerDiagnostics: () => '',
    // Same reason as the line above: this harness evaluates the TEMPLATE in a bare VM, so every
    // helper the template calls has to be stubbed or it is a ReferenceError rather than a missing
    // section. The subject here is which CONTROLS a platform is offered, not what the trigger
    // panels render.
    renderTriggerConfig: () => '',
    // Same again for the playlist-inheritance badge ("Inherited from Lobby" / "Set for this
    // screen" + revert). It is not platform-dependent, so it is not this file's subject; it has
    // its own coverage in test/device-playlist-source-badge.test.js.
    playlistSourceBadge: () => '',
    // Same again for the capture-tier notice ("this panel is only showing the player's own
    // window"). It explains a capture STATE the panel reported, not a control the platform is or
    // is not offered, so it is not this file's subject; it is covered in test/capture-mode.test.js.
    captureModeNotice: () => '',
    // Same again for the head office (corporate) playlist section that replaces the picker on a
    // screen head office drives. A recognisable marker, so the test below can see it was chosen.
    corporatePlaylistTab: () => '<!--corporate-playlist-tab-->',
    localStorage: { getItem: () => null, setItem: () => {} },
    Math, Date, JSON, String, Array, Object,
  };
  return vm.runInNewContext('`' + template + '`', sandbox);
}

const ANDROID_FULL = {
  client_type: 'apk', android_version: '13',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update'],
};
const WEB = {
  android_version: 'Web/Chrome',
  capabilities: ['playback.video', 'audio.volume', 'remote.screenshot', 'remote.stream',
    'remote.input', 'system.restart_player'],
};
// Exactly what tizen/js/app.js registers, including the android_version field — which reads
// 'Tizen 6.5' and NOT anything Android-shaped. An earlier version of this fixture omitted it, so
// every "not offered to Tizen" assertion below passed without ever exercising the case that
// actually matters.
const TIZEN = {
  platform: 'Tizen 6.5', client_type: 'wgt', android_version: 'Tizen 6.5',
  capabilities: ['playback.video', 'audio.volume', 'display.rotation', 'remote.input',
    'system.restart_player'],
};
const BRIGHTSIGN = {
  platform: 'brightsign', hardware_model: 'XT245',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.rotation',
    'remote.input', 'system.reboot', 'system.restart_player'],
};

const has = (html, id) => html.includes(`id="${id}"`);

// Same harness, but with a telemetry payload — the cards above are driven by it.
function renderWith(device, telemetry) {
  const saved = renderWith._tel;
  renderWith._tel = telemetry;
  try { return render(device, telemetry); } finally { renderWith._tel = saved; }
}

test('a browser tab is no longer offered controls over a machine it cannot touch', () => {
  const html = render(WEB);
  assert.equal(has(html, 'rebootBtn'), false, 'a tab cannot reboot the PC it is running on');
  assert.equal(has(html, 'shutdownBtn'), false);
  assert.equal(has(html, 'screenOffBtn'), false, 'nor switch off the monitor');
  assert.equal(has(html, 'screenOnBtn'), false);
  assert.equal(has(html, 'forceUpdateBtn'), false, 'nor update itself — the page reloads instead');
  assert.ok(has(html, 'launchAppBtn'), 'but reloading the player IS something it can do');
});

test('a Tizen TV is not offered screen power or the reboot it has no API for', () => {
  const html = render(TIZEN);
  assert.equal(has(html, 'screenOffBtn'), false);
  assert.equal(has(html, 'screenOnBtn'), false);
  assert.equal(has(html, 'rebootBtn'), false);
  assert.equal(has(html, 'forceUpdateBtn'), false);
});

test('a BrightSign IS offered the screen power and reboot it genuinely has', () => {
  // The check that catches gating written as "hide everything that is not Android", which would
  // read as correct on every other test in this file.
  const html = render(BRIGHTSIGN);
  assert.ok(has(html, 'screenOffBtn'));
  assert.ok(has(html, 'screenOnBtn'));
  assert.ok(has(html, 'rebootBtn'));
});

test('an Android panel keeps the full control set', () => {
  const html = render(ANDROID_FULL);
  for (const id of ['rebootBtn', 'screenOffBtn', 'screenOnBtn', 'launchAppBtn', 'forceUpdateBtn',
    'screenshotBtn', 'startRemoteBtn', 'sysVolume', 'sysWinBrightness']) {
    assert.ok(has(html, id), `${id} must survive`);
  }
});

test('THE REGRESSION THAT MATTERS: an undeclared legacy display loses nothing', () => {
  // ~440 real displays declare nothing. If the gate reads "no declaration => supports nothing",
  // every one of them loses its entire control panel the moment this deploys — a far worse bug
  // than the one being fixed. The server resolves a per-platform baseline for them, and this
  // asserts the client renders whatever it is handed rather than second-guessing it.
  const legacyAndroid = { client_type: 'apk', android_version: '9' };   // no capabilities field
  const html = render(legacyAndroid);
  for (const id of ['rebootBtn', 'screenOffBtn', 'screenOnBtn', 'launchAppBtn', 'forceUpdateBtn',
    'screenshotBtn', 'startRemoteBtn']) {
    assert.ok(has(html, id), `${id} disappeared for a display that never declared anything`);
  }
});

test('the live view is hidden on a player that cannot capture, and the key pad is not', () => {
  // Start used to produce a canvas that stayed black forever, which reads as a dead panel rather
  // than as an unsupported feature. The D-pad still works there — it is a different mechanism.
  const html = render(TIZEN);
  assert.equal(has(html, 'startRemoteBtn'), false, 'no screenshot stream to start');
  assert.equal(has(html, 'remoteCanvas'), false, 'and no permanently black canvas');
  assert.ok(html.includes('KEYCODE_DPAD_CENTER'), 'key input is unaffected');
});

test('a player with no remote surface at all loses the whole Remote tab', () => {
  const blind = { platform: 'brightsign', capabilities: ['playback.video', 'audio.volume'] };
  const html = render(blind);
  assert.equal(html.includes('data-tab="remote"'), false, 'no tab');
  assert.equal(has(html, 'tab-remote'), false, 'and no orphaned tab body behind it');
});

test('a tab trigger is never rendered without its content, or the click blanks the page', () => {
  // setupTabs() does getElementById(`tab-${dataset.tab}`).classList.add(...) with no null check,
  // so a trigger whose body was gated away throws on click and leaves every tab deselected.
  for (const device of [WEB, TIZEN, BRIGHTSIGN, ANDROID_FULL, { client_type: 'apk' }]) {
    const html = render(device);
    for (const m of html.matchAll(/data-tab="([\w-]+)"/g)) {
      assert.ok(has(html, `tab-${m[1]}`),
        `tab "${m[1]}" has a trigger but no content for ${device.platform || device.android_version || 'apk'}`);
    }
  }
});

test('the capability list is shown, so a missing control is explainable', () => {
  // Hiding controls with no explanation just moves the confusion: "the reboot button vanished"
  // is a support ticket unless the page says what the panel reported.
  const html = render(TIZEN);
  assert.ok(html.includes('device.caps.title'));
  assert.ok(html.includes('remote.input'), 'the actual declared names are listed');
  assert.ok(html.includes('device.caps.declared'));

  const legacy = render({ client_type: 'apk' });
  assert.ok(legacy.includes('device.caps.assumed'),
    'and an undeclared display says so rather than presenting a guess as fact');
});

test('every gated control still renders balanced markup', () => {
  // A gate placed around an opening tag but not its close leaves the rest of the page inside a
  // stray element, which does not throw and does not show up in any assertion above.
  for (const device of [WEB, TIZEN, BRIGHTSIGN, ANDROID_FULL, { client_type: 'apk' },
    { platform: 'brightsign', capabilities: [] }]) {
    const html = render(device);
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    assert.equal(open, close,
      `unbalanced <div> for ${device.platform || device.android_version || 'apk'}: ${open} open, ${close} close`);
    const bopen = (html.match(/<button\b/g) || []).length;
    const bclose = (html.match(/<\/button>/g) || []).length;
    assert.equal(bopen, bclose, 'unbalanced <button>');
  }
});

// ---------------------------------------------------------------------------------------------
// The MediaProjection capture bootstrap.
//
// This button is what turns screen capture ON for an Android panel that cannot do it yet. It hung
// off can('remote.screenshot') — which is backwards twice over. Android declares that capability
// only once the accessibility service is running, so the gate hid the button from every panel that
// still needed pressing, and showed it on browsers and TVs that have no MediaProjection at all.

test('the capture bootstrap is offered to an Android panel that cannot capture yet', () => {
  const html = render({ client_type: 'apk', android_version: '13',
    capabilities: ['playback.video', 'remote.input'] });
  assert.ok(has(html, 'enableSystemCaptureBtn'),
    'a panel with no remote.screenshot is exactly the one that needs the bootstrap');
});

test('THE ~440: a legacy panel keeps the button, using the shape the API really returns', () => {
  // Fed through the REAL capabilitiesFor(), not a fixture with the field missing. That distinction
  // sank an earlier version of this test: it rendered a device with no `capabilities` key at all,
  // which made the harness's caps null — a shape GET /api/devices/:id never produces, because it
  // resolves declared-or-baseline into one populated array. The test passed while production did
  // the opposite, and the android baseline CONTAINS remote.screenshot, so any gate keyed on
  // "already has capture" hides the bootstrap from every undeclared panel in the field.
  const { capabilitiesFor } = require('../lib/player-capabilities');
  const row = { client_type: 'apk', android_version: '11' };            // declares nothing
  const resolved = capabilitiesFor(row);
  assert.ok(resolved.includes('remote.screenshot'),
    'precondition: the baseline grants capture, which is what makes the naive gate wrong');
  const html = render({ ...row, capabilities: resolved });
  assert.ok(has(html, 'enableSystemCaptureBtn'), 'the ~440 must not lose the bootstrap');
});

test('a panel that already declares capture is still offered the better path', () => {
  // Deliberately NOT hidden. Declaring remote.screenshot on Android means the accessibility path;
  // MediaProjection is the one WebSocketService tries first and is strictly better, so this is an
  // upgrade rather than a redundant control.
  assert.ok(has(render(ANDROID_FULL), 'enableSystemCaptureBtn'));
});

test('nothing that lacks MediaProjection is offered it', () => {
  // A browser tab, a Tizen TV and a BrightSign have no such API. The old gate showed the button on
  // all three whenever they declared remote.screenshot by their own, unrelated means.
  for (const [name, dev] of [['web', WEB], ['tizen', TIZEN], ['brightsign', BRIGHTSIGN]]) {
    assert.equal(has(render(dev), 'enableSystemCaptureBtn'), false,
      `${name} has no MediaProjection to bootstrap`);
  }
});

test('a device-owner panel is told it already has system capture instead', () => {
  // Tier 2 needs no consent flow at all, so it gets the explanatory line, not the button.
  const html = render({ client_type: 'apk', android_version: '13', tier: 2,
    capabilities: ['playback.video'] });
  assert.equal(has(html, 'enableSystemCaptureBtn'), false, 'an owner does not need to be asked');
});

// ---------------------------------------------------------------------------------------------
// Pinning the REAL helper.
//
// Everything above renders the genuine template but runs it against the stubbed isAndroidDevice in
// the sandbox, because the template is evaluated in a bare VM context. That means the assertions
// about Tizen prove the STUB is right, not the shipped function — mutation-testing confirmed it:
// reverting device-detail.js to the buggy two-signal helper leaves every test above green.
//
// So assert against the source directly. It is a coarse check, but it is the difference between a
// convention ("if the real rule changes, change it here too") and something that fails.

test('the shipped isAndroidDevice short-circuits brightsign, tizen and wgt BEFORE the Android test', () => {
  const fn = (() => {
    const i = SRC.indexOf('function isAndroidDevice(device) {');
    assert.notEqual(i, -1, 'device-detail.js no longer defines isAndroidDevice');
    let depth = 0, end = -1;
    for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}' && --depth === 0) { end = k + 1; break; }
    }
    return SRC.slice(i, end);
  })();

  // A Tizen TV registers android_version 'Tizen 6.5' (tizen/js/app.js), which satisfies the
  // Android test. Only an earlier short-circuit keeps a MediaProjection button off a Samsung panel.
  const brightsign = fn.indexOf("includes('brightsign')");
  const tizen = fn.indexOf("includes('tizen')");
  const wgt = fn.indexOf("'wgt'");
  const androidTest = fn.indexOf("startsWith('Web/')");
  for (const [name, idx] of [['brightsign', brightsign], ['tizen', tizen], ['wgt', wgt]]) {
    assert.notEqual(idx, -1, `isAndroidDevice lost its ${name} short-circuit`);
    assert.ok(idx < androidTest, `the ${name} short-circuit must come BEFORE the android_version test`);
  }

  // And behave correctly when actually executed, not merely contain the right text.
  const real = eval(`(${fn.replace('function isAndroidDevice', 'function')})`);   // eslint-disable-line no-eval
  assert.equal(real({ platform: 'Tizen 6.5', client_type: 'wgt', android_version: 'Tizen 6.5' }), false,
    'a Tizen TV as it really registers');
  assert.equal(real({ client_type: 'wgt' }), false, 'the .wgt signal alone is enough');
  assert.equal(real({ platform: 'brightsign', android_version: 'Web/Chrome 120' }), false, 'a BrightSign');
  assert.equal(real({ android_version: 'Web/Chrome' }), false, 'a browser tab');
  assert.equal(real({ client_type: 'apk', android_version: '11' }), true, 'a legacy Android panel');
  assert.equal(real({ android_version: '9' }), true, 'an Android panel paired before client_type existed');
  assert.equal(real(null), false, 'and it never throws on a missing device');
});

// Info cards follow the DATA, not the platform.
//
// RAM and CPU were gated on "is this an Android panel?", which was right when Android was the only
// family that could measure them. A BrightSign widget runs with nodejs_enabled, so the bridge now
// reads os.totalmem/freemem and the load average — the numbers arrive and the old gate threw them
// away. Storage on that family was worse than absent: it reported the browser's cache quota, so a
// 119 GB player displayed "1026 MB".

const BS_WITH_DATA = {
  platform: 'brightsign', hardware_model: 'XT245', hardware_os_version: '9.1.93.2',
  android_version: 'Web/Safari/537.36', local_ip: '192.168.1.46',
  capabilities: ['playback.video', 'audio.volume', 'remote.input'],
};
const REAL_TELEMETRY = {
  storage_free_mb: 119563, storage_total_mb: 119616,
  ram_free_mb: 2773, ram_total_mb: 3656, cpu_usage: 5, uptime_seconds: 149,
};

test('a BrightSign that reports memory and load gets cards for them', () => {
  const html = renderWith(BS_WITH_DATA, REAL_TELEMETRY);
  assert.ok(has(html, 'telRam'), 'RAM card missing on a player that reports RAM');
  assert.ok(has(html, 'telCpu'), 'CPU card missing on a player that reports load');
  assert.ok(has(html, 'telStorage'), 'and the disk it now measures for real');
});

test('Android keeps its cards whether or not a reading has arrived yet', () => {
  // The old gate was platform-based, so an Android panel with no telemetry still showed "--".
  // Switching to data-presence must not take that away — an empty card is a known state, a missing
  // one reads as "this panel cannot do that".
  for (const tel of [REAL_TELEMETRY, {}]) {
    const html = renderWith({ client_type: 'apk', android_version: '13', capabilities: ['playback.video'] }, tel);
    assert.ok(has(html, 'telRam'), 'Android must keep its RAM card');
    assert.ok(has(html, 'telCpu'), 'Android must keep its CPU card');
  }
});

test('a browser tab gains nothing — it measures none of this', () => {
  const html = renderWith({ android_version: 'Web/Chrome', capabilities: ['playback.video'] }, {});
  assert.equal(has(html, 'telRam'), false);
  assert.equal(has(html, 'telCpu'), false);
});

test('the attached display and video mode get cards when reported', () => {
  const html = renderWith(BS_WITH_DATA, { ...REAL_TELEMETRY, attached_display: 'CX101', video_mode: '1920x1200@60' });
  assert.ok(has(html, 'telDisplay'), 'the panel EDID card');
  assert.ok(has(html, 'telVideoMode'), 'the negotiated mode card');
  assert.ok(html.includes('CX101'), 'and the monitor name itself');
});

test('a player that cannot read its output grows no empty rows', () => {
  const html = renderWith(BS_WITH_DATA, REAL_TELEMETRY);
  assert.equal(has(html, 'telDisplay'), false);
  assert.equal(has(html, 'telVideoMode'), false);
});

// ---------------------------------------------------------------------------------------------
// The System View pad and `tier`
//
// `tier` is an ANDROID device-owner concept — NOT NULL DEFAULT 0 in db/database.js, written only
// from the APK's DeviceInfo. A BrightSign, Tizen or web player never sends it, so it sits at the
// column default forever and can never reach 2. The pad was gated on `tier === 2` alone, which
// meant HOME / BACK / POWER / the D-pad / OK rendered click-blocked on every non-Android display
// — for keys those players genuinely handle (server/player/index.html:1895-1938,
// tizen/js/app.js:435-444). That is the "button that cannot work" this whole file argues against,
// inverted: a button that DOES work, presented as if it does not.
// ---------------------------------------------------------------------------------------------

// The pad is one div; read the inline style off it rather than asserting on the whole document.
// Reads FORWARD from the id — the style attribute follows it on the same tag. An earlier version
// searched backwards and picked up the preceding <hr>'s style, which made three of these tests
// pass without ever looking at the pad.
const padStyle = (html) => {
  const i = html.indexOf('id="systemViewControls"');
  if (i === -1) return null;
  const s = html.indexOf('style="', i);
  const end = html.indexOf('>', i);
  if (s === -1 || s > end) return '';   // the tag carries no style at all
  return html.slice(s + 7, html.indexOf('"', s + 7));
};

test('the system view pad is live on a BrightSign, which has no tier to earn', () => {
  const style = padStyle(render(BRIGHTSIGN));
  assert.ok(style, 'the pad must still render — these keys work on a BrightSign');
  assert.ok(!style.includes('pointer-events:none'), `pad was click-blocked: ${style}`);
  assert.ok(!style.includes('opacity:0.4'), `pad was greyed: ${style}`);
});

test('and on Tizen, for the same reason', () => {
  const style = padStyle(render(TIZEN));
  assert.ok(style && !style.includes('pointer-events:none'), `pad was click-blocked: ${style}`);
});

test('but an Android device that has NOT earned device-owner is still locked', () => {
  // The #161 gate is real on Android: without device-owner these keycodes need the accessibility
  // path, and offering them unlocked would be the original sin in the other direction.
  const style = padStyle(render({ ...ANDROID_FULL, tier: 0 }));
  assert.ok(style.includes('pointer-events:none'), `tier-0 Android must stay locked: ${style}`);
  assert.ok(style.includes('opacity:0.4'), `tier-0 Android must stay greyed: ${style}`);
});

test('and an Android device owner is unlocked', () => {
  const style = padStyle(render({ ...ANDROID_FULL, tier: 2 }));
  assert.ok(!style.includes('pointer-events:none'), `tier-2 Android must be live: ${style}`);
});

test('the two genuinely Android-only keys are not offered elsewhere', () => {
  // KEYCODE_APP_SWITCH has a case only in the APK (WebSocketService.kt:1068). 'settings' has no
  // handler outside Android at all and is not even in COMMAND_CAPABILITY, so the server forwards
  // it and a non-Android player silently drops it — a button that reports success and does
  // nothing, which is worse than an absent one.
  for (const [name, dev] of [['brightsign', BRIGHTSIGN], ['tizen', TIZEN], ['web', WEB]]) {
    const html = render(dev);
    assert.ok(!html.includes('KEYCODE_APP_SWITCH'), `${name} must not offer Recents`);
    assert.ok(!html.includes("_sendCmd('settings')"), `${name} must not offer Settings`);
  }
  const android = render({ ...ANDROID_FULL, tier: 2 });
  assert.ok(android.includes('KEYCODE_APP_SWITCH'), 'Android keeps Recents');
  assert.ok(android.includes("_sendCmd('settings')"), 'Android keeps Settings');
});

test('the keys that DO work off Android are still rendered everywhere', () => {
  // The failure this guards against is an over-eager cleanup that deletes the whole pad off
  // Android, taking five working controls with it.
  for (const [name, dev] of [['brightsign', BRIGHTSIGN], ['tizen', TIZEN], ['web', WEB]]) {
    const html = render(dev);
    for (const key of ['KEYCODE_HOME', 'KEYCODE_BACK', 'KEYCODE_POWER', 'KEYCODE_DPAD_CENTER']) {
      assert.ok(html.includes(key), `${name} must keep ${key} — the player handles it`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Player version on the Info tab
//
// The version card lived inside the block gated on
//   device.android_version && !device.android_version.startsWith('Web/')
// so it rendered for the APK only. A BrightSign, Tizen or web player registers android_version as
// "Web/<ua>", which fails that test — so those panels showed no version anywhere in the UI, and an
// operator had no way to tell a freshly-provisioned host from a year-old one.
// ---------------------------------------------------------------------------------------------

const infoCard = (html, label) => {
  const i = html.indexOf(label);
  if (i === -1) return null;
  const v = html.indexOf('info-card-value', i);
  return v === -1 ? null : html.slice(v, html.indexOf('</div>', v));
};

test('a BrightSign shows its player version on the Info tab', () => {
  const html = render({ ...BRIGHTSIGN, app_version: '1.9.36', client_version: '1.1.0-web' });
  const card = infoCard(html, 'device.info.app_version');
  assert.ok(card, 'the version card must render off Android');
  assert.ok(card.includes('1.9.36'), `expected the host package version, got: ${card}`);
});

test('and the page version alongside it, because the two can disagree', () => {
  // On a BrightSign app_version is the on-device host package and client_version is the page we
  // serve. A stale host against a fresh page is exactly the skew worth seeing at a glance.
  const html = render({ ...BRIGHTSIGN, app_version: '1.9.36', client_version: '1.1.0-web' });
  const i = html.indexOf('device.info.app_version');
  assert.ok(html.slice(i, i + 400).includes('1.1.0-web'), 'the page version should appear too');

  // When they match there is nothing to disambiguate, so it must not be repeated.
  const same = render({ ...BRIGHTSIGN, app_version: '1.9.36', client_version: '1.9.36' });
  const j = same.indexOf('device.info.app_version');
  const seg = same.slice(j, j + 400);
  assert.equal((seg.match(/1\.9\.36/g) || []).length, 1, 'identical versions must not be shown twice');
});

test('Tizen and web players get it too, and Android is unchanged', () => {
  for (const [name, dev] of [['tizen', TIZEN], ['web', WEB], ['android', ANDROID_FULL]]) {
    const html = render({ ...dev, app_version: '9.9.9' });
    const card = infoCard(html, 'device.info.app_version');
    assert.ok(card && card.includes('9.9.9'), `${name} must show a player version`);
  }
});

test('the Android-only cards stay Android-only', () => {
  // Moving the version card out must not drag the APK-specific ones with it: a settings PIN and an
  // Android OS version mean nothing on a BrightSign.
  const bs = render({ ...BRIGHTSIGN, app_version: '1.9.36' });
  assert.ok(!bs.includes('device.info.settings_pin'), 'settings PIN is an APK concept');
  assert.ok(!bs.includes('device.info.android_version'), 'android_version is an APK concept');
  const android = render({ ...ANDROID_FULL, app_version: '1.9.36' });
  assert.ok(android.includes('device.info.settings_pin'), 'Android keeps its PIN card');
});

// ---------------------------------------------------------------------------------------------
// The native Raspberry Pi player (client_type 'pi', platform 'Linux/<distro> (<model>)').
//
// Every control on this page used to be decided by "is it Android?" or "is it tier 2?", and a Pi is
// neither: it sends android_version '' and has no device-owner tier. So the Terminal tab, the kiosk
// row and the OS card were unreachable for it even when it declared the capabilities behind them —
// and the Android-only bootstraps (MediaProjection, device-owner QR, Recents) must stay off it.
// ---------------------------------------------------------------------------------------------

const PI = {
  client_type: 'pi', platform: 'Linux/Debian 12 (Raspberry Pi 5 Model B Rev 1.0)', android_version: '',
  hardware_model: 'Raspberry Pi 5 Model B Rev 1.0', hardware_os_version: 'Debian GNU/Linux 12 (bookworm)',
  hardware_serial: '10000000abcdef01', tier: 0, settings_pin: '4321',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.brightness', 'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update',
    'system.shell', 'system.pty', 'system.kiosk', 'system.install_apk', 'system.time'],
};
const PI_TELEMETRY = { ram_free_mb: 3100, ram_total_mb: 8000, cpu_usage: 12.5, temperature_c: 52.1,
  storage_free_mb: 20000, storage_total_mb: 29000, uptime_seconds: 3600 };

test('a Pi gets the Terminal tab, with Linux presets and both modes', () => {
  const html = render(PI);
  assert.ok(html.includes('data-tab="terminal"'), 'the tab trigger');
  assert.ok(has(html, 'tab-terminal'), 'and its body');
  assert.ok(has(html, 'termModeOneshot') && has(html, 'termModeInteractive'), 'the mode switch');
  assert.ok(has(html, 'termOneshot') && has(html, 'termCmd'), 'the one-shot shell');
  assert.ok(has(html, 'ptyHost') && has(html, 'ptyConnect'), 'the interactive terminal host');
  assert.ok(html.includes('vcgencmd measure_temp'), 'Linux presets, not getprop');
  assert.ok(html.includes('device.terminal.welcome_linux'), 'and Linux wording');
});

test('the package field on a Pi asks for a .deb, and still sends install_apk', () => {
  const html = render(PI);
  assert.ok(has(html, 'apkUrl'), 'the field renders (the command is install_apk on both platforms)');
  assert.ok(html.includes('device.terminal.push_deb'), 'labelled for a .deb');
  assert.equal(html.includes('device.terminal.push_apk'), false, 'not an APK prompt');
  // And not offered to a Pi that did not declare it — the server would refuse the command.
  const noInstall = render({ ...PI, capabilities: PI.capabilities.filter((c) => c !== 'system.install_apk') });
  assert.equal(has(noInstall, 'apkUrl'), false);
});

test('Interactive mode needs system.pty, and one-shot needs system.shell', () => {
  const noPty = render({ ...PI, capabilities: PI.capabilities.filter((c) => c !== 'system.pty') });
  assert.ok(has(noPty, 'tab-terminal'), 'the tab stays for the one-shot shell');
  assert.equal(has(noPty, 'ptyHost'), false, 'no interactive terminal without system.pty');
  assert.equal(has(noPty, 'termModeInteractive'), false, 'and no switch to a mode that is not there');

  const ptyOnly = render({ ...PI, capabilities: PI.capabilities.filter((c) => c !== 'system.shell') });
  assert.ok(has(ptyOnly, 'ptyHost'), 'a PTY-only player still gets a terminal');
  assert.equal(has(ptyOnly, 'termOneshot'), false, 'but no one-shot shell it cannot run');
  assert.ok(ptyOnly.includes('id="termInteractive" style="display:block"'), 'and it is visible without a mode switch');

  const neither = render({ ...PI, capabilities: PI.capabilities.filter((c) => c !== 'system.shell' && c !== 'system.pty' && c !== 'system.install_apk') });
  assert.equal(neither.includes('data-tab="terminal"'), false, 'no terminal capability, no tab');
});

test('the Terminal tab did not move for Android or appear for a browser', () => {
  const owner = render({ ...ANDROID_FULL, tier: 2 });
  assert.ok(has(owner, 'tab-terminal'), 'a device owner keeps its shell');
  assert.ok(owner.includes('device.terminal.push_apk'), 'and its APK push');
  assert.equal(has(owner, 'ptyHost'), false, 'Android declares no system.pty');
  assert.equal(render({ ...ANDROID_FULL, tier: 0 }).includes('data-tab="terminal"'), false, 'tier 0 without system.shell: none');
  assert.equal(render(WEB).includes('data-tab="terminal"'), false, 'a browser tab: none');
});

test('a Pi declaring system.kiosk gets kiosk lock/unlock and the power menu', () => {
  const html = render(PI);
  for (const id of ['t2KioskOn', 't2KioskOff', 't2PowerMenu', 't2Reboot']) assert.ok(has(html, id), `${id} missing`);
  assert.ok(html.includes('device.tier2.label_linux'), 'not labelled "Device owner" on a Pi');
  const noKiosk = render({ ...PI, capabilities: PI.capabilities.filter((c) => c !== 'system.kiosk') });
  assert.equal(has(noKiosk, 't2KioskOn'), false, 'no kiosk capability, no kiosk row');
  assert.equal(has(noKiosk, 't2PowerMenu'), false);
});

test('a Pi is never offered the Android-only bootstraps', () => {
  const html = render(PI);
  assert.equal(has(html, 'deviceOwnerBtn'), false, 'no device-owner QR');
  assert.equal(has(html, 'enableSystemCaptureBtn'), false, 'no MediaProjection');
  assert.equal(html.includes('KEYCODE_APP_SWITCH'), false, 'no Recents');
  assert.equal(html.includes("_sendCmd('settings')"), false, 'no Android settings activity');
  // Even if a Pi build ever reported something in android_version.
  const odd = render({ ...PI, android_version: 'Linux 6.6.31' });
  assert.equal(has(odd, 'deviceOwnerBtn'), false);
  assert.equal(has(odd, 'enableSystemCaptureBtn'), false);
  const style = padStyle(html);
  assert.ok(style && !style.includes('pointer-events:none'), 'and the key pad is not locked behind a tier it cannot earn');
});

test('a Pi shows its OS, model, settings PIN and the telemetry it sends', () => {
  const html = renderWith(PI, PI_TELEMETRY);
  assert.ok(html.includes('device.info.linux_player'), 'player type says Linux, not "Web Player"');
  assert.ok(html.includes('Debian GNU/Linux 12 (bookworm)'), 'the OS card');
  assert.ok(html.includes('Raspberry Pi 5 Model B Rev 1.0'), 'the model card');
  assert.ok(html.includes('device.info.settings_pin') && html.includes('4321'), 'the settings PIN card');
  assert.equal(html.includes('device.info.android_version'), false, 'but no "Android Version"');
  for (const id of ['telRam', 'telCpu', 'telTemp', 'telStorage']) assert.ok(has(html, id), `${id} missing`);
  assert.equal(has(html, 'telBattery'), false, 'no battery on a Pi');
});

test('Pi markup is balanced in every gating combination', () => {
  for (const device of [PI, { ...PI, capabilities: [] }, { ...PI, capabilities: ['system.pty'] }, { ...PI, tier: 2 }]) {
    const html = render(device);
    assert.equal((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length, 'unbalanced <div>');
    assert.equal((html.match(/<button\b/g) || []).length, (html.match(/<\/button>/g) || []).length, 'unbalanced <button>');
    for (const m of html.matchAll(/data-tab="([\w-]+)"/g)) assert.ok(has(html, `tab-${m[1]}`), `orphan tab ${m[1]}`);
  }
});

test('the shipped isAndroidDevice rejects a Pi before the android_version fallback', () => {
  const i = SRC.indexOf('function isAndroidDevice(device) {');
  let depth = 0, end = -1;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}' && --depth === 0) { end = k + 1; break; }
  }
  const fn = SRC.slice(i, end);
  assert.ok(fn.indexOf("'pi'") !== -1 && fn.indexOf("'pi'") < fn.indexOf("startsWith('Web/')"),
    'the Pi short-circuit must come BEFORE the android_version test');
  const real = eval(`(${fn.replace('function isAndroidDevice', 'function')})`);   // eslint-disable-line no-eval
  assert.equal(real({ client_type: 'pi', android_version: 'Linux 6.6' }), false, 'client_type alone');
  assert.equal(real({ platform: 'Linux/Debian 12 (Raspberry Pi 4 Model B)', android_version: '12' }), false, 'platform alone');
  assert.equal(real({ client_type: 'apk', android_version: '13' }), true, 'Android unchanged');
});

// ---------------------------------------------------------------------------------------------
// The native Windows player (client_type 'win', platform 'Windows/<edition> (<model>)'). The same
// engine as the Pi, so the same controls — but PowerShell presets and wording, an .exe/.msi package
// field, its own player-type card, and never an Android bootstrap.
// ---------------------------------------------------------------------------------------------

const WIN = {
  client_type: 'win', platform: 'Windows/11 Pro 25H2 (OptiPlex 7010)', android_version: '',
  hardware_model: 'OptiPlex 7010', hardware_os_version: 'Windows 11 Pro 25H2 (build 26200)',
  hardware_serial: 'ABC1234', tier: 0, settings_pin: '8765',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.brightness', 'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update',
    'system.shell', 'system.pty', 'system.kiosk', 'system.install_apk', 'system.time', 'system.screen_timeout'],
};

test('a Windows player gets the Terminal tab with PowerShell presets, both modes, and Windows wording', () => {
  const html = render(WIN);
  assert.ok(html.includes('data-tab="terminal"') && has(html, 'tab-terminal'));
  assert.ok(has(html, 'termModeOneshot') && has(html, 'termModeInteractive'));
  assert.ok(has(html, 'ptyHost'), 'PowerShell over ConPTY rides the same system.pty relay');
  assert.ok(html.includes('Get-Service ScreenTinkerHelper'), 'PowerShell presets');
  assert.equal(html.includes('vcgencmd'), false, 'not the Pi presets');
  assert.ok(html.includes('device.terminal.welcome_windows'));
  assert.ok(html.includes('device.terminal.placeholder_windows'));
  assert.ok(html.includes('device.terminal.uid_note_windows'));
  assert.equal(html.includes('device.terminal.welcome_linux'), false);
});

test('the package field on Windows asks for an .exe/.msi, and is gated on system.install_apk', () => {
  const html = render(WIN);
  assert.ok(has(html, 'apkUrl'));
  assert.ok(html.includes('device.terminal.push_exe'), 'labelled for an installer');
  assert.ok(html.includes('device.terminal.exe_ph'));
  assert.equal(html.includes('device.terminal.push_deb'), false, 'not a .deb prompt');
  assert.equal(html.includes('device.terminal.push_apk'), false, 'not an APK prompt');
  const noInstall = render({ ...WIN, capabilities: WIN.capabilities.filter((c) => c !== 'system.install_apk') });
  assert.equal(has(noInstall, 'apkUrl'), false);
});

test('a Windows player is never offered the Android-only bootstraps', () => {
  for (const d of [WIN, { ...WIN, android_version: 'Windows 11' }, { client_type: 'win', android_version: '10', capabilities: WIN.capabilities }]) {
    const html = render(d);
    assert.equal(has(html, 'deviceOwnerBtn'), false, 'no device-owner QR');
    assert.equal(has(html, 'enableSystemCaptureBtn'), false, 'no MediaProjection');
    assert.equal(html.includes('KEYCODE_APP_SWITCH'), false, 'no Recents');
    assert.equal(html.includes("_sendCmd('settings')"), false, 'no Android settings activity');
  }
  const style = padStyle(render(WIN));
  assert.ok(style && !style.includes('pointer-events:none'), 'the key pad is not locked behind a tier it cannot earn');
});

test('a Windows player shows its type, OS, model and PIN — not an Android version', () => {
  const html = renderWith(WIN, PI_TELEMETRY);
  assert.ok(html.includes('device.info.windows_player'), 'player type says Windows');
  assert.equal(html.includes('device.info.linux_player'), false);
  assert.ok(html.includes('Windows 11 Pro 25H2 (build 26200)'), 'the OS card');
  assert.ok(html.includes('OptiPlex 7010'), 'the model card');
  assert.ok(html.includes('device.info.settings_pin') && html.includes('8765'));
  assert.equal(html.includes('device.info.android_version'), false);
});

test('Windows kiosk / power row is capability-gated and labelled as a native player', () => {
  const html = render(WIN);
  for (const id of ['t2KioskOn', 't2KioskOff', 't2PowerMenu', 't2Reboot']) assert.ok(has(html, id), `${id} missing`);
  assert.ok(html.includes('device.tier2.label_linux'), 'the generic "System:" label, not "Device owner"');
  const bare = render({ ...WIN, capabilities: WIN.capabilities.filter((c) => !['system.kiosk', 'system.reboot'].includes(c)) });
  assert.equal(has(bare, 't2KioskOn'), false);
  assert.equal(has(bare, 't2Reboot'), false);
  const none = render({ ...WIN, capabilities: ['playback.video'] });
  assert.equal(none.includes('data-tab="terminal"'), false, 'no terminal capability, no tab');
});

test('Windows markup is balanced in every gating combination', () => {
  for (const device of [WIN, { ...WIN, capabilities: [] }, { ...WIN, capabilities: ['system.pty'] }, { ...WIN, capabilities: ['system.shell'] }]) {
    const html = render(device);
    assert.equal((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length, 'unbalanced <div>');
    assert.equal((html.match(/<button\b/g) || []).length, (html.match(/<\/button>/g) || []).length, 'unbalanced <button>');
    for (const m of html.matchAll(/data-tab="([\w-]+)"/g)) assert.ok(has(html, `tab-${m[1]}`), `orphan tab ${m[1]}`);
  }
});

test('the shipped isAndroidDevice rejects a Windows player before the android_version fallback', () => {
  const i = SRC.indexOf('function isAndroidDevice(device) {');
  let depth = 0, end = -1;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}' && --depth === 0) { end = k + 1; break; }
  }
  const fn = SRC.slice(i, end);
  assert.ok(fn.indexOf("'win'") !== -1 && fn.indexOf("'win'") < fn.indexOf("startsWith('Web/')"),
    'the Windows short-circuit must come BEFORE the android_version test');
  const real = eval(`(${fn.replace('function isAndroidDevice', 'function')})`);   // eslint-disable-line no-eval
  assert.equal(real({ client_type: 'win', android_version: 'Windows 11' }), false, 'client_type alone');
  assert.equal(real({ platform: 'Windows/11 Pro 25H2 (OptiPlex 7010)', android_version: '12' }), false, 'platform alone');
  assert.equal(real({ client_type: 'apk', android_version: '13' }), true, 'Android unchanged');
  // The kiosk-browser install on Windows is a browser, and stays one.
  assert.equal(real({ client_type: 'player', platform: 'Win32', android_version: 'Web/Chrome' }), false);
});

test('the shipped isWindowsDevice / terminalPresets agree with the harness stubs', () => {
  const grab = (name) => {
    const i = SRC.indexOf(`function ${name}(device) {`);
    assert.ok(i > 0, `${name} missing from device-detail.js`);
    let depth = 0;
    for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}' && --depth === 0) return SRC.slice(i, k + 1);
    }
    return null;
  };
  const ctx = { WINDOWS_TERMINAL_PRESETS: ['W'], LINUX_TERMINAL_PRESETS: ['L'], MAC_TERMINAL_PRESETS: ['M'], TERMINAL_PRESETS: ['A'] };
  vm.runInNewContext([grab('isLinuxDevice'), grab('isWindowsDevice'), grab('isMacDevice'), grab('isNativeDevice'), grab('terminalPresets')].join('\n')
    + '\nthis.w = isWindowsDevice; this.m = isMacDevice; this.n = isNativeDevice; this.p = terminalPresets;', ctx);
  // The native macOS player: client_type 'mac' or platform 'macOS/…'; Safari on a Mac is a browser.
  assert.equal(ctx.m({ client_type: 'mac' }), true);
  assert.equal(ctx.m({ platform: 'macOS/15.1 (Mac mini)' }), true);
  assert.equal(ctx.m({ client_type: 'player', platform: 'Safari 18' }), false);
  assert.equal(ctx.n({ client_type: 'mac' }), true);
  assert.deepEqual(ctx.p({ client_type: 'mac' }), ['M']);
  assert.equal(ctx.w({ client_type: 'win' }), true);
  assert.equal(ctx.w({ platform: 'windows/10 Enterprise LTSC (NUC)' }), true);
  assert.equal(ctx.w({ client_type: 'player', platform: 'Win32' }), false, 'navigator.platform is not our prefix');
  assert.equal(ctx.w({ client_type: 'pi' }), false);
  assert.equal(ctx.n({ client_type: 'pi' }), true);
  assert.equal(ctx.n({ client_type: 'apk' }), false);
  assert.deepEqual(ctx.p(WIN), ['W']);
  assert.deepEqual(ctx.p(PI), ['L']);
  assert.deepEqual(ctx.p(ANDROID_FULL), ['A']);
  // And the real Windows presets are PowerShell, including the helper-service check.
  const presets = SRC.slice(SRC.indexOf('const WINDOWS_TERMINAL_PRESETS'), SRC.indexOf('];', SRC.indexOf('const WINDOWS_TERMINAL_PRESETS')));
  for (const cmd of ['Get-ComputerInfo', 'Get-PSDrive C', 'Get-Service ScreenTinkerHelper', 'Get-WinEvent']) assert.ok(presets.includes(cmd), cmd);
});

/*
 * Head office (corporate) playlists, spec §7.9: on a screen head office drives, the playlist tab is
 * head office's section — NOT the store's playlist picker, layout selector or draft banner. The
 * draft banner there would be head office's draft, offering a store a Publish the server refuses.
 * MUTATION CHECK (verified once): make the template's `playlist_source === 'corporate'` branch
 * `false` -> this test goes red.
 */
test('a screen head office drives gets the head office section instead of the picker, layout and draft banner', () => {
  const corp = render({ ...ANDROID_FULL, playlist_source: 'corporate', playlist_status: 'draft', playlist_id: 'P', corporate: { playlist_name: 'Brand' } }, {});
  assert.ok(corp.includes('<!--corporate-playlist-tab-->'), 'the corporate section was not chosen');
  for (const id of ['playlistPicker', 'deviceLayoutSelect', 'applyLayoutBtn', 'devicePublishBtn', 'copyPlaylistBtn', 'addContentBtn']) {
    assert.ok(!corp.includes(`id="${id}"`), `${id} must not render on a mandated screen`);
  }
  const plain = render({ ...ANDROID_FULL, playlist_source: 'group', playlist_status: 'draft', playlist_id: 'P' }, {});
  assert.ok(!plain.includes('<!--corporate-playlist-tab-->'), 'an ordinary screen must not get the corporate section');
  for (const id of ['playlistPicker', 'deviceLayoutSelect', 'devicePublishBtn', 'addContentBtn']) assert.ok(plain.includes(`id="${id}"`), `${id} vanished from an ordinary screen`);
});
