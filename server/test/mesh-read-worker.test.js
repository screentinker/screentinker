'use strict';

/*
 * Mesh reads on a worker thread, and the same reads without one.
 *
 * ⚠️ THE PROPERTY THAT MATTERS IS THAT THE TWO AGREE. A fallback that answers slightly differently
 * is worse than no fallback: the path nobody develops on is the one that is wrong, and it is wrong
 * only in the field — on BrightSign, where a patched Node may have no worker_threads at all and
 * where nobody is watching a console.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const nodeData = require('../lib/mesh/node-data');
const { createReadRunner, workerThreadsAvailable } = require('../lib/mesh/read-runner');

const NOW = Math.floor(Date.now() / 1000);
const quiet = { log() {}, warn() {}, error() {} };

/*
 * ⚠️ THE SCHEMA COMES FROM THE REAL ONE. It used to be hand-written here, and that is precisely
 * why this file certified two broken projections as working for months.
 *
 * The old fixture declared `playlist_items` WITHOUT `child_playlist_id` and `content` without the
 * columns the code actually referenced — so it reproduced node-data.js's blind spots rather than
 * exposing them. A nested item read as a blank row and the test agreed; `/api/playlists/:id`
 * referenced three columns that do not exist (`i.position`, `c.name`, `c.type`) and no test ever
 * called that path.
 *
 * Booting the real db module once and copying the file per test costs a few milliseconds and makes
 * that entire class of bug impossible: a column the code names but the database lacks now fails
 * loudly, here, instead of being swallowed into an HTTP 403 on somebody's hub.
 */
