'use strict';

/*
 * Per-client roles on a hub.
 *
 * The requirement is an MSP one: "read-only on Acme, full on Contoso". The subtlety is that in 2.0 a
 * hub CANNOT write to a client's screens at all — invariant I2 makes the mesh upward-only — so the
 * axis that genuinely differs per client is not read versus write on their data, it is who may change
 * the RELATIONSHIP: retention, token rotation, disenrollment, which nodes belong to whom.
 *
 * A tech who can view Acme's screens is a very different risk from one who can sever Acme's edge, and
 * that is the distinction a client asks about when they ask who at the MSP can do what.
 *
 * See docs/mesh-phase0-design.md.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const roles = require('../lib/mesh/client-roles');

const rowFor = (role) => ({ client_id: 'c1', user_id: 'u1', role });
const tech = { id: 'u1', role: 'user' };
const admin = { id: 'u0', role: 'platform_admin' };

test('a viewer sees the client and cannot touch the connection', () => {
  assert.equal(roles.userMay(rowFor('viewer'), tech, 'view-mirrored-data'), true);
  for (const action of ['manage-edge', 'disenroll', 'assign-nodes']) {
    assert.equal(roles.userMay(rowFor('viewer'), tech, action), false,
      `a viewer must not be able to ${action}`);
  }
});

test('a manager sees the client and may change the connection — but not their screens', () => {
  /*
   * ⚠️ This used to loop over EVERY action and assert manager could do all of them, which was true
   * while manager was the top role and became a false claim the moment a higher one existed. The
   * distinction is the interesting part: managing the CONNECTION (retention, TLS, severing) is a
   * different conversation with a client from changing what their screens SHOW.
   */
  for (const action of ['view-mirrored-data', 'manage-edge', 'disenroll', 'assign-nodes']) {
    assert.equal(roles.userMay(rowFor('manager'), tech, action), true,
      `a manager should be able to ${action}`);
  }
  for (const action of ['push-content', 'command-devices']) {
    assert.equal(roles.userMay(rowFor('manager'), tech, action), false,
      `a manager must NOT be able to ${action} — that is the publisher role`);
  }
});

test('⚠️ publisher outranks manager, because a wall is more visible than a severed link', () => {
  assert.ok(roles.ROLES.publisher.rank > roles.ROLES.manager.rank,
    'severing an edge is disruptive and reversible; putting the wrong thing on a hospital wall is ' +
    'neither, and nobody at the MSP may notice');
  for (const action of roles.ACTIONS) {
    assert.equal(roles.userMay(rowFor('publisher'), tech, action), true,
      `a publisher should be able to ${action}`);
  }
});

test('⚠️ the two write actions are SEPARATE — one does not confer the other', () => {
  // A tech reloading a stuck screen is not the same permission as changing what it shows.
  assert.ok(roles.ACTIONS.includes('push-content'));
  assert.ok(roles.ACTIONS.includes('command-devices'));
  assert.notEqual('push-content', 'command-devices');
  assert.equal(roles.roleAllows('viewer', 'push-content'), false);
  assert.equal(roles.roleAllows('viewer', 'command-devices'), false);
});

test('THE POINT: access to one client says nothing about another', () => {
  // "read-only on Acme, full on Contoso" — the whole reason this table has a role column.
  const onAcme = rowFor('viewer');
  const onContoso = rowFor('manager');
  assert.equal(roles.userMay(onAcme, tech, 'disenroll'), false);
  assert.equal(roles.userMay(onContoso, tech, 'disenroll'), true);
});

test('no access row means no access at all', () => {
  /*
   * ⚠️ Default deny BY ABSENCE. A newly created client is invisible until somebody is named on it.
   * Visible-unless-denied would expose every new client to every tech the moment it is created, which
   * is the wrong direction for a mistake to fail in.
   */
  assert.equal(roles.effectiveRole(null, tech), null);
  assert.equal(roles.userMay(null, tech, 'view-mirrored-data'), false,
    'a tech with no row must not even see that the client exists');
  assert.equal(roles.userMay(undefined, tech, 'view-mirrored-data'), false);
});

