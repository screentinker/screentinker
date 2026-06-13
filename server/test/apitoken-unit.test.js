'use strict';

// Unit tests for apiTokenAuth branches that are awkward to assert against the subprocess
// integration server (cross-process SQLite/WAL visibility is unreliable mid-run): the
// must_change_password gate, plus a sanity check that a normal token passes with the
// platform role stripped. Uses the project's in-memory-DB injection pattern (inject
// ../db/database into the require cache BEFORE requiring the middleware).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-apitoken-unit';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
    auth_provider TEXT, avatar_url TEXT, plan_id TEXT, email_alerts INTEGER,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT, prefix TEXT, name TEXT, user_id TEXT,
    workspace_id TEXT, scope TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
  );
`);
require.cache[require.resolve('../db/database')] = { id: require.resolve('../db/database'), loaded: true, exports: { db } };
const { apiTokenAuth, hashToken } = require('../middleware/apiToken');

function seedToken({ mustChange }) {
  const uid = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, must_change_password) VALUES (?, ?, ?)').run(uid, uid + '@t.local', mustChange ? 1 : 0);
  const secret = 'st_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), hashToken(secret), secret.slice(0, 11), 'n', uid, 'ws-x', 'read');
  return secret;
}
function runAuth(secret) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer ' + secret }, query: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { resolve({ outcome: 'response', status: this.statusCode }); } };
    apiTokenAuth(req, res, () => resolve({ outcome: 'next', viaToken: req.viaToken, role: req.user && req.user.role }));
  });
}

test('apiTokenAuth: a must_change_password owner is blocked with 403', async () => {
  const r = await runAuth(seedToken({ mustChange: true }));
  assert.equal(r.outcome, 'response');
  assert.equal(r.status, 403);
});
test('apiTokenAuth: a normal owner passes (next; viaToken set; platform role stripped to user)', async () => {
  const r = await runAuth(seedToken({ mustChange: false }));
  assert.equal(r.outcome, 'next');
  assert.equal(r.viaToken, true);
  assert.equal(r.role, 'user');
});
