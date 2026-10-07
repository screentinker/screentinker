'use strict';

/*
 * Wall schedules: a schedule can target a video wall, and a wall panel follows ONLY its wall's
 * schedules, on the wall's one clock — so a scheduled change switches every panel together instead
 * of tearing the picture. Pins the table rebuild (an old database keeps every row, index and
 * trigger), the widened CHECK, the scheduler rule and the payload's scheduled wall layout.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-wallsched-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const { db, _migrateWallSchedules } = require('../db/database');
const { evaluateSchedules } = require('../services/scheduler');

const id = () => crypto.randomUUID();
const fakeIo = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) };

// ------------------------------------------------------------------ the rebuild

const OLD = `CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    device_id       TEXT,
    group_id        TEXT,
    playlist_id     TEXT,
    title           TEXT NOT NULL DEFAULT '',
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    priority        INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
)`;

function oldDb() {
  const d = new Database(':memory:');
  d.exec("CREATE TABLE video_walls (id TEXT PRIMARY KEY); INSERT INTO video_walls VALUES ('w'), ('w1');");   // every real database has it
  d.exec(OLD);
  d.exec('ALTER TABLE schedules ADD COLUMN workspace_id TEXT');   // a column added after phase 4
  d.exec('CREATE INDEX idx_schedules_device ON schedules(device_id, enabled)');
  d.exec('CREATE TABLE log (n INTEGER)');
  d.exec('CREATE TRIGGER sched_ins AFTER INSERT ON schedules BEGIN INSERT INTO log VALUES (1); END');
  d.prepare("INSERT INTO schedules (id, user_id, device_id, start_time, end_time, workspace_id) VALUES ('s1','u','d1','a','b','ws')").run();
  d.prepare("INSERT INTO schedules (id, user_id, group_id, start_time, end_time, workspace_id, priority) VALUES ('s2','u','g1','a','b','ws',7)").run();
  return d;
}

test('an old schedules table is rebuilt with wall_id, keeping every row and column', () => {
  const d = oldDb();
  _migrateWallSchedules(d);
  const cols = d.prepare('PRAGMA table_info(schedules)').all().map((c) => c.name);
  assert.ok(cols.includes('wall_id'));
  assert.ok(cols.includes('workspace_id'), 'a column added after phase 4 survives');
  const rows = d.prepare('SELECT id, device_id, group_id, workspace_id, priority FROM schedules ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 's1', device_id: 'd1', group_id: null, workspace_id: 'ws', priority: 0 },
    { id: 's2', device_id: null, group_id: 'g1', workspace_id: 'ws', priority: 7 },
  ]);
});

test('…its indexes and triggers come back, and a wall index is added', () => {
  const d = oldDb();
  _migrateWallSchedules(d);
  const objs = d.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'schedules' AND type IN ('index','trigger') AND sql IS NOT NULL").all().map((o) => o.name).sort();
  assert.deepEqual(objs, ['idx_schedules_device', 'idx_schedules_wall', 'sched_ins']);
  const before = d.prepare('SELECT COUNT(*) n FROM log').get().n;   // the fixture's own two inserts
  d.prepare("INSERT INTO schedules (id, user_id, wall_id, start_time, end_time) VALUES ('s3','u','w1','a','b')").run();
  assert.equal(d.prepare('SELECT COUNT(*) n FROM log').get().n, before + 1, 'the trigger still fires');
  assert.equal(before, 2, 'and the copy did not fire it (the rows were moved, not re-inserted through it)');
});

test('the new CHECK: exactly one of device, group, wall', () => {
  const d = oldDb();
  _migrateWallSchedules(d);
  const ins = (cols, vals) => d.prepare(`INSERT INTO schedules (id, user_id, start_time, end_time${cols}) VALUES ('${id()}','u','a','b'${vals})`).run();
  ins(', wall_id', ", 'w'");
  assert.throws(() => ins(', wall_id, device_id', ", 'w', 'd'"), /CHECK/);
  assert.throws(() => ins(', wall_id, group_id', ", 'w', 'g'"), /CHECK/);
  assert.throws(() => ins('', ''), /CHECK/);
});

test('it runs once: a second pass is a no-op', () => {
  const d = oldDb();
  _migrateWallSchedules(d);
  const sql = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get().sql;
  _migrateWallSchedules(d);
  assert.equal(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get().sql, sql);
});

test('a table it does not recognise is left exactly as it is', () => {
  const d = new Database(':memory:');
  d.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, device_id TEXT, CHECK (device_id IS NOT NULL))");
  const before = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get().sql;
  _migrateWallSchedules(d);
  assert.equal(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'schedules'").get().sql, before);
});

test('a fresh install already has wall_id (schema.sql) and the wall index', () => {
  assert.ok(db.prepare('PRAGMA table_info(schedules)').all().some((c) => c.name === 'wall_id'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_schedules_wall'").get());
});

// ------------------------------------------------------------------ the scheduler

let userId, wallId, own, sched, panelSched, layoutId;
const A = id(), B = id(), SOLO = id();
const window = () => {
  const d0 = new Date(Date.now() - 86400000).toISOString().slice(0, 10), d1 = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return [`${d0}T00:00`, `${d1}T23:59`];
};

before(() => {
  db.pragma('foreign_keys = OFF');   // the wall names its leader before the panel rows exist
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(userId, `ws-${userId}@example.com`, 'W', 'x');
  own = id(); sched = id(); panelSched = id(); layoutId = id(); wallId = id();
  for (const p of [own, sched, panelSched]) db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)').run(p, userId, p.slice(0, 4));
  db.prepare("INSERT INTO video_walls (id, user_id, name, leader_device_id, playlist_id) VALUES (?, ?, 'W', ?, ?)").run(wallId, userId, A, own);
  // Two panels that report DIFFERENT zones: the wall must still switch on one clock.
  for (const [dev, tz, x] of [[A, 'Europe/Amsterdam', 0], [B, 'America/New_York', 1920]]) {
    db.prepare(`INSERT INTO devices (id, user_id, name, pairing_code, status, wall_id, reported_timezone) VALUES (?, ?, ?, ?, 'online', ?, ?)`)
      .run(dev, userId, dev.slice(0, 4), dev.slice(0, 6), wallId, tz);
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row, canvas_x, canvas_y, canvas_width, canvas_height) VALUES (?, ?, ?, 0, ?, 0, 1920, 1080)')
      .run(wallId, dev, x, x);
  }
  db.prepare(`INSERT INTO devices (id, user_id, name, pairing_code, status, playlist_id, timezone) VALUES (?, ?, 'solo', ?, 'online', ?, 'UTC')`).run(SOLO, userId, SOLO.slice(0, 6), own);
  db.pragma('foreign_keys = ON');
});

const schedRow = (target, playlist, extra = {}) => {
  const [s, e] = window();
  const cols = { id: id(), user_id: userId, title: 't', start_time: s, end_time: e, timezone: 'UTC', enabled: 1, playlist_id: playlist, ...target, ...extra };
  db.prepare(`INSERT INTO schedules (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`).run(...Object.values(cols));
  return cols.id;
};
const scheduledOf = (dev) => db.prepare('SELECT scheduled_playlist_id p, scheduled_layout_id l FROM devices WHERE id = ?').get(dev);

test('a wall schedule switches EVERY panel, whatever zone each reports', () => {
  db.prepare('DELETE FROM schedules').run();
  schedRow({ wall_id: wallId }, sched);
  evaluateSchedules(fakeIo);
  assert.equal(scheduledOf(A).p, sched);
  assert.equal(scheduledOf(B).p, sched);
  assert.equal(scheduledOf(SOLO).p, null, 'a screen outside the wall is untouched');
});

test('a schedule written on ONE panel no longer switches it alone (it would tear the wall)', () => {
  db.prepare('DELETE FROM schedules').run();
  schedRow({ device_id: B }, panelSched);
  evaluateSchedules(fakeIo);
  assert.equal(scheduledOf(B).p, null);
  assert.equal(scheduledOf(A).p, null);
});

test('when the wall schedule ends, every panel goes back together', () => {
  db.prepare('DELETE FROM schedules').run();
  schedRow({ wall_id: wallId }, sched);
  evaluateSchedules(fakeIo);
  db.prepare('UPDATE schedules SET enabled = 0').run();
  evaluateSchedules(fakeIo);
  assert.equal(scheduledOf(A).p, null);
  assert.equal(scheduledOf(B).p, null);
});

// ------------------------------------------------------------------ the payload

let httpServer, io;
after(() => { try { io && io.close(); } catch { /* */ } try { httpServer && httpServer.close(); } catch { /* */ } });

test('a wall schedule\'s layout becomes the WALL\'s layout on every panel while it runs', async () => {
  httpServer = http.createServer(); io = new Server(httpServer);
  const setup = require('../ws/deviceSocket'); setup(io);
  await new Promise((r) => httpServer.listen(0, r));
  db.prepare("INSERT INTO layouts (id, name, width, height) VALUES (?, 'sched', 3840, 1080)").run(layoutId);
  db.prepare("INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES (?, ?, 'L', 0, 0, 50, 100, 0), (?, ?, 'R', 50, 0, 50, 100, 1)")
    .run(id(), layoutId, id(), layoutId);
  db.prepare('DELETE FROM schedules').run();
  schedRow({ wall_id: wallId }, sched, { layout_id: layoutId });
  evaluateSchedules(io);
  for (const dev of [A, B]) {
    const p = setup.buildPlaylistPayload(dev);
    assert.equal(p.layout && p.layout.id, layoutId, dev);
    assert.equal(p.wall_config.canvas_layout, true, dev);
  }
});
