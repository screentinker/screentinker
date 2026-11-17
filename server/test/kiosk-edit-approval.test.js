'use strict';

/*
 * A kiosk page has no draft: saving it changes every screen that plays it at once. With "require
 * approval" on, an editor could change a page live in a published playlist with no reviewer, and a
 * head-office (corporate) lock on the widget that frames it did not apply to the page either.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-kiosk-appr-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-kiosk-approval';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-kappr', WS = 'ws-kappr';
const users = { owner: 'u-kappr-owner', admin: 'u-kappr-admin', alice: 'u-kappr-alice', bob: 'u-kappr-bob' };
for (const [k, uid] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(uid, `${k}@kappr.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.owner);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Kiosk WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.alice, 'workspace_editor'); mem.run(WS, users.bob, 'workspace_editor');
db.prepare('INSERT OR IGNORE INTO workspace_reviewers (workspace_id,user_id,added_by,created_at) VALUES (?,?,?,0)').run(WS, users.bob, users.admin);

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
app.use('/api/kiosk', requireAuth, resolveTenancy, require('../routes/kiosk'));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const userRow = (uid) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(uid);
async function call(method, pathname, who, body) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(userRow(users[who]), WS)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
const approval = (on) => db.prepare('UPDATE workspaces SET require_approval = ? WHERE id = ?').run(on ? 1 : 0, WS);
const cfg = (pid) => JSON.parse(db.prepare('SELECT config FROM kiosk_pages WHERE id = ?').get(pid).config);

function kioskPage({ live }) {
  const pid = crypto.randomUUID(), wid = crypto.randomUUID();
  db.prepare("INSERT INTO kiosk_pages (id,user_id,workspace_id,name,config) VALUES (?,?,?,'Lobby kiosk',?)").run(pid, users.alice, WS, JSON.stringify({ title: 'Old' }));
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES (?,?,?,'webpage','Kiosk: Lobby',?)")
    .run(wid, users.alice, WS, JSON.stringify({ url: `/api/kiosk/${pid}/render` }));
  if (live) {
    db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status,published_snapshot) VALUES (?,?,?,'Front desk','published',?)")
      .run(crypto.randomUUID(), users.alice, WS, JSON.stringify([{ widget_id: wid }]));
  }
  return pid;
}

test('approval on: an editor cannot change a live kiosk page, and nothing is saved', async () => {
  approval(true);
  const pid = kioskPage({ live: true });
  const r = await call('PUT', `/api/kiosk/${pid}`, 'alice', { config: { title: 'Unreviewed' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'review_required');
  assert.match(r.json.error, /"Front desk"/);
  assert.equal(cfg(pid).title, 'Old');
});

test('approval on: a reviewer or admin may, and a page nothing published plays stays editable', async () => {
  approval(true);
  const pid = kioskPage({ live: true });
  assert.equal((await call('PUT', `/api/kiosk/${pid}`, 'bob', { config: { title: 'Reviewer' } })).status, 200);
  assert.equal((await call('PUT', `/api/kiosk/${pid}`, 'admin', { config: { title: 'Admin' } })).status, 200);
  assert.equal(cfg(pid).title, 'Admin');
  const idle = kioskPage({ live: false });
  assert.equal((await call('PUT', `/api/kiosk/${idle}`, 'alice', { config: { title: 'Fine' } })).status, 200);
});

test('approval off: editors save as before', async () => {
  approval(false);
  const pid = kioskPage({ live: true });
  assert.equal((await call('PUT', `/api/kiosk/${pid}`, 'alice', { config: { title: 'New' } })).status, 200);
  assert.equal(cfg(pid).title, 'New');
});

test('the corporate media lock applies to the page through its widget', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'kiosk.js'), 'utf8');
  assert.match(src, /corpGuard\.assertMediaWritable\(req, 'widget', wid\)/);
  assert.match(src, /if \(pageConfig && liveEditRefused\(req, res, page\)\) return;/);
});
