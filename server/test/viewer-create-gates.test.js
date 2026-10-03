'use strict';

// Server code review, MEDIUM (systemic): the "read-only viewer" gate was on PUT/DELETE (via each
// router's checkXWrite) but missing on the CREATE routes, so a workspace_viewer could create
// widgets, content, fonts, custom shaders, kiosk pages, and layouts in its own workspace. A shared
// tenancy.denyReadOnly now gates them. denyReadOnly runs before body/file validation, so a
// pure-JSON request is enough to prove the gate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-viewer-create-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-viewer-create';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-vc', WS = 'ws-vc';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vc-owner','vcowner@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vc-editor','vceditor@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-vc-viewer','vcviewer@t.local','x','user')").run();
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', 'u-vc-owner');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, 'u-vc-owner');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_editor')").run(WS, 'u-vc-editor');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_viewer')").run(WS, 'u-vc-viewer');

const app = express();
app.use(express.json());
const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) };
app.set('io', io);
for (const r of ['widgets', 'content', 'fonts', 'custom-shaders', 'kiosk', 'layouts']) {
  app.use('/api/' + r, requireAuth, resolveTenancy, require('../routes/' + r));
}
const server = app.listen(0);
test.after(() => { server.close(); });

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (id) => generateToken(row(id), WS);
async function call(method, pathname, who, body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
}

const CREATES = [
  ['POST', '/api/widgets', { widget_type: 'clock', name: 'w' }],
  ['POST', '/api/content/youtube', { url: 'https://youtu.be/x' }],
  ['POST', '/api/content/remote', { url: 'https://example.com/x.jpg', name: 'r' }],
  ['POST', '/api/fonts', {}],
  ['POST', '/api/custom-shaders', { source: 'x', name: 's' }],
  ['POST', '/api/kiosk', { name: 'k' }],
  ['POST', '/api/layouts', { name: 'L' }],
];

test('a read-only member cannot create in its workspace (widgets/content/fonts/shaders/kiosk/layouts)', async () => {
  for (const [m, p, body] of CREATES) {
    assert.equal(await call(m, p, 'u-vc-viewer', body), 403, `${p} must be 403 for a viewer`);
  }
});

test('an editor is not over-blocked by the create gate', async () => {
  // Editor create is not 403 (it may be 200/201, or 400 on incidental body validation, but never the
  // read-only 403). Widgets and kiosk take a plain body and should succeed.
  assert.notEqual(await call('POST', '/api/widgets', 'u-vc-editor', { widget_type: 'clock', name: 'w' }), 403);
  assert.notEqual(await call('POST', '/api/kiosk', 'u-vc-editor', { name: 'k' }), 403);
  assert.notEqual(await call('POST', '/api/layouts', 'u-vc-editor', { name: 'L' }), 403);
});
