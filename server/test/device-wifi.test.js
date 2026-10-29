'use strict';

/*
 * #720 Wi-Fi networks of a screen (lib/device-wifi.js, routes/device-wifi.js).
 *
 * What these guard is invisible until it costs someone a network password or a screen in a van:
 *
 *   - the password NEVER comes back: not from this API, not masked, not in device lists, the
 *     preview payload, MCP or the activity log — and it is encrypted at rest, not merely hidden;
 *   - the routes are JWT-only, so an API token (and with it every MCP tool) gets a 401;
 *   - the list is only handed to a screen over TLS — native, or from a TRUSTED proxy that says
 *     https — and never over a plain socket unless the operator set WIFI_ALLOW_INSECURE;
 *   - a password that cannot be decrypted stops the push instead of sending a list without that
 *     network (the player would drop it);
 *   - a copied (replica) workspace never delivers: it holds no rows and would send an empty list;
 *   - what the player reports touches only its own rows and only known states.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');

const PASSWORD = 'correct-horse-battery-staple-42';
const SSID = 'Depot Uplink';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(extraEnv = {}) {
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'st-wifi-' + crypto.randomBytes(4).toString('hex'));
  const log = dataDir + '.log';
  const logFd = fs.openSync(log, 'w');
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', logFd, logFd],
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(log, 'utf8').slice(-2000));
  const jfetch = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    let body = null; try { body = await res.json(); } catch { /* */ }
    return { status: res.status, body, text: JSON.stringify(body) };
  };
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `wifi${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Passw0rd123', name: 'Wifi' }),
  });
  const db = new Database(path.join(dataDir, 'db', 'remote_display.db'));
  return { proc, base, jfetch, db, log, jwt: reg.body.token, userId: reg.body.user && reg.body.user.id, wsId: reg.body.current_workspace_id };
}

let S; // the main server
before(async () => { S = await boot(); });
after(() => { try { S.db.close(); } catch { /* */ } try { S.proc.kill('SIGKILL'); } catch { /* */ } });

const H = (tok, body, method) => ({
  method: method || (body === undefined ? 'GET' : 'POST'),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function makeDevice(srv, { wsId = srv.wsId } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  srv.db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, created_at)
    VALUES (?, 'Van panel', 'offline', ?, ?, 'apk', strftime('%s','now'))`).run(id, wsId, token);
  return { id, token };
}

/** A player socket. `https` sends X-Forwarded-Proto: https (from 127.0.0.1, which is a trusted proxy). */
function connect(srv, dev, { https = false, caps = ['net.wifi'], mode = 'direct' } = {}) {
  return new Promise((resolve, reject) => {
    const received = [];
    const s = ioClient(srv.base + '/device', {
      transports: ['websocket'], reconnection: false,
      extraHeaders: https ? { 'X-Forwarded-Proto': 'https' } : {},
    });
    s.on('device:wifi-networks', (d) => received.push(d));
    s.on('connect', () => s.emit('device:register', {
      device_id: dev.id, device_token: dev.token, capabilities: caps,
      device_info: { app_version: '3.0.4', wifi_mode: mode },
    }));
    s.on('device:registered', () => resolve({ s, received }));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}

const addNet = (srv, devId, body, tok = srv.jwt) => srv.jfetch(`/api/device-wifi/${devId}/networks`, H(tok, body));
const getWifi = (srv, devId, tok = srv.jwt) => srv.jfetch(`/api/device-wifi/${devId}`, H(tok));

/* ───────────────────────────────────────────────────────────── the door */

test('⚠️ an API token gets a 401 — and so does every MCP tool riding on one', async () => {
  const dev = makeDevice(S);
  const tok = (await S.jfetch('/api/tokens', H(S.jwt, { name: 'full', scope: 'full' }))).body.token;
  assert.ok(tok, 'token minted');
  assert.equal((await getWifi(S, dev.id, tok)).status, 401);
  assert.equal((await addNet(S, dev.id, { ssid: SSID, security: 'wpa2', password: PASSWORD }, tok)).status, 401);
});

test('a workspace viewer can read the list but not change it (the settings PIN rule)', async () => {
  const dev = makeDevice(S);
  assert.equal((await addNet(S, dev.id, { ssid: 'Office', security: 'open' })).status, 201);
  const other = await S.jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `viewer${Date.now()}@example.com`, password: 'Passw0rd123', name: 'V' }),
  });
  S.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')")
    .run(S.wsId, other.body.user.id);
  const read = await getWifi(S, dev.id, other.body.token);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.networks.length, 1);
  assert.equal((await addNet(S, dev.id, { ssid: 'Nope', security: 'open' }, other.body.token)).status, 403);
  const id = read.body.networks[0].id;
  assert.equal((await S.jfetch(`/api/device-wifi/${dev.id}/networks/${id}`, H(other.body.token, undefined, 'DELETE'))).status, 403);
});

