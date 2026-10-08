'use strict';

/*
 * Weather and area conditions (lib/local-conditions.js), decided per screen on the server.
 *
 *   - a condition is validated (six weather groups, temperature ops, a real point and radius)
 *   - weather fails OPEN (no location / no reading -> plays); geo fails CLOSED (unplaced -> skipped)
 *   - the screen's payload leaves out failing items and never carries these types to a player
 *   - the sweep refreshes each ~11 km cell once and pushes only when a condition could see a change
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-localcond-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const L = require('../lib/local-conditions');

const CHICAGO = { latitude: 41.88, longitude: -87.63 };
const MILWAUKEE = { latitude: 43.04, longitude: -87.91 };

test('validation: weather groups and temperature ops, a real point and radius', () => {
  assert.deepEqual(L.normalise({ type: 'weather', field: 'condition', value: 'Rain' }), { type: 'weather', field: 'condition', op: 'eq', value: 'rain' });
  assert.equal(L.normalise({ type: 'weather', field: 'condition', value: 'meatballs' }), false);
  assert.deepEqual(L.normalise({ type: 'weather', field: 'temperature', op: 'lt', value: '5', units: 'f' }), { type: 'weather', field: 'temperature', op: 'lt', value: 5, units: 'f' });
  assert.equal(L.normalise({ type: 'weather', field: 'temperature', op: 'eq', value: 5 }), false);
  assert.equal(L.normalise({ type: 'geo', lat: 95, lon: 0, radius_km: 5 }), false);
  assert.equal(L.normalise({ type: 'geo', lat: 41.9, lon: -87.6, radius_km: 0 }), false);
  assert.equal(L.normalise({ type: 'geo', lat: 41.9, lon: -87.6, radius_km: 25, op: 'outside' }).op, 'outside');
});

test('WMO codes map to the six groups', () => {
  assert.deepEqual([0, 2, 45, 61, 81, 73, 95, 999].map(L.groupOf), ['clear', 'cloudy', 'fog', 'rain', 'rain', 'snow', 'storm', null]);
});

test('geo: within/outside by great-circle distance; an unplaced screen fails CLOSED', () => {
  const near = L.normalise({ type: 'geo', lat: 41.88, lon: -87.63, radius_km: 50 });
  assert.ok(L.passes(near, CHICAGO));
  assert.ok(!L.passes(near, MILWAUKEE), 'Milwaukee is ~130 km from Chicago');
  assert.ok(L.passes({ ...near, op: 'outside' }, MILWAUKEE));
  assert.ok(!L.passes(near, {}), 'no location: a regional item does not play');
  assert.ok(!L.passes(near, { latitude: null, longitude: null }));
  assert.ok(Math.abs(L.haversineKm(41.88, -87.63, 43.04, -87.91) - 130) < 5);
});

test('weather: reads the cached cell; no location or no reading fails OPEN', async () => {
  L._reset();
  const rain = L.normalise({ type: 'weather', field: 'condition', value: 'rain' });
  const cold = L.normalise({ type: 'weather', field: 'temperature', op: 'lt', value: 40, units: 'f' });
  assert.ok(L.passes(rain, CHICAGO), 'no reading yet: plays');
  assert.ok(L.passes(rain, {}), 'no location: plays');
  L._setFetch(async () => ({ group: 'clear', temperature_c: 2, code: 0, is_day: true }));
  db.prepare("INSERT INTO users (id, email, role) VALUES ('u-lc', 'lc@t.local', 'user')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('o-lc', 'O', 'u-lc')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-lc', 'o-lc', 'W')").run();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('pl-lc-w', 'u-lc', 'ws-lc', 'w')").run();
  db.prepare(`INSERT INTO playlist_items (playlist_id, sort_order, play_when) VALUES ('pl-lc-w', 0, ?)`).run(JSON.stringify(rain));
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, latitude, longitude) VALUES ('d-lc-chi', 'u-lc', 'ws-lc', 'chi', 'p1', ?, ?)").run(CHICAGO.latitude, CHICAGO.longitude);
  const r = await L.sweep(db, null, 1_000_000);
  assert.equal(r.refreshed, 1);
  assert.ok(!L.passes(rain, CHICAGO), 'clear in Chicago: the rain item is skipped');
  assert.ok(L.passes({ ...rain, op: 'neq' }, CHICAGO));
  assert.ok(L.passes(cold, CHICAGO), '2 °C is 35.6 °F, under 40 °F');
  assert.equal(L.readingFor(CHICAGO).group, 'clear');
});

test('the sweep refreshes a cell once per 15 minutes and pushes only on a visible change', async () => {
  let calls = 0;
  let reading = { group: 'clear', temperature_c: 2.2, code: 0, is_day: true };
  L._setFetch(async () => { calls++; return reading; });
  let r = await L.sweep(db, null, 1_000_000 + 5 * 60 * 1000);
  assert.equal(r.refreshed, 0, 'still fresh');
  assert.equal(calls, 0);
  reading = { ...reading, temperature_c: 2.4 };
  r = await L.sweep(db, null, 1_000_000 + 16 * 60 * 1000);
  assert.equal(r.refreshed, 1);
  assert.equal(r.pushed, 0, '2.2 -> 2.4 °C is the same whole degree: nothing to push');
  reading = { ...reading, group: 'rain' };
  r = await L.sweep(db, null, 1_000_000 + 32 * 60 * 1000);
  assert.equal(r.pushed, 1, 'clear -> rain: the screen gets a fresh payload');
  reading = { group: 'rain', temperature_c: 3.6 };
  L._setFetch(async () => { throw new Error('offline'); });
  r = await L.sweep(db, null, 1_000_000 + 48 * 60 * 1000);
  assert.equal(L.readingFor(CHICAGO).group, 'rain', 'a failed refresh keeps the last reading');

  // A restart: the cache is rebuilt from the database, so nothing looks like a change.
  L._reset();
  assert.equal(L.readingFor(CHICAGO), null);
  L._load(db, 1_000_000 + 48 * 60 * 1000);
  assert.equal(L.readingFor(CHICAGO).group, 'rain', 'readings survive a restart');
});

test('the payload: failing items are left out, and these condition types never reach a player', () => {
  setupDeviceSocket(new Server(http.createServer()));
  const build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  const items = [
    { filename: 'always.png', mime_type: 'image/png', filepath: 'a.png', duration_sec: 10, sort_order: 0 },
    { filename: 'rain.png', mime_type: 'image/png', filepath: 'r.png', duration_sec: 10, sort_order: 1, play_when: { type: 'weather', field: 'condition', op: 'eq', value: 'rain' } },
    { filename: 'sun.png', mime_type: 'image/png', filepath: 's.png', duration_sec: 10, sort_order: 2, play_when: { type: 'weather', field: 'condition', op: 'eq', value: 'clear' } },
    { filename: 'chicago.png', mime_type: 'image/png', filepath: 'c.png', duration_sec: 10, sort_order: 3, play_when: { type: 'geo', op: 'within', lat: 41.88, lon: -87.63, radius_km: 50 } },
  ];
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES ('pl-lc', 'u-lc', 'ws-lc', 'p', 'published', ?)").run(JSON.stringify(items));
  db.prepare("UPDATE devices SET playlist_id = 'pl-lc', playlist_source = 'device' WHERE id = 'd-lc-chi'").run();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, latitude, longitude) VALUES ('d-lc-mke', 'u-lc', 'ws-lc', 'mke', 'p2', 'pl-lc', 'device', ?, ?)").run(MILWAUKEE.latitude, MILWAUKEE.longitude);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES ('d-lc-none', 'u-lc', 'ws-lc', 'none', 'p3', 'pl-lc', 'device')").run();

  const names = (id) => build(id).assignments.map((a) => a.filename);
  assert.deepEqual(names('d-lc-chi'), ['always.png', 'rain.png', 'chicago.png'], 'raining in Chicago (last reading), inside the area');
  assert.deepEqual(names('d-lc-mke'), ['always.png', 'rain.png', 'sun.png'], 'Milwaukee: no reading yet (weather plays), outside the area');
  assert.deepEqual(names('d-lc-none'), ['always.png', 'rain.png', 'sun.png'], 'unplaced: weather plays, geo does not');
  for (const a of build('d-lc-chi').assignments) assert.ok(!a.play_when || !['weather', 'geo'].includes(a.play_when.type), 'stripped before sending');
});
