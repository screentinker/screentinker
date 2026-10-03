'use strict';

// The week calendar can answer two different questions, and it needs both.
//
// `?device_id=` answers "what plays on THIS screen" — the original behaviour, unchanged.
// `?all=1` answers "what is scheduled anywhere", which is what an operator actually needs
// to see. With a one-screen-at-a-time calendar you cannot tell whether an empty grid means
// nothing is scheduled or that you pointed the schedule at a different screen — and that is
// exactly the confusion a real user hit.
//
// The workspace for `all=1` comes from the caller's RESOLVED TENANCY, never from a raw
// client-supplied id. `all=1` filters on nothing but req.workspaceId, so the tenant boundary
// rests entirely on that resolution — asserted here rather than assumed. The platform-admin
// act-as path is pinned alongside it so the two are not confused for each other.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-schedall-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-schedall-' + crypto.randomBytes(4).toString('hex') + '.log');
const A = {}, B = {}, OWNER = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const auth = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

async function tenant(label, ip) {
  const email = label + crypto.randomBytes(4).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  });
  const me = await jfetch('/api/auth/me', { headers: auth(reg.body.token) });
  return { token: reg.body.token, wsId: me.body.accessible_workspaces[0].id,
           userId: reg.body.user.id, role: me.body.user ? me.body.user.role : reg.body.user.role };
}
const mkDevice = (ws, name) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id,name,status,workspace_id,reported_timezone,created_at)
              VALUES (?,?,'online',?, 'Asia/Tokyo', strftime('%s','now'))`).run(id, name, ws);
  return id;
};
const mkSchedule = (tok, body) => jfetch('/api/schedules', {
  method: 'POST', headers: auth(tok),
  body: JSON.stringify({ start_time: '2026-07-28T09:00:00', end_time: '2026-07-28T17:00:00', ...body }),
});
const week = (tok, q) => jfetch(`/api/schedules/week?date=2026-07-27T00:00:00.000Z&${q}`, { headers: auth(tok) });

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

  // The FIRST account on a fresh self-hosted instance is made platform_admin — the instance
  // owner — and platform staff can act-as into any workspace (lib/tenancy.js accessContext).
  // That is deliberate, so burn a throwaway owner here: A and B must both be ordinary users
  // or the cross-tenant assertion below would be testing the wrong thing.
  Object.assign(OWNER, await tenant('owner', '198.51.20.9'));
  Object.assign(A, await tenant('a', '198.51.20.1'));
  Object.assign(B, await tenant('b', '198.51.20.2'));
  assert.equal(A.role, 'user', 'A is an ordinary tenant, not the instance owner');
  assert.equal(B.role, 'user', 'B is an ordinary tenant, not the instance owner');

  A.lobby = mkDevice(A.wsId, 'Lobby screen');
  A.cafe = mkDevice(A.wsId, 'Cafe screen');
  B.theirs = mkDevice(B.wsId, 'Their screen');

  await mkSchedule(A.token, { device_id: A.lobby, title: 'Lobby morning' });
  await mkSchedule(A.token, { device_id: A.cafe, title: 'Cafe lunch' });
  await mkSchedule(B.token, { device_id: B.theirs, title: 'Other tenant' });
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('a single-screen calendar still shows only that screen', async () => {
  const r = await week(A.token, `device_id=${A.lobby}`);
  assert.equal(r.status, 200);
  const titles = r.body.map(e => e.title);
  assert.ok(titles.includes('Lobby morning'), 'its own schedule is there');
  assert.ok(!titles.includes('Cafe lunch'), 'another screen\'s schedule is not');
});

test('all=1 shows every screen in the workspace at once', async () => {
  const r = await week(A.token, 'all=1');
  assert.equal(r.status, 200);
  const titles = r.body.map(e => e.title);
  assert.ok(titles.includes('Lobby morning') && titles.includes('Cafe lunch'),
    'both screens appear on one grid');
});

test('every event names the screen it targets, so blocks can be told apart', async () => {
  const r = await week(A.token, 'all=1');
  const lobby = r.body.find(e => e.title === 'Lobby morning');
  const cafe = r.body.find(e => e.title === 'Cafe lunch');
  assert.equal(lobby.device_name, 'Lobby screen');
  assert.equal(cafe.device_name, 'Cafe screen');
});

test('days=N widens the window for the month view, and is capped', async () => {
  // Three and a half weeks past the requested Sunday: inside a 42-day month grid, outside the week.
  await mkSchedule(A.token, { device_id: A.lobby, title: 'Late August', start_time: '2026-08-20T09:00:00', end_time: '2026-08-20T10:00:00' });
  const wk = await week(A.token, 'all=1');
  assert.ok(!wk.body.map(e => e.title).includes('Late August'), 'the default seven-day window does not reach it');
  const month = await week(A.token, 'all=1&days=42');
  assert.equal(month.status, 200);
  assert.ok(month.body.map(e => e.title).includes('Late August'), 'a 42-day window does');
  const capped = await week(A.token, 'all=1&days=99999');
  assert.equal(capped.status, 200, 'an absurd value is clamped, not refused');
  assert.ok(capped.body.map(e => e.title).includes('Late August'));
  const junk = await week(A.token, 'all=1&days=banana');
  assert.equal(junk.body.length, wk.body.length, 'garbage falls back to the seven-day default');
});

test('all=1 NEVER crosses tenants', async () => {
  const r = await week(A.token, 'all=1');
  const titles = r.body.map(e => e.title);
  assert.ok(!titles.includes('Other tenant'), 'the other workspace is not visible');
  // An ordinary tenant cannot steer the scope from the query string either. resolveTenancy
  // does validate ?workspace_id= against access and falls through when there is none, but
  // all=1 filters on nothing except req.workspaceId, so this is the assertion that keeps
  // that true if the resolver's precedence is ever loosened.
  const steered = await week(A.token, `all=1&workspace_id=${B.wsId}`);
  assert.ok(Array.isArray(steered.body), 'still a normal response, not an error page');
  assert.ok(!steered.body.map(e => e.title).includes('Other tenant'),
    'a client-supplied workspace_id buys nothing without access to that workspace');
});

test('a platform admin acting-as another workspace sees that workspace, by design', async () => {
  // The counterpart to the test above: this is NOT a leak, it is the instance owner's
  // documented act-as path. Pinned so the distinction stays legible.
  const r = await week(OWNER.token, `all=1&workspace_id=${B.wsId}`);
  assert.equal(OWNER.role, 'platform_admin');
  assert.ok(r.body.map(e => e.title).includes('Other tenant'),
    'act-as resolves the requested workspace for platform staff');
});

test('a group schedule appears with its group name', async () => {
  const gid = crypto.randomUUID();
  db.prepare('INSERT INTO device_groups (id,user_id,workspace_id,name) VALUES (?,?,?,?)')
    .run(gid, A.userId, A.wsId, 'All lobby screens');
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?,?)').run(gid, A.lobby);
  await mkSchedule(A.token, { group_id: gid, title: 'Group evening' });

  const r = await week(A.token, 'all=1');
  const ev = r.body.find(e => e.title === 'Group evening');
  assert.ok(ev, 'the group schedule is on the all-screens grid');
  assert.equal(ev.group_name, 'All lobby screens');
  assert.ok(!ev.device_id, 'it targets a group, not a device');
});

test('asking for neither scope is refused rather than silently guessing', async () => {
  const r = await jfetch('/api/schedules/week?date=2026-07-27T00:00:00.000Z', { headers: auth(A.token) });
  assert.equal(r.status, 400);
});
