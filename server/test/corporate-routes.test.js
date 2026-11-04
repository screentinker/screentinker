'use strict';

/*
 * Head office (corporate) playlists, Stage A, against the REAL server: settings, corporate
 * playlists, "Where it plays" (mandates), and every override / bypass of a mandated screen that the
 * spec (§4.3, §4.4, §4.6, D13) closes — each asserted as the documented status + code AND, where it
 * is a write, the database unchanged afterwards.
 *
 * Cast (one org, "Acme"):
 *   plat   platform admin (first registered user)
 *   admin  org owner of Acme — a corporate author and admin
 *   hqed   workspace_editor in Acme's HQ workspace, NOT an author (corporate_authors = org_admins)
 *   store  workspace_editor in Acme's "Store 1" workspace — a store manager
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - routes/playlists.js loadPlaylistAccess: drop the assertPlaylistWritable call -> "a non-author HQ editor ..."
 *   - routes/playlists.js publishPlaylist: drop corpGuard.assertCanPublish        -> "⚠️ approvals publish ..."
 *   - ws/deviceSocket.js: drop `if (corporateSource) default_content = null`         -> "a dark mandate ..."
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
const U = {};          // name -> { token, id }
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
  return { status: r.status, body };
}
const get = (who, p, ws) => api(p, J(who, undefined, 'GET', ws));

async function register(name) {
  const r = await api('/api/auth/register', J(null, { email: `${name}-${Date.now()}@acme.test`, password: 'Passw0rd123', name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
  return U[name];
}

const mkContent = (ws, name, mime = 'image/png') => {
  const id = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
       VALUES (?, ?, ?, ?, ?, ?, 10, 1)`, id, U.admin.id, ws, name, `${name}`, mime);
  return id;
};
const mkDevice = (ws, name, extra = '') => {
  const id = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, capabilities) VALUES (?, ?, ?, ?, ?, ?)',
    id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6), JSON.stringify(['display.power', 'system.reboot', 'system.shell']));
  if (extra) run(`UPDATE devices SET ${extra} WHERE id = ?`, id);
  return id;
};
const resolvedOf = (d) => q1('SELECT playlist_id, source, layout_id FROM device_resolved_playlist WHERE device_id = ?', d);
const itemsOf = (pl) => JSON.stringify(q('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY id', pl));

let P, hqContent, storeContent, ownPl, dev, dev2;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-'));
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
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID(); OTHER_STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', OTHER_STORE, ORG, 'Store 2', 'store-2');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", HQ, U.hqed.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);

  hqContent = mkContent(HQ, 'brand.png');
  storeContent = mkContent(STORE, 'offer.png');
  dev = mkDevice(STORE, 'Till screen');
  dev2 = mkDevice(STORE, 'Window screen');
  const own = await api('/api/playlists', J('store', { name: 'Store own' }, 'POST', STORE));
  ownPl = own.body.id;
  await api(`/api/playlists/${ownPl}/items`, J('store', { content_id: storeContent, duration_sec: 10 }, 'POST', STORE));
  await api(`/api/playlists/${ownPl}/publish`, J('store', {}, 'POST', STORE));
  const a = await api(`/api/playlists/${ownPl}/assign`, J('store', { device_id: dev }, 'POST', STORE));
  assert.equal(a.status, 200, JSON.stringify(a.body));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

/* ── settings ───────────────────────────────────────────────────────────────────────────────── */

test('settings: only org owners/admins change them; the HQ workspace must be the org\'s', async () => {
  let r = await api('/api/corporate/settings', J('store', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_ADMIN_REQUIRED');
  r = await api('/api/corporate/settings', J('hqed', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_ADMIN_REQUIRED');
  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 400, 'no HQ yet');
  r = await api('/api/corporate/settings', J('admin', { hq_workspace_id: U.store.ws }, 'PUT', HQ));
  assert.equal(r.status, 400, 'another org\'s workspace cannot be HQ');
  r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'sometimes' }, 'PUT', HQ));
  assert.equal(r.status, 400, 'an unknown store-trigger policy is refused, not silently stored');
  r = await api('/api/corporate/settings', J('admin', { store_trigger_cap_sec: 5 }, 'PUT', HQ));
  assert.equal(r.status, 400, 'the store-trigger cap is 30-3600 s');
  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await get('store', '/api/corporate/settings', STORE);
  assert.equal(r.status, 200);
  assert.equal(r.body.corporate_enabled, true);
  assert.equal(r.body.is_admin, false); assert.equal(r.body.can_author, false);
  assert.equal(r.body.workspaces, undefined, 'the workspace list is for admins');
});