let TEMPLATE_DB = null;
function schemaTemplate() {
  if (TEMPLATE_DB) return TEMPLATE_DB;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshread-tpl-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  process.env.SELF_HOSTED = 'true';
  /*
   * ⚠️ Evict CONFIG too, not just the db module. config.js resolves DATA_DIR at first require and
   * caches it, and node-data (imported at the top of this file) already pulled both in — so
   * evicting only db/database re-required it against the ALREADY-CACHED config and opened the real
   * development database. The tell was a device count of 37: 35 real rows plus the 2 seeded here.
   */
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../db/database')];
  const real = require('../db/database');
  const file = real.db.name;                 // the real, migrated database file
  /*
   * ⚠️ Checkpoint AND CLOSE. copyFileSync copies only the .db, never the -wal, so while that
   * connection stays open every copy is a snapshot of a file still being written — which surfaces
   * later as a bare "FOREIGN KEY constraint failed" from a DELETE, naming nothing. Closing makes
   * the template quiescent, so every copy is the same complete database.
   */
  real.db.pragma('wal_checkpoint(TRUNCATE)');
  try { real.db.close(); } catch (e) { /* already closed */ }
  if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
  TEMPLATE_DB = file;
  return TEMPLATE_DB;
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshread-'));
  const file = path.join(dir, 'r.db');
  fs.copyFileSync(schemaTemplate(), file);
  const db = new Database(file);
  // No wipe: a freshly-migrated database has no rows in any of these tables (verified), and a
  // DELETE sweep across FK-linked tables is a good way to fail for reasons unrelated to the test.

  /*
   * ⚠️ FK-SAFE ORDER: users -> playlists -> content -> items -> devices.
   *
   * The old hand-written schema had no foreign keys, so seed order never mattered. The real one
   * does, and `devices.playlist_id` references `playlists(id)` — inserting the device first fails
   * with a bare "FOREIGN KEY constraint failed" that names nothing. Order the seed by dependency
   * and it cannot come back.
   */
  /*
   * Named columns, never positional — the real schema is wider than this fixture cares about and
   * grows over time. `playlists.user_id` is NOT NULL REFERENCES users(id) and foreign_keys is ON,
   * so a user has to exist first: a pushed or seeded playlist genuinely cannot exist without one.
   */
  db.prepare(`INSERT INTO users (id,email,name,password_hash) VALUES ('u1','seed@example.com','Seed','x')`).run();
  // The tenancy rows the rest of the seed hangs off: workspace_id is a real FK on devices,
  // playlists and content, so 'w1'/'w2' have to exist rather than being convenient strings.
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES ('o1','Seed Org','u1',?,?)`).run(NOW, NOW);
  for (const w of ['w1', 'w2']) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?, 'o1', ?, ?, ?)`).run(w, `WS ${w}`, NOW, NOW);
  }
  db.prepare(`INSERT INTO playlists (id,user_id,name,status,published_snapshot,workspace_id,created_at,updated_at)
              VALUES ('pl1','u1','Store Loop','published',NULL,'w1',?,?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size,duration_sec)
              VALUES ('c1','u1','w1','Welcome.mp4','uploads/welcome.mp4','video/mp4',1024,18)`).run();
  db.prepare(`INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec,created_at,updated_at)
              VALUES ('pl1','c1',0,18,?,?)`).run(NOW, NOW);

  /*
   * ⚠️ A NESTED item — the shape the old hand-written fixture could not express, because it
   * declared playlist_items without child_playlist_id. Without this row, a projection that drops
   * child_playlist_id still reads as "ok" with the right item count.
   */
  db.prepare(`INSERT INTO playlists (id,user_id,name,status,workspace_id,created_at,updated_at)
              VALUES ('pl-child','u1','Nested Loop','published','w1',?,?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO playlist_items (playlist_id,child_playlist_id,sort_order,duration_sec,created_at,updated_at)
              VALUES ('pl1','pl-child',1,10,?,?)`).run(NOW, NOW);

  db.prepare(`INSERT INTO devices (id,user_id,name,status,last_heartbeat,workspace_id,playlist_id,created_at)
              VALUES ('d1','u1','Lobby','online',?, 'w1','pl1',?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO devices (id,user_id,name,status,last_heartbeat,workspace_id,created_at)
              VALUES ('d2','u1','Elsewhere','offline',?, 'w2',?)`).run(NOW - 900, NOW);
  db.prepare(`INSERT INTO device_telemetry (device_id,storage_free_mb,cpu_usage,uptime_seconds,reported_at)
              VALUES ('d1',4096,12.5,7200,?)`).run(NOW);
  db.__dir = dir;
  db.__file = file;
  return db;
}
const cleanup = (db) => {
  try { db.close(); } catch (e) { /* closed */ }
  try { fs.rmSync(db.__dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
};

const edge = (over = {}) => ({
  id: 'e1', peer_node_id: 'child', direction: 'up',
  grant_categories: JSON.stringify(['health', 'identity', 'content-metadata']),
  shared_workspaces: null, revoked_at: null, ...over,
});

test('⚠️ THE WORKER AND THE FALLBACK RETURN THE SAME ANSWER', async () => {
  /*
   * The property the whole design rests on. Both paths call the identical function; the moment they
   * can disagree, the one nobody develops on is wrong and is wrong only in the field.
   */
  const db = freshDb();
  const withWorker = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const withoutWorker = createReadRunner({
    dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const p of ['/api/devices', '/api/devices/d1', '/api/playlists', '/api/devices/d1/telemetry']) {
      const req = { path: p, method: 'GET' };
      const [a, b] = await Promise.all([withWorker.run(edge(), req), withoutWorker.run(edge(), req)]);

      /*
       * ⚠️ COMPARED AS DELIVERED, which is JSON over a socket — and the distinction is not pedantry,
       * it caught a genuine difference between the two sqlite drivers.
       *
       * `node:sqlite` returns rows with a NULL PROTOTYPE; better-sqlite3 returns ordinary objects.
       * postMessage's structured clone normalises them, so the worker path yields plain objects and
       * the inline path yields null-prototype ones — deepEqual distinguishes those, and the raw
       * comparison failed on the fallback driver only.
       *
       * Neither survives the wire: both serialise to the same bytes, and `undefined` values are
       * dropped by JSON identically. So the property worth guarding is that what the PARENT receives
       * is the same, not that two in-memory representations share a prototype.
       */
      /*
       * ⚠️ EXCEPT `asOf`, WHICH IS ALLOWED TO DIFFER — and comparing it exactly is a test bug I
       * shipped. Each path stamps its own generation time, which is correct: they are two separate
       * computations. An exact comparison therefore fails whenever the two straddle a second
       * boundary — locally almost never, in CI often enough to block a release.
       *
       * The property is that the same QUESTION yields the same DATA, so the timestamps are checked
       * for being close rather than equal. "Re-run it" would have been the wrong response to this.
       */
      const strip = (r) => JSON.stringify({ ...r, asOf: undefined });
      assert.equal(strip(a), strip(b), `${p} must be identical on both paths, as delivered`);
      if (a.asOf !== undefined) {
        assert.ok(Math.abs(a.asOf - b.asOf) <= 2,
          `${p}: the two paths stamped times ${Math.abs(a.asOf - b.asOf)}s apart`);
      }
      assert.equal(a.ok, true, `${p} should have answered`);
    }
  } finally { withWorker.stop(); withoutWorker.stop(); cleanup(db); }
});

test('the fallback runner reports itself as inline, and still answers', async () => {
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    assert.equal(r.mode, 'inline');
    const answer = await r.run(edge(), { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, true);
    assert.equal(answer.rows.length, 2);
  } finally { r.stop(); cleanup(db); }
});

test('a worker runs on this platform, and says so', async () => {
  // ⚠️ Skipped rather than failed where the module is absent — that is the BrightSign case, and it
  // is a supported configuration, not a broken one.
  if (!workerThreadsAvailable()) return;
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  try {
    assert.equal(r.mode, 'worker');
    const answer = await r.run(edge(), { path: '/api/devices/d1', method: 'GET' });
    assert.equal(answer.ok, true);
    assert.equal(answer.row.name, 'Lobby');
    assert.equal(answer.row.telemetry.length, 1, 'the composite shape survives the thread hop');
    assert.equal(answer.row.assignments.length, 2);

    /*
     * ⚠️ THE NESTED ITEM MUST NOT READ AS A BLANK ROW.
     *
     * The projection used to enumerate item columns without child_playlist_id, so a nested item
     * came back with content_id, widget_id AND child_playlist_id all null — right item count,
     * right durations, an empty row, and ok:true. A hub showed the customer a playlist with a gap
     * in it and nothing anywhere said why.
     */
    const nested = answer.row.assignments.find((a) => a.sort_order === 1);
    assert.ok(nested, 'the nested item vanished from the projection');
    assert.equal(nested.child_playlist_id, 'pl-child',
      'a nested item read as a blank row — no content, no widget, no child');
    assert.equal(nested.child_playlist_name, 'Nested Loop',
      'the hub can only render "plays Nested Loop in full" if the name crosses the wire');
  } finally { r.stop(); cleanup(db); }
});

test('⚠️ /api/playlists/:id answers at all — it referenced three columns that do not exist', async () => {
  /*
   * This path had ZERO coverage, and it was broken on every node for every playlist: `i.position`,
   * `c.name` and `c.type` are all absent from the schema. SQLite reports c.name first, so fixing
   * only the known one changed nothing. The catch rendered it as ok:false, which routes/mesh.js
   * turns into HTTP 403 — "this will never work until somebody changes a grant". No grant would
   * ever have helped.
   */
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    const answer = await r.run(edge(), { path: '/api/playlists/pl1', method: 'GET' });
    assert.equal(answer.ok, true, `playlist detail refused: ${answer.reason}`);
    assert.equal(answer.row.name, 'Store Loop');
    assert.equal(answer.row.items.length, 2, 'both items, in sort_order');
    assert.equal(answer.row.items[0].content_name, 'Welcome.mp4');
    assert.equal(answer.row.items[1].child_playlist_id, 'pl-child',
      'the nested reference must survive here too');
  } finally { r.stop(); cleanup(db); }
});

test('⚠️ the WORKSPACE SCOPE is applied on both paths', async () => {
  // A scope that held only on the main thread would be no scope at all once the worker was the
  // normal path — and the worker is the path that runs in production.
  const db = freshDb();
  const scoped = edge({ shared_workspaces: JSON.stringify(['w1']) });
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const list = await r.run(scoped, { path: '/api/devices', method: 'GET' });
      assert.deepEqual(list.rows.map((d) => d.id), ['d1'], 'the other workspace never travels');
      const other = await r.run(scoped, { path: '/api/devices/d2', method: 'GET' });
      assert.equal(other.ok, false, 'and cannot be reached by id either');
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('⚠️ the GRANT is applied on both paths', async () => {
  const db = freshDb();
  const healthOnly = edge({ grant_categories: JSON.stringify(['health']) });
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const one = await r.run(healthOnly, { path: '/api/devices/d1', method: 'GET' });
      assert.equal(one.ok, true);
      assert.equal(one.row.name, undefined, 'a health-only edge learns no names');
      assert.deepEqual(one.row.assignments, [], 'and no content');
      const pl = await r.run(healthOnly, { path: '/api/playlists', method: 'GET' });
      assert.equal(pl.ok, false, 'playlists need content-metadata');
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('a write is refused on both paths', async () => {
  const db = freshDb();
  const w = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  const i = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet, preferWorker: false });
  try {
    for (const r of [w, i]) {
      const res = await r.run(edge(), { path: '/api/devices/d1', method: 'DELETE' });
      assert.equal(res.ok, false);
      assert.match(res.reason, /can read, and cannot write/);
    }
  } finally { w.stop(); i.stop(); cleanup(db); }
});

test('⚠️ a dead worker falls back instead of hanging', async () => {
  /*
   * In-flight reads must be ANSWERED when the worker dies, not left pending. Leaving them would
   * hang the parent until its own timeout, and an operator watching a spinner concludes the product
   * is broken — a worse outcome than the slow path.
   */
  if (!workerThreadsAvailable()) return;
  const db = freshDb();
  const r = createReadRunner({ dbPath: db.__file, db, nodeData, logger: quiet });
  try {
    assert.equal(r.mode, 'worker');
    r.stop();                       // the worker is gone
    assert.equal(r.mode, 'inline', 'and the runner says so');
    const answer = await r.run(edge(), { path: '/api/devices', method: 'GET' });
    assert.equal(answer.ok, true, 'reads keep working');
  } finally { cleanup(db); }
});

test('the worker opens the database READ-ONLY', () => {
  /*
   * ⚠️ Makes "the read path cannot write" a property of the file descriptor rather than of the code
   * above it: a bug in a projection produces SQLITE_READONLY instead of a silent mutation on a
   * customer's server.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'read-worker.js'), 'utf8');
  assert.match(src, /new Database\(workerData\.dbPath, \{ readonly: true \}\)/);
});

test('⚠️ the platform is not sniffed — the capability is TRIED', () => {
  /*
   * BrightSign runs a patched Node whose capabilities do not follow from its version, so a check
   * like "is this BrightSign" is wrong in both directions the moment either side changes: a future
   * OS that gains workers stays slow forever, and a platform nobody thought of crashes.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'read-runner.js'), 'utf8');
  /*
   * ⚠️ Comments stripped first. The file EXPLAINS why it does not sniff, and naming the platform in
   * that explanation would fail a test asserting the platform is not named — which is how a correct
   * guard gets deleted for being "wrong".
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /brightsign|BrightSign|process\.platform ===/, 'no platform sniffing');
  assert.match(src, /require\('node:worker_threads'\)/);
  assert.match(src, /require\('worker_threads'\)/, 'and the unprefixed name is tried too');
  assert.match(src, /catch \(e\) \{[\s\S]{0,400}mode = 'inline'/,
    'constructing one either works or it does not');
});

/*
 * ⚠️ WHY A SCREEN IS MISBEHAVING — and how little of it travels.
 *
 * An MSP could see that a customer's screen was unhealthy and had no way to ask why, which is the
 * difference between fixing it from a desk and driving to the site. But a player's debug payload is
 * whatever the page serialised: a widget's response body, a signed URL, text an operator typed into
 * a slide. Sending it upward because it is "diagnostics" would hand a third party the contents of a
 * customer's screen under a grant that says "why something went wrong".
 */
test('⚠️ a debug read needs the diagnostics grant, not health', () => {
  const readProxy = require('../lib/mesh/read-proxy');
  const path = '/api/devices/dev-1/debug';
  assert.equal(readProxy.authorize({}, path, 'GET', ['health', 'identity']).ok, false,
    'health says whether a screen is alive; it does not open its logs');
  assert.equal(readProxy.authorize({}, path, 'GET', ['diagnostics']).ok, true);
  // And it stays a READ — the allowlist must never admit a write to this path.
  assert.equal(readProxy.authorize({}, path, 'POST', ['diagnostics']).ok, false);
});

test('⚠️ the error payload is summarised, and the query string never travels', () => {
  const db = freshDb();
  try {
    // d1 already exists in this fixture, in the workspace the edge can see.
    db.prepare(`INSERT INTO player_debug_logs (device_id, ip, user_agent, url, error_fingerprint, error_data, context, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('d1', '10.0.0.5', 'Chrome',
           'https://site.example/widget/render?token=SECRET-abc123&id=9',
           'fp-1',
           JSON.stringify({ message: 'Failed to fetch', stack: 'x', body: 'CUSTOMER CONTENT' }),
           JSON.stringify({ note: 'private' }), NOW);

    const withDiag = edge({
      grant_categories: JSON.stringify(['health', 'identity', 'diagnostics']),
    });
    const out = nodeData.answerRead(db, withDiag, { path: '/api/devices/d1/debug', method: 'GET' });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.rows.length, 1);
    const r = out.rows[0];

    assert.equal(r.message, 'Failed to fetch', 'the message is what support needs');
    assert.equal(r.fingerprint, 'fp-1', 'and the fingerprint, so repeats group');

    const asSent = JSON.stringify(r);
    assert.ok(!asSent.includes('SECRET-abc123'), 'the query string must not travel');
    assert.ok(!asSent.includes('CUSTOMER CONTENT'), 'nor the error body');
    assert.ok(!asSent.includes('private'), 'nor the context blob');
    assert.match(r.where, /\/widget\/render$/, 'which widget IS the useful half');
  } finally { cleanup(db); }
});

test('a screen in a workspace this edge cannot see has no debug either', () => {
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO player_debug_logs (device_id, url, error_fingerprint, error_data, created_at)
                VALUES ('d2','https://x/y','fp-2','{"message":"nope"}',?)`).run(NOW);
    const scoped = edge({
      grant_categories: JSON.stringify(['health', 'diagnostics']),
      shared_workspaces: JSON.stringify(['w1']),      // d2 lives in w2
    });
    const out = nodeData.answerRead(db, scoped, { path: '/api/devices/d2/debug', method: 'GET' });
    assert.equal(out.ok, false, 'the workspace scope applies to diagnostics like everything else');
  } finally { cleanup(db); }
});
