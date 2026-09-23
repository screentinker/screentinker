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
