'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sssp3-fit-http-'));
const dataDir = path.join(tmp, 'data');
let base, proc, sqlite, owner, outsider;
const id = crypto.randomUUID();
const renditionId = 'a'.repeat(32);
const filename = `ssf_${renditionId}.jpg`;

async function request(token, pathname) {
  const response = await fetch(base + pathname, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JWT_SECRET: 'fit-http-' + crypto.randomBytes(12).toString('hex') };
  const log = fs.openSync(path.join(tmp, 'server.log'), 'w');
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', log, log] });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/status')).ok) break; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 119) throw new Error('server did not boot; see ' + path.join(tmp, 'server.log'));
  }
  let n = 0;
  async function register(email) {
    const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${++n}` }, body: JSON.stringify({ email, password: 'Passw0rd123!', createOrg: true }) });
    const json = await response.json();
    assert.equal(response.status, 201, JSON.stringify(json));
    return { token: json.token, id: json.user.id, workspace: json.current_workspace_id };
  }
  owner = await register('owner@fit-http.invalid');
  outsider = await register('outsider@fit-http.invalid');
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(dataDir, 'db', 'remote_display.db'));
  const contentDir = path.join(dataDir, 'uploads', 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'origin.jpg'), 'origin');
  fs.writeFileSync(path.join(contentDir, filename), 'rendition');
  sqlite.prepare('INSERT INTO content (id,workspace_id,filename,filepath,mime_type,file_size,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)')
    .run(id, owner.workspace, 'origin.jpg', 'origin.jpg', 'image/jpeg', 6);
  sqlite.prepare(`INSERT INTO sssp3_fit_renditions (id,content_id,workspace_id,source_file,source_revision,fit,width,height,output_ext,status,filepath,file_size,created_at,updated_at,last_used_at)
    VALUES (?,?,?,?,?,'contain',960,540,'.jpg','ready',?,?,1,1,1)`).run(renditionId, id, owner.workspace, 'origin.jpg', 1, filename, 9);
});

after(() => { try { proc && proc.kill('SIGKILL'); } catch (_) {} try { sqlite && sqlite.close(); } catch (_) {} });

test('gated rendition endpoint enforces workspace access and no-store caching', async () => {
  const url = `/api/content/${id}/sssp3-fit/${renditionId}`;
  const denied = await request(null, url);
  assert.equal(denied.status, 403);
  const foreign = await request(outsider.token, url);
  assert.equal(foreign.status, 403);
  const ok = await request(owner.token, url);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.equal(ok.text, 'rendition');
  const notReady = await request(owner.token, `/api/content/${id}/sssp3-fit/${'b'.repeat(32)}`);
  assert.equal(notReady.status, 404);
});
