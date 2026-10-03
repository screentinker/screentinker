'use strict';

/*
 * Transport, end to end: a child node dials a parent over a real socket and reports upward.
 *
 * ⚠️ REAL SOCKETS, NOT THE SIMULATION. The topology harness models the graph and the failure
 * injection; these prove the wire actually carries it — authentication, backpressure answered rather
 * than dropped, subtree attestation, and the reconnect behaviour. A simulation cannot tell you that
 * an auth middleware rejects, because in a simulation there is no middleware.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const setupMeshSocket = require('../ws/meshSocket');
const pairing = require('../lib/mesh/pairing');
const envelope = require('../lib/mesh/envelope');
const { Uplink, backoffFor, BACKOFF_MAX_MS } = require('../lib/mesh/uplink');

const HUB_ID = 'hub-node';
const CHILD_ID = 'child-node';
const quietLogger = { log() {}, warn() {}, error() {} };

/** Stand a parent up on a random port with one live edge. */
async function parent({ edgeOver = {}, onEnvelope = () => {} } = {}) {
  const { token, tokenHash } = pairing.mintEdgeToken();
  const edge = {
    id: 'edge-1', peer_node_id: CHILD_ID, direction: 'down',
    grant_categories: ['health'], role_capabilities: ['consumes-telemetry'],
    revoked_at: null, token_expires_at: null, ...edgeOver,
  };

  const http = createServer();
  const io = new Server(http, { pingInterval: 300, pingTimeout: 300 });
  const received = [];

  const wired = setupMeshSocket(io, {
    thisNodeId: HUB_ID,
    acceptEnrollment: () => true,
    findEdgeByTokenHash: (h) => (h === tokenHash ? edge : null),
    // The same mutable row, so a test can revoke or expire it MID-SESSION and see the open socket
    // react — which is the whole point of re-reading it per envelope.
    reloadEdge: (id) => (id === edge.id ? edge : null),
    onEnvelope: (e, env, meta) => { received.push({ env, meta }); onEnvelope(e, env, meta); },
    logger: quietLogger,
  });

  const port = await new Promise((r) => http.listen(0, '127.0.0.1', () => r(http.address().port)));
  return {
    url: `http://127.0.0.1:${port}`, token, edge, received, io, http, wired,
    async close() { io.close(); await new Promise((r) => http.close(r)); },
  };
}

function child(hub, over = {}) {
  return new Uplink({
    parentUrl: hub.url, edgeToken: hub.token, nodeId: CHILD_ID,
    connect, logger: quietLogger, ...over,
  });
}

const waitFor = (fn, ms = 4000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let v; try { v = fn(); } catch { v = false; }
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error('timed out waiting'));
    setTimeout(tick, 20);
  };
  tick();
});

// ===== the wire works =====

test('a child dials its parent and an observation arrives', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    up.send(envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { up: true },
    }));
    await waitFor(() => hub.received.length === 1);

    const got = hub.received[0].env;
    assert.equal(got.origin_node_id, CHILD_ID);
    // ⚠️ The parent stamps its own receipt, so skew stays measurable across the hop.
    assert.equal(got.receipts.length, 1);
    assert.equal(got.receipts[0].node_id, HUB_ID);
    await waitFor(() => up.lastSyncAt !== null, 2000);
  } finally { up.stop(); await hub.close(); }
});

// ===== authentication =====

test('a connection with no token is refused', async () => {
  const hub = await parent();
  const sock = connect(`${hub.url}/mesh`, { transports: ['websocket'], reconnection: false });
  try {
    const err = await new Promise((resolve) => sock.on('connect_error', resolve));
    assert.match(err.message, /No edge token was presented/i);
  } finally { sock.close(); await hub.close(); }
});

test('a revoked edge is refused, and says so without confirming the edge exists', async () => {
  /*
   * ⚠️ "Revoked" and "no such token" answer identically on purpose. A caller holding a stale token
   * learns that it no longer works — not whether the relationship still exists, which is somebody
   * else's business.
   */
  const hub = await parent({ edgeOver: { revoked_at: Math.floor(Date.now() / 1000) } });
  const up = child(hub).start();
  try {
    await waitFor(() => up.lastError !== null);
    assert.match(up.lastError, /no longer authorised|revoked|expired/i);
    assert.equal(up.connected, false);
  } finally { up.stop(); await hub.close(); }
});

test('a wrong token is refused with the same answer as a revoked one', async () => {
  const hub = await parent();
  const up = child(hub, { edgeToken: 'not-the-token' }).start();
  try {
    await waitFor(() => up.lastError !== null);
    assert.match(up.lastError, /no longer authorised/i);
  } finally { up.stop(); await hub.close(); }
});

// ===== the security property =====

