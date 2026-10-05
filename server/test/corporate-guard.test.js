'use strict';

/*
 * The corporate guard's building blocks, against an in-memory database built from the real
 * definitions: the actor (who is asking), the SQLite backstop (a forgotten writer fails closed),
 * the device-control rule (D13) and org-owned media.
 *
 * MUTATION CHECKS (verified once by reverting each line and watching a named test go red):
 *   - backstop: drop `st_corp_can_author(...) = 0` from lockedFor     -> "a store actor ... is refused"
 *   - device-command: drop the assertDeviceControl call in deliverCommand -> "deliverCommand refuses ..."
 *   - guard: drop GATED_COMMANDS.screen_off                            -> "every gated command ..."
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, injectDb } = require('./helpers/corporate-fixture');

const db = freshDb();
injectDb(db);
const s = seed(db);
const actor = require('../lib/corporate/actor');
const guard = require('../lib/corporate/guard');
const runtime = require('../lib/corporate/runtime');

const org = s.org('Acme');
const hq = s.ws(org, 'HQ'); s.hq(org, hq);
const store = s.ws(org, 'Store');
const P = s.playlist(hq, { corporate: 1, name: 'Brand' });
const child = s.playlist(hq, { name: 'Brand child' });
const plain = s.playlist(hq, { name: 'HQ ordinary' });
const own = s.playlist(store, { name: 'Store own' });
const cHq = 'c-hq'; db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type) VALUES (?, ?, 'a.png', 'image/png')").run(cHq, hq);
const cStore = 'c-store'; db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type) VALUES (?, ?, 'b.png', 'image/png')").run(cStore, store);
db.prepare('INSERT INTO playlist_items (playlist_id, child_playlist_id, sort_order) VALUES (?, ?, 0)').run(P, child);
db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 1)').run(P, cHq);
db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(own, cStore);

s.user('u-admin'); s.orgMember(org, 'u-admin', 'org_admin');
s.user('u-hqed'); s.wsMember(hq, 'u-hqed', 'workspace_editor');
s.user('u-store'); s.wsMember(store, 'u-store', 'workspace_editor');
s.user('u-plat', 'platform_admin');
s.user('u-op', 'platform_operator');

const A = {
  admin: () => actor.fromUser({ id: 'u-admin', role: 'user' }),
  hqEditor: () => actor.fromUser({ id: 'u-hqed', role: 'user' }),
  store: () => actor.fromUser({ id: 'u-store', role: 'user' }),
  platform: () => actor.fromUser({ id: 'u-plat', role: 'platform_admin' }),
  operator: () => actor.fromUser({ id: 'u-op', role: 'platform_operator' }),
  token: () => actor.fromUser({ id: 'u-admin', role: 'user' }, { viaToken: true, tokenScope: 'full' }),
};
const as = (a, fn) => actor.runWithActor(a, fn);
const items = (pl) => db.prepare('SELECT id, content_id, child_playlist_id, sort_order FROM playlist_items WHERE playlist_id = ? ORDER BY id').all(pl);

/* ── actor ──────────────────────────────────────────────────────────────────────────────────── */

test('who authors: org admin and platform admin yes; HQ editor only when the org opts in; tokens and operators never', () => {
  assert.equal(actor.canAuthorOrg(A.admin(), org), true);
  assert.equal(actor.canAuthorOrg(A.platform(), org), true);
  assert.equal(actor.canAuthorOrg(A.hqEditor(), org), false);
  assert.equal(actor.canAuthorOrg(A.store(), org), false);
  assert.equal(actor.canAuthorOrg(A.operator(), org), false);
  assert.equal(actor.canAuthorOrg(A.token(), org), false, 'a token minted by an org admin must not author (D12)');
  db.prepare("UPDATE organizations SET corporate_authors = 'org_admins_and_hq_editors' WHERE id = ?").run(org);
  try {
    assert.equal(actor.canAuthorOrg(A.hqEditor(), org), true);
    assert.equal(actor.isOrgAdminOf(A.hqEditor(), org), false, 'an HQ author still cannot assign (mandates are admin-only)');
    assert.equal(actor.canAuthorOrg(A.store(), org), false);
  } finally {
    db.prepare("UPDATE organizations SET corporate_authors = 'org_admins' WHERE id = ?").run(org);
  }
});

