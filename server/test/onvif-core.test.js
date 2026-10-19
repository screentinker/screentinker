'use strict';

/*
 * ONVIF core (lib/onvif/*): the SOAP messages and parsing, HTTP Digest, and a camera session over
 * the server transport against a fake camera that authenticates for real (test/helpers/fake-onvif-camera.js).
 */

process.env.OUTBOUND_ALLOW_PRIVATE = '1';   // the fake camera is on 127.0.0.1

const { test } = require('node:test');
const assert = require('node:assert/strict');
const soap = require('../lib/onvif/soap');
const digest = require('../lib/onvif/http-digest');
const { OnvifCamera, discover, xaddrFrom, reaim, fixLocalHost } = require('../lib/onvif/camera');
const { serverTransport } = require('../lib/onvif/transport');
const { startFakeCamera } = require('./helpers/fake-onvif-camera');

// ─── Messages and parsing ────────────────────────────────────────────────────

test('WS-Security PasswordDigest is Base64(SHA1(nonce + created + password))', () => {
  // A worked value: nonce 16 zero bytes, created 2026-01-01T00:00:00Z, password "secret".
  const d = soap.passwordDigest(Buffer.alloc(16), '2026-01-01T00:00:00Z', 'secret');
  const want = require('crypto').createHash('sha1')
    .update(Buffer.concat([Buffer.alloc(16), Buffer.from('2026-01-01T00:00:00Zsecret')])).digest('base64');
  assert.equal(d, want);
  const h = soap.securityHeader({ username: 'a<b', password: 'x', nonce: Buffer.alloc(16), created: '2026-01-01T00:00:00Z' });
  assert.match(h, /<Username>a&lt;b<\/Username>/, 'user values are escaped');
  assert.match(h, /PasswordDigest/);
  assert.equal(soap.envelope('<X/>').includes('Security'), false, 'no header without credentials');
});

test('request bodies escape tokens and clamp PTZ speeds', () => {
  assert.match(soap.body.getStreamUri(false, 'a&b'), /<ProfileToken>a&amp;b<\/ProfileToken>/);
  const m = soap.body.continuousMove('p', { pan: 5, tilt: -0.25, zoom: 'x' }, 99);
  assert.match(m, /x="1" y="-0.25"/);
  assert.match(m, /<Zoom x="0"/);
  assert.match(m, /<Timeout>PT10S<\/Timeout>/, 'the auto-stop timeout is capped');
});

test('a SOAP fault becomes an OnvifError; NotAuthorized gets its own code', () => {
  const f = (code) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:${code}</s:Value></s:Subcode></s:Code><s:Reason><s:Text>nope</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
  assert.throws(() => soap.parseReply.ok(f('NotAuthorized')), (e) => e.code === 'not-authorized');
  assert.throws(() => soap.parseReply.ok(f('ActionNotSupported')), (e) => e.code === 'fault' && /nope/.test(e.message));
  assert.throws(() => soap.parseReply.ok('<html>login</html>'), (e) => e.code === 'not-soap');
  assert.throws(() => soap.parseReply.ok('<s:Envelope xmlns:s="x"><unclosed></s:Envelope>'), (e) => e.code === 'bad-xml');
});

test('probe matches: names and hardware from scopes, http XAddrs only, garbage ignored', () => {
  const xml = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="x" xmlns:a="y"><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:1</a:Address></a:EndpointReference><d:Scopes>onvif://www.onvif.org/name/Front%20Door onvif://www.onvif.org/hardware/IPC</d:Scopes><d:XAddrs>http://10.0.0.5/onvif/device_service soap.udp://x</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
  assert.deepEqual(soap.parseReply.probeMatches(xml), [{ endpoint: 'urn:uuid:1', xaddrs: ['http://10.0.0.5/onvif/device_service'], name: 'Front Door', hardware: 'IPC', location: '' }]);
  assert.deepEqual(soap.parseReply.probeMatches('not xml'), []);
});

test('credentials go into an RTSP address, encoded; other schemes are left alone', () => {
  assert.equal(soap.withCredentials('rtsp://10.0.0.5:554/s', 'ad min', 'p@ss:w'), 'rtsp://ad%20min:p%40ss%3Aw@10.0.0.5:554/s');
  assert.equal(soap.withCredentials('http://10.0.0.5/s', 'a', 'b'), 'http://10.0.0.5/s');
  assert.equal(soap.withCredentials('rtsp://10.0.0.5/s', '', 'b'), 'rtsp://10.0.0.5/s');
});

test('addresses: typed hosts become device service URLs; advertised hosts are re-aimed; 0.0.0.0 is fixed', () => {
  assert.equal(xaddrFrom('192.168.1.20'), 'http://192.168.1.20/onvif/device_service');
  assert.equal(xaddrFrom('cam.local:8080'), 'http://cam.local:8080/onvif/device_service');
  assert.equal(xaddrFrom('http://10.0.0.9:8000'), 'http://10.0.0.9:8000/onvif/device_service');
  assert.equal(xaddrFrom('rm -rf /'), null);
  assert.equal(reaim('http://172.17.0.4:8899/onvif/media', 'http://192.168.1.20/onvif/device_service'), 'http://192.168.1.20:8899/onvif/media');
  assert.equal(fixLocalHost('rtsp://0.0.0.0:554/s', 'http://192.168.1.20/onvif/device_service'), 'rtsp://192.168.1.20:554/s');
});

