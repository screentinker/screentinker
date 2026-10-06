'use strict';

// AUDIT F07 — the #150 settings restore must never carry one tenant's playlist/layout/default
// content/team onto a panel claimed into ANOTHER tenant.
//
// applyToDevice refuses a snapshot from a different workspace — but the automatic restore ran on
// the freshly INSERTed provisioning row, which never has a workspace_id (it only gets one at the
// claim). `s.workspace_id && dev.workspace_id && ...` short-circuited to "apply", workspace A's
// playlist_id/layout_id/default_content_id/team_id landed on the unclaimed row, and the claim
// (/api/provision/pair) never cleared them. device_resolved_playlist falls back to d.playlist_id,
// so tenant B's screen played tenant A's published playlist. The existing unit test seeded the
// device WITH a workspace, so it never saw the real NULL-workspace row.
//
// End-to-end here: real register over a socket, real claim over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, JWT, WS_B, USER_B;
const DATA_DIR = path.join(os.tmpdir(), 'st-f07-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-f07-' + crypto.randomBytes(4).toString('hex') + '.log');
const DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
let proc, tdb;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = () => String(crypto.randomInt(100000, 1000000));

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
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  // Tenant B: the operator who claims the panel.
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b@test.local', password: 'test12345', name: 'B' }) });
  const j = await r.json();
  JWT = j.token; USER_B = j.user && j.user.id;
  tdb = new Database(DB_PATH); tdb.pragma('busy_timeout = 3000'); tdb.pragma('foreign_keys = OFF');
  if (!USER_B) USER_B = tdb.prepare("SELECT id FROM users WHERE email = 'b@test.local'").get().id;
  WS_B = tdb.prepare(`SELECT w.id FROM workspaces w JOIN organizations o ON o.id = w.organization_id
                       WHERE o.owner_user_id = ? LIMIT 1`).get(USER_B).id;
});
after(() => {
  try { tdb && tdb.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

function seedTenantA(tag) {
  const u = 'uA-' + tag, o = 'oA-' + tag, ws = 'wsA-' + tag;
  tdb.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(u, tag + '@a.local');
  tdb.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(o, 'org A ' + tag, u);
  tdb.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, o, 'ws A ' + tag);
  return { u, ws };
}
function seedPlaylist(ws, user, name) {
  const id = 'pl-' + crypto.randomBytes(4).toString('hex');
  tdb.prepare("INSERT INTO playlists (id, name, workspace_id, user_id) VALUES (?, ?, ?, ?)").run(id, name, ws, user);
  return id;
}
function seedLayout(user) {
  const id = 'lay-' + crypto.randomBytes(4).toString('hex');
  tdb.prepare("INSERT INTO layouts (id, user_id, name) VALUES (?, ?, 'L')").run(id, user);
  return id;
}
function seedSnapshot(fp, { ws, playlist, layout = null, team = null, name }) {
  tdb.prepare(`INSERT INTO device_settings (fingerprint, workspace_id, device_name, orientation, playlist_id, layout_id, team_id, blocked, last_seen)
               VALUES (?, ?, ?, 'portrait', ?, ?, ?, 0, strftime('%s','now'))`).run(fp, ws, name, playlist, layout, team);
}
function provision(code, fingerprint) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code, fingerprint }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve(d.device_id); });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(null); }, 4000);
  });
}
async function claim(code, name) {
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, ...(name ? { name } : {}) }) });
  return { status: r.status, body: await r.json() };
}
const row = (id) => tdb.prepare('SELECT * FROM devices WHERE id = ?').get(id);

test('THE LEAK: an unclaimed provisioning row does not receive the previous tenant\'s assignments', async () => {
  const A = seedTenantA('leak1');
  const fp = 'hw-fp-' + crypto.randomBytes(4).toString('hex');
  const plA = seedPlaylist(A.ws, A.u, 'A secret playlist');
  const layA = seedLayout(A.u);
  seedSnapshot(fp, { ws: A.ws, playlist: plA, layout: layA, team: 'team-A', name: 'A Lobby' });

  const id = await provision(rnd(), fp);
  assert.ok(id, 'provisioned');
  const d = row(id);
  assert.equal(d.workspace_id, null, 'a provisioning row has no workspace (precondition)');
  assert.equal(d.playlist_id, null, "workspace A's playlist must not land on a workspace-less row");
  assert.equal(d.layout_id, null);
  assert.equal(d.team_id, null);
});

test('THE LEAK: claiming the panel into tenant B does not hand it tenant A\'s playlist/layout/team', async () => {
  const A = seedTenantA('leak2');
  const fp = 'hw-fp-' + crypto.randomBytes(4).toString('hex');
  const plA = seedPlaylist(A.ws, A.u, 'A secret playlist 2');
  const layA = seedLayout(A.u);
  seedSnapshot(fp, { ws: A.ws, playlist: plA, layout: layA, team: 'team-A2', name: 'A Lobby' });

  const code = rnd();
  const id = await provision(code, fp);
  const c = await claim(code, 'B Screen');
  assert.equal(c.status, 200);
  const d = row(id);
  assert.equal(d.workspace_id, WS_B);
  assert.equal(d.playlist_id, null, "tenant B's screen must not play tenant A's playlist");
  assert.equal(d.layout_id, null);
  assert.equal(d.team_id, null);
  assert.equal(d.name, 'B Screen', "A's name does not follow the hardware either");
  assert.notEqual(d.orientation, 'portrait', "nothing from A's snapshot applies");
});

test('THE POINT OF #150: a panel re-paired into its OWN workspace still comes back configured', async () => {
  const fp = 'hw-fp-' + crypto.randomBytes(4).toString('hex');
  const plB = seedPlaylist(WS_B, USER_B, 'B playlist');
  seedSnapshot(fp, { ws: WS_B, playlist: plB, name: 'B Lobby' });

  const code = rnd();
  const id = await provision(code, fp);
  assert.equal(row(id).playlist_id, null, 'nothing applied before the claim');
  const c = await claim(code);   // no explicit name -> the restored one beats "Display N"
  assert.equal(c.status, 200);
  const d = row(id);
  assert.equal(d.playlist_id, plB, 'its own playlist is restored at the claim');
  assert.equal(d.orientation, 'portrait', 'and its orientation');
  assert.equal(d.name, 'B Lobby', 'and its saved name, since the operator typed none');
});

test('an operator-typed name at the claim beats the restored one', async () => {
  const fp = 'hw-fp-' + crypto.randomBytes(4).toString('hex');
  const plB = seedPlaylist(WS_B, USER_B, 'B playlist 2');
  seedSnapshot(fp, { ws: WS_B, playlist: plB, name: 'Old Name' });
  const code = rnd();
  const id = await provision(code, fp);
  assert.equal((await claim(code, 'New Name')).status, 200);
  const d = row(id);
  assert.equal(d.name, 'New Name');
  assert.equal(d.playlist_id, plB);
});