test('no actor = system', () => {
  assert.equal(actor.current(), null);
  assert.equal(actor.canAuthorOrg(null, org), true);
  as(A.store(), () => {
    assert.ok(actor.current());
    actor.runAsSystem(() => assert.equal(actor.current(), null, 'runAsSystem leaves the request store'));
  });
});

/* ── backstop ───────────────────────────────────────────────────────────────────────────────── */

test('⚠️ a store actor writing a corporate playlist directly is refused — INSERT, UPDATE, DELETE, schedules, the row', () => {
  const before = JSON.stringify(items(P));
  for (const a of [A.store(), A.hqEditor(), A.token()]) {
    as(a, () => {
      assert.throws(() => db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 9)').run(P, cHq), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare('UPDATE playlist_items SET sort_order = 7 WHERE playlist_id = ?').run(P), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(P), /CORPORATE_LOCKED/);
      // the CHILD of a corporate playlist is governed too
      assert.throws(() => db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(child, cHq), /CORPORATE_LOCKED/);
      const itemId = items(P)[1].id;
      assert.throws(() => db.prepare("INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time) VALUES ('x', ?, '1', '09:00', '10:00')").run(itemId), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare("UPDATE playlists SET published_snapshot = '[]', status = 'published' WHERE id = ?").run(P), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare("UPDATE playlists SET name = 'pwned' WHERE id = ?").run(P), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare('DELETE FROM playlists WHERE id = ?').run(P), /CORPORATE_LOCKED/);
      assert.throws(() => db.prepare('UPDATE playlists SET corporate = 0 WHERE id = ?').run(P), /CORPORATE_LOCKED/);
      // a cascade from deleting head office's media fails closed too
      assert.throws(() => db.prepare('DELETE FROM content WHERE id = ?').run(cHq), /CORPORATE_LOCKED/);
    });
  }
  assert.equal(JSON.stringify(items(P)), before, 'rows must be byte-identical after every refusal');
});

test('an author, and system code, may write it', () => {
  as(A.admin(), () => {
    const r = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 5)').run(P, cHq);
    db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.lastInsertRowid);
  });
  as(A.platform(), () => { db.prepare("UPDATE playlists SET description = 'ok' WHERE id = ?").run(P); });
  const r = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 6)').run(P, cHq);
  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.lastInsertRowid);
});

test('a store actor writing its OWN playlist is unaffected; an ordinary HQ playlist too', () => {
  as(A.store(), () => {
    const r = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 3)').run(own, cStore);
    db.prepare('UPDATE playlist_items SET sort_order = 4 WHERE id = ?').run(r.lastInsertRowid);
    db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.lastInsertRowid);
    db.prepare("UPDATE playlists SET name = 'renamed' WHERE id = ?").run(own);
  });
  as(A.hqEditor(), () => {
    const r = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 3)').run(plain, cHq);
    db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.lastInsertRowid);
  });
});

test('a non-author cannot create a corporate playlist row, or make one corporate', () => {
  as(A.hqEditor(), () => {
    assert.throws(() => db.prepare("INSERT INTO playlists (id, workspace_id, name, corporate) VALUES ('new-c', ?, 'x', 1)").run(hq), /CORPORATE_LOCKED/);
    assert.throws(() => db.prepare('UPDATE playlists SET corporate = 1 WHERE id = ?').run(plain), /CORPORATE_LOCKED/);
  });
});

