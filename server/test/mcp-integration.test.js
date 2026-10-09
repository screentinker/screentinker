'use strict';

/*
 * The MCP endpoint end to end: the REAL server.js as a subprocess, real tokens, real loopback tool
 * calls, and a fake panel on the device socket.
 *
 * Every finding here was a 200 or a well-formed answer that was wrong — set_volume delivered an empty
 * payload, add_to_playlist dropped its duration, list_schedules ignored its filter, every tenant's
 * tool calls shared one rate-limit bucket — so each is asserted on what ARRIVED (at the panel, in the
 * database, in the audit log), not on the shape of the request we sent.
 *
 * Client addresses are simulated with X-Forwarded-For: the test talks to the server over loopback,
 * which `trust proxy` trusts, so req.ip becomes the forwarded address exactly as it would behind a
 * local nginx.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');
const { CAPABILITIES } = require('../lib/player-capabilities');

let PORT, BASE, proc, DB_PATH;
const DATA_DIR = path.join(os.tmpdir(), 'st-mcp-it-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const hdrs = (tok, ip, extra = {}) => ({
  'Content-Type': 'application/json',
  ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
  ...(ip ? { 'X-Forwarded-For': ip } : {}),
  ...extra,
});
const post = (tok, obj, ip) => ({ method: 'POST', headers: hdrs(tok, ip), body: JSON.stringify(obj) });

let rpcId = 0;
async function mcp(tok, method, params, ip, extraHeaders) {
  return jfetch('/mcp', {
    method: 'POST', headers: hdrs(tok, ip, extraHeaders),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
}
async function tool(tok, name, args, ip) {
  const r = await mcp(tok, 'tools/call', { name, arguments: args }, ip);
  return r;
}
const textOf = (r) => r.body && r.body.result && r.body.result.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r));

function openDb() {
  return new (require('better-sqlite3'))(DB_PATH, { timeout: 5000 });
}
// ⚠️ The server writes its audit row on the response's 'finish' (services/activity.js), in ANOTHER
// process: the reply can reach this test first, and a read straight after it found no row (seen
// once in CI on main). Wait briefly for it.
async function auditRow(sql) {
  for (let i = 0; i < 40; i++) {
    const db = openDb();
    const row = db.prepare(sql).get();
    db.close();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DB_PATH = path.join(DATA_DIR, 'db', 'remote_display.db');
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', MCP_CORS_ORIGINS: 'http://inspector.test:6274' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = async (email) => (await jfetch('/api/auth/register', post(null, { email, password: 'test12345', name: email }))).body;
  const u1 = await reg('m1@test.local');
  const u2 = await reg('m2@test.local');
  S.jwt = u1.token; S.user1 = u1.user.id; S.jwt2 = u2.token;
  S.tok = {};
  for (const scope of ['read', 'write', 'full']) {
    const c = await jfetch('/api/tokens', post(S.jwt, { name: scope, scope }));
    S.tok[scope] = c.body.token; S.wsA = c.body.workspace_id;
  }
  S.tokB = (await jfetch('/api/tokens', post(S.jwt2, { name: 'b', scope: 'write' }))).body.token;

  S.groupId = (await jfetch('/api/groups', post(S.jwt, { name: 'Lobby group' }))).body.id;
  S.groupId2 = (await jfetch('/api/groups', post(S.jwt, { name: 'Atrium group' }))).body.id;
  S.groupEmpty = (await jfetch('/api/groups', post(S.jwt, { name: 'Empty group' }))).body.id;

  const db = openDb();
  S.deviceId = crypto.randomUUID();
  S.deviceToken = 'devtok_' + crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO devices (id,name,user_id,workspace_id,device_token,status,created_at) VALUES (?,?,?,?,?,'offline',strftime('%s','now'))")
    .run(S.deviceId, 'Lobby TV', S.user1, S.wsA, S.deviceToken);
  S.deviceId2 = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id,name,user_id,workspace_id,device_token,status,created_at) VALUES (?,?,?,?,?,'offline',strftime('%s','now'))")
    .run(S.deviceId2, 'Back office', S.user1, S.wsA, 'devtok_' + crypto.randomBytes(16).toString('hex'));
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(S.groupId, S.deviceId);
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(S.groupId2, S.deviceId);
  db.close();

  // A fake panel: registers with every capability declared, and records each command it receives.
  S.commands = [];
  await new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    S.sock = sock;
    const t = setTimeout(() => reject(new Error('fake device did not register')), 8000);
    sock.on('connect', () => sock.emit('device:register', {
      device_id: S.deviceId, device_token: S.deviceToken,
      device_info: { app_version: 'test', capabilities: CAPABILITIES },
    }));
    sock.on('device:registered', () => { clearTimeout(t); resolve(); });
    sock.on('device:command', (c) => S.commands.push(c));
    sock.on('device:auth-error', () => reject(new Error('fake device auth-error')));
  });
});

after(() => {
  try { S.sock && S.sock.close(); } catch { /* */ }
  if (proc) proc.kill('SIGKILL');
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

