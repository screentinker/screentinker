'use strict';

/*
 * Local slots, against an in-memory database built from the real DDL (test/helpers/corporate-fixture):
 * nearest fill per slot (spec §2.3), signatures, the composition cache (§3.3), the signature-aware
 * group-sync key (§2.4), the composition fan-out (§3.4) and the devices-playing unions.
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - composition.js compositionForFills: return the cached row without comparing inputs_rev
 *       -> "the cache is self-healing: ..."
 *   - devices-playing.js: drop the fill union (a)        -> "devicesPlayingContent reaches screens playing a fill ..."
 *   - resolve.js fillCandidates: drop the fill_state = 'ok' filter -> "an over-limit fill is skipped ..."
 *   - resolve.js scopeRank: let a device fill apply to a wall member -> "video wall members use the wall's fill ..."
 *   - fanout.js changedKeys/withCompositionDiff: push every device -> "a fill row change pushes ONLY ..."
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, injectDb } = require('./helpers/corporate-fixture');

const db = freshDb();
injectDb(db);

// Record pushes instead of reaching a socket server.
const pushed = [];
const cqPath = require.resolve('../lib/command-queue');
require.cache[cqPath] = { id: cqPath, filename: cqPath, loaded: true, exports: { queueOrEmitPlaylistUpdate: (_ns, id) => pushed.push(id) } };
const dsPath = require.resolve('../ws/deviceSocket');
require.cache[dsPath] = { id: dsPath, filename: dsPath, loaded: true, exports: { buildPlaylistPayload: () => ({}) } };
const io = { of: () => ({}) };

const resolve = require('../lib/corporate/resolve');
const composition = require('../lib/corporate/composition');
const fanout = require('../lib/corporate/fanout');
const fills = require('../lib/corporate/fills');

const s = seed(db);
let ORG, HQ, W1, W2, P, SLOT, dev, devB, devWall1, devWall2, wall, gHigh, gLow;
const img = (id) => ({ content_id: id, mime_type: 'image/png', duration_sec: 10, sort_order: 0, zone_id: null });
const ids = (items) => items.map((i) => i.content_id);

before(() => {
  ORG = s.org('Acme');
  HQ = s.ws(ORG, 'HQ');
  W1 = s.ws(ORG, 'Store 1');
  W2 = s.ws(ORG, 'Store 2');
  s.hq(ORG, HQ);
  P = s.playlist(HQ, { corporate: 1, name: 'Brand' });
  s.composable(P, [img('hq1')]);
  SLOT = s.slot(ORG, P, { name: 'Promo' });
  dev = s.device(W1, { name: 'Till' });
  devB = s.device(W1, { name: 'Window' });
  wall = s.wall(W1);
  devWall1 = s.device(W1, { name: 'Wall L' });
  devWall2 = s.device(W1, { name: 'Wall R' });
  s.onWall(devWall1, wall);
  s.onWall(devWall2, wall);
  gHigh = s.group(W1, { priority: 5, created_at: 10 });
  gLow = s.group(W1, { priority: 1, created_at: 5 });
  s.join(dev, gHigh); s.join(dev, gLow); s.join(devB, gLow);
  s.join(devWall1, gHigh);
  s.mandate(ORG, 'org', ORG, { playlist_id: P });
});

const fillOf = (d) => resolve.fillsForDevice(db, d, P).get(SLOT);

test('nearest fill wins per slot: device > group > workspace', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  assert.equal(fillOf(dev).fillId, wsF.id, 'workspace level when nothing nearer');
  const gF = s.fill(SLOT, W1, 'group', gLow, { items: [img('g')] });
  assert.equal(fillOf(dev).fillId, gF.id, 'group beats workspace');
  const dF = s.fill(SLOT, W1, 'device', dev, { items: [img('d')] });
  assert.equal(fillOf(dev).fillId, dF.id, 'the screen\'s own beats its groups');
  assert.equal(fillOf(devB).fillId, gF.id, 'another screen in the group is unaffected');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?, ?)').run(wsF.id, gF.id, dF.id);
});

test('group tie-break: priority DESC, then created_at ASC, then id', () => {
  const low = s.fill(SLOT, W1, 'group', gLow, { items: [img('low')] });
  const high = s.fill(SLOT, W1, 'group', gHigh, { items: [img('high')] });
  assert.equal(fillOf(dev).fillId, high.id, 'higher priority group wins');
  db.prepare('UPDATE device_groups SET priority = 1 WHERE id = ?').run(gHigh);
  assert.equal(fillOf(dev).fillId, low.id, 'same priority: the older group (created_at 5 < 10)');
  db.prepare('UPDATE device_groups SET priority = 5 WHERE id = ?').run(gHigh);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(low.id, high.id);
});

test('a fill from another workspace never applies (a store can only fill its own screens)', () => {
  const other = s.fill(SLOT, W2, 'workspace', W2, { items: [img('other')] });
  assert.equal(fillOf(dev), undefined);
  // A fill row naming W1 whose playlist lives in W2 is ignored too.
  const wrong = s.fill(SLOT, W1, 'workspace', W1, { items: [img('moved')] });
  db.prepare('UPDATE playlists SET workspace_id = ? WHERE id = ?').run(W2, wrong.playlistId);
  assert.equal(fillOf(dev), undefined);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(other.id, wrong.id);
});

test('only slots in the PUBLISHED composable resolve: a draft-only slot is ignored, a removed one plays until published', () => {
  const draftOnly = s.slot(ORG, P, { name: 'Draft', live: false });
  const f = s.fill(draftOnly, W1, 'workspace', W1, { items: [img('x')] });
  assert.equal(resolve.fillsForDevice(db, dev, P).get(draftOnly), undefined, 'not in the published composable');
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  db.prepare('UPDATE corporate_slots SET retired_at = 1 WHERE id = ?').run(SLOT);
  assert.equal(fillOf(dev).fillId, wsF.id, 'removed in the draft: still live until head office publishes (R19)');
  const keep = db.prepare('SELECT published_composable FROM playlists WHERE id = ?').get(P).published_composable;
  s.composable(P, JSON.parse(keep).filter((el) => el.__slot !== SLOT));
  assert.equal(fillOf(dev), undefined, 'published without it: gone');
  s.composable(P, JSON.parse(keep));
  db.prepare('UPDATE corporate_slots SET retired_at = NULL WHERE id = ?').run(SLOT);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(f.id, wsF.id);
});

test('an over-limit fill is skipped as if absent, and so is an unpublished one: the next level plays', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  const dF = s.fill(SLOT, W1, 'device', dev, { items: [img('d')], state: 'over_limit' });
  assert.equal(fillOf(dev).fillId, wsF.id, 'over_limit -> workspace');
  const dF2 = s.fill(SLOT, W1, 'group', gHigh, { published: false });
  assert.equal(fillOf(dev).fillId, wsF.id, 'unpublished -> skipped');
  assert.equal(resolve.fillsForDevice(db, dev, P, { anyState: true }).get(SLOT).fillId, dF.id, 'but the add redirect still finds the one being built');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?, ?)').run(wsF.id, dF.id, dF2.id);
});

test('video wall members use the wall\'s fill and ignore device and group fills (a wall never splits)', () => {
  const g = s.fill(SLOT, W1, 'group', gHigh, { items: [img('g')] });
  const d = s.fill(SLOT, W1, 'device', devWall1, { items: [img('d')] });
  assert.equal(fillOf(devWall1), undefined, 'device/group fills do not reach a wall member');
  const w = s.fill(SLOT, W1, 'wall', wall, { items: [img('w')] });
  assert.equal(fillOf(devWall1).fillId, w.id);
  assert.equal(fillOf(devWall2).fillId, w.id);
  db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(devWall2, wall);
  assert.equal(fillOf(devWall1).fillId, w.id, 'a leader change leaves the wall fill in force');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?, ?)').run(g.id, d.id, w.id);
});

test('signatures are stable and sorted; the bulk path agrees with the per-device path', () => {
  const S2 = s.slot(ORG, P, { name: 'Second' });
  const a = s.fill(SLOT, W1, 'workspace', W1, { items: [img('a')] });
  const b = s.fill(S2, W1, 'device', dev, { items: [img('b')] });
  const sig = resolve.signatureFor(resolve.fillsForDevice(db, dev, P));
  const expected = [[SLOT, a.playlistId], [S2, b.playlistId]].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(';');
  assert.equal(sig, expected);
  const bulk = resolve.signaturesForPlaylist(db, P);
  for (const d of [dev, devB, devWall1, devWall2]) {
    assert.equal(bulk.get(d).signature, resolve.signatureFor(resolve.fillsForDevice(db, d, P)), `bulk == single for ${d}`);
  }
  assert.equal(resolve.signatureFor(new Map()), '');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(a.id, b.id);
  db.prepare('DELETE FROM playlist_items WHERE slot_id = ?').run(S2);
  db.prepare('UPDATE corporate_slots SET retired_at = 1 WHERE id = ?').run(S2);
});

test('compositionFor splices the store\'s published content and tags its origin', () => {
  const f = s.fill(SLOT, W1, 'workspace', W1, { items: [img('s1'), img('s2')] });
  const c = composition.compositionFor(db, dev, P);
  assert.deepEqual(ids(c.items), ['hq1', 's1', 's2']);
  assert.deepEqual(c.items.map((i) => i.__origin_ws), [HQ, W1, W1]);
  assert.ok(db.prepare('SELECT 1 FROM corporate_compositions WHERE playlist_id = ? AND signature = ?').get(P, c.signature), 'cached');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(f.id);
});

test('the cache is self-healing: a fill published behind the fan-out\'s back is picked up on the next read', () => {
  const f = s.fill(SLOT, W1, 'workspace', W1, { items: [img('old')] });
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq1', 'old']);
  // Some future publish path writes the snapshot and bumps the rev but forgets every push.
  db.prepare('UPDATE playlists SET published_snapshot = ?, published_rev = published_rev + 1 WHERE id = ?').run(JSON.stringify([img('new')]), f.playlistId);
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq1', 'new']);
  // And a corporate change (rev bump on P) likewise.
  s.composable(P, [img('hq2'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: {}, fallback: null }]);
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq2', 'new']);
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: {}, fallback: null }]);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(f.id);
});

test('sync key: plain P without fills; P|signature with them; a screen with its own fill drops out', () => {
  const g = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(gLow);
  db.prepare('UPDATE device_groups SET sync_enabled = 1 WHERE id = ?').run(gLow);
  const grp = { ...g, sync_enabled: 1 };
  assert.equal(resolve.syncKeyForGroup(db, grp), P, 'no fills: the Stage A key, unchanged');
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  const key = resolve.syncKeyForGroup(db, grp);
  assert.equal(key, `${P}|${SLOT}=${wsF.playlistId}`);
  assert.deepEqual(resolve.syncMembers(db, grp, 'd.id').map((r) => r.id).sort(), [dev, devB].sort(), 'both members play the workspace fill');
  const own = s.fill(SLOT, W1, 'device', devB, { items: [img('own')] });
  assert.deepEqual(resolve.syncMembers(db, grp, 'd.id').map((r) => r.id), [dev], 'a screen with its own content plays a different loop');
  assert.equal(resolve.isSyncMember(db, grp, devB), false);
  assert.equal(resolve.isSyncMember(db, grp, dev), true);
  assert.equal(resolve.deviceSyncGroup(db, devB, P), null);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(wsF.id, own.id);
  db.prepare('UPDATE device_groups SET sync_enabled = 0 WHERE id = ?').run(gLow);
});

test('a fill row change pushes ONLY the screens whose composed loop changed', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  composition.compositionFor(db, dev, P);
  pushed.length = 0;
  // A device-level fill that is a byte-identical copy changes nothing on screen: no push.
  fanout.withCompositionDiff(io, P, () => {
    fills.createFill(db, { slot: fills.slotRow(db, SLOT), workspaceId: W1, scopeKind: 'device', scopeId: dev, copyFromPlaylistId: wsF.playlistId });
  });
  assert.deepEqual(pushed, [], 'a copy is invisible on screen');
  // Changing what one screen plays pushes that screen only.
  const own = fills.fillAt(db, SLOT, 'device', dev);
  fanout.withCompositionDiff(io, P, () => {
    db.prepare('UPDATE playlists SET published_snapshot = ?, published_rev = published_rev + 1 WHERE id = ?').run(JSON.stringify([img('mine')]), own.fill_playlist_id);
  });
  assert.deepEqual(pushed, [dev]);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(wsF.id, own.id);
});

test('fill publish fan-out: before/after around the write; an unrelated republish pushes nobody', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  composition.compositionFor(db, dev, P);
  pushed.length = 0;
  let ctx = fanout.beforePublish(wsF.playlistId);
  assert.equal(ctx.kind, 'fill');
  db.prepare('UPDATE playlists SET published_rev = published_rev + 1 WHERE id = ?').run(wsF.playlistId);   // same content
  fanout.afterPublish(ctx, io);
  assert.deepEqual(pushed, [], 'identical composed loop: nothing restarts');
  ctx = fanout.beforePublish(wsF.playlistId);
  db.prepare('UPDATE playlists SET published_snapshot = ?, published_rev = published_rev + 1 WHERE id = ?').run(JSON.stringify([img('ws2')]), wsF.playlistId);
  fanout.afterPublish(ctx, io);
  // Everyone in the workspace, the video wall included (a wall takes workspace-level content whole;
  // only device- and group-level content skips wall members).
  assert.deepEqual(pushed.sort(), [dev, devB, devWall1, devWall2].sort());
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(wsF.id);
});

test('head office lowering a limit marks over-limit fills (they stop playing), raising it brings them back', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('a'), img('b'), img('c')] });
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: { max_items: 2 }, fallback: img('fb') }]);
  fanout.recheckSlotFills(db, P);
  assert.equal(db.prepare('SELECT fill_state FROM corporate_slot_fills WHERE id = ?').get(wsF.id).fill_state, 'over_limit');
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq1', 'fb'], 'not truncated — the fallback plays instead');
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'corporate.fill.over_limit'").get(), 'audited');
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: { max_items: 5 }, fallback: img('fb') }]);
  fanout.recheckSlotFills(db, P);
  assert.equal(db.prepare('SELECT fill_state FROM corporate_slot_fills WHERE id = ?').get(wsF.id).fill_state, 'ok');
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq1', 'a', 'b', 'c']);
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: {}, fallback: null }]);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(wsF.id);
});

test('devicesPlayingContent reaches screens playing a fill, and screens whose slot falls back to the content', () => {
  const { devicesPlayingContent } = require('../lib/devices-playing');
  db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type) VALUES ('c-store', ?, 'offer.png', 'image/png')").run(W1);
  const f = s.fill(SLOT, W1, 'device', dev, { items: [{ ...img('c-store') }] });
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, 'c-store', 0)").run(f.playlistId);
  assert.deepEqual(devicesPlayingContent('c-store'), [dev], 'only the screen whose nearest fill holds it');
  db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type) VALUES ('c-fb', ?, 'fb.png', 'image/png')").run(HQ);
  db.prepare("UPDATE corporate_slots SET fallback_content_id = 'c-fb' WHERE id = ?").run(SLOT);
  assert.deepEqual(devicesPlayingContent('c-fb').sort(), [dev, devB, devWall1, devWall2].sort(), 'every screen on the corporate playlist');
  db.prepare('UPDATE corporate_slots SET fallback_content_id = NULL WHERE id = ?').run(SLOT);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(f.id);
});

test('describeFill counts the screens an edit reaches (nearest fill IS this one)', () => {
  const wsF = s.fill(SLOT, W1, 'workspace', W1, { items: [img('ws')] });
  const own = s.fill(SLOT, W1, 'device', dev, { items: [img('own')] });
  const row = db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(wsF.id);
  const d = fills.describeFill(db, row, fills.slotRow(db, SLOT));
  assert.equal(d.screens, 3, 'the window screen and both wall panels; the till has its own');
  assert.equal(d.scope_label, 'Everyone in "Store 1"');
  db.prepare('DELETE FROM corporate_slot_fills WHERE id IN (?, ?)').run(wsF.id, own.id);
});

test('a replaced video that grew past the slot\'s seconds marks the fill over_limit; shrinking back clears it', () => {
  db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type, duration_sec) VALUES ('c-vid', ?, 'clip.mp4', 'video/mp4', 20)").run(W1);
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: { max_total_sec: 60 }, fallback: null }]);
  const f = s.fill(SLOT, W1, 'workspace', W1, { items: [{ content_id: 'c-vid', mime_type: 'video/mp4', duration_sec: 10, content_duration: 20 }] });
  composition.compositionFor(db, dev, P);
  pushed.length = 0;
  db.prepare("UPDATE content SET duration_sec = 300 WHERE id = 'c-vid'").run();   // the replace
  const changed = fanout.recheckFillsForContent(io, 'c-vid');
  assert.equal(changed.length, 1);
  assert.equal(db.prepare('SELECT fill_state FROM corporate_slot_fills WHERE id = ?').get(f.id).fill_state, 'over_limit');
  assert.ok(pushed.includes(dev), 'the screens that played it are pushed');
  assert.deepEqual(ids(composition.compositionFor(db, dev, P).items), ['hq1'], 'not playing: the slot is skipped (no fallback)');
  db.prepare("UPDATE content SET duration_sec = 30 WHERE id = 'c-vid'").run();
  fanout.recheckFillsForContent(io, 'c-vid');
  assert.equal(db.prepare('SELECT fill_state FROM corporate_slot_fills WHERE id = ?').get(f.id).fill_state, 'ok');
  s.composable(P, [img('hq1'), { __slot: SLOT, zone_id: null, sort_order: 1, limits: {}, fallback: null }]);
  db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(f.id);
});

test('the hourly sweep drops compositions no screen uses and retired slots nothing can bring back', () => {
  const { sweepCorporate } = require('../services/corporate-sweep');
  db.prepare("INSERT INTO corporate_compositions (playlist_id, signature, inputs_rev, snapshot) VALUES (?, 'nobody=uses-this', 'x', '[]')").run(P);
  composition.compositionFor(db, dev, P);   // a live row (signature '')
  const gone = s.slot(ORG, P, { name: 'Gone', live: false });
  db.prepare('DELETE FROM playlist_items WHERE slot_id = ?').run(gone);
  db.prepare('UPDATE corporate_slots SET retired_at = 1 WHERE id = ?').run(gone);
  const kept = s.slot(ORG, P, { name: 'Restorable', live: false });
  db.prepare('DELETE FROM playlist_items WHERE slot_id = ?').run(kept);
  db.prepare('UPDATE corporate_slots SET retired_at = 1 WHERE id = ?').run(kept);
  db.prepare('UPDATE playlists SET published_structure = ? WHERE id = ?').run(JSON.stringify([{ slot_id: kept, sort_order: 0 }]), P);
  const out = sweepCorporate();
  assert.ok(out.compositions >= 1, 'stale rows from earlier tests go too');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM corporate_compositions WHERE signature = 'nobody=uses-this'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM corporate_compositions WHERE playlist_id = ? AND signature = ''").get(P), 'the row a screen uses stays');
  assert.equal(db.prepare('SELECT 1 FROM corporate_slots WHERE id = ?').get(gone), undefined, 'unreachable retired slot removed');
  assert.ok(db.prepare('SELECT 1 FROM corporate_slots WHERE id = ?').get(kept), 'a discard could still restore this one');
  db.prepare('UPDATE playlists SET published_structure = NULL WHERE id = ?').run(P);
});
