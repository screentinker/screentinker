'use strict';

/*
 * Review fixes for head office playlists, against the REAL server (same harness as
 * corporate-slots-routes.test.js):
 *
 *   - a store's "play every N" on its slot content: published unwoven, so the slot limits count the
 *     store's real items and head office's airtime split holds
 *   - a full slot refuses an add with add-time words ("wasn't added"), not the publish-time ones
 *   - demote -> ordinary publish -> promote leaves no stale published_composable behind
 *   - a rollback to an older version that publishes, then an upgrade: the boot reconcile republishes
 *     head office's playlist and the composition cache notices the store's republish
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - routes/playlists.js buildSnapshotItems: drop the fill no-weave branch -> "a store's \"play every N\" ..."
 *   - lib/corporate/fills.js assertCanAdd: drop { at: 'add' }               -> "a slot that is full ..."
 *   - BOTH routes/playlists.js publishPlaylist writing the composable only when corporate AND
 *     routes/corporate.js demote keeping published_composable (either alone holds) -> "demote, republish ..."
 *   - server.js: drop the reconcileAtBoot call                              -> "after another server version ..."
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
const U = {};
let ORG, HQ, STORE, OTHER_STORE;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

function J(who, body, method = 'POST', ws) {
  const h = { 'Content-Type': 'application/json' };
  if (who) h.Authorization = `Bearer ${U[who] ? U[who].token : who}`;
  if (ws) h['X-Workspace-Id'] = ws;
  return { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}
const get = (who, p, ws) => api(p, J(who, undefined, 'GET', ws));

async function register(name) {
  const r = await api('/api/auth/register', J(null, { email: `${name}-${Date.now()}@acme.test`, password: 'Passw0rd123', name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
  return U[name];
}

const mkContent = (ws, name, mime = 'image/png', dur = 10) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, id, U.admin.id, ws, name, `${name}`, mime, dur);
  return id;
};
const mkDevice = (ws, name) => {
  const id = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)', id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6));
  return id;
};
const itemsOf = (pl) => JSON.stringify(q('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY id', pl));
async function plays(who, dev, ws) {
  const r = await get(who, `/api/devices/${dev}/preview-payload`, ws);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('__slot'), 'a slot marker reached a player payload');
  assert.ok(!text.includes('__origin_ws'), 'the origin tag reached a player payload');
  return (r.body.assignments || []).map((a) => a.content_id || a.widget_id);
}


let P, SLOT, FILL, hqContent, hq2, sA, sB, sC, sD, oldX, newY, dev, dev3;

async function boot() {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* */ }
    await sleep(250);
  }
  throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
}
async function stop() {
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  try { proc.kill('SIGKILL'); } catch { /* */ }
}

before(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-review-'));
  LOG = path.join(DATA_DIR, 'server.log');
  await boot();
  await register('plat');
  await register('admin');
  await register('store');
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID(); OTHER_STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', OTHER_STORE, ORG, 'Store 2', 'store-2');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);
  hqContent = mkContent(HQ, 'brand.png'); hq2 = mkContent(HQ, 'brand2.png');
  oldX = mkContent(HQ, 'old-x.png'); newY = mkContent(HQ, 'new-y.png');
  sA = mkContent(STORE, 'a.png'); sB = mkContent(STORE, 'b.png'); sC = mkContent(STORE, 'c.png'); sD = mkContent(STORE, 'd.png');
  dev = mkDevice(STORE, 'Till');
  dev3 = mkDevice(OTHER_STORE, 'Other till');

  let r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/playlists', J('admin', { name: 'Brand loop' }, 'POST', HQ));
  P = r.body.id;
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 10 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo', max_items: 3 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  SLOT = r.body.id;
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { target_kind: 'workspace', target_id: STORE, playlist_id: P }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a store\'s "play every N" never weaves its slot content: 3 items publish as 3, within max_items 3', async () => {
  for (const x of [sA, sB, sC]) {
    const r = await api(`/api/assignments/device/${dev}`, J('store', { content_id: x, duration_sec: 10 }, 'POST', STORE));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    FILL = r.body.redirected_to.fill_playlist_id;
  }
  const first = q1('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order LIMIT 1', FILL);
  let r = await api(`/api/playlists/${FILL}/items/${first.id}`, J('store', { repeat_every_sec: 120 }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 200, `the limits count the store's 3 items, not woven copies: ${JSON.stringify(r.body)}`);
  const snap = JSON.parse(q1('SELECT published_snapshot FROM playlists WHERE id = ?', FILL).published_snapshot);
  assert.deepEqual(snap.map((i) => i.content_id), [sA, sB, sC], 'published unwoven');
  assert.ok(snap.every((i) => i.repeat_every_sec === undefined), 'and without the flag');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC]);
});

test('a slot that is full refuses an add with words that fit an add (nothing changed yet)', async () => {
  const r = await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sD, duration_sec: 10 }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT');
  assert.match(r.body.error, /can hold up to 3 items\. Adding this would make 4 items, so it wasn't added\./);
  assert.doesNotMatch(r.body.error, /It now has|publish again/);
  assert.equal(q1('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?', FILL).n, 3);
});

test('demote, republish as ordinary, promote: mandated screens play the NEW loop, not the last corporate one', async () => {
  let r = await api('/api/corporate/playlists', J('admin', { name: 'Seasonal' }, 'POST', HQ));
  const Q = r.body.id;
  const it = await api(`/api/playlists/${Q}/items`, J('admin', { content_id: oldX, duration_sec: 10 }, 'POST', HQ));
  assert.equal(it.status, 201, JSON.stringify(it.body));
  r = await api(`/api/playlists/${Q}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { target_kind: 'workspace', target_id: OTHER_STORE, playlist_id: Q }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const M = r.body.id || (r.body.mandate && r.body.mandate.id);
  assert.deepEqual(await plays('admin', dev3, OTHER_STORE), [oldX]);
  r = await api(`/api/corporate/mandates/${M}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/corporate/playlists/${Q}/demote`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await api(`/api/playlists/${Q}/items/${it.body.id}`, J('admin', undefined, 'DELETE', HQ));
  await api(`/api/playlists/${Q}/items`, J('admin', { content_id: newY, duration_sec: 10 }, 'POST', HQ));
  r = await api(`/api/playlists/${Q}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/corporate/playlists/${Q}/promote`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { target_kind: 'workspace', target_id: OTHER_STORE, playlist_id: Q }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await plays('admin', dev3, OTHER_STORE), [newY], 'not the stale composable from before the demote');
});

test('after another server version published (a rollback), the next boot puts the current loop on screen', async () => {
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC]);
  await stop();
  // What an older version does on the same database: items and published_snapshot change;
  // published_rev, published_composable and the composition cache are left alone.
  const db = dbh();
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(P).n;
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, 10)').run(P, hq2, n + 5);
    db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
      .run(JSON.stringify([{ content_id: hqContent, duration_sec: 10 }, { content_id: null, duration_sec: 10 }, { content_id: hq2, duration_sec: 10 }]), P);
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?').run(FILL, sC);
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 9, 10)').run(FILL, sD);
    db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
      .run(JSON.stringify([sA, sB, sD].map((c, i) => ({ content_id: c, duration_sec: 10, sort_order: i }))), FILL);
  } finally { db.close(); }
  await boot();
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sD, hq2], 'both head office\'s and the store\'s new content play');
  assert.match(fs.readFileSync(LOG, 'utf8'), /"Brand loop" .* was published by another server version; republished/);
});
