'use strict';

/*
 * Preview-at-time: the LIVE path is unchanged, and the forecast IS the live path.
 *
 * Making the resolution path accept an injected instant touched three live modules
 * (services/scheduler.js, ws/deviceSocket.js, lib/local-conditions.js). The promise was "no screen
 * plays anything different", and a promise like that is only worth the test that holds it:
 *
 *   1. OLD vs NEW. The three modules are loaded as they were at the commit before this feature
 *      (git show BASELINE:…) next to the current ones, both are driven at the same instants over
 *      the fixture fleet (test/helpers/simulate-fixture.js), and what the scheduler writes and what
 *      every screen is sent must be deep-equal. Skipped — loudly — when git or that commit is not
 *      available (a tarball install); 2 and 3 still run.
 *   2. MIRROR vs VIEW. lib/device-simulate.js resolveFromInputs restates the resolver view's CASE in
 *      JS; for every device and every combination of scheduled playlist/layout it must equal the
 *      view itself.
 *   3. FORECAST vs LIVE. At each instant, after the real scheduler tick, the simulator's resolution
 *      and its payload for that instant must equal the live view row and the live payload.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-simeq-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const fixture = require('../test/helpers/simulate-fixture');
const setupDeviceSocket = require('../ws/deviceSocket');
const scheduler = require('../services/scheduler');
const sim = require('../lib/device-simulate');

// The commit this feature was built on. Its scheduler / payload builder / local conditions are the
// "old" behaviour the refactor must reproduce exactly.
const BASELINE = '90b3ff4559d0b541d244fa5aebd2727277c6c64b';
const CHANGED = ['services/scheduler.js', 'ws/deviceSocket.js', 'lib/local-conditions.js'];
const SERVER = path.join(__dirname, '..');

const fakeIo = { of: () => ({ to: () => ({ emit() {} }), emit() {}, adapter: { rooms: new Map() } }) };
let f, io1, io2, httpA, httpB, baseline = null, baselineWhy = '';

/*
 * Materialise the baseline copies in a temp dir. Each relative require is pointed at the baseline
 * copy when it names one of the CHANGED files, else at the real module — so both versions share
 * one database connection and every unchanged dependency.
 */
