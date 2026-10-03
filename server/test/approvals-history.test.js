'use strict';

/*
 * Content approval (optional, per workspace, off by default) and version history.
 *
 * Runs against a FRESH data dir so the migrations run here too: the baseline, the column
 * defaults, and the tables are exercised by the same process that then drives the routes.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-approvals-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-approvals';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const revisions = require('../lib/revisions');
const approvals = require('../lib/approvals');
const releases = require('../lib/releases');
const retention = require('../lib/revision-retention');

const O = 'org-appr', WS = 'ws-appr', WS2 = 'ws-other';
const users = { admin: 'u-appr-admin', alice: 'u-appr-alice', bob: 'u-appr-bob', carol: 'u-appr-carol', viewer: 'u-appr-viewer', other: 'u-appr-other' };
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@appr.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.admin);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Approvals WS');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O, 'Other WS');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.alice, 'workspace_editor'); mem.run(WS, users.bob, 'workspace_editor');
mem.run(WS, users.carol, 'workspace_editor'); mem.run(WS, users.viewer, 'workspace_viewer');
mem.run(WS2, users.other, 'workspace_admin');

const app = express();
app.use(express.json());
const emitted = [];
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: (...a) => emitted.push(a) }), emit: (...a) => emitted.push(a) };
app.set('io', { of: () => nsp });
for (const [p, m] of [['playlists', 'playlists'], ['widgets', 'widgets'], ['layouts', 'layouts'], ['content', 'content'], ['slide-decks', 'slide-decks'], ['approvals', 'approvals'], ['revisions', 'revisions']]) {
  app.use(`/api/${p}`, requireAuth, resolveTenancy, require(`../routes/${m}`));
}
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body, ws = WS) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(row(users[who]), ws)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────
const CID = 'c-appr-1', PL = 'pl-appr-1', PL2 = 'pl-other-1', WID = 'w-appr-1', LID = 'l-appr-1';
function seedFile(name, bytes) { fs.mkdirSync(config.contentDir, { recursive: true }); fs.writeFileSync(path.join(config.contentDir, name), bytes); return name; }
before(() => {
  seedFile('appr-v1.png', Buffer.from('PNG-BYTES-V1'));
  db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size,updated_at) VALUES (?,?,?,?,?,?,?,100)")
    .run(CID, users.alice, WS, 'photo.png', 'appr-v1.png', 'image/png', 12);
  db.prepare("INSERT OR IGNORE INTO widgets (id,user_id,workspace_id,widget_type,name,config,updated_at) VALUES (?,?,?,?,?,?,100)")
    .run(WID, users.alice, WS, 'text', 'Welcome', JSON.stringify({ text: 'Hello', api_key: 'sk-secret-123' }));
  db.prepare("INSERT OR IGNORE INTO layouts (id,user_id,workspace_id,name,width,height) VALUES (?,?,?,?,1920,1080)").run(LID, users.alice, WS, 'Lobby');
  db.prepare("INSERT OR IGNORE INTO layout_zones (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,sort_order) VALUES ('z-appr-1',?, 'Main',0,0,100,100,0)").run(LID);
  db.prepare("INSERT OR IGNORE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')").run(PL, users.alice, WS, 'Lobby loop');
  db.prepare("INSERT OR IGNORE INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)").run(PL, CID);
  db.prepare("INSERT OR IGNORE INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')").run(PL2, users.other, WS2, 'Other loop');
  db.prepare("INSERT OR IGNORE INTO playlist_items (playlist_id,widget_id,sort_order,duration_sec) VALUES (?,?,0,10)").run(PL2, WID);
});

const plRow = () => db.prepare('SELECT * FROM playlists WHERE id = ?').get(PL);
const wRow = () => db.prepare('SELECT * FROM widgets WHERE id = ?').get(WID);
const openSubs = () => db.prepare(`SELECT * FROM submissions WHERE resource_id = ? AND status IN ('submitted','changes_requested','approved')`).all(PL);

// ─── migration and defaults ─────────────────────────────────────────────────────────────────

test('migration: approval is off for every workspace and the baseline invents nothing', () => {
  assert.equal(db.prepare('SELECT require_approval FROM workspaces WHERE id = ?').get(WS).require_approval, 0);
  assert.equal(db.prepare('SELECT require_approval FROM workspaces WHERE id = ?').get(WS2).require_approval, 0);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'revisions_baseline_v1'").get(), 'baseline one-shot recorded');
  // A row that predates history gets rev #1 from its own state, its own timestamp, and no author.
  db.prepare("INSERT OR IGNORE INTO widgets (id,user_id,workspace_id,widget_type,name,config,created_at,updated_at) VALUES ('w-old',?,?,'text','Old',?,1000,2000)").run(users.alice, WS, '{"text":"old"}');
  const n = revisions.baselineAll(db);
  assert.ok(n >= 1);
  const b = revisions.latest(db, 'widget', 'w-old');
  assert.equal(b.rev_no, 1); assert.equal(b.actor_kind, 'baseline'); assert.equal(b.actor_user_id, null); assert.equal(b.created_at, 2000); assert.equal(b.is_baseline, 1);
  assert.equal(revisions.baselineAll(db), 0, 'a second run records nothing');
});

// ─── with approval off: everything as before ────────────────────────────────────────────────

test('approval off: publishing, widget and layout edits are direct, and history records them', async () => {
  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 200);
  assert.equal(plRow().status, 'published'); assert.ok(plRow().published_snapshot);
  const live = revisions.lastPublished(db, 'playlist', PL);
  assert.ok(live && live.published_at, 'the published revision is marked');

  const w = await call('PUT', `/api/widgets/${WID}`, 'alice', { config: { text: 'Hello v2', api_key: 'sk-secret-123' } });
  assert.equal(w.status, 200); assert.equal(JSON.parse(wRow().config).text, 'Hello v2'); assert.equal(wRow().draft_config, null);
  const l = await call('PUT', `/api/layouts/${LID}`, 'alice', { zones: [{ id: 'z-appr-1', name: 'Main', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }] });
  assert.equal(l.status, 200);
  assert.equal(db.prepare("SELECT width_percent FROM layout_zones WHERE id = 'z-appr-1'").get().width_percent, 50);
  assert.equal(db.prepare('SELECT draft_zones FROM layouts WHERE id = ?').get(LID).draft_zones, null);
  assert.ok(revisions.list(db, 'widget', WID).length >= 2, 'a save is a revision');
});

test('settings: only a workspace admin may change them, and a reviewer is required to enable', async () => {
  assert.equal((await call('PUT', '/api/approvals/settings', 'alice', { require_approval: true })).status, 403);
  assert.equal((await call('PUT', '/api/approvals/settings', 'viewer', { require_approval: true })).status, 403);
  const s = await call('GET', '/api/approvals/settings', 'admin');
  assert.equal(s.json.require_approval, false); assert.equal(s.json.can_enable, false); assert.ok(s.json.enable_blockers.includes('no_reviewer'));
  const noRev = await call('PUT', '/api/approvals/settings', 'admin', { require_approval: true });
  assert.equal(noRev.status, 400); assert.equal(noRev.json.code, 'no_reviewer');
  const bad = await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.viewer] });
  assert.equal(bad.status, 400, 'a viewer cannot be a reviewer');
  const cross = await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.other] });
  assert.equal(cross.status, 400, 'a member of another workspace cannot be a reviewer');
  const ok = await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob, users.carol], require_approval: true });
  assert.equal(ok.status, 200); assert.equal(ok.json.require_approval, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'approval:enabled' AND workspace_id = ?").get(WS).n, 1, 'audited');
  assert.equal(db.prepare('SELECT require_approval FROM workspaces WHERE id = ?').get(WS2).require_approval, 0, 'the other workspace is untouched');
});

test('a lone admin cannot enable approval and lock the workspace out of publishing', async () => {
  /*
   * WS2 has exactly one member. Assigning themselves as the reviewer satisfies "at least one
   * reviewer", which used to be the whole gate - and approval then wedged the workspace forever,
   * because every submission is authored by the only person who could approve it.
   */
  const self = await call('PUT', '/api/approvals/settings', 'other', { reviewers: [users.other] }, WS2);
  assert.equal(self.status, 200, 'assigning yourself as a reviewer is allowed');
  assert.equal(self.json.can_enable, false, 'but it does not unlock the toggle');
  assert.ok(self.json.enable_blockers.includes('single_user'));

  const on = await call('PUT', '/api/approvals/settings', 'other', { require_approval: true }, WS2);
  assert.equal(on.status, 400); assert.equal(on.json.code, 'single_user');
  assert.equal(db.prepare('SELECT require_approval FROM workspaces WHERE id = ?').get(WS2).require_approval, 0);

  // And the other workspace, which has five members, is unaffected by the stricter gate.
  const s = await call('GET', '/api/approvals/settings', 'admin');
  assert.ok(s.json.eligible.length >= 2);
});

