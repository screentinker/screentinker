'use strict';

// Wall layouts and holds over HTTP, against a real server: who may put which layout on a wall,
// what a hold item is stored as, and that a layout delete lets go of the walls that used it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

let PORT, BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-wall-routes-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const send = (method, tok, obj) => ({ method, ...auth(tok), body: JSON.stringify(obj) });
const register = async (email) => (await jfetch('/api/auth/register', send('POST', '', { email, password: 'test12345', name: email }))).body.token;
const twoZones = [
  { name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
  { name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
];

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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  S.a = await register('wall-a@test.local');
  S.b = await register('wall-b@test.local');
  S.layoutA = (await jfetch('/api/layouts', send('POST', S.a, { name: 'Wall A', width: 3840, height: 1080, zones: twoZones }))).body.id;
  S.layoutB = (await jfetch('/api/layouts', send('POST', S.b, { name: 'Wall B', zones: twoZones }))).body.id;
  S.wall = (await jfetch('/api/walls', send('POST', S.a, { name: 'Lobby' }))).body.id;
});
after(() => { try { proc.kill(); } catch { /* */ } });

test('a wall takes a layout from its own workspace, and the wall reads it back', async () => {
  const r = await jfetch(`/api/walls/${S.wall}`, send('PUT', S.a, { layout_id: S.layoutA }));
  assert.equal(r.status, 200);
  assert.equal(r.body.layout_id, S.layoutA);
});

test('a wall refuses another workspace\'s layout', async () => {
  const r = await jfetch(`/api/walls/${S.wall}`, send('PUT', S.a, { layout_id: S.layoutB }));
  assert.equal(r.status, 403);
  assert.equal((await jfetch(`/api/walls/${S.wall}`, auth(S.a))).body.layout_id, S.layoutA, 'unchanged');
});

test('an unknown layout is a 404, and "" clears the wall back to the plain canvas', async () => {
  assert.equal((await jfetch(`/api/walls/${S.wall}`, send('PUT', S.a, { layout_id: 'nope' }))).status, 404);
  const r = await jfetch(`/api/walls/${S.wall}`, send('PUT', S.a, { layout_id: '' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.layout_id, null);
});

test('deleting a layout lets go of the walls that used it (foreign keys are off here)', async () => {
  const tmp = (await jfetch('/api/layouts', send('POST', S.a, { name: 'Temp', zones: twoZones }))).body.id;
  await jfetch(`/api/walls/${S.wall}`, send('PUT', S.a, { layout_id: tmp }));
  assert.equal((await jfetch(`/api/layouts/${tmp}`, { method: 'DELETE', ...auth(S.a) })).status, 200);
  assert.equal((await jfetch(`/api/walls/${S.wall}`, auth(S.a))).body.layout_id, null);
});

test('a hold is stored as content with no bytes: hold://blank by default, hold://freeze on request', async () => {
  const blank = await jfetch('/api/content/hold', send('POST', S.a, {}));
  assert.equal(blank.status, 201);
  assert.equal(blank.body.mime_type, 'application/x-st-hold');
  assert.equal(blank.body.remote_url, 'hold://blank');
  assert.equal(blank.body.file_size, 0);
  const freeze = await jfetch('/api/content/hold', send('POST', S.a, { mode: 'freeze', name: 'Wait for B' }));
  assert.equal(freeze.body.remote_url, 'hold://freeze');
  assert.equal(freeze.body.filename, 'Wait for B');
  S.hold = freeze.body.id;
});

test('a hold refuses a junk mode, and cannot be turned into other content', async () => {
  assert.equal((await jfetch('/api/content/hold', send('POST', S.a, { mode: 'sideways' }))).status, 400);
  assert.equal((await jfetch(`/api/content/${S.hold}`, send('PUT', S.a, { mime_type: 'video/mp4' }))).status, 400);
  assert.equal((await jfetch(`/api/content/${S.hold}`, send('PUT', S.a, { remote_url: 'https://example.com/x.mp4' }))).status, 400);
});

test('a hold can switch between freeze and blank', async () => {
  const r = await jfetch(`/api/content/${S.hold}`, send('PUT', S.a, { remote_url: 'hold://blank' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.remote_url, 'hold://blank');
});

// ------------------------------------------------------------------ a wall as a screen

test('a wall takes a member, and then: a wall schedule is accepted, a schedule on its panel is refused', async () => {
  const dev = (await jfetch('/api/devices/web-player', send('POST', S.a, { name: 'Panel 1' }))).body;
  S.panel = dev.device.id;
  const put = await jfetch(`/api/walls/${S.wall}/devices`, send('PUT', S.a, { devices: [
    { device_id: S.panel, grid_col: 0, grid_row: 0, rotation: 0, canvas_x: 0, canvas_y: 0, canvas_width: 1920, canvas_height: 1080 },
  ] }));
  assert.equal(put.status, 200);
  const day = new Date().toISOString().slice(0, 10);
  const win = { start_time: `${day}T09:00:00`, end_time: `${day}T17:00:00` };
  const ok = await jfetch('/api/schedules', send('POST', S.a, { wall_id: S.wall, title: 'Lunch', ...win }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.wall_id, S.wall);
  assert.equal(ok.body.device_id, null);
  S.wallSchedule = ok.body.id;
  const panel = await jfetch('/api/schedules', send('POST', S.a, { device_id: S.panel, ...win }));
  assert.equal(panel.status, 409);
  assert.equal(panel.body.code, 'WALL_PANEL');
  const both = await jfetch('/api/schedules', send('POST', S.a, { wall_id: S.wall, device_id: S.panel, ...win }));
  assert.equal(both.status, 400);
});

test('another workspace cannot schedule this wall', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const r = await jfetch('/api/schedules', send('POST', S.b, { wall_id: S.wall, start_time: `${day}T09:00:00`, end_time: `${day}T10:00:00` }));
  assert.equal(r.status, 403);
});

test('the calendar names the wall a schedule targets', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const week = await jfetch(`/api/schedules/week?all=1&date=${day}`, auth(S.a));
  const ev = (week.body || []).find((e) => e.id === S.wallSchedule || e.schedule_id === S.wallSchedule);
  assert.ok(ev, 'the wall schedule is on the calendar');
  assert.equal(ev.wall_name, 'Lobby');
});

test('a command goes to every panel and is counted per panel', async () => {
  const r = await jfetch(`/api/walls/${S.wall}/command`, send('POST', S.a, { type: 'screen_on' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 1);
  assert.equal(r.body.sent + r.body.offline + r.body.unsupported, 1);
  assert.equal((await jfetch(`/api/walls/${S.wall}/command`, send('POST', S.a, { type: 'rm -rf' }))).status, 400);
  assert.equal((await jfetch(`/api/walls/${S.wall}/command`, send('POST', S.b, { type: 'screen_on' }))).status, 403);
});
