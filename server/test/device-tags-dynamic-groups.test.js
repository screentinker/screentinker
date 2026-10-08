'use strict';

/*
 * Device tags and dynamic groups, end to end against a real server.
 *
 * A dynamic group fills itself from rules (lib/device-group-rules.js) by keeping
 * device_group_members equal to what the rules say, so every consumer of a group keeps working.
 * What has to hold:
 *   - tags are stored normalised and come back as an array; ?tag= filters the device list
 *   - creating a group with rules, or changing a screen's tags, moves membership at once
 *   - hand-editing a dynamic group's members is refused (409); clearing the rules keeps them
 *   - a screen on a video wall never joins (a wall member is never in a group)
 *   - a tag edit that would change which head office playlist a screen plays is refused for a
 *     store editor, and NOTHING is written, exactly like dragging it out of the group by hand
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
let HQ, STORE;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

function J(who, body, method = 'POST', ws) {
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${U[who].token}` };
  if (ws) h['X-Workspace-Id'] = ws;
  return { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function register(name) {
  const r = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}-${Date.now()}@acme.test`, password: 'Passw0rd123', name }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
}
const mkDevice = (ws, name, tags) => {
  const id = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, platform, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6), 'android', tags ? JSON.stringify(tags) : null);
  return id;
};
const membersOf = (g) => q('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id', g).map((r) => r.device_id).sort();
const tagRule = (value, op = 'has') => ({ match: 'all', rules: [{ field: 'tag', op, value }] });

let lobby1, lobby2, till, walled;

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dyngroups-'));
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

  await register('plat');      // first account is platform staff; keep it out of the way
  await register('admin');
  await register('store');
  HQ = U.admin.ws;
  const ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);

  lobby1 = mkDevice(STORE, 'Lobby North', ['lobby']);
  lobby2 = mkDevice(STORE, 'Lobby South');
  till = mkDevice(STORE, 'Till 1', ['retail']);
  walled = mkDevice(STORE, 'Wall panel', ['lobby']);
  const wall = crypto.randomUUID();
  run('INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows) VALUES (?, ?, ?, ?, 1, 1)', wall, U.admin.id, STORE, 'Wall');
  run('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0)', wall, walled);
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

let G;

test('tags are stored normalised, come back as an array, and filter the device list', async () => {
  const r = await api(`/api/devices/${lobby2}`, J('store', { tags: 'Lobby, Portrait,lobby' }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tags, ['lobby', 'portrait']);
  assert.equal(q1('SELECT tags FROM devices WHERE id = ?', lobby2).tags, '["lobby","portrait"]');

  const list = await api('/api/devices?tag=LOBBY', J('store', undefined, 'GET', STORE));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((d) => d.id).sort(), [lobby1, lobby2, walled].sort());
  assert.ok(list.body.every((d) => Array.isArray(d.tags)));

  const bad = await api(`/api/devices/${lobby2}`, J('store', { tags: { not: 'a list' } }, 'PUT', STORE));
  assert.equal(bad.status, 400);
});

test('the preview shows which screens rules would select, without the wall panel', async () => {
  const r = await api('/api/groups/rules-preview', J('store', { rules: tagRule('lobby') }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.devices.map((d) => d.id).sort(), [lobby1, lobby2].sort());
  const bad = await api('/api/groups/rules-preview', J('store', { rules: { rules: [] } }, 'POST', STORE));
  assert.equal(bad.status, 400);
});

test('a group created with rules fills itself, never with a wall member', async () => {
  const r = await api('/api/groups', J('store', { name: 'Lobbies', rules: tagRule('lobby') }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  G = r.body.id;
  assert.deepEqual(r.body.rules, tagRule('lobby'));
  assert.deepEqual(membersOf(G), [lobby1, lobby2].sort());
});

test('changing a screen\'s tags moves it into or out of the group at once', async () => {
  let r = await api(`/api/devices/${till}`, J('store', { tags: ['retail', 'lobby'] }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.groups_changed, [{ group_id: G, name: 'Lobbies', op: 'add' }]);
  assert.deepEqual(membersOf(G), [lobby1, lobby2, till].sort());

  r = await api(`/api/devices/${lobby1}`, J('store', { tags: [] }, 'PUT', STORE));
  assert.equal(r.status, 200);
  assert.deepEqual(membersOf(G), [lobby2, till].sort());
});

test('changing the rules re-fills the group', async () => {
  const r = await api(`/api/groups/${G}`, J('store', { rules: tagRule('retail') }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(membersOf(G), [till]);
  const bad = await api(`/api/groups/${G}`, J('store', { rules: { match: 'all', rules: [{ field: 'tag', op: 'eq', value: 'x' }] } }, 'PUT', STORE));
  assert.equal(bad.status, 400);
  assert.deepEqual(membersOf(G), [till], 'a refused rule set changed nothing');
});

test('a dynamic group\'s members cannot be edited by hand; clearing the rules keeps them', async () => {
  let r = await api(`/api/groups/${G}/devices`, J('store', { device_id: lobby1 }, 'POST', STORE));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'DYNAMIC_GROUP');
  r = await api(`/api/groups/${G}/devices/${till}`, J('store', undefined, 'DELETE', STORE));
  assert.equal(r.status, 409);
  assert.deepEqual(membersOf(G), [till]);

  r = await api(`/api/groups/${G}`, J('store', { rules: null }, 'PUT', STORE));
  assert.equal(r.status, 200);
  assert.equal(r.body.rules, null);
  assert.deepEqual(membersOf(G), [till], 'a hand-built group again, with the same members');
  r = await api(`/api/groups/${G}/devices`, J('store', { device_id: lobby1 }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // ...and a tag edit no longer moves anyone in or out of a hand-built group.
  r = await api(`/api/devices/${till}`, J('store', { tags: [] }, 'PUT', STORE));
  assert.equal(r.status, 200);
  assert.deepEqual(membersOf(G), [lobby1, till].sort());
});

test('HEAD OFFICE: a store editor\'s tag edit that would change a screen\'s mandate is refused, nothing written', async () => {
  // A dynamic group in the store, mandated by head office.
  let r = await api('/api/groups', J('store', { name: 'Windows', rules: tagRule('window') }, 'POST', STORE));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const W = r.body.id;
  r = await api(`/api/devices/${lobby2}`, J('store', { tags: ['lobby', 'portrait', 'window'] }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(membersOf(W), [lobby2]);

  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, hq_workspace_id: HQ }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const content = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
       VALUES (?, ?, ?, 'brand.png', 'brand.png', 'image/png', 10, 1)`, content, U.admin.id, HQ);
  r = await api('/api/corporate/playlists', J('admin', { name: 'Brand loop' }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const P = r.body.id;
  r = await api(`/api/playlists/${P}/items`, J('admin', { content_id: content, duration_sec: 8 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api(`/api/playlists/${P}/publish`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('/api/corporate/mandates', J('admin', { playlist_id: P, target_kind: 'group', target_id: W }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const tagsBefore = q1('SELECT tags FROM devices WHERE id = ?', lobby2).tags;
  r = await api(`/api/devices/${lobby2}`, J('store', { tags: ['lobby'] }, 'PUT', STORE));
  assert.ok(r.status === 403 || r.status === 409, `refused, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'CORPORATE_MEMBERSHIP');
  assert.equal(q1('SELECT tags FROM devices WHERE id = ?', lobby2).tags, tagsBefore, 'the tag edit was not written');
  assert.deepEqual(membersOf(W), [lobby2], 'still in the mandated group');

  // A tag edit that does not touch the mandated group still goes through.
  r = await api(`/api/devices/${lobby2}`, J('store', { tags: ['window', 'portrait'] }, 'PUT', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(membersOf(W), [lobby2]);
});
