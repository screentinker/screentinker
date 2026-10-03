'use strict';

/*
 * Nested clients, and access resolved through the nesting.
 *
 * ⚠️ THE TENSION THESE EXIST TO PIN. client-roles.js guarantees a new client is invisible until
 * somebody is explicitly named on it. Inheritance breaks that by construction — put a client under
 * West Region and everyone holding West Region can see it, with nobody naming them.
 *
 * Both properties are worth keeping, so the design does not pick one: inherited access is allowed but
 * must never be SILENT. Every resolution carries its provenance, and `whoGainsAccess` answers "who is
 * about to be able to see this" BEFORE the move is saved. The tests below hold that line — the ones
 * that matter most are the provenance and disclosure cases, not the happy path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tree = require('../lib/mesh/client-tree');
const roles = require('../lib/mesh/client-roles');

/* A small MSP: holding -> west -> acme, and west -> contoso. */
const PARENTS = {
  holding: null,
  west: 'holding',
  acme: 'west',
  contoso: 'west',
  solo: null,
};
const getParentId = (id) => (id in PARENTS ? PARENTS[id] : null);
const childrenOf = (id) => Object.keys(PARENTS).filter((k) => PARENTS[k] === id);
const subtreeDepthBelow = (id) => {
  const kids = childrenOf(id);
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(subtreeDepthBelow));
};

const accessTable = (rows) => (clientId, userId) =>
  rows.find((r) => r.client_id === clientId && r.user_id === userId) || null;
const listFor = (rows) => (clientId) => rows.filter((r) => r.client_id === clientId);

const tech = { id: 'u1', role: 'user' };
const admin = { id: 'u0', role: 'platform_admin' };

// ===== the chain =====

test('the ancestor chain runs from the client up to the root', () => {
  assert.deepEqual(tree.ancestorChain('acme', getParentId), ['acme', 'west', 'holding']);
  assert.deepEqual(tree.ancestorChain('solo', getParentId), ['solo']);
});

test('a cycle in STORED data stops the walk instead of hanging a request', () => {
  /*
   * ⚠️ Defends against bad data, not just bad input. A row edited by hand — or written before the
   * validation existed — would otherwise spin forever, and this runs inside permission checks, so it
   * would hang a request rather than fail one.
   */
  const looped = { a: 'b', b: 'c', c: 'a' };
  const chain = tree.ancestorChain('a', (id) => looped[id] || null);
  assert.deepEqual(chain, ['a', 'b', 'c'], 'each node once, then stop');
});

// ===== placing a client =====

test('a client cannot be its own parent, nor create a loop at any distance', () => {
  assert.equal(tree.validateParent('acme', 'acme', getParentId).ok, false);

  // ⚠️ A GRANDPARENT loop — what actually happens when someone reorganises by dragging. A one-level
  // or prefix check would miss this, which is why refusal is by reachability (same as mesh I3).
  const bad = tree.validateParent('holding', 'acme', getParentId, subtreeDepthBelow);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /loop in the client hierarchy/i);
  assert.match(bad.reason, /Move it out from under/i, 'the refusal must say what to do about it');
});

test('depth is measured for the deepest leaf, not the client being moved', () => {
  /*
   * Attaching a whole subtree can breach the cap even when the client being moved would not — this is
   * the case a naive depth check gets wrong, and it fails only for the customer with the deepest tree.
   */
  const deepParents = { l1: null, l2: 'l1', l3: 'l2', movable: null, kid: 'movable' };
  const gp = (id) => (id in deepParents ? deepParents[id] : null);
  const kidsOf = (id) => Object.keys(deepParents).filter((k) => deepParents[k] === id);
  const below = (id) => {
    const k = kidsOf(id);
    return k.length === 0 ? 0 : 1 + Math.max(...k.map(below));
  };

  // 'movable' alone under l3 would be depth 4 — allowed. With its child it is 5 — refused.
  const v = tree.validateParent('movable', 'l3', gp, below);
  assert.equal(v.ok, false);
  assert.match(v.reason, new RegExp(`limited to ${tree.MAX_CLIENT_DEPTH} levels`));
  assert.match(v.reason, /would make 5/);

  const leafOk = tree.validateParent('leafy', 'l3', gp, () => 0);
  assert.equal(leafOk.ok, true, 'a leaf at the same position is fine');
});

test('un-parenting is always allowed', () => {
  assert.equal(tree.validateParent('acme', null, getParentId).ok, true);
});

// ===== resolution =====

