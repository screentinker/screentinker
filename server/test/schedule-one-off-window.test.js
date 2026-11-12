'use strict';

/*
 * A ONE-OFF SCHEDULE RUNS FOR THE WINDOW THE CALENDAR DRAWS.
 *
 * The schedule form has a start time and an end time and no end date. For a repeating schedule an
 * end earlier than the start has always meant "through midnight" (lib/schedule-recurrence.js), and
 * the calendar draws a one-off the same way: 21:00 to 06:00 is a block tonight and a block
 * tomorrow morning. But the engine reads a one-off as two full stamps, start <= now <= end, and a
 * one-off saved with both stamps on the same date and the end earlier than the start is a window
 * that can never contain a moment. It was stored exactly like that, drawn as overnight, and never
 * ran.
 *
 * The invariant: what is stored for a one-off is a window the engine can be inside of, and it is
 * the window the calendar shows. So the end of a same-date, end-before-start one-off is stored on
 * the following day, and an end that is genuinely before the start (an earlier date) is refused.
 * Repeating schedules keep their time-of-day meaning and are stored as sent.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');

// The engine's own predicate, loaded against a scratch database of its own.
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-oneoff-eng-' + crypto.randomBytes(4).toString('hex'));
const { isScheduleActiveAt } = require('../services/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE, admin, deviceId;
const DATA_DIR = path.join(os.tmpdir(), 'st-oneoff-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

const call = async (method, p, body) => {
  const res = await fetch(BASE + p, { method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};

/** The engine's view of a wall-clock moment: 2031-03-10 is a Monday. */
const at = (day, hh, mm) => ({ y: 2031, mo: 3, day, dow: (day - 9 + 70) % 7, min: hh * 60 + mm });
const active = (row, L) => isScheduleActiveAt(row, L);

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sched' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'S' }) })).json();
  admin = { token: reg.token, userId: reg.user.id, wsId: reg.current_workspace_id };
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  deviceId = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at)
              VALUES (?, 'Lobby', 'offline', ?, ?, ?, 'apk', strftime('%s','now'))`)
    .run(deviceId, admin.wsId, admin.userId, crypto.randomBytes(32).toString('hex'));
});

after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const base = () => ({ device_id: deviceId, title: 'Evening', timezone: 'America/Chicago' });

test('a one-off drawn through midnight runs through midnight', async () => {
  const r = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T21:00:00', end_time: '2031-03-10T06:00:00' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = r.body;
  assert.equal(String(row.start_time).slice(0, 16), '2031-03-10T21:00', 'the start is stored as sent');
  assert.equal(active(row, at(10, 20, 59)), false, 'not before it starts');
  assert.equal(active(row, at(10, 21, 30)), true, 'running half an hour in');
  assert.equal(active(row, at(11, 5, 59)), true, 'still running before the end, next morning');
  assert.equal(active(row, at(11, 6, 1)), false, 'over after the end');
  assert.equal(active(row, at(10, 5, 0)), false, 'and it did not run the morning BEFORE it started');
});

test('an ordinary same-day one-off is stored exactly as sent', async () => {
  const r = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T09:00:00', end_time: '2031-03-10T17:00:00' });
  assert.equal(r.status, 201);
  assert.equal(r.body.start_time, '2031-03-10T09:00:00');
  assert.equal(r.body.end_time, '2031-03-10T17:00:00');
});

test('a multi-day one-off is stored exactly as sent', async () => {
  const r = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T09:00', end_time: '2031-03-12T08:00' });
  assert.equal(r.status, 201);
  assert.equal(r.body.end_time, '2031-03-12T08:00');
});

test('a repeating overnight schedule keeps its time-of-day form and still runs through midnight', async () => {
  const r = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T21:00:00', end_time: '2031-03-10T06:00:00', recurrence: 'FREQ=DAILY' });
  assert.equal(r.status, 201);
  assert.equal(r.body.end_time, '2031-03-10T06:00:00', 'stored as sent');
  assert.equal(active(r.body, at(12, 23, 0)), true);
  assert.equal(active(r.body, at(13, 5, 0)), true);
  assert.equal(active(r.body, at(13, 12, 0)), false);
});

test('an end on an earlier date than the start is refused, on create and on edit', async () => {
  const r = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T09:00', end_time: '2031-03-09T17:00' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /end/i);
  const ok = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T09:00', end_time: '2031-03-10T17:00' });
  const e = await call('PUT', '/api/schedules/' + ok.body.id, { end_time: '2031-03-01T17:00' });
  assert.equal(e.status, 400, JSON.stringify(e.body));
  const still = db.prepare('SELECT end_time FROM schedules WHERE id = ?').get(ok.body.id);
  assert.equal(still.end_time, '2031-03-10T17:00', 'a refused edit changes nothing');
});

test('moving a one-off so it crosses midnight stores a window that runs', async () => {
  const ok = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T09:00', end_time: '2031-03-10T17:00' });
  const e = await call('PUT', '/api/schedules/' + ok.body.id, { start_time: '2031-03-10T22:00', end_time: '2031-03-10T02:00' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(active(e.body, at(10, 23, 0)), true);
  assert.equal(active(e.body, at(11, 1, 0)), true);
  assert.equal(active(e.body, at(11, 3, 0)), false);
});

test('turning a repeating overnight schedule into a one-off keeps it overnight', async () => {
  const rec = await call('POST', '/api/schedules', { ...base(), start_time: '2031-03-10T21:00', end_time: '2031-03-10T06:00', recurrence: 'FREQ=DAILY' });
  const e = await call('PUT', '/api/schedules/' + rec.body.id, { recurrence: null });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(active(e.body, at(10, 23, 0)), true);
  assert.equal(active(e.body, at(11, 5, 0)), true);
});

test('an edit that touches neither time nor repeat leaves the stored times alone', async () => {
  const id = crypto.randomUUID();
  // A row from before this rule, as it sits in existing databases.
  db.prepare(`INSERT INTO schedules (id, user_id, workspace_id, device_id, title, start_time, end_time, timezone, priority, color)
              VALUES (?, ?, ?, ?, 'Old', '2031-03-10T21:00:00', '2031-03-10T06:00:00', 'UTC', 0, '#3B82F6')`)
    .run(id, admin.userId, admin.wsId, deviceId);
  const e = await call('PUT', '/api/schedules/' + id, { color: '#FF0000', title: 'Old, recoloured' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.end_time, '2031-03-10T06:00:00', 'a recolour does not start a schedule that was not running');
});
