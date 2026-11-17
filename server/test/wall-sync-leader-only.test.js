'use strict';

/*
 * ONLY A WALL'S LEADER MAY SYNC IT (advisory 3.7).
 *
 * wall:sync was relayed from ANY member of the wall: a panel whose device token leaked could
 * broadcast its own index and position and every follower jumped to it. The server now relays a
 * wall:sync only from the wall's leader_device_id. And wall_config carries leader_device_id, so a
 * follower can check the server-stamped sender itself (additive: is_leader stays).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE, owner;
const DATA_DIR = path.join(os.tmpdir(), 'st-wallsync-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

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
    body: JSON.stringify({ email: 'wall' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'W' }) })).json();
  owner = { userId: reg.user.id, wsId: reg.current_workspace_id };
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function panel(wallId, col, row) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, wall_id, created_at)
              VALUES (?, ?, 'offline', ?, ?, ?, 'apk', ?, strftime('%s','now'))`)
    .run(id, `tile ${col},${row}`, owner.wsId, owner.userId, token, wallId);
  db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, ?, ?)').run(wallId, id, col, row);
  return { id, token, syncs: [], configs: [] };
}

function connect(p) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('wall:sync', (d) => p.syncs.push(d));
    s.on('device:playlist-update', (d) => { if (d && d.wall_config) p.configs.push(d.wall_config); });
    s.on('connect', () => s.emit('device:register', { device_id: p.id, device_token: p.token, device_info: { app_version: 'test' } }));
    s.on('device:registered', () => { p.s = s; resolve(p); });
    s.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 8000);
  });
}

test('a non-leader member cannot sync the wall; the leader still can, and wall_config names it', async () => {
  const wallId = crypto.randomUUID();
  db.prepare("INSERT INTO video_walls (id, user_id, name, grid_cols, grid_rows, workspace_id) VALUES (?, ?, 'W', 2, 2, ?)")
    .run(wallId, owner.userId, owner.wsId);
  const tiles = [panel(wallId, 0, 0), panel(wallId, 1, 0), panel(wallId, 0, 1)];
  try {
    for (const t of tiles) await connect(t);
    await sleep(500);   // leadership settles on the top-left online tile; members are re-pushed
    const leaderId = db.prepare('SELECT leader_device_id FROM video_walls WHERE id = ?').get(wallId).leader_device_id;
    assert.ok(leaderId, 'the wall has a leader');
    const leader = tiles.find((t) => t.id === leaderId);
    const others = tiles.filter((t) => t !== leader);

    for (const t of tiles) {
      const cfg = t.configs[t.configs.length - 1];
      assert.ok(cfg, `${t.id} got a wall_config`);
      assert.equal(cfg.leader_device_id, leaderId, 'wall_config names the leader');
      assert.equal(cfg.is_leader, t === leader, 'and is_leader is still there');
    }

    // A follower tries to drive the wall.
    others[0].s.emit('wall:sync', { wall_id: wallId, index: 7, position: 99 });
    await sleep(400);
    for (const t of tiles) assert.equal(t.syncs.length, 0, 'a sync from a non-leader is not relayed');

    // The leader drives it.
    leader.s.emit('wall:sync', { wall_id: wallId, index: 1, position: 2 });
    for (let i = 0; i < 30 && !others.every((t) => t.syncs.length); i++) await sleep(100);
    for (const t of others) {
      assert.equal(t.syncs.length, 1, 'the leader\'s sync reaches every follower');
      assert.equal(t.syncs[0].device_id, leaderId, 'stamped with the leader\'s id');
    }
    assert.equal(leader.syncs.length, 0, 'not echoed to the leader');
  } finally {
    for (const t of tiles) { try { t.s && t.s.close(); } catch { /* */ } }
  }
});
