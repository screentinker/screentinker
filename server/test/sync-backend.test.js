'use strict';

// A group can only run the protocol its weakest member supports.
//
// BrightWall is BrightSign's native synchronisation: frame-accurate, and exclusive to BrightSign
// hardware. ScreenTinker's own group sync derives every member's position from a shared clock, so it
// spans Android, web, Tizen and BrightSign, survives a server outage, and syncs to the second rather
// than the frame.
//
// The trap this guards is the mixed group. Selecting native sync for a wall that contains one Android
// panel cannot work — and the failure would be invisible from the dashboard, because the BrightSigns
// would look perfectly synchronised while the odd panel drifted on its own. So that combination
// downgrades and reports why, instead of being accepted and half-applied.
//
// Kept pure: no fleet, no sockets, just device rows in and a decision out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSyncBackend, isBrightSignDevice, networksDiffer } = require('../lib/sync-backend');

const bs = (n = 1) => ({ id: `bs${n}`, platform: 'brightsign', name: `BrightSign ${n}` });
const android = { id: 'a1', platform: 'Android 12', name: 'Lobby tablet' };
const web = { id: 'w1', platform: 'Chrome 150', name: 'Test web' };

test('auto picks native sync when every display is a BrightSign', () => {
  const r = resolveSyncBackend('auto', [bs(1), bs(2), bs(3)]);
  assert.equal(r.backend, 'brightsign');
  assert.equal(r.downgraded, false);
});

test('auto falls back to our protocol the moment one member is not a BrightSign', () => {
  const r = resolveSyncBackend('auto', [bs(1), bs(2), android]);
  assert.equal(r.backend, 'screentinker');
  assert.equal(r.reason, 'not every display is a BrightSign');
  assert.equal(r.code, 'not_all_brightsign');
});

test('a group of identical web players is not called a "mixed fleet"', () => {
  // Seen filming the groups guide: three web players under Sync: Auto read "screentinker — mixed fleet".
  const r = resolveSyncBackend('auto', [web, { ...web, id: 'w2' }, { ...web, id: 'w3' }]);
  assert.equal(r.backend, 'screentinker');
  assert.doesNotMatch(r.reason, /mixed/);
  assert.equal(r.code, 'not_all_brightsign');
});

test('every decision carries a code the dashboard can translate (and a count where it says one)', () => {
  const cases = [
    [resolveSyncBackend('auto', [bs(1), bs(2)]), 'all_brightsign'],
    [resolveSyncBackend('auto', []), 'empty'],
    [resolveSyncBackend('screentinker', [bs(1)]), 'explicit'],
    [resolveSyncBackend('brightsign', [bs(1), bs(2)]), 'explicit'],
    [resolveSyncBackend('brightsign', []), 'empty_native'],
    [resolveSyncBackend('brightsign', [bs(1), android, web]), 'non_brightsign'],
  ];
  for (const [r, code] of cases) assert.equal(r.code, code, r.reason);
  assert.equal(cases[5][0].count, 2);
});

test('THE TRAP: native sync explicitly selected for a mixed group downgrades and says why', () => {
  const r = resolveSyncBackend('brightsign', [bs(1), bs(2), android]);
  assert.equal(r.backend, 'screentinker', 'BrightWall cannot include a non-BrightSign screen');
  assert.equal(r.downgraded, true);
  assert.match(r.reason, /1 non-BrightSign display$/, 'the operator must be told which way it broke');
});

test('the downgrade message counts the offenders and pluralises', () => {
  const r = resolveSyncBackend('brightsign', [bs(1), android, web]);
  assert.match(r.reason, /2 non-BrightSign displays$/);
});

test('our protocol is honoured on an all-BrightSign group — never overridden', () => {
  // A 100% BrightSign site still gets to choose ours, e.g. to stay consistent with other sites.
  const r = resolveSyncBackend('screentinker', [bs(1), bs(2)]);
  assert.equal(r.backend, 'screentinker');
  assert.equal(r.downgraded, false);
});

