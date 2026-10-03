'use strict';

// Serving two APKs, and letting a display move between them.
//
// The passive opt-in shipped in 1.9.26 only stopped a sideloaded build being reverted. It did not
// let the server DISTRIBUTE a beta: there was one APK slot, and latest_version was the server's own
// VERSION, so a beta build had to be installed by hand on every display.
//
// Two things have to hold or this becomes an OTA loop rather than a feature:
//
//   1. The version advertised must match the bytes served. The check and the download resolve the
//      channel the same way and fall back to stable identically, and a beta with no declared
//      version does not activate at all.
//   2. Switching back must actually move the display. Stable is semver-OLDER than the beta it
//      replaces, so the ordinary "never downgrade" rule strands it — unticking the box would be
//      another silent no-op.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chan-'));
process.env.DATA_DIR = tmp;

const apkCache = require('../lib/apk-cache');
const breaker = require('../lib/ota-breaker');

const STABLE = path.join(tmp, 'ScreenTinker.apk');
const BETA = path.join(tmp, 'ScreenTinker-beta.apk');

function writeStable() { fs.writeFileSync(STABLE, Buffer.alloc(100, 1)); }
function writeBeta(version) {
  fs.writeFileSync(BETA, Buffer.alloc(250, 2));
  if (version === null) { try { fs.unlinkSync(BETA + '.version'); } catch (_) {} }
  else fs.writeFileSync(BETA + '.version', version + '\n');
}
function clearBeta() {
  try { fs.unlinkSync(BETA); } catch (_) {}
  try { fs.unlinkSync(BETA + '.version'); } catch (_) {}
}

const ask = (client, latest, beta, wasOnBeta = false) =>
  breaker.decide(client, latest, null, Date.now(), beta, wasOnBeta);

test('with no beta published, the beta channel simply is not available', () => {
  writeStable(); clearBeta(); apkCache.refresh();
  assert.equal(apkCache.betaAvailable(), false);
  // Ticking the box on a server with no beta build must be a no-op, not a broken display.
  assert.equal(apkCache.forChannel('beta').path, STABLE, 'must fall back to stable');
});

test('a beta APK with NO declared version does not activate', () => {
  // Failing closed: the server cannot know what version those bytes are, and advertising a
  // version that does not match what is served is how an OTA loop starts.
  writeStable(); writeBeta(null); apkCache.refresh();
  assert.equal(apkCache.betaAvailable(), false, 'an undeclared beta must be ignored entirely');
  assert.equal(apkCache.forChannel('beta').path, STABLE);
});

test('a beta APK with a junk version file is treated as absent, not trusted', () => {
  writeStable(); fs.writeFileSync(BETA, Buffer.alloc(250, 2));
  fs.writeFileSync(BETA + '.version', 'latest\n');
  apkCache.refresh();
  assert.equal(apkCache.betaAvailable(), false);
});

test('a properly declared beta activates and is served on the beta channel only', () => {
  writeStable(); writeBeta('1.9.27-rc1'); apkCache.refresh();
  assert.equal(apkCache.betaAvailable(), true);
  assert.equal(apkCache.getBeta().version, '1.9.27-rc1');
  assert.equal(apkCache.forChannel('beta').path, BETA);
  assert.equal(apkCache.forChannel('stable').path, STABLE, 'stable displays must be unaffected');
  assert.equal(apkCache.get().path, STABLE);
});

test('the two slots report their own sizes, so apk_size matches the bytes served', () => {
  writeStable(); writeBeta('1.9.27-rc1'); apkCache.refresh();
  assert.equal(apkCache.forChannel('stable').size, 100);
  assert.equal(apkCache.forChannel('beta').size, 250);
  assert.notEqual(apkCache.get().size, apkCache.getBeta().size);
});

test('an opted-in display is offered the beta build over the current stable', () => {
  // The check compares against the beta's declared version, not the server's.
  const v = ask('1.9.26', '1.9.27-rc1', false);
  assert.equal(v.update_available, true);
  assert.equal(v.reason, 'offer');
});

test('once on the beta build, an opted-in display is up to date', () => {
  assert.equal(ask('1.9.27-rc1', '1.9.27-rc1', false).reason, 'up-to-date');
});

test('THE SWITCH BACK: unticking beta moves a display off the beta build', () => {
  // Stable 1.9.26 is semver-OLDER than 1.9.27-rc1, so the plain "never downgrade" rule would
  // strand it and unticking the box would appear to do nothing. wasOnBeta is the evidence that
  // we actually served this display the beta channel.
  const v = ask('1.9.27-rc1', '1.9.26', false, true);
  assert.equal(v.update_available, true, 'the display must be offered the release build');
  assert.equal(v.reason, 'channel-return');
});

test('a display we never served beta to is NOT pulled back, even on a pre-release', () => {
  // #144 protects a tester who is ahead of the server on their own build. Publishing a beta must
  // not drag every such display backwards — that is the exact harm the opt-in exists to prevent.
  const v = ask('1.9.4-beta1', '1.9.3', false, false);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'client-newer');
});

test('a display AHEAD on a real release is still never downgraded', () => {
  // This is a rolled-back server, not a channel switch. Pushing it backwards would be wrong.
  const v = ask('1.9.27', '1.9.26', false);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'client-newer');
});

test('a still-opted-in display on a newer prerelease is NOT dragged back to stable', () => {
  // Only unticking the box should return it. While opted in it keeps its beta build, even though
  // we have served it beta before.
  const v = ask('1.9.27-rc1', '1.9.26', true, true);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'client-newer');
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

/*
 * #341 — the STABLE slot declares its version too.
 *
 * Reported from the field: a server on 2.0.7 with only an upstream-signed 2.0.0 APK mounted at
 * /data offered 2.0.7 to displays running 2.0.0. Android accepts the download as a same-version
 * reinstall, the display comes back on 2.0.0, and is offered again. Two displays, 493 downloads,
 * five days, nothing failing anywhere. Point 1 in this file's header was only ever enforced for
 * the beta slot; stable took the server's own VERSION on faith.
 */
test('stable advertises the version declared beside the APK, not the server build', () => {
  writeStable();
  try { fs.unlinkSync(STABLE + '.version'); } catch (_) {}
  apkCache.refresh();
  assert.equal(apkCache.get().version, null, 'no sidecar: the caller falls back to server VERSION, as before');

  fs.writeFileSync(STABLE + '.version', '2.0.0\n');
  apkCache.refresh();
  assert.equal(apkCache.get().version, '2.0.0', 'the served bytes describe themselves');

  // Garbage is treated as absent rather than advertised, same rule the beta slot uses.
  fs.writeFileSync(STABLE + '.version', 'not-a-version\n');
  apkCache.refresh();
  assert.equal(apkCache.get().version, null);

  fs.writeFileSync(STABLE + '.version', '2.0.0\n');
  apkCache.refresh();
  // The loop the report describes: with the declared version there is nothing to offer.
  assert.equal(ask('2.0.0', apkCache.get().version, false).update_available, false,
    'a 2.0.0 display offered a 2.0.0 APK is up to date, not a reinstall candidate');
});