async function waitForCommand(type, since) {
  for (let i = 0; i < 40; i++) {
    const hit = S.commands.slice(since).find((c) => c.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ───────────────────────────── 1. command scope ─────────────────────────────

test('a write token may send the five undoable commands, and nothing else', async () => {
  const dev = (tok, type, payload) => jfetch(`/api/devices/${S.deviceId}/command`, post(tok, { type, payload }, '192.0.2.11'));
  const grp = (tok, type) => jfetch(`/api/groups/${S.groupEmpty}/command`, post(tok, { type }, '192.0.2.11'));

  for (const type of ['refresh', 'screen_on', 'screen_off']) {
    assert.equal((await dev(S.tok.write, type)).status, 200, `write + ${type} on a device`);
    assert.equal((await grp(S.tok.write, type)).status, 200, `write + ${type} on a group`);
  }
  assert.equal((await dev(S.tok.write, 'set_volume', { level: 0.5 })).status, 200);
  for (const type of ['reboot', 'shell', 'install_apk', 'set_server_url', 'shutdown']) {
    const d = await dev(S.tok.write, type);
    assert.equal(d.status, 403, `write + ${type} must still need full`);
    assert.match(d.body.error, /need 'full'/);
    assert.equal((await grp(S.tok.write, type)).status, 403, `write + ${type} on a group must still need full`);
  }
  // A read token gets nothing, not even refresh.
  assert.equal((await dev(S.tok.read, 'refresh')).status, 403);
  assert.equal((await grp(S.tok.read, 'refresh')).status, 403);
  // full and a JWT session are unchanged.
  assert.equal((await dev(S.tok.full, 'reboot')).status, 200, 'full + reboot is allowed');
  assert.equal((await grp(S.tok.full, 'reboot')).status, 200, 'full + reboot on a group is allowed');
  assert.equal((await dev(S.jwt, 'reboot')).status, 200, 'a JWT session is not scope-gated');
});

test('send_command and send_group_command work with a write token through MCP', async () => {
  const r = await tool(S.tok.write, 'send_command', { display_id: S.deviceId, command: 'refresh' }, '192.0.2.12');
  assert.equal(r.body.result.isError, false, textOf(r));
  const g = await tool(S.tok.write, 'send_group_command', { group_id: S.groupId, command: 'screen_on' }, '192.0.2.12');
  assert.equal(g.body.result.isError, false, textOf(g));
});

// ───────────────────────────── 2. the level payload ─────────────────────────────

test('⚠️ set_volume and set_brightness reach the panel as payload.level, a 0..1 fraction', async () => {
  let since = S.commands.length;
  const r = await tool(S.tok.write, 'send_command', { display_id: S.deviceId, command: 'set_volume', value: 40 }, '192.0.2.13');
  assert.equal(r.body.result.isError, false, textOf(r));
  const vol = await waitForCommand('set_volume', since);
  assert.ok(vol, 'the panel never received set_volume');
  assert.deepEqual(vol.payload, { level: 0.4 }, 'what Android optDouble("level") and the native player read');

  since = S.commands.length;
  await tool(S.tok.write, 'send_group_command', { group_id: S.groupId, command: 'set_brightness', value: 75 }, '192.0.2.13');
  const bri = await waitForCommand('set_brightness', since);
  assert.ok(bri, 'the panel never received set_brightness');
  assert.deepEqual(bri.payload, { level: 0.75 });

  // And without a value it is refused before anything is sent, rather than muting the room.
  since = S.commands.length;
  const bad = await tool(S.tok.write, 'send_command', { display_id: S.deviceId, command: 'set_volume' }, '192.0.2.13');
  assert.equal(bad.body.error.code, -32602);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(S.commands.slice(since).length, 0, 'nothing reached the panel');
});

// ───────────────────────────── 3, 8. playlists and web pages ─────────────────────────────

test('add_to_playlist honours duration, and a web page is a webpage widget', async () => {
  const ip = '192.0.2.14';
  const pl = jsonOf(await tool(S.tok.write, 'create_playlist', { name: 'MCP deck' }, ip));
  const media = jsonOf(await tool(S.tok.write, 'add_media_url', { url: 'https://example.com/promo.mp4' }, ip));
  assert.equal(media.type, 'video/mp4');

  const item = await tool(S.tok.write, 'add_to_playlist', { playlist_id: pl.id, content_id: media.id, duration: 23 }, ip);
  assert.equal(item.body.result.isError, false, textOf(item));

  const page = await tool(S.tok.write, 'add_web_page', { url: 'https://example.com/menu?x=1' }, ip);
  assert.equal(page.body.result.isError, false, textOf(page));
  const w = jsonOf(page);
  assert.equal(w.kind, 'widget');
  assert.equal(w.type, 'webpage');
  assert.equal(w.url, 'https://example.com/menu?x=1');
  const wi = await tool(S.tok.write, 'add_to_playlist', { playlist_id: pl.id, widget_id: w.widget_id, duration: 45 }, ip);
  assert.equal(wi.body.result.isError, false, textOf(wi));

  const db = openDb();
  const rows = db.prepare('SELECT content_id, widget_id, duration_sec FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, rowid').all(pl.id);
  const widget = db.prepare('SELECT widget_type, config FROM widgets WHERE id = ?').get(w.widget_id);
  const pageAsContent = db.prepare("SELECT COUNT(*) n FROM content WHERE remote_url LIKE 'https://example.com/menu%'").get().n;
  db.close();
  assert.deepEqual(rows.map((r) => r.duration_sec), [23, 45], 'the route reads duration_sec; the tool must send it');
  assert.equal(rows[1].widget_id, w.widget_id);
  assert.equal(widget.widget_type, 'webpage');
  assert.equal(JSON.parse(widget.config).url, 'https://example.com/menu?x=1');
  assert.equal(pageAsContent, 0, 'a web page must never be stored as image/jpeg content again');

  // A URL that says nothing about what it is, with no type: refused, not guessed as JPEG.
  const unknown = await tool(S.tok.write, 'add_media_url', { url: 'https://example.com/stream' }, ip);
  assert.equal(unknown.body.error.code, -32602);
  const typed = jsonOf(await tool(S.tok.write, 'add_media_url', { url: 'https://example.com/stream', type: 'image' }, ip));
  assert.equal(typed.type, 'image/jpeg');
});

// ───────────────────────────── 4. schedules ─────────────────────────────

test('list_schedules filters by display_id', async () => {
  const pl = (await jfetch('/api/playlists', post(S.jwt, { name: 'Sched' }))).body.id;
  const mk = (device_id) => jfetch('/api/schedules', post(S.jwt, {
    device_id, playlist_id: pl, title: 'x', start_time: '2026-11-01T09:00', end_time: '2026-11-01T17:00',
  }));
  const a = await mk(S.deviceId);
  const b = await mk(S.deviceId2);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const all = jsonOf(await tool(S.tok.read, 'list_schedules', {}, '192.0.2.15'));
  const one = jsonOf(await tool(S.tok.read, 'list_schedules', { display_id: S.deviceId2 }, '192.0.2.15'));
  assert.ok(all.length >= 2);
  assert.ok(one.length >= 1 && one.every((s) => s.device_id === S.deviceId2), 'only the asked-for screen');
});

// ───────────────────────────── 5. groups ─────────────────────────────

test('list_displays and get_display report device-group membership, not the team', async () => {
  const list = jsonOf(await tool(S.tok.read, 'list_displays', {}, '192.0.2.16'));
  const lobby = list.find((d) => d.id === S.deviceId);
  // Ordered by group name: "Atrium group" before "Lobby group".
  assert.deepEqual(lobby.group_ids, [S.groupId2, S.groupId]);
  assert.equal(lobby.group_id, S.groupId2, 'group_id is the first, for older clients');
  const back = list.find((d) => d.id === S.deviceId2);
  assert.deepEqual(back.group_ids, []);
  assert.equal(back.group_id, null);

  const one = jsonOf(await tool(S.tok.read, 'get_display', { display_id: S.deviceId }, '192.0.2.16'));
  assert.deepEqual(one.group_ids, [S.groupId2, S.groupId]);
});

// ───────────────────────────── 6. body parsing ─────────────────────────────

test('⚠️ malformed JSON is a JSON-RPC parse error, and the 1 MB limit holds', async () => {
  const bad = await jfetch('/mcp', { method: 'POST', headers: hdrs(S.tok.read, '192.0.2.17'), body: '{"jsonrpc":"2.0",' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /application\/json/);
  assert.equal(bad.body.jsonrpc, '2.0');
  assert.equal(bad.body.error.code, -32700);
  assert.ok(!/at .*\.js:\d+/.test(JSON.stringify(bad.body)), 'no stack trace');

  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1.2 * 1024 * 1024) } });
  const huge = await jfetch('/mcp', { method: 'POST', headers: hdrs(S.tok.read, '192.0.2.17'), body: big });
  assert.equal(huge.status, 413, 'a 1.2 MB body must be refused');
  assert.equal(huge.body.error.code, -32600);

  // A normal request still works.
  const ok = await mcp(S.tok.read, 'ping', {}, '192.0.2.17');
  assert.deepEqual(ok.body.result, {});
});

