'use strict';

/*
 * ⚠️ THE UPGRADE CHANGES NO SCREEN — spec §2.6 / §8.5.
 *
 * The corporate feature rewrites the playlist resolver view every installed server reads on every
 * payload build. The per-boot verifier (applyResolverViews({verify:true})) proves the new view
 * agrees with the old one for every device before keeping it, and falls back to the old one —
 * degraded, not crashed — when it does not. These tests run the REAL boot (db/database.js) in
 * child processes against a database carrying the FROZEN pre-feature views
 * (test/fixtures/resolver-views-d82f572.sql, copied verbatim from the base commit), and compare
 * the full device payload of every device before and after.
 *
 *   1. a seeded fleet covering every resolution case: payloads byte-identical, upgrade recorded
 *   2. a deliberately wrong view (test seam): old views kept, degraded, corporate POST -> 503
 *   3. booting twice: the second boot takes the identical-SQL fast path
 *   4. a create-copy-drop-rename rebuild of playlists / organizations in the migration window
 *   5. every column the views name is covered by verifyAndRepairSchema
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const FROZEN = fs.readFileSync(path.join(__dirname, 'fixtures', 'resolver-views-d82f572.sql'), 'utf8');

function inChild(dataDir, body, env = {}) {
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    const out = {};
    const { db } = require(${JSON.stringify(path.join(SERVER, 'db', 'database'))});
    (async () => { ${body} })().then(() => { process.stdout.write('\\n@@' + JSON.stringify(out) + '@@\\n'); process.exit(0); },
      (e) => { process.stdout.write('\\n@@' + JSON.stringify({ error: e.stack || String(e) }) + '@@\\n'); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: SERVER, env: { ...process.env, SELF_HOSTED: 'true', NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 120000,
  });
  const m = /@@(.*)@@/s.exec(r.stdout || '');
  if (!m) throw new Error(`child produced no result: ${r.stderr || r.stdout}`);
  const res = JSON.parse(m[1]);
  if (res.error) throw new Error(res.error);
  res._stderr = r.stderr; res._stdout = r.stdout;
  return res;
}

// Every resolution case, seeded through plain SQL so nothing new is involved in building it.
const SEED = `
  const u = db.prepare('SELECT id FROM users LIMIT 1').get() || (() => {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'user')").run(); return { id: 'u1' }; })();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES ('org1', 'Org', ?)").run(u.id);
  db.prepare("INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES ('ws1', 'org1', 'WS')").run();
  const pl = (id, extra = {}) => db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, smart_rules) VALUES (?, ?, 'ws1', ?, 'published', ?, ?)")
    .run(id, u.id, id, JSON.stringify(extra.items || []), extra.smart || null);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES ('c1', ?, 'ws1', 'a.png', 'a.png', 'image/png', 1)").run(u.id);
  const item = (cid) => [{ content_id: cid, filename: 'a.png', mime_type: 'image/png', filepath: 'a.png', duration_sec: 10, sort_order: 0 }];
  for (const id of ['pOwn', 'pGroupA', 'pGroupB', 'pWall', 'pSched', 'pRaw', 'pChild']) pl(id, { items: item('c1') });
  pl('pSmart', { items: item('c1'), smart: JSON.stringify({ match: 'all', rules: [{ field: 'type', op: 'is', value: 'image' }] }) });
  pl('pParent', { items: item('c1') });
  db.prepare("INSERT INTO playlist_items (playlist_id, child_playlist_id, sort_order) VALUES ('pParent', 'pChild', 0)").run();
  db.prepare("INSERT INTO layouts (id, user_id, workspace_id, name) VALUES ('L1', ?, 'ws1', 'L1'), ('L2', ?, 'ws1', 'L2')").run(u.id, u.id);
  const dev = (id, cols = {}) => {
    db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, \\'ws1\\', ?, ?)').run(id, u.id, id, 'pc-' + id);
    for (const [k, v] of Object.entries(cols)) db.prepare('UPDATE devices SET ' + k + ' = ? WHERE id = ?').run(v, id);
  };
  db.prepare("INSERT INTO device_groups (id, user_id, workspace_id, name, playlist_id, priority, created_at) VALUES ('gA', ?, 'ws1', 'A', 'pGroupA', 0, 1), ('gB', ?, 'ws1', 'B', 'pGroupB', 5, 2)").run(u.id, u.id);
  db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name, playlist_id) VALUES ('w1', ?, 'ws1', 'Wall', 'pWall')").run(u.id);
  dev('dOverride', { playlist_id: 'pOwn', playlist_source: 'device', layout_id: 'L1' });
  dev('dInheritA'); db.prepare("INSERT INTO device_group_members (device_id, group_id) VALUES ('dInheritA', 'gA')").run();
  dev('dTwoGroups'); db.prepare("INSERT INTO device_group_members (device_id, group_id) VALUES ('dTwoGroups', 'gA'), ('dTwoGroups', 'gB')").run();
  dev('dWallLead', { wall_id: 'w1' }); dev('dWallFollow', { wall_id: 'w1' });
  db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('w1', 'dWallLead', 0, 0), ('w1', 'dWallFollow', 1, 0)").run();
  db.prepare("UPDATE video_walls SET leader_device_id = 'dWallLead' WHERE id = 'w1'").run();
  dev('dNone', { playlist_source: 'none' });
  dev('dSched', { scheduled_playlist_id: 'pSched', scheduled_layout_id: 'L2', playlist_id: 'pOwn', playlist_source: 'device' });
  dev('dSchedOverNone', { playlist_source: 'none', scheduled_playlist_id: 'pSched' });
  dev('dRaw', { playlist_id: 'pRaw' });
  dev('dSmart', { playlist_id: 'pSmart', playlist_source: 'device' });
  dev('dNested', { playlist_id: 'pParent', playlist_source: 'device', default_content_id: 'c1' });
  dev('dBare');
`;

const PAYLOADS = `
  // The payload builder is attached once the socket layer is set up — the real send path, not a copy.
  const setupDeviceSocket = require(${JSON.stringify(path.join(SERVER, 'ws', 'deviceSocket'))});
  const { Server } = require('socket.io');
  setupDeviceSocket(new Server(require('node:http').createServer()));
  const { buildPlaylistPayloadUnchecked } = setupDeviceSocket;
  out.payloads = {};
  for (const d of db.prepare('SELECT id FROM devices ORDER BY id').all()) out.payloads[d.id] = JSON.stringify(buildPlaylistPayloadUnchecked(d.id));
  out.views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all();
  out.resolved = db.prepare('SELECT device_id, playlist_id, source, layout_id FROM device_resolved_playlist ORDER BY device_id').all();
  out.upgraded = !!db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'corporate_resolver_v1'").get();
  out.degraded = require(${JSON.stringify(path.join(SERVER, 'lib', 'corporate', 'runtime'))}).isViewsDegraded();
`;

function installFrozen() {
  return `
    db.exec('DROP VIEW IF EXISTS device_resolved_playlist'); db.exec('DROP VIEW IF EXISTS device_inherited_playlist');
    db.exec(${JSON.stringify(FROZEN.replace(/^--.*$/gm, ''))});
    db.prepare("DELETE FROM schema_migrations WHERE id = 'corporate_resolver_v1'").run();
  `;
}

function freshDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `corp-up-${tag}-`)); }

test('1. a fleet on the PRE-FEATURE views: every device payload is byte-identical after the upgrade', () => {
  const dir = freshDir('fleet');
  // Boot once to create the schema, seed, then put the frozen pre-feature views back — the state
  // of an installed server the moment before it pulls this release.
  const before = inChild(dir, SEED + installFrozen() + PAYLOADS);
  assert.ok(Object.keys(before.payloads).length >= 12, 'the fleet was seeded');
  assert.equal(before.views.find((v) => v.name === 'device_resolved_playlist').sql.includes('corporate'), false, 'precondition: old views');

  const after = inChild(dir, PAYLOADS);
  assert.equal(after.degraded, false, after._stderr);
  assert.equal(after.upgraded, true, 'corporate_resolver_v1 recorded');
  assert.ok(after.views.find((v) => v.name === 'device_resolved_playlist').sql.includes('corporate_mandates'), 'the new view is in place');
  assert.deepEqual(after.resolved, before.resolved);
  for (const [id, p] of Object.entries(before.payloads)) assert.equal(after.payloads[id], p, `payload of ${id} changed`);
});

test('2. a definition that WOULD change a screen: previous views kept, degraded, corporate writes 503, payloads untouched', () => {
  const dir = freshDir('wrong');
  const before = inChild(dir, SEED + installFrozen() + PAYLOADS);
  // Simulate a broken new definition through the module's test seam, exactly as boot would apply it.
  const r = inChild(dir, `
    const sql = require(${JSON.stringify(path.join(SERVER, 'lib', 'playlist-resolver-sql'))});
    ${installFrozen()}
    const prev = sql.dropResolverViews(db);
    // A bug of exactly the kind this guards: the 'none' short-circuit lost, so a deliberately dark
    // screen inside a group would light up with the group's playlist.
    db.prepare("INSERT INTO device_group_members (device_id, group_id) VALUES ('dNone', 'gA')").run();
    const WRONG = sql.RESOLVED_VIEW.replace("WHEN d.playlist_source = 'none' AND d.scheduled_playlist_id IS NULL THEN NULL", "WHEN 1 = 0 THEN NULL");
    if (WRONG === sql.RESOLVED_VIEW) throw new Error('the test seam replacement did not apply');
    out.result = sql.applyResolverViews(db, { verify: true, previousSql: prev, resolvedViewSql: WRONG });
    ${PAYLOADS}
  `);
  assert.equal(r.result.status, 'degraded');
  assert.ok(r.result.changed.some((c) => c.device_id === 'dNone'), 'the dark screen would have lit up');
  assert.equal(r.degraded, true);
  assert.equal(r.views.find((v) => v.name === 'device_resolved_playlist').sql.includes('corporate'), false, 'the previous view is back');
  for (const [id, p] of Object.entries(before.payloads)) assert.equal(r.payloads[id], p, `payload of ${id} changed in degraded mode`);
  assert.match(r._stderr, /ABORT view upgrade/);
});

test('2b. degraded mode at the HTTP layer: corporate writes answer 503 CORPORATE_UNAVAILABLE, reads still work', async () => {
  const { freePort } = require('./helpers/free-port');
  const dir = freshDir('degraded-http');
  const PORT = await freePort();
  const logFd = fs.openSync(path.join(dir, 'server.log'), 'a');
  const proc = spawn(process.execPath, [path.join(SERVER, 'server.js')], {
    env: { ...process.env, DATA_DIR: dir, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', CORPORATE_TEST_FORCE_DEGRADED: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  try {
    const BASE = `http://127.0.0.1:${PORT}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
      if (!up) await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(up, 'server booted');
    const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `d${Date.now()}@x.test`, password: 'Passw0rd123', name: 'D' }) })).json();
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` };
    const w = await fetch(BASE + '/api/corporate/playlists', { method: 'POST', headers: H, body: JSON.stringify({ name: 'x' }) });
    assert.equal(w.status, 503);
    assert.equal((await w.json()).code, 'CORPORATE_UNAVAILABLE');
    const r = await fetch(BASE + '/api/corporate/settings', { headers: H });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).available, false);
  } finally { proc.kill('SIGKILL'); }
});

test('3. booting twice: the second boot takes the identical-SQL fast path', () => {
  const dir = freshDir('twice');
  inChild(dir, '');
  const r = inChild(dir, `
    const sql = require(${JSON.stringify(path.join(SERVER, 'lib', 'playlist-resolver-sql'))});
    const prev = sql.dropResolverViews(db);
    out.result = sql.applyResolverViews(db, { verify: true, previousSql: prev });
  `);
  assert.equal(r.result.status, 'same');
});

test('4. ⚠️ a table rebuild (create-copy-drop-rename) of playlists and organizations inside the migration window succeeds', () => {
  const { freshDb } = require('./helpers/corporate-fixture');
  const sql = require('../lib/playlist-resolver-sql');
  // With the views present SQLite refuses the rename — the reason boot drops them first.
  {
    const demo = freshDb({ guards: false });
    const create = demo.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'playlists'").get().sql;
    demo.pragma('foreign_keys = OFF');
    demo.exec(create.replace('CREATE TABLE playlists', 'CREATE TABLE playlists_new'));
    demo.exec('INSERT INTO playlists_new SELECT * FROM playlists');
    demo.exec('DROP TABLE playlists');
    assert.throws(() => demo.exec('ALTER TABLE playlists_new RENAME TO playlists'), /view/i);
  }
  const db = freshDb({ guards: false });
  db.prepare("INSERT INTO organizations (id, name) VALUES ('o', 'O')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id) VALUES ('w', 'o')").run();
  db.prepare("INSERT INTO playlists (id, workspace_id, name) VALUES ('p', 'w', 'p')").run();
  const rebuild = (table) => {
    const create = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
    db.pragma('foreign_keys = OFF');
    db.exec(create.replace(new RegExp(`CREATE TABLE ${table}`), `CREATE TABLE ${table}_new`));
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    db.pragma('foreign_keys = ON');
  };
  const prev = sql.dropResolverViews(db);
  rebuild('playlists');
  rebuild('organizations');
  const r = sql.applyResolverViews(db, { verify: true, previousSql: prev });
  assert.ok(['same', 'verified'].includes(r.status), JSON.stringify(r));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM device_resolved_playlist').get());
});

test('5. every column the resolver views name is checked (and repairable) by verifyAndRepairSchema', () => {
  const { REQUIRED_COLUMNS, REQUIRED_TABLES } = require('../lib/schema-check');
  const have = new Set(REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`));
  const named = {
    devices: ['workspace_id', 'playlist_id', 'playlist_source', 'wall_id', 'layout_id', 'scheduled_playlist_id', 'scheduled_layout_id'],
    workspaces: ['organization_id'],
    organizations: ['corporate_enabled'],
    playlists: ['workspace_id', 'corporate'],
  };
  for (const [t, cols] of Object.entries(named)) {
    assert.ok(REQUIRED_TABLES.includes(t), `${t} is a required table`);
    for (const c of cols) assert.ok(have.has(`${t}.${c}`), `${t}.${c} must be in REQUIRED_COLUMNS`);
  }
  for (const [t, c, repair] of REQUIRED_COLUMNS) if (named[t] && named[t].includes(c)) assert.ok(repair, `${t}.${c} has a repair`);
});