test('⚠️ a child may attest only to its own subtree', async () => {
  /*
   * A compromised leaf must not be able to forge data about a peer it merely shares a hub with.
   * The check is that the SENDING child appears in the ancestry: it may relay for things below
   * itself, and nothing else.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);

    const forged = envelope.createEnvelope({
      originNodeId: 'someone-elses-node', type: 'node-health', bodyVersion: 1,
      ancestry: ['someone-elses-node'], originTs: Date.now(), body: { forged: true },
    });
    const reply = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', forged, (err, res) => resolve(err || res));
    });
    assert.equal(reply.ok, false);
    assert.match(reply.reason, /only report data from its own subtree/i);
    assert.equal(hub.received.length, 0, 'and nothing was stored');

    // Relaying for a node BELOW itself is legitimate and must still work.
    const relayed = envelope.createEnvelope({
      originNodeId: 'leaf', type: 'node-health', bodyVersion: 1,
      ancestry: ['leaf', CHILD_ID], originTs: Date.now(), body: {},
    });
    const ok = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', relayed, (err, res) => resolve(err || res));
    });
    assert.equal(ok.ok, true, 'a child relaying for its own subtree is exactly the point of I5');
  } finally { up.stop(); await hub.close(); }
});

test('an unknown payload type crosses the wire as relay-only', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const env = envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'invented-in-2027', bodyVersion: 4,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    const res = await new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', env, (e, r) => resolve(e || r));
    });
    assert.equal(res.ok, true, 'an unknown type must not be an error (I5)');
    assert.equal(res.relayOnly, true, 'but must be marked relay-only rather than interpreted');
  } finally { up.stop(); await hub.close(); }
});

// ===== backpressure over the wire =====

test('a throttled child is ANSWERED, not silently dropped', async () => {
  /*
   * ⚠️ Silence is indistinguishable from success at the far end. A child told nothing assumes
   * delivery and moves on, so the data is lost with both sides believing otherwise.
   */
  const hub = await parent();
  hub.wired.backpressure.limits.maxMessages = 2;
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    const send = () => new Promise((resolve) => {
      up.socket.timeout(3000).emit('mesh:envelope', mk(), (e, r) => resolve(e || r));
    });

    await send(); await send();
    const third = await send();
    assert.equal(third.ok, false);
    assert.equal(third.throttled, true);
    assert.equal(third.limit, 'rate');
    assert.ok(third.retryAfterMs > 0, 'and told when it may try again');
  } finally { up.stop(); await hub.close(); }
});

// ===== reconnect =====

test('backoff is bounded and jittered, so a fleet does not thunder', () => {
  /*
   * ⚠️ THE JITTER IS THE LOAD-BEARING HALF (#144). A hub restart disconnects every child at the same
   * instant; without jitter they all retry in the same millisecond, knock it over again, and the
   * outage repeats on a fixed period until a human intervenes.
   */
  const spread = new Set();
  for (let i = 0; i < 200; i++) spread.add(backoffFor(3));
  assert.ok(spread.size > 50, `expected a wide spread of delays, got ${spread.size} distinct`);

  for (let attempt = 1; attempt <= 30; attempt++) {
    const d = backoffFor(attempt);
    assert.ok(d >= 250, 'never a hot loop');
    assert.ok(d <= BACKOFF_MAX_MS * 1.5, 'and always bounded');
  }
  // Deterministic with a fixed source, so the ceiling is testable rather than merely asserted.
  assert.equal(backoffFor(1, () => 0.5), 1000);
});

test('a node whose parent is down keeps buffering and stays fully functional (I1)', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    await hub.close();                        // the parent goes away mid-life
    await waitFor(() => !up.connected, 4000);

    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: {},
    });
    for (let i = 0; i < 5; i++) up.send(mk());

    assert.ok(up.buffer.length > 0, 'observations are held for backfill');
    assert.equal(up.status().connected, false);
    assert.ok(up.status().retryAttempt > 0, 'and it is retrying, with the reason recorded');
  } finally { up.stop(); }
});

test('the buffer is bounded and drops the OLDEST', async () => {
  /*
   * A node whose parent is away for a week must not consume its own memory reporting to nobody —
   * that would turn an observer's outage into the observed node's outage. Oldest-first because after
   * a long gap, "what is happening now" is worth more than the middle of last Tuesday.
   */
  const hub = await parent();
  const up = child(hub, { bufferMax: 3 });
  try {
    for (let i = 0; i < 10; i++) {
      up.send(envelope.createEnvelope({
        originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
        ancestry: [CHILD_ID], originTs: i, body: { i },
      }));
    }
    assert.equal(up.buffer.length, 3);
    assert.equal(up.buffer[0].body.i, 7, 'the newest survive');
    assert.equal(up.dropped, 7);
    assert.equal(up.status().droppedOldest, 7, 'and the loss is reported, not hidden');
  } finally { up.stop(); await hub.close(); }
});

test('an uplink refuses to exist without an operator-supplied address (I9)', () => {
  // ⚠️ There is no default parent and no fallback. This is how a peer architecture quietly becomes
  // hub-and-spoke, and it always arrives as a convenience.
  /*
   * ⚠️ AN UPLINK MUST SIMPLY CONSTRUCT — and this assertion exists because it once did not.
   *
   * Adding the write handler introduced `this.onWrite = opts.onWrite` into a constructor that
   * DESTRUCTURES its parameter, so there was no `opts` binding and every `new Uplink(...)` threw a
   * ReferenceError. services/mesh-uplink.js builds links inside a try/catch that logs one warn line
   * per edge, so on any node with MESH_ALLOW_UPLINK the ENTIRE MESH would have been inert — no
   * telemetry, no reads, no writes — behind `[mesh] uplink to <peer> not started`.
   *
   * The full suite stayed green. That is the config-gated-code-is-untested-code shape: the wiring
   * line for a feature cannot be exercised by tests that never build the object in the shape the
   * service builds it. So: build it plainly, both with and without the optional handlers.
   */
  const bare = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n', connect });
  assert.equal(bare.onRead, null, 'no handler means the child refuses reads, which is the safe default');
  assert.equal(bare.onWrite, null, 'and refuses writes, for the same reason');

  const wired = new Uplink({
    parentUrl: 'http://x', edgeToken: 't', nodeId: 'n', connect,
    onRead: () => ({ ok: true }), onWrite: () => ({ ok: true }),
  });
  assert.equal(typeof wired.onRead, 'function');
  assert.equal(typeof wired.onWrite, 'function', 'the write handler must actually be accepted');

  assert.throws(() => new Uplink({ edgeToken: 't', nodeId: 'n', connect }),
    /no default address/i);
  assert.throws(() => new Uplink({ parentUrl: 'http://x', nodeId: 'n', connect }), /edge token/i);
});

