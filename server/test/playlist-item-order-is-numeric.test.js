'use strict';

/*
 * A PLAYLIST ITEM'S POSITION IS A NUMBER.
 *
 * sort_order is what every player sorts by and what "add to the end" computes from (MAX + 1). The
 * item routes stored whatever the body carried. SQLite keeps a string in an INTEGER column when it
 * does not look like a number, MAX() then returns that string, MAX + 1 is NaN, and the next
 * "add several" fails on the NOT NULL column with a 500, for that playlist, until someone repairs
 * the row by hand.
 *
 * The invariant: a position that is not a finite number is refused and nothing is stored; and
 * adding to a playlist works whatever is already in its rows.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE, token, wsId, userId;
const DATA_DIR = path.join(os.tmpdir(), 'st-itemorder-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

const call = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};

function content(name) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec)
              VALUES (?, ?, ?, ?, ?, 'image/png', 10, 10)`).run(id, userId, wsId, name, name);
  return id;
}

async function playlistWithItem() {
  const pl = await call('POST', '/api/playlists', { name: 'Order ' + crypto.randomBytes(3).toString('hex') });
  assert.equal(pl.status, 201, JSON.stringify(pl.body));
  const item = await call('POST', `/api/playlists/${pl.body.id}/items`, { content_id: content('a.png') });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  const itemId = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').get(pl.body.id).id;
  return { id: pl.body.id, itemId };
}
const orderOf = (itemId) => db.prepare('SELECT sort_order, typeof(sort_order) AS t FROM playlist_items WHERE id = ?').get(itemId);

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ord' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'O' }) })).json();
  token = reg.token; wsId = reg.current_workspace_id; userId = reg.user.id;
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

for (const bad of ['abc', '', true, [3], { a: 1 }, null]) {
  test(`moving an item to position ${JSON.stringify(bad)} is refused and nothing is stored`, async () => {
    const pl = await playlistWithItem();
    const was = orderOf(pl.itemId);
    const r = await call('PUT', `/api/playlists/${pl.id}/items/${pl.itemId}`, { sort_order: bad });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual(orderOf(pl.itemId), was);
  });
}

test('a numeric position is stored as an integer, also when sent as digits in a string', async () => {
  const pl = await playlistWithItem();
  assert.equal((await call('PUT', `/api/playlists/${pl.id}/items/${pl.itemId}`, { sort_order: 7 })).status, 200);
  assert.deepEqual({ ...orderOf(pl.itemId) }, { sort_order: 7, t: 'integer' });
  assert.equal((await call('PUT', `/api/playlists/${pl.id}/items/${pl.itemId}`, { sort_order: '4' })).status, 200);
  assert.deepEqual({ ...orderOf(pl.itemId) }, { sort_order: 4, t: 'integer' });
});

test('adding an item at a position that is not a number is refused', async () => {
  const pl = await playlistWithItem();
  const r = await call('POST', `/api/playlists/${pl.id}/items`, { content_id: content('b.png'), sort_order: 'abc' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM playlist_items WHERE playlist_id = ?').get(pl.id).c, 1);
});

test('a playlist that already holds a non-numeric position still accepts new items, at the end', async () => {
  const pl = await playlistWithItem();
  db.prepare("UPDATE playlist_items SET sort_order = 'abc' WHERE id = ?").run(pl.itemId);   // a row from before this rule
  const bulk = await call('POST', `/api/playlists/${pl.id}/items/bulk`, { content_ids: [content('c.png'), content('d.png')] });
  assert.ok(bulk.status === 200 || bulk.status === 201, 'bulk add: ' + bulk.status + ' ' + JSON.stringify(bulk.body));
  const one = await call('POST', `/api/playlists/${pl.id}/items`, { content_id: content('e.png') });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  const rows = db.prepare("SELECT sort_order, typeof(sort_order) t FROM playlist_items WHERE playlist_id = ? AND id != ?").all(pl.id, pl.itemId);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.t, 'integer', 'every new row has a numeric position');
});
