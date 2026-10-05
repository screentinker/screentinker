'use strict';

/*
 * Head office EMERGENCY ALERTS (spec §5, Stage C) against the REAL server: the org switch, the
 * emergency API (CRUD, coverage, installer sheet, rotate, Activate now / clear / expiry / restart),
 * the /api/triggers refusals and code stripping, the trigger-settings lock on in-scope screens, the
 * token namespace in both directions, secrets out of preview-payload, and the store-trigger policy
 * with its impact list and acknowledgement.
 *
 * Cast (one org, "Acme"):
 *   plat    platform admin (first registered user)
 *   admin   org owner of Acme
 *   hqed    workspace_editor in the head office workspace (not an org admin)
 *   store   workspace_editor in "Store 1"
 *   viewer  workspace_viewer in "Store 1"
 *
 * The server runs with CORPORATE_TEST_EMERGENCY_MIN_SEC=1 (a NODE_ENV=test seam) so a real expiry
 * can be watched in seconds rather than a minute.
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching the named test go red):
 *   - routes/devices.js: drop emergencyTriggerSettingsRefused in trigger-config
 *       -> "⚠️ a store cannot quietly switch off triggers on a screen an alert covers"
 *   - routes/triggers.js: drop the emergency refusal in PUT -> "/api/triggers never edits ..."
 *   - routes/devices.js: drop the clearAllClash check -> "token namespace, the other direction ..."
 *   - routes/devices.js: drop the emergency code strip in preview-payload -> "preview-payload: ..."
 * Script: scratchpad corp/mutate-c.py.
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
let ORG, HQ, STORE, STORE2;
let ALARM, STORE_PL, DEV, DEV2, DEV_OFF, DEV_TIZEN, DEV_S2, ALERT;

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
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', CORPORATE_TEST_EMERGENCY_MIN_SEC: '1' },
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
const mkDevice = (ws, name, { http = 1, secret = true, platform = 'web' } = {}) => {
  const id = crypto.randomUUID();
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source,
        triggers_accept_http, trigger_secret, platform, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, 'device', ?, ?, ?, 'offline', strftime('%s','now') + 3600)`,
    id, U.admin.id, ws, name, crypto.randomUUID().slice(0, 6), STORE_PL, http, secret ? crypto.randomBytes(8).toString('hex') : null, platform);
  return id;
};
const preview = async (who, d, ws) => (await get(who, `/api/devices/${d}/preview-payload`, ws)).body;
const baseIds = (p) => (p.assignments || []).map((a) => a.content_id);

let alarmContent, storeContent;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-em-'));
  LOG = path.join(DATA_DIR, 'server.log');
  await boot();
  for (const n of ['plat', 'admin', 'hqed', 'store', 'viewer']) await register(n);
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID(); STORE2 = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE2, ORG, 'Store 2', 'store-2');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", HQ, U.hqed.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", STORE, U.viewer.id);
  alarmContent = mkContent(HQ, 'alarm.png');
  storeContent = mkContent(STORE, 'offer.png');
  ALARM = mkPlaylist(HQ, 'Evacuate', alarmContent);
  STORE_PL = mkPlaylist(STORE, 'Store own', storeContent);
  DEV = mkDevice(STORE, 'Till');
  DEV2 = mkDevice(STORE, 'Window');
  DEV_OFF = mkDevice(STORE, 'Back office', { http: 0, secret: false });
  DEV_TIZEN = mkDevice(STORE, 'TV', { platform: 'tizen' });
  DEV_S2 = mkDevice(STORE2, 'Other store');
});

after(async () => { await stop(); });

/* ── the org switch ────────────────────────────────────────────────────────────────────────── */

