'use strict';

/*
 * #790: "the slide reloads on every sync, even when the API returns the same data".
 *
 * A slide bound to a data source reloads when its widget revision (widgets.updated_at) moves, and
 * that moves only when a sync CHANGES the cached data. These tests run the real sync path (only the
 * network is stubbed) and pin both halves:
 *   - an identical response, synced again and again, never moves the revision (REST stamps an
 *     `updated` time on every fetch; that alone must not count as a change);
 *   - a response that does change reports WHICH variables changed, so an operator can see the
 *     timestamp or request id that makes a "mostly the same" API reload the slide every sync.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-ds-change-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-ds-change';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const types = require('../lib/data-sources/builtin-types');
const rest = require('../lib/data-sources/rest-resolver');

let BODY = '{}';
types.getBuiltinType('rest').resolve = (cfg, ctx) => rest.resolveRest(cfg, {
  ...ctx,
  fetcher: async () => ({ text: BODY, contentType: 'application/json', status: 200 }),
});
const svc = require('../lib/data-sources/service');

const rev = (id) => db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(id).updated_at;

before(() => {
  const org = 'org-' + crypto.randomBytes(3).toString('hex');
  const owner = 'u-' + crypto.randomBytes(3).toString('hex');
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'ds790@t.local', 'x', 'user')").run(owner);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(org, 'O', owner);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-790', ?, 'W')").run(org);
  for (const [id, shape] of [['ds-obj', 'auto'], ['ds-tbl', 'table']]) {
    db.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config) VALUES (?, 'ws-790', ?, ?, 'rest', ?)")
      .run(id, id, id, JSON.stringify({ url: 'https://example.com/feed.json', shape }));
    db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config, updated_at) VALUES (?, 'ws-790', 'slide', 'S', ?, 100)")
      .run('w-' + id, JSON.stringify({ text: `{{ds:${id}.status}}` }));
  }
});

for (const id of ['ds-obj', 'ds-tbl']) {
  test(`${id}: the same response synced repeatedly never moves the slide's revision`, async () => {
    BODY = JSON.stringify(id === 'ds-tbl' ? [{ room: 'A', status: 'open' }] : { status: 'open', temp: 21 });
    const first = await svc.syncDataSource(id, true);
    assert.equal(first.changed, true, 'the first sync fills an empty cache');
    const r0 = rev('w-' + id);
    // A later wall-clock second, so a fresh `updated` stamp WOULD differ if it were kept.
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 2; i++) {
      const again = await svc.syncDataSource(id, true);
      assert.equal(again.changed, false);
      assert.deepEqual(again.changed_keys, []);
    }
    assert.equal(rev('w-' + id), r0, 'no new revision, so no player reload');
  });
}

test('a changed response names the variables that changed, and moves the revision', async () => {
  BODY = JSON.stringify({ status: 'open', temp: 21 });
  await svc.syncDataSource('ds-obj', true);
  const r0 = rev('w-ds-obj');
  await new Promise((r) => setTimeout(r, 1100));
  BODY = JSON.stringify({ status: 'open', temp: 21, request_id: 'abc123' });
  const out = await svc.syncDataSource('ds-obj', true);
  assert.equal(out.changed, true);
  assert.ok(out.changed_keys.includes('request_id'), out.changed_keys.join(','));
  assert.ok(!out.changed_keys.includes('status') && !out.changed_keys.includes('temp'));
  assert.ok(rev('w-ds-obj') > r0, 'a real change reaches the screen');
});

test('changedKeys: added, removed and modified keys; capped; tolerant of a bad cache', () => {
  assert.deepEqual(svc.changedKeys(JSON.stringify({ a: 1, b: 2, c: 3 }), { a: 1, b: 9, d: 4 }), ['b', 'd', 'c']);
  assert.deepEqual(svc.changedKeys(null, { a: 1 }), ['a']);
  assert.deepEqual(svc.changedKeys('not json', { a: 1 }), ['a']);
  const big = {};
  for (let i = 0; i < 50; i++) big['k' + i] = i;
  assert.equal(svc.changedKeys('{}', big).length, 10);
});
