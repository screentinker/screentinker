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