test('an unrecognised role grants nothing rather than falling back to the lowest one', () => {
  /*
   * A typo, a hand-edited row, or a row written by a newer version must not grant anything. Falling
   * back to "viewer" would feel forgiving and would still hand over a client's data.
   */
  for (const bad of ['admin', 'owner', 'VIEWER', '', null, undefined, 'manger']) {
    assert.equal(roles.effectiveRole(rowFor(bad), tech), null, `role "${bad}" must not resolve`);
    assert.equal(roles.userMay(rowFor(bad), tech, 'view-mirrored-data'), false);
  }
});

test('an unrecognised action is refused, not waved through', () => {
  // A caller checking a permission this module has never heard of has almost certainly mistyped it.
  assert.equal(roles.roleAllows('manager', 'delete-everything'), false);
  assert.equal(roles.roleAllows('manager', 'view_mirrored_data'), false, 'underscores are a typo, not a synonym');
});

test('platform_admin is not contained, and that is deliberate', () => {
  /*
   * The instance owner can edit the database and grant themselves any row; pretending otherwise would
   * be theatre that complicates the code without protecting anyone. What the model DOES deliver is
   * the property a client actually asks about — that an ordinary technician sees the clients they
   * were named on and no others, which the tests above pin.
   */
  assert.equal(roles.effectiveRole(null, admin), 'manager');
  assert.equal(roles.userMay(null, admin, 'disenroll'), true);
});

test('⚠️ a write action is never held by INHERITANCE, only by a direct row', () => {
  /*
   * ⚠️ REPLACES "no role promises write access". That guard asserted an ABSENCE that was correct
   * while there was no write channel, and deleting it to add one would have removed the only thing
   * watching this file. The property that has to survive is narrower and more useful: a role may
   * now name a write action, but holding it through the client TREE must not be enough.
   *
   * Read access inherits on purpose — naming somebody on every client is toil nobody keeps up with,
   * and whoGainsAccess exists so inheritance is never silent. Write is a different magnitude:
   * dragging a client under "West Region" would otherwise hand the ability to change a hospital's
   * screens to everyone holding that region, in one drag, with nobody named.
   */
  for (const name of roles.ROLE_NAMES) {
    for (const action of roles.ROLES[name].can) {
      assert.ok(roles.ACTIONS.includes(action), `${name} claims unknown action ${action}`);
    }
  }
  assert.deepEqual([...roles.DIRECT_ONLY_ACTIONS].sort(), ['command-devices', 'push-content'],
    'every write action must be direct-only; a new one added without this is inheritable by default');
  for (const a of roles.ACTIONS) {
    const isWrite = /^(push-content|command-devices)$/.test(a);
    assert.equal(roles.requiresDirectAccess(a), isWrite,
      `${a}: write actions require a direct row, read actions may inherit`);
  }
});

test('assigning an unknown role is refused with a readable reason', () => {
  const bad = roles.validateRole('superuser');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not a client role/i);
  // The refusal must tell an operator what they CAN pick, not merely that they were wrong.
  for (const r of roles.ROLE_NAMES) assert.match(bad.reason, new RegExp(r));
  assert.equal(roles.validateRole('manager').ok, true);
});

test('the schema carries the role column and defaults it to the safer one', () => {
  /*
   * ⚠️ Runs in a child process: config.js resolves DATA_DIR once at load, so setting it from inside a
   * running suite lands the schema in the developer's real data directory.
   */
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-roles-'));
  try {
    const probe = `
      require('./db/database.js');
      const { Database } = require('./db/sqlite-driver');
      const db = new Database(require('path').join(process.env.DATA_DIR, 'db', 'remote_display.db'));
      const cols = db.prepare("select name, dflt_value from pragma_table_info('mesh_client_access')").all();
      db.close();
      console.log('PROBE=' + JSON.stringify(cols));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test' },
    });
    const line = out.split('\n').find((l) => l.startsWith('PROBE='));
    assert.ok(line, `probe produced no result:\n${out.slice(-400)}`);
    const cols = JSON.parse(line.slice('PROBE='.length));

    const role = cols.find((c) => c.name === 'role');
    assert.ok(role, 'mesh_client_access must carry a role column');
    assert.match(String(role.dflt_value), /viewer/,
      'the default must be the LESSER role — a row written without one must not confer management');
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