test('the emergency switch: owners/admins only; HQ is where alerts live', async () => {
  let r = await api('/api/corporate/settings', J('store', { emergency_triggers_enabled: true }, 'PUT', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_ADMIN_REQUIRED');
  r = await api('/api/corporate/settings', J('hqed', { emergency_triggers_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 403);
  r = await api('/api/corporate/settings', J('admin', { hq_workspace_id: HQ, emergency_triggers_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.emergency_triggers_enabled, true);
  assert.equal(q1('SELECT emergency_triggers_enabled AS e FROM organizations WHERE id = ?', ORG).e, 1);
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.switch'"), 'audited');
  r = await get('store', '/api/corporate/settings', STORE);
  assert.equal(r.body.emergency_triggers_enabled, true);
});

/* ── the emergency API ─────────────────────────────────────────────────────────────────────── */

test('only the organization\'s admins reach /api/corporate/emergency', async () => {
  for (const [who, ws] of [['store', STORE], ['hqed', HQ], ['viewer', STORE]]) {
    const r = await get(who, '/api/corporate/emergency', ws);
    assert.equal(r.status, 403, who); assert.equal(r.body.code, 'CORPORATE_EMERGENCY', who);
    const c = await api('/api/corporate/emergency', J(who, { name: 'x' }, 'POST', ws));
    assert.equal(c.status, 403, who);
  }
  assert.equal((await get('admin', '/api/corporate/emergency', HQ)).status, 200);
  assert.equal((await get('plat', '/api/corporate/emergency', HQ)).status, 200, 'platform admin acting as');
});

test('create: the validator\'s rules for an emergency alert', async () => {
  // A store trigger whose code an alert must not reuse.
  const st = await api('/api/triggers', J('store', { name: 'Store doorbell', match_token: 'DOORBELL', mode: 'once', target_ref: STORE_PL, assignments: [{ target_type: 'device', target_id: DEV }] }, 'POST', STORE));
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const base = { name: 'Evacuate', match_token: 'EVAC', clear_token: 'EVAC_CLR', target_ref: ALARM, mode: 'until_cleared', scopes: [{ scope_kind: 'workspace', scope_id: STORE }] };
  const bad = async (over, status, re) => {
    const r = await api('/api/corporate/emergency', J('admin', { ...base, ...over }, 'POST', HQ));
    assert.equal(r.status, status, `${JSON.stringify(over)} -> ${JSON.stringify(r.body)}`);
    if (re) assert.match(r.body.error, re);
    return r;
  };
  await bad({ target_ref: STORE_PL }, 400, /playlist in this workspace/);
  await bad({ lease_sec: 301 }, 400, /5-300/);
  await bad({ priority: 1001 }, 400, /0\.\.1000/);
  await bad({ mode: 'once', max_duration_sec: 30 }, 400, /60-3600/);
  await bad({ scopes: [{ scope_kind: 'workspace', scope_id: U.store.ws }] }, 400, /not in this organization/);
  await bad({ scopes: [{ scope_kind: 'wall', scope_id: 'x' }] }, 400, /scope_kind/);
  const clash = await bad({ match_token: 'DOORBELL' }, 409);
  assert.equal(clash.body.code, 'CORPORATE_EMERGENCY_TOKEN');
  assert.equal(q1("SELECT COUNT(*) AS n FROM triggers WHERE kind = 'emergency'").n, 0, 'nothing written by a refusal');
});

test('create: an alert in the head office workspace, scoped to Store 1, with coverage', async () => {
  const r = await api('/api/corporate/emergency', J('admin', {
    name: 'Evacuate', match_token: 'EVAC', clear_token: 'EVAC_CLR', target_ref: ALARM, mode: 'until_cleared', priority: 5,
    scopes: [{ scope_kind: 'workspace', scope_id: STORE }],
  }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ALERT = r.body.id;
  assert.equal(r.body.kind, 'emergency');
  assert.equal(r.body.workspace_id, HQ);
  assert.equal(r.body.lease_sec, 120, 'until_cleared gets the default lease');
  assert.deepEqual(r.body.scopes.map((s) => [s.scope_kind, s.scope_id, s.name]), [['workspace', STORE, 'Store 1']]);
  assert.equal(r.body.coverage.total, 4);
  assert.equal(r.body.coverage.trigger_ready, 2, 'the till and the window: listener on, secret set, synced');
  assert.equal(r.body.coverage.activate_ready, 2);
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.create'"));
  const list = await get('admin', '/api/corporate/emergency', HQ);
  assert.equal(list.body.enabled_for_org, true);
  assert.equal(list.body.triggers.length, 1);
});

test('/api/triggers never creates, edits or deletes an emergency alert, and shows its codes to org admins only', async () => {
  let r = await api('/api/triggers', J('store', { kind: 'emergency', name: 'x', match_token: 'Z', mode: 'once', target_ref: STORE_PL }, 'POST', STORE));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'CORPORATE_EMERGENCY');
  r = await api('/api/triggers', J('admin', { kind: 'emergency', name: 'x', match_token: 'Z', mode: 'once', target_ref: ALARM }, 'POST', HQ));
  assert.equal(r.status, 403, 'not even an admin: the emergency API is the one door');
  const before = JSON.stringify(q1('SELECT * FROM triggers WHERE id = ?', ALERT));
  for (const who of ['hqed', 'admin']) {
    r = await api(`/api/triggers/${ALERT}`, J(who, { name: 'Hijack', match_token: 'EVAC', mode: 'once', target_ref: ALARM }, 'PUT', HQ));
    assert.equal(r.status, 403, who); assert.equal(r.body.code, 'CORPORATE_EMERGENCY');
    r = await api(`/api/triggers/${ALERT}`, J(who, undefined, 'DELETE', HQ));
    assert.equal(r.status, 403, who);
  }
  assert.equal(JSON.stringify(q1('SELECT * FROM triggers WHERE id = ?', ALERT)), before);

  const asEditor = (await get('hqed', '/api/triggers', HQ)).body.triggers.find((t) => t.id === ALERT);
  assert.equal(asEditor.kind, 'emergency');
  assert.equal(asEditor.match_token, null); assert.equal(asEditor.clear_token, null);
  assert.equal((await get('hqed', `/api/triggers/${ALERT}`, HQ)).body.match_token, null);
  const asAdmin = (await get('admin', '/api/triggers', HQ)).body.triggers.find((t) => t.id === ALERT);
  assert.equal(asAdmin.match_token, 'EVAC');

  const storeList = await get('store', '/api/triggers', STORE);
  assert.deepEqual(storeList.body.head_office.emergency.map((t) => t.name), ['Evacuate'], 'the store sees it, read-only');
  assert.ok(!JSON.stringify(storeList.body.head_office).includes('EVAC'), 'no codes for the store');
  assert.deepEqual((await get('store', '/api/triggers', STORE2)).body.head_office.emergency, [], 'Store 2 is outside the scope');
});

test('⚠️ a store cannot quietly switch off triggers on a screen an alert covers', async () => {
  const before = JSON.stringify(q1('SELECT triggers_accept_http, trigger_secret, trigger_clear_all_token FROM devices WHERE id = ?', DEV));
  let r = await api(`/api/devices/${DEV}/trigger-config`, J('store', { accept_http: false }, 'POST', STORE));
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_DEVICE_CONTROL');
  assert.match(r.body.error, /Head office manages trigger settings/);
  r = await api(`/api/devices/${DEV}/trigger-secret`, J('store', { rotate: true }, 'POST', STORE));
  assert.equal(r.status, 403);
  assert.equal(JSON.stringify(q1('SELECT triggers_accept_http, trigger_secret, trigger_clear_all_token FROM devices WHERE id = ?', DEV)), before);
  // Outside the scope, and for the org's admins, nothing changes.
  r = await api(`/api/devices/${DEV_S2}/trigger-config`, J('admin', { http_port: 8090 }, 'POST', STORE2));
  assert.equal(r.status, 200);
  r = await api(`/api/devices/${DEV}/trigger-config`, J('admin', { http_port: 8091 }, 'POST', STORE));
  assert.equal(r.status, 200, 'an org admin may');
  // Switch off: the lock goes with it (only while head office uses emergency alerts).
  await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: false }, 'PUT', HQ));
  try {
    r = await api(`/api/devices/${DEV}/trigger-config`, J('store', { http_port: 8092 }, 'POST', STORE));
    assert.equal(r.status, 200);
  } finally { await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: true }, 'PUT', HQ)); }
});

test('token namespace, the other direction: a clear-all token may not be an alert code', async () => {
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE2, U.store.id);
  const r = await api(`/api/devices/${DEV_S2}/trigger-config`, J('store', { clear_all_token: 'EVAC_CLR' }, 'POST', STORE2));
  assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'CORPORATE_EMERGENCY_TOKEN');
  assert.ok(!r.body.error.includes('Evacuate'), 'the alert is not named to a store');
  assert.equal(q1('SELECT trigger_clear_all_token AS t FROM devices WHERE id = ?', DEV_S2).t, null);
  assert.equal((await api(`/api/devices/${DEV_S2}/trigger-config`, J('store', { clear_all_token: 'MYSTOP' }, 'POST', STORE2))).status, 200);
});

