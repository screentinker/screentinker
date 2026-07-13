'use strict';

// #142 step 2 — integration: the lag monitor samples, persists to a BOUNDED table,
// and surfaces current lag on /api/status. Boots the real server with fast sampling
// and a tiny (fractional-day) retention so the prune is observable within the test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-lag-int-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-lag-int-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      LAG_SAMPLE_INTERVAL_MS: '200',          // sample fast
      LAG_FLUSH_MS: '200',                    // #146 Item E: batch-insert fast so persistence is observable in-test
      LAG_TELEMETRY_RETENTION_DAYS: '0.00001', // ~0.86s retention
      LAG_PRUNE_INTERVAL_MS: '400',           // prune often
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('/api/status exposes a current loop_lag snapshot', async () => {
  const r = await fetch(BASE + '/api/status');
  const body = await r.json();
  assert.ok(body.loop_lag, 'loop_lag present on /api/status');
  assert.equal(typeof body.devices_connected, 'number', 'devices_connected always-on live-fleet gauge');
  assert.ok(['normal', 'elevated', 'critical'].includes(body.loop_lag.band), 'band is a valid level');
  assert.equal(typeof body.loop_lag.p99_ms, 'number', 'p99_ms is numeric');
  assert.equal(typeof body.loop_lag.mean_ms, 'number', 'mean_ms is numeric');
  // #146 P3.8: soak observability block — gauges + throughput
  assert.ok(body.debug, 'debug block present');
  assert.equal(typeof body.debug.flap.buckets, 'number', 'flap bucket count exposed');
  assert.equal(typeof body.debug.flap.quarantined, 'number', 'flap quarantine count exposed');
  assert.equal(typeof body.debug.flap.refusedTotal, 'number', 'flap refusedTotal exposed');
  assert.equal(typeof body.debug.flap.refusedLastWindow, 'number', 'flap refusedLastWindow exposed');
  assert.equal(typeof body.debug.flap.quarantineStartsTotal, 'number', 'flap quarantineStartsTotal exposed');
  assert.equal(typeof body.debug.flap.quarantineStartsLastWindow, 'number', 'flap quarantineStartsLastWindow exposed');
  assert.equal(typeof body.debug.ota_breaker.rateBackoffTotal, 'number', 'ota breaker rateBackoffTotal exposed');
  assert.equal(typeof body.debug.ota_breaker.rateBackoffLastWindow, 'number', 'ota breaker rateBackoffLastWindow exposed');
  assert.equal(typeof body.debug.ota_download.inFlight, 'number', 'download in-flight exposed');
  assert.equal(typeof body.debug.ota_download.servedTotal, 'number', 'download servedTotal exposed');
  assert.equal(typeof body.debug.ota_download.shedTotal, 'number', 'download shedTotal exposed');
  assert.ok('maintenance' in body.debug && typeof body.debug.maintenance.ms === 'number', 'last-prune stats exposed');
  assert.equal(typeof body.debug.maintenance.sweepsTotal, 'number', 'maintenance sweepsTotal exposed');
  assert.equal(typeof body.debug.log_coalescer_buffer, 'number', 'coalescer buffer size exposed');
});

test('lag samples are persisted AND bounded by retention prune (not unbounded)', async () => {
  // Let it sample for ~3s. At 200ms/sample that is ~15 inserts, but with ~0.86s
  // retention pruned every 400ms the table must stay small — proving the table
  // can never become a second unbounded-growth table.
  await new Promise(r => setTimeout(r, 1800));
  const dbPath = path.join(DATA_DIR, 'db', 'remote_display.db');
  const db = new Database(dbPath, { readonly: true });
  const count = db.prepare('SELECT COUNT(*) c FROM event_loop_lag').get().c;
  db.close();
  assert.ok(count >= 1, 'lag samples are being persisted');
  assert.ok(count < 15, `table is bounded by the prune (held ${count} rows over ~3s of 200ms sampling)`);
});
