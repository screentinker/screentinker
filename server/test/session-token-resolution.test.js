'use strict';

// Six surfaces resolve a session token THEMSELVES instead of sitting behind requireAuth:
// the three /api/status token routes, the screenshot route, the content-reference gate,
// and the /dashboard socket handshake. They all now call middleware/auth.resolveSessionUser,
// the same resolver requireAuth uses, so they must inherit its checks. This suite walks
// every one of them and asserts, per surface:
//
//   1. a PRE-TOTP token (mfa_pending, i.e. password accepted but the TOTP step not
//      completed) is refused,
//   2. a normal full session token is still accepted, and
//   3. a recovery token behaves as it did before this refactor - accepted by
//      requireAuth-gated routes, refused by these six (it has no users row, so the
//      lookups these replaced already denied it).
//
// The socket handshake is included deliberately: it is the one surface with no HTTP
// equivalent, so a suite that covered only the routes would not hold it to the contract.
//
// Boots the REAL server.js as a subprocess against an isolated DB (same convention as
// api.test.js / totp.test.js). Node built-ins + socket.io-client (devDep) only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const ioClient = require('socket.io-client');
// The phone: otplib 13 has no `authenticator`; generate the current code under the server's limits.
const otplib = require('otplib');
const PHONE_LIMITS = otplib.createGuardrails({ MIN_SECRET_BYTES: 10 });   // accepts pre-otplib-13 secrets too
const authenticator = { generate: (secret) => otplib.generateSync({ secret, guardrails: PHONE_LIMITS }) };

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const SECRET = 'test-secret-session-resolution-' + crypto.randomBytes(4).toString('hex');
const DATA_DIR = path.join(os.tmpdir(), 'st-session-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-session-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;
const S = {}; // shared fixtures populated in before()

const PW = 'Passw0rd123';

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok, extra = {}) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...extra } });
const post = (tok, obj, extra) => ({ method: 'POST', ...auth(tok, extra), body: JSON.stringify(obj || {}) });

