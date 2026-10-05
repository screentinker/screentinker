'use strict';

/*
 * Head office local slots (Stage B), against the REAL server: slots, the stores' content that fills
 * them, the per-store composition each screen plays, the redirects that put "add to this screen"
 * into the slot, the limits, and every slot_id duty (discard, restore, export/import). Screens are
 * checked through what they would actually be sent (GET /api/devices/:id/preview-payload builds the
 * same payload a player receives).
 *
 * Cast (one org, "Acme"): admin = org owner (author + admin); hqed = HQ editor, NOT an author;
 * store / store2 = editors of "Store 1". Head office's playlist P plays org-wide.
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - routes/playlists.js discard: drop slot_id from the INSERT     -> "remove a slot, then discard ..."
 *   - routes/playlists.js publishPlaylist: drop fills.judgePublish  -> "fill limits ... at publish"
 *   - routes/assignments.js POST /device/:id: drop the redirectAdd branch -> "slots: only corporate authors ..."
 *       (the store's add reaches the Stage A path and is no longer CORPORATE_NO_SLOT) and every redirect test after it
 *   - ws/deviceSocket.js: read published_snapshot instead of compositionFor -> "publishing the slot content ..."
 *   - lib/revisions.js restore: drop slot_id from the INSERT        -> "revision restore brings a removed slot back"
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

let P, SLOT, hqContent, hqFallback, hqLive, sA, sB, sC, sD, sVideo, sLive, ownPl, dev, dev2, dev3, FILL, WSFILL_ID;

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-slots-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  await register('plat');
  await register('admin');
  await register('hqed');
  await register('store');
  await register('store2');
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID(); OTHER_STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', OTHER_STORE, ORG, 'Store 2', 'store-2');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", HQ, U.hqed.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store2.id);

  hqContent = mkContent(HQ, 'brand.png');
  hqFallback = mkContent(HQ, 'fallback.png');
  hqLive = mkContent(HQ, 'live.m3u8', 'video/hls', null);
  sA = mkContent(STORE, 'a.png'); sB = mkContent(STORE, 'b.png'); sC = mkContent(STORE, 'c.png'); sD = mkContent(STORE, 'd.png');
  sVideo = mkContent(STORE, 'long.mp4', 'video/mp4', 600);
  sLive = mkContent(STORE, 'tv.m3u8', 'video/hls', null);
  dev = mkDevice(STORE, 'Till');
  dev2 = mkDevice(STORE, 'Window');
  dev3 = mkDevice(OTHER_STORE, 'Other till');
  const own = await api('/api/playlists', J('store', { name: 'Store own' }, 'POST', STORE));
  ownPl = own.body.id;

  let r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/playlists', J('admin', { name: 'Brand loop' }, 'POST', HQ));
  P = r.body.id;
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 10 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { target_kind: 'org', target_id: ORG, playlist_id: P }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const slotItem = () => q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND slot_id = ?', P, SLOT);

/* ── slots ──────────────────────────────────────────────────────────────────────────────────── */

test('slots: only corporate authors add them; limits are validated; a live fallback is refused', async () => {
  let r = await api(`/api/corporate/playlists/${P}/slots`, J('hqed', { name: 'Promo' }, 'POST', HQ));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_AUTHOR_REQUIRED');
  r = await api(`/api/corporate/playlists/${P}/slots`, J('store', { name: 'Promo' }, 'POST', STORE));
  assert.equal(r.status, 403);
  r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo', max_items: 0 }, 'POST', HQ));
  assert.equal(r.status, 400);
  r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo', fallback_content_id: hqLive }, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIVE');
  r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo', help_text: 'Your weekly offer', max_items: 3, max_total_sec: 60, fallback_content_id: hqFallback }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  SLOT = r.body.id;
  assert.equal(r.body.live, false, 'a new slot is live only after head office publishes');
  assert.ok(slotItem(), 'placed in the corporate draft');
  assert.equal(q1('SELECT status FROM playlists WHERE id = ?', P).status, 'draft');
  // Not live yet: a store adding to its screen still has nowhere to put it.
  r = await api(`/api/assignments/device/${dev}`, J('store', { content_id: sA }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_NO_SLOT');
});

test('publish: the composable keeps the slot, the snapshot shows the fallback, screens play the fallback', async () => {
  const revBefore = q1('SELECT published_rev FROM playlists WHERE id = ?', P).published_rev;
  const r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = q1('SELECT published_snapshot, published_composable, published_rev FROM playlists WHERE id = ?', P);
  assert.ok(row.published_composable.includes(`"__slot":"${SLOT}"`));
  assert.ok(!row.published_snapshot.includes('__slot'), 'a corporate playlist\'s own snapshot never holds a marker');
  assert.ok(row.published_snapshot.includes(hqFallback));
  assert.ok(row.published_rev > revBefore, 'published_rev moves on publish');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, hqFallback]);
  assert.deepEqual(await plays('admin', dev3, OTHER_STORE), [hqContent, hqFallback]);
});