test('an empty group never claims native sync', () => {
  assert.equal(resolveSyncBackend('auto', []).backend, 'screentinker');
  const forced = resolveSyncBackend('brightsign', []);
  assert.equal(forced.backend, 'screentinker');
  assert.equal(forced.downgraded, true);
});

test('unknown or missing settings read as auto rather than throwing', () => {
  assert.equal(resolveSyncBackend('nonsense', [bs(1)]).backend, 'brightsign');
  assert.equal(resolveSyncBackend(undefined, [android]).backend, 'screentinker');
  assert.equal(resolveSyncBackend('auto', null).backend, 'screentinker');
});

test('a pre-port panel is NOT recognised until it re-registers — no phantom user-agent match', () => {
  // Panels paired before this port registered as "Chrome 120" with a BrightSign user agent, and an
  // earlier version tried to catch them that way. It could never work: `devices` has no user_agent
  // column, so the field is always undefined on a row read from the database — the check passed
  // only in tests that fabricated it, which is exactly how dead code survives.
  const legacy = { id: 'old', platform: 'Chrome 120', user_agent: 'BrightSign/9.1.92.2 (HD1026) Chrome/120' };
  assert.equal(isBrightSignDevice(legacy), false, 'a fabricated user_agent must not create a match');
  assert.equal(resolveSyncBackend('auto', [legacy, bs(2)]).backend, 'screentinker',
    'so a group containing one reads as mixed until that panel re-registers as brightsign');
});

test('a non-BrightSign device is never mistaken for one', () => {
  assert.equal(isBrightSignDevice(android), false);
  assert.equal(isBrightSignDevice(null), false);
  assert.equal(isBrightSignDevice({}), false);
});

// --- multicast reach -----------------------------------------------------------------------
//
// SyncManager is multicast, so the whole group must share one L2 network. Two BrightSigns in
// different buildings would each sync perfectly within their own subnet and drift from each other,
// and the dashboard would show a healthy group the whole time. The IP comparison is a heuristic,
// so it is only ever used as evidence AGAINST native sync — never as proof for it.

const bsAt = (n, ip) => ({ id: `bs${n}`, platform: 'brightsign', ip_address: ip });

test('THE SILENT SPLIT: all-BrightSign but on different subnets does not get native sync', () => {
  const r = resolveSyncBackend('auto', [bsAt(1, '10.1.5.20'), bsAt(2, '10.9.5.20')]);
  assert.equal(r.backend, 'screentinker');
  assert.match(r.reason, /different networks/);
  assert.equal(r.code, 'split_network');
});

test('explicitly selecting native across subnets downgrades and explains multicast', () => {
  const r = resolveSyncBackend('brightsign', [bsAt(1, '192.168.1.10'), bsAt(2, '192.168.2.10')]);
  assert.equal(r.backend, 'screentinker');
  assert.equal(r.downgraded, true);
  assert.match(r.reason, /multicast/);
  assert.equal(r.code, 'split_network_multicast');
});

test('one subnet keeps native sync', () => {
  const r = resolveSyncBackend('auto', [bsAt(1, '192.168.1.10'), bsAt(2, '192.168.1.11')]);
  assert.equal(r.backend, 'brightsign');
});

test('unknown addresses block nothing — absence of evidence is not evidence', () => {
  const r = resolveSyncBackend('auto', [bs(1), bs(2)]);
  assert.equal(r.backend, 'brightsign', 'a fleet that never recorded IPs must still work');
  assert.equal(networksDiffer([bs(1), bsAt(2, '10.0.0.1')]), false, 'one known address proves nothing');
});

test('IPv6 members are compared on their /64', () => {
  const a = { id: 'a', platform: 'brightsign', ip_address: '2600:4040:917a:2200::10' };
  const b = { id: 'b', platform: 'brightsign', ip_address: '2600:4040:917a:2200::11' };
  const c = { id: 'c', platform: 'brightsign', ip_address: '2600:4040:9999:2200::12' };
  assert.equal(resolveSyncBackend('auto', [a, b]).backend, 'brightsign');
  assert.equal(resolveSyncBackend('auto', [a, c]).backend, 'screentinker');
});
