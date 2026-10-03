'use strict';

/*
 * How a hub presents borrowed data.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO PREVENT IS A CONFIDENT WRONG ANSWER. A hub is reporting on machines
 * it does not control, over links that break independently of them, and the tempting simplification —
 * online or offline — forces a lie whenever the LINK is what failed. Everything below is about
 * keeping "I do not currently know" available as an answer, and making it legible.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const hv = require('../lib/mesh/hub-view');

const NOW = 1_700_000_000;
const liveEdge = (over = {}) => ({ id: 'e1', peer_node_id: 'n1', last_sync_at: NOW - 30,
                                   revoked_at: null, ...over });
const row = (over = {}) => ({ device_id: 'd1', name: 'Lobby', status: 'online',
                              received_at: NOW - 30, ...over });

// ===== tri-state =====

test('⚠️ THE CASE THAT MATTERS: a dead LINK does not turn healthy screens red', () => {
  /*
   * A WAN blip on one hub link would otherwise paint 400 working screens as offline and dispatch an
   * engineer to a site where nothing is wrong. The screens were fine; the observer went blind.
   */
  const staleLink = liveEdge({ last_sync_at: NOW - 3600 });
  const v = hv.deviceStatus(row({ status: 'online' }), staleLink, NOW);

  assert.equal(v.status, hv.STATUS.STALE, 'not "down" — we simply cannot see');
  assert.notEqual(v.status, hv.STATUS.DOWN);
  assert.equal(v.asOf, NOW - 30, 'and it says how old the last word was');
  assert.match(v.explain, /not currently reachable/i);
  assert.match(v.explain, /check the connection to the site before the screen/i,
    'the explanation must point at the network, not the screen');
});

test('a screen reported offline by a REACHABLE node is a real fault', () => {
  // The other half: when the link is fine, "offline" means the screen. This is the one that should
  // send somebody to look at hardware.
  const v = hv.deviceStatus(row({ status: 'offline' }), liveEdge(), NOW);
  assert.equal(v.status, hv.STATUS.DOWN);
  assert.match(v.explain, /fault is at the screen/i);
});

test('a healthy screen over a healthy link is live', () => {
  const v = hv.deviceStatus(row(), liveEdge(), NOW);
  assert.equal(v.status, hv.STATUS.LIVE);
  assert.equal(v.explain, null, 'nothing to explain when everything is working');
});

test('the LINK is judged before the row, always', () => {
  /*
   * ⚠️ Order matters. If the row were trusted first, a device that went offline AFTER the link
   * dropped would be reported online indefinitely, and one that recovered would never be seen to.
   */
  const staleLink = liveEdge({ last_sync_at: NOW - 7200 });
  for (const status of ['online', 'offline', 'unknown']) {
    assert.equal(hv.deviceStatus(row({ status }), staleLink, NOW).status, hv.STATUS.STALE,
      `a stale link must mask a row claiming "${status}"`);
  }
});

test('a never-synced node is UNKNOWN, not stale and not down', () => {
  // A link that has not started is not a link that failed; calling it either sends someone
  // debugging something that is merely new.
  const v = hv.deviceStatus(row(), liveEdge({ last_sync_at: null }), NOW);
  assert.equal(v.status, hv.STATUS.UNKNOWN);
  assert.match(v.explain, /has not synced yet/i);
});

test('a revoked edge is stale, never live', () => {
  const v = hv.deviceStatus(row(), liveEdge({ revoked_at: NOW - 10 }), NOW);
  assert.equal(v.status, hv.STATUS.STALE);
});

test('⚠️ EVEN A HEALTHY ROW CARRIES ITS AGE', () => {
  /*
   * A green dot with no timestamp is a claim about the present that may be ninety minutes old, and
   * the reader cannot tell. Attaching the age to every row — not only the stale ones — is what makes
   * the display honest rather than usually-right.
   */
  const v = hv.withAsOf(hv.deviceStatus(row({ received_at: NOW - 45 }), liveEdge(), NOW), NOW);
  assert.equal(v.status, hv.STATUS.LIVE);
  assert.equal(v.asOfAgeSec, 45);
});

// ===== rollup =====

test('a stale node reports online count as NULL, not zero', () => {
  /*
   * ⚠️ Zero is a measurement. "We cannot see" is not, and rendering it as 0/40 tells an operator
   * every screen at that site is down — the same lie as painting them red, moved into a summary.
   */
  const devices = [{ status: 'online' }, { status: 'online' }, { status: 'offline' }];
  const stale = hv.nodeRollup({
    node: { origin_node_id: 'n1', node_version: '2.0.0', received_at: NOW - 4000 },
    edge: liveEdge({ last_sync_at: NOW - 4000 }), devices, openAlerts: 2,
  }, NOW);

  assert.equal(stale.devicesOnline, null);
  assert.equal(stale.devicesTotal, 3, 'the total is still known — it is the last inventory');
  assert.equal(stale.stale, true);

  const live = hv.nodeRollup({
    node: { origin_node_id: 'n1', node_version: '2.0.0', received_at: NOW - 10 },
    edge: liveEdge(), devices, openAlerts: 2,
  }, NOW);
  assert.equal(live.devicesOnline, 2);
});

