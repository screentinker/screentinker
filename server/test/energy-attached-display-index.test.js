'use strict';

/*
 * The energy sampler's "which panel is attached" lookup must ride the partial index. Without it,
 * every screen that never reported a panel walked all of its telemetry rows, for every screen at
 * once every ten minutes: production froze 1.3-5 s on that rhythm (2026-11-27).
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-energy-idx-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');

// The exact statement lib/energy/index.js latestAttachedDisplay() runs.
const LOOKUP = 'SELECT attached_display FROM device_telemetry WHERE device_id = ? AND attached_display IS NOT NULL ORDER BY reported_at DESC LIMIT 1';

test('a migrated database has the partial index', () => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_telemetry_attached_display'").get();
  assert.ok(row, 'index exists');
  assert.match(row.sql, /WHERE attached_display IS NOT NULL/i);
});

test('the energy lookup uses it, not a walk of the screen\'s telemetry', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + LOOKUP).all('x').map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_telemetry_attached_display/, plan);
});

test('the answer is unchanged: newest attached panel, or none', () => {
  const ins = db.prepare('INSERT INTO device_telemetry (device_id, reported_at, attached_display) VALUES (?,?,?)');
  const withPanel = 'd-' + crypto.randomBytes(4).toString('hex');
  const without = 'd-' + crypto.randomBytes(4).toString('hex');
  for (const id of [withPanel, without]) db.prepare("INSERT INTO devices (id, name, status) VALUES (?, ?, 'online')").run(id, id);
  ins.run(withPanel, 100, 'OLD-PANEL');
  ins.run(withPanel, 200, 'NEW-PANEL');
  ins.run(withPanel, 300, null);            // a later row without a panel does not hide the panel
  for (let t = 1; t <= 50; t++) ins.run(without, t, null);
  assert.equal(db.prepare(LOOKUP).get(withPanel).attached_display, 'NEW-PANEL');
  assert.equal(db.prepare(LOOKUP).get(without), undefined);
});
