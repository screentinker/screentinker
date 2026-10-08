'use strict';

// A schedule must be stored in the same timezone the player will evaluate it in.
//
// These two disagreed. Playback resolved the device's zone (an explicit operator override,
// else the zone the player's OS reports), while creation defaulted to a bare 'UTC' because
// the dialog never asked for one. So a user typed wall-clock hours, got UTC, and watched a
// screen that was correctly showing nothing — with no visible cue that the hours meant
// something other than what was typed.
//
// Observed with a real user: a schedule set 09:00-17:00 by someone in Asia/Tokyo, stored as
// UTC. Their window would not open until 18:00 local. Reported to us as "I added something
// and it didn't appear on the screen", which is exactly what it looks like from the outside.
//
// The rule pinned here: when the caller does not name a zone, inherit the TARGET's. An
// explicit zone from the caller always wins — this only fills the silence.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
const { effectiveDeviceTz } = require('../lib/device-timezone');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-schedtz-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-schedtz-' + crypto.randomBytes(4).toString('hex') + '.log');
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const auth = () => ({ Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' });
const mkDevice = (name, tz, reported) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id,name,status,workspace_id,timezone,reported_timezone,created_at)
              VALUES (?,?,'online',?,?,?,strftime('%s','now'))`).run(id, name, S.wsId, tz, reported);
  return id;
};
const createSchedule = (body) => jfetch('/api/schedules', {
  method: 'POST', headers: auth(),
  body: JSON.stringify({ start_time: '2026-07-28T09:00:00', end_time: '2026-07-28T17:00:00', ...body }),
});

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
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 's' + crypto.randomBytes(5).toString('hex') + '@x.local', password: 'Passw0rd123' }),
  });
  S.token = reg.body.token;
  const me = await jfetch('/api/auth/me', { headers: auth() });
  S.wsId = me.body.accessible_workspaces[0].id;
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('THE BUG: a schedule inherits the target screen\'s reported timezone, not UTC', async () => {
  const tokyo = mkDevice('Tokyo panel', null, 'Asia/Tokyo');
  const r = await createSchedule({ device_id: tokyo });
  assert.equal(r.status, 201, `created (got ${JSON.stringify(r.body)})`);
  assert.equal(r.body.timezone, 'Asia/Tokyo',
    'the hours are stored against the clock the screen actually runs on');
});

test('an explicit timezone from the caller always wins', async () => {
  const tokyo = mkDevice('Tokyo panel 2', null, 'Asia/Tokyo');
  const r = await createSchedule({ device_id: tokyo, timezone: 'Europe/Paris' });
  assert.equal(r.body.timezone, 'Europe/Paris', 'inheritance only fills the silence');
});

test('an operator override on the device beats the OS-reported zone', async () => {
  const d = mkDevice('Overridden', 'Europe/Berlin', 'Asia/Tokyo');
  const r = await createSchedule({ device_id: d });
  assert.equal(r.body.timezone, 'Europe/Berlin');
});

test("a device whose override is the legacy 'UTC' still inherits its reported zone", async () => {
  // 'UTC' is the historical default value, not a deliberate choice, so it is treated as unset.
  const d = mkDevice('Legacy UTC', 'UTC', 'Asia/Tokyo');
  const r = await createSchedule({ device_id: d });
  assert.equal(r.body.timezone, 'Asia/Tokyo');
});

test('a device that has never reported a zone falls back to UTC', async () => {
  const d = mkDevice('Silent', null, null);
  const r = await createSchedule({ device_id: d });
  assert.equal(r.body.timezone, 'UTC', 'no information -> the previous behaviour, explicitly');
});

test('a group inherits its leader\'s timezone', async () => {
  const leader = mkDevice('Group leader', null, 'Asia/Tokyo');
  const gid = crypto.randomUUID();
  db.prepare('INSERT INTO device_groups (id,user_id,workspace_id,name,leader_device_id) VALUES (?,?,?,?,?)')
    .run(gid, S.userId || db.prepare('SELECT id FROM users LIMIT 1').pluck().get(), S.wsId, 'G', leader);
  const r = await createSchedule({ group_id: gid });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.timezone, 'Asia/Tokyo');
});

// The property that actually matters: creation and playback must resolve identically,
// or a schedule runs in a different zone than the one it was written in.
test('creation and playback resolve the same zone from the same row', async () => {
  for (const [tz, reported, expected] of [
    [null, 'Asia/Tokyo', 'Asia/Tokyo'],
    ['UTC', 'Asia/Tokyo', 'Asia/Tokyo'],
    ['Europe/Berlin', 'Asia/Tokyo', 'Europe/Berlin'],
    [null, null, null],
  ]) {
    const d = mkDevice('cmp-' + crypto.randomBytes(3).toString('hex'), tz, reported);
    const row = db.prepare('SELECT timezone, reported_timezone FROM devices WHERE id = ?').get(d);
    const playback = effectiveDeviceTz(row);                       // ws/deviceSocket.js path
    const created = (await createSchedule({ device_id: d })).body.timezone;  // routes/schedules.js path
    assert.equal(playback, expected, `playback resolves ${expected}`);
    assert.equal(created, expected || 'UTC', 'creation agrees with playback');
  }
});

// start_time/end_time are wall clock in the schedule's zone (services/scheduler.js compares their
// first 16 characters with the screen's local time). An ISO instant with Z or an offset was stored
// as typed, so "00:00Z" for a Tokyo screen ran at 00:00 Tokyo, nine hours late. It is converted now.
test('a time sent with Z or an offset is converted to wall clock in the schedule\'s zone', async () => {
  const tokyo = mkDevice('Tokyo UTC input', null, 'Asia/Tokyo');
  const z = await createSchedule({ device_id: tokyo, start_time: '2026-07-28T00:00:00Z', end_time: '2026-07-28T08:00:00.000Z' });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  assert.equal(z.body.start_time, '2026-07-28T09:00');
  assert.equal(z.body.end_time, '2026-07-28T17:00');

  const off = await createSchedule({ device_id: tokyo, start_time: '2026-07-28T09:00+02:00', end_time: '2026-07-28T23:30+02:00' });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.equal(off.body.start_time, '2026-07-28T16:00');
  assert.equal(off.body.end_time, '2026-07-29T06:30', 'the date rolls over with the conversion');

  // An explicit zone wins, for the conversion as for the stored zone.
  const paris = await createSchedule({ device_id: tokyo, timezone: 'Europe/Paris', start_time: '2026-07-28T07:00Z', end_time: '2026-07-28T15:00Z' });
  assert.equal(paris.body.start_time, '2026-07-28T09:00');
  assert.equal(paris.body.timezone, 'Europe/Paris');

  // Plain wall clock is stored exactly as before.
  const plain = await createSchedule({ device_id: tokyo });
  assert.equal(plain.body.start_time, '2026-07-28T09:00:00');

  // PUT converts the same way.
  const put = await jfetch(`/api/schedules/${z.body.id}`, { method: 'PUT', headers: auth(), body: JSON.stringify({ start_time: '2026-07-28T01:00Z' }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.start_time, '2026-07-28T10:00');
  assert.equal(put.body.end_time, '2026-07-28T17:00', 'a field not sent is left alone');
});

test('a time with an offset is refused when no zone can be determined', async () => {
  const silent = mkDevice('Silent offset', null, null);
  const r = await createSchedule({ device_id: silent, start_time: '2026-07-28T09:00:00Z', end_time: '2026-07-28T17:00:00Z' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /YYYY-MM-DDTHH:MM/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM schedules WHERE device_id = ?').pluck().get(silent), 0, 'nothing saved');

  const ok = await createSchedule({ device_id: silent });
  assert.equal(ok.status, 201);
  const put = await jfetch(`/api/schedules/${ok.body.id}`, { method: 'PUT', headers: auth(), body: JSON.stringify({ end_time: '2026-07-28T18:00-05:00' }) });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  assert.match(put.body.error, /YYYY-MM-DDTHH:MM/);
  assert.equal(db.prepare('SELECT end_time FROM schedules WHERE id = ?').pluck().get(ok.body.id), '2026-07-28T17:00:00');
});