test('⚠️ with the flag OFF there is no /mesh endpoint to reach (I1)', async () => {
  /*
   * The invisibility guarantee, at the transport layer. Not "a handler that refuses" — the namespace
   * is never created, so there is no surface at all. A user who never sets MESH_ACCEPT_ENROLLMENT
   * must not be able to tell the mesh exists, and an early-returning handler would still answer.
   */
  const http = createServer();
  const io = new Server(http);
  const wired = setupMeshSocket(io, { acceptEnrollment: () => false, logger: quietLogger });
  assert.equal(wired, null, 'nothing is wired when the flag is off');

  const port = await new Promise((r) => http.listen(0, '127.0.0.1', () => r(http.address().port)));
  const sock = connect(`http://127.0.0.1:${port}/mesh`, {
    transports: ['websocket'], reconnection: false, timeout: 2000,
  });
  try {
    const err = await new Promise((resolve, reject) => {
      sock.on('connect_error', resolve);
      sock.on('connect', () => reject(new Error('the namespace answered — it should not exist')));
      setTimeout(() => reject(new Error('no answer either way')), 5000);
    });
    // socket.io's own "Invalid namespace" — the endpoint genuinely is not there.
    assert.match(err.message, /invalid namespace/i);
  } finally {
    sock.close(); io.close(); await new Promise((r) => http.close(r));
  }
});

test('⚠️ END TO END: a denied field never crosses the wire', async () => {
  /*
   * The I10 property, proven on the actual socket rather than in a unit test. Filtering at the
   * PARENT would look identical from the child's side and be worthless: the data would already have
   * crossed into somebody else's process, and the client's only protection would be the good
   * behaviour of a machine they do not control.
   *
   * So the child projects with lib/mesh/mirror.js BEFORE sending, and what arrives is checked for
   * the absence of everything the grant did not cover.
   */
  const mirror = require('../lib/mesh/mirror');
  const hub = await parent();                       // edge grants ['health'] only
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);

    const deviceRow = {
      id: 'dev-1', name: 'Reception', status: 'online', battery_level: 55,
      hardware_serial: 'SN-77', ip_address: '80.51.0.7', local_ip: '10.0.0.5',
      playlist_name: 'Autumn Promo', screenshot_url: '/uploads/screenshots/dev-1.jpg',
    };

    up.send(envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'device-summary', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(),
      body: mirror.projectDevice(deviceRow, hub.edge.grant_categories),
    }));
    await waitFor(() => hub.received.length === 1);

    const body = hub.received[0].env.body;
    assert.equal(body.id, 'dev-1', 'the identifier travels — a grant hides what a screen is, not that it exists');
    assert.equal(body.battery_level, 55, 'and the granted health fields travel');

    for (const denied of ['name', 'hardware_serial', 'ip_address', 'local_ip',
                          'playlist_name', 'screenshot_url']) {
      assert.ok(!(denied in body),
        `"${denied}" reached the parent under a health-only grant — filtering is at the wrong end`);
    }

    // ⚠️ Belt and braces: the serialised frame must not contain the values either, in case a future
    // projection nests them somewhere the key check would miss.
    const wire = JSON.stringify(hub.received[0].env);
    for (const secret of ['Reception', 'SN-77', '80.51.0.7', 'Autumn Promo']) {
      assert.ok(!wire.includes(secret), `"${secret}" appeared in the frame sent to the parent`);
    }
  } finally { up.stop(); await hub.close(); }
});

// ===== authorisation is not a handshake-only decision =====

test('⚠️ REVOKING AN EDGE STOPS A SOCKET THAT IS ALREADY OPEN', async () => {
  /*
   * A mesh socket is long-lived by design: a child dials its parent and stays. So an edge captured
   * at handshake means revocation does nothing until the child happens to reconnect — which may be
   * days. An operator revokes precisely when they have decided a peer should stop being trusted, and
   * "it takes effect at the next reconnect" is not a revoke.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const mk = () => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { ok: true },
    });
    up.send(mk());
    await waitFor(() => hub.received.length === 1);

    // Revoked while the connection is up.
    hub.edge.revoked_at = Math.floor(Date.now() / 1000);

    up.send(mk());
    await waitFor(() => !up.connected, 4000);
    assert.equal(hub.received.length, 1, 'nothing was accepted after the revoke');
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ AN EXPIRED TOKEN IS ACTUALLY CHECKED — the column has to be SELECTed', async () => {
  /*
   * The real bug this guards: store.findEdgeByTokenHash did not select token_expires_at, so
   * edgeIsActive() saw `undefined`, its `typeof … === 'number'` gate skipped, and an expired edge
   * token authenticated forever. Every unit test passed because they build edge objects by hand
   * with the field present — only the production query omitted it.
   */
  const hub = await parent({ edgeOver: { token_expires_at: Math.floor(Date.now() / 1000) - 60 } });
  const up = child(hub).start();
  try {
    await waitFor(() => up.lastError, 4000);
    assert.match(up.lastError, /expired/i, 'and the child is told which of the two it was');
    assert.equal(up.connected, false);
  } finally { up.stop(); await hub.close(); }
});

