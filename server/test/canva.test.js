'use strict';

/*
 * Canva import and sync, end to end: a real server against a mock Canva Connect API.
 *
 * What has to hold:
 *   - an org admin saves a Canva integration; the secret is encrypted at rest and never returned
 *   - Connect is OAuth 2.0 + PKCE (S256): a wrong state is refused, the verifier reaches the token
 *     endpoint and matches the challenge, and the tokens are stored encrypted
 *   - an expired access token is refreshed once on 401 and the rotated refresh token is kept
 *   - an import exports the chosen pages (polling the job), creates one item per page, links them,
 *     and can build a playlist in page order
 *   - sync replaces bytes ONLY when the design changed, through the replace path (revision bumps)
 *   - an export URL outside canva.com is never fetched
 *   - disconnect revokes at Canva and removes the connection
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG, MOCK, mockServer;
let ADMIN, ORG;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...opts });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}
const auth = (body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN.token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const get = (p) => api(p, { headers: { Authorization: `Bearer ${ADMIN.token}` } });

/* ---------- a tiny real PNG, coloured by version so replaced bytes really differ ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(r, g, b, w = 16, h = 9) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- mock Canva ---------- */
const M = {
  clientId: 'canva-client-1', clientSecret: 'canva-secret-xyz',
  challenge: null, codes: new Map(), access: new Set(), refresh: new Set(), revoked: [],
  designUpdatedAt: 1000, version: 1, hostileUrl: null, exportsCreated: 0, tokenCalls: [],
  seq: 0,
};
function issueTokens() {
  const a = `acc-${++M.seq}-${crypto.randomBytes(4).toString('hex')}`;
  const r = `ref-${M.seq}-${crypto.randomBytes(4).toString('hex')}`;
  M.access.add(a); M.refresh.add(r);
  return { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: 14400, scope: 'design:meta:read design:content:read profile:read' };
}
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }); }
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function mockHandler(req, res) {
  const u = new URL(req.url, MOCK);
  if (u.pathname === '/v1/oauth/token' || u.pathname === '/v1/oauth/revoke') {
    const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    const form = new URLSearchParams(await readBody(req));
    if (basic !== `${M.clientId}:${M.clientSecret}`) return json(res, 401, { error: 'invalid_client', error_description: 'bad client' });
    if (u.pathname === '/v1/oauth/revoke') { M.revoked.push(form.get('token')); return json(res, 200, {}); }
    M.tokenCalls.push(Object.fromEntries(form));
    if (form.get('grant_type') === 'authorization_code') {
      const c = M.codes.get(form.get('code'));
      if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
      const expect = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (expect !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      M.codes.delete(form.get('code'));
      return json(res, 200, issueTokens());
    }
    if (form.get('grant_type') === 'refresh_token') {
      const r = form.get('refresh_token');
      if (!M.refresh.has(r)) return json(res, 400, { error: 'invalid_grant' });
      M.refresh.delete(r);   // single-use, as Canva's are
      return json(res, 200, issueTokens());
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (u.pathname.startsWith('/files/')) {
    const m = /^\/files\/p(\d+)-v(\d+)\.png$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(png(Number(m[1]) * 40, Number(m[2]) * 60, 200));
  }
  const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!M.access.has(tok)) return json(res, 401, { code: 'invalid_access_token', message: 'expired' });
  if (u.pathname === '/v1/users/me') return json(res, 200, { team_user: { user_id: 'cu-1', team_id: 'ct-1' } });
  if (u.pathname === '/v1/users/me/profile') return json(res, 200, { profile: { display_name: 'Pat Designer' } });
  const design = () => ({ id: 'DAF1', title: 'Spring menu', page_count: 2, updated_at: M.designUpdatedAt, thumbnail: { url: 'https://document-export.canva.com/thumb.png' } });
  if (u.pathname === '/v1/designs') return json(res, 200, { items: [design()], continuation: null });
  if (u.pathname === '/v1/designs/DAF1') return json(res, 200, { design: design() });
  if (u.pathname === '/v1/designs/DAF1/pages') return json(res, 200, { items: [{ index: 1, thumbnail: { url: 'https://document-export.canva.com/p1.png' } }, { index: 2, thumbnail: { url: 'https://document-export.canva.com/p2.png' } }] });
  if (u.pathname === '/v1/exports' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req));
    M.exportsCreated++;
    const id = `job-${M.exportsCreated}`;
    M[id] = { polls: 0, pages: b.format.pages, version: M.version };
    return json(res, 200, { job: { id, status: 'in_progress' } });
  }
  const jm = /^\/v1\/exports\/(job-\d+)$/.exec(u.pathname);
  if (jm && M[jm[1]]) {
    const j = M[jm[1]];
    if (j.polls++ < 1) return json(res, 200, { job: { id: jm[1], status: 'in_progress' } });
    const urls = j.pages.map((p) => M.hostileUrl || `${MOCK}/files/p${p}-v${j.version}.png`);
    return json(res, 200, { job: { id: jm[1], status: 'success', urls } });
  }
  json(res, 404, { code: 'not_found', message: 'nope' });
}

