'use strict';

/*
 * A PERSON AN ADMIN ADDS STARTS ON THE SAME PLAN AS A PERSON WHO SIGNS UP.
 *
 * On a self-hosted instance every account starts on the unrestricted plan (routes/auth.js
 * signupPlan): there is nothing to buy, and a colleague held to two screens on the operator's own
 * server was a nag with nobody to pay. "Add user" is the other way an account is made, and it wrote
 * the hosted free plan regardless. So the same colleague, added by the admin instead of signing up,
 * was refused their third screen, refused web-address content, and shown a price list.
 *
 * The invariant: on an instance whose signups start unrestricted, so does an added user. Where
 * signups do not (hosted, or a self-hosted operator who asked for the trial model), an added user
 * starts on free as before; they never get a trial clock they did not ask for.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
after(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } } });

async function boot(extraEnv) {
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const DATA_DIR = path.join(os.tmpdir(), 'st-addplan-' + crypto.randomBytes(4).toString('hex'));
  const logFd = fs.openSync(DATA_DIR + '.log', 'w');
  const env = { ...process.env, DATA_DIR, PORT: String(port), NODE_ENV: 'test', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  procs.push(proc);
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(DATA_DIR + '.log', 'utf8').slice(-2000));
  const post = async (p, body, token) => {
    const res = await fetch(BASE + p, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json };
  };
  const reg = await post('/api/auth/register', { email: 'owner' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'Owner' });
  assert.ok(reg.body && reg.body.token, 'registered: ' + JSON.stringify(reg.body));
  const db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  // The instance operator, so the route is reachable the same way in every mode.
  db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(reg.body.user.id);
  const login = await post('/api/auth/login', { email: reg.body.user.email, password: 'Passw0rd123' });
  const token = (login.body && login.body.token) || reg.body.token;
  const addUser = async () => {
    const email = 'added' + crypto.randomBytes(4).toString('hex') + '@example.com';
    const r = await post('/api/admin/users', { email, name: 'Added', password: 'Passw0rd456', workspaceId: reg.body.current_workspace_id, role: 'workspace_editor' }, token);
    assert.ok(r.status === 200 || r.status === 201, 'user added: ' + r.status + ' ' + JSON.stringify(r.body));
    return db.prepare('SELECT plan_id, trial_started FROM users WHERE email = ?').get(email);
  };
  const signupPlanOf = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(reg.body.user.id).plan_id;
  return { addUser, signupPlanOf, db };
}

test('self-hosted: an added user starts unrestricted, like a signup does', async () => {
  const s = await boot({ SELF_HOSTED: 'true', SELF_HOSTED_SIGNUP_PLAN: undefined });
  assert.equal(s.signupPlanOf, 'enterprise', 'a signup on this instance starts unrestricted');
  const u = await s.addUser();
  assert.equal(u.plan_id, 'enterprise', 'and so does a user the admin adds');
  assert.equal(u.trial_started, null, 'with no trial clock');
  const plan = s.db.prepare('SELECT max_devices FROM plans WHERE id = ?').get(u.plan_id);
  assert.equal(plan.max_devices, -1, 'which is the plan with no screen limit');
  s.db.close();
});

test('self-hosted with the trial model asked for: an added user starts on free, never on a trial', async () => {
  const s = await boot({ SELF_HOSTED: 'true', SELF_HOSTED_SIGNUP_PLAN: 'trial' });
  const u = await s.addUser();
  assert.equal(u.plan_id, 'free');
  assert.equal(u.trial_started, null);
  s.db.close();
});

test('hosted: an added user starts on free, never on a trial (unchanged)', async () => {
  const s = await boot({ SELF_HOSTED: undefined });
  const u = await s.addUser();
  assert.equal(u.plan_id, 'free');
  assert.equal(u.trial_started, null);
  s.db.close();
});
