'use strict';

/*
 * Moving screens so they NEWLY come under head office never hides a store trigger silently, and
 * moving a screen to another workspace (POST /api/devices/move-workspace) never takes it off its old
 * store's triggers silently either. Every such change lists the triggers and is refused (409,
 * nothing written) until the caller resends with acknowledge_impact. Real server, like
 * corporate-store-trigger-default.test.js.
 *
 * MUTATION CHECK (verified once by reverting and watching the named test go red):
 *   - routes/devices.js POST /move-workspace: drop the "impact.length && !acknowledged" refusal
 *       -> "⚠️ moving a screen off its store's trigger is refused until acknowledged ..."
 *   - lib/corporate/guard.js assertNoMandateLoss: drop the CORPORATE_STORE_TRIGGERS_IMPACT throw
 *       -> "⚠️ joining a group head office drives lists the store triggers it hides ..."
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
let proc, BASE, DATA_DIR, LOG, PORT;
const U = {};
let ORG, HQ, A, B, C, A_PL, CORP;

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
}

async function boot() {
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
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
}

const mkContent = (ws, name) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, file_size)
       VALUES (?, ?, ?, ?, ?, 'image/png', 10, 1)`, id, U.admin.id, ws, name, name);
  return id;
};
const mkPlaylist = (ws, name, contentId, corporate = 0) => {
  const id = crypto.randomUUID();
  const snap = JSON.stringify([{ content_id: contentId, filename: 'x.png', filepath: 'x.png', mime_type: 'image/png', duration_sec: 10, sort_order: 0 }]);
  run(`INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, corporate) VALUES (?, ?, ?, ?, 'published', ?, ?)`,
    id, U.admin.id, ws, name, snap, corporate);
  return id;
};
const mkDevice = (ws, name, { playlist = null } = {}) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source,
        triggers_accept_http, trigger_secret, platform, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'web', 'offline', strftime('%s','now') + 3600)`,
    id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6), playlist, playlist ? 'device' : null, crypto.randomBytes(8).toString('hex'));
  return id;
};
const wsOf = (d) => q1('SELECT workspace_id FROM devices WHERE id = ?', d).workspace_id;
const triggerNames = async (d) => ((await get('admin', `/api/devices/${d}/preview-payload`, wsOf(d))).body.triggers || []).map((t) => t.name);
const move = (who, ids, ws, extra = {}) => api('/api/devices/move-workspace', J(who, { device_ids: ids, workspace_id: ws, ...extra }, 'POST', HQ));
const trigger = async (who, ws, name, token, assignments) => {
  const pl = mkPlaylist(ws, `${name} pl`, mkContent(ws, `${token}.png`));
  const r = await api('/api/triggers', J(who, { name, match_token: token, mode: 'until_cleared', target_ref: pl, assignments }, 'POST', ws));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
};

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-move-'));
  LOG = path.join(DATA_DIR, 'server.log');
  await boot();
  for (const n of ['admin', 'mgr', 'store', 'outsider']) await register(n);
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  const mkWs = (name) => {
    const id = crypto.randomUUID();
    run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', id, ORG, name, name.toLowerCase().replace(/\s+/g, '-'));
    return id;
  };
  A = mkWs('Store A'); B = mkWs('Store B'); C = mkWs('Store C');
  // mgr: a workspace admin of A and C (not of B, not an org admin). store: an editor of A.
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", A, U.mgr.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", C, U.mgr.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", A, U.store.id);
  A_PL = mkPlaylist(A, 'A own', mkContent(A, 'a.png'));
  CORP = mkPlaylist(HQ, 'Brand', mkContent(HQ, 'brand.png'), 1);
  let r = await api('/api/corporate/settings', J('admin', { hq_workspace_id: HQ, corporate_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Head office drives the whole of Store B (nothing there has a trigger, so no prompt).
  r = await api('/api/corporate/mandates', J('admin', { target_kind: 'workspace', target_id: B, playlist_id: CORP }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

after(async () => { await stop(); });

let D1, D2;

test('the move preview lists the store trigger a screen leaves behind and the head office playlist it arrives under', async () => {
  D1 = mkDevice(A, 'Till', { playlist: A_PL });
  await trigger('store', A, 'Fire relay', 'FIRE', [{ target_type: 'device', target_id: D1 }]);
  assert.ok((await triggerNames(D1)).includes('Fire relay'));
  const r = await get('admin', `/api/devices/move-workspace/preview?device_ids=${D1}&workspace_id=${B}`, HQ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.leaving.map((t) => [t.name, t.workspace_name, t.screens, t.reason]), [['Fire relay', 'Store A', 1, 'left_store']]);
  assert.deepEqual(r.body.hidden, []);
  assert.equal(r.body.screens[0].head_office_before, null);
  assert.equal(r.body.screens[0].head_office_after, 'Brand');
  assert.equal(wsOf(D1), A, 'a preview moves nothing');
});

test("⚠️ moving a screen off its store's trigger is refused until acknowledged, and nothing moves", async () => {
  const r = await move('admin', [D1], B);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'DEVICE_MOVE_TRIGGERS_IMPACT');
  assert.deepEqual(r.body.impact.map((t) => t.name), ['Fire relay']);
  assert.match(r.body.error, /1 store trigger will no longer reach this screen/);
  assert.equal(wsOf(D1), A);
  assert.ok((await triggerNames(D1)).includes('Fire relay'), 'still on the store trigger');
});

test('acknowledged: the screen moves, plays head office in its new workspace, and both stores are told', async () => {
  const r = await move('admin', [D1], B, { acknowledge_impact: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsOf(D1), B);
  assert.deepEqual(r.body.store_triggers_left_behind.map((t) => t.name), ['Fire relay']);
  const row = q1('SELECT playlist_id, playlist_source FROM devices WHERE id = ?', D1);
  assert.deepEqual([row.playlist_id, row.playlist_source], [null, null], "Store A's own playlist stays with Store A");
  assert.equal(q1("SELECT COUNT(*) AS n FROM trigger_assignments WHERE target_type = 'device' AND target_id = ?", D1).n, 0);
  assert.deepEqual(await triggerNames(D1), []);
  assert.equal(q1('SELECT source FROM device_resolved_playlist WHERE device_id = ?', D1).source, 'corporate');
  const feeds = q("SELECT workspace_id FROM activity_log WHERE action = 'device.move_workspace' AND device_id = ?", D1).map((x) => x.workspace_id).sort();
  assert.deepEqual(feeds, [A, B].sort());
  assert.equal(q1("SELECT workspace_id FROM activity_log WHERE action = 'device.move_workspace.triggers_left' ORDER BY rowid DESC LIMIT 1").workspace_id, A);
});

test('a screen with no store triggers moves without being asked; its old groups stay behind', async () => {
  D2 = mkDevice(A, 'Door');
  const g = crypto.randomUUID();
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', g, U.admin.id, A, 'A front');
  run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', D2, g);
  const r = await move('admin', [D2], B);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsOf(D2), B);
  assert.equal(q1('SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = ?', D2).n, 0);
  assert.equal(r.body.moved[0].dropped.groups, 1);
});

test('moving a screen OUT from under head office needs no acknowledgement', async () => {
  const r = await move('admin', [D2], A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsOf(D2), A);
  assert.notEqual(q1('SELECT source FROM device_resolved_playlist WHERE device_id = ?', D2).source, 'corporate');
});

test("who may move: never a store editor; a workspace admin of both stores only when head office's playlist doesn't change", async () => {
  const d = mkDevice(A, 'Back');
  let r = await move('store', [d], C);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  r = await move('mgr', [d], B);
  assert.equal(r.status, 403, 'mgr is not an admin of Store B');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", B, U.mgr.id);
  r = await move('mgr', [d], B);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CORPORATE_MEMBERSHIP', 'coming under head office is an org admin decision');
  assert.equal(wsOf(d), A);
  r = await move('mgr', [d], C);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wsOf(d), C);
  r = await move('outsider', [d], A);
  assert.equal(r.status, 403);
});

test('⚠️ joining a group head office drives lists the store triggers it hides, and is refused until acknowledged', async () => {
  const gm = crypto.randomUUID();
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', gm, U.admin.id, C, 'C brand group');
  let r = await api('/api/corporate/mandates', J('admin', { target_kind: 'group', target_id: gm, playlist_id: CORP }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d5 = mkDevice(C, 'Kiosk');
  await trigger('admin', C, 'C bell', 'BELL', [{ target_type: 'device', target_id: d5 }]);
  r = await api(`/api/groups/${gm}/devices`, J('admin', { device_id: d5 }, 'POST', C));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CORPORATE_STORE_TRIGGERS_IMPACT');
  assert.deepEqual(r.body.impact.map((t) => [t.name, t.workspace_name]), [['C bell', 'Store C']]);
  assert.equal(q1('SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = ?', d5).n, 0, 'not joined');
  r = await api(`/api/groups/${gm}/devices`, J('admin', { device_id: d5, acknowledge_impact: true }, 'POST', C));
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  assert.equal(q1('SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = ?', d5).n, 1);
  assert.ok(!(await triggerNames(d5)).includes('C bell'), 'hidden under head office');
  const told = JSON.parse(q1("SELECT details FROM activity_log WHERE action = 'corporate.store_triggers.limited' ORDER BY rowid DESC LIMIT 1").details);
  assert.equal(told.cause, 'membership');
  assert.deepEqual(told.triggers.map((t) => t.name), ['C bell']);
  // Leaving the group: the trigger shows again, no question asked.
  r = await api(`/api/groups/${gm}/devices/${d5}`, J('admin', undefined, 'DELETE', C));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await triggerNames(d5)).includes('C bell'));
});

test('putting a screen on a video wall head office drives asks the same question', async () => {
  const w = crypto.randomUUID();
  run('INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows) VALUES (?, ?, ?, ?, 2, 1)', w, U.admin.id, C, 'C wall');
  let r = await api('/api/corporate/mandates', J('admin', { target_kind: 'wall', target_id: w, playlist_id: CORP }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d6 = mkDevice(C, 'Wall left');
  await trigger('admin', C, 'C buzzer', 'BUZZ', [{ target_type: 'device', target_id: d6 }]);
  const seat = { devices: [{ device_id: d6, grid_col: 0, grid_row: 0 }] };
  r = await api(`/api/walls/${w}/devices`, J('admin', seat, 'PUT', C));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CORPORATE_STORE_TRIGGERS_IMPACT');
  assert.equal(q1('SELECT wall_id FROM devices WHERE id = ?', d6).wall_id, null, 'not seated');
  r = await api(`/api/walls/${w}/devices`, J('admin', { ...seat, acknowledge_impact: true }, 'PUT', C));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q1('SELECT wall_id FROM devices WHERE id = ?', d6).wall_id, w);
});

test('a move needs real screens, a real workspace the caller administers, in the same organization', async () => {
  const d = mkDevice(A, 'Spare');
  // admin is this install's first user, a platform admin, so it gets past "admin of both": the
  // organization check is what stops a screen leaving its organization.
  let r = await move('admin', [d], U.outsider.ws);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'MOVE_OTHER_ORG');
  r = await move('admin', [], B);
  assert.equal(r.status, 400);
  r = await move('admin', [d], 'nope');
  assert.equal(r.status, 404);
  assert.equal(wsOf(d), A);
});
