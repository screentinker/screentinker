'use strict';

/*
 * Apple TV. ⚠️ THE ONLY PLATFORM HERE THAT IS NOT THE WEB PLAYER IN A SHELL.
 *
 * tvOS ships no WKWebView and no browser, and an app may not carry its own engine — there is no JIT
 * entitlement, so a bundled WebKit or Chromium would interpret its JavaScript, and App Store guideline
 * 2.5.6 requires web-browsing apps to use Apple's WebKit, which tvOS does not offer. The player page
 * cannot run there at any price.
 *
 * So this baseline is where the honesty about that lives. Every absence below is an absence that no
 * amount of work on our side removes, and the test exists to stop the next person "completing" the
 * list by copying another platform's.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const caps = require('../lib/player-capabilities');

const tvos = (extra = {}) => ({ platform: 'tvOS 18.2', client_type: 'tvos', ...extra });

test('a tvOS client is recognised by platform OR client_type', () => {
  // Two signals for the reason Tizen has two: `platform` is the primary key but it lives in a column
  // a register from a client not sending it used to overwrite.
  for (const d of [
    { platform: 'tvOS 18.2', client_type: 'tvos' },
    { platform: 'tvOS 18.2', client_type: '' },
    { platform: 'Apple TV 4K', client_type: '' },
    { platform: 'appletv', client_type: '' },
    { platform: '', client_type: 'tvos' },
  ]) {
    assert.equal(caps.platformFamily(d), 'tvos', `not recognised: ${JSON.stringify(d)}`);
  }
});

test('⚠️ a tvOS client never falls through to the browser baseline', () => {
  /*
   * The check sits BEFORE the android_version test. A tvOS client sends no android_version, so without
   * that ordering it lands on 'web' — and inherits playback.widget, playback.youtube and
   * playback.bundle, none of which it can honour. The operator would get three controls with nothing
   * behind them, which is the failure this whole capability model exists to prevent.
   */
  const family = caps.platformFamily({ platform: 'tvOS 18.2', client_type: 'tvos' });
  assert.notEqual(family, 'web');
  const web = caps.capabilitiesFor({ platform: '', client_type: '' });
  const apple = caps.capabilitiesFor(tvos());
  assert.notDeepEqual(apple.slice().sort(), web.slice().sort(),
    'the tvOS baseline is identical to the browser one — the family is probably not matching');
});

test('the things that need a DOM are refused, and that is permanent', () => {
  /*
   * ⚠️ playback.widget is the interesting one. EIGHT of the nine builtin widget types are data plus
   * layout and render natively; `webpage` is arbitrary HTML and cannot. A capability that is true for
   * eight and false for one is a capability that lies, so it stays out until the dashboard can express
   * "widgets, except that one" — a control that silently does nothing on one widget type is worse than
   * a control that is absent.
   */
  for (const cap of ['playback.widget', 'playback.youtube', 'playback.bundle']) {
    assert.equal(caps.supports(tvos(), cap), false, `${cap} needs a DOM and tvOS has none`);
  }
});

test('the things tvOS has no API for are refused', () => {
  // Landscape-only OS; an app cannot power or dim the panel, reboot the box, update itself outside the
  // App Store, or enter kiosk mode without MDM supervision.
  for (const cap of ['display.rotation', 'display.power', 'display.brightness',
                     'system.reboot', 'system.self_update', 'system.kiosk', 'remote.input']) {
    assert.equal(caps.supports(tvos(), cap), false, `${cap} has no tvOS API`);
  }
});

test('the things it genuinely does are present, and HLS is declared rather than assumed', () => {
  for (const cap of ['playback.video', 'playback.image', 'playback.zones', 'playback.transitions',
                     'playback.pip', 'audio.mute', 'audio.volume', 'remote.screenshot',
                     'system.restart_player', 'sync.clock', 'offline.cache']) {
    assert.equal(caps.supports(tvos(), cap), true, `${cap} should be supported`);
  }
  /*
   * ⚠️ playback.hls is NOT baselined here, and that is correct even though AVPlayer is the best HLS
   * client of any player we ship. It is in no baseline at all by design (iptv-hls.test.js): a live
   * channel is a URL the PLAYER opens on its own LAN, so an undeclared device must be refused rather
   * than handed a stream it will render as a black screen. The app declares it instead — and a
   * declared set wins, so the capability tracks the shipped build rather than the server's opinion of
   * it.
   */
  assert.equal(caps.supports(tvos(), 'playback.hls'), false, 'undeclared must be refused');
  assert.equal(caps.supports(tvos({ capabilities: JSON.stringify([...caps.BASELINE.tvos, 'playback.hls']) }),
    'playback.hls'), true, 'a build that declares it gets it');
});

test('every capability named in the baseline is a real one', () => {
  // A typo here is a capability that can never be true, and nothing else would notice.
  for (const cap of caps.BASELINE.tvos) {
    assert.ok(caps.CAP_SET.has(cap), `BASELINE.tvos names "${cap}", which is not a known capability`);
  }
});

test('a declared set still wins over the baseline', () => {
  // The baseline is what an undeclared device gets. A shipped player that declares its own set — which
  // is how every capability actually arrives — must override it, or a future tvOS build could never
  // gain a capability without a server release.
  const declared = caps.capabilitiesFor(tvos({ capabilities: JSON.stringify(['playback.video']) }));
  assert.deepEqual(declared, ['playback.video']);
  assert.equal(caps.supports(tvos({ capabilities: '["playback.video"]' }), 'playback.image'), false);
});