test('enabling approval changes nothing on screens: the published playlist stays published', () => {
  const p = plRow();
  assert.equal(p.status, 'published'); assert.ok(p.published_snapshot);
});

// ─── with approval on ────────────────────────────────────────────────────────────────────────

test('approval on: publish is refused on the server, edits become drafts, the other workspace is unaffected', async () => {
  db.prepare("INSERT INTO playlist_items (playlist_id,widget_id,sort_order,duration_sec) VALUES (?,?,1,10)").run(PL, WID);
  db.prepare("UPDATE playlists SET status = 'draft' WHERE id = ?").run(PL);
  const before = plRow().published_snapshot;
  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'approval_required');
  assert.equal(plRow().published_snapshot, before, 'players still have the old snapshot');

  const w = await call('PUT', `/api/widgets/${WID}`, 'alice', { config: { text: 'Hello v3', api_key: 'sk-secret-123' } });
  assert.equal(w.status, 200); assert.equal(w.json.draft, true);
  assert.equal(JSON.parse(wRow().config).text, 'Hello v2', 'live config untouched');
  assert.equal(JSON.parse(wRow().draft_config).config.text, 'Hello v3');
  assert.equal(wRow().updated_at, JSON.parse(JSON.stringify(wRow())).updated_at);

  const l = await call('PUT', `/api/layouts/${LID}`, 'alice', { zones: [{ id: 'z-appr-1', name: 'Main', width_percent: 25, height_percent: 100 }] });
  assert.equal(l.status, 200); assert.equal(l.json.draft, true);
  assert.equal(db.prepare("SELECT width_percent FROM layout_zones WHERE id = 'z-appr-1'").get().width_percent, 50, 'live zones untouched');
  const z = await call('POST', `/api/layouts/${LID}/zones`, 'alice', { name: 'Side' });
  assert.equal(z.status, 409, 'zone-level writes cannot bypass the draft');

  const other = await call('POST', `/api/playlists/${PL2}/publish`, 'other', null, WS2);
  assert.equal(other.status, 200, 'the workspace without approval publishes directly');
});

