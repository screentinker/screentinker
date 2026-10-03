'use strict';

// Server code review, token-scope + stale-membership group:
//   #4 embedded router had no scope gate -> agency / billing:read tokens could read device renders.
//   #5 status import/export trusted the JWT's current_workspace_id without re-checking membership.
//   #6 schedules PUT wrote zone_id without validating it is in the schedule's workspace.
//   #7 content upload accepted a foreign folder_id.
// #4 is exercised functionally (the scariest: a narrow-grant token reading device content); the
// others are locked in with source-level regression guards so the validation cannot silently drop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-token-scope-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-token-scope';

const express = require('express');
const { db } = require('../db/database');
const { hashToken } = require('../middleware/apiToken');

const WS = 'ws-ts';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-ts','ts@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('o-ts','Org','u-ts')").run();
db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?, 'o-ts','WS')").run(WS);
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?, 'u-ts','workspace_admin')").run(WS);

// two API tokens in the same workspace: one 'read', one 'agency'
const mkToken = (scope) => {
  const secret = 'st_' + scope + '_' + Math.random().toString(36).slice(2);
  db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at) VALUES (?,?,?,?,?,?,?, strftime('%s','now'))")
    .run('tok-' + scope, hashToken(secret), secret.slice(0, 10), scope + ' token', 'u-ts', WS, scope);
  return secret;
};
const readSecret = mkToken('read');
const agencySecret = mkToken('agency');

const app = express();
app.use('/api/embedded', require('../routes/embedded'));
const server = app.listen(0);
test.after(() => { server.close(); });
const get = async (pathname, secret) => {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers: { Authorization: 'Bearer ' + secret } });
  return res.status;
};

// #4 — the scope gate on the embedded (device-content) router
test('embedded: a read-ladder token can read, an agency token cannot', async () => {
  assert.equal(await get('/api/embedded/presets', readSecret), 200, 'read token is allowed');
  assert.equal(await get('/api/embedded/presets', agencySecret), 403, 'agency token cannot read device content');
});

// #5 / #6 / #7 — regression guards that the validation is present
test('#5: status import/export re-validate the JWT workspace against membership', () => {
  const src = fs.readFileSync(require.resolve('../routes/status'), 'utf8');
  assert.match(src, /function sessionWorkspaceId/, 'a membership-validating resolver exists');
  assert.match(src, /accessContext\(userId, role, ws\)/, 'it checks access, not just the claim');
  assert.ok(!/workspaceId = session\.decoded\.current_workspace_id \|\| null;/.test(src),
    'the raw-claim assignment must be gone from both handlers');
});

test('#6: schedules PUT validates a changed zone_id against the workspace', () => {
  const src = fs.readFileSync(require.resolve('../routes/schedules'), 'utf8');
  // The check must appear in the PUT handler, after the ownershipChecks loop.
  const put = src.slice(src.indexOf("router.put('/:id'"));
  assert.match(put, /req\.body\.zone_id !== undefined && req\.body\.zone_id && req\.body\.zone_id !== schedule\.zone_id/);
  assert.match(put, /checkZoneInWorkspace\(req\.body\.zone_id, schedule\.workspace_id\)/);
});

test('#7: content upload validates folder_id against the workspace', () => {
  const src = fs.readFileSync(require.resolve('../routes/content'), 'utf8');
  const up = src.slice(src.indexOf("router.post('/', checkStorageLimit"));
  assert.match(up.slice(0, 1200), /content_folders WHERE id = \?/);
  assert.match(up.slice(0, 1200), /target\.workspace_id !== req\.workspaceId/);
});