test('the real store query loads every field edgeIsActive gates on', () => {
  /*
   * Read from the SOURCE rather than a hand-built row: the failure mode was a field the checker
   * reads and the query never returned, which no amount of testing edgeIsActive itself can catch.
   */
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/mesh/store.js'), 'utf8');
  const active = fs.readFileSync(require.resolve('../lib/mesh/pairing.js'), 'utf8')
    .match(/function edgeIsActive[\s\S]*?\n}/)[0];
  for (const field of ['revoked_at', 'token_expires_at']) {
    assert.ok(active.includes(field), `edgeIsActive should gate on ${field}`);
    for (const fn of ['findEdgeByTokenHash', 'reloadEdge']) {
      const body = src.match(new RegExp(`function ${fn}[\\s\\S]*?\\n}`))[0];
      assert.ok(body.includes(field), `${fn} must SELECT ${field} — it is gated on`);
    }
  }
});

// ===== the uplink buffer =====

test('⚠️ send() reports THIS envelope, not a running total', () => {
  /*
   * It used to `return this.dropped === 0`, so one drop at any point latched the return to false
   * forever and a caller counting on it reported loss on every later send that buffered fine.
   */
  const up = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n',
                          connect: () => ({ on() {}, close() {} }), bufferMax: 2, logger: quietLogger });
  assert.equal(up.send({ a: 1 }), true);
  assert.equal(up.send({ a: 2 }), true);
  assert.equal(up.send({ a: 3 }), false, 'this one evicted the oldest');
  assert.equal(up.buffer.length, 2, 'and the buffer stayed at its limit');
  assert.equal(up.dropped, 1);
});

test('⚠️ the RE-BUFFER path is bounded too', () => {
  /*
   * A parent that accepts connections but times out every emit sends everything back through
   * _requeue. Pushing directly there grew the buffer past its own limit — the exact condition the
   * limit exists for, since an observer's outage must never become the observed node's outage (I1).
   */
  const up = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n',
                          connect: () => ({ on() {}, close() {} }), bufferMax: 3, logger: quietLogger });
  for (let i = 0; i < 3; i++) up.send({ i });
  for (let i = 0; i < 100; i++) up._requeue({ requeued: i });
  assert.equal(up.buffer.length, 3, 'never grows past the limit however many come back');
  assert.equal(up.dropped, 100, 'and the loss is counted rather than hidden');
});

test('⚠️ A TOKEN EXPIRING IN A YEAR IS NOT TREATED AS EXPIRED (seconds vs milliseconds)', async () => {
  /*
   * The stored column is unix SECONDS, like every timestamp in this database. meshSocket's now() is
   * MILLISECONDS, because the backpressure window is a ms budget. Comparing the two made every token
   * look long expired — the handshake refused every child with "this connection's token expired" and
   * the mesh never connected at all.
   *
   * ⚠️ Every unit test still passed, because the fixtures set token_expires_at to null and never
   * exercised the comparison. Only standing two real servers up found it.
   */
  const hub = await parent({ edgeOver: { token_expires_at: Math.floor(Date.now() / 1000) + 365 * 86400 } });
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected, 4000);
    up.send(envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { ok: true },
    }));
    await waitFor(() => hub.received.length === 1);
    assert.equal(up.lastError, null, 'no refusal at all');
  } finally { up.stop(); await hub.close(); }
});

// ===== the read-through proxy =====