test('structural checks hold even for system: a slot placement outside a corporate playlist, a nested playlist in a slot fill', () => {
  const slot = 'slot-1';
  db.prepare("INSERT INTO corporate_slots (id, organization_id, playlist_id, name) VALUES (?, ?, ?, 'Promo')").run(slot, org, P);
  assert.throws(() => db.prepare('INSERT INTO playlist_items (playlist_id, slot_id, sort_order) VALUES (?, ?, 0)').run(own, slot), /CORPORATE_SLOT_OUTSIDE/);
  const fill = s.playlist(store, { name: 'fill' });
  db.prepare("INSERT INTO corporate_slot_fills (id, slot_id, workspace_id, scope_kind, scope_id, fill_playlist_id) VALUES ('f1', ?, ?, 'workspace', ?, ?)").run(slot, store, store, fill);
  assert.throws(() => db.prepare('INSERT INTO playlist_items (playlist_id, child_playlist_id, sort_order) VALUES (?, ?, 0)').run(fill, own), /FILL_FLAT/);
  db.prepare("DELETE FROM corporate_slot_fills WHERE id = 'f1'").run();
  db.prepare('DELETE FROM corporate_slots WHERE id = ?').run(slot);
});

test('⚠️ the UDFs never query: a backstop check inside a multi-row INSERT ... SELECT does not trip "connection busy" (R15)', () => {
  as(A.store(), () => {
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) SELECT ?, ?, value FROM json_each(?)').run(own, cStore, JSON.stringify([10, 11, 12, 13]));
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND sort_order >= 10').run(own);
  });
});

test('the tripwire counts a governed write with no actor INSIDE an HTTP request, and nothing outside one', () => {
  actor.resetTripwire();
  db.prepare('UPDATE playlist_items SET muted = 0 WHERE playlist_id = ?').run(own);
  assert.equal(actor.tripwireCount(), 0, 'system work outside a request is not a tripwire event');
  actor.httpAls.run({ method: 'POST', path: '/x' }, () => {
    db.prepare('UPDATE playlist_items SET muted = 0 WHERE playlist_id = ?').run(own);
  });
  // Only a write that touches head office's content is a tripwire event: an ordinary playlist's
  // actorless write (an admin workspace delete) must not log corporate warnings (review fix).
  assert.equal(actor.tripwireCount(), 0, 'an ordinary playlist is not governed: nothing to note');
  actor.httpAls.run({ method: 'POST', path: '/x' }, () => {
    db.prepare('UPDATE playlist_items SET muted = 0 WHERE playlist_id = ?').run(P);
  });
  assert.ok(actor.tripwireCount() >= 1, 'an actorless write to head office\'s content inside a request must be counted');
  actor.resetTripwire();
});

/* ── governance and media ───────────────────────────────────────────────────────────────────── */

test('governanceOf: corporate, its child, and nothing else', () => {
  assert.equal(guard.governanceOf(db, P).kind, 'corporate');
  assert.equal(guard.governanceOf(db, child).kind, 'corporate_child');
  assert.equal(guard.governanceOf(db, plain).kind, null);
  assert.equal(guard.governanceOf(db, own).kind, null);
});

test('assertPlaylistWritable: AUTHOR_REQUIRED for a non-author, TOKEN for any token, nothing for an author or system', () => {
  assert.throws(() => guard.assertPlaylistWritable(A.hqEditor(), { id: P }), (e) => e.code === 'CORPORATE_AUTHOR_REQUIRED' && e.status === 403);
  assert.throws(() => guard.assertPlaylistWritable(A.token(), { id: child }), (e) => e.code === 'CORPORATE_TOKEN');
  guard.assertPlaylistWritable(A.admin(), { id: P });
  guard.assertPlaylistWritable(null, { id: P });
  guard.assertPlaylistWritable(A.store(), { id: own });
});

