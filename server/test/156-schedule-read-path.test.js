'use strict';

// #156 — playlist item schedule saved but not shown in editor.
//
// GET /playlists/:id (the editor's load path) built its `items` array but never
// attached schedules, so the Web UI rendered "always plays" for items that DO
// have a live schedule. Worse: the editor's unchanged-save then re-PUTs whatever
// it loaded, and PUT /schedules is a wholesale DELETE+INSERT — so loading an
// item as "no schedule" and saving silently WIPED the real schedule.
//
// The fix mirrors GET /:id/items (playlists.js:351): attach schedulesForItem()
// to each item in GET /:id. These three tests exercise the read path, the write
// round-trip, and the wipe-trap regression via the REAL editor load->save flow.
//
// Harness matches api.test.js: boot the real server.js against an isolated DB and
// drive it over HTTP with a JWT. Node built-ins + better-sqlite3 (dep) only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT; // avoid clashes with sibling subprocess suites
let BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-156-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-156-test-' + crypto.randomBytes(4).toString('hex') + '.log');

let proc;
const S = {}; // shared fixtures

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = () => ({ headers: { Authorization: 'Bearer ' + S.jwt, 'Content-Type': 'application/json' } });
const post = (obj) => ({ method: 'POST', ...auth(), body: JSON.stringify(obj) });
const put = (obj) => ({ method: 'PUT', ...auth(), body: JSON.stringify(obj) });

// --- fixture helpers ---------------------------------------------------------
async function addItem() {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post({ widget_id: S.widgetId }));
  assert.equal(r.status, 201, 'add item should 201: ' + JSON.stringify(r.body));
  return r.body.id;
}
async function putSchedules(itemId, blocks) {
  return jfetch(`/api/playlists/${S.playlistId}/items/${itemId}/schedules`, put({ blocks }));
}
async function loadItem(itemId) {
  // The editor's read path: GET /:id then read the item out of .items.
  const r = await jfetch(`/api/playlists/${S.playlistId}`, auth());
  assert.equal(r.status, 200, 'GET /:id should 200');
  const it = r.body.items.find(i => i.id === itemId);
  assert.ok(it, 'item should be present in GET /:id payload');
  return it;
}

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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // first user -> platform_admin + a workspace; its JWT authorizes the editor routes.
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'u156@test.local', password: 'test12345', name: 'U156' }),
  });
  S.jwt = reg.body.token;

  S.widgetId = (await jfetch('/api/widgets', post({ name: 'W156', widget_type: 'clock', config: {} }))).body.id;
  S.playlistId = (await jfetch('/api/playlists', post({ name: 'PL156' }))).body.id;
  S.dbPath = path.join(DATA_DIR, 'db', 'remote_display.db');
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

// A schedule block as emitted by schedulesForItem() (playlists.js:121) and consumed
// by the editor (frontend/js/views/playlists.js:749) — the shape both sides agree on.
function assertBlockShape(b) {
  assert.ok(b && typeof b === 'object', 'block is an object');
  assert.ok(Array.isArray(b.days), 'block.days is an array');
  assert.equal(typeof b.start, 'string', 'block.start is a string');
  assert.equal(typeof b.end, 'string', 'block.end is a string');
  assert.ok('start_date' in b, 'block has start_date');
  assert.ok('end_date' in b, 'block has end_date');
}

// 1. RENDER — a schedule written directly to the table must surface on GET /:id
//    (the read-path wiring), not come back undefined/[] as "always plays".
test('GET /:id attaches schedules to each item (render path)', async () => {
  const itemId = await addItem();

  // Write a schedule straight to the table (a second WAL connection; the server sees it),
  // proving the READ path independent of the write route.
  const sdb = new (require('better-sqlite3'))(S.dbPath, { timeout: 5000 });
  sdb.prepare(
    'INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)'
  ).run(crypto.randomUUID(), itemId, '1,2,3', '09:00', '17:00', null, null, 0);
  sdb.close();

  const it = await loadItem(itemId);
  assert.ok(Array.isArray(it.schedules), 'item.schedules present (not undefined)');
  assert.equal(it.schedules.length, 1, 'item.schedules non-empty');
  assertBlockShape(it.schedules[0]);
  assert.deepEqual(it.schedules[0].days, [1, 2, 3], 'days decoded from active_days');
  assert.equal(it.schedules[0].start, '09:00');
  assert.equal(it.schedules[0].end, '17:00');
  assert.equal(it.schedules[0].start_date, null);
  assert.equal(it.schedules[0].end_date, null);
});

