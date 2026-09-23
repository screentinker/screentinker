'use strict';

/*
 * Display power schedules: the CRUD surface, tenancy, and the precedence rule.
 *
 * The assertions worth having here are the ones that are invisible until they cost someone a site
 * visit or a dark screen:
 *
 *   - DEVICE BEATS GROUP, including when the device's own schedule is DISABLED. Falling back to
 *     the group on `enabled = 0` would mean the only way to exempt one panel from a group schedule
 *     is to remove it from the group, and the operator who unticked the box watches it sleep anyway.
 *   - a schedule in ANOTHER workspace must be invisible and unaddressable, or one tenant darkens
 *     another tenant's screens.
 *   - a malformed window must be refused AT SAVE TIME. The evaluator is deliberately forgiving so
 *     one bad row can never darken a screen — which means a typo saves clean and silently does
 *     nothing for ever unless this layer is strict.
 *   - deleting a schedule must reach the screens that were following it, or they keep evaluating
 *     windows that no longer exist anywhere and go dark on a schedule nobody can find.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-dps-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, deviceId, groupId, dbFile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const api = (p) => BASE + '/api/display-power-schedules' + p;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `dps${Date.now()}@example.com`, password: 'Passw0rd123', name: 'DPS',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  // ⚠️ The router is routes/device-groups.js but it mounts at /api/groups — see config/api-surface.js.
  const g = await (await fetch(BASE + '/api/groups', J(jwt, { name: 'Lobby screens' }))).json();
  groupId = g.id;
  assert.ok(groupId, `group fixture failed: ${JSON.stringify(g)}`);

  // A device is created by PAIRING, not by an API call, so the harness inserts one directly — the
  // same approach triggers-crud.test.js takes. WAL makes the second writer fine.
  const Database = require('better-sqlite3');
  dbFile = path.join(DATA_DIR, 'db', 'remote_display.db');
  const raw = new Database(dbFile);
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby 1', workspaceId, 'offline');
  raw.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const NIGHTS = [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }];

async function createFor(target, extra = {}) {
  const r = await fetch(api('/'), J(jwt, { ...target, windows: NIGHTS, ...extra }));
  return { status: r.status, body: await r.json() };
}
async function del(id) { return (await fetch(api('/' + id), J(jwt, undefined, 'DELETE'))).status; }

/* ------------------------------------------------------------------ CRUD */

