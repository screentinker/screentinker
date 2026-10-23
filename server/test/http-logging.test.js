'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { accessLogger, authenticationFailure } = require('../lib/http-logging');

test('access logger accepts omitted options and resolves the socket IP without a resolver', () => {
  assert.equal(typeof accessLogger(), 'function');
  const lines = [];
  const req = { method: 'GET', socket: { remoteAddress: '::ffff:203.0.113.7' } };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = true;
  accessLogger({ write: line => lines.push(line) })(req, res, () => {});
  res.emit('finish');
  assert.equal(JSON.parse(lines[0].split(' [access] ')[1]).ip, '203.0.113.7');
});

test('access logging records completion once, including anonymous failures, without credentials', () => {
  const lines = [];
  const req = {
    method: 'GET', originalUrl: '/api/hooks/in/id/SECRET?token=SECRET',
    headers: { authorization: 'Bearer SECRET', cookie: 'SECRET' },
    body: { password: 'SECRET' }, socket: { remoteAddress: '::ffff:203.0.113.7' },
  };
  const res = new EventEmitter();
  res.statusCode = 404;
  res.writableFinished = true;
  let next = false;
  accessLogger({ write: s => lines.push(s), getClientIp: () => '::ffff:203.0.113.7' })(req, res, () => { next = true; });
  assert.equal(next, true);
  res.emit('finish');
  res.emit('close');
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SECRET|authorization|cookie|password|\/id\//);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.*Z \[access\] /);
  const record = JSON.parse(lines[0].split(' [access] ')[1]);
  assert.equal(record.ip, '203.0.113.7');
  assert.equal(record.status, 404);
  assert.equal(record.method, 'GET');
  assert.equal(record.route, '-');
  assert.equal(record.aborted, false);
  assert.ok(record.duration_ms >= 0);
});

test('matched routes use templates and aborted responses are recorded', () => {
  const lines = [];
  const req = { method: 'POST', originalUrl: '/api/auth/oidc/secret/callback', route: { path: '/oidc/:slug/callback' }, socket: {} };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = false;
  accessLogger({ write: s => lines.push(s), getClientIp: () => '2001:db8::1' })(req, res, () => {});
  res.emit('close');
  const record = JSON.parse(lines[0].split(' [access] ')[1]);
  assert.equal(record.route, '/oidc/:slug/callback');
  assert.equal(record.aborted, true);
  assert.equal(record.status, 499);
  assert.doesNotMatch(lines[0], /secret/);
});

test('security failures are individual, validated events without account or request data', () => {
  const lines = [];
  for (let i = 0; i < 3; i++) authenticationFailure('::ffff:203.0.113.9', 'password', { write: s => lines.push(s) });
  authenticationFailure('2001:db8::9', 'totp', { write: s => lines.push(s) });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /\[security\] auth_failure ip=203\.0\.113\.9 method=password\n$/);
  assert.match(lines[3], /ip=2001:db8::9 method=totp/);
  const count = lines.length;
  authenticationFailure('203.0.113.9\nFAKE', 'password', { write: s => lines.push(s) });
  authenticationFailure('203.0.113.9', 'password\nFAKE', { write: s => lines.push(s) });
  assert.equal(lines.length, count, 'unvalidated input cannot become a security event');
});

test('security events go only to the SECURITY_LOG file; unset means no file', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-seclog-'));
  const file = path.join(dir, 'security.log');
  const saved = process.env.SECURITY_LOG;
  try {
    delete process.env.SECURITY_LOG;
    authenticationFailure('203.0.113.5', 'password');
    process.env.SECURITY_LOG = file;
    authenticationFailure('203.0.113.5', 'password');
    authenticationFailure('203.0.113.5\nFAKE', 'password');
    await new Promise(r => setTimeout(r, 100));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[security\] auth_failure ip=203\.0\.113\.5 method=password$/);
  } finally {
    if (saved === undefined) delete process.env.SECURITY_LOG; else process.env.SECURITY_LOG = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route includes the router mount path', () => {
  const lines = [];
  const req = { method: 'POST', baseUrl: '/api/auth', route: { path: '/login' }, socket: {} };
  const res = new EventEmitter();
  res.statusCode = 401;
  res.writableFinished = true;
  accessLogger({ write: s => lines.push(s), getClientIp: () => '203.0.113.7' })(req, res, () => {});
  res.emit('finish');
  assert.equal(JSON.parse(lines[0].split(' [access] ')[1]).route, '/api/auth/login');
});

test('Express router errors retain the full route template', async t => {
  const express = require('express');
  for (const scenario of [
    { name: 'synchronous error', path: '/login', url: '/api/auth/login', expected: '/api/auth/login' },
    { name: 'async error in nested routers', path: '/login', url: '/api/auth/login', expected: '/api/auth/login', nested: true },
    { name: 'parameter and query stay private', path: '/oidc/:slug/callback', url: '/api/auth/oidc/SECRET/callback?token=SECRET', expected: '/api/auth/oidc/:slug/callback' },
  ]) {
    await t.test(scenario.name, async () => {
      const app = express();
      let recorded;
      const record = new Promise(resolve => { recorded = resolve; });
      app.use(accessLogger({ write: line => recorded(JSON.parse(line.split(' [access] ')[1])) }));
      const router = express.Router();
      router.get(scenario.path, scenario.nested
        ? async () => { throw new Error('test error'); }
        : () => { throw new Error('test error'); });
      if (scenario.nested) {
        const parent = express.Router();
        parent.use('/auth', router);
        app.use('/api', parent);
      } else app.use('/api/auth', router);
      app.use((err, req, res, next) => res.status(500).end());

      // Exercise Express routing and error unwinding without opening a network port.
      const req = Object.assign(new EventEmitter(), {
        method: 'GET', url: scenario.url, headers: {}, socket: { remoteAddress: '203.0.113.8' },
      });
      const headers = {};
      const res = Object.assign(new EventEmitter(), {
        setHeader(name, value) { headers[name] = value; },
        getHeader(name) { return headers[name]; },
        end() {
          Object.defineProperty(this, 'writableFinished', { value: true });
          this.emit('finish');
        },
      });
      app.handle(req, res);
      const logged = await record;
      assert.equal(logged.status, 500);
      assert.equal(logged.route, scenario.expected);
      assert.doesNotMatch(JSON.stringify(logged), /SECRET|token=/);
    });
  }
});

test('logging failure does not turn a completed response into an exception', () => {
  const req = { method: 'GET', socket: {} };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = true;
  accessLogger({ getClientIp: () => { throw new Error('unavailable'); }, write: () => { throw new Error('unavailable'); } })(req, res, () => {});
  assert.doesNotThrow(() => res.emit('finish'));
  assert.doesNotThrow(() => authenticationFailure('203.0.113.1', 'password', { write: () => { throw new Error('unavailable'); } }));
});