test('a screen in someone else\'s workspace is not reachable', async () => {
  const stranger = await S.jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `stranger${Date.now()}@example.com`, password: 'Passw0rd123', name: 'X' }),
  });
  const dev = makeDevice(S);
  assert.equal((await getWifi(S, dev.id, stranger.body.token)).status, 403);
  assert.equal((await addNet(S, dev.id, { ssid: 'X', security: 'open' }, stranger.body.token)).status, 403);
});

/* ───────────────────────────────────────────────────────────── secrecy */

test('⚠️ the password NEVER comes back — not on create, read or update, not even masked', async () => {
  const dev = makeDevice(S);
  const c = await addNet(S, dev.id, { ssid: SSID, security: 'wpa2', password: PASSWORD });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.network.has_password, true);
  assert.equal(c.body.network.password, undefined);
  const r = await getWifi(S, dev.id);
  const u = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${c.body.network.id}`, H(S.jwt, { priority: 5 }, 'PUT'));
  assert.equal(u.status, 200, u.text);
  for (const blob of [c.text, r.text, u.text]) {
    assert.ok(!blob.includes(PASSWORD), 'the password escaped into a response');
    assert.ok(!blob.includes('*'.repeat(PASSWORD.length)), 'a mask at the real length says how long it is');
  }
});

test('⚠️ the password is encrypted AT REST', async () => {
  const rows = S.db.prepare('SELECT psk_enc FROM device_wifi_networks WHERE psk_enc IS NOT NULL').all();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!r.psk_enc.includes(PASSWORD) && !Buffer.from(r.psk_enc, 'base64').toString('latin1').includes(PASSWORD));
});

test('⚠️ nothing about the networks reaches device lists, the device row, preview-payload or MCP', async () => {
  const dev = makeDevice(S);
  const ssid = 'Leak Probe ' + crypto.randomBytes(3).toString('hex');
  assert.equal((await addNet(S, dev.id, { ssid, security: 'wpa2', password: PASSWORD })).status, 201);
  const tok = (await S.jfetch('/api/tokens', H(S.jwt, { name: 'read', scope: 'read' }))).body.token;
  const blobs = [
    (await S.jfetch('/api/devices', H(S.jwt))).text,
    (await S.jfetch(`/api/devices/${dev.id}`, H(S.jwt))).text,
    (await S.jfetch(`/api/devices/${dev.id}/preview-payload`, H(S.jwt))).text,
    (await S.jfetch('/api/devices', H(tok))).text,
    (await S.jfetch(`/api/devices/${dev.id}`, H(tok))).text,
  ];
  const mcp = await fetch(S.base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_display', arguments: { display_id: dev.id } } }),
  });
  blobs.push(await mcp.text());
  for (const b of blobs) {
    assert.ok(!b.includes(PASSWORD), 'the password leaked through a generic surface');
    assert.ok(!b.includes(ssid), 'the managed list leaked through a generic surface');
  }
});

test('⚠️ every change is in the activity log — the SSID, never the password', async () => {
  const dev = makeDevice(S);
  const c = await addNet(S, dev.id, { ssid: 'Audit Net', security: 'wpa3', password: PASSWORD });
  await S.jfetch(`/api/device-wifi/${dev.id}/networks/${c.body.network.id}`, H(S.jwt, { password: PASSWORD + 'x' }, 'PUT'));
  await S.jfetch(`/api/device-wifi/${dev.id}/networks/${c.body.network.id}`, H(S.jwt, undefined, 'DELETE'));
  const rows = S.db.prepare("SELECT action, details, user_id, device_id FROM activity_log WHERE device_id = ? AND action LIKE 'wifi_network_%' ORDER BY id").all(dev.id);
  assert.deepEqual(rows.map((r) => r.action), ['wifi_network_added', 'wifi_network_changed', 'wifi_network_removed']);
  for (const r of rows) {
    assert.equal(JSON.parse(r.details).ssid, 'Audit Net');
    assert.ok(r.user_id, 'who did it');
    assert.ok(!r.details.includes(PASSWORD), 'the password is in the audit trail');
  }
});

/* ───────────────────────────────────────────────────────────── validation and write semantics */

test('input is checked the way Android checks it', async () => {
  const dev = makeDevice(S);
  const bad = async (body, re) => {
    const r = await addNet(S, dev.id, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    if (re) assert.match(r.body.error, re);
  };
  await bad({ security: 'wpa2', password: PASSWORD }, /SSID/);
  await bad({ ssid: 'x'.repeat(33), security: 'open' }, /32 bytes/);
  await bad({ ssid: 'ü'.repeat(17), security: 'open' }, /32 bytes/); // 34 bytes
  await bad({ ssid: 'tab\there', security: 'open' }, /control/);
  await bad({ ssid: 'A', security: 'wep', password: PASSWORD }, /security/);
  await bad({ ssid: 'A', security: 'wpa2' }, /password is required/);
  await bad({ ssid: 'A', security: 'wpa2', password: 'short' }, /8 to 63/);
  await bad({ ssid: 'A', security: 'wpa3', password: 'a'.repeat(64) }, /8 to 63/);
  await bad({ ssid: 'A', security: 'open', password: PASSWORD }, /open network/);
  await bad({ ssid: 'A', security: 'open', priority: 101 }, /priority/);
  await bad({ ssid: 'A', security: 'open', priority: 1.5 }, /priority/);
  // A raw 64-hex key is a valid WPA2 credential.
  assert.equal((await addNet(S, dev.id, { ssid: 'Hex', security: 'wpa2', password: 'ab'.repeat(32) })).status, 201);
  assert.equal((await addNet(S, dev.id, { ssid: 'Hex', security: 'open' })).status, 409, 'one entry per SSID');
});

test('switching WPA2 → WPA3 keeps a password only if it is valid for WPA3', async () => {
  const dev = makeDevice(S);
  const hex = await addNet(S, dev.id, { ssid: 'HexNet', security: 'wpa2', password: 'ab'.repeat(32) });
  const r = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${hex.body.network.id}`, H(S.jwt, { security: 'wpa3' }, 'PUT'));
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.error, /again/);
  const pass = await addNet(S, dev.id, { ssid: 'PassNet', security: 'wpa2', password: PASSWORD });
  const ok = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${pass.body.network.id}`, H(S.jwt, { security: 'wpa3' }, 'PUT'));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.network.security, 'wpa3');
});

test('a screen holds at most 16 managed networks', async () => {
  const dev = makeDevice(S);
  for (let i = 0; i < 16; i++) assert.equal((await addNet(S, dev.id, { ssid: `N${i}`, security: 'open' })).status, 201);
  const r = await addNet(S, dev.id, { ssid: 'N16', security: 'open' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at most 16/);
});

test('⚠️ editing without a password KEEPS it; going open drops it; open → secured needs a new one', async () => {
  const dev = makeDevice(S);
  const c = await addNet(S, dev.id, { ssid: 'Keep', security: 'wpa2', password: PASSWORD });
  const id = c.body.network.id;
  const before = S.db.prepare('SELECT psk_enc FROM device_wifi_networks WHERE id = ?').get(id).psk_enc;
  // What a form round-trip sends: everything it shows, and an empty password field.
  const u = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${id}`, H(S.jwt, { ssid: 'Keep', security: 'wpa2', hidden: true, priority: 3, password: '' }, 'PUT'));
  assert.equal(u.status, 200, u.text);
  assert.equal(u.body.network.has_password, true);
  assert.equal(S.db.prepare('SELECT psk_enc FROM device_wifi_networks WHERE id = ?').get(id).psk_enc, before, 'the stored password was replaced');
  const open = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${id}`, H(S.jwt, { security: 'open' }, 'PUT'));
  assert.equal(open.body.network.has_password, false);
  assert.equal(S.db.prepare('SELECT psk_enc FROM device_wifi_networks WHERE id = ?').get(id).psk_enc, null);
  const back = await S.jfetch(`/api/device-wifi/${dev.id}/networks/${id}`, H(S.jwt, { security: 'wpa2' }, 'PUT'));
  assert.equal(back.status, 400);
});

/* ───────────────────────────────────────────────────────────── delivery */

test('⚠️ never over a plain connection: the screen gets nothing and the rows say why', async () => {
  const dev = makeDevice(S);
  const { s, received } = await connect(S, dev, { https: false });
  await sleep(300);
  const c = await addNet(S, dev.id, { ssid: 'Plain', security: 'wpa2', password: PASSWORD });
  assert.equal(c.body.delivery, 'insecure');
  await sleep(300);
  assert.equal(received.length, 0, 'a password went out over a plain socket');
  const st = await getWifi(S, dev.id);
  assert.equal(st.body.connection.online, true);
  assert.equal(st.body.connection.tls, false);
  assert.equal(st.body.networks[0].status, 'not_delivered');
  assert.equal(st.body.networks[0].status_reason, 'insecure_connection');
  s.close();
});

test('over TLS (a trusted proxy saying https) the list arrives, with the password, on change and on connect', async () => {
  const dev = makeDevice(S);
  let { s, received } = await connect(S, dev, { https: true });
  await sleep(300);
  const st0 = await getWifi(S, dev.id);
  assert.equal(st0.body.supported, true);
  assert.equal(st0.body.mode, 'direct', 'device_info.wifi_mode is stored');
  assert.equal(st0.body.connection.tls, true);
  const c = await addNet(S, dev.id, { ssid: SSID, security: 'wpa2', password: PASSWORD, priority: 7 });
  assert.equal(c.body.delivery, 'delivered');
  await sleep(300);
  const last = received[received.length - 1];
  assert.deepEqual(last.networks.map((n) => [n.ssid, n.security, n.password, n.priority, n.hidden]), [[SSID, 'wpa2', PASSWORD, 7, false]]);
  s.close();
  await sleep(300);
  // On the next connect the list comes again, unasked.
  ({ s, received } = await connect(S, dev, { https: true }));
  await sleep(500);
  assert.equal(received.length, 1, 'no push on connect');
  assert.equal(received[0].networks[0].ssid, SSID);
  s.close();
});

test('a screen without net.wifi is sent nothing (an older player would not understand the event)', async () => {
  const dev = makeDevice(S);
  const { s, received } = await connect(S, dev, { https: true, caps: ['playback.video'] });
  await sleep(300);
  const c = await addNet(S, dev.id, { ssid: 'Old', security: 'open' });
  assert.equal(c.body.delivery, 'unsupported');
  await sleep(300);
  assert.equal(received.length, 0);
  assert.equal((await getWifi(S, dev.id)).body.supported, false);
  s.close();
});

test('an unknown wifi_mode is stored as NULL, not trusted', async () => {
  const dev = makeDevice(S);
  const { s } = await connect(S, dev, { https: true, mode: 'root-everything' });
  await sleep(300);
  assert.equal(S.db.prepare('SELECT wifi_mode FROM devices WHERE id = ?').get(dev.id).wifi_mode, null);
  s.close();
});

test('⚠️ a password that cannot be decrypted stops the push instead of dropping that network', async () => {
  const dev = makeDevice(S);
  const { s, received } = await connect(S, dev, { https: true });
  await sleep(300);
  const a = await addNet(S, dev.id, { ssid: 'Good', security: 'wpa2', password: PASSWORD });
  assert.equal(a.body.delivery, 'delivered');
  const b = await addNet(S, dev.id, { ssid: 'Broken', security: 'wpa2', password: PASSWORD });
  S.db.prepare('UPDATE device_wifi_networks SET psk_enc = ? WHERE id = ?').run(Buffer.from('not a ciphertext at all, really').toString('base64'), b.body.network.id);
  await sleep(300);
  const n = received.length;
  const c = await addNet(S, dev.id, { ssid: 'Third', security: 'open' });
  assert.equal(c.body.delivery, 'password_unreadable');
  await sleep(300);
  assert.equal(received.length, n, 'a list without the broken network went out');
  s.close();
});

test('⚠️ a copied (replica) workspace never delivers — it would send an empty list', async () => {
  const dev = makeDevice(S);
  await addNet(S, dev.id, { ssid: 'On the primary', security: 'open' });
  S.db.prepare('UPDATE workspaces SET origin_node_id = ? WHERE id = ?').run('primary-node-uuid', S.wsId);
  try {
    // Writes to a copy are refused at the door (tenancy)...
    const c = await addNet(S, dev.id, { ssid: 'Replica', security: 'open' });
    assert.equal(c.status, 409, c.text);
    assert.equal(c.body.code, 'read_only_replica');
    // ...and a screen of a copied workspace is turned away before it could be sent this node's
    // (empty) copy of the list. push() refuses a copy as well ('not_owner'); this is the outer door.
    await assert.rejects(connect(S, dev, { https: true }), /read-only copy/);
  } finally {
    S.db.prepare('UPDATE workspaces SET origin_node_id = NULL WHERE id = ?').run(S.wsId);
  }
});

test('the player\'s report updates ITS rows only, and only with known states and reason codes', async () => {
  const dev = makeDevice(S);
  const other = makeDevice(S);
  const mine = (await addNet(S, dev.id, { ssid: 'Mine', security: 'open' })).body.network.id;
  const theirs = (await addNet(S, other.id, { ssid: 'Theirs', security: 'open' })).body.network.id;
  const { s } = await connect(S, dev, { https: true });
  await sleep(300);
  s.emit('device:wifi-result', {
    device_id: dev.id,
    results: [
      { id: mine, state: 'deferred', reason: 'connected_network_in_use' },
      { id: theirs, state: 'applied' },
    ],
  });
  await sleep(300);
  const m = S.db.prepare('SELECT status, status_reason FROM device_wifi_networks WHERE id = ?').get(mine);
  assert.deepEqual([m.status, m.status_reason], ['deferred', 'connected_network_in_use']);
  assert.notEqual(S.db.prepare('SELECT status FROM device_wifi_networks WHERE id = ?').get(theirs).status, 'applied',
    'a screen changed another screen\'s row');
  s.emit('device:wifi-result', { device_id: dev.id, results: [{ id: mine, state: 'pwned', reason: 'x' }, { id: mine, state: 'failed', reason: 'Free text <b>from the panel</b>' }] });
  await sleep(300);
  const m2 = S.db.prepare('SELECT status, status_reason FROM device_wifi_networks WHERE id = ?').get(mine);
  assert.deepEqual([m2.status, m2.status_reason], ['failed', null]);
  s.close();
});

/* ───────────────────────────────────────────────────────────── cleanup */

test('deleting a screen deletes its networks', async () => {
  const dev = makeDevice(S);
  await addNet(S, dev.id, { ssid: 'Gone', security: 'open' });
  const d = await S.jfetch(`/api/devices/${dev.id}`, H(S.jwt, undefined, 'DELETE'));
  assert.equal(d.status, 200, d.text);
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM device_wifi_networks WHERE device_id = ?').get(dev.id).n, 0);
});

test('moving a screen to another workspace leaves the old workspace\'s passwords behind', async () => {
  const dev = makeDevice(S);
  await addNet(S, dev.id, { ssid: 'Old WS', security: 'wpa2', password: PASSWORD });
  const toWs = crypto.randomUUID();
  const org = S.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(S.wsId).organization_id;
  S.db.prepare("INSERT INTO workspaces (id, name, organization_id) VALUES (?, 'Other', ?)").run(toWs, org);
  const m = await S.jfetch('/api/devices/move-workspace', H(S.jwt, { device_ids: [dev.id], workspace_id: toWs }));
  assert.equal(m.status, 200, m.text);
  assert.equal(S.db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(dev.id).workspace_id, toWs, 'moved');
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM device_wifi_networks WHERE device_id = ?').get(dev.id).n, 0);
});

test('the export leaves the table out and the import drops it explicitly', () => {
  const exportTables = require('../lib/trust/export-tables');
  assert.ok(!exportTables.EXPORTED.device_wifi_networks, 'Wi-Fi passwords in an organization export');
  assert.ok(exportTables.EXCLUDED.device_wifi_networks, 'classified, with a reason');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trust', 'import-restore.js'), 'utf8');
  assert.match(src, /NEVER_IMPORTED = Object\.freeze\(\['device_wifi_networks'\]\)/);
  const purge = fs.readFileSync(path.join(__dirname, '..', 'lib', 'user-deletion.js'), 'utf8');
  assert.match(purge, /'device_wifi_networks'/);
});

test('the mesh never replicates the table', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'replication.js'), 'utf8');
  assert.ok(!src.includes('device_wifi_networks'), 'the Wi-Fi table is in the replication list');
});

/* ───────────────────────────────────────────────────────────── the opt-out */

test('WIFI_ALLOW_INSECURE=1 lets a plain connection through, and says so at boot', async () => {
  const L = await boot({ WIFI_ALLOW_INSECURE: '1' });
  try {
    const dev = makeDevice(L);
    const { s, received } = await connect(L, dev, { https: false });
    await sleep(300);
    const c = await addNet(L, dev.id, { ssid: 'LAN only', security: 'wpa2', password: PASSWORD });
    assert.equal(c.body.delivery, 'delivered');
    await sleep(300);
    assert.equal(received[received.length - 1].networks[0].password, PASSWORD);
    assert.equal((await getWifi(L, dev.id)).body.connection.allow_insecure, true);
    assert.match(fs.readFileSync(L.log, 'utf8'), /WIFI_ALLOW_INSECURE is set/);
    s.close();
  } finally {
    try { L.db.close(); } catch { /* */ }
    L.proc.kill('SIGKILL');
  }
});
