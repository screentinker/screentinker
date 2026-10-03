'use strict';

/*
 * #318: adding many content items to a playlist in one request.
 *
 * Somebody uploaded ~160 party photos and then had to add them to a playlist one at a time, because
 * POST /:id/items takes a single item. That is the #317 wall one screen further along.
 *
 * The behaviour worth pinning is PARTIAL SUCCESS. Refusing 160 photos because one of them expired
 * last week is an obstacle, not a safety property — but silently dropping it would be worse, since
 * the published snapshot filters expired content and the operator would get a shorter playlist than
 * they asked for with nothing saying so. Valid rows go in, refused ones come back itemised.
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
let PORT, BASE, jwt, db, playlistId;
const DATA_DIR = path.join(os.tmpdir(), 'st-bulk-' + crypto.randomBytes(4).toString('hex'));
let proc;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const jpost = (o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

async function upload(n) {
  const fd = new FormData();
  for (let i = 0; i < n; i++) fd.append('files', new Blob([PNG], { type: 'image/png' }), `p-${crypto.randomBytes(3).toString('hex')}-${i}.png`);
  const r = await fetch(BASE + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: fd });
  assert.equal(r.status, 201, 'seed upload succeeded');
  const body = await r.json();
  return (Array.isArray(body) ? body : [body]).map((c) => c.id);
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-bulk.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const email = 'b' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
  playlistId = (await (await fetch(BASE + '/api/playlists', jpost({ name: 'party' }))).json()).id;
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('#318: many items go in with one request, in the order given', async () => {
  const ids = await upload(30);
  const r = await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: ids }));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.added.length, 30, 'all thirty added in one call');
  assert.equal(body.skipped.length, 0);
  // The order asked for is the order stored — otherwise sorting the picker is pointless.
  const stored = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC').all(playlistId).map(r2 => r2.content_id);
  assert.deepEqual(stored, ids, 'sort_order follows the submitted order');
});

test('#318: a bad id is skipped and itemised, the rest still go in', async () => {
  const ids = await upload(3);
  const withGhost = [ids[0], 'no-such-content-id', ids[1], ids[2]];
  const r = await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: withGhost }));
  assert.equal(r.status, 201, 'one bad id does not fail the batch');
  const body = await r.json();
  assert.equal(body.added.length, 3);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].content_id, 'no-such-content-id');
  assert.match(body.skipped[0].reason, /not found/i);
});

test('#318: expired content is refused, because publishing would silently drop it', async () => {
  const [ok, dead] = await upload(2);
  db.prepare('UPDATE content SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, dead);
  const r = await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: [ok, dead] }));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.added.length, 1);
  assert.deepEqual(body.skipped.map(s => s.reason), ['expired']);
});

test('#318: deactivated content is refused for the same reason', async () => {
  const [ok, off] = await upload(2);
  db.prepare('UPDATE content SET is_active = 0 WHERE id = ?').run(off);
  const body = await (await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: [ok, off] }))).json();
  assert.equal(body.added.length, 1);
  assert.deepEqual(body.skipped.map(s => s.reason), ['deactivated']);
});

test('#318: nothing addable is a 400, not a misleading 201', async () => {
  const r = await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: ['ghost-a', 'ghost-b'] }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.added.length, 0);
  assert.equal(body.skipped.length, 2);
});

test('#318: the request shape is validated', async () => {
  assert.equal((await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({}))).status, 400);
  assert.equal((await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: [] }))).status, 400);
  const tooMany = await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: new Array(501).fill('x') }));
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /too many/i);
});

test('#318: adding marks the playlist a draft, as a single add does', async () => {
  const ids = await upload(2);
  db.prepare("UPDATE playlists SET status = 'published' WHERE id = ?").run(playlistId);
  await fetch(BASE + `/api/playlists/${playlistId}/items/bulk`, jpost({ content_ids: ids }));
  const row = db.prepare('SELECT status FROM playlists WHERE id = ?').get(playlistId);
  assert.notEqual(row.status, 'published', 'items changed since publish -> draft');
});

test('#319: the dashboard sorts a whole playlist through the existing reorder route', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');
  assert.match(view, /playlistSortApply/, 'there is an apply-order control');
  assert.match(view, /api\.reorderPlaylistItems\(currentPlaylistId, order\)/,
    'sorting reuses the reorder endpoint rather than inventing a stored sort rule');
  const at = view.indexOf("playlistSortApply')?.addEventListener");
  const fn = view.slice(at, at + 2600);
  assert.match(fn, /const sortable = \(i\) => !!i\.content_id;/,
    'widgets and nested playlists have no filename or duration, so they are not fed to the comparator');
});
