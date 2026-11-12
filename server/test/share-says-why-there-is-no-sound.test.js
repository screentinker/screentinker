'use strict';

/*
 * A SHARE WITH NO SOUND SAYS WHY.
 *
 * Reported: "sometimes when casting from ChromeOS, the audio does not share" (and never from
 * Firefox). Whether a screen share carries sound is decided in the browser's own picker: a window
 * never does, a tab does unless "Also share tab audio" was switched off, the entire screen only on
 * Windows and ChromeOS, and Firefox and Safari never do. One message for all of it ("No sound is
 * being shared", Windows only) left people guessing, so the message now names the choice that was
 * made, from what the browser reports (displaySurface).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FE = path.join(__dirname, '..', '..', 'frontend');
const load = () => import(path.join(FE, 'js', 'lib', 'screen-share-client.js'));

const UA = {
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
};
const picked = (displaySurface) => ({ getVideoTracks: () => [{ getSettings: () => (displaySurface ? { displaySurface } : {}) }], getAudioTracks: () => [] });

test('the message names what was picked', async () => {
  const { noSoundKey } = await load();
  assert.equal(noSoundKey(picked('window'), UA.chromeos), 'screen_share.no_sound_window');
  assert.equal(noSoundKey(picked('browser'), UA.chromeos), 'screen_share.no_sound_tab');
  assert.equal(noSoundKey(picked('monitor'), UA.edge), 'screen_share.no_sound_screen');
  assert.equal(noSoundKey(picked(null), UA.chromeos), 'screen_share.no_sound', 'a browser that does not say: the general message');
  assert.equal(noSoundKey(null, UA.chromeos), 'screen_share.no_sound');
});

test('Firefox and Safari are told it is the browser, whatever was picked; Chromium browsers are not', async () => {
  const { noSoundKey, screenSoundPossible } = await load();
  for (const b of ['firefox', 'safari']) {
    assert.equal(screenSoundPossible(UA[b]), false, b);
    assert.equal(noSoundKey(picked('browser'), UA[b]), 'screen_share.no_sound_browser', b);
  }
  for (const b of ['chromeos', 'edge']) assert.equal(screenSoundPossible(UA[b]), true, b);
});

test('every message exists in English, and the general one names ChromeOS', () => {
  const en = fs.readFileSync(path.join(FE, 'js', 'i18n', 'en.js'), 'utf8');
  for (const k of ['no_sound', 'no_sound_tab', 'no_sound_window', 'no_sound_screen', 'no_sound_browser', 'sound_not_here']) {
    assert.match(en, new RegExp(`'screen_share\\.${k}': '`), k);
  }
  assert.match(en, /'screen_share\.no_sound': '[^\n]*ChromeOS/);
  // Both places that share a screen use the specific message.
  for (const f of ['js/share-page.js', 'js/components/screen-share.js']) {
    const src = fs.readFileSync(path.join(FE, f), 'utf8');
    assert.match(src, /t\(noSoundKey\(stream\)\)/, f);
    assert.doesNotMatch(src, /t\('screen_share\.no_sound'\)/, f);
  }
});