test('org-owned media: a non-author may not change what a corporate playlist uses', () => {
  assert.throws(() => guard.assertMediaWritable(A.hqEditor(), 'content', cHq), (e) => e.code === 'CORPORATE_MEDIA');
  guard.assertMediaWritable(A.admin(), 'content', cHq);
  guard.assertMediaWritable(A.store(), 'content', cStore);
  // Still on screens through the PUBLISHED copy, after the draft dropped it.
  const cOld = 'c-old'; db.prepare("INSERT INTO content (id, workspace_id, filename) VALUES (?, ?, 'old.png')").run(cOld, hq);
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify([{ content_id: cOld }]), P);
  assert.throws(() => guard.assertMediaWritable(A.hqEditor(), 'content', cOld), (e) => e.code === 'CORPORATE_MEDIA');
  // A mandate's layout is head office's too.
  const lay = s.layout(hq);
  s.mandate(org, 'workspace', store, { playlist_id: P, layout_id: lay });
  assert.throws(() => guard.assertMediaWritable(A.hqEditor(), 'layout', lay), (e) => e.code === 'CORPORATE_MEDIA');
  db.prepare('DELETE FROM corporate_mandates').run();
});

/* ── device controls (D13) ──────────────────────────────────────────────────────────────────── */

test('every gated command is refused on a mandated screen for everyone but org admins; ungated ones pass', () => {
  const d = s.device(store);
  const dev = { id: d, workspace_id: store };
  const unmandated = s.device(store);
  s.mandate(org, 'device', d, { playlist_id: P });
  try {
    assert.equal(runtime.active(db), true);
    for (const type of Object.keys(guard.GATED_COMMANDS)) {
      for (const a of [A.store(), A.hqEditor(), A.operator(), A.token()]) {
        const r = guard.assertDeviceControl(a, dev, type, {});
        assert.equal(r.ok, false, `${type} must be refused`);
        assert.equal(r.code, 'CORPORATE_DEVICE_CONTROL');
      }
      assert.equal(guard.assertDeviceControl(A.admin(), dev, type, {}).ok, true, `${type}: org admin`);
      assert.equal(guard.assertDeviceControl(A.platform(), dev, type, {}).ok, true, `${type}: platform admin`);
      assert.equal(guard.assertDeviceControl(null, dev, type, {}).ok, true, `${type}: system`);
      assert.equal(guard.assertDeviceControl(A.store(), { id: unmandated, workspace_id: store }, type, {}).ok, true, `${type}: unmandated screen`);
    }
    for (const type of ['reboot', 'set_volume', 'set_timezone', 'refresh', 'screen_on']) {
      assert.equal(guard.assertDeviceControl(A.store(), dev, type, { level: 0.5 }).ok, true, type);
    }
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('brightness is floored at 20% for non-admins on a mandated screen; -1 (follow system) passes', () => {
  const d = s.device(store);
  s.mandate(org, 'device', d, { playlist_id: P });
  try {
    const dev = { id: d, workspace_id: store };
    assert.deepEqual(guard.assertDeviceControl(A.store(), dev, 'set_brightness', { level: 0 }).payload, { level: 0.2 });
    assert.deepEqual(guard.assertDeviceControl(A.store(), dev, 'set_system_brightness', { level: 0.1 }).payload, { level: 0.2 });
    assert.deepEqual(guard.assertDeviceControl(A.store(), dev, 'set_brightness', { level: 0.7 }).payload, { level: 0.7 });
    assert.deepEqual(guard.assertDeviceControl(A.store(), dev, 'set_brightness', { level: -1 }).payload, { level: -1 });
    assert.deepEqual(guard.assertDeviceControl(A.admin(), dev, 'set_brightness', { level: 0 }).payload, { level: 0 });
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('⚠️ deliverCommand refuses a gated command on a mandated screen (REST, fan-outs and the socket share this one path)', () => {
  const { deliverCommand } = require('../lib/device-command');
  const d = s.device(store);
  db.prepare("UPDATE devices SET platform = 'android' WHERE id = ?").run(d);
  s.mandate(org, 'device', d, { playlist_id: P });
  const emitted = [];
  const ns = { adapter: { rooms: new Map([[d, new Set(['sock'])]]) }, to: () => ({ emit: (ev, p) => emitted.push(p) }) };
  try {
    const device = { id: d, workspace_id: store, platform: 'android', capabilities: JSON.stringify(['display.power', 'system.shell', 'system.reboot']) };
    // Explicit actor (the dashboard socket's path) …
    const r1 = deliverCommand(ns, device, 'screen_off', {}, { actor: A.store() });
    assert.equal(r1.status, 'refused');
    assert.equal(r1.code, 'CORPORATE_DEVICE_CONTROL');
    // … and the ambient request actor (every REST caller).
    const r2 = as(A.store(), () => deliverCommand(ns, device, 'reboot', {}));
    assert.notEqual(r2.status, 'refused', 'reboot stays with the store');
    const r3 = as(A.store(), () => deliverCommand(ns, device, 'shell', { cmd: 'id' }));
    assert.equal(r3.status, 'refused');
    assert.ok(!emitted.some((p) => p && p.type === 'shell'), 'the shell command must never reach the panel');
    const r4 = as(A.admin(), () => deliverCommand(ns, device, 'reboot', {}));
    assert.notEqual(r4.status, 'refused');
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('inactive (no mandates): every device-level helper is today\'s behaviour', () => {
  assert.equal(runtime.active(db), false);
  const d = s.device(store);
  assert.equal(guard.activeMandateFor(db, d), null);
  assert.equal(guard.assertDeviceControl(A.store(), { id: d }, 'screen_off', {}).ok, true);
  assert.equal(guard.assertNotMandated(A.store(), d), null);
  let ran = false;
  guard.assertNoMandateLoss(A.store(), [d], () => { ran = true; });
  assert.equal(ran, true);
});

test('CORPORATE_TEST_FORCE_DEGRADED / viewsDegraded switches every device helper off', () => {
  const d = s.device(store);
  s.mandate(org, 'device', d, { playlist_id: P });
  try {
    assert.equal(runtime.active(db), true);
    runtime.setViewsDegraded(true);
    assert.equal(runtime.active(db), false);
    assert.equal(guard.assertDeviceControl(A.store(), { id: d }, 'screen_off', {}).ok, true);
    assert.equal(guard.assertNotMandated(A.store(), d), null);
  } finally {
    runtime.setViewsDegraded(false);
    db.prepare('DELETE FROM corporate_mandates').run();
  }
});

test('mandate-loss guard: a change in EITHER direction is refused and rolled back for a non-admin', () => {
  const g = s.group(store);
  const d = s.device(store);
  const pGrp = s.playlist(hq, { corporate: 1 });
  s.mandate(org, 'group', g, { playlist_id: pGrp });
  try {
    // gaining a mandate (join)
    assert.throws(() => guard.assertNoMandateLoss(A.store(), [d], () => s.join(d, g), () => 'join refused'),
      (e) => e.code === 'CORPORATE_MEMBERSHIP' && /join refused/.test(e.message));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = ?').get(d).n, 0, 'rolled back');
    // an org admin may
    guard.assertNoMandateLoss(A.admin(), [d], () => s.join(d, g));
    // losing it (leave)
    assert.throws(() => guard.assertNoMandateLoss(A.store(), [d], () => db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(d)),
      (e) => e.code === 'CORPORATE_MEMBERSHIP');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = ?').get(d).n, 1, 'rolled back');
    // a change that does not touch the mandate is fine
    guard.assertNoMandateLoss(A.store(), [d], () => db.prepare("UPDATE devices SET name = 'x' WHERE id = ?").run(d));
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('error mapping: a backstop RAISE becomes a 403 with its code; anything else is not ours', () => {
  const r = guard.toResponse(Object.assign(new Error('CORPORATE_LOCKED'), { code: 'SQLITE_CONSTRAINT_TRIGGER' }));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_LOCKED');
  assert.equal(guard.toResponse(new Error('FILL_FLAT')).status, 400);
  assert.equal(guard.toResponse(new Error('FOREIGN KEY constraint failed')), null);
  assert.equal(guard.toResponse(null), null);
  const e = guard.err('CORPORATE_OVERRIDE', { name: 'Brand' }, { corporate: { playlist_id: P, playlist_name: 'Brand' } });
  const r2 = guard.toResponse(e);
  assert.equal(r2.status, 403); assert.match(r2.body.error, /"Brand"/); assert.equal(r2.body.corporate.playlist_id, P);
});