test('preview-payload: the alert is projected above every store trigger; its codes and the secrets only to who may see them', async () => {
  const asStore = await preview('store', DEV, STORE);
  const e = asStore.triggers.find((t) => t.id === ALERT);
  assert.ok(e, 'projected to an in-scope screen');
  assert.equal(e.priority, 100005);
  assert.equal(asStore.triggers[0].id, ALERT, 'first, so the player meets its code first');
  assert.equal(e.match_token, null, 'store users never read the codes');
  assert.ok(asStore.trigger_config.secret, 'an editor still sees the screen\'s own trigger secret');
  const asAdmin = await preview('admin', DEV, STORE);
  assert.equal(asAdmin.triggers.find((t) => t.id === ALERT).match_token, 'EVAC');
  const asViewer = await preview('viewer', DEV, STORE);
  assert.equal(asViewer.trigger_config.secret, null, 'no secret for a viewer');
  assert.equal(asViewer.local_api.secret, null);
  assert.ok(!(await preview('admin', DEV_S2, STORE2)).triggers.some((t) => t.id === ALERT), 'outside the scope');
});

test('coverage, installer sheet (audited) and rotate-secrets', async () => {
  run("UPDATE devices SET last_heartbeat = strftime('%s','now') + 3600");
  const c = (await get('admin', `/api/corporate/emergency/${ALERT}/coverage`, HQ)).body;
  const by = Object.fromEntries(c.unreachable.map((u) => [u.device_id, u.reasons]));
  assert.equal(c.total, 4);
  assert.deepEqual(by[DEV_OFF], ['listener_off']);
  assert.deepEqual(by[DEV_TIZEN], ['platform_no_triggers']);
  assert.deepEqual(by[DEV], [], 'listed only for Activate now (offline), ready for an alarm trigger');
  assert.deepEqual(c.unreachable.find((u) => u.device_id === DEV).activate_reasons, ['offline']);
  assert.equal(c.trigger_ready, 2);

  const sheet = (await get('admin', `/api/corporate/emergency/${ALERT}/installer-sheet`, HQ)).body;
  const till = sheet.screens.find((s) => s.device_id === DEV);
  const secret = q1('SELECT trigger_secret AS s FROM devices WHERE id = ?', DEV).s;
  assert.equal(till.secret, secret);
  assert.ok(till.lines.some((l) => l.kind === 'http_fire' && l.line.includes('token=EVAC') && l.line.includes(':8092')));
  assert.equal(sheet.trigger.clear_token, 'EVAC_CLR');
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.sheet'"), 'every read is audited');
  assert.equal((await get('store', `/api/corporate/emergency/${ALERT}/installer-sheet`, STORE)).status, 403);

  const rot = await api(`/api/corporate/emergency/${ALERT}/rotate-secrets`, J('admin', {}, 'POST', HQ));
  assert.equal(rot.status, 200);
  assert.equal(rot.body.rotated, 4);
  assert.notEqual(q1('SELECT trigger_secret AS s FROM devices WHERE id = ?', DEV).s, secret);
  assert.equal(rot.body.screens.find((s) => s.device_id === DEV).secret, q1('SELECT trigger_secret AS s FROM devices WHERE id = ?', DEV).s);
});

