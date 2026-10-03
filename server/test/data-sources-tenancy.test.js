'use strict';

/*
 * Data sources are scoped to a WORKSPACE (and so to its organization): against a real server
 * process, org B can never list, read, edit, refresh, delete, back-fill a secret from, or bind to
 * org A's sources — not by id, not by slug, not by spoofing X-Workspace-Id — and a read-only
 * member of A sees A's data without the credentials behind it.
 *
 * Uses the Manual table and REST types: the table needs no network, and REST carries a secret.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-ds-tenancy-'));
const DATA_DIR = path.join(TMP, 'data');
const TOKEN = 'TENANT-A-API-TOKEN-' + crypto.randomBytes(6).toString('hex');
let BASE;
let proc;
let sqlite;
const U = {};
const DS = {};

async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && who.token) headers.Authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_REGISTRATION;
  Object.assign(env, { DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JWT_SECRET: 'ds-ten-' + crypto.randomBytes(8).toString('hex') });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));

  let n = 0;
  const reg = async (email, createOrg) => {
    const r = await api(null, 'POST', '/api/auth/register', { email, password: 'Passw0rd123!', createOrg }, { 'X-Forwarded-For': `192.0.2.${++n}` });
    assert.equal(r.status, 201, `register ${email}: ${r.text}`);
    return { token: r.json.token, id: r.json.user.id, ws: r.json.current_workspace_id };
  };
  U.admin = await reg('admin@ds.local', true);      // first user is platform_admin; kept out of the way
  U.a = await reg('owner-a@ds.local', true);
  U.b = await reg('owner-b@ds.local', true);
  U.viewerA = await reg('viewer-a@ds.local', false);
  assert.ok(U.a.ws && U.b.ws && U.a.ws !== U.b.ws);

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
  const orgA = sqlite.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(U.a.ws).organization_id;
  const orgB = sqlite.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(U.b.ws).organization_id;
  assert.notEqual(orgA, orgB, 'two separate organizations');
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(U.a.ws, U.viewerA.id);

  // Org A: a table with A-only data, and a REST source holding a token. Org B: a table with the SAME slug.
  let r = await api(U.a, 'POST', '/api/data-sources', { name: 'Menu', slug: 'menu', type: 'table', config: { columns: ['Item', 'Price'], rows: [['A-SECRET-ITEM', '9.99']], key_column: 'Item' } });
  assert.equal(r.status, 201, r.text); DS.aTable = r.json.id;
  r = await api(U.a, 'POST', '/api/data-sources', { name: 'Queue', type: 'rest', config: { url: 'https://api.example.com/queue', auth_type: 'bearer', auth_token: TOKEN } });
  assert.equal(r.status, 201, r.text); DS.aRest = r.json.id;
  r = await api(U.b, 'POST', '/api/data-sources', { name: 'Menu', slug: 'menu', type: 'table', config: { columns: ['Item'], rows: [['B-ITEM']] } });
  assert.equal(r.status, 201, r.text); DS.bTable = r.json.id;
  assert.equal(r.json.slug, 'menu', 'a slug is unique per workspace, not globally');
  // Let the background first sync of the tables land.
  for (let i = 0; i < 40; i++) {
    const row = sqlite.prepare('SELECT last_status FROM data_sources WHERE id = ?').get(DS.aTable);
    if (row && row.last_status === 'ok') break;
    await new Promise((res) => setTimeout(res, 100));
  }
});

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

test('each workspace lists only its own sources', async () => {
  const a = await api(U.a, 'GET', '/api/data-sources');
  const b = await api(U.b, 'GET', '/api/data-sources');
  assert.deepEqual(a.json.map((d) => d.id).sort(), [DS.aTable, DS.aRest].sort());
  assert.deepEqual(b.json.map((d) => d.id), [DS.bTable]);
  assert.doesNotMatch(b.text, /A-SECRET-ITEM|TENANT-A/);
});

test('a spoofed X-Workspace-Id or ?workspace_id does not cross into another org', async () => {
  for (const [h, q] of [[{ 'X-Workspace-Id': U.a.ws }, ''], [{}, `?workspace_id=${U.a.ws}`]]) {
    const r = await api(U.b, 'GET', '/api/data-sources' + q, undefined, h);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((d) => d.id), [DS.bTable]);
  }
});

test('org B gets 404 for every per-id route on org A\'s source', async () => {
  for (const id of [DS.aTable, DS.aRest]) {
    assert.equal((await api(U.b, 'GET', `/api/data-sources/${id}`)).status, 404);
    assert.equal((await api(U.b, 'PUT', `/api/data-sources/${id}`, { name: 'pwned', config: { columns: ['x'], rows: [] } })).status, 404);
    assert.equal((await api(U.b, 'POST', `/api/data-sources/${id}/refresh`)).status, 404);
    assert.equal((await api(U.b, 'DELETE', `/api/data-sources/${id}`)).status, 404);
  }
  const still = sqlite.prepare('SELECT name FROM data_sources WHERE id = ?').get(DS.aTable);
  assert.equal(still.name, 'Menu', 'unchanged and not deleted');
});

test('org B cannot have org A\'s stored token back-filled into a test, even at the same URL', async () => {
  const r = await api(U.b, 'POST', '/api/data-sources/test', {
    id: DS.aRest, type: 'rest', config: { url: 'https://api.example.com/queue', auth_type: 'bearer', auth_token: '' },
  });
  assert.doesNotMatch(r.text, new RegExp(TOKEN));
  // And the token never leaves the server in A's own reads either.
  const own = await api(U.a, 'GET', `/api/data-sources/${DS.aRest}`);
  assert.equal(own.status, 200);
  assert.doesNotMatch(own.text, new RegExp(TOKEN));
  assert.match(sqlite.prepare('SELECT config FROM data_sources WHERE id = ?').get(DS.aRest).config, /"auth_token":"enc:v1:/);
});

test('the same slug in two orgs caches each org\'s own data', () => {
  // The same workspace-filtered query service.getWorkspaceDataMapSync (slides) runs.
  const map = (ws) => Object.fromEntries(sqlite.prepare('SELECT slug, cached_data FROM data_sources WHERE workspace_id = ?').all(ws).map((r) => [r.slug, JSON.parse(r.cached_data || '{}')]));
  const a = map(U.a.ws);
  const b = map(U.b.ws);
  assert.equal(a.menu.a_secret_item, '9.99');
  assert.equal(b.menu.row1_item, 'B-ITEM');
  assert.equal(b.menu.a_secret_item, undefined);
});

test('a read-only member sees the data but not the credentials, and cannot write', async () => {
  const list = await api(U.viewerA, 'GET', '/api/data-sources', undefined, { 'X-Workspace-Id': U.a.ws });
  assert.equal(list.status, 200);
  assert.ok(list.json.some((d) => d.id === DS.aTable));
  assert.doesNotMatch(list.text, new RegExp(TOKEN));
  const create = await api(U.viewerA, 'POST', '/api/data-sources', { name: 'x', type: 'table', config: { columns: ['a'], rows: [] } }, { 'X-Workspace-Id': U.a.ws });
  assert.equal(create.status, 403);
  const test2 = await api(U.viewerA, 'POST', '/api/data-sources/test', { type: 'table', config: { columns: ['a'], rows: [] } }, { 'X-Workspace-Id': U.a.ws });
  assert.equal(test2.status, 403);
});
