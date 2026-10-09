'use strict';
// A real time zone for a fresh display. ⚠️ Raspberry Pi OS ships Europe/London, so a Pi set up
// without the Imager's locale step ran its schedules on UK time from anywhere (a Pi 4 in Chicago).
//  - GET /api/public/timezone: the zone Cloudflare places the caller in (cf-timezone), asked by
//    the installers of OUR server, no third-party geo-IP; null without Cloudflare in front.
//  - Pairing: a display still on a default zone gets the pairing admin's browser zone, for the
//    LAN servers that can't see where a display is. Never over an override or a chosen zone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { freePort } = require('./helpers/free-port');
const tz = require('../lib/device-timezone');

// ---------------------------------------------------------------------- pure rules

test('requestTimezone: the cf-timezone header, validated', () => {
  const req = (h) => ({ get: (n) => (n.toLowerCase() === 'cf-timezone' ? h : undefined) });
  assert.equal(tz.requestTimezone(req('America/Chicago')), 'America/Chicago');
  for (const bad of [undefined, '', 'Mars/Olympus', "America/Chicago'", 'a'.repeat(65), 'America/Chicago\n']) {
    assert.equal(tz.requestTimezone(req(bad)), null, JSON.stringify(bad));
  }
  assert.equal(tz.requestTimezone(null), null);
});

test('pairingTimezone: only a default zone is replaced, never an override or a chosen zone', () => {
  const dev = (reported, override = 'UTC') => ({ reported_timezone: reported, timezone: override });
  for (const d of [null, 'Europe/London', 'UTC', 'Etc/UTC']) {
    assert.equal(tz.pairingTimezone(dev(d), 'America/Chicago'), 'America/Chicago', `from ${d}`);
  }
  assert.equal(tz.pairingTimezone(dev('Asia/Tokyo'), 'America/Chicago'), null, 'a zone somebody chose is kept');
  assert.equal(tz.pairingTimezone(dev('Europe/London', 'Europe/Paris'), 'America/Chicago'), null, 'an operator override wins');
  assert.equal(tz.pairingTimezone(dev('Europe/London'), 'Europe/London'), null, 'already right: nothing to send');
  for (const bad of [undefined, '', 'Mars/Olympus', "x'"]) assert.equal(tz.pairingTimezone(dev('UTC'), bad), null);
  assert.equal(tz.pairingTimezone(null, 'America/Chicago'), null);
});

// ---------------------------------------------------------------------- the real server

let BASE, proc, JWT;
const DATA_DIR = path.join(os.tmpdir(), 'st-tz-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-tz-' + crypto.randomBytes(4).toString('hex') + '.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'op@test.local', password: 'test12345', name: 'Op' }) });
  JWT = (await r.json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('GET /api/public/timezone answers from Cloudflare, null without it, and is never cached', async () => {
  let r = await fetch(BASE + '/api/public/timezone', { headers: { 'cf-timezone': 'America/Chicago' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { timezone: 'America/Chicago' });
  assert.match(r.headers.get('cache-control') || '', /no-store/, 'one cached answer would give every Pi the first caller\'s zone');
  r = await fetch(BASE + '/api/public/timezone');
  assert.deepEqual(await r.json(), { timezone: null }, 'a self-hosted server without Cloudflare cannot say');
  r = await fetch(BASE + '/api/public/timezone', { headers: { 'cf-timezone': 'Mars/Olympus' } });
  assert.deepEqual(await r.json(), { timezone: null });
});

// A native player: provisions with a pairing code, declares system.time, reports its OS zone,
// then stays connected to see what pairing sends it.
function nativePlayer(code, reportedZone, caps = ['system.time']) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const commands = [];
    sock.on('device:command', (c) => commands.push(c));
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code, capabilities: caps, device_info: { app_version: 'test', platform: 'linux/aarch64' } }));
    sock.on('device:registered', (d) => {
      sock.emit('device:heartbeat', { device_id: d.device_id, telemetry: { timezone: reportedZone, device_utc: Date.now() } });
      setTimeout(() => resolve({ sock, commands, id: d.device_id }), 300);
    });
    setTimeout(() => resolve(null), 4000);
  });
}
async function pair(code, browserTz) {
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: code, browser_timezone: browserTz }) });
  return r.status;
}
const rnd = () => String(crypto.randomInt(100000, 1000000));
const zoneCommands = (p) => p.commands.filter((c) => c.type === 'set_timezone').map((c) => c.payload && c.payload.timezone);

test('pairing sends the admin\'s browser zone to a display still on Pi OS\'s Europe/London default', async () => {
  const code = rnd();
  const p = await nativePlayer(code, 'Europe/London');
  assert.ok(p, 'provisioned');
  assert.equal(await pair(code, 'America/Chicago'), 200);
  await sleep(400);
  p.sock.close();
  assert.deepEqual(zoneCommands(p), ['America/Chicago']);
});

test('pairing leaves a chosen zone alone, and a player that cannot set its zone gets nothing', async () => {
  let code = rnd();
  let p = await nativePlayer(code, 'Asia/Tokyo');
  assert.equal(await pair(code, 'America/Chicago'), 200);
  await sleep(400); p.sock.close();
  assert.deepEqual(zoneCommands(p), [], 'Asia/Tokyo was somebody\'s choice');

  code = rnd();
  p = await nativePlayer(code, 'Etc/UTC', []);   // declares no system.time (a web player, say)
  assert.equal(await pair(code, 'America/Chicago'), 200);
  await sleep(400); p.sock.close();
  assert.deepEqual(zoneCommands(p), [], 'unsupported: never sent');
});

test('pairing without a browser zone (an older dashboard, the API) still pairs and sends nothing', async () => {
  const code = rnd();
  const p = await nativePlayer(code, 'Europe/London');
  assert.equal(await pair(code, undefined), 200);
  await sleep(400); p.sock.close();
  assert.deepEqual(zoneCommands(p), []);
});