test('⚠️ A PARENT CAN READ THE CHILD, and gets the child\'s own shape back', async () => {
  /*
   * The point of reading through rather than serving the mirror: an operator looking at a customer's
   * estate should see what the customer sees. A reduced summary makes every remote site a
   * second-class view, and second-class views stop being trusted.
   */
  const hub = await parent();
  const up = child(hub, {
    onRead: (req) => (req.path === '/api/devices'
      ? { ok: true, rows: [{ id: 'd1', name: 'Lobby', status: 'online' }] }
      : { ok: false, reason: 'That is not something this connection may read.' }),
  }).start();
  try {
    await waitFor(() => up.connected);
    const answer = await hub.wired.readFrom(CHILD_ID, { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, true);
    assert.equal(answer.rows[0].name, 'Lobby');
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ A WRITE IS REFUSED BY THE CHILD, not merely unsent by the parent', async () => {
  /*
   * The parent may ASK; it may not TELL. If that held only because the parent never sends a write,
   * it would be a convention — and conventions hold until somebody adds one convenient endpoint.
   * The refusal has to come from the side that owns the rows.
   */
  const readProxy = require('../lib/mesh/read-proxy');
  const hub = await parent();
  const up = child(hub, {
    onRead: (req) => {
      const check = readProxy.authorize({}, req.path, req.method, ['health']);
      return check.ok ? { ok: true, rows: [] } : { ok: false, reason: check.reason };
    },
  }).start();
  try {
    await waitFor(() => up.connected);
    const wrote = await hub.wired.readFrom(CHILD_ID, { path: '/api/devices', method: 'DELETE' });
    assert.equal(wrote.ok, false);
    assert.match(wrote.reason, /can read, and cannot write/);

    const sneaky = await hub.wired.readFrom(CHILD_ID, { path: '/api/devices/d1/block', method: 'GET' });
    assert.equal(sneaky.ok, false, 'a path outside the allowlist is refused even as a GET');
  } finally { up.stop(); await hub.close(); }
});

test('a read for a grant the edge does not hold is refused', async () => {
  // The proxy must not be the way around the client's own decision about what travels.
  const readProxy = require('../lib/mesh/read-proxy');
  const check = readProxy.authorize({}, '/api/playlists', 'GET', ['health']);
  assert.equal(check.ok, false);
  assert.match(check.reason, /content-metadata/);
});

test('⚠️ reading a node that is NOT CONNECTED says so, rather than hanging', async () => {
  /*
   * A request that queues invisibly is how an operator ends up staring at a spinner and concluding
   * the product is broken. "Not connected right now" and "refused" also need opposite responses.
   */
  const hub = await parent();
  try {
    const answer = await hub.wired.readFrom('nobody-here', { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, false);
    assert.equal(answer.offline, true);
    assert.match(answer.reason, /not connected/);
  } finally { await hub.close(); }
});

test('the workspace scope narrows a proxied read', () => {
  // ⚠️ Applied on the child, from the edge — never from a filter the parent passes, which would let
  // the party that benefits from ignoring it decide whether to apply it.
  const readProxy = require('../lib/mesh/read-proxy');
  const rows = [
    { id: 'a', workspace_id: 'w1' },
    { id: 'b', workspace_id: 'w2' },
    { id: 'c', workspace_id: null },
  ];
  assert.deepEqual(readProxy.scopeRows(rows, ['w1']).map((r) => r.id), ['a', 'c'],
    'unfiled rows travel; another workspace does not');
  assert.equal(readProxy.scopeRows(rows, null).length, 3, 'null means every workspace');
});

// ===== batching =====

test('⚠️ A CHILD DOES NOT BATCH UNTIL THE PARENT SAYS IT CAN', async () => {
  /*
   * The compatibility property the whole design rests on. An older parent treats `batch` as an
   * unknown type, so I5 applies — relay it, do not store it — and it would forward a batch and store
   * NOTHING, with no error on either side. A mixed-version mesh would lose telemetry invisibly.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    await waitFor(() => up.parentCapabilities !== null, 4000);
    assert.ok(up.batchLimits(), 'this parent advertises batch-v1');

    // Simulate an older parent: forget what it told us.
    up.parentCapabilities = null;
    assert.equal(up.batchLimits(), null);

    const mk = (i) => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'node-health', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { i },
    });
    up.sendMany([mk(1), mk(2), mk(3)], { nodeId: CHILD_ID, ancestry: [CHILD_ID] });
    await waitFor(() => hub.received.length === 3, 4000);
    assert.ok(hub.received.every((r) => r.env.type === 'node-health'),
      'it falls back to individual envelopes, exactly as today');
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ capabilities are FORGOTTEN on disconnect', () => {
  /*
   * The next connection may be to a different parent, or the same one downgraded. A stale "it
   * supports batching" would send batches into a node that relays them without storing — the silent
   * failure again, arriving through a reconnect nobody thought about.
   */
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/mesh/uplink.js'), 'utf8');
  const onDisconnect = src.slice(src.indexOf("this.socket.on('disconnect'"));
  assert.match(onDisconnect.slice(0, 800), /this\.parentCapabilities = null/);
});

test('a batch arrives as items, applied as a group', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    await waitFor(() => up.batchLimits() !== null, 4000);

    const mk = (id) => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'device-summary', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(), body: { id, status: 'online' },
    });
    up.sendMany([mk('d1'), mk('d2'), mk('d3')], { nodeId: CHILD_ID, ancestry: [CHILD_ID] });

    await waitFor(() => hub.received.length === 1, 4000);
    const { env, meta } = hub.received[0];
    assert.equal(env.type, 'batch', 'one message on the wire');
    assert.equal(meta.batch.length, 3, 'three payloads handed over together');
    assert.deepEqual(meta.batch.map((e) => e.body.id), ['d1', 'd2', 'd3'], 'in order');
    assert.ok(meta.batch.every((e) => e.type === 'device-summary'),
      'each item is expressed as the envelope the storage layer already knows');
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ ONE BAD ITEM COSTS EXACTLY ONE BAD ITEM (I6)', async () => {
  /*
   * All-or-nothing means a single malformed item from a newer child discards every good one beside
   * it — and the child, seeing a rejection, retries the identical batch forever.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const good = { type: 'device-summary', body_version: 1, origin_ts: Date.now(), body: { id: 'd1' } };
    const bad = { type: 'device-summary', body_version: 1, body: { id: 'd2' } };   // no origin_ts
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(),
      items: [good, bad, { ...good, body: { id: 'd3' } }],
    });

    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.ok, true);
    assert.equal(ack.accepted, 2, 'the good items land');
    assert.equal(ack.rejected.length, 1);
    assert.equal(ack.rejected[0].index, 1, 'and the caller is told WHICH');
    assert.match(ack.rejected[0].reason, /origin timestamp/);
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ A FORGED ITEM IS REJECTED even inside an honest batch', async () => {
  /*
   * Attestation runs PER ITEM. A relay legitimately carries items from several origins, so checking
   * only the batch would let a compromised child slip in an item claiming a peer's origin and have
   * it accepted on the batch's credentials — data about a site it merely shares a hub with.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const mine = { type: 'device-summary', body_version: 1, origin_ts: Date.now(), body: { id: 'd1' } };
    const theirs = { ...mine, origin_node_id: 'someone-elses-node', body: { id: 'stolen' } };
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(), items: [mine, theirs],
    });

    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.accepted, 1, 'only the item it may speak for');
    assert.equal(ack.rejected.length, 1);
    assert.match(ack.rejected[0].reason, /own subtree/);
  } finally { up.stop(); await hub.close(); }
});

test('an unknown type inside a batch is relayed, not stored, and not rejected (I5)', async () => {
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(),
      items: [
        { type: 'device-summary', body_version: 1, origin_ts: Date.now(), body: { id: 'd1' } },
        { type: 'invented-in-2027', body_version: 1, origin_ts: Date.now(), body: { x: 1 } },
      ],
    });
    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.accepted, 1);
    assert.equal(ack.relayed, 1, 'forwarded, not understood, not refused');
    assert.equal(ack.rejected.length, 0);
  } finally { up.stop(); await hub.close(); }
});

test('a batch may not contain a batch', () => {
  // ⚠️ Nesting turns every bound — item count, byte size, the per-item loop — into a recursive
  // problem, which is how a size limit stops being one.
  const v = envelope.validateItem(
    { type: 'batch', body_version: 1, origin_ts: Date.now(), body: {} },
    { batchOriginNodeId: 'n1' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /may not contain a batch/);
});

test('⚠️ batches are CHUNKED below the receiver\'s limit', () => {
  /*
   * The parent's limits are authoritative — a sender's own defaults are a guess about somebody
   * else's box — and the chunk is flushed BEFORE the item that would breach the bound. Overshooting
   * by one item is how a batch trips socket.io's maxHttpBufferSize and fails with an error that says
   * nothing about batching.
   */
  const sent = [];
  const up = new Uplink({
    parentUrl: 'http://x', edgeToken: 't', nodeId: 'n1', logger: quietLogger,
    connect: () => ({ on() {}, close() {} }),
  });
  up.parentCapabilities = { supports: ['batch-v1'], maxBatchItems: 10, maxBatchBytes: 1024 * 1024 };
  up.send = (env) => { sent.push(env); return true; };

  const mk = (i) => envelope.createEnvelope({
    originNodeId: 'n1', type: 'device-summary', bodyVersion: 1,
    ancestry: ['n1'], originTs: Date.now(), body: { id: `d${i}` },
  });
  up.sendMany(Array.from({ length: 25 }, (_, i) => mk(i)), { nodeId: 'n1', ancestry: ['n1'] });

  assert.equal(sent.length, 3, '25 items at 10 per batch');
  assert.deepEqual(sent.map((b) => b.body.items.length), [10, 10, 5]);
  assert.ok(sent.every((b) => b.type === 'batch'));
});

