'use strict';

/*
 * The store-trigger policy DEFAULT ('off' = "Don't show store triggers") and the rule that makes
 * it safe: no change ever hides a store's trigger silently. Every change that NEWLY brings screens
 * under head office — creating a mandate, moving or re-enabling one, switching corporate playlists
 * on — lists the store triggers it would hide and is refused (409, nothing written) until the
 * admin acknowledges them. Real server, like corporate-emergency-routes.test.js.
 *
 * MUTATION CHECK (verified once by reverting and watching the named test go red):
 *   - routes/corporate.js POST /mandates: drop requireMandateImpactAck
 *       -> "⚠️ a mandate that would hide a store trigger is refused until acknowledged ..."
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
let STORE_PL, CORP, DEV, DEV3, DEV4;

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

let storeContent;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corp-stdef-'));
  LOG = path.join(DATA_DIR, 'server.log');
  await boot();
  for (const n of ['plat', 'admin', 'store']) await register(n);
  HQ = U.admin.ws;
  ORG = q1('SELECT organization_id FROM workspaces WHERE id = ?', HQ).organization_id;
  STORE = crypto.randomUUID();
  run('INSERT INTO workspaces (id, organization_id, name, slug) VALUES (?, ?, ?, ?)', STORE, ORG, 'Store 1', 'store-1');
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", STORE, U.store.id);
  const hqContent = mkContent(HQ, 'brand.png');
  storeContent = mkContent(STORE, 'offer.png');
  STORE_PL = mkPlaylist(STORE, 'Store own', storeContent);
  CORP = mkPlaylist(HQ, 'Brand', hqContent, 1);
  DEV = mkDevice(STORE, 'Till');
  DEV3 = mkDevice(STORE, 'Back wall');
  DEV4 = mkDevice(STORE, 'Door');
});

after(async () => { await stop(); });

const storeTrigger = async (name, token, deviceId) => {
  const r = await api('/api/triggers', J('store', { name, match_token: token, mode: 'until_cleared', target_ref: STORE_PL,
    assignments: [{ target_type: 'device', target_id: deviceId }] }, 'POST', STORE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
};
const mandate = (deviceId, extra = {}) => api('/api/corporate/mandates',
  J('admin', { target_kind: 'device', target_id: deviceId, playlist_id: CORP, ...extra }, 'POST', HQ));
const triggerNames = async (d) => ((await preview('admin', d, STORE)).triggers || []).map((t) => t.name);
const mandates = () => q1('SELECT COUNT(*) AS n FROM corporate_mandates').n;

test("a new organization's store-trigger policy is 'off' (Don't show store triggers)", async () => {
  assert.equal(q1('SELECT store_triggers_under_mandate AS p FROM organizations WHERE id = ?', ORG).p, 'off');
  const r = await api('/api/corporate/settings', J('admin', { hq_workspace_id: HQ, corporate_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.store_triggers_under_mandate, 'off');
  assert.equal((await get('admin', '/api/corporate/settings', HQ)).body.store_triggers_under_mandate, 'off');
  // No screen of this store is head office's yet: its Triggers page says nothing about a policy.
  assert.equal((await get('store', '/api/triggers', STORE)).body.head_office.store_trigger_policy, null);
});

test('⚠️ a mandate that would hide a store trigger is refused until acknowledged, and nothing is written', async () => {
  await storeTrigger('Fire relay', 'FIRE', DEV);
  const pv = await get('admin', `/api/corporate/mandates/preview?target_kind=device&target_id=${DEV}&playlist_id=${CORP}`, HQ);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.deepEqual(pv.body.preview.store_triggers_affected.map((i) => [i.name, i.workspace_name, i.screens]), [['Fire relay', 'Store 1', 1]]);
  assert.equal(pv.body.preview.store_trigger_policy, 'off');

  const r = await mandate(DEV);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CORPORATE_STORE_TRIGGERS_IMPACT');
  assert.deepEqual(r.body.impact.map((i) => i.name), ['Fire relay']);
  assert.match(r.body.error, /1 store trigger on screens/);
  assert.equal(mandates(), 0, 'a refusal writes nothing');
  assert.ok((await triggerNames(DEV)).includes('Fire relay'), 'the screen still shows the store trigger');
});

test('acknowledged: the mandate is saved, the trigger stops showing on that screen, and the store is told', async () => {
  const r = await mandate(DEV, { acknowledge_impact: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.store_triggers_affected, 1);
  assert.ok(!(await triggerNames(DEV)).includes('Fire relay'), 'hidden on the mandated screen');
  const audit = JSON.parse(q1("SELECT details FROM activity_log WHERE action = 'corporate.mandate.create' ORDER BY rowid DESC LIMIT 1").details);
  assert.deepEqual(audit.store_triggers_acknowledged.map((i) => i.name), ['Fire relay']);
  const told = q1("SELECT workspace_id FROM activity_log WHERE action = 'corporate.store_triggers.limited' ORDER BY rowid DESC LIMIT 1");
  assert.equal(told.workspace_id, STORE, "the store hears it in its own activity feed");
  assert.deepEqual((await get('store', '/api/triggers', STORE)).body.head_office.store_trigger_policy, { policy: 'off', cap_sec: 300 });
});

test('turning a disabled mandate back on asks again; turning it off never asks', async () => {
  const id = q1('SELECT id FROM corporate_mandates WHERE target_id = ?', DEV).id;
  let r = await api(`/api/corporate/mandates/${id}`, J('admin', { enabled: false }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await triggerNames(DEV)).includes('Fire relay'), 'back to the store: its trigger shows again');
  r = await api(`/api/corporate/mandates/${id}`, J('admin', { enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_STORE_TRIGGERS_IMPACT');
  assert.equal(q1('SELECT enabled FROM corporate_mandates WHERE id = ?', id).enabled, 0, 'not re-enabled by the refusal');
  r = await api(`/api/corporate/mandates/${id}`, J('admin', { enabled: true, acknowledge_impact: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // An edit that newly covers nothing (the screen is already head office's) needs no acknowledgement.
  r = await api(`/api/corporate/mandates/${id}`, J('admin', { note: 'Brand loop' }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('no store trigger on the screens: no acknowledgement needed', async () => {
  const r = await mandate(DEV3);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.store_triggers_affected, 0);
});

test('switching corporate playlists back on lists the triggers its existing mandates would hide', async () => {
  let r = await api('/api/corporate/settings', J('admin', { corporate_enabled: false }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await triggerNames(DEV)).includes('Fire relay'), 'off: the store drives its screen again');
  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true }, 'PUT', HQ));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'CORPORATE_IMPACT_UNACKNOWLEDGED');
  assert.deepEqual(r.body.impact.map((i) => i.name), ['Fire relay']);
  assert.equal(q1('SELECT corporate_enabled AS e FROM organizations WHERE id = ?', ORG).e, 0, 'not switched on by the refusal');
  r = await api('/api/corporate/settings', J('admin', { corporate_enabled: true, acknowledge_impact: true }, 'PUT', HQ));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await triggerNames(DEV)).includes('Fire relay'));
});

test("policy 'allow' (Show store triggers): a mandate never asks, and the trigger keeps showing", async () => {
  let r = await api('/api/corporate/settings', J('admin', { store_triggers_under_mandate: 'allow' }, 'PUT', HQ));
  assert.equal(r.status, 200, 'going to allow needs no acknowledgement');
  await storeTrigger('Door chime', 'CHIME', DEV4);
  r = await mandate(DEV4);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.store_triggers_affected, 0);
  assert.ok((await triggerNames(DEV4)).includes('Door chime'));
});