/* ── Activate now ──────────────────────────────────────────────────────────────────────────── */

test('Activate now: refused with the switch off or without a duration; then covered screens play the alert, others do not', async () => {
  await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: false }, 'PUT', HQ));
  let r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300 }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_EMERGENCY_OFF');
  await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: true }, 'PUT', HQ));
  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 400, 'a duration is required: an alert started here always ends');
  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('store', { duration_sec: 300 }, 'POST', STORE));
  assert.equal(r.status, 403);

  const s2Before = JSON.stringify(await preview('admin', DEV_S2, STORE2));
  const offBefore = baseIds(await preview('admin', DEV_OFF, STORE));
  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300, note: 'drill' }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.reached.online, 0);
  assert.equal(r.body.reached.offline_will_get_on_reconnect, 2);
  assert.deepEqual(r.body.reached.not_eligible.map((n) => [n.device_id, n.reason]).sort(),
    [[DEV_OFF, 'listener_off'], [DEV_TIZEN, 'platform_no_triggers']].sort());
  const p = await preview('admin', DEV, STORE);
  assert.deepEqual(baseIds(p), [alarmContent]);
  assert.ok(p.triggers.every((t) => t.kind === 'emergency'), 'no store trigger can overlay it');
  assert.deepEqual(baseIds(await preview('admin', DEV_OFF, STORE)), offBefore, 'triggers off here: untouched');
  assert.equal(JSON.stringify(await preview('admin', DEV_S2, STORE2)), s2Before, 'outside the scope: byte-identical');
  const list = (await get('admin', '/api/corporate/emergency', HQ)).body.triggers[0];
  assert.ok(list.active_activation && list.active_activation.remaining_sec > 200);

  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300 }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_EMERGENCY_ACTIVE');
  r = await api(`/api/corporate/emergency/${ALERT}/clear`, J('admin', {}, 'POST', HQ));
  assert.equal(r.status, 200); assert.equal(r.body.ended, true);
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [storeContent], 'back to its own playlist');
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.activate'"));
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.clear'"));
});

