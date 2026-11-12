'use strict';

/*
 * AN ACTION THAT HAPPENED HAS A ROW, WHATEVER ITS REQUEST BODY LOOKED LIKE.
 *
 * The activity row for a request is written after the response, with a short summary built from
 * a few body fields (name, filename, plan). The summary converted those fields to text with
 * String(), and String() throws on an object whose toString is not a function. The write is in a
 * try/catch, so nothing broke: the action went through and the row was simply never written. Any
 * caller could therefore do something and leave no trace by adding `"name": {"toString": 1}` to
 * a request whose route ignores `name`.
 *
 * The invariant: a mutation that succeeded is in the log, with or without a readable summary.
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
let proc, db, BASE, token, userId;
const DATA_DIR = path.join(os.tmpdir(), 'st-actbody-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

const call = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const logged = async (action) => {
  for (let i = 0; i < 20; i++) {
    const n = db.prepare('SELECT COUNT(*) c FROM activity_log WHERE user_id = ? AND action = ?').get(userId, action).c;
    if (n) return n;
    await sleep(50);
  }
  return 0;
};

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
    body: JSON.stringify({ email: 'act' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'A' }) })).json();
  token = reg.token; userId = reg.user.id;
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

for (const odd of [{ toString: 1 }, { a: 1 }, ['x', 'y'], true, 12345]) {
  test(`a delete that carries name=${JSON.stringify(odd)} is still in the log`, async () => {
    const pl = await call('POST', '/api/playlists', { name: 'To delete' });
    assert.equal(pl.status, 201, JSON.stringify(pl.body));
    db.prepare("DELETE FROM activity_log WHERE action = 'DELETE /api/playlists/:id'").run();
    const del = await call('DELETE', '/api/playlists/' + pl.body.id, { name: odd, filename: odd, plan_id: odd });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(await logged('DELETE /api/playlists/:id'), 1, 'the deletion has its row');
  });
}

test('a readable name is still summarised, and nothing is dropped in the server log', async () => {
  const pl = await call('POST', '/api/playlists', { name: 'Lobby loop' });
  assert.equal(pl.status, 201);
  await sleep(200);
  const row = db.prepare("SELECT details FROM activity_log WHERE user_id = ? AND details LIKE '%Lobby loop%'").get(userId);
  assert.ok(row, 'the summary carries the name');
  assert.doesNotMatch(fs.readFileSync(LOG, 'utf8'), /AUDIT-DROP/);
});
