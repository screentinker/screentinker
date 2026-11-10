'use strict';

/*
 * AN API TOKEN CAN FETCH THE FILES OF THE WORKSPACE IT IS BOUND TO.
 *
 * GET /api/content/{id}/file is documented for scope `read`. The route is also what players and
 * <img> tags use, so it sits in front of the authenticated routers with its own gate: the file is
 * served when a playlist or widget references it, or when the requester proves workspace access.
 * That proof only understood a dashboard session. An integration that uploads a file and reads it
 * back, or mirrors a library, was refused with 403 "Content not assigned to any playlist or
 * widget" until someone put the item in a playlist; the same call with a session returned 200.
 *
 * The invariant: a live token with at least read scope reads the files (and thumbnails) of its
 * own workspace, referenced or not, and nothing else: not another workspace's files, not after it
 * is revoked, and not once its owner has left the workspace.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-tokfile-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const A = {}, B = {};

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* */ }
  return { status: res.status, buf, json };
};

async function account(o, name) {
  const reg = await call('POST', '/api/auth/register', null, { email: name + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name });
  assert.ok(reg.json && reg.json.token, JSON.stringify(reg.json));
  Object.assign(o, { jwt: reg.json.token, userId: reg.json.user.id, wsId: reg.json.current_workspace_id });
}
function file(o, bytes) {
  const id = crypto.randomUUID();
  const name = id + '.png';
  fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'content'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', 'content', name), bytes);
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec)
              VALUES (?, ?, ?, 'pic.png', ?, 'image/png', ?, 10)`).run(id, o.userId, o.wsId, name, bytes.length);
  return id;
}
async function apiToken(o, scope) {
  const r = await call('POST', '/api/tokens', o.jwt, { name: 'integration ' + scope, scope });
  assert.ok(r.status === 200 || r.status === 201, 'token created: ' + r.status + ' ' + JSON.stringify(r.json));
  return { secret: r.json.token, id: r.json.id };
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  await account(A, 'alpha');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  await account(B, 'beta');
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('a token reads a file of its own workspace that nothing references yet', async () => {
  const id = file(A, PNG);
  for (const scope of ['read', 'full']) {
    const t = await apiToken(A, scope);
    const r = await call('GET', `/api/content/${id}/file`, t.secret);
    assert.equal(r.status, 200, `${scope} token: ${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
    assert.deepEqual(r.buf, PNG, 'and gets the bytes');
  }
});

test('the session path and the anonymous path are as they were', async () => {
  const id = file(A, PNG);
  assert.equal((await call('GET', `/api/content/${id}/file`, A.jwt)).status, 200, 'a member session reads it');
  assert.equal((await call('GET', `/api/content/${id}/file`, null)).status, 403, 'nobody reads an unreferenced file anonymously');
  assert.equal((await call('GET', `/api/content/${id}/file`, 'st_' + 'x'.repeat(43))).status, 403, 'nor with a made-up token');
});

test('a token does not read another workspace\'s unreferenced file', async () => {
  const theirs = file(B, PNG);
  const t = await apiToken(A, 'full');
  assert.equal((await call('GET', `/api/content/${theirs}/file`, t.secret)).status, 403);
});

test('a revoked token reads nothing', async () => {
  const id = file(A, PNG);
  const t = await apiToken(A, 'read');
  assert.equal((await call('GET', `/api/content/${id}/file`, t.secret)).status, 200);
  db.prepare("UPDATE api_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(t.id);
  assert.equal((await call('GET', `/api/content/${id}/file`, t.secret)).status, 403);
});

test('a token whose owner has left the workspace reads nothing', async () => {
  // A second member of A's workspace mints a token, then is removed.
  const C = {}; await account(C, 'gamma');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(A.wsId, C.userId);
  const id = file(A, PNG);
  const tid = crypto.randomUUID(); const secret = 'st_' + crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at)
              VALUES (?, ?, ?, 'c', ?, ?, 'read', strftime('%s','now'))`)
    .run(tid, crypto.createHash('sha256').update(secret).digest('hex'), secret.slice(0, 11), C.userId, A.wsId);
  assert.equal((await call('GET', `/api/content/${id}/file`, secret)).status, 200, 'while a member');
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(A.wsId, C.userId);
  assert.equal((await call('GET', `/api/content/${id}/file`, secret)).status, 403, 'after leaving');
});
