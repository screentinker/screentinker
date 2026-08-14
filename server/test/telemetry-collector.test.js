'use strict';

// The collector and the public aggregate it feeds. Both were previously inline in server.js
// with no test at all — the endpoint that decides what a public marketing page claims, and the
// unauthenticated one anyone on the internet can POST to.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.exec(`CREATE TABLE telemetry_reports (
  instance_id TEXT PRIMARY KEY,
  version TEXT,
  screen_count INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);`);

const app = express();
app.use('/api', require('../routes/telemetry-collector')(db));
const server = app.listen(0);
let base;

test.before(async () => {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const uuid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(0, 36).padEnd(36, '0');
const report = (body) => fetch(`${base}/api/telemetry/report`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('a well-formed report is accepted and stored', async () => {
  const res = await report({ instance_id: uuid(1), version: '1.9.34', screen_count: 12 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const row = db.prepare('SELECT * FROM telemetry_reports WHERE instance_id = ?').get(uuid(1));
  assert.equal(row.screen_count, 12);
  assert.equal(row.version, '1.9.34');
});

test('reporting again updates the row rather than adding one', async () => {
  // An install reports daily. If this ever inserted instead of updating, one install would
  // occupy 365 rows a year and the public figure would count it 365 times.
  await report({ instance_id: uuid(1), version: '1.9.35', screen_count: 20 });
  const n = db.prepare('SELECT COUNT(*) AS c FROM telemetry_reports WHERE instance_id = ?').get(uuid(1)).c;
  assert.equal(n, 1, 'still a single row for this install');
  const row = db.prepare('SELECT * FROM telemetry_reports WHERE instance_id = ?').get(uuid(1));
  assert.equal(row.screen_count, 20, 'count is the latest reported');
  assert.equal(row.version, '1.9.35');
});

test('hostile or malformed bodies are refused, not stored', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM telemetry_reports').get().c;
  const bad = [
    { instance_id: 'not-a-uuid', screen_count: 1 },
    { instance_id: uuid(2) },                                    // no count
    { instance_id: uuid(2), screen_count: -1 },
    { instance_id: uuid(2), screen_count: 1e9 },                 // absurd, would skew the total
    { instance_id: uuid(2), screen_count: 1.5 },                 // not an integer
    { instance_id: uuid(2), screen_count: 1, version: 'v'.repeat(41) },
    {},
  ];
  for (const body of bad) {
    const res = await report(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telemetry_reports').get().c, before,
    'nothing rejected reached the table');
});

test('the public aggregate sums screens across installs and names no one', async () => {
  db.prepare(`INSERT INTO telemetry_reports (instance_id, version, screen_count, first_seen, last_seen)
              VALUES (?,?,?,?,?)`).run(uuid(3), '1.9.34', 480, 1, 1);
  const res = await fetch(`${base}/api/public/stats`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.screens, 500, '20 + 480');
  assert.equal(body.installs, 2);
  // The whole payload — no instance ids, no versions, nothing per-install.
  assert.deepEqual(Object.keys(body).sort(), ['installs', 'screens']);
  assert.match(res.headers.get('cache-control') || '', /max-age=300/);
});

test('the aggregate is cached, so a scraper cannot turn page views into queries', async () => {
  db.prepare(`INSERT INTO telemetry_reports (instance_id, version, screen_count, first_seen, last_seen)
              VALUES (?,?,?,?,?)`).run(uuid(4), '1.9.34', 999, 1, 1);
  const body = await (await fetch(`${base}/api/public/stats`)).json();
  assert.equal(body.screens, 500, 'still the cached figure, not 1499');
});