test('HTTP Digest matches the RFC 2617 worked example', () => {
  const ch = digest.parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const h = digest.authorization(ch, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', cnonce: '0a4f113b', nc: 1 });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.equal(digest.parseChallenge('Basic realm="x"'), null);
});

// ─── A camera session against the fake camera ────────────────────────────────

test('WS-Security camera: identity, profiles, stream address with credentials, snapshot', async (t) => {
  const cam = await startFakeCamera({ clockSkewSec: 120 });   // two minutes off: the token must use ITS clock
  t.after(() => cam.close());
  const c = new OnvifCamera(serverTransport(), { xaddr: cam.xaddr, username: 'admin', password: 'secret' });
  const info = await c.connect();
  assert.equal(info.manufacturer, 'FakeCam');
  assert.ok(Math.abs(info.time_offset_ms - 120000) < 3000, 'the clock offset was learned');
  const profiles = await c.profiles();
  assert.deepEqual(profiles.map((p) => [p.token, p.width, p.ptz]), [['main', 1920, false], ['sub', 640, false]]);
  assert.equal(await c.streamUri('sub'), 'rtsp://admin:secret@127.0.0.1:554/sub', '0.0.0.0 became the camera host, credentials put in');
  const snap = await c.snapshot('main');
  assert.equal(snap.type, 'image/jpeg');
  assert.deepEqual(snap.buffer, cam.jpeg, 'the snapshot passed Digest');
});

test('a wrong password is "not-authorized", not a generic failure', async (t) => {
  const cam = await startFakeCamera();
  t.after(() => cam.close());
  const c = new OnvifCamera(serverTransport(), { xaddr: cam.xaddr, username: 'admin', password: 'wrong' });
  await assert.rejects(c.connect(), (e) => e.code === 'not-authorized');
});

test('HTTP-Digest-only camera, Media2-only camera, old firmware without GetServices', async (t) => {
  const d = await startFakeCamera({ auth: 'both' });
  const m2 = await startFakeCamera({ media2Only: true });
  const old = await startFakeCamera({ oldFirmware: true });
  t.after(() => Promise.all([d.close(), m2.close(), old.close()]));

  const a = new OnvifCamera(serverTransport(), { xaddr: d.xaddr, username: 'admin', password: 'secret' });
  await a.connect();
  assert.equal((await a.profiles()).length, 2, 'Digest challenge answered, then WS-Security accepted');

  const b = new OnvifCamera(serverTransport(), { xaddr: m2.xaddr, username: 'admin', password: 'secret' });
  await b.connect();
  const p = await b.profiles();
  assert.deepEqual(p.map((x) => [x.token, x.encoding, x.width]), [['main', 'H265', 2560], ['sub', 'H264', 640]]);
  assert.ok(m2.calls.some((x) => x.name === 'GetProfiles' && /ver20\/media/.test(x.body)), 'asked through Media2');

  const c = new OnvifCamera(serverTransport(), { xaddr: old.xaddr, username: 'admin', password: 'secret' });
  const info = await c.connect();
  assert.match(info.services.media, /\/onvif\/media$/, 'fell back to GetCapabilities');
});

test('PTZ: presets, a move with clamped speeds, stop, go to preset, home; refused on a fixed camera', async (t) => {
  const cam = await startFakeCamera({ ptz: true });
  const fixed = await startFakeCamera();
  t.after(() => Promise.all([cam.close(), fixed.close()]));
  const c = new OnvifCamera(serverTransport(), { xaddr: cam.xaddr, username: 'admin', password: 'secret' });
  await c.connect();
  const profiles = await c.profiles();
  assert.equal(profiles.find((x) => x.token === 'main').ptz, true);
  assert.deepEqual(await c.presets('main'), [{ token: '1', name: 'Door' }, { token: '2', name: 'Car park' }]);
  await c.move('main', { pan: 2, tilt: -0.5, zoom: 0 });
  await c.stop('main');
  await c.gotoPreset('main', '2');
  await c.home('main');
  assert.deepEqual(cam.ptzLog, [
    { op: 'ContinuousMove', token: 'main', pan: 1, tilt: -0.5, zoom: 0 },
    { op: 'Stop', token: 'main' },
    { op: 'GotoPreset', token: 'main', preset: '2' },
    { op: 'GotoHomePosition', token: 'main' },
  ]);
  const f = new OnvifCamera(serverTransport(), { xaddr: fixed.xaddr, username: 'admin', password: 'secret' });
  await f.connect();
  await assert.rejects(f.move('main', { pan: 1 }), (e) => e.code === 'no-ptz');
});

test('discovery: a unicast probe finds the camera, prefers its IPv4 address, merges duplicates', async (t) => {
  const cam = await startFakeCamera();
  t.after(() => cam.close());
  const found = await discover(serverTransport(), { host: '127.0.0.1', port: cam.discoveryPort, timeoutMs: 800 });
  assert.equal(found.length, 1, 'two Probes, one camera');
  assert.equal(found[0].xaddr, cam.xaddr);
  assert.equal(found[0].name, 'Lobby Cam');
  assert.equal(found[0].hardware, 'FC-1');
});

test('the server transport refuses private addresses unless the operator opened them', async () => {
  const saved = process.env.OUTBOUND_ALLOW_PRIVATE;
  process.env.OUTBOUND_ALLOW_PRIVATE = '';
  try {
    const c = new OnvifCamera(serverTransport(), { xaddr: 'http://192.168.1.20/onvif/device_service', username: 'a', password: 'b' });
    await assert.rejects(c.connect(), (e) => e.code === 'server-blocked' && /OUTBOUND_ALLOW/.test(e.message));
    await assert.rejects(discover(serverTransport(), {}), (e) => e.code === 'server-blocked');
  } finally {
    process.env.OUTBOUND_ALLOW_PRIVATE = saved;
  }
});
