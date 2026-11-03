'use strict';

/*
 * #788: GET /devices listed a screen once per telemetry row tied on its latest reported_at.
 *
 * reported_at is whole seconds, so two heartbeats in one second (a reconnect right after a beat, the
 * embedded writer, a replica, HEARTBEAT_MIN_INTERVAL_MS=0) both matched MAX(reported_at). The list
 * is LIMIT 100, so the duplicates pushed real screens off the Displays page: a reporter's workspace
 * lost 3 screens to one device with 110 tied rows, and prod had 5 tied devices on 2026-11-03.
 *
 * These run the REAL route (router mounted on a bare app with the tenancy the middleware would
 * set), the real threshold sweep and the real mesh projection, against tied rows.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-788-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { latestTelemetryIdSql, latestScreenshotIdSql } = require('../lib/latest-row');

const id = () => crypto.randomUUID();
const NOW = Math.floor(Date.now() / 1000);
let userId, wsId, server, base;

function mkWorkspace() {
  const orgId = id(); const ws = id();
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(orgId, 'org-' + orgId.slice(0, 4), userId, NOW, NOW);
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(ws, orgId, 'ws-' + ws.slice(0, 4), NOW, NOW);
  return ws;
}
function mkDevice(ws, name, sort) {
  const d = id();
  db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, sort_order) VALUES (?,?,?,?,?,?)')
    .run(d, userId, ws, name, id().slice(0, 6), sort);
  return d;
}
const telemetry = (d, at, cpu) => db.prepare(
  'INSERT INTO device_telemetry (device_id, cpu_usage, reported_at) VALUES (?,?,?)').run(d, cpu, at);

before(async () => {
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)')
    .run(userId, `t788-${userId}@example.com`, 'T788', 'x');
  wsId = mkWorkspace();
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user' }; req.workspaceId = req.get('x-ws'); next(); });
  app.use('/api/devices', require('../routes/devices'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server && server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

const list = async (ws, qs = '') => {
  const r = await fetch(`${base}/api/devices${qs}`, { headers: { 'x-ws': ws } });
  assert.equal(r.status, 200);
  return r.json();
};

test('⚠️ a screen with tied latest telemetry is listed ONCE, with the newest row (highest id)', async () => {
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'tied', 0);
  telemetry(d, NOW - 60, 10);
  telemetry(d, NOW, 20);
  telemetry(d, NOW, 30);
  telemetry(d, NOW, 40);   // same second, written last
  const rows = await list(ws);
  assert.equal(rows.length, 1, 'one card per screen, not one per tied row');
  assert.equal(rows[0].id, d);
  assert.equal(rows[0].cpu_usage, 40, 'the tie goes to the row written last');
});

test('⚠️ ties no longer push real screens off a full page (the Displays-page symptom)', async () => {
  const ws = mkWorkspace();
  const flooder = mkDevice(ws, 'flooder', 0);
  for (let i = 0; i < 110; i++) telemetry(flooder, NOW, i);   // the reporter's 110 tied rows
  const others = [];
  for (let i = 1; i <= 99; i++) others.push(mkDevice(ws, 'screen-' + i, i));
  const rows = await list(ws);
  assert.equal(rows.length, 100);
  assert.equal(new Set(rows.map((r) => r.id)).size, 100, 'no duplicates');
  for (const o of others) assert.ok(rows.some((r) => r.id === o), 'every real screen is on the page');
});

test('a screen with no telemetry still lists, with blank readings', async () => {
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'fresh', 0);
  const rows = await list(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, d);
  assert.equal(rows[0].cpu_usage, null);
});

test('tied screenshot rows list the screen once, with the newest file', async () => {
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'shots', 0);
  const shot = db.prepare('INSERT INTO screenshots (device_id, filepath, captured_at) VALUES (?,?,?)');
  shot.run(d, 'old.jpg', NOW - 5); shot.run(d, 'a.jpg', NOW); shot.run(d, 'b.jpg', NOW);
  const rows = await list(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].screenshot_path, 'b.jpg');
  assert.equal(rows[0].screenshot_at, NOW);
});

test('the latest row is still the NEWEST timestamp, not just the highest id', async () => {
  // A backfilled / clock-skewed row with a higher id but an older reported_at must not win.
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'skew', 0);
  telemetry(d, NOW, 77);
  telemetry(d, NOW - 3600, 11);   // inserted later, reported earlier
  assert.equal((await list(ws))[0].cpu_usage, 77);
});

test('the threshold sweep evaluates a tied screen once', () => {
  const svc = require('../services/threshold-alerts');
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'alerting', 0);
  db.prepare("UPDATE devices SET status = 'online', last_heartbeat = ? WHERE id = ?").run(NOW, d);
  telemetry(d, NOW, 95); telemetry(d, NOW, 95); telemetry(d, NOW, 95);
  const ruleId = 'r788-' + id().slice(0, 8);
  db.prepare(`INSERT INTO alert_rules (id, workspace_id, name, metric, threshold, sustain_seconds, severity, enabled, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(ruleId, ws, 'CPU', 'cpu_usage', 80, 0, 'warn', 1, NOW);
  const s = svc.sweep(db, { now: NOW });
  // One evaluation per (rule, device). With the old join the tied screen was evaluated once per
  // tied row, so `evaluated` ran ahead of rules x devices.
  const devices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE blocked IS NULL OR blocked = 0').get().n;
  assert.equal(s.errors, 0);
  assert.equal(s.evaluated, s.rules * devices, 'each device evaluated once per rule, ties included');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE rule_id = ? AND device_id = ?').get(ruleId, d).n, 1,
    'one alert for the tied screen');
});

test('the mesh projection carries a tied screen once', () => {
  const { deviceProjections } = require('../lib/mesh/node-data');
  const ws = mkWorkspace();
  const d = mkDevice(ws, 'meshy', 0);
  telemetry(d, NOW, 5); telemetry(d, NOW, 6);
  const out = deviceProjections(db, ['health', 'identity'], { shared_workspaces: JSON.stringify([ws]) })
    .filter((r) => r.id === d);
  assert.equal(out.length, 1, 'one projection per screen');
  assert.equal(out[0].cpu_usage, 6);
});

test('the lookup rides the (device_id, time DESC) index, not a scan', () => {
  for (const [sql, idx] of [
    [`SELECT d.id, t.cpu_usage FROM devices d LEFT JOIN device_telemetry t ON t.rowid = ${latestTelemetryIdSql('d.id')} WHERE d.workspace_id = ?`, 'idx_telemetry_device'],
    [`SELECT d.id, s.filepath FROM devices d LEFT JOIN screenshots s ON s.rowid = ${latestScreenshotIdSql('d.id')} WHERE d.workspace_id = ?`, 'idx_screenshots_device'],
  ]) {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(wsId).map((r) => r.detail).join(' | ');
    assert.match(plan, new RegExp(idx), plan);
    assert.doesNotMatch(plan, /SCAN (lt|ls)\b(?! USING)/, plan);
  }
});

test('the helper refuses anything that is not a column reference', () => {
  assert.throws(() => latestTelemetryIdSql('d.id; DROP TABLE devices'));
  assert.throws(() => latestScreenshotIdSql("d.id OR 1=1"));
  assert.doesNotThrow(() => latestTelemetryIdSql('devices.id'));
});

test('⚠️ guard: no hand-written MAX(reported_at)/MAX(captured_at) latest-row join comes back', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', 'data', 'uploads'].includes(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        if (/MAX\(\s*(reported_at|captured_at)\s*\)[^;]{0,200}GROUP BY\s+device_id/i.test(s)) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], 'use lib/latest-row.js: a MAX() join returns one row per TIED row (#788)');
});
