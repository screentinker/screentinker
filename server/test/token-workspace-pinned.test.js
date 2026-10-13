'use strict';

/*
 * An API token reaches its bound workspace and no other, whatever the request asks for.
 *
 * ⚠️ EXPRESS 5 TURNED req.query INTO A GETTER that re-parses the URL on every read, so
 * middleware/apiToken.js's `delete req.query.workspace_id` stopped doing anything: resolveTenancy
 * then honoured ?workspace_id and a token bound to workspace A answered for any other workspace its
 * owner belongs to. The fix is in lib/tenancy.js (a token never takes ?workspace_id). This boots the
 * real server, because the bug lived in how the framework hands over the query string, not in
 * either function on its own.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-token-ws-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let proc, BASE;
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok, extra = {}) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...extra } });
const post = (tok, obj, extra) => ({ method: 'POST', ...auth(tok, extra), body: JSON.stringify(obj) });
const register = (email) => jfetch('/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test12345', name: email }),
});

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // The first user becomes platform admin; the boundary is about an ordinary owner.
  await register('first@test.local');
  const a = await register('owner@test.local');
  const b = await register('other@test.local');
  S.jwtA = a.body.token; S.ownerId = a.body.user.id; S.jwtB = b.body.token;

  // The owner's token, bound to the owner's own workspace (A).
  const tok = await jfetch('/api/tokens', post(S.jwtA, { name: 'pinned', scope: 'read' }));
  S.token = tok.body.token; S.wsA = tok.body.workspace_id;
  S.wsB = (await jfetch('/api/tokens', post(S.jwtB, { name: 'b', scope: 'read' }))).body.workspace_id;
  assert.ok(S.token && S.wsA && S.wsB && S.wsA !== S.wsB, 'fixtures');

  // One marker playlist in each workspace.
  assert.equal((await jfetch('/api/playlists', post(S.jwtA, { name: 'MARK-A' }))).status, 201);
  assert.equal((await jfetch('/api/playlists', post(S.jwtB, { name: 'MARK-B' }))).status, 201);

  // The owner is ALSO a member of workspace B: exactly the case where steering would work.
  const db = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(S.wsB, S.ownerId);
  db.close();
  // Sanity: the owner's own session CAN read B, so a token reaching B would be a real leak.
  const viaSession = await jfetch('/api/playlists', auth(S.jwtA, { 'X-Workspace-Id': S.wsB }));
  assert.ok(JSON.stringify(viaSession.body).includes('MARK-B'), 'the owner session reaches workspace B');
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

const names = (r) => JSON.stringify(r.body);

test('?workspace_id cannot steer a token into another workspace its owner belongs to', async () => {
  const r = await jfetch(`/api/playlists?workspace_id=${encodeURIComponent(S.wsB)}`, auth(S.token));
  assert.equal(r.status, 200);
  assert.ok(names(r).includes('MARK-A'), 'still answers for its own workspace');
  assert.ok(!names(r).includes('MARK-B'), 'never for workspace B');
});

test('X-Workspace-Id cannot steer it either', async () => {
  const r = await jfetch('/api/playlists', auth(S.token, { 'X-Workspace-Id': S.wsB }));
  assert.equal(r.status, 200);
  assert.ok(names(r).includes('MARK-A'));
  assert.ok(!names(r).includes('MARK-B'));
});
