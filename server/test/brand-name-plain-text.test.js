'use strict';

// GHSA-rvxj (E): a workspace brand name is plain text. POST /api/white-label refuses markup, control
// characters and over-long names with a 400 and saves good names trimmed; the settings import keeps
// going and falls back to the default name. Main's t()/asText() already neutralises the name, but
// older players and dashboards render it raw, so it must not be stored as HTML in the first place.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const { brandNameProblem } = require('../lib/branding');

test('brandNameProblem refuses non-text, markup, control characters and names over 80', () => {
  for (const ok of ['Harbour Café Screens', '', '  Acme  ', 'A & B Signs', "O'Brien's", 'x'.repeat(80)]) {
    assert.equal(brandNameProblem(ok), null, JSON.stringify(ok));
  }
  for (const bad of [null, 42, {}, ['x'], '<img src=x onerror=alert(1)>', 'a>b', 'tab\there', 'nl\n', 'del\u007f', 'x'.repeat(81)]) {
    assert.equal(typeof brandNameProblem(bad), 'string', JSON.stringify(bad));
  }
});

let PORT, BASE, proc, db, WS, JWT;
const DATA_DIR = path.join(os.tmpdir(), 'st-brand-text-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  const env = { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' };
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@test.local', password: 'test12345', name: 'owner' }) })).json();
  JWT = reg.token;
  const { Database } = require('../db/sqlite-driver');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  WS = db.prepare('SELECT w.id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE o.owner_user_id = ? LIMIT 1').get(reg.user.id).id;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } try { db.close(); } catch { /* */ } try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const api = (url, body) => fetch(BASE + url, { method: 'POST', body: JSON.stringify(body),
  headers: { Authorization: 'Bearer ' + JWT, 'x-workspace-id': WS, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' } });
const storedName = () => (db.prepare('SELECT brand_name FROM white_labels WHERE workspace_id = ?').get(WS) || {}).brand_name;

test('POST /api/white-label refuses an HTML brand name with a plain 400 and stores nothing', async () => {
  const r = await api('/api/white-label', { brand_name: '<img src=x onerror=alert(1)>' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /< or >/);
  assert.equal(storedName(), undefined, 'no row was created');
});

test('POST /api/white-label saves a good name trimmed, and refuses a bad one over an existing row', async () => {
  assert.equal((await api('/api/white-label', { brand_name: '  Harbour Café Screens  ' })).status, 200);
  assert.equal(storedName(), 'Harbour Café Screens');
  for (const bad of ['x'.repeat(81), 'line\nbreak', null]) {
    assert.equal((await api('/api/white-label', { brand_name: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(storedName(), 'Harbour Café Screens', 'the refused saves changed nothing');
  // Other fields still save without a brand_name.
  assert.equal((await api('/api/white-label', { primary_color: '#112233' })).status, 200);
  assert.equal(storedName(), 'Harbour Café Screens');
});

test('the settings import falls back to the default name instead of storing HTML', async () => {
  const r = await api('/api/status/import', { format: 'screentinker-export-v2', white_label: { brand_name: '<script>alert(1)</script>' } });
  assert.equal(r.status, 200, 'the import itself succeeds');
  assert.equal(storedName(), 'ScreenTinker');
  const ok = await api('/api/status/import', { format: 'screentinker-export-v2', white_label: { brand_name: ' Imported Brand ' } });
  assert.equal(ok.status, 200);
  assert.equal(storedName(), 'Imported Brand');
});