test('⚠️ BACKPRESSURE COUNTS ITEMS, so batching is not a way around the rate limit', () => {
  const { Backpressure } = require('../lib/mesh/backpressure');
  const bp = new Backpressure();
  let admitted = 0;
  // One message per batch, but 400 payloads each: the message counter would never notice.
  for (let i = 0; i < 20; i++) if (bp.admit('c', 5000, 0, 400).ok) admitted++;
  assert.ok(admitted < 20, 'the item budget bites even though the message budget would not');
  const refusal = bp.admit('c', 5000, 0, 400);
  assert.equal(refusal.limit, 'items');
  assert.match(refusal.reason, /Batching reduces messages, not the amount of data/);

  // ⚠️ And it rolls with the window: a counter checked but never reset throttles forever.
  assert.equal(bp.admit('c', 5000, 999_999, 400).ok, true);
});

test('⚠️ a RELAYED item is accepted when its own chain proves the path', async () => {
  /*
   * The other half of the attestation rule, and the reason it cannot simply be "origin must be the
   * child". A relay legitimately carries payloads from below it — a grandchild's data reaching the
   * hub through the child — and that is credible exactly when the item's OWN ancestry shows the
   * sending child on the path it took.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(),
      items: [
        { type: 'device-summary', body_version: 1, origin_ts: Date.now(), body: { id: 'mine' } },
        // From a grandchild, relayed by this child — the chain says so.
        { type: 'device-summary', body_version: 1, origin_ts: Date.now(),
          origin_node_id: 'grandchild', ancestry: ['grandchild', CHILD_ID], body: { id: 'theirs' } },
        // Claims a grandchild but shows a path this child is not on.
        { type: 'device-summary', body_version: 1, origin_ts: Date.now(),
          origin_node_id: 'elsewhere', ancestry: ['elsewhere', 'some-other-hub'], body: { id: 'forged' } },
      ],
    });

    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.accepted, 2, 'its own, and the one it can prove it relayed');
    assert.equal(ack.rejected.length, 1);
    assert.equal(ack.rejected[0].index, 2, 'the unprovable one, and only that one');
    assert.match(ack.rejected[0].reason, /own subtree/);
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ a COMPRESSED batch survives the real wire, as binary', async () => {
  /*
   * socket.io carries binary natively as an attachment, so the payload travels as bytes rather than
   * base64 — which would have made it ~33% LARGER for the privilege of being text nobody reads.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    await waitFor(() => up.batchLimits() !== null, 4000);
    assert.equal(up.batchLimits().encoding, 'br', 'the first encoding both sides can do');

    const mk = (i) => envelope.createEnvelope({
      originNodeId: CHILD_ID, type: 'device-summary', bodyVersion: 1,
      ancestry: [CHILD_ID], originTs: Date.now(),
      body: { id: `d${i}`, name: `Store ${i}`, status: 'online', storage_free_mb: 4096 },
    });
    up.sendMany(Array.from({ length: 50 }, (_, i) => mk(i)), { nodeId: CHILD_ID, ancestry: [CHILD_ID] });

    await waitFor(() => hub.received.length === 1, 4000);
    const { env, meta } = hub.received[0];
    assert.equal(env.body.enc, 'br', 'compressed on the wire');
    assert.equal(meta.batch.length, 50, 'and all fifty arrive');
    assert.equal(meta.batch[7].body.name, 'Store 7', 'intact');
  } finally { up.stop(); await hub.close(); }
});

test('a batch sent plainly still works when there is no shared encoding', () => {
  // ⚠️ A peer that cannot decode is worse off than one that received it plainly, so no overlap
  // means no compression rather than a payload the far side cannot open.
  const up = new Uplink({ parentUrl: 'http://x', edgeToken: 't', nodeId: 'n1',
                          connect: () => ({ on() {}, close() {} }), logger: quietLogger });
  up.parentCapabilities = { supports: ['batch-v1'], encodings: ['lzma-9000'] };
  assert.equal(up.batchLimits().encoding, null);

  const b = envelope.createBatch({ originNodeId: 'n1', ancestry: ['n1'], originTs: Date.now(),
    items: [{ type: 'node-health', body_version: 1, origin_ts: Date.now(), body: { ok: true } }],
    encoding: null });
  assert.ok(Array.isArray(b.body.items), 'plain items, readable by anyone');
  assert.equal(envelope.batchItems(b).length, 1);
});

test('⚠️ A DECOMPRESSION BOMB IS REFUSED, not unpacked', () => {
  /*
   * Brotli will turn a kilobyte into gigabytes, so a bound on what ARRIVES is no bound at all — the
   * payload has to be refused by how large it BECOMES. zlib enforces that during the decode rather
   * than after allocating.
   */
  const zlib = require('node:zlib');
  const huge = Buffer.alloc(envelope.BATCH_LIMITS.maxDecodedBytes * 4, 0x41);
  const bomb = zlib.brotliCompressSync(huge);
  assert.ok(bomb.length < 64 * 1024, 'a small payload that expands enormously');

  const items = envelope.decodeItems({ enc: 'br', count: 1, data: bomb });
  assert.equal(items, null, 'refused rather than expanded');
});