test('/api/corporate is JWT-only: an API token gets 401', async () => {
  const t = await api('/api/tokens', J('admin', { name: 'ci', scope: 'full' }, 'POST', HQ));
  assert.equal(t.status, 201, JSON.stringify(t.body));
  U.adminToken = { token: t.body.token };
  const r = await get('adminToken', '/api/corporate/settings');
  assert.equal(r.status, 401);
});

/* ── corporate playlists ────────────────────────────────────────────────────────────────────── */

test('only an author creates a corporate playlist', async () => {
  let r = await api('/api/corporate/playlists', J('hqed', { name: 'Nope' }, 'POST', HQ));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_AUTHOR_REQUIRED');
  r = await api('/api/corporate/playlists', J('admin', { name: 'Brand loop' }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  P = r.body.id;
  assert.equal(q1('SELECT corporate, workspace_id FROM playlists WHERE id = ?', P).workspace_id, HQ);
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 8 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('a non-author HQ editor cannot change a corporate playlist through the playlist routes; rows unchanged', async () => {
  const before = itemsOf(P);
  const plBefore = JSON.stringify(q1('SELECT name, status, published_snapshot FROM playlists WHERE id = ?', P));
  for (const [p, m, b] of [
    [`/api/playlists/${P}/items`, 'POST', { content_id: hqContent, duration_sec: 5 }],
    [`/api/playlists/${P}`, 'PUT', { name: 'pwned' }],
    [`/api/playlists/${P}/publish`, 'POST', {}],
    [`/api/playlists/${P}/items/reorder`, 'POST', { order: [] }],
    [`/api/playlists/${P}`, 'DELETE', undefined],
  ]) {
    const r = await api(p, J('hqed', b, m, HQ));
    assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'CORPORATE_AUTHOR_REQUIRED', `${m} ${p}`);
  }
  // an API token, even the org admin's own
  const r = await api(`/api/playlists/${P}/items`, J('adminToken', { content_id: hqContent, duration_sec: 5 }, 'POST', HQ));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_TOKEN');
  assert.equal(itemsOf(P), before);
  assert.equal(JSON.stringify(q1('SELECT name, status, published_snapshot FROM playlists WHERE id = ?', P)), plBefore);
});

test('a corporate playlist cannot be nested, nor become smart', async () => {
  const host = await api('/api/playlists', J('admin', { name: 'host' }, 'POST', HQ));
  let r = await api(`/api/playlists/${host.body.id}/items`, J('admin', { child_playlist_id: P }, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_NESTED');
  r = await api(`/api/playlists/${P}`, J('admin', { smart_rules: { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'x' }] } }, 'PUT', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SMART');
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, slot_id: 'x' }, 'POST', HQ));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'CORPORATE_SLOT_FIELD');
});

/* ── mandates ───────────────────────────────────────────────────────────────────────────────── */

test('mandates: admin only; the playlist must be published; one per target', async () => {
  let r = await api('/api/corporate/mandates', J('store', { playlist_id: P, target_kind: 'workspace', target_id: STORE }, 'POST', STORE));
  assert.equal(r.status, 403);
  r = await api('/api/corporate/mandates', J('hqed', { playlist_id: P, target_kind: 'workspace', target_id: STORE }, 'POST', HQ));
  assert.equal(r.status, 403);
  r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'workspace', target_id: STORE }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_NOT_PUBLISHED');
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await get('admin', `/api/corporate/mandates/preview?playlist_id=${P}&target_kind=workspace&target_id=${STORE}`, HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.preview.screens, 2, 'both store screens would switch');
  assert.equal(r.body.preview.screen_playlists, 1, 'one has its own playlist that will pause');
  assert.deepEqual(r.body.preview.workspaces.map((w) => w.name), ['Store 1']);
  assert.equal(q('SELECT * FROM corporate_mandates').length, 0, 'the preview wrote nothing');

  const before = resolvedOf(dev);
  assert.equal(before.source, 'device');
  r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'workspace', target_id: STORE }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.screens_changed, 2);
  assert.deepEqual(resolvedOf(dev), { playlist_id: P, source: 'corporate', layout_id: null });
  r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'workspace', target_id: STORE }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_TARGET_TAKEN');
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.mandate.create'"), 'audited');
});