test('expiry happens with nobody asking', async () => {
  const r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 2 }, 'POST', HQ));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [alarmContent]);
  let row;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    row = q1('SELECT ended_at, ended_by FROM emergency_activations WHERE id = ?', r.body.activation.id);
    if (row.ended_at) break;
  }
  assert.equal(row.ended_by, 'expired', 'the server ended it on its own');
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [storeContent]);
});

test('a restart mid-activation keeps the alert on screen', async () => {
  const r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 600 }, 'POST', HQ));
  assert.equal(r.status, 201);
  await stop();
  await boot();
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [alarmContent], 'restored from emergency_activations');
  assert.match(fs.readFileSync(LOG, 'utf8'), /restored 1 live activation/);
});

test('turning the alert off, or the org switch off, ends a live activation', async () => {
  let r = await api(`/api/corporate/emergency/${ALERT}`, J('admin', { enabled: false }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.active_activation, null);
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [storeContent]);
  assert.ok(!(await preview('admin', DEV, STORE)).triggers.some((t) => t.id === ALERT), 'disabled: not projected');
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'corporate.emergency.disable'"));
  assert.ok(!q("SELECT details FROM activity_log WHERE action LIKE 'corporate.emergency.%'").some((r) => /EVAC/.test(r.details || '')),
    'alert codes never reach the activity log');
  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300 }, 'POST', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_EMERGENCY_DISABLED');
  await api(`/api/corporate/emergency/${ALERT}`, J('admin', { enabled: true }, 'PUT', HQ));
  r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300 }, 'POST', HQ));
  assert.equal(r.status, 201);
  await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: false }, 'PUT', HQ));
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [storeContent]);
  assert.equal(q1('SELECT ended_by FROM emergency_activations WHERE id = ?', r.body.activation.id).ended_by, U.admin.id);
  assert.ok(!(await preview('admin', DEV, STORE)).triggers.some((t) => t.id === ALERT), 'switch off: no definitions on any screen');
  await api('/api/corporate/settings', J('admin', { emergency_triggers_enabled: true }, 'PUT', HQ));
});