test('access on a region reaches the clients under it', () => {
  // The reason to nest at all: name a tech once, not on every client as it is won.
  const rows = [{ client_id: 'west', user_id: 'u1', role: 'viewer' }];
  const r = tree.resolveAccess('acme', tech, getParentId, accessTable(rows), roles);
  assert.equal(r.role, 'viewer');
  assert.equal(r.source, 'inherited');
  assert.equal(r.viaClientId, 'west');
});

test('THE PROVENANCE RULE: a role never comes back without saying where it came from', () => {
  /*
   * There is deliberately no way to ask "what is my role" and get a bare answer. A UI that cannot
   * distinguish direct access from inherited access cannot warn anyone about the second, and the
   * warning is the entire reason inheritance is acceptable here.
   */
  const rows = [
    { client_id: 'acme', user_id: 'u1', role: 'manager' },
    { client_id: 'west', user_id: 'u2', role: 'viewer' },
  ];
  const direct = tree.resolveAccess('acme', tech, getParentId, accessTable(rows), roles);
  assert.equal(direct.source, 'direct');
  assert.equal(direct.viaClientId, null);

  const inherited = tree.resolveAccess('acme', { id: 'u2', role: 'user' }, getParentId, accessTable(rows), roles);
  assert.equal(inherited.source, 'inherited');
  assert.equal(inherited.viaClientId, 'west');

  const none = tree.resolveAccess('acme', { id: 'u9', role: 'user' }, getParentId, accessTable(rows), roles);
  assert.equal(none.role, null);
  assert.equal(none.source, 'none');
});

test('most-specific wins, so a child row can NARROW an inherited role', () => {
  /*
   * manager across West Region but viewer on the one client under NDA. An inherit-the-maximum model
   * cannot express this, and it is the case an MSP will actually hit.
   */
  const rows = [
    { client_id: 'west', user_id: 'u1', role: 'manager' },
    { client_id: 'acme', user_id: 'u1', role: 'viewer' },
  ];
  const onAcme = tree.resolveAccess('acme', tech, getParentId, accessTable(rows), roles);
  assert.equal(onAcme.role, 'viewer', 'the nearer row wins even though it grants less');
  assert.equal(tree.userMayThroughTree('acme', tech, 'disenroll', getParentId, accessTable(rows), roles), false);

  // ...and the broader role still applies to the sibling.
  assert.equal(tree.userMayThroughTree('contoso', tech, 'disenroll', getParentId, accessTable(rows), roles), true);
});

test('an unrecognised role STOPS the walk rather than falling through to a broader one', () => {
  /*
   * ⚠️ The subtle escalation. If a typo'd row on the client were merely skipped, the walk would
   * continue up and hand the user the BROADER inherited role — turning a mistake into more access
   * than anyone intended. Failing closed at the nearest row is the safe reading.
   */
  const rows = [
    { client_id: 'west', user_id: 'u1', role: 'manager' },
    { client_id: 'acme', user_id: 'u1', role: 'viewr' },   // typo
  ];
  const r = tree.resolveAccess('acme', tech, getParentId, accessTable(rows), roles);
  assert.equal(r.role, null, 'a broken row must not silently promote to the parent role');
  assert.equal(r.source, 'none');
});

test('no row anywhere in the chain means no access', () => {
  const r = tree.resolveAccess('acme', tech, getParentId, accessTable([]), roles);
  assert.equal(r.role, null);
  assert.equal(tree.userMayThroughTree('acme', tech, 'view-mirrored-data', getParentId, accessTable([]), roles), false);
});

test('platform_admin resolves everywhere, and says so', () => {
  const r = tree.resolveAccess('acme', admin, getParentId, accessTable([]), roles);
  assert.equal(r.role, 'manager');
  assert.equal(r.source, 'platform-admin', 'the provenance must not be mistaken for a real grant row');
});

// ===== disclosure =====

test('THE DISCLOSURE PRIMITIVE: who gains access before the move is saved', () => {
  /*
   * This is what keeps inheritance from being silent, and it is why the collision with
   * default-deny-by-absence is acceptable rather than a hole. The UI shows this and the operator
   * agrees to the consequence instead of discovering it later.
   */
  const rows = [
    { client_id: 'west', user_id: 'u1', role: 'viewer' },
    { client_id: 'holding', user_id: 'u2', role: 'manager' },
  ];
  const gained = tree.whoGainsAccess('solo', 'west', getParentId, listFor(rows));
  assert.deepEqual(gained.map((g) => g.user_id).sort(), ['u1', 'u2'],
    'everyone anywhere above the new parent gains access, not just the immediate one');
  assert.equal(gained.find((g) => g.user_id === 'u1').viaClientId, 'west');
  assert.equal(gained.find((g) => g.user_id === 'u2').viaClientId, 'holding');
});

