'use strict';
/**
 * #900: the import said "That address is not allowed from this server (private, internal or metadata
 * addresses are blocked)" for a Xibo name the Docker container simply could not resolve. A name that
 * does not resolve must say so, and a refused address must name itself and (self-hosted) the
 * setting that opens it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.OUTBOUND_ALLOW_PRIVATE;
delete process.env.OUTBOUND_ALLOW_HOSTS;

const config = require('../config');
const transport = require('../lib/migrate/transport');

async function withSelfHosted(v, fn) {
  const prev = config.selfHosted;
  config.selfHosted = v;
  try { return await fn(); } finally { config.selfHosted = prev; }
}

async function rejection(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a rejection');
}

// RFC 6761: .invalid never resolves, so this is a DNS failure on every machine, offline or not.
const NOWHERE = 'http://xibo.screentinker-test.invalid';

test('a name this server cannot resolve says so, not "blocked"', async () => {
  await withSelfHosted(true, async () => {
    const e = await rejection(() => transport.client(NOWHERE).api('/api/about'));
    assert.equal(e.name, 'MigrateHttpError');
    assert.equal(e.code, 'unresolved');
    assert.match(e.message, /could not look up xibo\.screentinker-test\.invalid/);
    assert.match(e.message, /Docker/);
    assert.match(e.message, /extra_hosts/);
    assert.doesNotMatch(e.message, /not allowed|blocked/);
  });
});

test('the Docker advice is only for the person who runs the server', async () => {
  await withSelfHosted(false, async () => {
    const e = await rejection(() => transport.client(NOWHERE).api('/api/about'));
    assert.equal(e.code, 'unresolved');
    assert.doesNotMatch(e.message, /Docker|extra_hosts/);
    assert.match(e.message, /reachable from the internet/);
  });
});

test('a download from an unresolvable host says the same', async () => {
  await withSelfHosted(true, async () => {
    const os = require('node:os');
    const path = require('node:path');
    const dest = path.join(os.tmpdir(), `st-mig-${process.pid}-${Date.now()}.bin`);
    const e = await rejection(() => transport.client(NOWHERE).download('/api/library/download/1', dest, 1e6));
    assert.equal(e.code, 'unresolved');
  });
});

test('a refused address names the address, and self-hosted gets the setting that opens it', async () => {
  await withSelfHosted(true, async () => {
    const e = transport._ssrfErrorForTest({ name: 'SsrfError', code: 'ssrf', reason: 'blocked-ip:10.1.2.3' }, 'http://xibo.corp.lan/api');
    assert.equal(e.code, 'blocked');
    assert.match(e.message, /xibo\.corp\.lan \(10\.1\.2\.3\)/);
    assert.match(e.message, /OUTBOUND_ALLOW_HOSTS or OUTBOUND_ALLOW_PRIVATE/);
    const lit = await rejection(async () => transport.normalizeBaseUrl('http://127.0.0.1:8080'));
    assert.equal(lit.code, 'blocked');
    assert.match(lit.message, /\(127\.0\.0\.1\)/);
    assert.match(lit.message, /OUTBOUND_ALLOW/);
  });
  await withSelfHosted(false, async () => {
    const lit = await rejection(async () => transport.normalizeBaseUrl('http://127.0.0.1:8080'));
    assert.equal(lit.code, 'blocked');
    assert.doesNotMatch(lit.message, /OUTBOUND_ALLOW/, 'a hosted user cannot set server variables');
  });
});

test('the real wire still refuses a metadata address, now naming it', async () => {
  await withSelfHosted(true, async () => {
    const e = await rejection(() => transport.client('http://169.254.169.254').api('/latest/meta-data'));
    assert.equal(e.code, 'blocked');
    assert.match(e.message, /169\.254\.169\.254/);
  });
});

/*
 * #900 part 2: "The server could not be reached" with packets flowing between the servers. The
 * message and the server log now carry the cause.
 */
const http = require('node:http');
const net = require('node:net');

async function withLocalServer(handler, fn) {
  const srv = handler.length === 1 ? net.createServer(handler) : http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prevAllow = process.env.OUTBOUND_ALLOW_PRIVATE;
  process.env.OUTBOUND_ALLOW_PRIVATE = 'true';    // the guard must let us reach 127.0.0.1
  transport._setSleep(() => Promise.resolve());   // retries without waiting
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, warns); } finally {
    console.warn = origWarn;
    transport._setSleep(null);
    if (prevAllow === undefined) delete process.env.OUTBOUND_ALLOW_PRIVATE; else process.env.OUTBOUND_ALLOW_PRIVATE = prevAllow;
    await new Promise((r) => srv.close(r));
  }
}

test('a connection reset says "connection reset", is retried, and is logged without the query', async () => {
  let hits = 0;
  await withLocalServer((sock) => { hits++; sock.resetAndDestroy(); }, async (base, warns) => {
    const e = await rejection(() => transport.client(base).api('/api/layout', { query: { embed: 'regions', token: 'SECRET' } }));
    assert.equal(e.code, 'network');
    assert.equal(e.detail, 'connection reset');
    assert.match(e.message, /could not be reached \(connection reset from 127\.0\.0\.1\)/);
    assert.equal(hits, transport.MAX_RETRIES + 1, 'retried, then gave up');
    assert.ok(warns.some((w) => w === '[migrate] 127.0.0.1/api/layout: connection reset'), warns.join('\n'));
    assert.ok(!warns.some((w) => /SECRET|embed/.test(w)), 'the query never reaches the log');
  });
});

test('a redirect loop says "too many redirects"', async () => {
  await withLocalServer((req, res) => { res.writeHead(302, { Location: req.url }); res.end(); }, async (base) => {
    const e = await rejection(() => transport.client(base).api('/api/library'));
    assert.equal(e.code, 'network');
    assert.match(e.message, /too many redirects/);
  });
});

test('TLS and other socket codes become words; unknown or odd codes stay safe', () => {
  const d = (code) => transport._networkDetailForTest({ code });
  assert.equal(d('DEPTH_ZERO_SELF_SIGNED_CERT'), 'TLS certificate not trusted, DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(d('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'TLS certificate not trusted, UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.equal(d('CERT_HAS_EXPIRED'), 'TLS certificate not trusted, CERT_HAS_EXPIRED');
  assert.equal(d('ERR_TLS_CERT_ALTNAME_INVALID'), 'TLS certificate does not match the name');
  assert.equal(d('EPROTO'), 'TLS error, EPROTO');
  assert.equal(d('ECONNREFUSED'), 'connection refused');
  assert.equal(d('HPE_INVALID_CONSTANT'), 'invalid HTTP response');
  assert.equal(d('ESOMETHINGNEW'), 'ESOMETHINGNEW');
  assert.equal(d('https://user:pw@x/ y'), 'network error', 'anything that is not a plain code is not echoed');
  assert.equal(transport._networkDetailForTest(null), 'network error');
});
