'use strict';

/*
 * Disenrollment, and what the observed side gets to see while the link lasts.
 *
 * ⚠️ THE ASYMMETRY THIS RESISTS. The parent gets a topology view and an alert inbox, so the parent's
 * UI is the one that naturally gets built. The child's view protects the person who did not ask for
 * any of this — and an MSP link a client cannot see or sever is a contract dispute waiting to happen.
 * In the ordinary case it is also what makes a client comfortable agreeing in the first place.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consentView, disenroll, onParentLost, STALE_AFTER_MS } = require('../lib/mesh/edge-status');

const T0 = 1_700_000_000_000;
const upEdge = (over = {}) => ({
  id: 'e1', direction: 'up', peer_node_id: 'hub-1',
  grant_categories: ['health', 'identity'],
  last_sync_at: T0, revoked_at: null, ...over,
});

// ===== consent, from below =====

test('the child can see exactly what its parent can see, in plain language', () => {
  /*
   * ⚠️ Category NAMES tell a client nothing they can evaluate. "whether your screens are up" is a
   * sentence they can agree or object to. The wording comes from grants.js so it cannot drift from
   * what is actually enforced.
   */
  const v = consentView(upEdge(), T0);
  assert.equal(v.parentNodeId, 'hub-1');
  assert.deepEqual(v.sharing, ['health', 'identity']);
  assert.equal(v.sharingExplained.length, 2);
  for (const line of v.sharingExplained) {
    assert.ok(line.length > 20, 'each consequence must be a sentence, not a label');
  }
});

test('a grant of nothing says so, rather than showing an empty list', () => {
  // An empty list reads as "not loaded yet". It has to say what it means.
  const v = consentView(upEdge({ grant_categories: [] }), T0);
  assert.equal(v.sharingExplained.length, 1);
  assert.match(v.sharingExplained[0], /no data about it will be shared/i);
});

test('the child can always sever, and is told the parent cannot control it', () => {
  /*
   * "Can this hub change what plays on my screens?" is the question a client actually asks, and the
   * answer is only reassuring if it is written where they can read it.
   */
  const v = consentView(upEdge(), T0);
  assert.equal(v.canRevoke, true, 'severing is not a permission the parent grants');
  assert.equal(v.parentCanControlThisNode, false);
});

test('⚠️ "never synced" is not "stale"', () => {
  /*
   * A brand-new link that has not synced yet is not unhealthy — it has not started. Calling it stale
   * sends a client debugging something that is merely new.
   */
  const fresh = consentView(upEdge({ last_sync_at: null }), T0);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastSyncAt, null);

  const recent = consentView(upEdge({ last_sync_at: T0 - 1000 }), T0);
  assert.equal(recent.stale, false);

  const old = consentView(upEdge({ last_sync_at: T0 - STALE_AFTER_MS - 1 }), T0);
  assert.equal(old.stale, true, 'a link that HAS synced and then went quiet is stale');
});

test('a revoked link is shown as unlinked, and cannot be revoked twice', () => {
  const v = consentView(upEdge({ revoked_at: T0 }), T0);
  assert.equal(v.linked, false);
  assert.equal(v.revokedAt, T0);
  assert.equal(v.canRevoke, false);
});

test('the consent view is for the child; a downward edge has none', () => {
  // A parent looking at its own child edge is a different screen with different questions.
  assert.equal(consentView({ ...upEdge(), direction: 'down' }, T0), null);
  assert.equal(consentView(null, T0), null);
});

// ===== disenrollment =====

test('THE DEFAULT: severing keeps history and stops the flow', () => {
  /*
   * ⚠️ Deleting on disconnect is the intuitive behaviour and it is wrong. Last month's uptime report
   * would silently change because somebody disconnected a client today — and a report that rewrites
   * itself cannot be cited in an invoice dispute.
   */
  const r = disenroll(upEdge(), { by: 'child', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.edge.revoked_at, T0);
  assert.equal(r.edge.mirrored_state, 'retained-stale');
  assert.match(r.summary, /kept and marked\s+stale/i);
  assert.match(r.summary, /purge it separately/i, 'and it must say how to actually remove it');
});

test('purge is available but is a separate, explicit decision', () => {
  // The client's right to removal is real; it is just not a side effect of clicking disconnect.
  const r = disenroll(upEdge(), { by: 'child', now: T0, purge: true });
  assert.equal(r.edge.mirrored_state, 'purge-requested');
  assert.match(r.summary, /Reports that included this node will change/i,
    'the consequence must be stated before it happens, not discovered afterwards');
});

test('either side may sever, and which side did it is recorded', () => {
  for (const by of ['parent', 'child']) {
    const r = disenroll(upEdge(), { by, now: T0, reason: 'contract ended' });
    assert.equal(r.ok, true);
    assert.equal(r.edge.revoked_by, by);
    assert.equal(r.edge.revoked_reason, 'contract ended');
  }
  // An unattributed disconnection is refused: "who ended this" is the first question afterwards.
  assert.equal(disenroll(upEdge(), { by: 'nobody', now: T0 }).ok, false);
});

test('severing twice is refused rather than silently re-stamped', () => {
  const r = disenroll(upEdge({ revoked_at: T0 - 5000 }), { by: 'child', now: T0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already disconnected/i);
});

// ===== losing a parent =====

test('losing a parent is silent and changes nothing about how the node runs (I1)', () => {
  /*
   * ⚠️ Losing an OBSERVER is not an incident. Raising an alarm for it trains an operator to ignore
   * alarms, and the node is by definition still doing its job — scheduling, playback, local alerting
   * and the local dashboard are untouched.
   */
  const s = onParentLost(upEdge({ last_sync_at: T0 - 60_000 }), T0);
  assert.equal(s.stillFullyFunctional, true);
  assert.equal(s.alarm, false, 'a lost observer must not raise an alarm');
  assert.equal(s.buffering, true, 'observations are held for backfill when the link returns');
  assert.equal(s.connectionView.parentNodeId, 'hub-1', 'it IS surfaced — in the connection view');
});

// ===== the NOC state of a down link =====

test('⚠️ a telemetry-only child that reported a minute ago is CONNECTED (the NOC drew it down since #399)', () => {
  const { childLinkState } = require('../lib/mesh/edge-status');
  const now = 1_800_000_000;   // unix seconds, like the stored column
  const edge = (over = {}) => ({ id: 'e2', direction: 'down', peer_node_id: 'bs-1', revoked_at: null, last_sync_at: now - 54, ...over });
  assert.equal(childLinkState(edge(), null, now), 'connected');
  assert.equal(childLinkState(edge({ last_sync_at: now - 601 }), null, now), 'down', 'quiet past 10 minutes');
  assert.equal(childLinkState(edge({ last_sync_at: null }), null, now), 'down', 'never reported');
  assert.equal(childLinkState(edge({ revoked_at: now - 5 }), null, now), 'revoked');
});

test('a replicating child is judged by its replica row, not by when it last reported', () => {
  const { childLinkState } = require('../lib/mesh/edge-status');
  const now = 1_800_000_000;
  const e = { id: 'e3', revoked_at: null, last_sync_at: null };
  assert.equal(childLinkState(e, { edge: 'up', lag_s: 3 }, now), 'connected');
  assert.equal(childLinkState(e, { edge: 'up', lag_s: 61 }, now), 'lagging');
  assert.equal(childLinkState(e, { edge: 'down', lag_s: null }, now), 'down');
});
