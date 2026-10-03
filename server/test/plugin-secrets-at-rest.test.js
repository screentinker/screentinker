'use strict';

// Encryption of secret fields at rest (lib/plugins/secrets.js encrypt/decrypt + the one-time
// migration). Uses the real secretbox (AES-256-GCM, JWT-derived key), so this is a true round-trip.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/plugins/secrets');
const registry = require('../lib/plugins/registry');

const FIELDS = [
  { name: 'authorization', type: 'password' },
  { name: 'api_key', type: 'text' }, // backstopped as secret by name
  { name: 'url', type: 'url' },       // not secret
];

test('encryptSecrets marks secret fields and leaves the rest; decrypt is the inverse', () => {
  const cfg = { authorization: 'Bearer t0ken', api_key: 'k-1', url: 'https://x/y', interval_min: 15 };
  const enc = secrets.encryptSecrets(cfg, FIELDS);
  assert.ok(enc.authorization.startsWith(secrets.ENC_PREFIX), 'authorization encrypted');
  assert.ok(enc.api_key.startsWith(secrets.ENC_PREFIX), 'mistyped secret encrypted (backstop)');
  assert.equal(enc.url, 'https://x/y', 'non-secret untouched');
  assert.equal(enc.interval_min, 15, 'non-secret untouched');
  assert.notEqual(enc.authorization, cfg.authorization, 'ciphertext, not plaintext');

  const dec = secrets.decryptSecrets(enc, FIELDS);
  assert.equal(dec.authorization, 'Bearer t0ken');
  assert.equal(dec.api_key, 'k-1');
  assert.equal(dec.url, 'https://x/y');
});

test('empty / already-encrypted values pass through encrypt unchanged (idempotent)', () => {
  const once = secrets.encryptSecrets({ authorization: 'x', api_key: '' }, FIELDS);
  const twice = secrets.encryptSecrets(once, FIELDS);
  assert.equal(twice.authorization, once.authorization, 're-encrypt is a no-op');
  assert.ok(!('api_key' in twice) || twice.api_key === '', 'blank secret not encrypted');
});

test('legacy plaintext passes through decrypt unchanged (migration read path)', () => {
  const dec = secrets.decryptSecrets({ authorization: 'legacy-plaintext', url: 'https://x' }, FIELDS);
  assert.equal(dec.authorization, 'legacy-plaintext');
});

test('ciphertext that will not decrypt (rotated key) reads back empty, no crash', () => {
  // A marker with garbage after it cannot authenticate under any key.
  const dec = secrets.decryptSecrets({ authorization: secrets.ENC_PREFIX + 'bm90LXZhbGlk' }, FIELDS);
  assert.equal(dec.authorization, '', 'undecryptable secret becomes empty (re-enterable)');
});

test('hasPlaintextSecret detects a legacy secret but not an encrypted one', () => {
  assert.equal(secrets.hasPlaintextSecret({ authorization: 'plain' }, FIELDS), true);
  assert.equal(secrets.hasPlaintextSecret(secrets.encryptSecrets({ authorization: 'plain' }, FIELDS), FIELDS), false);
  assert.equal(secrets.hasPlaintextSecret({ url: 'https://x' }, FIELDS), false);
});

test('the one-time migration encrypts legacy rows and is idempotent', (t) => {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return t.skip('better-sqlite3 not available'); }
  const { migrateSecretsAtRest } = require('../lib/plugins/migrate-secrets');

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE data_sources (id TEXT PRIMARY KEY, type TEXT, config TEXT);
    CREATE TABLE plugin_state (id TEXT PRIMARY KEY, settings TEXT);
  `);
  // A legacy iCal source with a plaintext authorization (fieldsForDataSource('ical') -> [] so
  // authorization is caught by the always-secret name).
  db.prepare('INSERT INTO data_sources (id, type, config) VALUES (?, ?, ?)')
    .run('ds1', 'ical', JSON.stringify({ url: 'https://cal/x', authorization: 'Bearer legacy' }));
  // A plugin_state row for a registered plugin with a secret settings field.
  registry.reset();
  registry.recordPlugin({ id: 'wh', name: 'wh', settingsFields: [{ name: 'token', type: 'password' }], enabled: true, loaded: true, capabilities: ['hooks'] });
  db.prepare('INSERT INTO plugin_state (id, settings) VALUES (?, ?)')
    .run('wh', JSON.stringify({ token: 'legacy-token', label: 'x' }));

  const n = migrateSecretsAtRest(db);
  assert.equal(n, 2, 'both legacy rows migrated');

  const ds = JSON.parse(db.prepare('SELECT config FROM data_sources WHERE id = ?').get('ds1').config);
  assert.ok(ds.authorization.startsWith(secrets.ENC_PREFIX), 'data-source secret now encrypted at rest');
  assert.equal(ds.url, 'https://cal/x', 'non-secret preserved');
  assert.equal(secrets.decryptSecrets(ds, secrets.fieldsForDataSource('ical')).authorization, 'Bearer legacy');

  const ps = JSON.parse(db.prepare('SELECT settings FROM plugin_state WHERE id = ?').get('wh').settings);
  assert.ok(ps.token.startsWith(secrets.ENC_PREFIX), 'plugin setting secret now encrypted');
  assert.equal(ps.label, 'x');

  // Idempotent: a second run touches nothing.
  assert.equal(migrateSecretsAtRest(db), 0, 're-run migrates nothing');
  db.close();
  registry.reset();
});
