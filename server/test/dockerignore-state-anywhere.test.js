'use strict';

/*
 * A .dockerignore pattern without a leading double-star slash matches at the build-context ROOT only (unlike
 * .gitignore). `*.db` alone let a local `docker build` from a working tree copy server/db/*.db (every
 * account, token and device secret) and backups into the image. Verified against a real BuildKit
 * build when this was written; pinned here so a later edit cannot quietly root-anchor them again.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, '..', '..', '.dockerignore'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('database files and their sidecars are excluded anywhere in the tree', () => {
  for (const p of ['**/*.db', '**/*.db-wal', '**/*.db-shm', '**/*.db.*', '**/*.sqlite', '**/*.sqlite3']) {
    assert.ok(lines.includes(p), p);
  }
  for (const p of ['*.db', '*.db-wal', '*.db-shm', '*.db.*']) assert.ok(!lines.includes(p), `root-only ${p} is not the rule`);
});

test('state directories and secrets are excluded', () => {
  for (const p of ['server/uploads', 'server/certs', 'server/data', 'server/backups', 'backups', '**/.env', '**/.env.*', '**/*.pem']) {
    assert.ok(lines.includes(p), p);
  }
});

test('nothing the image needs is excluded', () => {
  for (const p of ['server', 'server/db', 'server/scripts', 'frontend', 'shared', 'native', 'VERSION', 'release-notes.json', 'scripts']) {
    assert.ok(!lines.includes(p), p);
  }
});
