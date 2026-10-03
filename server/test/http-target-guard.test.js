'use strict';

/*
 * The device-side http_request target guard, against its shared contract.
 *
 * shared/http-target-vectors.json is the SAME file the Kotlin port is held to. Both must agree:
 * a door stricter than its doorman is a feature that half-works, and a doorman stricter than its
 * door is a 400 nobody can explain.
 *
 * ⚠️ The property most worth protecting here is the SCHEME ALLOWLIST. Everything else in this
 * guard is defence in depth; the allowlist is the thing standing between "fetch a URL and return
 * 64KiB" and "read a file off this device and return 64KiB". On Android `content://` reads through
 * content providers, which is precisely the mechanism for exposing one app's private data.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../lib/http-target-guard');
const VECTORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'http-target-vectors.json'), 'utf8')
);

test('http-target-guard: conforms to every shared vector', () => {
  const failures = [];
  for (const v of VECTORS.vectors) {
    const got = guard.check(v.url);
    if (got.allow !== v.expect.allow) {
      failures.push(`  ${v.name}\n    ${v.url} -> allow=${got.allow}, expected ${v.expect.allow}`);
      continue;
    }
    if (!v.expect.allow && got.reason !== v.expect.reason) {
      failures.push(`  ${v.name}\n    ${v.url} -> reason=${got.reason}, expected ${v.expect.reason}`);
    }
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}\n`);
  assert.ok(VECTORS.vectors.length >= 24, 'the contract should not shrink');
});

test('http-target-guard: RFC1918 is ALLOWED — it is the entire feature', () => {
  /*
   * Named loudly because it is the opposite of what the server's own data-source fetcher does, and
   * someone tidying the two into agreement would delete the feature: the panel exists to talk to
   * the PLC on the shop network. If this ever starts refusing private addresses, the command has
   * no remaining purpose.
   */
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1']) {
    assert.equal(guard.check(`http://${host}/x`).allow, true, `${host} must be reachable from a panel`);
  }
});

test('http-target-guard: the scheme allowlist is the whole defence', () => {
  const localFileReads = [
    'file:///data/data/com.remotedisplay.player/shared_prefs/remote_display.xml',
    'content://com.android.contacts/contacts',
    'content://media/external/images/media',
    'jar:file:///x.apk!/y',
  ];
  for (const url of localFileReads) {
    const got = guard.check(url);
    assert.equal(got.allow, false, `${url} must never be fetchable`);
    assert.equal(got.reason, 'bad_scheme');
  }
  // `android_asset://` cannot even be parsed — '_' is illegal in a scheme — so it is refused as
  // malformed rather than by the allowlist. Refused is refused; the reason differs, and pinning
  // 'bad_scheme' would have been asserting something no URL parser can produce.
  assert.equal(guard.check('android_asset://x').allow, false);
  assert.deepEqual(guard.ALLOWED_SCHEMES, ['http:', 'https:'], 'adding a scheme here needs a security argument');
});

test('http-target-guard: link-local goes wholesale, not just the famous address', () => {
  // 169.254.169.254 is the one everybody knows, but the range only exists when DHCP has failed, so
  // nothing on it is a legitimate signage target and blocking it all costs nothing real.
  for (const host of ['169.254.169.254', '169.254.0.1', '169.254.255.255']) {
    assert.deepEqual(guard.check(`http://${host}/`), { allow: false, reason: 'metadata_address' });
  }
  // ...and the neighbouring ranges are NOT blocked, so the block stays narrow.
  assert.equal(guard.check('http://169.253.0.1/').allow, true);
  assert.equal(guard.check('http://169.255.0.1/').allow, true);
});

test('http-target-guard: isBlockedAddress is shared with the resolved-address re-check', () => {
  /*
   * The player resolves a hostname and re-checks each address with THIS predicate before
   * connecting. Exporting it is what stops that becoming a second list that drifts — a hostname
   * pointing at the metadata service is the obvious way round a string check.
   */
  assert.equal(guard.isBlockedAddress('169.254.169.254'), true);
  assert.equal(guard.isBlockedAddress('fe80::1'), true);
  assert.equal(guard.isBlockedAddress('fd00:ec2::254'), true);
  assert.equal(guard.isBlockedAddress('[fe80::1]'), true, 'brackets must not defeat it');
  assert.equal(guard.isBlockedAddress('192.168.1.1'), false);
  assert.equal(guard.isBlockedAddress(''), false);
  assert.equal(guard.isBlockedAddress(null), false);
});

test('http-target-guard: never throws, whatever it is handed', () => {
  for (const junk of [undefined, null, 42, {}, [], 'http://', ' ', 'http://[::', '\u0000']) {
    const got = guard.check(junk);
    assert.equal(typeof got.allow, 'boolean', `junk input ${JSON.stringify(junk)} must get a verdict`);
    if (!got.allow) assert.ok(typeof guard.explain(got.reason) === 'string');
  }
});