function loadBaseline() {
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: SERVER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { baselineWhy = 'not a git checkout'; return null; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-simeq-base-'));
  for (const rel of CHANGED) {
    let src;
    try { src = execFileSync('git', ['show', `${BASELINE}:server/${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
    catch (_) { baselineWhy = `baseline commit ${BASELINE.slice(0, 8)} not in this repository`; return null; }
    const dir = path.dirname(path.join(SERVER, rel));
    src = src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
      if (!spec.startsWith('.')) {
        // A package: resolve it from where the real file lives (a builtin resolves to itself).
        return `require(${JSON.stringify(require.resolve(spec, { paths: [dir] }))})`;
      }
      const abs = require.resolve(path.resolve(dir, spec));
      const relTarget = path.relative(SERVER, abs).split(path.sep).join('/');
      const target = CHANGED.includes(relTarget) ? path.join(tmp, relTarget) : abs;
      return `require(${JSON.stringify(target)})`;
    });
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), src);
  }
  return {
    scheduler: require(path.join(tmp, 'services/scheduler.js')),
    deviceSocket: require(path.join(tmp, 'ws/deviceSocket.js')),
  };
}

before(() => {
  f = fixture.build(db);
  httpA = http.createServer(); io1 = new Server(httpA); setupDeviceSocket(io1);
  baseline = loadBaseline();
  if (baseline) { httpB = http.createServer(); io2 = new Server(httpB); baseline.deviceSocket(io2); }
});
after(() => { try { io1.close(); } catch { /* */ } try { io2 && io2.close(); } catch { /* */ } });

const deviceIds = () => Object.values(f.devices);
const clearScheduled = () => db.prepare('UPDATE devices SET scheduled_playlist_id = NULL, scheduled_layout_id = NULL').run();
const scheduledCols = () => Object.fromEntries(db.prepare('SELECT id, scheduled_playlist_id, scheduled_layout_id FROM devices ORDER BY id').all()
  .map((r) => [r.id, [r.scheduled_playlist_id, r.scheduled_layout_id]]));
const viewRow = (id) => {
  const r = db.prepare('SELECT playlist_id, source, layout_id FROM device_resolved_playlist WHERE device_id = ?').get(id);
  return { playlist_id: r.playlist_id ?? null, source: r.source ?? null, layout_id: r.layout_id ?? null };
};
const json = (x) => JSON.parse(JSON.stringify(x));
// ⚠️ Fields added to the payload ON PURPOSE since the baseline, removed from today's side before the
// byte comparison so everything else is still compared exactly. Each one names why it exists.
//   wall_config.leader_device_id — GHSA-rvxj 3.7: a wall follower ignores a sync not stamped by its leader.
const withoutAdditions = (p) => {
  if (p && p.wall_config && typeof p.wall_config === 'object') { const { leader_device_id, ...w } = p.wall_config; return { ...p, wall_config: w }; }
  return p;
};

/*
 * The instants: every schedule edge in the fixture on both sides of the US (Mar 8) and EU (Mar 29)
 * DST changes and the Sydney one (Apr 5), plus a 97-minute grid across a week — a stride that is
 * coprime with the hour, so it lands on every minute-of-hour pattern rather than the same few.
 */
function instants() {
  const out = new Set();
  const fixed = [
    '2026-03-06T11:59:00Z', '2026-03-06T12:00:00Z', '2026-03-06T15:30:00Z', '2026-03-06T15:31:00Z',
    '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', '2026-03-09T10:59:00Z', '2026-03-09T11:00:00Z',
    '2026-03-09T12:35:00Z', '2026-03-09T12:50:00Z', '2026-03-09T13:35:00Z', '2026-03-09T14:31:00Z',
    '2026-03-08T22:00:00Z', '2026-03-09T06:00:00Z', '2026-03-09T06:01:00Z', '2026-03-10T11:59:00Z',
    '2026-03-10T12:00:00Z', '2026-03-28T23:30:00Z', '2026-03-29T01:00:00Z', '2026-03-29T16:00:00Z',
    '2026-04-04T15:59:00Z', '2026-04-04T16:00:00Z', '2026-04-08T08:00:00Z', '2026-05-08T08:30:00Z',
  ];
  for (const s of fixed) out.add(Date.parse(s));
  for (let t = Date.parse('2026-03-05T00:00:00Z'); t < Date.parse('2026-03-12T00:00:00Z'); t += 97 * 60000) out.add(t);
  return [...out].sort((a, b) => a - b);
}

test('baseline modules are available (old-vs-new comparison runs)', (t) => {
  if (!baseline) t.skip(`old-vs-new skipped: ${baselineWhy}`);
  else assert.ok(baseline.deviceSocket.buildPlaylistPayloadUnchecked, 'baseline payload builder loaded');
});

test('OLD vs NEW: the scheduler writes, and every screen is sent, exactly what it was before', (t) => {
  if (!baseline) return t.skip(`old-vs-new skipped: ${baselineWhy}`);
  let compared = 0;
  for (const at of instants()) {
    clearScheduled();
    mock.timers.enable({ apis: ['Date'], now: at });
    let oldCols, oldPayloads;
    try {
      baseline.scheduler.evaluateSchedules(fakeIo);
      oldCols = scheduledCols();
      oldPayloads = Object.fromEntries(deviceIds().map((id) => [id, json(baseline.deviceSocket.buildPlaylistPayloadUnchecked(id))]));
    } finally { mock.timers.reset(); }

    clearScheduled();
    scheduler.evaluateSchedules(fakeIo, new Date(at));
    assert.deepEqual(scheduledCols(), oldCols, `scheduler columns differ at ${new Date(at).toISOString()}`);
    for (const id of deviceIds()) {
      assert.deepEqual(withoutAdditions(json(setupDeviceSocket.buildPlaylistPayloadUnchecked(id))), oldPayloads[id],
        `live payload of ${id} differs from the baseline at ${new Date(at).toISOString()}`);
      compared++;
    }
  }
  assert.ok(compared > 1000, `expected a real matrix, compared ${compared}`);
});

test('OLD vs NEW: isScheduleActiveNow is unchanged by the isScheduleActiveAt split', (t) => {
  if (!baseline) return t.skip(`old-vs-new skipped: ${baselineWhy}`);
  const rows = db.prepare('SELECT * FROM schedules').all();
  const zones = [null, 'UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Kathmandu'];
  let n = 0;
  for (const at of instants()) {
    for (const s of rows) for (const z of zones) {
      assert.equal(scheduler.isScheduleActiveNow(s, new Date(at), z), baseline.scheduler.isScheduleActiveNow(s, new Date(at), z),
        `${s.title} at ${new Date(at).toISOString()} in ${z}`);
      n++;
    }
  }
  assert.ok(n > 5000);
});

test('MIRROR vs VIEW: resolveFromInputs equals the resolver view for every device and schedule state', () => {
  const playlists = [null, ...Object.values(f.playlists)];
  const layoutId = crypto.randomUUID();
  db.prepare('INSERT INTO layouts (id, name, user_id) VALUES (?, ?, ?)').run(layoutId, 'L', f.userId);
  // A device-level layout on one screen, so the layout COALESCE is exercised both ways.
  db.prepare('UPDATE devices SET layout_id = ? WHERE id = ?').run(layoutId, f.devices.raw);
  let n = 0;
  try {
    for (const id of deviceIds()) {
      for (const sp of playlists) for (const sl of [null, layoutId]) {
        db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?').run(sp, sl, id);
        const inputs = sim.resolverInputs(db, id);
        assert.deepEqual(sim.resolveFromInputs(inputs, { playlist_id: sp, layout_id: sl }), viewRow(id),
          `device ${id} with scheduled ${sp}/${sl}`);
        n++;
      }
    }
  } finally {
    clearScheduled();
    db.prepare('UPDATE devices SET layout_id = NULL WHERE id = ?').run(f.devices.raw);
  }
  assert.ok(n >= deviceIds().length * playlists.length * 2);
});

test('FORECAST vs LIVE: at every instant the simulator resolves and builds exactly what the live tick does', () => {
  const offline = f.devices.offline;   // the tick skips offline screens; a forecast assumes it is online
  let n = 0;
  for (const at of instants()) {
    clearScheduled();
    scheduler.evaluateSchedules(fakeIo, new Date(at));
    for (const id of deviceIds()) {
      if (id === offline) continue;
      const ctx = sim.loadContext(id);
      const st = sim.stateAt(ctx, at);
      assert.deepEqual(st.entry.resolved, viewRow(id), `resolution of ${id} at ${new Date(at).toISOString()}`);
      assert.deepEqual(json(st.entry.payload), json(setupDeviceSocket.buildPlaylistPayloadUnchecked(id)),
        `payload of ${id} at ${new Date(at).toISOString()}`);
      n++;
    }
  }
  clearScheduled();
  assert.ok(n > 1000);
});

test('simulate() self-checks its mirror against the live view', () => {
  for (const id of deviceIds()) assert.equal(sim.simulate(id, Date.parse('2026-03-09T12:35:00Z')).resolver_check, 'ok', id);
});

/*
 * 3.0 layouts (docs/layouts-and-campaigns.md): the view gained a tier — the resolved playlist's own
 * published layout, below a schedule's and above the device's, skipped on wall members — and the
 * payload picks an orientation version of the layout from the screen's shape. The tests above run
 * the fleet with no playlist layouts (and prove the old behaviour is untouched); these run it again
 * WITH them, so the mirror and the forecast are held to the new tier too.
 */
function withPlaylistLayouts(fn) {
  const L1 = crypto.randomUUID(), L2 = crypto.randomUUID();
  db.prepare('INSERT INTO layouts (id, name, user_id) VALUES (?, ?, ?), (?, ?, ?)').run(L1, 'PL1', f.userId, L2, 'PL2', f.userId);
  const z = (lid, n, x, w) => { const id = crypto.randomUUID(); db.prepare('INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES (?, ?, ?, ?, 0, ?, 100, 0)').run(id, lid, n, x, w); return id; };
  const a = z(L1, 'A', 0, 60); z(L1, 'B', 60, 40); z(L2, 'C', 0, 50); z(L2, 'D', 50, 50);
  db.prepare("INSERT INTO layout_zone_variants (zone_id, layout_id, variant, x_percent, y_percent, width_percent, height_percent) VALUES (?, ?, 'portrait', 0, 0, 100, 60)").run(a, L1);
  const withLayout = { Own: L1, GroupHigh: L2, Promo: L1, Wall: L2, HQ: L2, Night: L1 };
  for (const [name, lid] of Object.entries(withLayout)) db.prepare('UPDATE playlists SET layout_id = ?, published_layout_id = ? WHERE id = ?').run(lid, lid, f.playlists[name]);
  db.prepare("UPDATE devices SET layout_id = ?, orientation = 'portrait' WHERE id = ?").run(L2, f.devices.raw);
  db.prepare("UPDATE devices SET orientation = 'portrait' WHERE id = ?").run(f.devices.tie);
  try { return fn({ L1, L2 }); } finally {
    db.prepare('UPDATE playlists SET layout_id = NULL, published_layout_id = NULL').run();
    db.prepare("UPDATE devices SET layout_id = NULL, orientation = 'landscape' WHERE id IN (?, ?)").run(f.devices.raw, f.devices.tie);
    clearScheduled();
  }
}

test('MIRROR vs VIEW with playlist layouts: the playlist tier is mirrored for every device and schedule state', () => {
  withPlaylistLayouts(({ L1, L2 }) => {
    const playlists = [null, ...Object.values(f.playlists)];
    let n = 0, fromPlaylist = 0;
    for (const id of deviceIds()) {
      for (const sp of playlists) for (const sl of [null, L1, L2]) {
        db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?').run(sp, sl, id);
        const mine = sim.resolveFromInputs(sim.resolverInputs(db, id), { playlist_id: sp, layout_id: sl });
        assert.deepEqual(mine, viewRow(id), `device ${id} with scheduled ${sp}/${sl}`);
        if (!sl && mine.layout_id && mine.source !== 'corporate') fromPlaylist++;
        n++;
      }
    }
    assert.ok(n >= deviceIds().length * playlists.length * 3);
    assert.ok(fromPlaylist > 10, `the playlist tier was actually exercised (${fromPlaylist})`);
  });
});

test('FORECAST vs LIVE with playlist layouts and a portrait screen: same resolution, same payload', () => {
  withPlaylistLayouts(() => {
    const offline = f.devices.offline;
    let n = 0;
    const all = instants();
    for (const at of all.filter((_, i) => i % 3 === 0)) {
      clearScheduled();
      scheduler.evaluateSchedules(fakeIo, new Date(at));
      for (const id of deviceIds()) {
        if (id === offline) continue;
        const st = sim.stateAt(sim.loadContext(id), at);
        assert.deepEqual(st.entry.resolved, viewRow(id), `resolution of ${id} at ${new Date(at).toISOString()}`);
        assert.deepEqual(json(st.entry.payload), json(setupDeviceSocket.buildPlaylistPayloadUnchecked(id)),
          `payload of ${id} at ${new Date(at).toISOString()}`);
        n++;
      }
    }
    assert.ok(n > 300);
    for (const id of deviceIds()) assert.equal(sim.simulate(id, Date.parse('2026-03-09T12:35:00Z')).resolver_check, 'ok', id);
  });
});
