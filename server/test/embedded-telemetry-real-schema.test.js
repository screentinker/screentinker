'use strict';

/*
 * Embedded telemetry against the REAL schema. embedded-renderer.test.js builds its own tables, and
 * its device_telemetry once had a nullable battery_charging where schema.sql says NOT NULL DEFAULT 0.
 * So a test passed while every real embedded poll without X-ST-Charging lost its telemetry row
 * (2.6.0). This boots the real database in a child process and makes the same calls.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');

test('the documented telemetry headers alone write a row on the real schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-emb-tel-'));
  try {
    const r = spawnSync(process.execPath, ['-e', `
      const { db } = require('./db/database');
      db.pragma('foreign_keys = OFF');
      const req = db.prepare('PRAGMA table_info(devices)').all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
      const names = ['id', ...req.map((c) => c.name)];
      db.prepare('INSERT INTO devices (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')')
        .run('dev-1', ...req.map((c) => (/INT|REAL/i.test(c.type) ? 0 : 'x')));
      db.pragma('foreign_keys = ON');
      const { touchDeviceHeartbeat } = require('./routes/embedded');
      const warn = []; const ow = console.warn; console.warn = (...a) => { warn.push(a.join(' ')); };
      // Battery, RSSI and firmware, exactly as docs/embedded-renderer.md documents them; no X-ST-Charging.
      touchDeviceHeartbeat({ id: 'dev-1' }, { headers: { 'x-st-device-battery': '73', 'x-st-device-rssi': '-61', 'x-st-firmware-version': 'fw-1.2' }, socket: { remoteAddress: '10.0.0.9' } });
      touchDeviceHeartbeat({ id: 'dev-1' }, { headers: { 'x-st-device-battery': '72', 'x-st-charging': '1' }, socket: { remoteAddress: '10.0.0.9' } });
      console.warn = ow;
      const rows = db.prepare('SELECT battery_level, battery_charging, wifi_rssi FROM device_telemetry WHERE device_id = ? ORDER BY id').all('dev-1');
      const dev = db.prepare('SELECT status, app_version FROM devices WHERE id = ?').get('dev-1');
      console.log(JSON.stringify({ rows, dev, warn }));
    `], { cwd: SERVER, encoding: 'utf8', timeout: 120000, env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.rows, [
      { battery_level: 73, battery_charging: 0, wifi_rssi: -61 },
      { battery_level: 72, battery_charging: 1, wifi_rssi: null },
    ]);
    assert.equal(out.dev.status, 'online');
    assert.equal(out.dev.app_version, 'fw-1.2');
    assert.deepEqual(out.warn.filter((w) => /telemetry write failed/.test(w)), [], 'no write failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