test('device add redirects into the slot (workspace level), never into head office\'s playlist', async () => {
  const before = itemsOf(P);
  let r = await api(`/api/assignments/device/${dev}`, J('store', { content_id: sA }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.redirected_to.scope_kind, 'workspace');
  assert.equal(r.body.redirected_to.scope_label, 'Everyone in "Store 1"');
  assert.equal(r.body.redirected_to.slot_name, 'Promo');
  assert.equal(r.body.redirected_to.created, true);
  assert.equal(r.body.redirected_to.screens, 2, 'both Store 1 screens');
  FILL = r.body.redirected_to.fill_playlist_id;
  WSFILL_ID = r.body.redirected_to.fill_id;
  assert.equal(itemsOf(P), before, 'head office\'s playlist is untouched');
  assert.equal(q1('SELECT workspace_id FROM playlists WHERE id = ?', FILL).workspace_id, STORE);
  r = await api(`/api/assignments/device/${dev2}`, J('store', { content_id: sB }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.redirected_to.fill_playlist_id, FILL, 'the second add lands in the same content');
  assert.equal(r.body.redirected_to.created, false);
  // A draft: nothing changes on screen until it is published.
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, hqFallback]);
  // A nested playlist never goes into a slot.
  r = await api(`/api/assignments/device/${dev}`, J('store', { child_playlist_id: ownPl }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_FLAT');
});

test('publishing the slot content puts it on every screen that plays it, and only those', async () => {
  const r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB]);
  assert.deepEqual(await plays('store', dev2, STORE), [hqContent, sA, sB]);
  assert.deepEqual(await plays('admin', dev3, OTHER_STORE), [hqContent, hqFallback], 'another store keeps the fallback');
  const pl = await get('store', '/api/playlists', STORE);
  const badge = pl.body.find((p) => p.id === FILL);
  assert.equal(badge.corporate_slot.slot_name, 'Promo', 'the store\'s list badges it "Your slot"');
});