test('creates a device schedule and reads it back with the windows intact', async () => {
  const { status, body } = await createFor({ device_id: deviceId }, { name: 'Overnight' });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.schedule.device_id, deviceId);
  assert.equal(body.schedule.group_id, null);
  assert.equal(body.schedule.enabled, true);
  assert.deepEqual(body.schedule.windows, NIGHTS);

  const got = await (await fetch(api('/' + body.schedule.id), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.deepEqual(got.schedule.windows, NIGHTS, 'windows must survive the JSON round trip exactly');
  await del(body.schedule.id);
});

test('one schedule per target — the second create is refused and names the first', async () => {
  const a = await createFor({ device_id: deviceId });
  assert.equal(a.status, 201);
  const b = await createFor({ device_id: deviceId });
  assert.equal(b.status, 409);
  assert.equal(b.body.id, a.body.schedule.id, 'the conflict must point at the existing row, not just refuse');
  await del(a.body.schedule.id);
});

test('device XOR group: neither and both are refused', async () => {
  const neither = await fetch(api('/'), J(jwt, { windows: NIGHTS }));
  assert.equal(neither.status, 400);
  const both = await fetch(api('/'), J(jwt, { device_id: deviceId, group_id: groupId, windows: NIGHTS }));
  assert.equal(both.status, 400);
});

/* ------------------------------------------------------- save-time validation */

test('a malformed window is refused at SAVE time, not silently ignored at evaluation', async () => {
  /*
   * ⚠️ This is the whole reason the router validates at all. lib/power-window.js treats a junk
   * window as inert so a corrupt row can never darken a screen — which means without this check
   * an operator types "2500", the dashboard saves happily, and the schedule does nothing for ever
   * with no error anywhere.
   */
  const bad = [
    [{ days: [1], start: '2500', end: '06:00' }, /start/i],
    [{ days: [1], start: '22:00', end: '99:99' }, /end/i],
    [{ days: [], start: '22:00', end: '06:00' }, /day/i],
    [{ days: [7], start: '22:00', end: '06:00' }, /0-6/],
    [{ days: [1], start: '22:00', end: '22:00' }, /never active/i],
    [{ days: [1], start: '24:00', end: '06:00' }, /24:00/],
  ];
  for (const [w, re] of bad) {
    const r = await fetch(api('/'), J(jwt, { device_id: deviceId, windows: [w] }));
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(w)}`);
    const body = await r.json();
    assert.match(body.error, re, `error should explain: ${body.error}`);
  }
  const notArray = await fetch(api('/'), J(jwt, { device_id: deviceId, windows: 'nope' }));
  assert.equal(notArray.status, 400);
});

test('an unknown timezone is refused rather than stored for a panel to choke on', async () => {
  const r = await fetch(api('/'), J(jwt, { device_id: deviceId, windows: NIGHTS, timezone: 'Not/AZone' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /timezone/i);

  const ok = await createFor({ device_id: deviceId }, { timezone: 'America/Chicago' });
  assert.equal(ok.status, 201);
  await del(ok.body.schedule.id);
});

/* --------------------------------------------------------- the precedence rule */

test('DEVICE BEATS GROUP, and a disabled device schedule still beats it', async () => {
  const grp = await createFor({ group_id: groupId }, { name: 'Group nights' });
  assert.equal(grp.status, 201);

  // With only a group schedule, the member follows it.
  let eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.schedule.source, 'group');
  assert.equal(eff.schedule.id, grp.body.schedule.id);

  // Its own schedule wins.
  const dev = await createFor({ device_id: deviceId }, { name: 'This screen' });
  assert.equal(dev.status, 201);
  eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.schedule.source, 'device');
  assert.equal(eff.schedule.id, dev.body.schedule.id);

  /*
   * ⚠️ AND IT STILL WINS WHEN DISABLED. Unticking "enabled" on one screen means "this screen does
   * not sleep" — if that fell through to the group, the only way to exempt a panel would be to
   * remove it from the group, and the operator who unticked the box would watch it go dark anyway.
   */
  const off = await fetch(api('/' + dev.body.schedule.id), J(jwt, { enabled: false }, 'PUT'));
  assert.equal(off.status, 200);
  eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.schedule.source, 'device', 'a disabled device schedule must NOT fall back to the group');
  assert.equal(eff.schedule.enabled, false);
  assert.equal(eff.state, 'on', 'and a disabled schedule leaves the screen on');

  // Remove the device's own and the group's applies again.
  await del(dev.body.schedule.id);
  eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.schedule.source, 'group', 'deleting the override must fall back, not leave nothing');
  await del(grp.body.schedule.id);

  eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.schedule, null);
  assert.equal(eff.state, 'on', 'no schedule anywhere = lit');
});

test('effective reports the advisory next edge for the dashboard', async () => {
  const s = await createFor({ device_id: deviceId }, { timezone: 'America/Chicago' });
  const eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.ok(['on', 'scheduled_off'].includes(eff.state));
  if (eff.next_edge) {
    assert.match(eff.next_edge.at, /^\d{2}:\d{2}$/);
    assert.ok(['on', 'scheduled_off'].includes(eff.next_edge.to));
  }
  await del(s.body.schedule.id);
});

/* ------------------------------------------------------------------ tenancy */

test('another workspace cannot see, read, edit or delete this one\'s schedule', async () => {
  const mine = await createFor({ device_id: deviceId });
  assert.equal(mine.status, 201);
  const id = mine.body.schedule.id;

  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `dps-other${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();
  const otherJwt = other.token;

  const list = await (await fetch(api('/'), { headers: { Authorization: `Bearer ${otherJwt}` } })).json();
  assert.equal(list.schedules.length, 0, 'a foreign schedule must not even be listed');

  const H = { headers: { Authorization: `Bearer ${otherJwt}` } };
  assert.equal((await fetch(api('/' + id), H)).status, 404);
  assert.equal((await fetch(api('/effective/' + deviceId), H)).status, 404, 'nor may they ask about our device');
  assert.equal((await fetch(api('/' + id), J(otherJwt, { enabled: false }, 'PUT'))).status, 404);
  assert.equal((await fetch(api('/' + id), J(otherJwt, undefined, 'DELETE'))).status, 404);

  // And it is untouched.
  const still = await (await fetch(api('/' + id), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(still.schedule.enabled, true);
  await del(id);
});

test('a target in another workspace cannot be addressed', async () => {
  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `dps-t${Date.now()}@example.com`, password: 'Passw0rd123', name: 'T',
  }))).json();
  // Their token, our device.
  const r = await fetch(api('/'), J(other.token, { device_id: deviceId, windows: NIGHTS }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /device not found/i);
});

/* --------------------------------------------------------------- the payload */

test('the schedule rides the device payload, outside the item list', async () => {
  /*
   * ⚠️ Top-level, NOT in assignments. A power-schedule edit must never enter the player's
   * structural fingerprint or changing "off at 22:00" restarts playback (#234).
   */
  const s = await createFor({ device_id: deviceId }, { timezone: 'America/Chicago' });
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile, { readonly: true });
  const row = raw.prepare('SELECT COUNT(*) n FROM display_power_schedules WHERE device_id = ?').get(deviceId);
  raw.close();
  assert.equal(row.n, 1);

  const { powerScheduleForDevice } = require('../lib/device-power-schedule');
  assert.ok(typeof powerScheduleForDevice === 'function');
  await del(s.body.schedule.id);
});