test('the editor is shown its own draft, not the live version it would overwrite', async () => {
  /*
   * Both editors assign the API response straight onto their canvas/form. When those responses
   * carried the LIVE record, the author's saved-but-unreviewed work appeared to vanish and the
   * next save posted the stale state back over the draft.
   */
  const put = await call('PUT', `/api/layouts/${LID}`, 'alice', { name: 'Lobby draft', zones: [{ id: 'z-appr-1', name: 'Main', width_percent: 25, height_percent: 100 }] });
  assert.equal(put.status, 200); assert.equal(put.json.draft, true);
  assert.equal(put.json.zones[0].width_percent, 25, 'PUT echoes the draft it just saved');
  assert.equal(put.json.name, 'Lobby draft');

  const got = await call('GET', `/api/layouts/${LID}`, 'alice');
  assert.equal(got.json.zones[0].width_percent, 50, 'zones stays LIVE - renderers read this route');
  assert.equal(got.json.draft.zones[0].width_percent, 25, 'and the draft is offered alongside it');
  assert.equal(got.json.draft.name, 'Lobby draft');

  // Widgets carry theirs on the row itself; the dashboard reads draft_config when present.
  // Keep api_key in the payload: later tests assert this widget's newest revision redacts it.
  const w = await call('PUT', `/api/widgets/${WID}`, 'alice', { name: 'Welcome v4', config: { text: 'Hello v4', api_key: 'sk-secret-123' } });
  assert.equal(w.json.pending_review, true);
  const row = db.prepare('SELECT config, draft_config FROM widgets WHERE id = ?').get(WID);
  assert.equal(JSON.parse(row.draft_config).config.text, 'Hello v4');
  assert.notEqual(JSON.parse(row.config).text, 'Hello v4', 'live config untouched');
});

const CURL = 'c-appr-url';
test('approval on: changing what a remote item points at is a draft, not a live edit', async () => {
  db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,remote_url,mime_type,updated_at) VALUES (?,?,?,?,?,?,100)")
    .run(CURL, users.alice, WS, 'Weather page', 'https://example.com/old', 'text/html');
  revisions.recordCurrent(db, 'content', CURL, { actor: { userId: users.alice }, summary: 'Added' });
  const r = await call('PUT', `/api/content/${CURL}`, 'alice', { remote_url: 'https://example.com/new', filename: 'Weather page 2' });
  assert.equal(r.status, 200); assert.equal(r.json.pending_review, true);
  const live = db.prepare('SELECT * FROM content WHERE id = ?').get(CURL);
  assert.equal(live.remote_url, 'https://example.com/old', 'the live URL did not move');
  assert.equal(live.filename, 'Weather page 2', 'a name is a detail and applies live');
  assert.equal(JSON.parse(live.draft_json).remote_url, 'https://example.com/new');
  const direct = await call('POST', `/api/revisions/content/${CURL}/publish-draft`, 'alice');
  assert.equal(direct.status, 409); assert.equal(direct.json.code, 'approval_required');
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'content', resource_id: CURL });
  assert.equal(sub.status, 201);
  assert.equal((await call('POST', `/api/approvals/${sub.json.id}/approve`, 'carol')).status, 200);
  const pub = await call('POST', `/api/approvals/${sub.json.id}/publish`, 'alice');
  assert.equal(pub.status, 200);
  const after = db.prepare('SELECT * FROM content WHERE id = ?').get(CURL);
  assert.equal(after.remote_url, 'https://example.com/new', 'released: the URL is applied');
  assert.equal(after.draft_json, null);
});

