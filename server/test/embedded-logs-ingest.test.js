'use strict';

/*
 * POST /api/embedded/logs (#638 review): only the panel itself writes its diagnostic logs, and the
 * documented text/plain upload actually works. Real schema (db/database.js).
 *
 * Before: resolveAuth also accepted read/write/full API tokens, so any reader of a workspace could
 * plant "device" logs; and server.js skips its global body parser for this path while the route
 * mounted only a JSON one, so a text/plain body arrived as {} and was stored as zero entries.
 * (That a read token cannot change the stored orientation is in embedded-orientation-compat.test.js.)
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/embedded-real-db').boot({});
after(() => h.close());

const rows = (id) => h.db.prepare('SELECT log_json, log_count FROM device_diagnostic_logs WHERE device_id = ? ORDER BY id').all(id);

test('an API token cannot upload "device" logs, whatever its scope', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  for (const scope of ['read', 'full']) {
    const tok = h.mkToken(scope);
    const res = await fetch(`${base}/logs?device_id=${p.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: [{ level: 'ERROR', msg: 'planted' }] }),
    });
    assert.equal(res.status, 403, `${scope} token`);
  }
  assert.deepEqual(rows(p.id), [], 'nothing stored');
});

test('the device uploads JSON logs', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  const res = await fetch(`${base}/logs?device_id=${p.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: [{ level: 'INFO', tag: 'Boot', msg: 'hello' }, { level: 'WARN', msg: 'low rssi' }], version: '1.3.0' }),
  });
  assert.equal(res.status, 200);
  const [r] = rows(p.id);
  assert.equal(r.log_count, 2);
  assert.deepEqual(JSON.parse(r.log_json).logs.map((l) => l.msg), ['hello', 'low rssi']);
});

test('the device uploads text/plain logs, one entry per line', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  const res = await fetch(`${base}/logs?device_id=${p.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'text/plain' },
    body: '[Boot] ScreenTinker MCU v1.3.0 booting\n[Sync] HTTP 200\n',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 2);
  const [r] = rows(p.id);
  assert.equal(r.log_count, 2);
  assert.deepEqual(JSON.parse(r.log_json).logs, [
    { msg: '[Boot] ScreenTinker MCU v1.3.0 booting', level: 'INFO' },
    { msg: '[Sync] HTTP 200', level: 'INFO' },
  ]);
});

test('an oversized text/plain upload is refused with 413', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  const res = await fetch(`${base}/logs?device_id=${p.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'text/plain' },
    body: 'x'.repeat(300 * 1024),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(rows(p.id), []);
});
