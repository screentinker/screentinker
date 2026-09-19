'use strict';

// The replica write proxy (lib/replica-proxy.js) against a fake HTTP primary. Express is used for
// the replica side so req/res have the same shape the tenancy resolver hands the proxy.

const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const proxy = require('../lib/replica-proxy');

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** A fake primary that records what it received and answers whatever the test asked for. */
async function fakePrimary(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(rec);
      handler(rec, res);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

/** A replica app: every /api/* request goes to the proxy with the given config. */
async function replicaApp(config, opts) {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.all('/api/*', (req, res) => proxy.proxyToPrimary(req, res, config, opts));
  const { srv, port } = await listen(app);
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

test('no PRIMARY_URL: 409 read_only_replica, nothing is applied', async () => {
  const r = await replicaApp({ primaryUrl: null });
  try {
    const res = await fetch(`${r.url}/api/devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'read_only_replica');
  } finally { r.close(); }
});

test('a JSON write is forwarded verbatim: method, path, body, Authorization; Host and Cookie are not', async () => {
  const p = await fakePrimary((rec, res) => { res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'a=b'); res.end(JSON.stringify({ id: 'new', echo: JSON.parse(rec.body) })); });
  const r = await replicaApp({ primaryUrl: p.url });
  try {
    const res = await fetch(`${r.url}/api/devices/abc/rename?x=1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user-jwt', cookie: 'session=zzz', 'x-custom': 'kept' },
      body: JSON.stringify({ name: 'Lobby' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-st-served-by'), 'primary');
    assert.equal(res.headers.get('set-cookie'), null, 'the primary\'s cookies never reach the browser through a replica');
    assert.deepEqual(await res.json(), { id: 'new', echo: { name: 'Lobby' } });
    const got = p.seen[0];
    assert.equal(got.method, 'PUT');
    assert.equal(got.url, '/api/devices/abc/rename?x=1');
    assert.equal(got.headers.authorization, 'Bearer user-jwt');
    assert.equal(got.headers['x-custom'], 'kept');
    assert.equal(got.headers.cookie, undefined, 'cookie stripped: replica writes assume Bearer');
    assert.equal(got.headers.host, `127.0.0.1:${new URL(p.url).port}`, 'Host recomputed for the primary');
    assert.equal(got.headers[proxy.HOP_HEADER], '1');
    assert.match(got.headers['x-forwarded-for'], /127\.0\.0\.1/);
  } finally { r.close(); p.close(); }
});

test('upstream 401/403 pass through untouched — a refusal is not an outage', async () => {
  const p = await fakePrimary((rec, res) => { res.statusCode = 403; res.setHeader('content-type', 'application/json'); res.end('{"error":"forbidden by primary"}'); });
  const r = await replicaApp({ primaryUrl: p.url });
  try {
    const res = await fetch(`${r.url}/api/x`, { method: 'DELETE', headers: { authorization: 'Bearer nope' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden by primary');
  } finally { r.close(); p.close(); }
});

test('a request that already crossed a replica is refused with 508 proxy_loop', async () => {
  const p = await fakePrimary((rec, res) => res.end('never'));
  const r = await replicaApp({ primaryUrl: p.url });
  try {
    const res = await fetch(`${r.url}/api/x`, { method: 'POST', headers: { [proxy.HOP_HEADER]: '1' } });
    assert.equal(res.status, 508);
    assert.equal((await res.json()).code, 'proxy_loop');
    assert.equal(p.seen.length, 0, 'the loop is cut before the second hop');
  } finally { r.close(); p.close(); }
});

test('a dead primary answers 503 primary_unreachable with retry_after; a slow one times out to the same', async () => {
  // Dead: a port nothing listens on.
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`; await new Promise((r) => dead.close(r));
  const r1 = await replicaApp({ primaryUrl: deadUrl });
  try {
    const res = await fetch(`${r1.url}/api/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'primary_unreachable');
    assert.equal(body.retry_after, 30);
  } finally { r1.close(); }
  // Slow: never answers.
  const p = await fakePrimary(() => { /* hang */ });
  const r2 = await replicaApp({ primaryUrl: p.url }, { timeoutMs: 300 });
  try {
    const t0 = Date.now();
    const res = await fetch(`${r2.url}/api/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'primary_unreachable');
    assert.ok(Date.now() - t0 < 5000, 'timed out on the configured timeout, not the socket default');
  } finally { r2.close(); p.close(); }
});

test('PRIMARY_REDIRECT: 307 with a Location on the primary, and the primary is not contacted', async () => {
  const p = await fakePrimary((rec, res) => res.end('never'));
  const r = await replicaApp({ primaryUrl: p.url, primaryRedirect: true });
  try {
    const res = await fetch(`${r.url}/api/devices/abc?y=2`, { method: 'PATCH', redirect: 'manual' });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), `${p.url}/api/devices/abc?y=2`);
    assert.equal(p.seen.length, 0);
  } finally { r.close(); p.close(); }
});

test('an oversized body is refused locally with 413 before it is forwarded', async () => {
  const p = await fakePrimary((rec, res) => res.end('never'));
  const r = await replicaApp({ primaryUrl: p.url });
  try {
    const res = await fetch(`${r.url}/api/content`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(proxy.MAX_BODY_BYTES + 1) },
      body: new ReadableStream({ start(c) { c.close(); } }), duplex: 'half',
    }).catch(() => null);
    // Either the replica refused (413) or the socket was cut on the declared length; the primary saw nothing.
    if (res) assert.equal(res.status, 413);
    assert.equal(p.seen.length, 0);
  } finally { r.close(); p.close(); }
});

test('a non-JSON body (multipart-shaped) is streamed through unchanged', async () => {
  const p = await fakePrimary((rec, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ len: rec.body.length, ct: rec.headers['content-type'] })); });
  const r = await replicaApp({ primaryUrl: p.url });
  try {
    const payload = 'x'.repeat(5000);
    const res = await fetch(`${r.url}/api/content/upload`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=abc' }, body: payload });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { len: 5000, ct: 'multipart/form-data; boundary=abc' });
  } finally { r.close(); p.close(); }
});
