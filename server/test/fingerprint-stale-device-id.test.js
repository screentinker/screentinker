'use strict';

// A device that reconnects after its row was deleted sends the id it still has cached. That id
// is gone, and device_fingerprints.device_id has an FK to devices(id) — so writing it back
// throws FOREIGN KEY constraint failed. The throw is caught, which is why nothing looked broken,
// but the catch abandons the ENTIRE fingerprint block: last_seen is not touched, the reinstall
// link is not made, and the #150 settings restore never runs. That restore exists precisely for
// the post-delete re-pair, so the failure lands exactly where the feature was supposed to help —
// a re-paired panel comes back with its orientation/name/playlist reset.
//
// Observed on production: 37 occurrences, timestamped identically to the "sending unpaired" log
// lines, which is the same event seen from the other side.
//
// The rule pinned here: only ever store a device_id that still resolves. Prefer the incoming id,
// fall back to what is already stored, else NULL — which the column allows, and which is what
// ON DELETE SET NULL already leaves behind.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-fp-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');

const mkDevice = (name) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, created_at)
              VALUES (?, ?, 'online', strftime('%s','now'))`).run(id, name);
  return id;
};

// The exact statement the register handler runs, with the guard applied.
// tokenProven mirrors the handler's ⚠️ AUDIT F06 rule: the incoming id is only honoured when the
// caller proved it owns it (fingerprint-unproven-device-id.test.js covers that end-to-end).
function writeFingerprint(fingerprint, incomingDeviceId, tokenProven = true) {
  const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
  if (!existing) return null;
  const known = (id) => !!(id && db.prepare('SELECT 1 FROM devices WHERE id = ?').get(id));
  const fpDeviceId = (tokenProven && known(incomingDeviceId)) ? incomingDeviceId
    : (known(existing.device_id) ? existing.device_id : null);
  db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
    .run(fpDeviceId, fingerprint);
  return db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
}

before(() => { db.pragma('foreign_keys = ON'); });
after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('foreign keys are actually enforced, or this whole file proves nothing', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('the SHIPPED handler carries the guard, not just this test', () => {
  // writeFingerprint() above mirrors the handler's statement; without this check the whole
  // file would still pass against an unfixed deviceSocket.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const i = src.indexOf('UPDATE device_fingerprints SET last_seen');
  assert.notEqual(i, -1, 'the UPDATE still exists');
  const window = src.slice(Math.max(0, i - 900), i + 300);
  assert.match(window, /SELECT 1 FROM devices WHERE id = \?/,
    'the id is validated against devices before being written');
  assert.doesNotMatch(window, /\.run\(\s*device_id \|\| existing\.device_id/,
    'the unguarded write is gone');
});

test('THE BUG: a reconnect carrying a DELETED device id must not throw', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const dev = mkDevice('Panel');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, dev);

  db.prepare('DELETE FROM devices WHERE id = ?').run(dev);   // ON DELETE SET NULL clears the link
  assert.equal(db.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?').get(fp).device_id, null);

  // The player still has the old id cached and sends it on reconnect.
  const row = writeFingerprint(fp, dev);
  assert.ok(row, 'the write completed instead of throwing');
  assert.equal(row.device_id, null, 'a vanished id is not written back');
});

test('last_seen is still updated — the block is no longer abandoned', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const dev = mkDevice('Panel2');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id, last_seen) VALUES (?, ?, 1)').run(fp, dev);
  db.prepare('DELETE FROM devices WHERE id = ?').run(dev);

  const row = writeFingerprint(fp, dev);
  assert.ok(row.last_seen > 1, 'the fingerprint is still seen, which is what drives reinstall tracking');
});

test('a LIVE device id is stored, so normal tracking is unaffected', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const a = mkDevice('A');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, a);
  const b = mkDevice('B');
  assert.equal(writeFingerprint(fp, b).device_id, b, 'the incoming id wins when it resolves');
});

test('an absent incoming id keeps the existing link rather than clearing it', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const a = mkDevice('Keeper');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, a);
  assert.equal(writeFingerprint(fp, null).device_id, a, 'still linked — this is what reinstall detection reads');
});

test('both ids vanished -> NULL, not a throw', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const a = mkDevice('Gone');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, a);
  db.prepare('DELETE FROM devices WHERE id = ?').run(a);
  const ghost = crypto.randomUUID();
  assert.equal(writeFingerprint(fp, ghost).device_id, null);
});

test('the UNGUARDED statement really does throw — the bug is what we think it is', () => {
  const fp = 'fp-' + crypto.randomBytes(4).toString('hex');
  const dev = mkDevice('Proof');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, dev);
  db.prepare('DELETE FROM devices WHERE id = ?').run(dev);
  assert.throws(
    () => db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
      .run(dev, fp),
    /FOREIGN KEY constraint failed/,
    'this is the exact error seen 37 times on prod',
  );
});