/* -------------------------------------------------- the fan-out after a delete / retarget */

/*
 * ⚠️ THE FAILURE THESE EXIST FOR. devicesAffectedBySchedule returns CANDIDATES — the screens that
 * were following the row. After the row is gone, what each of them should now obey is a different
 * question, and the answer may be a group's schedule or nothing at all. Pushing the DELETED row's
 * windows, or pushing nothing, both leave a panel evaluating a schedule that no longer exists
 * anywhere in the product — and the only symptom is a screen going dark on a schedule nobody can
 * find in the dashboard.
 *
 * These connect a real device socket and assert on what the server actually EMITS, not on what the
 * resolver would return if asked. The resolver being right is necessary and not sufficient: the
 * route has to consult it per-device at push time.
 */

const ioClient = require('socket.io-client');

/** Connect as a device and collect what the server pushes, for `ms`. */
function listen(deviceId, token, ms = 1200) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { commands: [], payloads: [], registered: false };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => sock.emit('device:register', { device_id: deviceId, device_token: token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => { got.registered = true; });
    sock.on('device:command', (c) => got.commands.push(c));
    sock.on('device:playlist-update', (p) => got.payloads.push(p));
    sock.on('device:auth-error', () => finish());
    setTimeout(finish, ms);
  });
}

/** A paired device that declares the capability, so deliverCommand will actually send to it. */
async function pairedDevice() {
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile);
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString('hex');
  raw.prepare(`INSERT INTO devices (id, name, workspace_id, status, device_token, capabilities, platform)
               VALUES (?, ?, ?, 'offline', ?, ?, 'android')`)
    .run(id, 'Sched ' + id.slice(0, 4), workspaceId, token, JSON.stringify(['display.power', 'display.power_schedule']));
  raw.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(groupId, id);
  raw.close();
  return { id, token };
}

const powerCmds = (got) => got.commands.filter((c) => c.type === 'set_power_schedule');

test('delete a device schedule -> the member is pushed its GROUP schedule, not the deleted one', async () => {
  const dev = await pairedDevice();
  const grp = await createFor({ group_id: groupId }, { name: 'Group nights', timezone: 'America/Chicago' });
  assert.equal(grp.status, 201);

  // Give this one screen its own, different schedule.
  const own = await fetch(api('/'), J(jwt, {
    device_id: dev.id, name: 'Just this screen', timezone: 'America/Chicago',
    windows: [{ days: [0], start: '01:00', end: '02:00' }],
  }));
  assert.equal(own.status, 201);
  const ownId = (await own.json()).schedule.id;

  // Now delete it while the device is listening.
  const watching = listen(dev.id, dev.token, 1500);
  await sleep(300);
  assert.equal(await del(ownId), 200);
  const got = await watching;

  assert.ok(got.registered, 'the fixture device registered');
  const cmds = powerCmds(got);
  assert.ok(cmds.length >= 1, `expected a set_power_schedule push, got ${JSON.stringify(got.commands)}`);
  const pushed = cmds[cmds.length - 1].payload.schedule;
  assert.ok(pushed, 'a schedule must be pushed — the screen falls back to its group, not to nothing');
  assert.equal(pushed.source, 'group', 'it must be the GROUP schedule it now inherits');
  assert.equal(pushed.id, grp.body.schedule.id);
  assert.deepEqual(pushed.windows, NIGHTS, 'and the group windows, NOT the deleted row\'s 01:00-02:00');

  await del(grp.body.schedule.id);
});

