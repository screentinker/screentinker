'use strict';

/*
 * WHO READS WHICH ACTIVITY ROWS.
 *
 * The activity log is where a workspace's administrator asks "who changed that". The list route
 * gave everyone but the instance operator only their OWN rows, so on a hosted instance the person
 * who runs a workspace could not see what their team did in it, while the operator saw every
 * tenant's rows.
 *
 * The invariant:
 *   - a workspace administrator reads the rows of the workspace they are signed in to, whoever
 *     made them, and nothing from any other workspace;
 *   - an editor or viewer reads their own rows only (unchanged);
 *   - the instance operator reads everything (unchanged).
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
const DATA_DIR = path.join(os.tmpdir(), 'st-actscope-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const U = {};

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
async function account(name) {
  const r = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: name + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name }) })).json();
  assert.ok(r.token, JSON.stringify(r));
  return { token: r.token, id: r.user.id, wsId: r.current_workspace_id };
}
async function joinAs(user, wsId, role) {
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, user.id, role);
  const sw = await call('POST', '/api/auth/switch-workspace', user.token, { workspace_id: wsId });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  user.token = sw.body.token || user.token;
}
const names = async (u) => {
  const r = await call('GET', '/api/activity?limit=200', u.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.map((x) => x.details || '').join('\n');
};

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  U.operator = await account('operator');            // first account: the instance operator
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  U.admin = await account('admin');                   // runs workspace A (their own)
  U.editor = await account('editor');
  U.other = await account('other');                   // runs workspace B
  await joinAs(U.editor, U.admin.wsId, 'workspace_editor');
  // One recognisable action each.
  assert.equal((await call('POST', '/api/playlists', U.admin.token, { name: 'made-by-admin' })).status, 201);
  assert.equal((await call('POST', '/api/playlists', U.editor.token, { name: 'made-by-editor' })).status, 201);
  assert.equal((await call('POST', '/api/playlists', U.other.token, { name: 'made-by-other' })).status, 201);
  await sleep(300);
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a workspace administrator reads what their team did in the workspace, and no other workspace', async () => {
  const seen = await names(U.admin);
  assert.match(seen, /made-by-admin/);
  assert.match(seen, /made-by-editor/, 'the editor\'s action in the administrator\'s workspace');
  assert.doesNotMatch(seen, /made-by-other/, 'nothing from another workspace');
});

test('an editor still reads their own rows only', async () => {
  const seen = await names(U.editor);
  assert.match(seen, /made-by-editor/);
  assert.doesNotMatch(seen, /made-by-admin/);
  assert.doesNotMatch(seen, /made-by-other/);
});

test('another workspace\'s administrator sees neither', async () => {
  const seen = await names(U.other);
  assert.match(seen, /made-by-other/);
  assert.doesNotMatch(seen, /made-by-admin|made-by-editor/);
});

test('the instance operator still reads everything', async () => {
  const seen = await names(U.operator);
  assert.match(seen, /made-by-admin/); assert.match(seen, /made-by-editor/); assert.match(seen, /made-by-other/);
});

test('a demoted administrator is back to their own rows at once', async () => {
  const temp = await account('temp');
  await joinAs(temp, U.admin.wsId, 'workspace_admin');
  assert.match(await names(temp), /made-by-editor/);
  db.prepare("UPDATE workspace_members SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?").run(U.admin.wsId, temp.id);
  assert.doesNotMatch(await names(temp), /made-by-editor|made-by-admin/);
});
