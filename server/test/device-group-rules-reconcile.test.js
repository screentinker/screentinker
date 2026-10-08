'use strict';

// The parts of dynamic groups that no HTTP route shows directly:
//   - who gets re-pushed when membership changes (a SYNC group's remaining peers too)
//   - the system reconcile run by pairing / leaving a wall / a workspace move, and the sweep
//   - the #150 delete+re-pair snapshot carrying tags, so a re-paired screen rejoins its groups
//   - mesh replication's devices UPDATE trigger picking up a column added after it was installed

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dgrr-'));
const { db } = require('../db/database');
const R = require('../lib/device-group-rules');

const U = 'u-dgrr', O = 'o-dgrr', WS = 'ws-dgrr';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?,'x','user')").run(U, 'dgrr@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
const dev = (id, tags) => db.prepare(`INSERT INTO devices (id,name,workspace_id,user_id,tags,created_at,updated_at)
  VALUES (?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(id, id, WS, U, JSON.stringify(tags));
const group = (id, rules, sync = 0) => {
  db.prepare('INSERT INTO device_groups (id,name,user_id,workspace_id,rules,sync_enabled) VALUES (?,?,?,?,?,?)')
    .run(id, id, U, WS, rules ? JSON.stringify(rules) : null, sync);
  return db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id);
};
const members = (g) => db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(g).map((r) => r.device_id).sort();
const tag = (v) => ({ match: 'all', rules: [{ field: 'tag', op: 'has', value: v }] });

test('a change to a SYNC group re-pushes its remaining peers, not just the screen that moved', () => {
  dev('s1', ['sync']); dev('s2', ['sync']); dev('s3', []);
  const g = group('g-sync', tag('sync'), 1);
  R.applyOps(db, R.groupOps(g, R.planGroup(db, g)));
  assert.deepEqual(members('g-sync'), ['s1', 's2']);

  db.prepare('UPDATE devices SET tags = ? WHERE id = ?').run('["sync"]', 's3');
  const ops = R.planDevice(db, 's3');
  assert.deepEqual(ops.map((o) => [o.group.id, o.op]), [['g-sync', 'add']]);
  R.applyOps(db, ops);
  assert.deepEqual(R.devicesToPush(db, ops).sort(), ['s1', 's2', 's3'], 'peers carry the new member in their sync payload');

  const plain = group('g-plain', tag('sync'), 0);
  const ops2 = R.groupOps(plain, R.planGroup(db, plain));
  R.applyOps(db, ops2);
  assert.deepEqual(R.devicesToPush(db, ops2).sort(), ['s1', 's2', 's3'], 'every moved screen, and only those, for a plain group');
});

test('a leader that leaves a sync group stops being its pinned leader', () => {
  db.prepare('UPDATE device_groups SET leader_device_id = ? WHERE id = ?').run('s1', 'g-sync');
  db.prepare('UPDATE devices SET tags = ? WHERE id = ?').run('[]', 's1');
  R.applyOps(db, R.planDevice(db, 's1'));
  assert.equal(db.prepare('SELECT leader_device_id FROM device_groups WHERE id = ?').get('g-sync').leader_device_id, null);
});

test('the system reconcile: a screen leaving a wall joins its groups; the sweep catches a direct edit', () => {
  dev('w1', ['lobby']);
  const g = group('g-lobby', tag('lobby'));
  db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows) VALUES ('wall-r', ?, ?, 'W', 1, 1)").run(U, WS);
  db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('wall-r', 'w1', 0, 0)").run();
  assert.deepEqual(R.reconcileDeviceAsSystem(db, null, 'w1'), [], 'on a wall: no group');
  assert.deepEqual(members(g.id), []);

  db.prepare("DELETE FROM video_wall_devices WHERE device_id = 'w1'").run();
  assert.equal(R.reconcileDeviceAsSystem(db, null, 'w1').length, 1);
  assert.deepEqual(members(g.id), ['w1']);

  // A path that skips the reconcile (an import, a mesh sync, a hand fix-up): the sweep repairs it.
  db.prepare("UPDATE devices SET tags = '[]' WHERE id = 'w1'").run();
  assert.ok(R.sweep(db, null) >= 1);
  assert.deepEqual(members(g.id), []);
  assert.equal(R.sweep(db, null), 0, 'a second sweep finds nothing to change');
});

test('#150: tags survive delete + re-pair, so the screen rejoins its dynamic groups', () => {
  const settings = require('../lib/device-settings');
  dev('rp1', ['window']);
  db.prepare("INSERT INTO device_fingerprints (fingerprint, device_id, last_seen) VALUES ('fp-rp1', 'rp1', strftime('%s','now'))").run();
  assert.equal(settings.snapshot('rp1'), 'fp-rp1');
  db.prepare("DELETE FROM devices WHERE id = 'rp1'").run();

  dev('rp2', []);
  settings.applyToDevice('rp2', 'fp-rp1');
  assert.equal(db.prepare("SELECT tags FROM devices WHERE id = 'rp2'").get().tags, '["window"]');
});

test('mesh: the devices UPDATE trigger is rebuilt when the table has grown a column', () => {
  const repl = require('../lib/mesh/replication');
  repl.ensureTriggers(db, { wanted: true });
  const sqlOf = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'mesh_cl_devices_upd'").get().sql;
  assert.match(sqlOf(), /\btags\b/, 'a fresh install already lists devices.tags');

  // Simulate an install that predates a column: rebuild the trigger without it, then add one more.
  db.exec('DROP TRIGGER mesh_cl_devices_upd');
  db.exec('ALTER TABLE devices ADD COLUMN zz_later_col TEXT');
  db.exec(repl.triggerSql(db, repl.TABLES.find((t) => t.table === 'devices'))[1].replace(/, zz_later_col/, ''));
  assert.doesNotMatch(sqlOf(), /zz_later_col/);

  const r = repl.ensureTriggers(db, { wanted: true });
  assert.equal(r.action, 'refreshed');
  assert.match(sqlOf(), /zz_later_col/, 'edits to the new column reach the change log now');
  assert.equal(repl.ensureTriggers(db, { wanted: true }).action, 'kept', 'and it is not rebuilt again');
});