test('⚠️ an UNDER-DECLARED batch is refused outright', async () => {
  /*
   * Backpressure charges for what a batch SAYS it holds, before unpacking it — otherwise a
   * compressed payload buys a free pass through the limit that exists to stop exactly that.
   * Refused rather than re-charged: under-declaring is not a mistake anyone makes by accident.
   */
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const items = Array.from({ length: 20 }, (_, i) => ({
      type: 'device-summary', body_version: 1, origin_ts: Date.now(), body: { id: `d${i}` },
    }));
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(), items, encoding: 'br' });
    batch.body.count = 1;      // the lie

    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.ok, false);
    assert.match(ack.reason, /more payloads than it declared/);
    assert.equal(hub.received.length, 0, 'and nothing was stored');
  } finally { up.stop(); await hub.close(); }
});

test('a batch that cannot be unpacked is refused, never relayed onward', async () => {
  // ⚠️ Forwarding bytes this node could not read would push an unbounded decompression problem one
  // hop further up, and the hop that finally opens it is the one that pays.
  const hub = await parent();
  const up = child(hub).start();
  try {
    await waitFor(() => up.connected);
    const batch = envelope.createBatch({
      originNodeId: CHILD_ID, ancestry: [CHILD_ID], originTs: Date.now(),
      items: [{ type: 'node-health', body_version: 1, origin_ts: Date.now(), body: {} }],
      encoding: 'br' });
    batch.body.data = Buffer.from('not actually brotli');

    const ack = await new Promise((resolve) => up.socket.emit('mesh:envelope', batch, resolve));
    assert.equal(ack.ok, false);
    assert.match(ack.reason, /could not be unpacked/);
    assert.equal(hub.received.length, 0);
  } finally { up.stop(); await hub.close(); }
});

test('⚠️ a SCREENSHOT needs display-capture, and travels as bytes', async () => {
  /*
   * The gap this closes: the mirror carries a screenshot ROW when the grant allows, and that row
   * names a file on the CHILD's disk. A remote device page therefore pointed an <img> at a local
   * path this server has never had — an empty picture frame, no error, and a field that said the
   * screenshot existed.
   *
   * display-capture is its own grant because a screen capture is not metadata about a screen: it is
   * a picture of whatever was visible on it.
   */
  const readProxy = require('../lib/mesh/read-proxy');
  const denied = readProxy.authorize({}, '/api/devices/d1/screenshot', 'GET',
                                     ['health', 'identity', 'content-metadata']);
  assert.equal(denied.ok, false, 'a rich grant without display-capture still cannot see the screen');
  assert.match(denied.reason, /display-capture/);

  const allowed = readProxy.authorize({}, '/api/devices/d1/screenshot', 'GET', ['display-capture']);
  assert.equal(allowed.ok, true);

  // And it is still a read: the write refusal applies to this path like any other.
  assert.equal(readProxy.authorize({}, '/api/devices/d1/screenshot', 'POST', ['display-capture']).ok,
    false);
});

