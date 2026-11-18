'use strict';

/*
 * With "require approval" on, POST /api/schedules already sends a one-off item's generated playlist
 * through the review queue. PUT did not: changing the schedule's content rewrote the playlist and
 * called publishPlaylist directly, so an editor put new content on screen with no reviewer.
 * The edit now lands as the playlist's draft and waits in the queue; the screen keeps the approved copy.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-sched-appr-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-schedule-approval';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-sappr', WS = 'ws-sappr';
const users = { owner: 'u-sappr-owner', admin: 'u-sappr-admin', alice: 'u-sappr-alice', bob: 'u-sappr-bob' };
for (const [k, uid] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(uid, `${k}@sappr.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.owner);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Sched WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.alice, 'workspace_editor'); mem.run(WS, users.bob, 'workspace_editor');
const DEV = 'dev-sappr';
db.prepare("INSERT OR IGNORE INTO devices (id,user_id,workspace_id,name,status) VALUES (?,?,?,'Lobby','offline')").run(DEV, users.alice, WS);
db.prepare('INSERT OR IGNORE INTO workspace_reviewers (workspace_id,user_id,added_by,created_at) VALUES (?,?,?,0)').run(WS, users.bob, users.admin);

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
app.use('/api/schedules', requireAuth, resolveTenancy, require('../routes/schedules'));
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

const addContent = (name) => {
  const cid = crypto.randomUUID();
  db.prepare("INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,?,?,'image/png',1)")
    .run(cid, users.alice, WS, name, `${cid}.png`);
  return cid;
};
const approval = (on) => db.prepare('UPDATE workspaces SET require_approval = ? WHERE id = ?').run(on ? 1 : 0, WS);
const snap = (pl) => db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot || '';
const now = Math.floor(Date.now() / 1000);

async function newSchedule(contentId) {
  const r = await call('POST', '/api/schedules', 'alice', {
    device_id: DEV, content_id: contentId, title: 't', start_time: now + 3600, end_time: now + 7200,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

test('approval on: changing a schedule\'s content queues it, the screen keeps the approved copy', async () => {
  approval(false);
  const A = addContent('approved.png'), B = addContent('unreviewed.png');
  const s = await newSchedule(A);
  const before = snap(s.playlist_id);
  assert.match(before, new RegExp(A));
  approval(true);
  const r = await call('PUT', `/api/schedules/${s.id}`, 'alice', { content_id: B });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.approval_pending, true);
  assert.equal(snap(s.playlist_id), before, 'published copy unchanged');
  assert.doesNotMatch(snap(s.playlist_id), new RegExp(B));
  const sub = db.prepare("SELECT status FROM submissions WHERE resource_type = 'playlist' AND resource_id = ? AND status = 'submitted'").get(s.playlist_id);
  assert.ok(sub, 'the change is in the review queue');
});

test('approval off: changing a schedule\'s content still publishes straight away', async () => {
  approval(false);
  const A = addContent('a.png'), B = addContent('b.png');
  const s = await newSchedule(A);
  const r = await call('PUT', `/api/schedules/${s.id}`, 'alice', { content_id: B });
  assert.equal(r.status, 200);
  assert.equal(r.json.approval_pending, undefined);
  assert.match(snap(s.playlist_id), new RegExp(B));
});
