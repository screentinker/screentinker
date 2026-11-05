'use strict';

/*
 * Platform Traffic (lib/traffic-ledger.js): what a request counts as, that a response's bytes are
 * counted from the socket (files and headers included), that the NIC sampler copes with resets, and
 * that flush + report agree. Real schema (db/database.js), in a temp DATA_DIR.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-traffic-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const { db } = require('../db/database');
const traffic = require('../lib/traffic-ledger');
traffic._setDb(db);

after(() => { try { db.close(); } catch (_) {} fs.rmSync(dataDir, { recursive: true, force: true }); });

test('requests are sorted into kinds, the specific /api routes before the generic one', () => {
  const c = traffic.categorize;
  assert.equal(c('/uploads/content/abc.mp4'), 'content');
  assert.equal(c('/api/content/123/file?rev=2'), 'content');
  assert.equal(c('/api/content/123/variant/tizen'), 'content');
  assert.equal(c('/api/content/123'), 'api', 'metadata, not the file');
  assert.equal(c('/api/embedded/render?device_id=x'), 'embedded');
  assert.equal(c('/api/embedded/firmware/xiao.bin'), 'ota');
  assert.equal(c('/download/apk'), 'ota');
  assert.equal(c('/api/player/raster'), 'raster');
  assert.equal(c('/player/index.html'), 'player');
  assert.equal(c('/api/devices'), 'api');
  assert.equal(c('/'), 'web');
  for (const k of [c('/x'), c('/api/x')]) assert.ok(traffic.CATEGORIES.includes(k));
});

test('a response is counted from the socket: a streamed file and its headers, attributed', async () => {
  traffic._reset();
  const express = require('express');
  const app = express();
  app.use(traffic.middleware());
  const body = Buffer.alloc(200000, 7);
  app.get('/api/content/c1/file', (req, res) => { res.locals.trafficWorkspaceId = 'ws-1'; res.locals.trafficDeviceId = 'dev-1'; res.end(body); });
  app.get('/api/devices', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const a = await fetch(`${base}/api/content/c1/file`); await a.arrayBuffer();
    const b = await fetch(`${base}/api/devices`); await b.arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));
    traffic.flush();
    const rows = db.prepare('SELECT category, workspace_id, requests, bytes_out, bytes_in FROM traffic_hourly ORDER BY category').all();
    const content = rows.find((r) => r.category === 'content');
    assert.ok(content, JSON.stringify(rows));
    assert.equal(content.workspace_id, 'ws-1');
    assert.equal(content.requests, 1);
    assert.ok(content.bytes_out >= body.length && content.bytes_out < body.length + 2000, `body + headers: ${content.bytes_out}`);
    assert.ok(content.bytes_in > 0, 'the request line and headers came in');
    const api = rows.find((r) => r.category === 'api');
    assert.ok(api && api.bytes_out > 0 && api.bytes_out < 2000);
    const dev = db.prepare('SELECT device_id, bytes_out FROM traffic_device_daily').all();
    assert.equal(dev.length, 1);
    assert.equal(dev[0].device_id, 'dev-1');
  } finally {
    server.close();
  }
});

test('the host sampler reads the uplink from /proc, counts deltas, and survives a counter reset', () => {
  traffic._reset();
  db.prepare('DELETE FROM host_traffic_hourly').run();
  const route = 'Iface\tDestination\tGateway\tFlags\nenp1s0\t00000000\t0101A8C0\t0003\ndocker0\t000011AC\t00000000\t0001\n';
  const dev = (rx, tx) => `Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n`
    + `    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n`
    + `enp1s0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0\n`
    + `docker0: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0\n`;
  const t0 = 1_800_000_000;
  let cur = dev(1000, 2000);
  const read = (p) => (p.endsWith('route') ? route : cur);
  traffic.sampleHost(t0, read);                       // baseline
  cur = dev(1500, 9000); traffic.sampleHost(t0 + 60, read);
  cur = dev(100, 300);   traffic.sampleHost(t0 + 120, read);   // reboot: counters went backwards
  traffic.flush();
  const rows = db.prepare('SELECT iface, rx_bytes, tx_bytes FROM host_traffic_hourly').all();
  assert.deepEqual(rows.map((r) => r.iface), ['enp1s0'], 'only the default-route interface, not lo or docker0');
  assert.equal(rows[0].rx_bytes, 500 + 100);
  assert.equal(rows[0].tx_bytes, 7000 + 300);
});

test('without a default route, every non-virtual interface counts', () => {
  const parsed = traffic.parseNetDev(
    'h1\nh2\n    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n  eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\nveth12: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n',
    traffic.uplinkInterfaces(''));
  assert.deepEqual(Object.keys(parsed), ['eth0']);
  assert.deepEqual(parsed.eth0, { rx: 10, tx: 20 });
});

test('report: totals, kinds, top workspaces and screens, month against the quota', () => {
  traffic._reset();
  for (const t of ['traffic_hourly', 'traffic_daily', 'traffic_device_daily', 'host_traffic_hourly']) db.prepare(`DELETE FROM ${t}`).run();
  const now = Math.floor(Date.now() / 1000);
  traffic.add('content', 'ws-a', 'dev-a', 100, 5_000_000, 3, now);
  traffic.add('embedded', 'ws-b', 'dev-b', 50, 1_000_000, 10, now);
  traffic.add('web', null, null, 10, 20_000, 1, now);
  traffic.flush();
  db.prepare('INSERT INTO host_traffic_hourly (hour, node, iface, rx_bytes, tx_bytes) VALUES (?,?,?,?,?)')
    .run(Math.floor(now / 3600) * 3600, traffic.NODE, 'eth0', 2_000_000, 9_000_000);
  const r = traffic.report(db, { days: 7, now, quotaBytes: 90_000_000 });
  assert.equal(r.granularity, 'hour');
  assert.equal(r.totals.attributed_out, 6_020_000);
  assert.equal(r.totals.host_tx, 9_000_000);
  assert.equal(r.totals.requests, 14);
  assert.equal(r.by_category[0].category, 'content', 'largest first');
  assert.deepEqual(r.top_workspaces.map((w) => w.id), ['ws-a', 'ws-b'], 'no empty workspace in the list');
  assert.deepEqual(r.top_devices.map((d) => d.id), ['dev-a', 'dev-b']);
  assert.equal(r.month.quota_pct, 10);
  assert.equal(traffic.report(db, { days: 30, now }).granularity, 'day');
  assert.equal(traffic.report(db, { days: 30, now }).month.quota_pct, null, 'no quota set');
});

test('prune drops rows past each table\'s retention and keeps the rest', () => {
  for (const t of ['traffic_hourly', 'traffic_daily', 'traffic_device_daily', 'host_traffic_hourly']) db.prepare(`DELETE FROM ${t}`).run();
  const now = 1_900_000_000;
  const day = (d) => new Date((now - d * 86400) * 1000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO traffic_hourly (hour, node, category, workspace_id) VALUES (?, 'n', 'api', '')").run(now - 40 * 86400);
  db.prepare("INSERT INTO traffic_hourly (hour, node, category, workspace_id) VALUES (?, 'n', 'web', '')").run(now - 1 * 86400);
  db.prepare("INSERT INTO traffic_device_daily (day, node, device_id) VALUES (?, 'n', 'old')").run(day(100));
  db.prepare("INSERT INTO traffic_daily (day, node, category, workspace_id) VALUES (?, 'n', 'api', '')").run(day(100));
  traffic._setDb(db);
  assert.equal(traffic.prune(now), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM traffic_hourly').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM traffic_daily').get().n, 1, 'daily keeps 400 days');
});

test('the admin route is platform-admin only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.match(src, /router\.get\('\/traffic', requirePlatformAdmin,/);
});
