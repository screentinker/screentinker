'use strict';

/*
 * `update` is new software on the screen — on an embedded panel, a reflash. It is the same class
 * as install_apk, so on a screen head office controls it is for the organization's admins only.
 * Before this, a store editor could reflash a mandated panel (#638 review).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, injectDb } = require('./helpers/corporate-fixture');

const db = freshDb();
injectDb(db);
const s = seed(db);
const actor = require('../lib/corporate/actor');
const guard = require('../lib/corporate/guard');
const { deliverCommand } = require('../lib/device-command');
const queue = require('../lib/command-queue');

const org = s.org('Acme');
const hq = s.ws(org, 'HQ'); s.hq(org, hq);
const store = s.ws(org, 'Store');
const P = s.playlist(hq, { corporate: 1, name: 'Brand' });
s.user('u-admin'); s.orgMember(org, 'u-admin', 'org_admin');
s.user('u-store'); s.wsMember(store, 'u-store', 'workspace_editor');
const A = {
  admin: () => actor.fromUser({ id: 'u-admin', role: 'user' }),
  store: () => actor.fromUser({ id: 'u-store', role: 'user' }),
};
// No socket room: an embedded panel only ever polls.
const ns = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }) };

test.after(() => queue._resetForTests());

test('update is gated like install_apk', () => {
  assert.ok(guard.GATED_COMMANDS.update, 'update must be in GATED_COMMANDS');
  assert.ok(guard.GATED_COMMANDS.install_apk);
});

test('a store editor cannot queue a firmware update for a head-office-controlled embedded panel', () => {
  const d = s.device(store);
  s.mandate(org, 'device', d, { playlist_id: P });
  const panel = { id: d, workspace_id: store, client_type: 'embedded', power_source: 'usb' };
  try {
    const r = deliverCommand(ns, panel, 'update', {}, { actor: A.store() });
    assert.equal(r.status, 'refused');
    assert.equal(r.code, 'CORPORATE_DEVICE_CONTROL');
    assert.deepEqual(queue.peekPendingCommands(d), [], 'nothing was queued');

    // The organization's admin still can.
    const ok = deliverCommand(ns, panel, 'update', {}, { actor: A.admin() });
    assert.equal(ok.status, 'queued');
    assert.deepEqual(queue.peekPendingCommands(d).map((c) => c.type), ['update']);
  } finally {
    db.prepare('DELETE FROM corporate_mandates').run();
    queue.popPendingCommands(d);
  }
});
