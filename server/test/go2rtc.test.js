'use strict';
// The media plane's pure and fail-soft behaviour. What must hold without a real go2rtc:
//   - stream names are deterministic and workspace-scoped (one workspace cannot name another's)
//   - every network call returns null rather than throwing when go2rtc is absent or down
//   - ICE never leaks admin credentials
// The actual WebRTC media flow needs a live go2rtc + browser and is documented as a manual step.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-go2rtc-'));

test('stream names are deterministic, prefixed, and in go2rtc\'s charset', () => {
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  const a = g.streamName('ws-1', 'dev-1');
  assert.equal(a, g.streamName('ws-1', 'dev-1'), 'stable across calls');
  assert.match(a, /^st_[a-z0-9]+$/, 'prefixed, hex, no unsafe characters');
  assert.equal(g.streamName('', 'dev-1'), null);
  assert.equal(g.streamName('ws-1', null), null);
});

test('a stream name is workspace-scoped: no other pair produces it', () => {
  const g = require('../lib/go2rtc');
  const mine = g.streamName('ws-A', 'dev-1');
  assert.notEqual(mine, g.streamName('ws-B', 'dev-1'), 'different workspace, same device -> different name');
  assert.notEqual(mine, g.streamName('ws-A', 'dev-2'), 'same workspace, different device -> different name');
  // The proxy check: a name is only valid for the pair that made it.
  assert.equal(g.streamBelongsTo(mine, 'ws-A', 'dev-1'), true);
  assert.equal(g.streamBelongsTo(mine, 'ws-B', 'dev-1'), false, 'another workspace cannot claim it');
  assert.equal(g.streamBelongsTo('st_forged', 'ws-A', 'dev-1'), false);
  assert.equal(g.streamBelongsTo(null, 'ws-A', 'dev-1'), false);
});

test('with GO2RTC_URL unset, the plane is disabled and every call is a safe no-op', async () => {
  delete process.env.GO2RTC_URL;
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  assert.equal(g.enabled(), false);
  assert.equal(await g.healthy(), false);
  assert.equal(await g.putStream('st_x', 'rtsp://y'), false);
  assert.equal(await g.deleteStream('st_x'), false);
  assert.equal(await g.hasStream('st_x'), false);
  assert.equal(await g.webrtcExchange('st_x', 'v=0...'), null);
});

test('a down go2rtc yields null/false, never a throw', async () => {
  process.env.GO2RTC_URL = 'http://127.0.0.1:9';   // nothing listens on discard
  process.env.GO2RTC_TIMEOUT_MS = '300';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  assert.equal(g.enabled(), true, 'a URL is set, so it is "on"...');
  assert.equal(await g.healthy(), false, '...but unreachable, so unhealthy, not thrown');
  assert.equal(await g.putStream('st_x', 'rtsp://y'), false);
  assert.equal(await g.webrtcExchange('st_x', 'v=0'), null);
  delete process.env.GO2RTC_URL; delete process.env.GO2RTC_TIMEOUT_MS;
});

test('admin auth is attached from a token or basic creds, and never in ICE', () => {
  process.env.GO2RTC_URL = 'http://go2rtc:1984';
  process.env.GO2RTC_API_TOKEN = 'secret-token';
  process.env.GO2RTC_TURN_URL = 'turn:turn.example:3478';
  process.env.GO2RTC_TURN_USER = 'u'; process.env.GO2RTC_TURN_PASS = 'p';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  assert.equal(g._adminHeaders().Authorization, 'Bearer secret-token');
  const ice = g.iceServers();
  assert.ok(ice.some((s) => /stun:/.test(s.urls)), 'a STUN server is always offered');
  const turn = ice.find((s) => /turn:/.test(s.urls));
  assert.equal(turn.username, 'u'); assert.equal(turn.credential, 'p');
  assert.ok(!JSON.stringify(ice).includes('secret-token'), 'the go2rtc admin token never reaches ICE');
  for (const k of ['GO2RTC_URL', 'GO2RTC_API_TOKEN', 'GO2RTC_TURN_URL', 'GO2RTC_TURN_USER', 'GO2RTC_TURN_PASS']) delete process.env[k];
});