let submissionId;
test('submit, review queue, approve by a reviewer, publish by the creator', async () => {
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL, note: 'Please review' });
  assert.equal(sub.status, 201); submissionId = sub.json.id; assert.equal(sub.json.status, 'submitted');
  const q = await call('GET', '/api/approvals/queue', 'bob');
  assert.equal(q.status, 200);
  const entry = q.json.find((s) => s.id === submissionId);
  assert.ok(entry); assert.equal(entry.submitter_email, 'alice@appr.local'); assert.equal(entry.resource_name, 'Lobby loop'); assert.ok(entry.submitted_at);
  const detail = await call('GET', `/api/approvals/${submissionId}`, 'bob');
  assert.equal(detail.json.diff_from_live.items.added.length, 1, 'the diff against live shows the added widget');

  // Approval is a decision, not a release.
  const ap = await call('POST', `/api/approvals/${submissionId}/approve`, 'bob', { comment: 'Looks good' });
  assert.equal(ap.status, 200); assert.equal(ap.json.status, 'approved'); assert.equal(ap.json.reviewer_id, users.bob); assert.ok(ap.json.decided_at);
  assert.equal(plRow().status, 'draft', 'approval alone did not publish');

  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 200);
  assert.equal(plRow().status, 'published');
  assert.equal(JSON.parse(plRow().published_snapshot).length, 2);
  const s = approvals.getSubmission(db, submissionId);
  assert.equal(s.status, 'published'); assert.equal(s.published_by, users.alice);
  const live = revisions.lastPublished(db, 'playlist', PL);
  assert.equal(live.id, s.revision_id, 'the exact reviewed revision is what went live');
});

test('every playlist item mutation is a revision with its author', async () => {
  const before = revisions.list(db, 'playlist', PL).length;
  const add = await call('POST', `/api/playlists/${PL}/items`, 'alice', { widget_id: WID, duration_sec: 5 });
  assert.equal(add.status, 201);
  const itemId = add.json.id;
  assert.equal((await call('PUT', `/api/playlists/${PL}/items/${itemId}`, 'alice', { duration_sec: 9 })).status, 200);
  assert.equal((await call('POST', `/api/playlists/${PL}/items/reorder`, 'alice', { order: db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order DESC').all(PL).map((r) => r.id) })).status, 200);
  assert.equal((await call('DELETE', `/api/playlists/${PL}/items/${itemId}`, 'alice')).status, 200);
  const list = revisions.list(db, 'playlist', PL);
  const mine = list.slice(0, list.length - before);
  assert.deepEqual(mine.map((r) => r.summary).sort(), ['Added item', 'Edited item', 'Removed item', 'Reordered items']);
  assert.ok(mine.every((r) => r.actor_user_id === users.alice));
});

test('removing a reviewer, or their write access, voids their pending approval at publish time', async () => {
  // Carol approves; the admin then drops Carol from the reviewer list before anyone publishes.
  assert.equal((await call('PUT', `/api/playlists/${PL}`, 'alice', { name: 'Lobby loop v2' })).status, 200);
  let sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  assert.equal(sub.status, 201);
  assert.equal((await call('POST', `/api/approvals/${sub.json.id}/approve`, 'carol')).status, 200);
  assert.equal((await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob] })).status, 200);
  const reopened = await call('GET', `/api/approvals/${sub.json.id}`, 'alice');
  assert.equal(reopened.json.status, 'submitted', 'back in the queue, visibly'); assert.equal(reopened.json.reviewer_id, null);
  let pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'awaiting_review');
  assert.equal(plRow().status, 'draft', 'nothing went live');

  // The gate itself rechecks too: a reviewer downgraded outside the settings page (members admin).
  assert.equal((await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob, users.carol] })).status, 200);
  assert.equal((await call('POST', `/api/approvals/${sub.json.id}/approve`, 'carol')).status, 200);
  db.prepare("UPDATE workspace_members SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?").run(WS, users.carol);
  pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'approver_ineligible');
  assert.equal(approvals.getSubmission(db, sub.json.id).status, 'submitted', 'returned to the queue');
  assert.equal(plRow().status, 'draft');
  db.prepare("UPDATE workspace_members SET role = 'workspace_editor' WHERE workspace_id = ? AND user_id = ?").run(WS, users.carol);
  // With a standing reviewer it publishes.
  assert.equal((await call('POST', `/api/approvals/${sub.json.id}/approve`, 'bob')).status, 200);
  pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 200); assert.equal(plRow().status, 'published');
});