// 2. ROUND-TRIP — the editor's write path (PUT .../schedules) must reflect create,
//    edit, and delete when read back through GET /:id.
test('schedule create/edit/delete round-trips through the editor read path', async () => {
  const itemId = await addItem();

  // create
  let r = await putSchedules(itemId, [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', start_date: null, end_date: null }]);
  assert.equal(r.status, 200, 'create PUT 200: ' + JSON.stringify(r.body));
  let it = await loadItem(itemId);
  assert.equal(it.schedules.length, 1);
  assert.deepEqual(it.schedules[0].days, [1, 2, 3, 4, 5]);
  assert.equal(it.schedules[0].start, '08:00');
  assert.equal(it.schedules[0].end, '18:00');

  // edit
  r = await putSchedules(itemId, [{ days: [6], start: '10:00', end: '12:00', start_date: '2026-01-01', end_date: '2026-12-31' }]);
  assert.equal(r.status, 200, 'edit PUT 200');
  it = await loadItem(itemId);
  assert.equal(it.schedules.length, 1);
  assert.deepEqual(it.schedules[0].days, [6]);
  assert.equal(it.schedules[0].start, '10:00');
  assert.equal(it.schedules[0].end, '12:00');
  assert.equal(it.schedules[0].start_date, '2026-01-01');
  assert.equal(it.schedules[0].end_date, '2026-12-31');

  // delete ([] = no schedule = always plays)
  r = await putSchedules(itemId, []);
  assert.equal(r.status, 200, 'delete PUT 200');
  it = await loadItem(itemId);
  assert.deepEqual(it.schedules, [], 'schedules cleared -> empty array');
});

// 3. WIPE-TRAP GUARD (the one that matters) — simulate the editor's load -> unchanged
//    save. The editor seeds its blocks from item.schedules (frontend:749) and doSave()
//    re-PUTs exactly those (frontend:828-831). If the load returns no schedules (the
//    bug), the unchanged save PUTs [] and the DELETE+INSERT wipes the live schedule.
//    With the fix, the load returns the blocks, the re-PUT re-inserts them, survives.
test('unchanged editor save does NOT wipe an existing schedule', async () => {
  const itemId = await addItem();

  // item starts WITH a schedule
  await putSchedules(itemId, [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00', start_date: null, end_date: null }]);

  // --- editor LOAD (frontend/js/views/playlists.js:749) ---
  const it = await loadItem(itemId);
  const seeded = (it.schedules || []).map(b => ({
    days: Array.isArray(b.days) ? [...b.days] : [],
    start: b.start || '00:00',
    end: b.end || '24:00',
    start_date: b.start_date || '',
    end_date: b.end_date || '',
  }));

  // --- editor SAVE with no changes (doSave, frontend:828-831) ---
  const payload = seeded.map(b => ({
    days: b.days, start: b.start, end: b.end,
    start_date: b.start_date || null, end_date: b.end_date || null,
  }));
  const r = await putSchedules(itemId, payload);
  assert.equal(r.status, 200, 'unchanged save PUT 200: ' + JSON.stringify(r.body));

  // schedule must STILL exist (pre-fix: seeded === [] -> payload [] -> wiped -> fails here)
  const after = await loadItem(itemId);
  assert.equal(after.schedules.length, 1, 'schedule survived the unchanged save (no silent wipe)');
  assert.deepEqual(after.schedules[0].days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(after.schedules[0].start, '00:00');
  assert.equal(after.schedules[0].end, '24:00');
});