test('health is cached so a page of tiles does not hammer the sidecar', async () => {
  process.env.GO2RTC_URL = 'http://127.0.0.1:9';
  process.env.GO2RTC_HEALTH_TTL_MS = '10000';
  process.env.GO2RTC_TIMEOUT_MS = '300';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { calls++; throw new Error('down'); };
  try {
    g._resetHealth();
    await g.healthy(); await g.healthy(); await g.healthy();
    assert.equal(calls, 1, 'three health checks inside the TTL make one network call');
  } finally { global.fetch = realFetch; for (const k of ['GO2RTC_URL', 'GO2RTC_HEALTH_TTL_MS', 'GO2RTC_TIMEOUT_MS']) delete process.env[k]; }
});

// ensureStream + hasActiveProducer: the publish-path pieces found necessary during live
// verification against a real go2rtc 1.9.14. go2rtc's WHIP (POST /api/webrtc?dst=NAME) 404s on a
// stream that does not exist, and the streams API cannot create an empty one, so ensureStream
// creates it with the inert 'webrtc:' source. hasActiveProducer then answers "is a publisher
// really connected?" — true only for a producer with a real remote_addr, not the placeholder.
test('ensureStream creates a webrtc: placeholder only when the stream is absent', async () => {
  process.env.GO2RTC_URL = 'http://go2rtc:1984';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  const calls = [];
  const realFetch = global.fetch;
  // First: stream absent -> GET returns {}, then a PUT with src=webrtc: must be issued.
  global.fetch = async (url, opts) => {
    calls.push({ method: opts.method, url });
    if (opts.method === 'GET') return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '' };
  };
  try {
    assert.equal(await g.ensureStream('st_abc'), true);
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'a PUT was issued to create the stream');
    assert.match(put.url, /\/api\/streams\?name=st_abc&src=webrtc:/, 'created with the inert webrtc: source');
  } finally { global.fetch = realFetch; delete process.env.GO2RTC_URL; }
});

test('ensureStream is a no-op when the stream already exists (no duplicate placeholder)', async () => {
  process.env.GO2RTC_URL = 'http://go2rtc:1984';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  let puts = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (opts.method === 'PUT') puts++;
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ st_abc: { producers: [{ url: 'webrtc:' }] } }) };
  };
  try {
    assert.equal(await g.ensureStream('st_abc'), true);
    assert.equal(puts, 0, 'an existing stream is not re-created');
  } finally { global.fetch = realFetch; delete process.env.GO2RTC_URL; }
});

test('hasActiveProducer is false for a placeholder-only stream, true once a producer is connected', async () => {
  process.env.GO2RTC_URL = 'http://go2rtc:1984';
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('../lib/go2rtc')];
  const g = require('../lib/go2rtc');
  const realFetch = global.fetch;
  const withStreams = (obj) => { global.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => obj }); };
  try {
    withStreams({ st_abc: { producers: [{ url: 'webrtc:' }], consumers: [] } });
    assert.equal(await g.hasActiveProducer('st_abc'), false, 'inert placeholder is not "publishing"');
    withStreams({ st_abc: { producers: [{ url: 'webrtc:' }, { url: 'webrtc:', remote_addr: '10.0.0.5:33666 host', bytes_recv: 59800 }] } });
    assert.equal(await g.hasActiveProducer('st_abc'), true, 'a producer with a real remote_addr IS publishing');
    withStreams({});
    assert.equal(await g.hasActiveProducer('st_abc'), false, 'absent stream is not publishing');
  } finally { global.fetch = realFetch; delete process.env.GO2RTC_URL; }
});