test('the device page knows, before adding, which slot and level "Add content" lands in', async () => {
  const r = await get('store', `/api/devices/${dev}`, STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.corporate;
  assert.equal(c.slots.length, 1);
  assert.equal(c.slots[0].name, 'Promo');
  assert.equal(c.slots[0].limits.max_items, 3);
  assert.equal(c.slots[0].fill.scope_kind, 'workspace');
  assert.equal(c.slots[0].fill.playing, true);
  assert.equal(c.slots[0].own, false);
  assert.deepEqual(c.items.map((i) => [i.origin, i.locked]), [['corporate', true], ['slot', false], ['slot', false]]);
});

test('fill limits: count, seconds (a video at its real length), live, flat — at add, and at publish', async () => {
  let r = await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sVideo }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT', 'a 600 s video does not fit 60 s');
  r = await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sLive, duration_sec: 30 }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIVE');
  r = await api(`/api/playlists/${FILL}/items`, J('store', { child_playlist_id: ownPl }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_FLAT');
  r = await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sC, duration_sec: 10 }, 'POST', STORE));
  assert.equal(r.status, 201, 'three items, 30 s: within the limits');
  r = await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sD, duration_sec: 10 }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT');
  assert.match(r.body.error, /up to 3 items and 60 seconds/);
  r = await api(`/api/playlists/${FILL}/items/bulk`, J('store', { content_ids: [sD] }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT');
  r = await api(`/api/playlists/${FILL}/items/selection`, J('store', { action: 'paste', items: [{ content_id: sD, duration_sec: 10 }] }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT');
  r = await api(`/api/playlists/${FILL}/items/selection`, J('store', { action: 'paste', items: [{ child_playlist_id: ownPl }] }, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_FLAT');
  r = await api(`/api/playlists/${FILL}`, J('store', { smart_rules: { match: 'all', rules: [] } }, 'PUT', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_FLAT', 'slot content is never a smart playlist');
  // The authoritative check is at publish: a row some other path wrote is caught there.
  run('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 99, 10)', FILL, sD);
  const snap = q1('SELECT published_snapshot FROM playlists WHERE id = ?', FILL).published_snapshot;
  r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'FILL_LIMIT');
  assert.equal(q1('SELECT published_snapshot FROM playlists WHERE id = ?', FILL).published_snapshot, snap, 'nothing went live');
  run('DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sD);
  r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC]);
});

test('⚠️ approvals: an over-limit fill approved by a reviewer is still refused at release (FILL_LIMIT)', async () => {
  let r = await api('/api/approvals/settings', J('admin', { require_approval: true, reviewers: [U.store2.id] }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  run('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 99, 10)', FILL, sD);
  run("UPDATE playlists SET status = 'draft' WHERE id = ?", FILL);
  r = await api('/api/approvals/submit', J('store', { resource_type: 'playlist', resource_id: FILL }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sub = r.body.id || (r.body.submission && r.body.submission.id);
  r = await api(`/api/approvals/${sub}/approve`, J('store2', {}, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/approvals/${sub}/publish`, J('store2', {}, 'POST', STORE));
  assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'FILL_LIMIT');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC], 'screens unchanged');
  run('DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sD);
  run("UPDATE playlists SET status = 'published' WHERE id = ?", FILL);
  await api('/api/approvals/settings', J('admin', { require_approval: false }, 'PUT', STORE));
});

test('"Only this screen": fill_scope device copies the content, then diverges; DELETE the fill reverts', async () => {
  const itemA = q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sA).id;
  let r = await api(`/api/assignments/${itemA}?device_id=${dev}&fill_scope=device`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.edited_fill.scope_kind, 'device');
  assert.equal(r.body.edited_fill.screens, 1);
  const own = r.body.edited_fill.fill_playlist_id;
  assert.notEqual(own, FILL);
  assert.equal(q('SELECT * FROM playlist_items WHERE playlist_id = ?', FILL).length, 3, 'the shared content is untouched');
  // The copy carried the published snapshot, so nothing changed on screen yet.
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC]);
  r = await api(`/api/playlists/${own}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sB, sC]);
  assert.deepEqual(await plays('store', dev2, STORE), [hqContent, sA, sB, sC], 'the other screen keeps the shared content');
  // Editing the shared content without fill_scope says where the edit lands.
  const itemB = q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sB).id;
  r = await api(`/api/assignments/${itemB}`, J('store', { device_id: dev2, duration_sec: 12 }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.edited_fill.scope_kind, 'workspace');
  // "Use Everyone in Store 1's again"
  const fillId = q1('SELECT id FROM corporate_slot_fills WHERE fill_playlist_id = ?', own).id;
  r = await api(`/api/corporate/fills/${fillId}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.playlist_deleted, true);
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC]);
  assert.equal(q1('SELECT 1 AS x FROM playlists WHERE id = ?', own), undefined);
});

test('head office lowers the limit: over-limit content stops playing, the store is told, fixing it brings it back', async () => {
  let r = await api(`/api/corporate/slots/${SLOT}`, J('admin', { max_items: 2 }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await get('admin', `/api/corporate/slots/${SLOT}/impact?max_items=2`, HQ);
  assert.equal(r.status, 200);
  assert.equal(r.body.stores, 1);
  assert.equal(r.body.over[0].scope_kind, 'workspace');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB, sC], 'slot settings wait for the corporate publish');
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q1('SELECT fill_state FROM corporate_slot_fills WHERE id = ?', WSFILL_ID).fill_state, 'over_limit');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, hqFallback], 'not truncated: the fallback plays');
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.fill.over_limit' AND workspace_id = ?", STORE), 'the store\'s activity says so');
  r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'FILL_LIMIT');
  const itemC = q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sC).id;
  r = await api(`/api/playlists/${FILL}/items/${itemC}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200);
  r = await api(`/api/playlists/${FILL}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q1('SELECT fill_state FROM corporate_slot_fills WHERE id = ?', WSFILL_ID).fill_state, 'ok');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB]);
  // Raise it again for what follows.
  await api(`/api/corporate/slots/${SLOT}`, J('admin', { max_items: 5 }, 'PUT', HQ));
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200);
});

test('slot rows in the editor: swap, delete, duplicate, dayparts and an interval are refused', async () => {
  const before = itemsOf(P);
  const id = slotItem().id;
  let r = await api(`/api/playlists/${P}/items/${id}`, J('admin', { content_id: hqContent }, 'PUT', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_SWAP');
  r = await api(`/api/playlists/${P}/items/${id}`, J('admin', { repeat_every_sec: 60 }, 'PUT', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_REPEAT');
  r = await api(`/api/playlists/${P}/items/${id}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_REMOVE');
  r = await api(`/api/playlists/${P}/items/${id}/duplicate`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_DUPLICATE');
  r = await api(`/api/playlists/${P}/items/${id}/schedules`, J('admin', { blocks: [{ days: [1], start: '09:00', end: '10:00' }] }, 'PUT', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_SCHEDULE');
  r = await api(`/api/playlists/${P}/items/selection`, J('admin', { action: 'delete', ids: [id] }, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_REMOVE');
  r = await api(`/api/playlists/${P}/items/selection`, J('admin', { action: 'duplicate', ids: [id] }, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_DUPLICATE');
  assert.equal(itemsOf(P), before, 'nothing changed');
  r = await get('admin', `/api/playlists/${P}`, HQ);
  assert.equal(r.body.items.find((it) => it.slot_id === SLOT).slot.name, 'Promo', 'the editor gets the slot to draw');
  r = await api(`/api/corporate/playlists/${P}/demote`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 409);
});

test('remove a slot, then discard: the slot comes back with its stores\' content (slot_id survives discard)', async () => {
  let r = await api(`/api/corporate/slots/${SLOT}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(slotItem(), undefined, 'placement removed from the draft');
  assert.ok(q1('SELECT retired_at FROM corporate_slots WHERE id = ?', SLOT).retired_at, 'retired, not deleted');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB], 'live until published');
  r = await api(`/api/playlists/${P}/discard`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(slotItem(), 'the slot row is back, as a slot');
  assert.equal(q1('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND content_id IS NULL AND widget_id IS NULL AND child_playlist_id IS NULL AND slot_id IS NULL', P).n, 0, 'no ghost rows');
  assert.equal(q1('SELECT retired_at FROM corporate_slots WHERE id = ?', SLOT).retired_at, null);
  assert.ok(q1('SELECT 1 AS x FROM corporate_slot_fills WHERE id = ?', WSFILL_ID), 'stores\' content still attached');
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB]);
});

test('revision restore brings a removed slot back', async () => {
  const revs = await get('admin', `/api/revisions/playlist/${P}`, HQ);
  assert.equal(revs.status, 200, JSON.stringify(revs.body));
  let r = await api(`/api/corporate/slots/${SLOT}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200);
  assert.equal(slotItem(), undefined);
  // The newest revision before the removal holds the slot.
  const withSlot = revs.body.revisions[0];
  r = await api(`/api/revisions/playlist/${P}/${withSlot.id}/restore`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(slotItem(), 'restored as a slot row');
  assert.equal(q1('SELECT retired_at FROM corporate_slots WHERE id = ?', SLOT).retired_at, null);
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB]);
});

test('a revision whose slot no longer exists says so (dropped) instead of skipping it silently', async () => {
  let r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Seasonal' }, 'POST', HQ));
  assert.equal(r.status, 201);
  const S3 = r.body.id;
  const revs = await get('admin', `/api/revisions/playlist/${P}`, HQ);
  const withS3 = revs.body.revisions[0];
  r = await api(`/api/corporate/slots/${S3}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200);
  run('DELETE FROM corporate_slots WHERE id = ?', S3);   // what the hourly sweep does to an unreachable retired slot
  r = await api(`/api/revisions/playlist/${P}/${withS3.id}/restore`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.dropped, [{ slot_id: S3, slot_name: 'Seasonal' }]);
  assert.ok(slotItem(), 'the slot that still exists came back');
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('group add-content puts mandated members\' item in the GROUP-level slot content, copied from the workspace\'s', async () => {
  const G = crypto.randomUUID();
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', G, U.admin.id, STORE, 'Windows');
  run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', dev2, G);
  const before = itemsOf(P);
  const r = await api(`/api/groups/${G}/assign-content`, J('store', { content_id: sD }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added_to_slots.length, 1);
  assert.equal(r.body.added_to_slots[0].scope_kind, 'group');
  assert.equal(itemsOf(P), before, 'never inserted into head office\'s playlist');
  const gfill = r.body.added_to_slots[0].fill_playlist_id;
  assert.deepEqual(q('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order', gfill).map((x) => x.content_id), [sA, sB, sD]);
  const pub = await api(`/api/playlists/${gfill}/publish`, J('store', {}, 'POST', STORE));
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual(await plays('store', dev2, STORE), [hqContent, sA, sB, sD]);
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB], 'the till is not in the group');
});

test('a store deleting content its slot content plays: scrubbed, rev moved, the screen pushed the shorter loop', async () => {
  const gfill = q1("SELECT f.fill_playlist_id FROM corporate_slot_fills f WHERE f.scope_kind = 'group' AND f.workspace_id = ?", STORE).fill_playlist_id;
  const rev = q1('SELECT published_rev FROM playlists WHERE id = ?', gfill).published_rev;
  assert.deepEqual(await plays('store', dev2, STORE), [hqContent, sA, sB, sD]);
  const r = await api(`/api/content/${sD}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(q1('SELECT published_rev FROM playlists WHERE id = ?', gfill).published_rev > rev, 'the fill\'s published_rev moved');
  assert.equal(q1('SELECT COUNT(*) AS n FROM corporate_compositions WHERE snapshot LIKE ?', `%${sD}%`).n, 0);
  assert.deepEqual(await plays('store', dev2, STORE), [hqContent, sA, sB]);
});

test('mute on a store item reaches the composed loop', async () => {
  const itemB = q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?', FILL, sB).id;
  const r = await api(`/api/assignments/${itemB}`, J('store', { muted: true }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let p = await get('store', `/api/devices/${dev}/preview-payload`, STORE);
  assert.equal(p.body.assignments.find((a) => a.content_id === sB).muted, 1);
  // And on head office's own item: the composable is patched, so every store's composition follows.
  const hqItem = q1('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?', P, hqContent).id;
  const m = await api(`/api/playlists/${P}/items/${hqItem}`, J('admin', { muted: true }, 'PUT', HQ));
  assert.equal(m.status, 200, JSON.stringify(m.body));
  p = await get('store', `/api/devices/${dev}/preview-payload`, STORE);
  assert.equal(p.body.assignments.find((a) => a.content_id === hqContent).muted, 1);
  p = await get('admin', `/api/devices/${dev3}/preview-payload`, OTHER_STORE);
  assert.equal(p.body.assignments.find((a) => a.content_id === hqContent).muted, 1);
});

test('preview a screen: items tagged by origin; draft=1 is head office\'s; the fill draft preview splices the store\'s draft', async () => {
  let r = await get('store', `/api/corporate/preview?device_id=${dev}`, STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.tag), ['corporate', 'slot', 'slot']);
  assert.equal(r.body.items[1].slot_name, 'Promo');
  assert.equal(r.body.items[1].level_label, 'Everyone in "Store 1"');
  assert.equal(r.body.slots[0].outcome, 'fill');
  r = await get('admin', `/api/corporate/preview?device_id=${dev3}`, HQ);
  assert.deepEqual(r.body.items.map((i) => i.tag), ['corporate', 'fallback']);
  r = await get('store', `/api/corporate/preview?device_id=${dev}&draft=1`, STORE);
  assert.equal(r.status, 403);
  r = await get('admin', `/api/corporate/preview?device_id=${dev}&draft=1`, HQ);
  assert.equal(r.status, 200); assert.equal(r.body.draft, true);
  // Fill draft preview: add to the draft, preview shows it, the screen does not.
  await api(`/api/playlists/${FILL}/items`, J('store', { content_id: sC, duration_sec: 10 }, 'POST', STORE));
  r = await get('store', `/api/corporate/fills/${WSFILL_ID}/preview?device_id=${dev}`, STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.content_id), [hqContent, sA, sB, sC]);
  assert.equal(r.body.draft_totals.items, 3);
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA, sB]);
  // Another store cannot preview this store's content.
  r = await get(U.store2.token, `/api/corporate/fills/${WSFILL_ID}/preview?device_id=${dev3}`, STORE);
  assert.equal(r.status, 400, 'a screen outside the content\'s level is refused');
});

test('store face and the compliance report', async () => {
  let r = await get('store', '/api/corporate/store', STORE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mandates[0].playlist_id, P);
  assert.equal(r.body.mandates[0].screens, 2);
  assert.equal(r.body.slots[0].name, 'Promo');
  assert.ok(r.body.slots[0].fills.some((f) => f.scope_kind === 'workspace' && f.screens >= 1));
  r = await get('store', '/api/corporate/reports/slots', STORE);
  assert.equal(r.status, 403);
  r = await get('admin', '/api/corporate/reports/slots', HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s1 = r.body.rows.find((x) => x.workspace_id === STORE);
  const s2 = r.body.rows.find((x) => x.workspace_id === OTHER_STORE);
  assert.equal(s1.state, 'filled');
  assert.equal(s2.state, 'fallback');
  r = await get('admin', '/api/corporate/reports/slots?problems=1', HQ);
  assert.deepEqual(r.body.rows.map((x) => x.workspace_id), [OTHER_STORE]);
  r = await get('admin', '/api/corporate/reports/slots?format=csv', HQ);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /Promo/);
  const now = Math.floor(Date.now() / 1000);
  run('INSERT INTO play_logs (device_id, content_id, content_name, started_at, duration_sec, workspace_id) VALUES (?, ?, ?, ?, 10, ?)', dev, hqContent, 'brand', now - 60, STORE);
  r = await get('admin', '/api/corporate/reports/plays', HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.workspaces.find((w) => w.workspace_id === STORE).plays, 1);
  assert.equal(r.body.playlists.find((p) => p.playlist_id === P).plays, 1);
});

test('export carries corporate playlists and slots; import outside head office turns slots into their fallback', async () => {
  const dump = await (await fetch(`${BASE}/api/status/export?token=${U.admin.token}`)).json();
  const exp = dump.playlists.find((p) => p.id === P);
  assert.equal(exp.corporate, 1);
  assert.ok(dump.playlist_items.some((pi) => pi.playlist_id === P && pi.slot_id === SLOT));
  assert.ok(dump.corporate_slots.some((sl) => sl.id === SLOT));
  assert.equal(dump.corporate.organization_id, ORG);
  assert.ok(dump.corporate.mandates_not_exported >= 1, 'what does not travel is said');
  // Into another org's workspace: an ordinary playlist; the slot becomes its fallback.
  let r = await api('/api/status/import', J('store', dump));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.stats.converted_slots >= 1, JSON.stringify(r.body.stats));
  assert.equal(q1("SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ? AND corporate = 1", U.store.ws).n, 0);
  // Back into head office while the original still places the slot: a NEW slot id (the stores'
  // content stays with the playlist that plays).
  r = await api('/api/status/import', J('admin', dump));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stats.slots_remapped, 1, JSON.stringify(r.body.stats));
  assert.equal(q1('SELECT playlist_id FROM corporate_slots WHERE id = ?', SLOT).playlist_id, P, 'the original slot is untouched');
  // After head office removes the slot, a same-org re-import keeps its id and its stores' content.
  await api(`/api/corporate/slots/${SLOT}`, J('admin', undefined, 'DELETE', HQ));
  r = await api('/api/status/import', J('admin', dump));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stats.slots_kept, 1, JSON.stringify(r.body.stats));
  assert.ok(r.body.stats.fills_rebound >= 1);
  const moved = q1('SELECT playlist_id FROM corporate_slots WHERE id = ?', SLOT).playlist_id;
  assert.notEqual(moved, P);
  assert.equal(q1('SELECT corporate FROM playlists WHERE id = ?', moved).corporate, 1);
  assert.ok(q1('SELECT 1 AS x FROM playlist_items WHERE playlist_id = ? AND slot_id = ?', moved, SLOT));
});

test('deleting a store\'s slot content playlist falls its screens back', async () => {
  // Put a fresh slot back on P so the store has something to delete.
  let r = await api(`/api/corporate/playlists/${P}/slots`, J('admin', { name: 'Promo 2', fallback_content_id: hqFallback }, 'POST', HQ));
  assert.equal(r.status, 201);
  const s2 = r.body.id;
  await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  r = await api(`/api/corporate/slots/${s2}/fills`, J('store', { scope_kind: 'workspace', scope_id: STORE }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api(`/api/corporate/slots/${s2}/fills`, J('store', { scope_kind: 'workspace', scope_id: STORE }, 'POST', STORE));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_FILL_EXISTS');
  const pl = r.body.fill.fill_playlist_id;
  await api(`/api/playlists/${pl}/items`, J('store', { content_id: sA, duration_sec: 10 }, 'POST', STORE));
  await api(`/api/playlists/${pl}/publish`, J('store', {}, 'POST', STORE));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, sA]);
  r = await api(`/api/playlists/${pl}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await plays('store', dev, STORE), [hqContent, hqFallback]);
  // A store cannot fill a slot for another store's workspace.
  r = await api(`/api/corporate/slots/${s2}/fills`, J('store', { scope_kind: 'workspace', scope_id: OTHER_STORE }, 'POST', STORE));
  assert.equal(r.status, 403);
});

test('re-pointing a level at another store playlist; a nested one is refused', async () => {
  const s2 = q1("SELECT id FROM corporate_slots WHERE playlist_id = ? AND name = 'Promo 2'", P).id;
  const made = await api(`/api/corporate/slots/${s2}/fills`, J('store', { scope_kind: 'workspace', scope_id: STORE }, 'POST', STORE));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const fills = [{ id: made.body.id }];
  const nested = await api('/api/playlists', J('store', { name: 'Has a child' }, 'POST', STORE));
  await api(`/api/playlists/${nested.body.id}/items`, J('store', { child_playlist_id: ownPl }, 'POST', STORE));
  let r = await api(`/api/corporate/fills/${fills[0].id}`, J('store', { fill_playlist_id: nested.body.id }, 'PUT', STORE));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const flat = await api('/api/playlists', J('store', { name: 'Flat offer' }, 'POST', STORE));
  r = await api(`/api/corporate/fills/${fills[0].id}`, J('store', { fill_playlist_id: flat.body.id }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fill_playlist_id, flat.body.id);
  // A head office editor who is not a member of the store cannot re-point the store's content.
  r = await api(`/api/corporate/fills/${fills[0].id}`, J('hqed', { fill_playlist_id: flat.body.id }, 'PUT', HQ));
  assert.equal(r.status, 403);
});

test('deleting head office\'s fallback content scrubs it from the composable and every composition', async () => {
  const before = await plays('admin', dev3, OTHER_STORE);
  assert.ok(before.includes(hqFallback));
  const r = await api(`/api/content/${hqFallback}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q1('SELECT COUNT(*) AS n FROM playlists WHERE published_composable LIKE ?', `%${hqFallback}%`).n, 0);
  assert.equal(q1('SELECT COUNT(*) AS n FROM corporate_compositions WHERE snapshot LIKE ?', `%${hqFallback}%`).n, 0);
  assert.deepEqual(await plays('admin', dev3, OTHER_STORE), [hqContent], 'the slot is now skipped there');
});

test('backstop tripwire: no actorless write inside an HTTP request in this whole run', () => {
  assert.ok(!fs.readFileSync(LOG, 'utf8').includes('backstop: write with no actor'), 'the tripwire fired');
});
