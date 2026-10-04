'use strict';

// #473: the JS kiosk rules (web player, Tizen, BrightSign) against the vectors every player shares.
// Android runs the same file in KioskVectorsTest and the native player in tests/test_kiosk.py.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kiosk-logic');

const ROOT = path.join(__dirname, '..', '..');
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'kiosk-vectors.json'), 'utf8'));

test('parse', () => {
  for (const v of V.parse) assert.deepEqual(K.parse(v.type, v.config), v.expect, v.name);
});

test('isAllowed', () => {
  for (const v of V.isAllowed) assert.equal(K.isAllowed(v.url, v.allowed), v.expect, v.url);
});

test('selectCookies', () => {
  for (const v of V.selectCookies) {
    const pats = v.patterns === 'BUILT_IN' ? K.CONSENT_COOKIES : v.patterns;
    assert.deepEqual(K.selectCookies(v.header, pats), v.expect, v.name);
  }
});

test('idle clock', () => {
  for (const v of V.idle) {
    const k = new K.Idle(v.idleMs, v.warnMs);
    for (const [op, t, want] of v.steps) {
      const got = op === 'touch' ? k.onTouch(t) : op === 'keepAlive' ? k.keepAlive(t) : k.tick(t);
      assert.deepEqual(got, want, `${v.name}: ${op}@${t}`);
    }
  }
});

test('isStartPage', () => {
  for (const v of V.isStartPage) assert.equal(K.isStartPage(v.url, v.start), v.expect, String(v.url));
});

test('error throttle', () => {
  for (const v of V.errorThrottle) {
    const th = new K.ErrorThrottle(v.windowMs);
    for (const [reason, url, t, want] of v.steps) assert.equal(th.shouldReport(reason, url, t), want, `${reason} ${url} @${t}`);
  }
});

test('chromeMajor', () => {
  for (const v of V.chromeMajor) assert.equal(K.chromeMajor(v.ua), v.expect);
});

test('the consent list is the same list the Android player keeps', () => {
  const kt = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/remotedisplay/player/kiosk/KioskLogic.kt'), 'utf8');
  const block = kt.slice(kt.indexOf('val BUILT_IN'), kt.indexOf(').distinct()', kt.indexOf('val BUILT_IN')));
  const names = [...new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]))];
  assert.deepEqual(names, K.CONSENT_COOKIES);
});

test('keepPatterns is empty unless keep_consent', () => {
  assert.deepEqual(K.keepPatterns(K.parse('webpage', { url: 'https://a.example', interactive: true })), []);
  const p = K.keepPatterns(K.parse('webpage', { url: 'https://a.example', interactive: true, keep_consent: true, keep_cookie_names: ['mine'] }));
  assert.ok(p.includes('CookieConsent') && p.includes('mine'));
});
