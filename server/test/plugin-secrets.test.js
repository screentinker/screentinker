'use strict';

// Secret redaction for plugin / data-source config (lib/plugins/secrets.js). Redaction is driven by
// field type (password) or an explicit secret:true, with a NAME backstop so a credential field a
// plugin author mistyped as `text` still fails closed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { secretNames, redactSecrets, mergeSecrets } = require('../lib/plugins/secrets');

test('authorization is always secret; typed password / secret:true are secret', () => {
  const names = secretNames([
    { name: 'token', type: 'password' },
    { name: 'client_secret', secret: true },
    { name: 'label', type: 'text' },
  ]);
  assert.ok(names.has('authorization'));
  assert.ok(names.has('token'));
  assert.ok(names.has('client_secret'));
  assert.ok(!names.has('label'));
});

test('backstop: a credential-looking name typed as text is still redacted', () => {
  const fields = [
    { name: 'api_key', type: 'text' },      // mistyped, must still be secret
    { name: 'access_token', type: 'text' },
    { name: 'password', type: 'text' },
    { name: 'my_bearer', type: 'text' },
    { name: 'url', type: 'url' },            // not secret
    { name: 'json_path', type: 'text' },     // not secret
  ];
  const names = secretNames(fields);
  assert.ok(names.has('api_key'), 'api_key backstopped');
  assert.ok(names.has('access_token'), 'access_token backstopped');
  assert.ok(names.has('password'), 'password backstopped');
  assert.ok(names.has('my_bearer'), 'bearer backstopped');
  assert.ok(!names.has('url'), 'url is not treated as secret');
  assert.ok(!names.has('json_path'), 'json_path is not treated as secret');

  const cfg = { api_key: 'k-123', url: 'https://x/y', json_path: 'data' };
  const red = redactSecrets(cfg, fields);
  assert.equal(red.api_key, '', 'mistyped secret is blanked on read');
  assert.equal(red.url, 'https://x/y', 'non-secret preserved');
});

test('mergeSecrets keeps a stored mistyped secret when the incoming value is blank', () => {
  const fields = [{ name: 'api_key', type: 'text' }];
  const merged = mergeSecrets({ api_key: '' }, { api_key: 'stored-key' }, fields);
  assert.equal(merged.api_key, 'stored-key');
});