// ===== time =====

test('⚠️ LIVE views use the OPERATOR zone, REPORTS use the ORIGIN zone', () => {
  /*
   * Two different correct answers. "Offline since 3pm" must mean 3pm to the person deciding whether
   * to phone someone. But a store manager's downtime happened during THEIR business hours — bucketing
   * Perth's October by Kenosha days makes every uptime figure quietly wrong with nothing on screen to
   * explain it.
   */
  const zones = { operatorTz: 'America/Chicago', originTz: 'Australia/Perth' };
  assert.equal(hv.zoneFor('live', zones), 'America/Chicago');
  assert.equal(hv.zoneFor('report', zones), 'Australia/Perth');
  assert.equal(hv.zoneFor('history', zones), 'Australia/Perth');
});

test('the zone is always LABELLED, because an unlabelled timestamp is a guess', () => {
  assert.match(hv.timeLabel('live', 'America/Chicago'), /your local zone/i);
  assert.match(hv.timeLabel('report', 'Australia/Perth'), /site's local zone/i);
  for (const ctx of ['live', 'report']) {
    assert.match(hv.timeLabel(ctx, 'Australia/Perth'), /Australia\/Perth/,
      'and it names the zone rather than merely claiming one');
  }
});

test('a missing zone falls back rather than silently rendering UTC as local', () => {
  assert.equal(hv.zoneFor('report', { operatorTz: 'America/Chicago' }), 'America/Chicago');
  assert.equal(hv.zoneFor('live', {}), 'UTC');
});

// ===== search and pagination =====

test('⚠️ pagination is CAPPED server-side, whatever the caller asks for', () => {
  // Fine at 40 devices, fatal at 10,000 — and the hub is the one place the whole fleet lands in one
  // table. A caller passing limit=100000 must not be able to ask for the fleet in one response.
  assert.equal(hv.deviceQuery({ limit: 100000 }).limit, hv.MAX_PAGE, 'a huge ask is capped');
  assert.equal(hv.deviceQuery({}).limit, hv.DEFAULT_PAGE);

  /*
   * ⚠️ Nonsense gets ONE answer. An earlier version clamped 0 to the default and -5 to 1 — two
   * behaviours for the same class of bad input, where a caller with an off-by-one would get a single
   * row back and conclude the fleet was empty.
   */
  for (const nonsense of [0, -5, NaN, null, 'abc', undefined]) {
    assert.equal(hv.deviceQuery({ limit: nonsense }).limit, hv.DEFAULT_PAGE,
      `limit=${String(nonsense)} should fall back to the default, not to 1`);
  }
  assert.match(hv.deviceQuery({}).sql, /LIMIT \? OFFSET \?/);
});

test('search is parameterised and escapes LIKE wildcards', () => {
  // A device literally named "100%" must not become a match-everything pattern.
  const q = hv.deviceQuery({ search: '100%_x' });
  assert.match(q.sql, /d\.name LIKE \? OR d\.device_id LIKE \?/);
  assert.ok(q.params[0].includes('\\%'), 'a literal % is escaped');
  assert.ok(q.params[0].includes('\\_'), 'and so is a literal _');
  assert.ok(!q.sql.includes('100%'), 'the term never reaches the SQL text');
});

test('search covers the id, because a health-only grant has no name to search', () => {
  const q = hv.deviceQuery({ search: 'abc' });
  assert.match(q.sql, /d\.device_id LIKE \?/,
    'devices with no granted name must still be findable somehow');
});

test('tombstoned devices never appear in a live list', () => {
  assert.match(hv.deviceQuery({}).sql, /d\.deleted_at IS NULL/);
});

test('a count query accompanies the page, so the UI can say how many there are', () => {
  const q = hv.deviceQuery({ search: 'lobby' });
  assert.match(q.countSql, /COUNT\(\*\)/);
  assert.equal(q.countParams.length, 2, 'and it takes the filter params without the paging ones');
});

// ===== deep links =====

test('a deep link points back at the node that owns the object', () => {
  /*
   * ⚠️ This is what lets the hub stay READ-ONLY and still be useful. Without it every remote row is a
   * dead end, and the only way to act is to widen the hub's permissions — which is how a read-only
   * observer becomes a control plane by accident.
   */
  const link = hv.deepLink({ peer_url: 'https://acme.example.com/' }, 'device', 'dev 1');
  // /app is part of the path: `/` is the marketing page and never sees the hash, so a deep link
  // without it dropped the operator on that node's front door.
  assert.equal(link, 'https://acme.example.com/app#/devices/dev%201', 'and the id is encoded');
});

test('an unknown address yields NO link rather than a guessed one (I9)', () => {
  assert.equal(hv.deepLink({ peer_url: null }, 'device', 'd1'), null);
  assert.equal(hv.deepLink(null, 'device', 'd1'), null);
});
