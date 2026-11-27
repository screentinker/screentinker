'use strict';

/*
 * The freshness report must never run on the main thread (production 2026-11-27: chips froze the
 * server 3-13 s, the 09:00 digest 28 s), and moving it must not change an answer or risk the database.
 *
 *   - the sliced proof-of-play read returns exactly what the one GROUP BY returned, boundaries included;
 *   - reports come from the worker, equal to an inline compute, and are shared between simultaneous callers;
 *   - a worker that times out, or that would open a different SQLite build, NEVER falls back to the
 *     main thread: the last report or nothing;
 *   - the worker never loads db/database.js (a second read-write connection plus migrations);
 *   - the digest never computes on the main thread;
 *   - the database passes integrity_check after all of it.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-fresh-omt-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { dbPath } = require('../config');
const freshness = require('../lib/freshness');
const { createFreshnessRunner } = require('../lib/freshness-runner');

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const id = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const F = {};
const runners = [];
const mkRunner = (o = {}) => { const r = createFreshnessRunner({ db, dbPath, logger: { log() {}, warn() {} }, ...o }); runners.push(r); return r; };

before(() => {
  const uid = id('u');
  db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)').run(uid, `${uid}@t.test`, 'u', NOW - 400 * DAY);
  const oid = id('org');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(oid, 'Org', uid);
  F.ws = id('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_at) VALUES (?,?,?,?)').run(F.ws, oid, 'W', NOW - 400 * DAY);
  F.other = id('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_at) VALUES (?,?,?,?)').run(F.other, oid, 'Other', NOW - 400 * DAY);
  const items = [];
  for (let i = 0; i < 4; i++) {
    const cid = id('c');
    db.prepare("INSERT INTO content (id, filename, mime_type, created_at, updated_at, workspace_id) VALUES (?,?, 'image/png', ?, ?, ?)")
      .run(cid, `c${i}.png`, NOW - (i + 1) * 40 * DAY, NOW - (i + 1) * 40 * DAY, F.ws);
    items.push({ content: cid });
  }
  const wid = id('w');
  db.prepare("INSERT INTO widgets (id, widget_type, name, config, created_at, updated_at, workspace_id) VALUES (?, 'slide', 'S', '{}', ?, ?, ?)")
    .run(wid, NOW - 50 * DAY, NOW - 50 * DAY, F.ws);
  items.push({ widget: wid });
  const pid = id('pl');
  db.prepare("INSERT INTO playlists (id, user_id, name, status, workspace_id) VALUES (?,?, 'P', 'published', ?)").run(pid, uid, F.ws);
  for (const it of items) db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, duration_sec, created_at) VALUES (?,?,?,10,?)').run(pid, it.content || null, it.widget || null, NOW - 500 * DAY);
  F.devices = [];
  for (let d = 0; d < 3; d++) {
    const did = id('d');
    db.prepare("INSERT INTO devices (id, name, status, playlist_id, playlist_source, workspace_id) VALUES (?, ?, 'online', ?, 'device', ?)").run(did, `D${d}`, pid, F.ws);
    F.devices.push(did);
  }
  const ins = db.prepare('INSERT INTO play_logs (device_id, content_id, widget_id, started_at, ended_at, duration_sec, workspace_id) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 3000; k++) {
      const it = items[rnd(items.length)];
      // Spread over 9 days so some plays fall before the 7-day window; a few are ahead of the clock.
      const when = NOW - rnd(9 * DAY) + (k % 97 === 0 ? 120 : 0);
      ins.run(F.devices[rnd(3)], it.content || null, it.widget || null, when, when + 10, rnd(5) ? 10 + rnd(20) : null, F.ws);
    }
    // Exactly on the window's start and on slice boundaries.
    const since = NOW - 7 * DAY;
    for (const t of [since, since - 1, since + DAY, since + DAY - 1, NOW, NOW + 1]) ins.run(F.devices[0], items[0].content, null, t, t + 10, 10, F.ws);
    // A play on this workspace's screen recorded against ANOTHER workspace must not count (as before).
    ins.run(F.devices[1], items[1].content, null, NOW - DAY, NOW - DAY + 10, 10, F.other);
  })();
});

after(() => { for (const r of runners) r.stop(); require('../lib/freshness-runner').defaultRunner().stop(); });

test('the sliced read returns exactly what the single GROUP BY returned', () => {
  const since = NOW - 7 * DAY;
  const old = db.prepare(`
    SELECT device_id, content_id, widget_id, COUNT(*) AS n, SUM(COALESCE(duration_sec, 10)) AS secs
      FROM play_logs
     WHERE device_id IN (SELECT id FROM devices WHERE workspace_id = ?) AND workspace_id = ? AND started_at >= ?
     GROUP BY device_id, content_id, widget_id`).all(F.ws, F.ws, since);
  const sliced = freshness.playsInWindow(db, F.ws, F.devices, since, NOW);
  const norm = (rows) => rows.map((r) => `${r.device_id}|${r.content_id}|${r.widget_id}|${r.n}|${r.secs}`).sort();
  assert.ok(old.length > 5, 'fixture produced plays');
  assert.deepEqual(norm(sliced), norm(old));
});

test('reports come from the worker and equal an inline compute', async () => {
  const r = mkRunner();
  const viaWorker = await r.report(F.ws, { fresh: true, now: NOW });
  assert.equal(r.mode, 'worker');
  const inline = freshness.computeWorkspace(db, F.ws, { now: NOW, useCache: false, keep: false });
  assert.deepEqual(viaWorker, inline);
  assert.ok(viaWorker.devices.length === 3);
});

test('the main thread never computes when a worker is available (simultaneous callers share one)', async () => {
  freshness.invalidate(F.ws);
  const orig = freshness.computeWorkspace;
  let mainCalls = 0;
  freshness.computeWorkspace = (...a) => { mainCalls++; return orig(...a); };
  try {
    const r = mkRunner();
    const [a, b, c] = await Promise.all([r.report(F.ws), r.report(F.ws), r.report(F.ws)]);
    assert.equal(mainCalls, 0);
    assert.ok(a && a === b && b === c, 'one shared computation');
    assert.equal(await r.report(F.ws), a, 'then served from the cache');
  } finally { freshness.computeWorkspace = orig; }
});

test('⚠️ a worker that does not answer in time is NOT replaced by a main-thread compute', async () => {
  freshness.invalidate(F.ws);
  const orig = freshness.computeWorkspace;
  let mainCalls = 0;
  freshness.computeWorkspace = (...a) => { mainCalls++; return orig(...a); };
  try {
    const r = mkRunner({ timeoutMs: 1 });
    assert.equal(await r.report(F.ws, { fresh: true }), null, 'no report yet: nothing, not an inline compute');
    freshness.remember(F.ws, { marker: 'last' });
    assert.deepEqual(await r.report(F.ws, { fresh: true }), { marker: 'last' }, 'the last report, however old');
    assert.equal(mainCalls, 0);
  } finally { freshness.computeWorkspace = orig; freshness.invalidate(F.ws); }
});

test('⚠️ a worker on a different SQLite driver refuses to open, and nothing runs inline', async () => {
  freshness.invalidate(F.ws);
  const sd = require('../db/sqlite-driver');
  const real = sd.driverName;
  const r = mkRunner();
  // The runner passes the main thread's driver name; pretend the main thread chose another one.
  Object.defineProperty(sd, 'driverName', { value: 'not-the-same', configurable: true, writable: true });
  try {
    assert.equal(await r.report(F.ws, { fresh: true }), null);
    assert.notEqual(r.mode, 'worker', 'the worker was torn down');
  } finally { Object.defineProperty(sd, 'driverName', { value: real, configurable: true, writable: true }); }
});

test('a snooze made while a report was computing is not undone by that report arriving', async () => {
  freshness.invalidate(F.ws);
  const r = mkRunner();
  const p = r.report(F.ws);
  freshness.invalidate(F.ws);   // what saveSettings / a snooze does
  await p;
  assert.equal(freshness.cached(F.ws), null, 'the in-flight answer was not cached over the invalidation');
});

test('⚠️ the worker never loads db/database.js (no second read-write connection, no migrations)', () => {
  const script = `
    const Module = require('module'); const orig = Module._load; const seen = [];
    Module._load = function (r, p, i) { seen.push(Module._resolveFilename(r, p, i)); return orig.apply(this, arguments); };
    const { Worker } = require('node:worker_threads');
    require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'freshness'))});
    require(${JSON.stringify(path.join(__dirname, '..', 'db', 'sqlite-driver'))});
    process.stdout.write(JSON.stringify(seen.filter((f) => f.includes('/db/'))));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }));
  assert.ok(!out.some((f) => /db[\\/]database\.js$/.test(f)), `worker modules loaded: ${out.join(', ')}`);
});

test('the digest never computes a report on the main thread', async () => {
  const digest = require('../services/freshness-digest');
  const orig = freshness.computeWorkspace;
  let mainCalls = 0;
  freshness.computeWorkspace = (...a) => { mainCalls++; return orig(...a); };
  try {
    // The server's own database and no injected source: the default, worker-backed path.
    const res = await digest.runDigestSweep({
      email: { isConfigured: () => true, sendEmail: async () => ({ sent: true }) },
      appUrl: 'https://st.test',
    });
    assert.equal(mainCalls, 0);
    assert.ok(res && !res.skipped, `the sweep ran (${JSON.stringify(res)})`);
  } finally { freshness.computeWorkspace = orig; }
});

test('the database is intact afterwards', () => {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

// ---------------------------------------------------------------------------------------------
// Chips answer now (reportSoon): a dashboard never waits on a report.
// ---------------------------------------------------------------------------------------------

test('chips with nothing cached: answer null within waitMs, and the report still lands for the next ask', async () => {
  freshness.invalidate(F.ws);
  const r = mkRunner();
  const t0 = Date.now();
  assert.equal(await r.reportSoon(F.ws, { waitMs: 0 }), null, 'no report yet: no chips, right away');
  assert.ok(Date.now() - t0 < 1000);
  await r.report(F.ws);   // joins the compute reportSoon started (shared), it does not start another
  const next = await r.reportSoon(F.ws, { waitMs: 0 });
  assert.ok(next && next.devices.length === 3, 'the next ask gets the finished report');
});

test('chips with an old report: that report at once, refreshed in the background', async () => {
  freshness.invalidate(F.ws);
  const r = mkRunner();
  freshness.remember(F.ws, { marker: 'old' });
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000;   // the cached report is now five minutes old
  let served;
  try { served = await r.reportSoon(F.ws, { waitMs: 0 }); } finally { Date.now = realNow; }
  assert.deepEqual(served, { marker: 'old' }, 'answered with what we had, not made to wait');
  // The background refresh it started replaces the old report when it lands.
  const until = Date.now() + 15000;
  while (Date.now() < until && !(freshness.cached(F.ws) || {}).devices) await new Promise((res) => setTimeout(res, 20));
  const fresh = freshness.cached(F.ws);
  assert.ok(fresh && fresh.devices && fresh.devices.length === 3, 'replaced by a real report');
});

test('chips after a snooze or settings change never get the report from before it', async () => {
  const r = mkRunner();
  freshness.remember(F.ws, { marker: 'before-snooze' });
  freshness.invalidate(F.ws);   // what a snooze / settings save does
  const got = await r.reportSoon(F.ws, { waitMs: 30000 });
  assert.notDeepEqual(got, { marker: 'before-snooze' });
  assert.ok(got && got.devices.length === 3);
});
