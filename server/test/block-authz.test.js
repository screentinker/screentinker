'use strict';

// #146 P1.4 — POST /api/devices/:id/{block,unblock} is a real lever now; its authz path
// must be covered, not just the happy path. Proves: the owner can block; a
// cross-workspace user CANNOT; a workspace_viewer CANNOT; unauthenticated CANNOT.
// Booted server + JWT; device + viewer membership seeded via the DB file.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-blockauthz-' + crypto.randomBytes(4).toString('hex'));
let proc, db;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-blockauthz.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const jf = async (p, opts = {}) => { const r = await fetch(BASE + p, opts); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (tok) => ({ method: 'POST', headers: tok ? { Authorization: 'Bearer ' + tok } : {} });

test('block/unblock authz: owner allowed; cross-workspace, viewer, and anon denied', async () => {
  const emailA = 'a' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const emailB = 'b' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwtA = (await jf('/api/auth/register', reg({ email: emailA, password: 'Passw0rd123' }))).body.token;
  const jwtB = (await jf('/api/auth/register', reg({ email: emailB, password: 'Passw0rd123' }))).body.token;
  assert.ok(jwtA && jwtB, 'both users registered');

  const userA = db.prepare('SELECT id FROM users WHERE email = ?').get(emailA).id;
  const userB = db.prepare('SELECT id FROM users WHERE email = ?').get(emailB).id;
  const wsA = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'workspace_admin'").get(userA).workspace_id;

  // a device in A's workspace
  db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES ('authz-dev', 'D', 'offline', ?)").run(wsA);

  // 1) anon -> 401
  assert.equal((await jf('/api/devices/authz-dev/block', post(null))).status, 401, 'unauthenticated cannot block');

  // 2) cross-workspace user B (not a member of A's workspace) -> 403
  assert.equal((await jf('/api/devices/authz-dev/block', post(jwtB))).status, 403, 'cross-workspace user cannot block');

  // 3) owner A -> 200, and the DB reflects it
  const okBlock = await jf('/api/devices/authz-dev/block', post(jwtA));
  assert.equal(okBlock.status, 200, 'owner can block');
  assert.equal(db.prepare("SELECT blocked FROM devices WHERE id = 'authz-dev'").get().blocked, 1, 'blocked persisted');

  // 4) make B a workspace_viewer in A's workspace -> still denied (read-only)
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(wsA, userB);
  assert.equal((await jf('/api/devices/authz-dev/unblock', post(jwtB))).status, 403, 'a workspace_viewer cannot unblock');
  assert.equal(db.prepare("SELECT blocked FROM devices WHERE id = 'authz-dev'").get().blocked, 1, 'still blocked — viewer write was denied');

  // 5) owner A can unblock -> 200
  assert.equal((await jf('/api/devices/authz-dev/unblock', post(jwtA))).status, 200, 'owner can unblock');
  assert.equal(db.prepare("SELECT blocked FROM devices WHERE id = 'authz-dev'").get().blocked, 0, 'unblocked');
});