test('someone who already has direct access is not reported as gaining it', () => {
  // Only the users for whom something actually changes — otherwise the warning cries wolf and gets
  // clicked through.
  const rows = [
    { client_id: 'west', user_id: 'u1', role: 'viewer' },
    { client_id: 'solo', user_id: 'u1', role: 'manager' },
  ];
  assert.deepEqual(tree.whoGainsAccess('solo', 'west', getParentId, listFor(rows)), []);
});

test('nearest ancestor wins in the disclosure too', () => {
  const rows = [
    { client_id: 'west', user_id: 'u1', role: 'viewer' },
    { client_id: 'holding', user_id: 'u1', role: 'manager' },
  ];
  const gained = tree.whoGainsAccess('solo', 'west', getParentId, listFor(rows));
  assert.equal(gained.length, 1);
  assert.equal(gained[0].role, 'viewer', 'the nearer role is the effective one, so report that');
  assert.equal(gained[0].viaClientId, 'west');
});

test('moving to the top level grants nobody anything', () => {
  const rows = [{ client_id: 'west', user_id: 'u1', role: 'viewer' }];
  assert.deepEqual(tree.whoGainsAccess('acme', null, getParentId, listFor(rows)), []);
});

/*
 * ⚠️ THE INSTANCE OWNER COULD NOT PUSH CONTENT TO THEIR OWN CLIENTS.
 *
 * resolveAccess short-circuited platform_admin to manager and never looked at the explicit access
 * row — the identical short-circuit that client-roles.effectiveRole had, fixed there and not here,
 * and everything that matters goes through this one.
 *
 * Two failures came out of that single line: the role was capped at manager, whose capabilities do
 * not include push-content, so a deliberate publisher row was read and discarded; and the source
 * came back 'platform-admin' rather than 'direct', so even an uncapped publisher would have failed
 * requiresDirectAccess — the rule that stops write inheriting down the client tree.
 *
 * ⚠️ FOUND BY RUNNING THREE REAL SERVERS AND PUSHING A FILE BETWEEN THEM, not by a test. Every test
 * in this file constructs the access row it wants, so none of them ever asked what an owner with a
 * publisher row actually resolves to.
 */
const OWNER = { id: 'u-owner', role: 'platform_admin' };
const TECH = { id: 'u-tech', role: 'user' };
const noParents = () => null;

test('⚠️ an owner with an explicit publisher row resolves to publisher, DIRECTLY', () => {
  const rows = { 'c1:u-owner': { role: 'publisher' } };
  const get = (cid, uid) => rows[`${cid}:${uid}`] || null;

  const r = tree.resolveAccess('c1', OWNER, noParents, get, roles);
  assert.equal(r.role, 'publisher', 'manager is the owner FLOOR, not a ceiling');
  assert.equal(r.source, 'direct',
    'a direct row must stay direct, or the write gate refuses it however good the role is');
  assert.ok(roles.roleAllows(r.role, 'push-content'));
  assert.ok(!(roles.requiresDirectAccess('push-content') && r.source !== 'direct'),
    'the two halves together are what the live push actually needs');
});

test('an owner with no row at all still sees the client, as manager', () => {
  // The floor is why an owner never loses sight of a client nobody named them on.
  const r = tree.resolveAccess('c1', OWNER, noParents, () => null, roles);
  assert.equal(r.role, 'manager');
  assert.equal(r.source, 'platform-admin');
});

test('an owner named at or below manager is not demoted by their own row', () => {
  const rows = { 'c1:u-owner': { role: 'viewer' } };
  const r = tree.resolveAccess('c1', OWNER, noParents, (cid, uid) => rows[`${cid}:${uid}`] || null, roles);
  assert.equal(r.role, 'manager', 'the floor applies only where it raises the answer');
});

test('⚠️ and none of this leaks to an ordinary technician', () => {
  // The floor is about the instance owner specifically. Everyone else is default-deny by absence.
  assert.equal(tree.resolveAccess('c1', TECH, noParents, () => null, roles).role, null);
  const rows = { 'c1:u-tech': { role: 'viewer' } };
  const r = tree.resolveAccess('c1', TECH, noParents, (cid, uid) => rows[`${cid}:${uid}`] || null, roles);
  assert.equal(r.role, 'viewer');
  assert.equal(roles.roleAllows(r.role, 'push-content'), false);
});

test('an owner with a malformed row still sees the client rather than being locked out', () => {
  const rows = { 'c1:u-owner': { role: 'not-a-role' } };
  const r = tree.resolveAccess('c1', OWNER, noParents, (cid, uid) => rows[`${cid}:${uid}`] || null, roles);
  assert.equal(r.role, 'manager', 'a typo must not lock the instance owner out of their own client');
});