test('edit: partial PUT keeps the rest; the scope and token rules apply again', async () => {
  let r = await api(`/api/corporate/emergency/${ALERT}`, J('admin', { scopes: [{ scope_kind: 'device', scope_id: DEV }] }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.match_token, 'EVAC');
  assert.equal(r.body.coverage.total, 1);
  r = await api(`/api/corporate/emergency/${ALERT}`, J('admin', { clear_token: 'DOORBELL' }, 'PUT', HQ));
  assert.equal(r.status, 409);
  r = await api(`/api/corporate/emergency/${ALERT}`, J('admin', { mode: 'once', max_duration_sec: 900 }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lease_sec, null); assert.equal(r.body.max_duration_sec, 900);
  // DEV2 left the scope: its trigger settings are the store's again.
  assert.equal((await api(`/api/devices/${DEV2}/trigger-config`, J('store', { http_port: 8095 }, 'POST', STORE))).status, 200);
});

/* ── store-trigger policy ─────────────────────────────────────────────────────────────────── */

test('store-trigger policy: impact list, acknowledgement, the stores told, and what a mandated screen receives', async () => {
  const CORP = mkPlaylist(HQ, 'Brand', alarmContent, 1);
  // This test walks the policy CHANGES, starting from "Show store triggers" ('allow'); the default
  // ('off') and the mandate-time acknowledgement are covered in corporate-store-trigger-default.test.js.
  run("UPDATE organizations SET corporate_enabled = 1, store_triggers_under_mandate = 'allow' WHERE id = ?", ORG);
  run("INSERT INTO corporate_mandates (id, organization_id, playlist_id, target_kind, target_id) VALUES (?, ?, ?, 'device', ?)", crypto.randomUUID(), ORG, CORP, DEV2);
  const st = await api('/api/triggers', J('store', { name: 'Fire relay', match_token: 'FIRE', mode: 'until_cleared', target_ref: STORE_PL,
    assignments: [{ target_type: 'device', target_id: DEV2 }] }, 'POST', STORE));
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const st2 = await api('/api/triggers', J('store', { name: 'Fire relay', match_token: 'FIRE', mode: 'until_cleared', target_ref: mkPlaylist(STORE2, 'S2 alert', storeContent),
    assignments: [{ target_type: 'device', target_id: DEV_S2 }] }, 'POST', STORE2));
  assert.equal(st2.status, 200, JSON.stringify(st2.body));

  let r = await get('admin', '/api/corporate/settings/store-trigger-impact?policy=leased&cap_sec=120', HQ);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.impact.map((i) => [i.name, i.workspace_name, i.screens]), [['Fire relay', 'Store 1', 1]]);
  assert.equal((await get('store', '/api/corporate/settings/store-trigger-impact?policy=off', STORE)).status, 403);

  r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'off' }, 'PUT', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_IMPACT_UNACKNOWLEDGED');
  assert.equal(r.body.impact.length, 1);
  assert.equal(q1('SELECT store_triggers_under_mandate AS p FROM organizations WHERE id = ?', ORG).p, 'allow', 'not stored');
  assert.ok((await preview('admin', DEV2, STORE)).triggers.some((t) => t.name === 'Fire relay'), 'allow: as before');

  r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'off', acknowledge_impact: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.store_triggers_affected, 1);
  assert.ok(!(await preview('admin', DEV2, STORE)).triggers.some((t) => t.name === 'Fire relay'), 'off: hidden on the mandated screen');
  assert.ok((await preview('admin', DEV_S2, STORE2)).triggers.some((t) => t.name === 'Fire relay'), 'never on a screen head office does not drive');
  const told = q1("SELECT workspace_id FROM activity_log WHERE action = 'corporate.store_triggers.limited'");
  assert.equal(told.workspace_id, STORE, 'the store is told in its own activity feed');
  assert.deepEqual((await get('store', '/api/triggers', STORE)).body.head_office.store_trigger_policy, { policy: 'off', cap_sec: 300 });

  r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'leased', store_trigger_cap_sec: 120, acknowledge_impact: true }, 'PUT', HQ));
  assert.equal(r.status, 200);
  assert.equal((await preview('admin', DEV2, STORE)).triggers.find((t) => t.name === 'Fire relay').lease_sec, 120);
  r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'allow' }, 'PUT', HQ));
  assert.equal(r.status, 200, 'going back to allow needs no acknowledgement');
  assert.equal((await preview('admin', DEV2, STORE)).triggers.find((t) => t.name === 'Fire relay').lease_sec, null);
});

test('delete: ends a live activation, removes the alert and its scope', async () => {
  let r = await api(`/api/corporate/emergency/${ALERT}/activate`, J('admin', { duration_sec: 300 }, 'POST', HQ));
  assert.equal(r.status, 201);
  r = await api(`/api/corporate/emergency/${ALERT}`, J('admin', undefined, 'DELETE', HQ));
  assert.equal(r.status, 200);
  assert.equal(q1('SELECT COUNT(*) AS n FROM triggers WHERE id = ?', ALERT).n, 0);
  assert.equal(q1('SELECT COUNT(*) AS n FROM emergency_trigger_scopes WHERE trigger_id = ?', ALERT).n, 0);
  assert.deepEqual(baseIds(await preview('admin', DEV, STORE)), [storeContent]);
  assert.equal((await api(`/api/corporate/emergency/${ALERT}`, J('admin', undefined, 'DELETE', HQ))).status, 404);
});

test('no write in this suite ran without an actor (backstop tripwire)', () => {
  assert.ok(!/backstop: write with no actor/.test(fs.readFileSync(LOG, 'utf8')));
});