async function pollJob(id) {
  for (let i = 0; i < 100; i++) {
    const r = await get(`/api/canva/jobs/${id}`);
    if (r.body.status !== 'running') return r.body;
    await sleep(100);
  }
  throw new Error('job did not finish');
}

before(async () => {
  const MOCK_PORT = await freePort();
  MOCK = `http://127.0.0.1:${MOCK_PORT}`;
  mockServer = http.createServer((req, res) => { mockHandler(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'canva-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', APP_URL: BASE,
      CANVA_API_BASE: MOCK, CANVA_AUTHORIZE_URL: `${MOCK}/authorize`, CANVA_POLL_MS: '50', CANVA_CLIENT_ID: '', CANVA_CLIENT_SECRET: '' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'Passw0rd123', name: 'Owner' }) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  ADMIN = { token: reg.body.token, id: reg.body.user.id, ws: reg.body.current_workspace_id };
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', ADMIN.ws).organization_id;
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (mockServer) mockServer.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

test('without an integration, Canva reports not configured', async () => {
  const s = await get('/api/canva/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, false);
  assert.equal(s.body.redirect_uri, `${BASE}/api/canva/callback`);
  assert.equal((await api('/api/canva/connect', auth({}))).status, 400);
});

test('an org admin saves the integration; the secret is encrypted and never returned', async () => {
  assert.equal((await api('/api/canva/integration', auth({ client_id: M.clientId }, 'PUT'))).status, 400, 'a secret is required the first time');
  const put = await api('/api/canva/integration', auth({ client_id: M.clientId, client_secret: 'wrong' }, 'PUT'));
  assert.equal(put.status, 200);
  const bad = await api('/api/canva/integration/test', auth({}));
  assert.equal(bad.body.ok, false, 'a wrong secret is reported');
  await api('/api/canva/integration', auth({ client_id: M.clientId, client_secret: M.clientSecret }, 'PUT'));
  const good = await api('/api/canva/integration/test', auth({}));
  assert.equal(good.body.ok, true, JSON.stringify(good.body));
  // Re-saving without the secret keeps it.
  await api('/api/canva/integration', auth({ client_id: M.clientId }, 'PUT'));
  assert.equal((await api('/api/canva/integration/test', auth({}))).body.ok, true);

  const g = await get('/api/canva/integration');
  assert.equal(g.body.client_id, M.clientId);
  assert.equal(g.body.has_client_secret, true);
  assert.ok(!JSON.stringify(g.body).includes(M.clientSecret));
  const row = q1('SELECT client_secret_enc FROM canva_integrations WHERE organization_id = ?', ORG);
  assert.ok(row.client_secret_enc && !row.client_secret_enc.includes(M.clientSecret), 'encrypted at rest');
  const s = await get('/api/canva/status');
  assert.equal(s.body.configured, true);
  assert.equal(s.body.source, 'org');
  assert.equal(s.body.connected, false);
});

async function startConnect() {
  const r = await api('/api/canva/connect', auth({}));
  assert.equal(r.status, 200);
  const url = new URL(r.body.url);
  const cookie = /st_canva_tx=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
  return { url, cookie };
}

test('connect is OAuth + PKCE: a wrong state is refused, the right one stores encrypted tokens', async () => {
  let { url, cookie } = await startConnect();
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('redirect_uri'), `${BASE}/api/canva/callback`);
  assert.equal(url.searchParams.get('client_id'), M.clientId);
  assert.match(url.searchParams.get('scope'), /design:content:read/);
  M.codes.set('code-a', { challenge: url.searchParams.get('code_challenge') });

  const wrong = await api(`/api/canva/callback?code=code-a&state=nope`, { headers: { Cookie: `st_canva_tx=${cookie}` } });
  assert.equal(wrong.headers.get('location'), '/app#/content?canva_error=bad_state');
  const noCookie = await api(`/api/canva/callback?code=code-a&state=${url.searchParams.get('state')}`);
  assert.equal(noCookie.headers.get('location'), '/app#/content?canva_error=expired');
  assert.equal(q1('SELECT COUNT(*) AS n FROM canva_connections').n, 0);

  ({ url, cookie } = await startConnect());
  M.codes.set('code-b', { challenge: url.searchParams.get('code_challenge') });
  const ok = await api(`/api/canva/callback?code=code-b&state=${url.searchParams.get('state')}`, { headers: { Cookie: `st_canva_tx=${cookie}` } });
  assert.equal(ok.headers.get('location'), '/app#/content?canva=connected');
  const call = M.tokenCalls.find((c) => c.code === 'code-b');
  assert.ok(call && call.code_verifier && call.code_verifier.length >= 43, 'the verifier reached the token endpoint (and matched, or no tokens)');
  const conn = q1('SELECT * FROM canva_connections WHERE user_id = ?', ADMIN.id);
  assert.equal(conn.display_name, 'Pat Designer');
  for (const t of M.access) assert.ok(!conn.access_enc.includes(t), 'access token encrypted');
  for (const t of M.refresh) assert.ok(!conn.refresh_enc.includes(t), 'refresh token encrypted');
  const s = await get('/api/canva/status');
  assert.equal(s.body.connected, true);
  assert.equal(s.body.display_name, 'Pat Designer');
});

test('designs are listed; an expired token is refreshed once and the rotated refresh token kept', async () => {
  const before = q1('SELECT refresh_enc FROM canva_connections WHERE user_id = ?', ADMIN.id).refresh_enc;
  M.access.clear();   // Canva expires every access token
  const r = await get('/api/canva/designs');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items[0].id, 'DAF1');
  assert.equal(r.body.items[0].title, 'Spring menu');
  assert.ok(!/acc-|ref-/.test(JSON.stringify(r.body)), 'no tokens in the response');
  assert.notEqual(q1('SELECT refresh_enc FROM canva_connections WHERE user_id = ?', ADMIN.id).refresh_enc, before, 'rotated refresh token stored');
  assert.equal((await get('/api/canva/designs')).status, 200, 'and the new pair keeps working');
  const pages = await get('/api/canva/designs/DAF1/pages');
  assert.equal(pages.body.pages.length, 2);
});

let IMPORTED = [];
test('import exports the pages, creates one item per page, links them, and builds a playlist', async () => {
  const r = await api('/api/canva/import', auth({ design_id: 'DAF1', pages: [2, 1], format: 'png', playlist_name: 'Spring menu' }));
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await pollJob(r.body.job_id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  IMPORTED = job.result.content_ids;
  assert.equal(IMPORTED.length, 2);
  const rows = IMPORTED.map((id) => q1('SELECT * FROM content WHERE id = ?', id));
  assert.deepEqual(rows.map((c) => c.filename), ['Spring menu — page 1.png', 'Spring menu — page 2.png'], 'page order');
  assert.ok(rows.every((c) => c.mime_type === 'image/png' && c.workspace_id === ADMIN.ws));
  const items = q('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order', job.result.playlist_id).map((x) => x.content_id);
  assert.deepEqual(items, IMPORTED);
  const links = (await get('/api/canva/links')).body.links;
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.pages[0]).sort(), [1, 2]);
});

test('sync replaces nothing while the design is unchanged, and the bytes when it changes', async () => {
  const before = IMPORTED.map((id) => q1('SELECT updated_at, byte_digest FROM content WHERE id = ?', id));
  const exportsBefore = M.exportsCreated;
  let job = await pollJob((await api(`/api/canva/links/${IMPORTED[0]}/sync`, auth({}))).body.job_id);
  assert.equal(job.status, 'done');
  assert.equal(job.result.replaced, 0);
  assert.equal(job.result.unchanged, 1);
  assert.equal(M.exportsCreated, exportsBefore, 'no export for an unchanged design');
  assert.deepEqual(IMPORTED.map((id) => q1('SELECT updated_at, byte_digest FROM content WHERE id = ?', id)), before);

  M.designUpdatedAt = 2000; M.version = 2;
  job = await pollJob((await api(`/api/canva/links/${IMPORTED[0]}/sync`, auth({}))).body.job_id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.result.replaced, 1);
  const after1 = q1('SELECT updated_at, byte_digest FROM content WHERE id = ?', IMPORTED[0]);
  assert.ok(after1.updated_at > before[0].updated_at, 'revision bumped');
  assert.notEqual(after1.byte_digest, before[0].byte_digest, 'new bytes');
  assert.ok(q1("SELECT 1 AS x FROM revisions WHERE resource_id = ? AND summary = 'Replaced file'", IMPORTED[0]), 'through the replace path');
  assert.equal(q1('SELECT design_updated_at FROM canva_links WHERE content_id = ?', IMPORTED[0]).design_updated_at, 2000);
});

test('the scheduled sweep refreshes the other page through the same rule', async () => {
  run('UPDATE canva_links SET last_checked_at = 0');
  const out = await new Promise((resolve) => {
    // Driven in-process against the same DB the server uses (the sweep's timer is minutes long).
    const child = spawn(process.execPath, ['-e', `
      process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
      require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'canva'))}).syncContent(${JSON.stringify(IMPORTED)}).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
    `], { env: { ...process.env, DATA_DIR, CANVA_API_BASE: MOCK, CANVA_POLL_MS: '50', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    child.stdout.on('data', (d) => { o += d; });
    child.on('exit', () => resolve(o));
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.replaced, 1, out);
  assert.equal(r.unchanged, 1);
});

test('an export URL outside canva.com is never fetched', async () => {
  M.hostileUrl = 'http://169.254.169.254/latest/meta-data';
  const countBefore = q1('SELECT COUNT(*) AS n FROM content').n;
  const r = await api('/api/canva/import', auth({ design_id: 'DAF1', pages: [1] }));
  const job = await pollJob(r.body.job_id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /outside canva\.com/);
  M.hostileUrl = 'https://evil.example.com/x.png';
  const job2 = await pollJob((await api('/api/canva/import', auth({ design_id: 'DAF1', pages: [1] }))).body.job_id);
  assert.match(job2.error, /outside canva\.com/);
  assert.equal(q1('SELECT COUNT(*) AS n FROM content').n, countBefore, 'nothing was created');
  M.hostileUrl = null;
});

test('Canva is JWT only: an API token cannot reach it', async () => {
  const tok = await api('/api/tokens', auth({ name: 'ci', scope: 'full' }));
  const raw = tok.body.token || tok.body.raw_token || tok.body.key;
  assert.ok(raw, JSON.stringify(tok.body));
  const r = await api('/api/canva/status', { headers: { Authorization: `Bearer ${raw}` } });
  assert.equal(r.status, 401);
});

test('disconnect revokes at Canva and forgets the connection', async () => {
  const r = await api('/api/canva/disconnect', auth({}));
  assert.equal(r.status, 200);
  assert.ok(M.revoked.length >= 1, 'revoked at Canva');
  assert.equal(q1('SELECT COUNT(*) AS n FROM canva_connections').n, 0);
  assert.equal((await get('/api/canva/status')).body.connected, false);
  // Deleting a linked item takes its link with it (foreign keys are off in production).
  await api(`/api/content/${IMPORTED[1]}`, auth(undefined, 'DELETE'));
  assert.equal(q1('SELECT COUNT(*) AS n FROM canva_links WHERE content_id = ?', IMPORTED[1]).n, 0);
});