test('the screenshot path is not reachable by traversal', () => {
  // ⚠️ A proxy is a NEW way to reach an old file. A path that was unreachable locally must not
  // become reachable remotely just because a different door was added.
  const readProxy = require('../lib/mesh/read-proxy');
  for (const bad of ['/api/devices/../users/screenshot', '/api/devices//screenshot',
                     '/api/devices/d1/screenshot/../../etc']) {
    assert.equal(readProxy.authorize({}, bad, 'GET', ['display-capture']).ok, false, bad);
  }
});

/*
 * ⚠️ A BATCHED ITEM MUST CARRY ITS OWN ANCESTRY, OR RELAYING IS IMPOSSIBLE.
 *
 * createBatch has always carried per-item ancestry — with a comment saying it exists precisely so a
 * relayed item can be attested, and that without it such an item is refused. sendMany then copied
 * items into the batch field by field and ancestry was not one of the fields, so the code written to
 * carry the proof never received it.
 *
 * The receiver's refusal was CORRECT: an item claiming an origin it cannot prove a path to is
 * exactly what that check exists to stop. The bug was that an honest relay could not prove it
 * either, because the proof was dropped a layer below the code that sends it. Nothing caught it,
 * because nothing had ever relayed anything: the field was written for a feature that did not exist
 * yet, and was broken by the time it did.
 *
 * Found by watching a three-node mesh refuse a screen: B sent ancestry [C,B] and A logged
 * `ancestry=undefined` for the same item.
 */
test('⚠️ sendMany preserves a relayed item\'s ancestry through batching', () => {
  const sent = [];
  /*
   * ⚠️ The double provides timeout(), because the real emit path is `socket.timeout(ms).emit(...)`.
   * Without it the call throws, _emit's try/catch swallows it, and the test simply sees nothing
   * sent — a stub simpler than its collaborator, which is the trap this codebase keeps falling into.
   */
  const sock = {
    on() {}, disconnect() {},
    emit(ev, payload) { sent.push({ ev, payload }); },
    timeout() { return { emit(ev, payload) { sent.push({ ev, payload }); } }; },
  };
  const link = new Uplink({
    parentUrl: 'http://127.0.0.1:9', edgeToken: 't', nodeId: 'node-B',
    connect: () => sock, logger: { log() {}, warn() {} },
  });
  link.socket = sock;
  link.connected = true;
  // Announce batching the way a parent's hello does, so sendMany takes the batch path.
  link.parentCapabilities = { supports: ['batch-v1'], encodings: [], maxBatchItems: 100, maxBatchBytes: 512 * 1024 };

  const own = envelope.createEnvelope({
    originNodeId: 'node-B', type: 'device-summary', bodyVersion: 1,
    ancestry: ['node-B'], originTs: Date.now(), body: { id: 'mine' },
  });
  const relayed = envelope.createEnvelope({
    originNodeId: 'node-C', type: 'device-summary', bodyVersion: 1,
    ancestry: ['node-C', 'node-B'], originTs: Date.now(), body: { id: 'theirs' },
  });

  link.sendMany([own, relayed], { nodeId: 'node-B', ancestry: ['node-B'] });

  const batch = sent.map((x) => x.payload).find((p) => p && p.type === 'batch');
  assert.ok(batch, 'the items should have gone out as a batch');
  const items = envelope.batchItems(batch);
  assert.equal(items.length, 2);

  const theirs = items.find((i) => i.body && i.body.id === 'theirs');
  assert.equal(theirs.origin_node_id, 'node-C');
  assert.deepEqual(theirs.ancestry, ['node-C', 'node-B'],
    'without this the receiver cannot attest the item and refuses it — correctly');

  /*
   * ⚠️ And the ordinary case stays cheap: an item whose origin matches the batch carries neither
   * field. Repeating them 400 times is most of what batching was for.
   */
  const mine = items.find((i) => i.body && i.body.id === 'mine');
  assert.equal(mine.origin_node_id, undefined);
  assert.equal(mine.ancestry, undefined);
});

/*
 * ⚠️ AN ITEM'S OWN CHAIN MUST SURVIVE BEING UNPACKED, or a relay looks like a direct link.
 *
 * The batch validator says it plainly — the batch's ancestry proves the BATCH's path, not the
 * item's — and itemAsEnvelope then handed every item the batch's chain anyway. A payload that
 * arrived having travelled A<-B<-C was stored as though it came straight from B, so everything
 * downstream that reasons about distance saw one hop where there were two.
 *
 * Measured: the top hub reported a server two links away as being one link away.
 */
test('⚠️ itemAsEnvelope keeps a relayed item\'s own ancestry', () => {
  const batch = {
    envelope_version: 1, origin_node_id: 'node-B', ancestry: ['node-B'], receipts: [],
  };
  const relayed = {
    type: 'node-health', body_version: 1, origin_ts: 1,
    origin_node_id: 'node-C', ancestry: ['node-C', 'node-B'], body: { node_id: 'node-C' },
  };
  const own = { type: 'node-health', body_version: 1, origin_ts: 1, body: { node_id: 'node-B' } };

  const asRelayed = envelope.itemAsEnvelope(relayed, batch);
  assert.equal(asRelayed.origin_node_id, 'node-C');
  assert.deepEqual(asRelayed.ancestry, ['node-C', 'node-B'],
    'two links from here, and the chain is the only thing that says so');

  // ⚠️ And an ordinary item still inherits the batch's chain — that omission is what makes
  // batching cheap, and it is correct because such an item did travel the batch's path.
  const asOwn = envelope.itemAsEnvelope(own, batch);
  assert.equal(asOwn.origin_node_id, 'node-B');
  assert.deepEqual(asOwn.ancestry, ['node-B']);
});
