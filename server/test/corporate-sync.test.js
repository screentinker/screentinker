'use strict';

/*
 * Group sync under head office mandates — spec §2.4, critique R2.
 *
 * Sync membership used to compare a member's resolved playlist with the GROUP's playlist id, in
 * four separate readers (groupSyncMembers, deviceSyncGroup, syncDecisionFor and the relay guard
 * groupSenderEligible — the fourth was the one first missed). All four now go through one helper
 * that compares a SYNC KEY. These tests pin that:
 *
 *   GOLDEN — with no mandate the helpers return exactly what the pre-feature SQL (copied verbatim
 *   below from base d82f572) returned, for every group and every device of a mixed fleet;
 *   COVERED — with a workspace mandate, a sync-enabled group whose members all play head office's
 *   playlist syncs on it even though the group has no playlist of its own (it could not sync at all
 *   before), and a member pulled elsewhere by a more specific mandate drops out.
 *
 * MUTATION CHECK (verified once): make isSyncMember compare against group.playlist_id again ->
 * "COVERED: ... the relay guard" goes red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, injectDb } = require('./helpers/corporate-fixture');

const db = freshDb();
injectDb(db);
const s = seed(db);
const corp = require('../lib/corporate/resolve');

// ── the pre-feature SQL, verbatim ──
const OLD = {
  members: (group) => (!group || !group.playlist_id ? [] : db.prepare(`
    SELECT d.id, d.status, d.platform, d.ip_address FROM devices d
    JOIN device_group_members dgm ON dgm.device_id = d.id
    JOIN device_resolved_playlist r ON r.device_id = d.id
    WHERE dgm.group_id = ? AND r.playlist_id = ? ORDER BY d.id
  `).all(group.id, group.playlist_id)),
  deviceSyncGroup: (deviceId, pl) => (!pl ? null : db.prepare(`
    SELECT g.id, g.sync_enabled, g.playlist_id, g.leader_device_id, g.sync_backend
    FROM device_groups g JOIN device_group_members dgm ON dgm.group_id = g.id
    WHERE dgm.device_id = ? AND g.sync_enabled = 1 AND g.playlist_id = ?
    ORDER BY g.name ASC, g.id ASC LIMIT 1
  `).get(deviceId, pl) || null),
  senderEligible: (group, deviceId) => {
    if (!group || !group.sync_enabled || !group.playlist_id) return false;
    return !!db.prepare(`
      SELECT 1 FROM device_group_members dgm
      JOIN device_resolved_playlist r ON r.device_id = dgm.device_id
      WHERE dgm.group_id = ? AND dgm.device_id = ? AND r.playlist_id = ?
    `).get(group.id, deviceId, group.playlist_id);
  },
};

const org = s.org('Acme');
const hq = s.ws(org, 'HQ'); s.hq(org, hq);
const store = s.ws(org, 'Store');
const P = s.playlist(hq, { corporate: 1 });
const a = s.playlist(store); const b = s.playlist(store); const own = s.playlist(store);
const gA = s.group(store, { playlist_id: a, sync_enabled: 1 });
const gB = s.group(store, { playlist_id: b, sync_enabled: 1, priority: 3 });
const gNone = s.group(store, { playlist_id: null, sync_enabled: 1 });
const gOff = s.group(store, { playlist_id: a, sync_enabled: 0 });
const devs = [];
for (let i = 0; i < 12; i++) {
  const d = s.device(store, i % 4 === 0 ? { playlist_id: own, playlist_source: 'device' } : {});
  devs.push(d);
  if (i % 2) s.join(d, gA);
  if (i % 3 === 0) s.join(d, gB);
  if (i % 5 === 0) s.join(d, gNone);
  if (i === 7) s.join(d, gOff);
}
const groups = () => db.prepare('SELECT * FROM device_groups').all();
const plain = (rows) => JSON.parse(JSON.stringify(rows));

test('GOLDEN: with no mandate all four readers are byte-identical to the pre-feature SQL', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM corporate_mandates').get().n, 0);
  for (const g of groups()) {
    assert.deepEqual(plain(corp.syncMembers(db, g, 'd.id, d.status, d.platform, d.ip_address')), plain(OLD.members(g)), `members of ${g.id}`);
    for (const d of devs) assert.equal(corp.isSyncMember(db, g, d), OLD.senderEligible(g, d), `sender ${d} in ${g.id}`);
    // the group objects the relay handlers load carry only these columns
    const slim = { id: g.id, sync_enabled: g.sync_enabled, playlist_id: g.playlist_id };
    for (const d of devs) assert.equal(corp.isSyncMember(db, slim, d), OLD.senderEligible(slim, d), `slim sender ${d}`);
  }
  for (const d of devs) {
    const pl = db.prepare('SELECT playlist_id FROM device_resolved_playlist WHERE device_id = ?').get(d).playlist_id;
    assert.deepEqual(plain(corp.deviceSyncGroup(db, d, pl)), plain(OLD.deviceSyncGroup(d, pl)), `sync group of ${d}`);
  }
});

test('COVERED: a workspace mandate — the group syncs on head office\'s playlist, the relay guard trusts its members', () => {
  s.mandate(org, 'workspace', store, { playlist_id: P });
  try {
    const g = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(gNone);
    const members = corp.syncMembers(db, g, 'd.id').map((r) => r.id);
    const expected = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').all(gNone).map((r) => r.device_id);
    assert.deepEqual(members, expected, 'every member plays P, so every member syncs');
    assert.ok(members.length >= 2);
    for (const d of members) assert.equal(corp.isSyncMember(db, { id: gNone, sync_enabled: 1, playlist_id: null }, d), true, 'the relay guard');
    assert.equal(OLD.senderEligible({ id: gNone, sync_enabled: 1, playlist_id: null }, members[0]), false, 'before: a group with no playlist could not relay at all');
    // The device's sync group: the first (by name) sync-enabled group it is in — every one of them
    // is now keyed on P, so it is no longer only gNone.
    const sg = corp.deviceSyncGroup(db, members[0], P);
    const mine = db.prepare(`SELECT g.id FROM device_groups g JOIN device_group_members m ON m.group_id = g.id
       WHERE m.device_id = ? AND g.sync_enabled = 1 ORDER BY g.name, g.id`).all(members[0]).map((r) => r.id);
    assert.equal(sg.id, mine[0]);
    assert.deepEqual(Object.keys(sg).sort(), ['id', 'leader_device_id', 'playlist_id', 'sync_backend', 'sync_enabled'], 'same row shape as before');
    assert.equal(corp.syncKeyForGroup(db, g), P);
    // A member pulled away by a more specific (device) mandate drops out of the group's sync.
    const P2 = s.playlist(hq, { corporate: 1 });
    s.mandate(org, 'device', members[0], { playlist_id: P2 });
    assert.ok(!corp.syncMembers(db, g, 'd.id').map((r) => r.id).includes(members[0]));
    assert.equal(corp.isSyncMember(db, { id: gNone, sync_enabled: 1, playlist_id: null }, members[0]), false);
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('a dark mandate gives nothing to sync on', () => {
  s.mandate(org, 'workspace', store, { dark: 1 });
  try {
    const g = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(gA);
    assert.equal(corp.syncKeyForGroup(db, g), null);
    assert.deepEqual(corp.syncMembers(db, g, 'd.id'), []);
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});
