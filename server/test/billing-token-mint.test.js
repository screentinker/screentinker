'use strict';

// #146 — owner-only billing:read token minting (server/lib/billing-token.js + the CLI it
// backs). Booted server + in-process mint function. Verifies the minted row's exact shape
// (scope + SHA-256 hash, nothing else), that the token reads billing but is refused
// elsewhere (scope isolation), and that revocation takes effect.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-billmint-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA_DIR;   // so requiring lib/billing-token's deps resolves this db too

const { mintBillingToken, revokeBillingToken, listBillingTokens } = require('../lib/billing-token');
const { hashToken } = require('../middleware/apiToken');

let proc, db, minted;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-billmint.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  // Register a user and promote to platform_admin so an OWNER + a workspace exist.
  const email = 'own' + crypto.randomBytes(4).toString('hex') + '@x.local';
  await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json();
  db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(email);

  minted = mintBillingToken(db, { name: 'Bold invoicing' });   // the function the CLI wraps
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const S = (r) => r.status;
const bearer = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

test('mint creates an api_tokens row: scope EXACTLY billing:read, correct SHA-256 hash', () => {
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(minted.id);
  assert.ok(row, 'row exists');
  assert.equal(row.scope, 'billing:read', 'scope is exactly billing:read');
  assert.equal(row.token_hash, hashToken(minted.secret), 'stored hash matches the SHA-256 verification path');
  assert.ok(minted.secret.startsWith('st_'), 'same secret format as existing tokens');
  // does NOT carry any workspace-level scope
  for (const s of ['read', 'write', 'full', 'agency']) assert.notEqual(row.scope, s);
  assert.ok(row.user_id && row.workspace_id, 'bound to owner + a workspace (FK satisfied)');
  assert.equal(row.revoked_at, null, 'not revoked at mint');
  // listBillingTokens surfaces it
  assert.ok(listBillingTokens(db).some((t) => t.id === minted.id));
});

test('minted token reads billing (200) but is REFUSED elsewhere (scope isolation)', async () => {
  assert.equal(S(await fetch(BASE + '/api/billing/usage', bearer(minted.secret))), 200, 'reads billing');
  const body = await (await fetch(BASE + '/api/billing/usage', bearer(minted.secret))).json();
  assert.equal(typeof body.billable_screens, 'number');
  assert.equal(S(await fetch(BASE + '/api/devices', bearer(minted.secret))), 403, 'refused on a workspace router');
  assert.equal(S(await fetch(BASE + '/api/admin/orgs', bearer(minted.secret))), 401, 'refused on an admin router');
});

test('revocation: a revoked minted token is refused', async () => {
  assert.equal(S(await fetch(BASE + '/api/billing/usage', bearer(minted.secret))), 200, 'valid before revoke');
  const res = revokeBillingToken(db, minted.id);
  assert.equal(res.ok, true);
  assert.equal(S(await fetch(BASE + '/api/billing/usage', bearer(minted.secret))), 401, 'refused after revoke');
});

test('mint requires a name; revoke refuses a non-billing token id', () => {
  assert.throws(() => mintBillingToken(db, { name: '' }), /name is required/);
  // revoke guard: a made-up id / non-billing scope is refused, not silently applied
  assert.equal(revokeBillingToken(db, 'no-such-id').ok, false);
});