test('a device mandate naming a video-wall member is refused (it would split the wall)', async () => {
  const wall = crypto.randomUUID();
  run('INSERT INTO video_walls (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', wall, U.admin.id, OTHER_STORE, 'Atrium');
  const w1 = mkDevice(OTHER_STORE, 'wall-1', `wall_id = '${wall}'`);
  const r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'device', target_id: w1 }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_WALL_SPLIT');
});

test('the device page says head office decides — by name, not link — and the payload is head office\'s', async () => {
  let r = await get('store', `/api/devices/${dev}`, STORE);
  assert.equal(r.status, 200);
  assert.equal(r.body.playlist_source, 'corporate');
  assert.equal(r.body.corporate.playlist_name, 'Brand loop');
  assert.equal(r.body.corporate.can_change, false);
  r = await get('store', `/api/devices/${dev}/preview-payload`, STORE);
  assert.equal(r.status, 200, typeof r.body === 'string' ? r.body.slice(0, 1500) : JSON.stringify(r.body));
  assert.deepEqual(r.body.assignments.map((a) => a.content_id), [hqContent]);
  assert.ok(!JSON.stringify(r.body).includes('__origin_ws'), 'the origin tag never leaves the server');
  r = await get('store', `/api/corporate/preview?device_id=${dev}`, STORE);
  assert.equal(r.status, 200, typeof r.body === 'string' ? r.body.slice(0, 1500) : JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.tag), ['corporate']);
  // The store playlist the mandate shadows is "paused", not "unused".
  r = await get('store', '/api/playlists', STORE);
  assert.equal(r.body.find((p) => p.id === ownPl).paused_count, 1);
});

/* ── overrides of a mandated screen (§4.3) ─────────────────────────────────────────────────── */

