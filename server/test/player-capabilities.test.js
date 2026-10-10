'use strict';

// The dashboard offered every control to every display. A browser tab cannot reboot its host, a
// Tizen TV has no device-owner concept, a BrightSign has no per-window brightness — so those
// buttons did nothing, silently. "UI that reports success and changes nothing" is a recurring bug
// shape here, and hiding an unsupported control is the fix.
//
// The risk in doing that is the opposite failure: stripping controls from the several hundred
// displays already in the field, none of which declare anything. So an ABSENT declaration falls
// back to a per-platform baseline, while an EMPTY one is honoured as a player genuinely saying it
// can do nothing. Those two cases are easy to conflate and the difference is a dark dashboard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../lib/player-capabilities');

test('a legacy display with NO declaration keeps its platform baseline', () => {
  // The several-hundred-device case: they will not update before the next dashboard deploy.
  const android = { client_type: 'apk', android_version: '12' };
  assert.ok(caps.supports(android, 'system.restart_player'));
  assert.ok(caps.supports(android, 'playback.video'));
  assert.ok(caps.supports(android, 'offline.cache'));
});

test('THE DISTINCTION: an EMPTY declaration is honoured, not treated as missing', () => {
  // A player saying "I can do nothing" is a real answer — a widget with no host bridge, say — and
  // must not be quietly upgraded to the baseline.
  const d = { client_type: 'apk', capabilities: '[]' };
  assert.deepEqual(caps.capabilitiesFor(d), []);
  assert.equal(caps.supports(d, 'playback.video'), false);
});

test('a declaration overrides the baseline in BOTH directions', () => {
  // Android gains real screenshots only when accessibility is on, and loses Tier-2 commands when
  // it is not device owner. A static table could never know either.
  const restricted = { client_type: 'apk', capabilities: JSON.stringify(['playback.video']) };
  assert.equal(caps.supports(restricted, 'system.reboot'), false, 'declared set is authoritative');

  const enhanced = { platform: 'Chrome 120', capabilities: JSON.stringify(['playback.video', 'system.reboot']) };
  assert.ok(caps.supports(enhanced, 'system.reboot'), 'a web player behind a host CAN reboot');
});

test('a browser tab does not claim what it cannot do', () => {
  const web = { platform: 'Chrome 150', android_version: 'Web/Chrome' };
  assert.equal(caps.supports(web, 'system.reboot'), false);
  assert.equal(caps.supports(web, 'system.kiosk'), false);
  assert.equal(caps.supports(web, 'display.power'), false);
  assert.ok(caps.supports(web, 'playback.video'));
});

test('platform families are recognised from the same fields the rest of the product uses', () => {
  assert.equal(caps.platformFamily({ platform: 'brightsign' }), 'brightsign');
  assert.equal(caps.platformFamily({ platform: 'Tizen 6.0' }), 'tizen');
  assert.equal(caps.platformFamily({ client_type: 'apk' }), 'android');
  assert.equal(caps.platformFamily({ android_version: 'Android 12' }), 'android');
  assert.equal(caps.platformFamily({ android_version: 'Web/Safari' }), 'web');
  assert.equal(caps.platformFamily({}), 'web', 'unknown falls back to the most limited set');
});

test('an unknown capability from a NEWER player does not discard the ones we understand', () => {
  const d = { client_type: 'apk', capabilities: JSON.stringify(['playback.video', 'quantum.teleport']) };
  assert.deepEqual(caps.capabilitiesFor(d), ['playback.video']);
});

test('asking about a capability that does not exist is false, never a throw', () => {
  assert.equal(caps.supports({ client_type: 'apk' }, 'nonsense.capability'), false);
  assert.equal(caps.supports(null, 'playback.video'), false);
});

test('malformed declarations fall back rather than blanking the UI', () => {
  for (const bad of ['not json', '{"a":1}', '   ', 42]) {
    const d = { client_type: 'apk', capabilities: bad };
    assert.ok(caps.supports(d, 'playback.video'), `${JSON.stringify(bad)} must fall back to baseline`);
  }
});

test('every baseline entry is a real capability name', () => {
  // A typo here silently disables a control for a whole platform.
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    for (const c of list) assert.ok(caps.CAP_SET.has(c), `${family} baseline has unknown capability ${c}`);
  }
});

