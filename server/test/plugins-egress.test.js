'use strict';

// Per-plugin network egress allowlist (lib/plugins/egress.js). A declared list constrains a
// plugin's fetches to named hosts; no list means unrestricted (still SSRF-guarded elsewhere).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowed, matchesPattern, makePluginFetch } = require('../lib/plugins/egress');
const { GuardedRequestError } = require('../lib/ssrf-guard');

test('exact host match', () => {
  assert.equal(matchesPattern('api.example.com', 'api.example.com'), true);
  assert.equal(matchesPattern('api.example.com', 'API.EXAMPLE.COM'), true); // case-insensitive
  assert.equal(matchesPattern('evil.com', 'api.example.com'), false);
});

test('"*." wildcard matches one-or-more leading labels but not the bare domain', () => {
  assert.equal(matchesPattern('a.example.com', '*.example.com'), true);
  assert.equal(matchesPattern('a.b.example.com', '*.example.com'), true);
  assert.equal(matchesPattern('example.com', '*.example.com'), false, 'bare domain is not covered by *.');
  assert.equal(matchesPattern('example.com.evil.com', '*.example.com'), false, 'suffix must be a label boundary');
});

test('an empty / missing allowlist means unrestricted', () => {
  assert.equal(isAllowed('https://anything.example.org/x', undefined), true);
  assert.equal(isAllowed('https://anything.example.org/x', []), true);
});

test('a declared allowlist permits listed hosts and refuses others', () => {
  const allow = ['api.weather.com', '*.example.com'];
  assert.equal(isAllowed('https://api.weather.com/v1', allow), true);
  assert.equal(isAllowed('https://eu.example.com/x', allow), true);
  assert.equal(isAllowed('https://evil.tld/x', allow), false);
  // Port and path do not matter; only the host is checked.
  assert.equal(isAllowed('https://api.weather.com:8443/v1?q=1', allow), true);
});

test('an unparseable URL is refused when a list is declared (fail closed)', () => {
  assert.equal(isAllowed('not a url', ['api.example.com']), false);
});

test('makePluginFetch rejects a disallowed host before any network call', async () => {
  const fetch = makePluginFetch(['api.example.com']);
  await assert.rejects(
    () => fetch('https://evil.tld/steal'),
    (e) => e instanceof GuardedRequestError && e.code === 'egress-not-allowed',
    'a host off the list is refused with egress-not-allowed',
  );
});
