'use strict';

// The global abuse backstop (lib/backstop-limit.js). Two halves: the bucket rules against a bare
// Express app with tiny limits (fast, exact), then the real server.js at its DEFAULT limits, to
// prove the thing that matters most — ordinary fleet traffic behind one NAT is never throttled.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const expressRateLimit = require('express-rate-limit');

const { freePort } = require('./helpers/free-port');
const { backstopOptions, parseLimit, isUncounted, DEFAULT_IDENTITY_MAX, DEFAULT_ANON_MAX } = require('../lib/backstop-limit');

async function bareApp({ identityMax, anonMax }) {
  const keys = [];
  const app = express();
  app.use(expressRateLimit(backstopOptions({
    identityMax, anonMax,
    getClientIp: (req) => req.headers['x-test-ip'] || req.ip,
    onReject: (req, res, retryAfter, info) => {
      keys.push(info.key);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests, try again later' });
    },
  })));
  app.use((req, res) => res.json({ ok: true }));
  const port = await freePort();
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const hit = (p, headers = {}, method = 'GET') =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-test-ip': '203.0.113.7', ...headers } });
  const burst = async (n, p, headers, method) => {
    const codes = [];
    for (let i = 0; i < n; i++) codes.push((await hit(p, headers, method)).status);
    return codes;
  };
  return { hit, burst, keys, close: () => new Promise((r) => server.close(r)) };
}