test('overrides: a store manager gets a 403 with the reason, an org admin a 409 SHADOWS; nothing changes', async () => {
  const devBefore = JSON.stringify(q1('SELECT * FROM devices WHERE id = ?', dev));
  const pBefore = itemsOf(P);
  const cases = [
    ['store', `/api/playlists/${ownPl}/assign`, 'POST', { device_id: dev }, STORE, 403, 'CORPORATE_OVERRIDE'],
    ['admin', `/api/playlists/${ownPl}/assign`, 'POST', { device_id: dev }, STORE, 409, 'CORPORATE_MANDATE_SHADOWS'],
    ['store', `/api/assignments/device/${dev}`, 'POST', { content_id: storeContent }, STORE, 403, 'CORPORATE_NO_SLOT'],
    ['store', `/api/assignments/device/${dev}/reorder`, 'POST', { order: [] }, STORE, 403, 'CORPORATE_LOCKED'],
    ['store', `/api/assignments/device/${dev2}/copy-to/${dev}`, 'POST', {}, STORE, 403, 'CORPORATE_OVERRIDE'],
    ['store', `/api/devices/${dev}`, 'PUT', { layout_id: null }, STORE, 403, 'CORPORATE_OVERRIDE'],
    ['store', `/api/layouts/device/${dev}`, 'PUT', { layout_id: null }, STORE, 403, 'CORPORATE_OVERRIDE'],
    ['store', '/api/schedules', 'POST', { device_id: dev, playlist_id: ownPl, start_time: '2026-01-01T09:00', end_time: '2026-01-01T10:00' }, STORE, 403, 'CORPORATE_SCHEDULE'],
    ['admin', '/api/schedules', 'POST', { device_id: dev, playlist_id: ownPl, start_time: '2026-01-01T09:00', end_time: '2026-01-01T10:00' }, STORE, 409, 'CORPORATE_SCHEDULE'],
  ];
  for (const [who, p, m, b, ws, status, code] of cases) {
    const r = await api(p, J(who, b, m, ws));
    assert.equal(r.status, status, `${who} ${m} ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, `${who} ${m} ${p}`);
    assert.ok(r.body.error && !/CORPORATE_/.test(r.body.error), 'a sentence, not a code');
  }
  assert.equal(JSON.stringify(q1('SELECT * FROM devices WHERE id = ?', dev)), devBefore);
  assert.equal(itemsOf(P), pBefore);
  assert.equal(q('SELECT * FROM schedules').length, 0);
  // Clearing the shadowed override is harmless, and says head office still plays here.
  const r = await api(`/api/devices/${dev}/playlist`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200); assert.equal(r.body.still_mandated, true);
});

test('group: assign-playlist refused when covered; add-content skips mandated members (never writes head office\'s playlist)', async () => {
  const g = await api('/api/groups', J('store', { name: 'Tills' }, 'POST', STORE));
  await api(`/api/groups/${g.body.id}/devices`, J('store', { device_id: dev2 }, 'POST', STORE));
  let r = await api(`/api/groups/${g.body.id}/assign-playlist`, J('store', { playlist_id: ownPl }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_OVERRIDE');
  const pBefore = itemsOf(P);
  r = await api(`/api/groups/${g.body.id}/assign-content`, J('store', { content_id: storeContent }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.skipped, [{ device_id: dev2, reason: 'no_slot' }]);
  assert.equal(itemsOf(P), pBefore, 'head office\'s playlist must never gain a store item');
});

test('membership: joining or leaving a group is refused when it would change a screen\'s head office playlist', async () => {
  const P2 = (await api('/api/corporate/playlists', J('admin', { name: 'Window loop' }, 'POST', HQ))).body.id;
  await api(`/api/playlists/${P2}/items`, J('admin', { content_id: hqContent, duration_sec: 5 }, 'POST', HQ));
  await api(`/api/playlists/${P2}/publish`, J('admin', {}, 'POST', HQ));
  const g = (await api('/api/groups', J('store', { name: 'Windows' }, 'POST', STORE))).body;
  const m = await api('/api/corporate/mandates', J('admin', { playlist_id: P2, target_kind: 'group', target_id: g.id }, 'POST', HQ));
  assert.equal(m.status, 201, JSON.stringify(m.body));
  let r = await api(`/api/groups/${g.id}/devices`, J('store', { device_id: dev }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_MEMBERSHIP');
  assert.match(r.body.error, /Adding this screen to "Windows"/);
  assert.equal(q('SELECT * FROM device_group_members WHERE group_id = ?', g.id).length, 0, 'rolled back');
  r = await api(`/api/groups/${g.id}/devices`, J('admin', { device_id: dev }, 'POST', STORE));
  assert.equal(r.status, 201, 'an org admin may');
  assert.equal(resolvedOf(dev).playlist_id, P2);
  r = await api(`/api/groups/${g.id}/devices/${dev}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 403); assert.match(r.body.error, /Removing this screen from "Windows"/);
  r = await api(`/api/groups/${g.id}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 403); assert.match(r.body.error, /Deleting the group "Windows"/);
  assert.ok(q1('SELECT 1 AS x FROM device_groups WHERE id = ?', g.id), 'the group survived');
  r = await api(`/api/groups/${g.id}`, J('admin', undefined, 'DELETE', STORE));
  assert.equal(r.status, 200);
  assert.equal(q('SELECT * FROM corporate_mandates WHERE target_id = ?', g.id).length, 0, 'the group mandate went with the group');
  assert.equal(resolvedOf(dev).playlist_id, P, 'back to the workspace mandate');
});

test('⚠️ group:sync RELAYS between members of a group head office\'s playlist covers (the group has no playlist of its own)', async () => {
  const ioClient = require('socket.io-client');
  const g = (await api('/api/groups', J('admin', { name: 'Sync wall' }, 'POST', STORE))).body;
  const a = mkDevice(STORE, 'sync-a'); const b = mkDevice(STORE, 'sync-b');
  const tokA = 'devtok_' + crypto.randomBytes(8).toString('hex'); const tokB = 'devtok_' + crypto.randomBytes(8).toString('hex');
  run('UPDATE devices SET device_token = ? WHERE id = ?', tokA, a); run('UPDATE devices SET device_token = ? WHERE id = ?', tokB, b);
  for (const d of [a, b]) assert.equal((await api(`/api/groups/${g.id}/devices`, J('admin', { device_id: d }, 'POST', STORE))).status, 201);
  run('UPDATE device_groups SET sync_enabled = 1 WHERE id = ?', g.id);
  assert.equal(resolvedOf(a).playlist_id, P, 'precondition: the workspace mandate covers both');
  const connect = (id, token) => new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const t = setTimeout(() => reject(new Error('register timeout ' + id)), 5000);
    sock.on('connect', () => sock.emit('device:register', { device_id: id, device_token: token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { clearTimeout(t); resolve(sock); });
    sock.on('device:auth-error', (e) => { clearTimeout(t); reject(new Error('auth ' + JSON.stringify(e))); });
  });
  const sa = await connect(a, tokA); const sb = await connect(b, tokB);
  try {
    const got = new Promise((resolve) => { sb.on('group:sync', resolve); setTimeout(() => resolve(null), 3000); });
    sa.emit('group:sync', { group_id: g.id, index: 2, position_ms: 1234 });
    const msg = await got;
    assert.ok(msg, 'the follower must receive the leader\'s broadcast — before the sync key, a group with no playlist relayed nothing');
    assert.equal(msg.device_id, a);
    assert.equal(msg.index, 2);
  } finally { sa.close(); sb.close(); }
});

/* ── device controls (D13) ──────────────────────────────────────────────────────────────────── */

test('device controls: blanking/detaching commands are org-admin only; reboot stays with the store', async () => {
  let r = await api(`/api/devices/${dev}/command`, J('store', { type: 'screen_off' }, 'POST', STORE));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_DEVICE_CONTROL');
  r = await api(`/api/devices/${dev}/command`, J('store', { type: 'shell', payload: { cmd: 'id' } }, 'POST', STORE));
  assert.equal(r.status, 403);
  r = await api(`/api/devices/${dev}/command`, J('store', { type: 'reboot' }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/devices/${dev}/command`, J('admin', { type: 'screen_off' }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/devices/${dev}/block`, J('store', {}, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_DEVICE_CONTROL');
  assert.equal(q1('SELECT blocked FROM devices WHERE id = ?', dev).blocked, 0);
  r = await api('/api/pip', J('store', { device_id: dev, type: 'web', uri: 'https://example.com/' }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_DEVICE_CONTROL');
  r = await api(`/api/devices/${dev}/local-api-secret`, J('store', { rotate: true }, 'POST', STORE));
  assert.equal(r.status, 403);
  r = await api('/api/display-power-schedules', J('store', { device_id: dev, windows: [{ days: [1], start: '00:00', end: '23:00' }] }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_DEVICE_CONTROL');
  r = await api(`/api/workspaces/${STORE}/command`, J('admin', { type: 'reboot' }, 'POST'));
  assert.ok(r.status === 200, JSON.stringify(r.body));
});

/* ── org-owned media and the publish chokepoint ────────────────────────────────────────────── */

test('org-owned media: a non-author HQ editor cannot delete or edit what a corporate playlist plays', async () => {
  let r = await api(`/api/content/${hqContent}`, J('hqed', undefined, 'DELETE', HQ));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_MEDIA');
  r = await api(`/api/content/${hqContent}`, J('hqed', { filename: 'x.png' }, 'PUT', HQ));
  assert.equal(r.status, 403);
  r = await api('/api/content/batch/delete', J('hqed', { ids: [hqContent] }, 'POST', HQ));
  assert.equal(r.status, 403);
  assert.ok(q1('SELECT 1 AS x FROM content WHERE id = ?', hqContent), 'still there');
});

test('⚠️ approvals publish: a reviewer who is not an author cannot ship a corporate playlist', async () => {
  let r = await api('/api/approvals/settings', J('admin', { require_approval: true, reviewers: [U.hqed.id] }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: hqContent, duration_sec: 9 }, 'POST', HQ));
  assert.equal(r.status, 201);
  r = await api('/api/approvals/submit', J('admin', { resource_type: 'playlist', resource_id: P }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sub = r.body.id || (r.body.submission && r.body.submission.id);
  r = await api(`/api/approvals/${sub}/approve`, J('hqed', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const snapBefore = q1('SELECT published_snapshot FROM playlists WHERE id = ?', P).published_snapshot;
  r = await api(`/api/approvals/${sub}/publish`, J('hqed', {}, 'POST', HQ));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_AUTHOR_REQUIRED');
  assert.equal(q1('SELECT published_snapshot FROM playlists WHERE id = ?', P).published_snapshot, snapBefore);
  r = await api(`/api/approvals/${sub}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await api('/api/approvals/settings', J('admin', { require_approval: false }, 'PUT', HQ));
});

test('revisions restore on a corporate playlist by a non-author answers with a code', async () => {
  const revs = await get('admin', `/api/revisions/playlist/${P}`, HQ);
  assert.equal(revs.status, 200);
  const rev = revs.body.revisions[revs.body.revisions.length - 1];
  const r = await api(`/api/revisions/playlist/${P}/${rev.id}/restore`, J('hqed', {}, 'POST', HQ));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_AUTHOR_REQUIRED');
});

test('a mandated corporate playlist cannot be deleted or made ordinary', async () => {
  let r = await api(`/api/playlists/${P}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_MANDATED');
  r = await api(`/api/corporate/playlists/${P}/demote`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_MANDATED');
});

/* ── dark mandate, kill switch, removal ─────────────────────────────────────────────────────── */

test('a dark mandate is really dark: no items and NO store default content', async () => {
  run('UPDATE devices SET default_content_id = ? WHERE id = ?', storeContent, dev2);
  const r0 = await get('store', `/api/devices/${dev2}/preview-payload`, STORE);
  assert.deepEqual(r0.body.default_content, null, 'precondition: dev2 is under the workspace mandate already');
  const m = await api('/api/corporate/mandates', J('admin', { dark: true, target_kind: 'device', target_id: dev2 }, 'POST', HQ));
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const r = await get('store', `/api/devices/${dev2}/preview-payload`, STORE);
  assert.deepEqual(r.body.assignments, []);
  assert.equal(r.body.default_content, null);
  const d = await get('store', `/api/devices/${dev2}`, STORE);
  assert.equal(d.body.corporate.dark, true);
  await api(`/api/corporate/mandates/${m.body.id}`, J('admin', undefined, 'DELETE', HQ));
});

test('kill switch: corporate off -> every store screen back to its own playlist immediately, mandates kept', async () => {
  let r = await api('/api/corporate/settings', J('admin', { corporate_enabled: false }, 'PUT', HQ));
  assert.equal(r.status, 200);
  assert.equal(resolvedOf(dev).source !== 'corporate', true);
  assert.ok(q('SELECT * FROM corporate_mandates').length > 0, 'mandates are kept');
  r = await api(`/api/assignments/device/${dev}`, J('store', { content_id: storeContent, duration_sec: 5 }, 'POST', STORE));
  assert.equal(r.status, 201, 'with the switch off nothing is refused: ' + JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'workspace', target_id: OTHER_STORE }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_DISABLED');
  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 200);
  assert.equal(resolvedOf(dev).source, 'corporate');
});

test('removing the mandate restores exactly what the screen had', async () => {
  const ms = await get('admin', '/api/corporate/mandates', HQ);
  const ws = ms.body.mandates.find((m) => m.target_kind === 'workspace' && m.target_id === STORE);
  const r = await api(`/api/corporate/mandates/${ws.id}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200);
  assert.notEqual(resolvedOf(dev).source, 'corporate');
});

test('the backstop tripwire never fired: no write in a request ran without an actor', () => {
  const log = fs.readFileSync(LOG, 'utf8');
  assert.doesNotMatch(log, /\[corporate\] backstop: write with no actor/);
  assert.doesNotMatch(log, /ABORT view upgrade/);
});

let PORT;
