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
      if (d.client_type === 'apk') return true;
      const av = String(d.android_version || '');
      return av !== '' && !av.startsWith('Web/');
    },
    TERMINAL_PRESETS: [],
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
