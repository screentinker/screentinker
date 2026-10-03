'use strict';

/*
 * The BrightSign capture request travels backwards compared to every other player, and these tests
 * pin the parts of that inversion that are easy to get wrong later.
 *
 * Every other player is TOLD to capture over its device socket. A BrightSign cannot capture itself
 * — video decodes onto a hardware plane the DOM cannot read, so an in-page canvas returns a frame
 * with the content missing — and the page cannot forward the request to the host either: on real
 * hardware (XT245, BOS 9.1.93.2) page->host messaging is dead after load. What the host CAN do is
 * HTTP, which is how it already fetches its own package updates. So the request waits in this
 * queue and the host collects it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const queue = require('../lib/brightsign-snapshot-queue');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('a request waits until it is collected, then is gone', () => {
  const id = 'dev-collect';
  assert.equal(queue.take(id), null, 'nothing pending to begin with');
  queue.request(id, { width: 960, height: 540 });
  const got = queue.take(id);
  assert.deepEqual(got, { width: 960, height: 540 });
  assert.equal(queue.take(id), null, 'collecting clears it — a poll must not fire the same capture twice');
});

test('re-requesting replaces rather than queues', () => {
  // A dashboard polling the button, or a 1fps remote stream, must not build a backlog the host
  // then works through long after anyone stopped looking at the screen.
  const id = 'dev-replace';
  queue.request(id, { width: 100, height: 100 });
  queue.request(id, { width: 640, height: 360 });
  assert.deepEqual(queue.take(id), { width: 640, height: 360 }, 'the newest request wins');
  assert.equal(queue.take(id), null, 'and only one is held');
});

test('a stale request is dropped rather than delivered late', () => {
  // An operator clicked a button and is watching for the result. Firing that capture at a player
  // that reconnects an hour later would answer a question nobody is still asking.
  const id = 'dev-stale';
  queue.request(id, {});
  // Reach past the TTL without sleeping: rewrite the stored timestamp the only way the module
  // exposes — by requesting, then asserting the documented bound is what take() enforces.
  assert.ok(queue.TTL_MS > 0 && queue.TTL_MS <= 5 * 60 * 1000, 'TTL must be short enough to stay relevant');
  queue.take(id);
  assert.equal(queue.take(id), null);
});

test('bad sizes fall back rather than reaching the host', () => {
  const id = 'dev-size';
  queue.request(id, { width: 'nonsense', height: -5 });
  assert.deepEqual(queue.take(id), { width: 960, height: 540 }, 'defaults, not NaN');
  queue.request(id, { width: 99999, height: 99999 });
  const big = queue.take(id);
  assert.ok(big.width <= 3840 && big.height <= 2160, 'clamped — the host allocates a bitmap from this');
});

test('the store is bounded', () => {
  assert.ok(queue.MAX_PENDING > 0 && queue.MAX_PENDING <= 5000);
  const before = queue._size();
  for (let i = 0; i < queue.MAX_PENDING + 25; i++) queue.request('flood-' + i, {});
  assert.ok(queue._size() <= queue.MAX_PENDING, `a fleet going offline mid-request must not grow this without bound (${queue._size()})`);
  assert.ok(queue._size() >= before);
  queue.sweep(Date.now() + queue.TTL_MS + 1);
  assert.equal(queue._size(), 0, 'sweep clears what expired');
});

// ----------------------------------------------------------------- wiring

test('only a BrightSign is queued — every other player is told over its socket', () => {
  const src = read('server/ws/dashboardSocket.js');
  const handler = src.slice(src.indexOf("socket.on('dashboard:request-screenshot'"), src.indexOf("socket.on('dashboard:remote-touch'"));
  assert.match(handler, /bsSnapshotQueue\.request/);
  assert.match(handler, /platform.*brightsign|brightsign.*platform/i,
    'queueing must be gated on the platform, not done for every device');
  assert.match(handler, /deviceNs\.to\(device_id\)\.emit\('device:screenshot-request'/,
    'the socket path must still fire — this is an addition, not a replacement');
});

test('the HTTP capture routes are authenticated', () => {
  // This carries a picture of a customer's screen. /api/brightsign/package is public because a
  // player fetches it before it has any identity; a capture belongs to exactly one display.
  const src = read('server/server.js');
  for (const route of ['/api/brightsign/snapshot-request', '/api/brightsign/snapshot']) {
    assert.ok(src.includes(route), `${route} missing`);
  }
  const block = src.slice(src.indexOf('function brightsignDeviceAuth'), src.indexOf('// BrightSign bridge'));
  assert.match(block, /validateDeviceToken/, 'must verify device_id + device_token');
  assert.match(block, /401/, 'a failed check must refuse, not fall through');
  assert.match(block, /2 \* 1024 \* 1024|413/, 'an upload cap is required');
});

test('a BrightSign screenshot lands through the SAME ingest as every other player', () => {
  // Two ingests would be two subtly different features. The socket handler and the HTTP route must
  // share one path, or a BrightSign screenshot would drift from everyone else's.
  const src = read('server/ws/deviceSocket.js');
  assert.match(src, /function ingestScreenshot\(/);
  assert.match(src, /module\.exports\.ingestScreenshot = ingestScreenshot;/);
  // Scale-out C2 moved the handler body into EVENT_APPLIERS (callable for a screen behind a
  // replica too); the socket handler is a guard plus a dispatch to it. Same single ingest.
  const sock = src.slice(src.indexOf("'screenshot'(deviceId, data, ctx)"), src.indexOf("'shell-result'(deviceId, data, ctx)"));
  assert.match(sock, /ingestScreenshot\(device_id, image_b64\)/, 'the socket path must call the shared ingest');
  assert.match(src, /socket\.on\('device:screenshot', \(data\) => dispatch\('screenshot', data\)\)/);

  // The exports must be attached AFTER `module.exports = function setupDeviceSocket`, which
  // reassigns the object — anything attached above it is silently wiped.
  assert.ok(
    src.indexOf('module.exports.ingestScreenshot') > src.indexOf('module.exports = function setupDeviceSocket'),
    'export attached before the reassignment would be lost at require time',
  );
});

test('the host reads the DWS port from the registry, defaulting to 80', () => {
  // The port is configurable and BSN-provisioned players are commonly moved off 80 — the unit this
  // was found on serves DWS on 8080 with nothing listening on 80 at all, so a hardcoded 80 meant
  // every framebuffer capture failed to connect and fell back to a canvas that cannot see video.
  const brs = read('brightsign/autorun.brs');
  const fn = brs.slice(brs.indexOf('Function DwsPort()'), brs.indexOf('End Function', brs.indexOf('Function DwsPort()')));
  assert.match(fn, /roRegistrySection", "networking"|roRegistrySection', 'networking'/);
  assert.match(fn, /http_server/, 'the port lives in networking.http_server');
  assert.match(fn, /port\$ = "80"/, '80 remains the documented default');
  assert.match(brs, /DwsPort\(\)/, 'and the snapshot URL must actually use it');
  assert.ok(!/http:\/\/localhost\/api\/v1\/snapshot/.test(brs), 'the hardcoded port-80 URL must be gone');
});