describe('bucket rules', () => {
  test('the ceiling triggers a 429 with the existing JSON shape and standard headers', async () => {
    const a = await bareApp({ identityMax: 5, anonMax: 5 });
    try {
      const codes = await a.burst(5, '/api/devices', { Authorization: 'Bearer tok-a' });
      assert.deepEqual(codes, [200, 200, 200, 200, 200]);
      const r = await a.hit('/api/devices', { Authorization: 'Bearer tok-a' });
      assert.equal(r.status, 429);
      assert.deepEqual(await r.json(), { error: 'Too many requests, try again later' });
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.match(r.headers.get('ratelimit') || '', /limit=5/);
      assert.ok(r.headers.get('ratelimit-policy'));
      assert.equal(r.headers.get('x-ratelimit-limit'), null, 'no legacy headers');
    } finally { await a.close(); }
  });

  test('different tokens behind ONE IP get separate buckets', async () => {
    const a = await bareApp({ identityMax: 3, anonMax: 3 });
    try {
      for (const t of ['one', 'two', 'three']) {
        assert.deepEqual(await a.burst(3, '/api/x', { Authorization: 'Bearer ' + t }), [200, 200, 200], t);
      }
      assert.equal((await a.hit('/api/x', { Authorization: 'Bearer one' })).status, 429);
      // X-Device-Token and ?token= are identities too, each its own bucket.
      assert.deepEqual(await a.burst(3, '/api/x', { 'X-Device-Token': 'dt-1' }), [200, 200, 200]);
      assert.deepEqual(await a.burst(3, '/api/x?token=bs-1'), [200, 200, 200]);
      // ...and anonymous traffic from that IP is not charged for any of it.
      assert.deepEqual(await a.burst(3, '/api/x'), [200, 200, 200]);
    } finally { await a.close(); }
  });

  test('the raw secret never becomes the bucket key', async () => {
    const a = await bareApp({ identityMax: 1, anonMax: 1 });
    try {
      await a.burst(2, '/api/x', { Authorization: 'Bearer super-secret-device-token' });
      assert.equal(a.keys.length, 1);
      assert.match(a.keys[0], /^cred:[0-9a-f]{32}$/);
      assert.doesNotMatch(a.keys[0], /super-secret/);
      // Nor the sha256 the database stores for a token.
      const dbHash = crypto.createHash('sha256').update('super-secret-device-token').digest('hex');
      assert.ok(!dbHash.includes(a.keys[0].slice(5)));
    } finally { await a.close(); }
  });

  test('anonymous: per IP, and per IP+device for a request that names its device', async () => {
    const a = await bareApp({ identityMax: 100, anonMax: 2 });
    try {
      assert.deepEqual(await a.burst(3, '/api/widgets/w/render?device=p1'), [200, 200, 429]);
      assert.deepEqual(await a.burst(2, '/api/widgets/w/render?device=p2'), [200, 200], 'another panel at the site');
      assert.deepEqual(await a.burst(2, '/api/update/check?device_id=p3'), [200, 200]);
      assert.deepEqual(await a.burst(3, '/'), [200, 200, 429], 'no identity at all: the IP');
      assert.deepEqual(await a.burst(2, '/', { 'x-test-ip': '203.0.113.8' }), [200, 200], 'another IP');
      // A device id is not a secret: from another IP it is another bucket, so knowing a panel's id
      // does not let anyone exhaust that panel's allowance.
      assert.deepEqual(await a.burst(2, '/api/widgets/w/render?device=p1', { 'x-test-ip': '198.51.100.9' }), [200, 200]);
    } finally { await a.close(); }
  });

  test('RATE_LIMIT_BACKSTOP=0 turns it off entirely', async () => {
    const a = await bareApp({ identityMax: 0, anonMax: 1 });
    try {
      assert.ok((await a.burst(20, '/api/x', { Authorization: 'Bearer t' })).every((c) => c === 200));
      assert.ok((await a.burst(20, '/api/x')).every((c) => c === 200));
      assert.equal((await a.hit('/api/x')).headers.get('ratelimit'), null, 'not even counted');
    } finally { await a.close(); }
  });

  test('RATE_LIMIT_BACKSTOP_ANON=0 leaves anonymous traffic alone but still bounds a token', async () => {
    const a = await bareApp({ identityMax: 2, anonMax: 0 });
    try {
      assert.ok((await a.burst(20, '/api/x')).every((c) => c === 200));
      assert.deepEqual(await a.burst(3, '/api/x', { Authorization: 'Bearer t' }), [200, 200, 429]);
    } finally { await a.close(); }
  });

  test('static assets, content bytes and socket.io are never counted', async () => {
    const a = await bareApp({ identityMax: 2, anonMax: 2 });
    try {
      for (const p of [
        '/player/index.html', '/player/st-sync.js', '/player', '/uploads/content/a.mp4', '/fonts/x.woff2',
        '/download/apk', '/js/app.js', '/css/site.css', '/favicon.ico', '/socket.io-client/socket.io.min.js',
        '/socket.io/?EIO=4&transport=polling', '/api/content/abc/file', '/api/content/abc/thumbnail',
        '/api/content/abc/bundle', '/api/content/abc/bundle-preview/tok',
      ]) {
        assert.ok((await a.burst(5, p)).every((c) => c === 200), p);
      }
      // The anonymous bucket is still untouched by all of the above.
      assert.deepEqual(await a.burst(3, '/api/x'), [200, 200, 429]);
      // A POST is never a static fetch, and an /api path with a static-looking suffix still counts.
      assert.equal(isUncounted({ method: 'POST', originalUrl: '/player/x.js' }), false);
      // Inside a router req.path is mount-stripped; the verdict follows the full URL.
      assert.equal(isUncounted({ method: 'GET', originalUrl: '/api/content/abc/file?x=1', path: '/abc/file' }), true);
      assert.equal(isUncounted({ method: 'GET', originalUrl: '//player//a.js', path: '/a.js' }), true);
      assert.equal(isUncounted({ method: 'GET', path: '/api/widgets/w/data.json' }), false);
      assert.equal(isUncounted({ method: 'GET', path: '/api/brightsign/x.js' }), false);
    } finally { await a.close(); }
  });

  test('parseLimit: unset/junk = default, explicit 0 = off', () => {
    assert.equal(parseLimit(undefined, 6000), 6000);
    assert.equal(parseLimit('', 6000), 6000);
    assert.equal(parseLimit('abc', 6000), 6000);
    assert.equal(parseLimit('-5', 6000), 6000);
    assert.equal(parseLimit('0', 6000), 0);
    assert.equal(parseLimit(' 1500 ', 6000), 1500);
    assert.ok(DEFAULT_IDENTITY_MAX >= 1000 && DEFAULT_ANON_MAX >= 1000, 'generous by design');
  });
});

// ─── the real server ───────────────────────────────────────────────────────────────────────────

