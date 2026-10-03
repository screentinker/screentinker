'use strict';

/*
 * The SERVER-side LAN trigger door.
 *
 * ⚠️ WHY IT EXISTS. Triggers are player-side by design so an alarm survives the WAN being down —
 * but that needs the player to bind a socket, which needs a Node context. BrightSign's
 * server-on-a-player build creates its widget WITHOUT nodejs_enabled (deliberately: a Node-enabled
 * widget "is NOT Node" and hosting the server there cost four boot failures), so the player runs in
 * an iframe with no `require`. `dgram` and raw `http` both throw and the listeners never start.
 * Measured on a real XT245: trigger ports 7847/8079/8099 all closed, so enabling triggers on that
 * box did nothing whatsoever. The server on the same board is real Node and can hold the door.
 *
 * ⚠️ THIS MODULE DECIDES ONLY *WHICH DEVICE*, never whether a fire is allowed. That stays in the one
 * resolver both sides already share, so there is no second copy of "may this fire" to drift from
 * the first — the "one decision, N doors" rule trigger-resolve.js states.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveTarget, extractWire } = require('../lib/trigger-ingress');

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

const devices = [
  { id: 'dev-a', trigger_secret: SECRET_A, triggers_accept_http: 1, triggers_accept_udp: 1 },
  { id: 'dev-b', trigger_secret: SECRET_B, triggers_accept_http: 1, triggers_accept_udp: 0 },
  { id: 'dev-none', trigger_secret: null, triggers_accept_http: 1, triggers_accept_udp: 1 },
];

const wire = (secret, token = 'ALARM1') => `ST1 ${secret} ${token}`;

/* ============================================================ addressing */

test('THE POINT: a payload is routed to the device whose secret it carries', () => {
  const r = resolveTarget(wire(SECRET_A), devices, 'udp');
  assert.equal(r.ok, true);
  assert.equal(r.deviceId, 'dev-a');
});

test('a different secret reaches a different device', () => {
  const r = resolveTarget(wire(SECRET_B), devices, 'http');
  assert.equal(r.deviceId, 'dev-b');
});

test('⚠️ the per-device transport flag still gates it', () => {
  // dev-b accepts http but NOT udp. The server door must not become a way around a setting an
  // operator deliberately turned off on the panel.
  assert.equal(resolveTarget(wire(SECRET_B), devices, 'http').ok, true);
  assert.equal(resolveTarget(wire(SECRET_B), devices, 'udp').ok, false);
});

test('a device with no secret can never be addressed', () => {
  // The unconfigured-device invariant: no secret means no fire, by any door.
  assert.equal(resolveTarget(wire(''), devices, 'udp').ok, false);
  assert.equal(resolveTarget('ST1 null ALARM1', devices, 'udp').ok, false);
});

test('an unknown secret is refused', () => {
  assert.equal(resolveTarget(wire('z'.repeat(32)), devices, 'udp').ok, false);
});

test('⚠️ "no such device" and "wrong transport" answer identically', () => {
  /*
   * Distinguishing them would turn the door into an oracle for enumerating both secrets and
   * per-device configuration — from an unauthenticated LAN port.
   */
  const unknown = resolveTarget(wire('z'.repeat(32)), devices, 'udp');
  const wrongTransport = resolveTarget(wire(SECRET_B), devices, 'udp');
  assert.equal(unknown.reason, wrongTransport.reason);
});

test('junk in never throws', () => {
  for (const bad of [null, undefined, '', 'nonsense', 'ST1', 'ST1 only-two', 'X1 a b', 42, {}]) {
    assert.doesNotThrow(() => resolveTarget(bad, devices, 'udp'));
    assert.equal(resolveTarget(bad, devices, 'udp').ok, false);
  }
  assert.doesNotThrow(() => resolveTarget(wire(SECRET_A), null, 'udp'));
  assert.doesNotThrow(() => resolveTarget(wire(SECRET_A), [null, {}, { id: 'x' }], 'udp'));
});

test('a malformed wire is refused before any secret is compared', () => {
  const r = resolveTarget('GARBAGE', devices, 'udp');
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, undefined);
});

test('⚠️ the sweep does not stop at the first match', () => {
  /*
   * Returning early makes the reply time depend on the device's position in the list, which leaks
   * that position to anyone who can time it. This asserts the property structurally — the source
   * must not break out of the loop — because timing cannot be asserted reliably in a unit test.
   */
  const src = require('fs').readFileSync(require.resolve('../lib/trigger-ingress.js'), 'utf8');
  const loop = src.slice(src.indexOf('for (const d of devices'), src.indexOf('if (!hit) return'));
  assert.ok(!/\bbreak\b/.test(loop), 'the candidate sweep must not break early');
  assert.ok(/secretMatches/.test(loop), 'the compare must go through the constant-time helper');
});

/* ============================================================ the four wire shapes */

test('⚠️ all four shapes a control system can actually emit are accepted', () => {
  /*
   * AMX has no HTTP client and hand-builds requests; Extron's Global Scripter forbids the socket
   * and http modules outright but can build a URL. A POST-JSON-only door is unreachable from both,
   * which is why the player's door takes all of these — and why this one must match it.
   */
  const expected = `ST1 ${SECRET_A} ALARM1`;
  assert.equal(extractWire({ body: expected }), expected, 'raw text/plain line');
  assert.equal(extractWire({ body: { secret: SECRET_A, token: 'ALARM1' } }), expected, 'JSON envelope');
  assert.equal(extractWire({ query: { secret: SECRET_A, token: 'ALARM1' } }), expected, 'GET query params');
  assert.equal(extractWire({ query: { m: expected } }), expected, 'GET whole raw line');
});

test('a request carrying nothing usable yields an empty wire, not a throw', () => {
  for (const req of [{}, { body: undefined }, { body: {} }, { query: {} }, { body: 42 }, { query: { secret: 'x' } }]) {
    assert.doesNotThrow(() => extractWire(req));
    assert.equal(resolveTarget(extractWire(req), devices, 'http').ok, false);
  }
});

test('the query form round-trips into a real addressing decision', () => {
  // End to end through both halves: what a URL-only control system sends must reach the right device.
  const text = extractWire({ query: { secret: SECRET_A, token: 'ALARM1' } });
  assert.equal(resolveTarget(text, devices, 'http').deviceId, 'dev-a');
});