test('delete the LAST schedule -> the device is pushed null, which is what clears it', async () => {
  const dev = await pairedDevice();
  const own = await fetch(api('/'), J(jwt, { device_id: dev.id, windows: NIGHTS, timezone: 'America/Chicago' }));
  assert.equal(own.status, 201);
  const ownId = (await own.json()).schedule.id;

  const watching = listen(dev.id, dev.token, 1500);
  await sleep(300);
  assert.equal(await del(ownId), 200);
  const got = await watching;

  const cmds = powerCmds(got);
  assert.ok(cmds.length >= 1, 'the screen must be told, or it keeps evaluating a deleted schedule for ever');
  assert.equal(cmds[cmds.length - 1].payload.schedule, null,
    'null is the clear — anything else leaves windows running that exist nowhere in the product');

  // And the payload it would get on any later reconnect agrees.
  const { powerScheduleForDevice } = require('../lib/device-power-schedule');
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile, { readonly: true });
  assert.equal(powerScheduleForDevice(raw, dev.id), null);
  raw.close();
});

test('retarget a schedule from a device to a group -> the device is pushed the NEW resolution', async () => {
  const dev = await pairedDevice();
  const own = await fetch(api('/'), J(jwt, {
    device_id: dev.id, timezone: 'America/Chicago',
    windows: [{ days: [0], start: '01:00', end: '02:00' }],
  }));
  assert.equal(own.status, 201);
  const ownId = (await own.json()).schedule.id;

  // Move it to the group the device belongs to, changing the windows at the same time.
  const watching = listen(dev.id, dev.token, 1500);
  await sleep(300);
  const put = await fetch(api('/' + ownId), J(jwt, { device_id: null, group_id: groupId, windows: NIGHTS }, 'PUT'));
  assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
  const got = await watching;

  const cmds = powerCmds(got);
  assert.ok(cmds.length >= 1, 'a retarget must reach the screens on BOTH sides of the move');
  const pushed = cmds[cmds.length - 1].payload.schedule;
  assert.ok(pushed, 'the device is still in that group, so it still has a schedule');
  assert.equal(pushed.source, 'group');
  assert.deepEqual(pushed.windows, NIGHTS);

  await del(ownId);
});

/* ------------------------------------- what the dashboard needs to not mislead the operator */

test('effective reports supported=false for a panel that cannot honour a schedule', async () => {
  /*
   * ⚠️ The dashboard uses this to DISABLE the editor. deliverCommand refuses set_power_schedule
   * without display.power_schedule, so on such a panel a saved schedule is a row nothing ever acts
   * on — and the operator walks away believing the shop lights go off at ten.
   */
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile);
  const dumb = crypto.randomUUID();
  raw.prepare(`INSERT INTO devices (id, name, workspace_id, status, capabilities, platform)
               VALUES (?, 'Old panel', ?, 'offline', ?, 'android')`)
    .run(dumb, workspaceId, JSON.stringify(['display.power']));   // the OLD capability only
  raw.close();

  const H = { headers: { Authorization: `Bearer ${jwt}` } };
  const eff = await (await fetch(api('/effective/' + dumb), H)).json();
  assert.equal(eff.supported, false, 'display.power alone must not imply an unattended schedule');

  const able = await (await fetch(api('/effective/' + deviceId), H)).json();
  assert.equal(typeof able.supported, 'boolean', 'the field is always present so the UI never guesses');
});

test('effective surfaces a multi-group conflict instead of silently picking one', async () => {
  /*
   * The resolver's ORDER BY group_id ASC stays — a stable documented winner is right for a
   * resolver. What is wrong is leaving it invisible: two group pages each look correct on their
   * own, and the only symptom is a screen going dark at the wrong time.
   */
  const g2 = await (await fetch(BASE + '/api/groups', J(jwt, { name: 'Also lobby' }))).json();
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile);
  raw.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(g2.id, deviceId);
  raw.close();

  const a = await createFor({ group_id: groupId }, { name: 'Ten o clock' });
  const b = await fetch(api('/'), J(jwt, {
    group_id: g2.id, name: 'Six o clock', windows: [{ days: [1], start: '18:00', end: '06:00' }],
  }));
  assert.equal(b.status, 201);
  const bId = (await b.json()).schedule.id;

  const eff = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(eff.group_schedules.length, 2, 'both must be reported so the dashboard can warn');
  assert.equal(eff.schedule.source, 'group');
  assert.equal(eff.group_schedules[0].id, eff.schedule.id,
    'the FIRST entry must be the one actually in force, so the UI can label it');
  assert.ok(eff.group_schedules.every((g) => g.group_name), 'named, so the operator knows where to look');

  await del(a.body.schedule.id);
  await del(bId);
  const after = await (await fetch(api('/effective/' + deviceId), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(after.group_schedules.length, 0, 'and the warning clears when the conflict does');
});