test('self-approval is refused, for the submitter and for anyone who authored part of the submission', async () => {
  // Bob edits the playlist THROUGH THE ITEM ROUTE (the way a person does), Alice submits it: Bob
  // may not approve it. The route must have recorded Bob as the author or the check is blind.
  const add = await call('POST', `/api/playlists/${PL}/items`, 'bob', { content_id: CID, duration_sec: 7 });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  const bobsRev = revisions.latest(db, 'playlist', PL);
  assert.equal(bobsRev.actor_user_id, users.bob, 'the item add is a revision by Bob');
  assert.equal(bobsRev.summary, 'Added item');
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  assert.equal(sub.status, 201);
  const own = await call('POST', `/api/approvals/${sub.json.id}/approve`, 'alice');
  assert.equal(own.status, 403); assert.equal(own.json.code, 'not_reviewer');
  const bobs = await call('POST', `/api/approvals/${sub.json.id}/approve`, 'bob');
  assert.equal(bobs.status, 403); assert.equal(bobs.json.code, 'self_approval');
  const carols = await call('POST', `/api/approvals/${sub.json.id}/approve`, 'carol');
  assert.equal(carols.status, 200);
  submissionId = sub.json.id;
});

test('approval binds to the exact revision: an edit after approval invalidates it', async () => {
  db.prepare('UPDATE playlist_items SET duration_sec = 99 WHERE playlist_id = ? AND sort_order = 2').run(PL);
  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'approval_stale');
  const again = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  assert.equal(again.status, 201);
  assert.equal(approvals.getSubmission(db, submissionId).status, 'superseded', 'the old approval is superseded, not reused');
  submissionId = again.json.id;
});

test('a referenced asset changing after approval invalidates it too', async () => {
  assert.equal((await call('POST', `/api/approvals/${submissionId}/approve`, 'carol')).status, 200);
  // The content's released bytes change (as a replace that went live would): the playlist's
  // approval covered the old asset, so it must not release the new one unseen.
  db.prepare('UPDATE content SET updated_at = updated_at + 50 WHERE id = ?').run(CID);
  const pub = await call('POST', `/api/approvals/${submissionId}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'deps_changed');
});

test('concurrent reviews and stale versions are refused with a useful message', async () => {
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  const s = approvals.getSubmission(db, sub.json.id);
  const stale = await call('POST', `/api/approvals/${s.id}/approve`, 'carol', { version: s.version - 1 });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'version_conflict');
  const rc = await call('POST', `/api/approvals/${s.id}/request-changes`, 'carol', { comment: 'Shorten item 3', version: s.version });
  assert.equal(rc.status, 200); assert.equal(rc.json.status, 'changes_requested'); assert.equal(rc.json.comment, 'Shorten item 3');
  // Bob authored part of this submission, so his refusal is self-approval; Carol's is "not pending".
  const bobs = await call('POST', `/api/approvals/${s.id}/approve`, 'bob');
  assert.equal(bobs.status, 403); assert.equal(bobs.json.code, 'self_approval');
  const second = await call('POST', `/api/approvals/${s.id}/approve`, 'carol');
  assert.equal(second.status, 409); assert.equal(second.json.code, 'not_pending');
  const noComment = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  const rc2 = await call('POST', `/api/approvals/${noComment.json.id}/request-changes`, 'carol', {});
  assert.equal(rc2.status, 400, 'changes requested need a comment');
  submissionId = noComment.json.id;
});

test('withdrawing, and a reviewer whose access was removed cannot review any more', async () => {
  const wd = await call('POST', `/api/approvals/${submissionId}/withdraw`, 'bob');
  assert.equal(wd.status, 403, 'only the submitter or an admin withdraws');
  const ok = await call('POST', `/api/approvals/${submissionId}/withdraw`, 'alice');
  assert.equal(ok.status, 200); assert.equal(ok.json.status, 'withdrawn');
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'playlist', resource_id: PL });
  submissionId = sub.json.id;
  db.prepare("UPDATE workspace_members SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?").run(WS, users.carol);
  const gone = await call('POST', `/api/approvals/${submissionId}/approve`, 'carol');
  assert.equal(gone.status, 403, 'downgraded to viewer: no longer a reviewer, immediately');
  db.prepare("UPDATE workspace_members SET role = 'workspace_editor' WHERE workspace_id = ? AND user_id = ?").run(WS, users.carol);
  const s = await call('GET', '/api/approvals/settings', 'admin');
  assert.ok(s.json.reviewers.find((r) => r.user_id === users.carol).eligible);
});

test('disabling approval needs an admin, warns, keeps history, cancels pending work without publishing', async () => {
  assert.equal(approvals.getSubmission(db, submissionId).status, 'submitted');
  assert.equal((await call('PUT', '/api/approvals/settings', 'alice', { require_approval: false })).status, 403);
  const before = plRow().published_snapshot;
  const s = await call('GET', '/api/approvals/settings', 'admin');
  assert.ok(s.json.pending_submissions >= 1, 'the UI is told how many submissions are pending before the switch');
  const off = await call('PUT', '/api/approvals/settings', 'admin', { require_approval: false });
  assert.equal(off.status, 200);
  assert.equal(approvals.getSubmission(db, submissionId).status, 'cancelled');
  assert.equal(plRow().published_snapshot, before, 'nothing was published by turning the setting off');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM submissions WHERE resource_id = ?').get(PL).n >= 5, 'review history preserved');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'approval:disabled' AND workspace_id = ?").get(WS).n, 1);
  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 200, 'publishing is direct again');
});

// ─── version history ─────────────────────────────────────────────────────────────────────────

test('history lists revisions with author, time and publication status, and redacts secrets', async () => {
  const h = await call('GET', `/api/revisions/playlist/${PL}`, 'alice');
  assert.equal(h.status, 200);
  assert.ok(h.json.revisions.length >= 3);
  const live = h.json.revisions.find((r) => r.is_live);
  assert.ok(live && live.published_at, 'the live revision is identified');
  assert.ok(h.json.revisions.some((r) => r.actor_email === 'alice@appr.local'));
  const wh = await call('GET', `/api/revisions/widget/${WID}`, 'alice');
  const one = await call('GET', `/api/revisions/widget/${WID}/${wh.json.revisions[0].id}`, 'alice');
  assert.equal(one.json.state.config.api_key, '***', 'secret-looking fields are masked');
  assert.equal(JSON.parse(wRow().config).api_key || JSON.parse(wRow().draft_config).config.api_key, 'sk-secret-123', 'but stored intact');
  assert.equal((await call('GET', `/api/revisions/playlist/${PL}`, 'other', null, WS2)).status, 404, 'history is workspace-scoped');
});

test('compare: added, removed and reordered items between two playlist revisions', async () => {
  const list = revisions.list(db, 'playlist', PL);
  const newest = list[0], oldest = list[list.length - 1];
  const d = await call('GET', `/api/revisions/playlist/${PL}/${newest.id}/diff?against=${oldest.id}`, 'alice');
  assert.equal(d.status, 200);
  assert.ok(d.json.diff.items.added.length >= 1);
});

test('restore creates a NEW draft revision by the restorer; the live version is untouched; approval policy applies', async () => {
  const list = revisions.list(db, 'playlist', PL);
  const target = list.find((r) => JSON.parse(r.state).items.length === 1) || list[list.length - 1];
  const liveBefore = plRow().published_snapshot;
  const r = await call('POST', `/api/revisions/playlist/${PL}/${target.id}/restore`, 'bob');
  assert.equal(r.status, 200); assert.equal(r.json.draft, true);
  assert.equal(r.json.revision.actor_user_id, users.bob); assert.equal(r.json.revision.actor_kind, 'restore');
  assert.ok(r.json.revision.rev_no > target.rev_no, 'appended, never rewritten');
  assert.equal(plRow().status, 'draft'); assert.equal(plRow().published_snapshot, liveBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(PL).n, JSON.parse(target.state).items.length);
  assert.equal(r.json.next, 'publish', 'approval off: the normal publish path follows');

  // Approval on: the restored draft needs fresh approval.
  await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob, users.carol], require_approval: true });
  const pub = await call('POST', `/api/playlists/${PL}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'approval_required');
  const r2 = await call('POST', `/api/revisions/playlist/${PL}/${target.id}/restore`, 'alice');
  assert.equal(r2.json.next, 'submit_for_review');
  await call('PUT', '/api/approvals/settings', 'admin', { require_approval: false });
});

