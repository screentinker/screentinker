'use strict';

// guardedRequest must not carry credentials across a cross-origin redirect. The header decision is
// a pure helper (stripSensitiveHeaders); the full redirect path is exercised by ssrf-guard.test.js,
// but the SSRF guard blocks loopback so a live cross-origin redirect is awkward to stage here. This
// pins exactly which headers are dropped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripSensitiveHeaders } = require('../lib/ssrf-guard');

test('drops authorization / cookie / proxy-authorization, case-insensitively', () => {
  const out = stripSensitiveHeaders({
    Authorization: 'Bearer secret',
    Cookie: 'session=abc',
    'Proxy-Authorization': 'x',
    'if-none-match': '"etag"',
    'user-agent': 'ScreenTinker',
  });
  assert.deepEqual(out, { 'if-none-match': '"etag"', 'user-agent': 'ScreenTinker' });
});

test('lowercase spellings are dropped too', () => {
  const out = stripSensitiveHeaders({ authorization: 'x', cookie: 'y', accept: 'application/json' });
  assert.deepEqual(out, { accept: 'application/json' });
});

test('a header set with no sensitive keys is returned intact (new object)', () => {
  const input = { accept: 'text/plain' };
  const out = stripSensitiveHeaders(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input, 'returns a copy, never mutates the caller');
});
