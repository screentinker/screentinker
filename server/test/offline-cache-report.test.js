'use strict';

/*
 * The web player's offline-cache report (player index.html reportOfflineCache → device:cache-status
 * → ws/deviceSocket.js 'cache-status' → devices.offline_cache → device page "Offline cache").
 * Pinned: only bounded numbers, a boolean and one short error name are stored; a report for another
 * screen is ignored; edges relay it last-wins; the page asks the worker and sends it.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-offline-cache-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const deviceSocket = require('../ws/deviceSocket');
const { Server } = require('socket.io');
const ioServer = http.createServer();
const io = new Server(ioServer);
deviceSocket(io);

after(() => { try { io.close(); } catch { /* */ } try { db.close(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });

db.prepare("INSERT INTO devices (id, name, status) VALUES ('d-1', 'Lobby', 'online'), ('d-2', 'Other', 'online')").run();
const row = (id) => db.prepare('SELECT offline_cache, offline_cache_at FROM devices WHERE id = ?').get(id);

test('a report is stored as bounded numbers, a boolean and one error name', () => {
  const r = deviceSocket.applyPlayerEvent('cache-status', 'd-1', {
    device_id: 'd-1', wanted: 3, ready: 2, ready_bytes: 44670976.7, partial: 1, partial_bytes: 1048576,
    usage: 50000000, quota: 62914560, persisted: false, error: 'QuotaExceededError',
  }, {});
  assert.equal(r.ok, true);
  const got = row('d-1');
  assert.ok(got.offline_cache_at > 0);
  assert.deepEqual(JSON.parse(got.offline_cache), {
    wanted: 3, ready: 2, ready_bytes: 44670976, partial: 1, partial_bytes: 1048576,
    usage: 50000000, quota: 62914560, persisted: false, error: 'QuotaExceededError',
  });
});

test('anything else is dropped: free text, negative or non-numeric values, extra fields', () => {
  deviceSocket.applyPlayerEvent('cache-status', 'd-1', {
    wanted: -1, ready: 'lots', ready_bytes: null, quota: '', persisted: 'yes',
    error: '<img src=x onerror=alert(1)>', note: 'hello', partial: 2,
  }, {});
  const s = JSON.parse(row('d-1').offline_cache);
  assert.deepEqual(s, { wanted: null, ready: null, ready_bytes: null, partial: 2, partial_bytes: null, usage: null, quota: null, persisted: null, error: null });
});

test('a report claiming another screen is ignored', () => {
  deviceSocket.applyPlayerEvent('cache-status', 'd-2', { device_id: 'd-1', wanted: 9, ready: 9 }, {});
  assert.equal(row('d-2').offline_cache, null);
});

test('an edge relays it last-wins, not as an ordered backlog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'player-termination.js'), 'utf8');
  assert.match(src, /COALESCE_KINDS = new Set\([^)]*'cache-status'/);
  assert.ok(deviceSocket.PLAYER_EVENT_KINDS.includes('cache-status'), 'a replica may relay it');
});

test('the page asks its worker and reports, after each pin and on a timer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(html, /socket\.emit\('device:cache-status'/);
  assert.match(html, /type: 'st-cache-status', urls: offlineCacheUrls/);
  assert.match(html, /scheduleOfflineCacheReport\(OFFLINE_REPORT_AFTER_PIN_MS\)/);
  assert.match(html, /navigator\.storage\.persist\(\)/);
  // var on purpose: requestOfflineCache can run before these lines (the 1.9.32 boot TDZ brick).
  assert.match(html, /var offlineCacheUrls = null;/);
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');
  assert.match(legacy, /device:cache-status/, 'the legacy (old webOS / Tizen) build carries it too');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'player', 'sw-legacy.js'), 'utf8'), /st-cache-status/);
});

test('the device page shows it, escaped', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(view, /\$\{offlineCacheCard\(device\)\}/);
  const fn = view.slice(view.indexOf('function offlineCacheCard'), view.indexOf('function formatUptime'));
  assert.match(fn, /esc\(t\('device\.info\.offline_cache_ready'/);
  assert.match(fn, /esc\(l\)/);
});