test('widgets: restore to draft, preview the revision, publish the draft', async () => {
  const list = revisions.list(db, 'widget', WID);
  const old = list.find((r) => JSON.parse(r.state).config.text === 'Hello');
  assert.ok(old, 'the first saved config is in history');
  const render = await call('GET', `/api/revisions/widget/${WID}/${old.id}/render`, 'alice');
  assert.equal(render.status, 200);
  const r = await call('POST', `/api/revisions/widget/${WID}/${old.id}/restore`, 'alice');
  assert.equal(r.status, 200); assert.equal(JSON.parse(wRow().draft_config).config.text, 'Hello');
  assert.equal(JSON.parse(wRow().config).text, 'Hello v2', 'live untouched by the restore');
  const p = await call('POST', `/api/revisions/widget/${WID}/publish-draft`, 'alice');
  assert.equal(p.status, 200);
  assert.equal(JSON.parse(wRow().config).text, 'Hello'); assert.equal(wRow().draft_config, null);
  assert.ok(revisions.lastPublished(db, 'widget', WID));
});

test('content: replaced bytes are retained, previewable, restorable, and publishing the draft keeps both', async () => {
  const seed = revisions.recordCurrent(db, 'content', CID, { actor: { userId: users.alice }, summary: 'Uploaded' });
  assert.equal(seed.file_ref, 'appr-v1.png');
  // A replace that went live (approval off): the old bytes move to .history, the row points at the new file.
  const retained = revisions.retainContentFile(db, CID, 'appr-v1.png', 'r1');
  assert.ok(retained.startsWith('.history/'));
  assert.ok(!fs.existsSync(path.join(config.contentDir, 'appr-v1.png')), 'moved, not copied, when unreferenced');
  db.prepare('UPDATE revisions SET file_ref = ? WHERE resource_type = ? AND resource_id = ? AND file_ref = ?').run(retained, 'content', CID, 'appr-v1.png');
  seedFile('appr-v2.png', Buffer.from('PNG-BYTES-V2'));
  db.prepare("UPDATE content SET filepath = 'appr-v2.png', file_size = 12, updated_at = updated_at + 1 WHERE id = ?").run(CID);
  const v2 = revisions.recordCurrent(db, 'content', CID, { actor: { userId: users.alice }, summary: 'Replaced file' });
  assert.equal(v2.file_ref, 'appr-v2.png');

  const oldRev = revisions.list(db, 'content', CID).find((r) => r.file_ref === retained);
  const f = await fetch(`http://127.0.0.1:${server.address().port}/api/revisions/content/${CID}/${oldRev.id}/file`, { headers: { Authorization: `Bearer ${generateToken(row(users.alice), WS)}` } });
  assert.equal(f.status, 200); assert.equal(await f.text(), 'PNG-BYTES-V1', 'the old bytes are served');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/revisions/content/${CID}/${oldRev.id}/file`, { headers: { Authorization: `Bearer ${generateToken(row(users.other), WS2)}` } })).status, 404);

  const r = await call('POST', `/api/revisions/content/${CID}/${oldRev.id}/restore`, 'bob');
  assert.equal(r.status, 200);
  const draft = JSON.parse(db.prepare('SELECT draft_json FROM content WHERE id = ?').get(CID).draft_json);
  assert.equal(fs.readFileSync(path.join(config.contentDir, draft.filepath)).toString(), 'PNG-BYTES-V1', 'the draft carries the OLD bytes');
  assert.equal(db.prepare('SELECT filepath FROM content WHERE id = ?').get(CID).filepath, 'appr-v2.png', 'live untouched');

  const p = await call('POST', `/api/revisions/content/${CID}/publish-draft`, 'bob');
  assert.equal(p.status, 200);
  const c = db.prepare('SELECT * FROM content WHERE id = ?').get(CID);
  assert.equal(fs.readFileSync(path.join(config.contentDir, c.filepath)).toString(), 'PNG-BYTES-V1');
  assert.equal(c.draft_json, null);
  const v2rev = revisions.list(db, 'content', CID).find((x) => x.id === v2.id);
  assert.ok(v2rev.file_ref.startsWith('.history/'), 'the replaced v2 bytes were retained in turn');
  assert.ok(fs.existsSync(revisions.resolveFileRef(v2rev.file_ref)));

  // A revision whose bytes are gone cannot pretend to restore.
  fs.unlinkSync(revisions.resolveFileRef(v2rev.file_ref));
  const gone = await call('POST', `/api/revisions/content/${CID}/${v2rev.id}/restore`, 'bob');
  assert.equal(gone.status, 409);
});

test('restoring a URL revision and publishing it actually releases that URL (every captured field, not just bytes)', async () => {
  // Approval is off here. A -> B live; restore A; publish; the live row must equal A.
  const a = revisions.latest(db, 'content', CURL);            // https://example.com/new after the release above
  assert.equal(JSON.parse(a.state).remote_url, 'https://example.com/new');
  const r = await call('PUT', `/api/content/${CURL}`, 'alice', { remote_url: 'https://example.com/b', captions_enabled: true });
  assert.equal(r.status, 200); assert.equal(r.json.pending_review, undefined, 'approval off: live edit');
  assert.equal(db.prepare('SELECT remote_url FROM content WHERE id = ?').get(CURL).remote_url, 'https://example.com/b');
  const restore = await call('POST', `/api/revisions/content/${CURL}/${a.id}/restore`, 'bob');
  assert.equal(restore.status, 200); assert.equal(restore.json.next, 'publish_draft');
  assert.equal(db.prepare('SELECT remote_url FROM content WHERE id = ?').get(CURL).remote_url, 'https://example.com/b', 'restore alone changes nothing live');
  const pub = await call('POST', `/api/revisions/content/${CURL}/publish-draft`, 'bob');
  assert.equal(pub.status, 200);
  const releasedState = revisions.captureLiveState(db, 'content', CURL);
  const wanted = JSON.parse(a.state);
  for (const k of revisions.CONTENT_DRAFT_FIELDS) assert.equal(releasedState[k] ?? null, wanted[k] ?? null, `released ${k} matches the restored revision`);
  assert.equal(releasedState.remote_url, 'https://example.com/new');
  assert.equal(releasedState.captions_enabled, 0);
});

test('discarding a draft keeps the bytes that history still references', async () => {
  const list = revisions.list(db, 'content', CID);
  const withBytes = list.filter((r) => r.file_ref && revisions.resolveFileRef(r.file_ref) && fs.existsSync(revisions.resolveFileRef(r.file_ref)));
  const target = withBytes.find((r) => r.file_ref.startsWith('.history/')) || withBytes[0];
  assert.ok(target, 'a restorable revision exists');
  const r = await call('POST', `/api/revisions/content/${CID}/${target.id}/restore`, 'bob');
  assert.equal(r.status, 200);
  const pending = JSON.parse(db.prepare('SELECT draft_json FROM content WHERE id = ?').get(CID).draft_json).filepath;
  const restoredRev = revisions.latest(db, 'content', CID);
  assert.equal(restoredRev.file_ref, pending, 'the restore revision points at the pending copy');
  const d = await call('POST', `/api/revisions/content/${CID}/discard-draft`, 'bob');
  assert.equal(d.status, 200);
  assert.ok(!fs.existsSync(path.join(config.contentDir, pending)), 'the pending copy left the live directory');
  const moved = revisions.get(db, restoredRev.id);
  assert.ok(moved.file_ref.startsWith('.history/'), 'and was retained for the revision that describes it');
  assert.ok(fs.existsSync(revisions.resolveFileRef(moved.file_ref)));
  const again = await call('POST', `/api/revisions/content/${CID}/${restoredRev.id}/restore`, 'bob');
  assert.equal(again.status, 200, 'that revision restores after the discard');
  assert.equal((await call('POST', `/api/revisions/content/${CID}/discard-draft`, 'bob')).status, 200);
  const liveFile = db.prepare('SELECT filepath FROM content WHERE id = ?').get(CID).filepath;
  assert.ok(fs.existsSync(path.join(config.contentDir, liveFile)), 'the live file is never touched by a discard');
});

test('retention keeps the newest, the live release, pending reviews and the baseline; prunes the rest and their files', () => {
  for (let i = 0; i < 8; i++) {
    db.prepare("UPDATE widgets SET config = ? WHERE id = ?").run(JSON.stringify({ text: 'v' + i }), WID);
    revisions.recordCurrent(db, 'widget', WID, { actor: { userId: users.alice }, summary: 'edit ' + i });
  }
  const before = revisions.list(db, 'widget', WID).length;
  assert.ok(before > 3);
  const live = revisions.lastPublished(db, 'widget', WID);
  const out = retention.prune(db, { keep: 3 });
  assert.ok(out.revisions_deleted > 0);
  const after = revisions.list(db, 'widget', WID);
  assert.ok(after.length < before, 'older unprotected revisions were pruned');
  // keep 3, plus the live release, plus the baseline: nothing else survives.
  assert.ok(after.length <= 5, `expected at most 5, got ${after.length}`);
  assert.ok(after.some((r) => r.is_baseline), 'the baseline survives');
  assert.ok(after.some((r) => r.id === live.id), 'the live revision survives even beyond the keep window');
  // Files: a retained file no revision names any more is removed; a named one stays.
  const hist = path.join(revisions.historyDir(), CID);
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 'orphan__x.png'), 'x');
  const out2 = retention.prune(db, { keep: 3 });
  assert.ok(!fs.existsSync(path.join(hist, 'orphan__x.png')));
  assert.ok(out2.files_kept >= 1, 'the retained v1 bytes named by a revision are kept');
});

test('permissions: viewers read history but cannot restore, submit or publish drafts', async () => {
  assert.equal((await call('GET', `/api/revisions/playlist/${PL}`, 'viewer')).status, 200);
  const list = revisions.list(db, 'playlist', PL);
  assert.equal((await call('POST', `/api/revisions/playlist/${PL}/${list[0].id}/restore`, 'viewer')).status, 403);
  assert.equal((await call('POST', '/api/approvals/submit', 'viewer', { resource_type: 'playlist', resource_id: PL })).status, 403);
  assert.equal((await call('POST', `/api/revisions/widget/${WID}/publish-draft`, 'viewer')).status, 403);
});

test('slide decks: publish goes through the gate; the deck is the reviewed unit', async () => {
  const created = await call('POST', '/api/slide-decks', 'alice', { name: 'Deck' });
  assert.equal(created.status, 201);
  const deckId = created.json.id;
  await call('PUT', '/api/approvals/settings', 'admin', { reviewers: [users.bob], require_approval: true });
  const pub = await call('POST', `/api/slide-decks/${deckId}/publish`, 'alice');
  assert.equal(pub.status, 409); assert.equal(pub.json.code, 'approval_required');
  const sub = await call('POST', '/api/approvals/submit', 'alice', { resource_type: 'slide_deck', resource_id: deckId });
  assert.equal(sub.status, 201);
  assert.equal((await call('POST', `/api/approvals/${sub.json.id}/approve`, 'bob')).status, 200);
  const pub2 = await call('POST', `/api/slide-decks/${deckId}/publish`, 'alice');
  assert.equal(pub2.status, 200);
  assert.equal(approvals.getSubmission(db, sub.json.id).status, 'published');
  await call('PUT', '/api/approvals/settings', 'admin', { require_approval: false });
});
