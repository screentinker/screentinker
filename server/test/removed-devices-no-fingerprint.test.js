'use strict';

/*
 * A fingerprint is a device credential: a register that presents one with no token is what the
 * reinstall reclaim keys on. GET /api/devices/removed is readable by any workspace member, viewers
 * included, so it names each saved snapshot by an opaque ref, and re-adopt takes that ref.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-removed-ref-'));
process.env.DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { db } = require('../db/database');
const ds = require('../lib/device-settings');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@t', 'A', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('o1', 'O', 'u1')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('w1', 'o1', 'W1'), ('w2', 'o1', 'W2')").run();
const FP = 'android-0123456789abcdef';
db.prepare("INSERT INTO device_settings (fingerprint, workspace_id, device_name, removed_at) VALUES (?, 'w1', 'Lobby', strftime('%s','now'))").run(FP);

test('the removed list never carries a fingerprint', () => {
  const rows = ds.listRemoved('w1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fingerprint, undefined);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(FP));
  assert.match(rows[0].ref, /^[0-9a-f]{32}$/);
  assert.equal(rows[0].device_name, 'Lobby');
});

test('a ref resolves to its fingerprint only inside its own workspace', () => {
  const { ref } = ds.listRemoved('w1')[0];
  assert.equal(ds.fingerprintForRef('w1', ref), FP);
  assert.equal(ds.fingerprintForRef('w2', ref), null);
  assert.equal(ds.fingerprintForRef('w1', 'not-a-ref'), null);
});

test('re-adopt accepts the ref the list hands out', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');
  assert.match(route, /body\.ref \? deviceSettings\.fingerprintForRef\(device\.workspace_id, body\.ref\)/);
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  assert.match(api, /reAdoptDevice: \(id, ref\) => request\(`\/devices\/\$\{id\}\/re-adopt`, \{ method: 'POST', body: JSON\.stringify\(\{ ref \}\) \}\)/);
});