async function boot(extraEnv) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), 'st-backstop-' + crypto.randomBytes(4).toString('hex'));
  const log = dataDir + '.log';
  const logFd = fs.openSync(log, 'w');
  const env = { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', ...extraEnv };
  for (const k of ['RATE_LIMIT_BACKSTOP', 'RATE_LIMIT_BACKSTOP_ANON']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(log, 'utf8').slice(-2000));
  const kill = () => { try { proc.kill('SIGKILL'); } catch { /* */ } fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { base, kill };
}

describe('server.js at its default limits', () => {
  let s;
  before(async () => { s = await boot({}); });
  after(() => s && s.kill());

  test('a burst of hundreds from one device token behind a shared IP is never limited', async () => {
    const NAT = '198.51.77.1';
    const statuses = [];
    // In parallel batches, as a busy player and its widgets would actually arrive.
    for (let b = 0; b < 10; b++) {
      const rs = await Promise.all(Array.from({ length: 50 }, () => fetch(s.base + '/api/embedded/info', {
        headers: { Authorization: 'Bearer some-device-token', 'X-Forwarded-For': NAT },
      })));
      for (const r of rs) { statuses.push(r.status); await r.arrayBuffer(); }
    }
    assert.equal(statuses.length, 500);
    assert.ok(!statuses.includes(429), 'not one 429');
    const r = await fetch(s.base + '/api/status', { headers: { 'X-Forwarded-For': NAT } });
    assert.match(r.headers.get('ratelimit') || '', new RegExp(`limit=${DEFAULT_ANON_MAX}`), 'the backstop is live, and generous');
  });

  test('many panels behind the same NAT, each with its own token, never collide', async () => {
    const NAT = '198.51.77.2';
    const rs = await Promise.all(Array.from({ length: 300 }, (_, i) => fetch(s.base + '/api/status', {
      headers: { Authorization: `Bearer panel-${i}`, 'X-Forwarded-For': NAT },
    })));
    assert.ok(rs.every((r) => r.status !== 429));
  });
});

describe('server.js with a low ceiling', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_BACKSTOP: '40', RATE_LIMIT_BACKSTOP_ANON: '20' }); });
  after(() => s && s.kill());

  test('the ceiling 429s with the shape the existing limiter uses, and MCP gets JSON-RPC', async () => {
    const IP = '198.51.78.1';
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await fetch(s.base + '/api/status', { headers: { 'X-Forwarded-For': IP } })).status);
    assert.equal(codes.filter((c) => c === 429).length, 1);
    const r = await fetch(s.base + '/api/status', { headers: { 'X-Forwarded-For': IP } });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'Too many requests, try again later' });
    assert.ok(r.headers.get('retry-after'));
    const m = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(m.status, 429);
    const body = await m.json();
    assert.equal(body.jsonrpc, '2.0', 'an MCP client still gets an error it can parse');
  });

  test('a request through a router that also mounts the backstop is counted ONCE', async () => {
    // /api/devices is mounted from the api-surface loop AND starts with router.use(backstop).
    const codes = [];
    for (let i = 0; i < 41; i++) {
      const r = await fetch(s.base + '/api/devices', { headers: { Authorization: 'Bearer count-once', 'X-Forwarded-For': '198.51.78.3' } });
      codes.push(r.status); await r.arrayBuffer();
    }
    assert.ok(!codes.slice(0, 40).includes(429), 'all 40 of the identity allowance, not 20');
    assert.equal(codes[40], 429);
  });

  test('content bytes stay uncounted inside the router mount too', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(s.base + '/api/content/nope/file', { headers: { 'X-Forwarded-For': '198.51.78.4' } });
      assert.notEqual(r.status, 429); await r.arrayBuffer();
    }
  });

  test('static and socket.io paths do not count even at a low ceiling', async () => {
    const IP = '198.51.78.2';
    for (let i = 0; i < 30; i++) {
      for (const p of ['/player/st-sync.js', '/socket.io-client/socket.io.min.js', '/socket.io/?EIO=4&transport=polling']) {
        const r = await fetch(s.base + p, { headers: { 'X-Forwarded-For': IP } });
        assert.notEqual(r.status, 429, p);
        await r.arrayBuffer();
      }
    }
  });
});

describe('server.js with RATE_LIMIT_BACKSTOP=0', () => {
  let s;
  before(async () => { s = await boot({ RATE_LIMIT_BACKSTOP: '0', RATE_LIMIT_BACKSTOP_ANON: '1' }); });
  after(() => s && s.kill());

  test('nothing is limited or even counted', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await fetch(s.base + '/api/status', { headers: { 'X-Forwarded-For': '198.51.79.1' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('ratelimit'), null);
    }
  });
});
