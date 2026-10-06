'use strict';

// Per-device settings are saved against the hardware FINGERPRINT so a panel that is deleted and
// paired again comes back configured — its name, orientation, playlist and blocked flag restored
// without anyone visiting it. That is deliberate and useful.
//
// A fingerprint is hardware-derived, so the same physical panel presents the same one no matter
// whose account it is paired into. applyToDevice looked the snapshot up on fingerprint alone with
// no workspace comparison, and its per-field guards only check that the referenced row still
// EXISTS, never who it belongs to:
//
//     if (s.playlist_id && db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(s.playlist_id))
//
// So a screen removed from one workspace and paired into another inherited the first workspace's
// playlist and started displaying its content. `blocked` crossed the same way, giving a device that
// arrives blocked for no reason the new owner can see. The manual restore route already compares
// workspaces before calling this, so the automatic re-pair path was the one place it was missing.
//
// The invariant: a saved snapshot only ever applies inside the workspace it was taken in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ws-confine-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const deviceSettings = require('../lib/device-settings');

function seedWorkspace(tag) {
  const u = 'u-' + tag, o = 'o-' + tag, ws = 'ws-' + tag, pl = 'pl-' + tag;
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash) VALUES (?,?, 'x')").run(u, tag + '@t.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(o, 'org ' + tag, u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(ws, o, 'ws ' + tag);
  db.prepare('INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES (?,?,?,?)').run(pl, 'PL ' + tag, ws, u);
  return { u, ws, pl };
}

const A = seedWorkspace('alpha');
const B = seedWorkspace('bravo');
const FP = 'hardware-fingerprint-shared';

function makeDevice(id, ws) {
  db.prepare(`INSERT OR REPLACE INTO devices (id,name,workspace_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(id, 'Screen', ws);
  return id;
}
const deviceRow = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

// The panel lived in workspace A: named, assigned A's playlist, and blocked there.
db.prepare(`INSERT OR REPLACE INTO device_settings (fingerprint, workspace_id, device_name, playlist_id, blocked, last_seen)
            VALUES (?,?, 'Lobby Screen', ?, 1, strftime('%s','now'))`).run(FP, A.ws, A.pl);

test('THE LEAK: a panel paired into another workspace does not inherit the first ones playlist', () => {
  const dev = makeDevice('dev-in-B', B.ws);
  deviceSettings.applyToDevice(dev, FP);
  const d = deviceRow(dev);
  assert.equal(d.playlist_id, null, "workspace B's screen must not be playing workspace A's content");
  assert.equal(d.workspace_id, B.ws, 'and it must stay in its own workspace');
});

test('a block from another workspace does not follow the hardware either', () => {
  const dev = makeDevice('dev-block-B', B.ws);
  deviceSettings.applyToDevice(dev, FP);
  assert.equal(deviceRow(dev).blocked, 0, 'arriving blocked with nothing to explain it is unactionable');
});

test('a mismatch is a quiet no-op, because re-pairing a second-hand panel is legitimate', () => {
  // It must not throw or refuse the pairing — only decline to carry the old configuration.
  const dev = makeDevice('dev-noop-B', B.ws);
  assert.doesNotThrow(() => deviceSettings.applyToDevice(dev, FP));
  assert.equal(deviceRow(dev).name, 'Screen', 'the name from the other workspace must not be applied');
});

test('AND THE POINT OF THE FEATURE: restore still works inside the owning workspace', () => {
  // The whole reason this exists — a panel re-paired at home comes back configured.
  const dev = makeDevice('dev-in-A', A.ws);
  deviceSettings.applyToDevice(dev, FP);
  const d = deviceRow(dev);
  assert.equal(d.playlist_id, A.pl, 'its own playlist must be restored');
  assert.equal(d.name, 'Lobby Screen', 'its own name must be restored');
  assert.equal(d.blocked, 1, 'and a genuine block must still survive a re-pair');
});

test('a snapshot with no workspace recorded is still applied, so legacy rows keep working', () => {
  db.prepare(`INSERT OR REPLACE INTO device_settings (fingerprint, workspace_id, device_name, blocked, last_seen)
              VALUES ('legacy-fp', NULL, 'Legacy Name', 0, strftime('%s','now'))`).run();
  const dev = makeDevice('dev-legacy', B.ws);
  deviceSettings.applyToDevice(dev, 'legacy-fp');
  assert.equal(deviceRow(dev).name, 'Legacy Name');
});

test('AUDIT F07: a row with NO workspace (the real provisioning row) gets nothing applied', () => {
  // The automatic restore used to run on the freshly INSERTed provisioning row, whose workspace_id
  // is always NULL — so `dev.workspace_id &&` short-circuited the guard and A's playlist landed on
  // the unclaimed row. The tests above all seeded a workspace and never saw that row.
  const dev = makeDevice('dev-unclaimed', null);
  assert.equal(deviceSettings.applyToDevice(dev, FP), null);
  const d = deviceRow(dev);
  assert.equal(d.playlist_id, null, "A's playlist must not land on a workspace-less row");
  assert.equal(d.name, 'Screen');
});

test('AUDIT F07: restoreOnClaim applies via the linked fingerprint once the row is in its workspace', () => {
  const dev = makeDevice('dev-claimed-A', A.ws);
  db.prepare("INSERT OR REPLACE INTO device_fingerprints (fingerprint, device_id, last_seen) VALUES (?, ?, strftime('%s','now'))").run(FP, dev);
  assert.ok(deviceSettings.restoreOnClaim(dev));
  assert.equal(deviceRow(dev).playlist_id, A.pl);
  assert.equal(deviceSettings.restoreOnClaim('no-such-device'), null, 'no fingerprint link -> no-op');
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
