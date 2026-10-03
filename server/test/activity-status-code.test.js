'use strict';

// activity_log.status_code + the widened audit gate.
//
// The bug: activityLogger wrapped res.json and gated on `res.statusCode < 400`, so a mutation that
// failed left NO row — indistinguishable, from the data, from one that never happened. Prod carried
// 12,667 audited requests and ZERO recorded failures outside the explicit auth:login_failed event.
// Wrapping res.json also meant a route replying with res.send()/sendStatus()/end() was never
// audited at all, so coverage depended on how each handler chose to answer.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-actstatus-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { db } = require('../db/database');
const { activityLogger, logActivity } = require('../services/activity');

let server, base;

function app() {
  const a = express();
  a.use(express.json());
  // stand in for requireAuth: a header decides who (if anyone) is calling
  a.use((req, res, next) => { if (req.headers['x-user']) req.user = { id: req.headers['x-user'] }; next(); });
  a.use(activityLogger);
  a.post('/ok', (req, res) => res.json({ ok: true }));
  a.post('/boom', (req, res) => res.status(500).json({ error: 'nope' }));
  a.post('/denied', (req, res) => res.status(403).json({ error: 'no' }));
  a.post('/missing', (req, res) => res.status(404).json({ error: 'gone' }));
  // replies WITHOUT res.json — the shape the old wrapper never saw
  a.post('/plain', (req, res) => res.status(204).end());
  a.post('/sendstatus', (req, res) => res.sendStatus(201));
  a.get('/read', (req, res) => res.json({ ok: true }));
  return a;
}

before(async () => {
  db.prepare("INSERT OR IGNORE INTO users (id, email) VALUES ('u1','u1@t.local')").run();
  server = http.createServer(app());
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));
beforeEach(() => db.prepare('DELETE FROM activity_log').run());

async function call(pathname, { user, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['x-user'] = user;
  const res = await fetch(base + pathname, { method, headers, body: method === 'GET' ? undefined : '{}' });
  // 'finish' fires as the response completes; yield once so the handler has run.
  await new Promise(r => setTimeout(r, 30));
  return res;
}
const rows = () => db.prepare('SELECT action, status_code, user_id FROM activity_log ORDER BY id').all();

test('a successful mutation records its status, not just the fact it happened', async () => {
  await call('/ok', { user: 'u1' });
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status_code, 200, 'the status is persisted');
  assert.match(r[0].action, /POST \/ok/);
});

test('THE BUG: a 500 is audited instead of vanishing', async () => {
  await call('/boom', { user: 'u1' });
  const r = rows();
  assert.equal(r.length, 1, 'a failed mutation leaves a row');
  assert.equal(r[0].status_code, 500);
});

test("a signed-in user's 403 is audited — it is their history", async () => {
  await call('/denied', { user: 'u1' });
  assert.equal(rows()[0].status_code, 403);
});

test('an ANONYMOUS 4xx is NOT audited, so scanners cannot flood the table', async () => {
  await call('/missing');          // no x-user: this is what /wp-login.php traffic looks like
  await call('/denied');
  assert.deepEqual(rows(), [], 'unauthenticated client errors are dropped');
});

test('an anonymous SUCCESS is not audited either — the rule is ownership, not status', async () => {
  // Regression guard. The old middleware wrapped res.json, so an endpoint could dodge auditing by
  // replying with res.end() — routes/widgets.js telemetry does exactly that on purpose. Hooking
  // 'finish' removed that accident, so the property has to be enforced here or a public
  // high-frequency endpoint silently starts writing an audit row per call.
  await call('/ok');
  await call('/plain');
  assert.deepEqual(rows(), [], 'an unauthenticated caller cannot grow activity_log');
});

test('a request owned by a DEVICE is audited even with no user', async () => {
  const res = await fetch(base + '/ok', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'dev-7' }),
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(res.status, 200);
  const r = rows();
  assert.equal(r.length, 1, 'device-owned traffic is still audited');
  assert.equal(r[0].status_code, 200);
});

test('an anonymous 5xx IS audited — a server error is ours, whoever triggered it', async () => {
  await call('/boom');
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status_code, 500);
  assert.equal(r[0].user_id, null);
});

test('responses that never call res.json are audited too (res.end / sendStatus)', async () => {
  await call('/plain', { user: 'u1' });
  await call('/sendstatus', { user: 'u1' });
  const r = rows();
  assert.equal(r.length, 2, 'the old res.json wrapper saw neither of these');
  assert.deepEqual(r.map(x => x.status_code).sort(), [201, 204]);
});

test('reads are still not audited', async () => {
  await call('/read', { user: 'u1', method: 'GET' });
  assert.deepEqual(rows(), []);
});

test('direct logActivity callers still work and leave status_code NULL', () => {
  logActivity('u1', 'auth:login_success', null, null, '10.0.0.1');
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status_code, null, 'a named event is not an HTTP request and has no status');
});