test('an UNDECLARED BrightSign is a browser tab, because the host bridge is unreleased', () => {
  /*
   * This test used to assert the opposite — that a BrightSign claims display power and reboot —
   * and it was wrong in the way that matters: the page reaches all of them only behind
   * BS.hasHost(), which needs an roHtmlWidget the on-device BrightScript created with node
   * integration. No released package shipped that, the one real XT245 we have runs BSN
   * Supervisor's widget where hasHost() is false, and any unit that DOES have a bridge declares
   * for itself and never reads this baseline.
   */
  const bs = { platform: 'brightsign' };
  assert.equal(caps.supports(bs, 'system.reboot'), false, 'RebootSystem() needs a host that is not there');
  assert.equal(caps.supports(bs, 'display.power'), false, 'CEC needs the same host');
  assert.equal(caps.supports(bs, 'system.restart_player'), false,
    'a page-initiated reload does not reliably bring an roHtmlWidget back — this one darkened a panel');
  assert.ok(caps.supports(bs, 'playback.video'), 'it is still a player');

  // A BrightSign that DOES declare gets everything its bridge really provides.
  const withHost = { platform: 'brightsign', capabilities: JSON.stringify(['system.reboot', 'display.power']) };
  assert.ok(caps.supports(withHost, 'system.reboot'));

  // Tizen has a real blanking path on every build (showScreenOff/clearScreenOff, no signing
  // needed) but no reboot without a partner-signed B2B surface it cannot assume.
  const tizen = { platform: 'Tizen 6.5' };
  assert.ok(caps.supports(tizen, 'display.power'), 'both halves work on a fielded .wgt');
  assert.equal(caps.supports(tizen, 'system.reboot'), false);
});

test('Tizen does NOT claim offline caching — it caches the playlist, not the media', () => {
  // st_payload_cache holds the playlist JSON in localStorage; there is no service worker and no
  // media cache, so an outage leaves the panel with a playlist it cannot play. The first version
  // of this baseline claimed offline.cache, which is precisely the lie the model exists to stop.
  assert.equal(caps.supports({ platform: 'Tizen 6.5' }, 'offline.cache'), false);
  assert.ok(caps.supports({ client_type: 'apk' }, 'offline.cache'), 'Android really does cache media');
});

test('the baseline describes a FIELDED player, not the one we are about to ship', () => {
  // Tizen's shipped build has no set_volume handler — the command falls through to "unknown
  // command" — so a legacy panel must not claim audio.volume even though updated panels will
  // declare it themselves. It DOES implement capture and streaming, so those must be claimed or
  // working controls disappear from every legacy Tizen display.
  const tizen = { platform: 'Tizen 6.5' };
  assert.equal(caps.supports(tizen, 'audio.volume'), false, 'the slider is dead on a fielded panel');
  // Web and BrightSign used to answer false here too, on the grounds that those players read
  // payload.value while the dashboard sends payload.level. 1.9.31 fixed the payload AND, more to
  // the point, those two players are SERVED BY THIS SERVER — an undeclared browser panel runs
  // whatever build is answering it, so there is no fielded-vs-shipping gap to describe. Tizen keeps
  // the old answer precisely because it does have one: its .wgt sits on the panel until someone
  // updates it, and the fix reaching this repo put nothing on any screen.
  assert.ok(caps.supports({ android_version: 'Web/Chrome' }, 'audio.volume'), 'the web player this build serves reads payload.level');
  assert.ok(caps.supports({ platform: 'brightsign' }, 'audio.volume'), 'BrightSign runs that same served player');
  assert.ok(caps.supports({ client_type: 'apk' }, 'audio.volume'), 'Android reads the payload it is sent');
  assert.ok(caps.supports(tizen, 'audio.mute'), 'mute does work');
  assert.ok(caps.supports(tizen, 'remote.screenshot'), 'captureAndSend exists in the shipped player');
  assert.ok(caps.supports(tizen, 'remote.stream'), 'startStreaming exists in the shipped player');
});

test('embedded display capabilities adapt to power source', () => {
  const batteryDev = { client_type: 'embedded', power_source: 'battery' };
  assert.equal(caps.platformFamily(batteryDev), 'embedded');
  assert.ok(caps.supports(batteryDev, 'playback.image'));
  assert.ok(caps.supports(batteryDev, 'offline.cache'));
  assert.equal(caps.supports(batteryDev, 'playback.pip'), false);
  assert.equal(caps.supports(batteryDev, 'system.reboot'), false);
  assert.equal(caps.supports(batteryDev, 'system.self_update'), false);
  assert.equal(caps.supports(batteryDev, 'audio.volume'), false);

  const usbDev = { client_type: 'embedded', power_source: 'usb' };
  assert.ok(caps.supports(usbDev, 'playback.image'));
  assert.ok(caps.supports(usbDev, 'offline.cache'));
  assert.equal(caps.supports(usbDev, 'playback.pip'), false);
  assert.ok(caps.supports(usbDev, 'system.reboot'));
  assert.equal(caps.supports(usbDev, 'system.self_update'), false);
  assert.equal(caps.supports(usbDev, 'audio.volume'), false);

  const profileDev = { screen_profile: 'seeed-reterminal-sticky' };
  assert.equal(caps.platformFamily(profileDev), 'embedded');
  assert.equal(caps.supports(profileDev, 'playback.pip'), false);
});

