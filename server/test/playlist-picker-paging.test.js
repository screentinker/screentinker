'use strict';

/*
 * The playlist content picker must see the WHOLE library.
 *
 * ⚠️ THE BUG, as reported: "adding content to the playlist — it won't give me the option to choose
 * uploaded content from a different folder." It was not a folder bug at all. GET /api/content
 * defaults to `LIMIT 100`, and the picker asked for everything without paging, so a workspace with
 * 211 items got the first 100 — newest first, which means the ones MISSING were the oldest, i.e.
 * precisely the ones an operator had already sorted into folders. The customer could see a video
 * in the library and not find it in the picker, and drew the only conclusion available to him.
 *
 * Two halves, and both are asserted here:
 *   - the SERVER still caps a single response (it must; an unbounded list is its own outage), and
 *   - the CLIENT pages until the server stops giving more, rather than trusting one page.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-pick-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, dbFile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const TOTAL = 211;        // the customer's actual library size, kept as the fixture on purpose

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
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `pick${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Pick',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;
  const userId = reg.user && reg.user.id ? reg.user.id : reg.user_id;

  // Two folders and 211 items, inserted directly — this is about the listing, not about upload.
  const Database = require('better-sqlite3');
  dbFile = path.join(DATA_DIR, 'db', 'remote_display.db');
  const raw = new Database(dbFile);
  const folderA = crypto.randomUUID();
  const folderB = crypto.randomUUID();
  for (const [id, name] of [[folderA, 'PILBARA'], [folderB, 'WA CONTENT']]) {
    // content_folders.user_id is NOT NULL with no default.
    raw.prepare('INSERT INTO content_folders (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)')
      .run(id, userId, workspaceId, name);
  }
  const ins = raw.prepare(`INSERT INTO content (id, workspace_id, filename, filepath, mime_type, file_size, folder_id, created_at, is_active)
                           VALUES (?, ?, ?, ?, 'video/mp4', 1024, ?, ?, 1)`);
  for (let i = 0; i < TOTAL; i++) {
    // Oldest first, so the items that a LIMIT 100 + date_desc would DROP are the early ones —
    // exactly the shape of the real library.
    const folder = i < 60 ? folderA : (i < 120 ? folderB : null);
    ins.run(crypto.randomUUID(), workspaceId, `clip-${String(i).padStart(3, '0')}.mp4`,
      `${crypto.randomUUID()}.mp4`, folder, 1700000000 + i);
  }
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const H = () => ({ headers: { Authorization: `Bearer ${jwt}` } });

test('⚠️ one unpaged request returns only 100 of 211 — the bug, reproduced', async () => {
  const one = await (await fetch(`${BASE}/api/content`, H())).json();
  assert.equal(one.length, 100, 'the endpoint caps a single response, and always did');
  assert.ok(TOTAL > one.length, 'so any caller that does not page is working from a truncated list');
});

test('paging to exhaustion returns the whole library', async () => {
  // What api.getAllContent does: page at the server's maximum until a short page arrives.
  const all = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const batch = await (await fetch(`${BASE}/api/content?limit=500&offset=${offset}`, H())).json();
    all.push(...batch);
    if (batch.length < 500) break;
    offset += batch.length;
  }
  assert.equal(all.length, TOTAL);
  const names = new Set(all.map((c) => c.filename));
  assert.equal(names.size, TOTAL, 'no duplicates across pages');
  assert.ok(names.has('clip-000.mp4'), 'the OLDEST item must be reachable — it is the one that went missing');
  assert.ok(names.has('clip-210.mp4'), 'and the newest');
});

test('the items a single page drops are the ones filed in folders', async () => {
  /*
   * This is why the report said "folders". Default sort is date_desc, so one page keeps the 100
   * newest — and in a library built by uploading into folders over time, the older items are the
   * filed ones. The picker looked exactly like a folder filter stuck on the wrong value.
   */
  const one = await (await fetch(`${BASE}/api/content`, H())).json();
  const onPageOne = one.filter((c) => c.folder_id).length;
  // 211 items newest-first: page one reaches back to item 111, so it catches the tail end of the
  // second folder and nothing before it. 9 of 120 filed items visible, 111 gone.
  assert.equal(onPageOne, 9, 'only the newest sliver of filed content survives page one');
  assert.ok(onPageOne / 120 < 0.1, 'over 90% of everything filed in a folder is invisible');

  const all = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const batch = await (await fetch(`${BASE}/api/content?limit=500&offset=${offset}`, H())).json();
    all.push(...batch);
    if (batch.length < 500) break;
    offset += batch.length;
  }
  assert.equal(all.filter((c) => c.folder_id).length, 120, 'paging recovers all 120 filed items');
});

test('the server cap is real and bounded, so paging is required rather than optional', async () => {
  const big = await (await fetch(`${BASE}/api/content?limit=99999`, H())).json();
  assert.ok(big.length <= 500, 'limit is clamped to 500, so no single request can ever return everything');
});

test('the picker calls the paging helper, not the single-page one', () => {
  /*
   * A source-level guard, because the failure is invisible at runtime until someone has more than
   * 100 items — which is exactly why it shipped. If this reverts to api.getContent(), a large
   * library silently loses its oldest half again.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');
  assert.match(src, /api\.getAllContent\(\)/, 'the add-item modal must page through the whole library');
  const modal = src.slice(src.indexOf('async function showAddItemModal'));
  assert.doesNotMatch(modal.slice(0, modal.indexOf('function renderTab')), /api\.getContent\(\)/,
    'a bare api.getContent() in this modal is the bug');
});

test('api.getAllContent reports truncation instead of pretending', () => {
  // A library beyond the ceiling must SAY so. Silently showing a partial list is the whole defect.
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  assert.match(api, /getAllContent/);
  assert.match(api, /truncated:\s*true/, 'the helper must be able to admit it stopped early');
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');
  assert.match(view, /library_truncated/, 'and the picker must render that admission');
});