// ───────────────────────────── 7. client attribution ─────────────────────────────

test('⚠️ two tenants on different addresses have separate rate-limit budgets', async () => {
  // /api/content allows 30 a minute per client. B spends all of it through MCP...
  for (let i = 0; i < 30; i++) {
    const r = await tool(S.tokB, 'list_content', {}, '198.51.100.20');
    assert.equal(r.body.result.isError, false, `B call ${i + 1}: ${textOf(r)}`);
  }
  const b31 = await tool(S.tokB, 'list_content', {}, '198.51.100.20');
  assert.equal(b31.body.result.isError, true);
  assert.match(textOf(b31), /429/, 'B is limited on its own budget');
  // ...and A, from another address, is not affected.
  const a = await tool(S.tok.read, 'list_content', {}, '198.51.100.10');
  assert.equal(a.body.result.isError, false, `A was limited by B's calls: ${textOf(a)}`);
});

test('⚠️ the activity log records the agent\'s address, not 127.0.0.1', async () => {
  const r = await tool(S.tok.write, 'create_playlist', { name: 'attributed' }, '198.51.100.77');
  assert.equal(r.body.result.isError, false, textOf(r));
  const row = await auditRow("SELECT ip_address FROM activity_log WHERE action LIKE 'POST /api/playlists%' AND details LIKE '%attributed%' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'no audit row');
  assert.equal(row.ip_address, '198.51.100.77');
});

test('a forged forwarding header is ignored', async () => {
  const { HEADER } = require('../lib/forwarded-client-ip');
  // Well-formed but signed with the wrong key: the address falls back to the real client.
  const forged = `203.0.113.99;${Date.now()};${'ab'.repeat(32)}`;
  const r = await jfetch('/api/playlists', {
    method: 'POST',
    headers: hdrs(S.tok.write, '198.51.100.88', { [HEADER]: forged }),
    body: JSON.stringify({ name: 'forged-attrib' }),
  });
  assert.equal(r.status, 201);
  const row = await auditRow("SELECT ip_address FROM activity_log WHERE details LIKE '%forged-attrib%' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'no audit row');
  assert.equal(row.ip_address, '198.51.100.88', 'the forged address must not be believed');
});

// ───────────────────────────── 9. schema validation ─────────────────────────────

test('⚠️ arguments are checked against the tool schema before any API call', async () => {
  const ip = '192.0.2.19';
  const cases = [
    ['send_command', { display_id: S.deviceId, command: 'shell' }, /command must be one of/],
    ['list_displays', { search: 42 }, /search must be a string/],
    ['create_playlist', { name: ['a', 'b'] }, /name must be a string/],
    ['create_playlist', { name: 'x'.repeat(201) }, /longer than 200/],
    ['get_display', { display_id: 'x'.repeat(65) }, /longer than 64/],
    ['get_display', {}, /missing required argument: display_id/],
    ['add_to_playlist', { playlist_id: 'p', content_id: 'c', duration: 'ten' }, /duration must be an integer/],
  ];
  const before = S.commands.length;
  for (const [name, args, msg] of cases) {
    const r = await tool(S.tok.full, name, args, ip);
    assert.ok(r.body.error, `${name} ${JSON.stringify(args).slice(0, 60)} was not refused`);
    assert.equal(r.body.error.code, -32602);
    assert.match(r.body.error.message, msg);
  }
  assert.equal(S.commands.length, before, 'shell never reached the panel');
});

// ───────────────────────────── minor ─────────────────────────────

test('MCP-Protocol-Version echoes the negotiated version', async () => {
  const init = await mcp(S.tok.read, 'initialize', { protocolVersion: '2025-03-26' }, '192.0.2.20');
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.equal(init.headers.get('mcp-protocol-version'), '2025-03-26');
  const next = await mcp(S.tok.read, 'tools/list', {}, '192.0.2.20', { 'MCP-Protocol-Version': '2024-11-05' });
  assert.equal(next.headers.get('mcp-protocol-version'), '2024-11-05');
  const none = await mcp(S.tok.read, 'tools/list', {}, '192.0.2.20');
  assert.equal(none.headers.get('mcp-protocol-version'), require('../lib/mcp/protocol').LATEST);
});

test('a 403 that is not about scope does not blame the scope', async () => {
  // Another workspace's playlist: refused, but no wider token would help.
  const other = (await jfetch('/api/playlists', post(S.jwt2, { name: 'B private' }))).body.id;
  const r = await tool(S.tok.full, 'get_playlist', { playlist_id: other }, '192.0.2.21');
  assert.equal(r.body.result.isError, true);
  assert.match(textOf(r), /failed: 40[34]/);
  assert.ok(!/scope/.test(textOf(r)), `blamed the scope: ${textOf(r)}`);
});

test('list_playlists and rename_display answer with shapes, not rows', async () => {
  const list = jsonOf(await tool(S.tok.read, 'list_playlists', {}, '192.0.2.22'));
  assert.ok(list.length > 0);
  for (const p of list) {
    assert.deepEqual(Object.keys(p).filter((k) => !['smart', 'corporate', 'corporate_slot'].includes(k)).sort(),
      ['description', 'display_count', 'id', 'item_count', 'name', 'status']);
  }
  const ren = jsonOf(await tool(S.tok.write, 'rename_display', { display_id: S.deviceId2, name: 'Back office 2' }, '192.0.2.22'));
  assert.equal(ren.name, 'Back office 2');
  assert.ok(!('device_token' in ren) && !('user_id' in ren) && !('workspace_id' in ren));
});

test('/mcp sends no CORS headers to an unlisted origin, and does to a listed one', async () => {
  const pre = (origin) => fetch(BASE + '/mcp', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  const evil = await pre('http://evil.test');
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'an unlisted origin must not be approved');
  const listed = await pre('http://inspector.test:6274');
  assert.equal(listed.headers.get('access-control-allow-origin'), 'http://inspector.test:6274');
  assert.equal(listed.headers.get('access-control-allow-credentials'), null, 'bearer only: never credentials');
  // The rest of the API keeps its own policy (this instance is self-hosted: any origin).
  const api = await fetch(BASE + '/api/status', { headers: { Origin: 'http://evil.test' } });
  assert.equal(api.headers.get('access-control-allow-origin'), 'http://evil.test');
});

// Last: it exhausts this address's /mcp budget.
test('the /mcp 429 is JSON-RPC shaped and says when to retry', async () => {
  const ip = '192.0.2.250';
  let last;
  for (let i = 0; i < 121; i++) last = await mcp(S.tok.read, 'ping', {}, ip);
  assert.equal(last.status, 429);
  assert.equal(last.body.jsonrpc, '2.0');
  assert.equal(last.body.error.code, -32000);
  const ra = Number(last.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 60, `Retry-After ${last.headers.get('retry-after')}`);
  assert.equal(last.body.error.data.retryAfter, ra);
  // Another address is unaffected.
  assert.equal((await mcp(S.tok.read, 'ping', {}, '192.0.2.251')).status, 200);
});
