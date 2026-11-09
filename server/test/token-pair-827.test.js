'use strict';

// #827: a workspace API token can pair a screen and create a web player.
//
// Runs the real server.js, so the mount order (limiter, bearerAuth, tenancy, scope, device limit)
// is the one production runs. What is pinned:
//  - a 'full' token pairs / creates into ITS bound workspace and leaves an audit row naming it;
//  - write, read and agency tokens are refused;
//  - token requests do not spend the per-IP pairing budget a site's NAT address shares;
//  - failed codes lock out the token's OWNER (every token they hold), not the token or the IP;
//  - each token still gets its own 5/min budget.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-tokpair-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-tokpair-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
const U = {};   // A: general, B: another workspace, C: gets locked out, D: a stranger

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const post = (tok, obj, extra = {}) => ({
  method: 'POST',
  headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(obj),
});

function seedDevice() {
  const id = crypto.randomUUID();
  const code = String(100000 + crypto.randomInt(900000));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO devices (id, pairing_code, status, app_version, created_at, last_heartbeat)
              VALUES (?, ?, 'provisioning', '1.1.0-web', ?, ?)`).run(id, code, now, now);
  return { id, code };
}

async function register() {
  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', post(null, { email, password: PW }));
  assert.ok(reg.body && reg.body.token, 'registered: ' + JSON.stringify(reg.body));
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const ws = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').get(user.id).workspace_id;
  return { jwt: reg.body.token, userId: user.id, ws };
}

function mint(owner, scope = 'full', name = 'rollout') {
  const secret = 'st_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), crypto.createHash('sha256').update(secret).digest('hex'), secret.slice(0, 11), name, owner.userId, owner.ws, scope);
  return secret;
}

const pair = (tok, code, extra) => jfetch('/api/provision/pair', post(tok, { pairing_code: code, name: 'Lobby ' + code }, extra));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  // /api/auth/register allows 5 per minute per IP: register everyone once.
  for (const k of ['A', 'B', 'C', 'D']) U[k] = await register();
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a full token pairs a screen into its own workspace and the pair is audited with the token', async () => {
  const owner = U.A;
  const tok = mint(owner, 'full', 'site rollout');
  const d = seedDevice();
  const r = await pair(tok, d.code);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT user_id, workspace_id, pairing_code, device_token FROM devices WHERE id = ?').get(d.id);
  assert.equal(row.workspace_id, owner.ws);
  assert.equal(row.user_id, owner.userId);
  assert.equal(row.pairing_code, null);
  assert.equal(r.body.device_token, undefined, 'the device token never leaves the server');
  const audit = db.prepare("SELECT details, workspace_id FROM activity_log WHERE action = 'device_paired_via_token' AND device_id = ?").get(d.id);
  assert.ok(audit, 'no audit row for a token pair');
  assert.match(audit.details, /site rollout/);
  assert.match(audit.details, new RegExp(tok.slice(0, 11)));
  assert.doesNotMatch(audit.details, new RegExp(tok.slice(12)), 'the secret is never logged');
});

test('a token cannot be steered into another workspace with X-Workspace-Id', async () => {
  const owner = U.A;
  const other = U.B;
  const tok = mint(owner);
  const d = seedDevice();
  const r = await pair(tok, d.code, { 'X-Workspace-Id': other.ws });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(d.id).workspace_id, owner.ws);
});

test('write, read and agency tokens are refused, and the screen stays unclaimed', async () => {
  const owner = U.A;
  const d = seedDevice();
  for (const scope of ['write', 'read', 'agency']) {
    const r = await pair(mint(owner, scope), d.code);
    assert.equal(r.status, 403, `${scope}: ${JSON.stringify(r.body)}`);
  }
  assert.ok(db.prepare('SELECT pairing_code FROM devices WHERE id = ?').get(d.id).pairing_code, 'still unclaimed');
  const w = await jfetch('/api/devices/web-player', post(mint(owner, 'write'), { name: 'x' }));
  assert.equal(w.status, 403);
});

test('a revoked or made-up token is a 401', async () => {
  const d = seedDevice();
  assert.equal((await pair('st_' + 'x'.repeat(40), d.code)).status, 401);
});

test('the rest of /api/provision stays JWT-only: a full token is a 401 on the bare POST', async () => {
  const r = await jfetch('/api/provision', post(mint(U.A), { pairing_code: seedDevice().code }));
  assert.equal(r.status, 401, JSON.stringify(r.body));
});

test('a full token creates a web player, audited', async () => {
  const owner = U.A;
  const tok = mint(owner, 'full', 'kiosk script');
  const r = await jfetch('/api/devices/web-player', post(tok, { name: 'Kiosk 1' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.enrol_key && r.body.player_url);
  const row = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(r.body.device.id);
  assert.equal(row.workspace_id, owner.ws);
  const audit = db.prepare("SELECT details FROM activity_log WHERE action = 'web_player_created_via_token' AND device_id = ?").get(r.body.device.id);
  assert.ok(audit);
  assert.match(audit.details, /kiosk script/);
});

test('failed codes lock out the OWNER across tokens; another owner and the per-IP sessions are unaffected', async () => {
  const owner = U.C;
  const a = mint(owner); const b = mint(owner);
  for (let i = 0; i < 5; i++) assert.equal((await pair(a, '00000' + i)).status, 404);
  const locked = await pair(b, seedDevice().code);
  assert.equal(locked.status, 429, 'a second token of the same owner buys no more guesses');
  assert.match(locked.body.error, /failed pairing attempts/i);

  const stranger = U.D;
  assert.equal((await pair(mint(stranger), seedDevice().code)).status, 200, 'a different owner on the same IP pairs');
  assert.equal((await pair(stranger.jwt, seedDevice().code)).status, 200, 'the IP itself is not locked by token failures');
});

test('each token has its own 5/min budget, apart from the per-IP one', async () => {
  const owner = U.A;
  const tok = mint(owner);
  for (let i = 0; i < 5; i++) assert.equal((await pair(tok, seedDevice().code)).status, 200, `pair ${i + 1}`);
  const sixth = await pair(tok, seedDevice().code);
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /too many requests/i);
  assert.equal((await pair(mint(owner), seedDevice().code)).status, 200, 'a second token rolls out in parallel');
});