// A 1x1 PNG - enough for the ingest path to produce a real file + thumbnail, so the
// content-reference gate is actually reachable.
const PNG_1X1 = Buffer.from(
  // Must be a STRUCTURALLY VALID PNG. The previous literal had a corrupt IDAT chunk (stored CRC
  // did not match its data) and only decoded because the old libpng was lenient. A stricter decoder
  // rejects it ("vipspng: libpng read error"), no thumbnail is written, and the assertions below
  // fail with a 404 that looks like an auth regression but is not. Every chunk CRC here verifies.
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

// Connect to the /dashboard namespace and report whether the handshake was accepted.
function connectDashboard(token) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/dashboard`, {
      auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true,
    });
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => done({ connected: true, message: null }));
    sock.on('connect_error', (e) => done({ connected: false, message: e.message }));
    setTimeout(() => done({ connected: false, message: 'timeout' }), 5000);
  });
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', JWT_SECRET: SECRET },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // First registered user becomes platform_admin - needed so the /backup happy path is
  // actually authorized, which is what makes its pre-TOTP refusal meaningful.
  S.adminEmail = 'admin' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', post(null, { email: S.adminEmail, password: PW }));
  S.adminToken = reg.body.token;
  assert.equal(reg.body.user.role, 'platform_admin', 'first user is platform_admin');

  // Enroll TOTP, then log in again to obtain a genuine mfa_pending token. The pre-existing
  // session token stays valid across enrollment (see totp.test.js), so S.adminToken is
  // still our "full session" fixture for the same account.
  const setup = await jfetch('/api/auth/totp/setup', post(S.adminToken, {}));
  await jfetch('/api/auth/totp/enable', post(S.adminToken, { code: authenticator.generate(setup.body.secret) }));
  const login = await jfetch('/api/auth/login', post(null, { email: S.adminEmail, password: PW }));
  assert.equal(login.body.mfa_required, true, 'login now stops at the TOTP step');
  assert.equal(login.body.token, undefined, 'no full session token before TOTP');
  S.mfaToken = login.body.mfa_token;
  assert.ok(S.mfaToken, 'got a pre-TOTP token');

  // Recovery token, minted exactly as scripts/reset-admin.js does it — including the
  // recovery_grants row, without which the token is refused outright. Backing it properly
  // keeps the assertions below testing what they were written to test (break-glass is
  // refused on these six surfaces because it has no users row / no workspace membership),
  // rather than passing for the unrelated reason that the token itself is invalid.
  {
    const Database = require('better-sqlite3');
    const gdb = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
    const jti = crypto.randomBytes(16).toString('hex');
    gdb.prepare('INSERT INTO recovery_grants (jti, expires_at, minted_by, note) VALUES (?,?,?,?)')
      .run(jti, Math.floor(Date.now() / 1000) + 3600, 'test', 'session-token-resolution');
    gdb.close();
    S.recoveryToken = jwt.sign(
      { id: 'recovery-' + jti, email: 'admin@localhost', role: 'admin', recovery: true, jti },
      SECRET, { expiresIn: '1h' }
    );
  }

  // Content with a real file + thumbnail, not referenced by any playlist, so
  // /api/content/:id/{file,thumbnail} falls through to the requester gate.
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'px.png');
  const up2 = await fetch(BASE + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + S.adminToken }, body: fd });
  const created = await up2.json();
  S.contentId = created.id;
  assert.ok(S.contentId, 'uploaded content for the reference-gate tests');
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

// ---------------------------------------------------------------------------
// 1. GET /api/status/backup  (?token=)  - full database download
// ---------------------------------------------------------------------------
test('status/backup: pre-TOTP token refused, full admin session accepted, recovery refused', async () => {
  const mfa = await jfetch(`/api/status/backup?token=${encodeURIComponent(S.mfaToken)}`);
  assert.equal(mfa.status, 401, 'pre-TOTP token must not reach the database backup');
  assert.equal(mfa.body.error, 'mfa_required');

  // Happy path returns the DB file itself, so consume it rather than parsing JSON.
  const ok = await fetch(`${BASE}/api/status/backup?token=${encodeURIComponent(S.adminToken)}`);
  await ok.arrayBuffer();
  assert.equal(ok.status, 200, 'a full platform-admin session still downloads the backup');

  const rec = await jfetch(`/api/status/backup?token=${encodeURIComponent(S.recoveryToken)}`);
  assert.equal(rec.status, 403, 'recovery identity is not a platform admin here (unchanged)');
});

// ---------------------------------------------------------------------------
// 2. GET /api/status/export  (?token=)
// ---------------------------------------------------------------------------
test('status/export: pre-TOTP token refused, full session accepted, recovery refused', async () => {
  const mfa = await jfetch(`/api/status/export?token=${encodeURIComponent(S.mfaToken)}`);
  assert.equal(mfa.status, 401, 'pre-TOTP token must not export account data');
  assert.equal(mfa.body.error, 'mfa_required');

  const ok = await jfetch(`/api/status/export?token=${encodeURIComponent(S.adminToken)}`);
  assert.equal(ok.status, 200, 'a full session still exports');

  const rec = await jfetch(`/api/status/export?token=${encodeURIComponent(S.recoveryToken)}`);
  assert.equal(rec.status, 404, 'recovery identity has no users row (unchanged)');
});

// ---------------------------------------------------------------------------
// 3. POST /api/status/import  (Authorization header)
// ---------------------------------------------------------------------------
test('status/import: pre-TOTP token refused, full session reaches the handler, recovery refused', async () => {
  const mfa = await jfetch('/api/status/import', post(S.mfaToken, { format: 'screentinker-export-v2' }));
  assert.equal(mfa.status, 401, 'pre-TOTP token must not import into a workspace');
  assert.equal(mfa.body.error, 'mfa_required');

  // 400 here is the post-auth validation failing on a body with no payload - i.e. the
  // token WAS accepted. Asserting "not 401/403/404" is the auth boundary we care about.
  const ok = await jfetch('/api/status/import', post(S.adminToken, { nope: true }));
  assert.equal(ok.status, 400, 'a full session passes auth and fails validation instead');

  const rec = await jfetch('/api/status/import', post(S.recoveryToken, { nope: true }));
  assert.equal(rec.status, 404, 'recovery identity has no users row (unchanged)');
});

// ---------------------------------------------------------------------------
// 4. GET /api/devices/:id/screenshot  (?token= and header)
// ---------------------------------------------------------------------------
test('screenshot: pre-TOTP token refused before the device lookup; full session gets past auth', async () => {
  const id = crypto.randomUUID();
  const mfa = await jfetch(`/api/devices/${id}/screenshot?token=${encodeURIComponent(S.mfaToken)}`);
  assert.equal(mfa.status, 401, 'pre-TOTP token must not read device screenshots');
  assert.equal(mfa.body.error, 'mfa_required');

  // No device exists, so 404 "Device not found" is the proof that auth was accepted and
  // the handler moved on to its (deliberately untouched) ownership logic.
  const ok = await jfetch(`/api/devices/${id}/screenshot?token=${encodeURIComponent(S.adminToken)}`);
  assert.equal(ok.status, 404, 'a full session clears auth and reaches the device lookup');

  const rec = await jfetch(`/api/devices/${id}/screenshot?token=${encodeURIComponent(S.recoveryToken)}`);
  assert.equal(rec.status, 401, 'recovery identity has no users row (unchanged)');

  // Same outcome via the Authorization header, not just the query parameter.
  const hdr = await jfetch(`/api/devices/${id}/screenshot`, auth(S.mfaToken));
  assert.equal(hdr.status, 401, 'header path refuses the pre-TOTP token too');
});

// ---------------------------------------------------------------------------
// 5. requesterCanAccessContent -> /api/content/:id/{file,thumbnail}
// ---------------------------------------------------------------------------
test('content gate: pre-TOTP token gets no more than an anonymous caller; full session reads', async () => {
  // Baseline: unreferenced content is not public.
  const anon = await jfetch(`/api/content/${S.contentId}/thumbnail`);
  assert.equal(anon.status, 403, 'unreferenced content is not anonymously readable');

  // The gate returns a boolean, so a refused token surfaces as the same 403 an anonymous
  // caller gets - the point is that it grants NOTHING extra.
  const mfa = await jfetch(`/api/content/${S.contentId}/thumbnail`, auth(S.mfaToken));
  assert.equal(mfa.status, 403, 'pre-TOTP token unlocks no content');
  const mfaFile = await jfetch(`/api/content/${S.contentId}/file`, auth(S.mfaToken));
  assert.equal(mfaFile.status, 403, 'pre-TOTP token unlocks no file either');

  const okThumb = await fetch(`${BASE}/api/content/${S.contentId}/thumbnail`, auth(S.adminToken));
  await okThumb.arrayBuffer();
  assert.equal(okThumb.status, 200, 'a workspace member with a full session still reads the thumbnail');
  const okFile = await fetch(`${BASE}/api/content/${S.contentId}/file`, auth(S.adminToken));
  await okFile.arrayBuffer();
  assert.equal(okFile.status, 200, 'and the file');

  const rec = await jfetch(`/api/content/${S.contentId}/thumbnail`, auth(S.recoveryToken));
  assert.equal(rec.status, 403, 'recovery identity has no workspace membership (unchanged)');
});

// ---------------------------------------------------------------------------
// 6. /dashboard socket handshake
// ---------------------------------------------------------------------------
test('dashboard socket: pre-TOTP token cannot open the namespace; full session can', async () => {
  const mfa = await connectDashboard(S.mfaToken);
  assert.equal(mfa.connected, false, 'pre-TOTP token must not reach the device-command channel');
  assert.equal(mfa.message, 'mfa_required');

  const ok = await connectDashboard(S.adminToken);
  assert.equal(ok.connected, true, 'a full session still connects');

  const rec = await connectDashboard(S.recoveryToken);
  assert.equal(rec.connected, false, 'recovery identity is refused the handshake');

  const bogus = await connectDashboard('not-a-jwt');
  assert.equal(bogus.connected, false, 'garbage token still refused');
  assert.equal(bogus.message, 'Invalid token');
});

// ---------------------------------------------------------------------------
// Cross-checks: the audience split, and requireAuth non-regression.
// ---------------------------------------------------------------------------
test('audience split: the pre-TOTP token works ONLY at /totp/verify, and a session token does not', async () => {
  // A full session token presented as an mfa_token is rejected (no pre-TOTP audience).
  const wrongWay = await jfetch('/api/auth/totp/verify', post(null, { mfa_token: S.adminToken, code: '000000' }));
  assert.equal(wrongWay.status, 401, 'a session token is not accepted as an mfa_token');
  assert.equal(wrongWay.body.error, 'mfa session expired');

  // And the pre-TOTP token is still accepted there: a wrong code gets past token
  // validation to the code check (401 "Invalid code"), not rejected as a bad token.
  const rightWay = await jfetch('/api/auth/totp/verify', post(null, { mfa_token: S.mfaToken, code: '000000' }));
  assert.equal(rightWay.status, 401);
  assert.equal(rightWay.body.error, 'Invalid code', 'pre-TOTP token is still redeemable at /totp/verify');
});

test('requireAuth non-regression: full session works, pre-TOTP 401s, recovery still reaches a gated route', async () => {
  assert.equal((await jfetch('/api/auth/me', auth(S.adminToken))).status, 200, 'full session');
  const mfa = await jfetch('/api/auth/me', auth(S.mfaToken));
  assert.equal(mfa.status, 401, 'pre-TOTP token');
  assert.equal(mfa.body.error, 'mfa_required');
  // Break-glass must keep working where it worked before - a requireAuth-gated route.
  assert.equal((await jfetch('/api/devices', auth(S.recoveryToken))).status, 200, 'recovery still authenticates');
});
