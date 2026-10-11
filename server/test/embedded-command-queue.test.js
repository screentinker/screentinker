'use strict';

// Commands for an embedded (HTTP-polling) panel.
//
// An embedded panel has no socket. It picks a queued command up as X-ST-Command on its next poll,
// and between polls it deep-sleeps for as long as X-ST-Expires-In said: 30-60s on a normal dwell,
// many hours under a power schedule. The socket queue's 30s TTL would expire nearly every command
// first, so the dashboard said "queued" and the panel never rebooted. Pinned here: an embedded
// panel's command lives until it is due back, and a scheduled reboot is queued ONLY for an
// embedded panel — every other player keeps the direct emit it always had.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-embcmd-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const config = require('../config');
const queue = require('../lib/command-queue');
const { evaluateSchedules } = require('../services/scheduler');

after(() => { queue._resetForTests(); try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const now = () => Math.floor(Date.now() / 1000);
function mkDevice(fields) {
  const id = crypto.randomUUID();
  const cols = { id, name: 'Dev ' + id.slice(0, 4), status: 'online', last_heartbeat: now(), created_at: now(), ...fields };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO devices (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k]));
  return id;
}

test('a socket player keeps the 30s reconnect TTL', () => {
  const id = mkDevice({ client_type: 'apk', android_version: '13' });
  assert.equal(queue.ttlForDevice({ id }), config.commandQueueTtlMs);
});

test('an embedded panel holds its command until it is due back, plus a grace', () => {
  const id = mkDevice({ client_type: 'embedded', heartbeat_expected_by: now() + 8 * 3600 });
  const ttl = queue.ttlForDevice({ id });
  assert.ok(ttl >= 8 * 3600 * 1000 && ttl <= (8 * 3600 + 11 * 60) * 1000, `ttl ${ttl}`);
});

test('an embedded panel that never said when it is back gets the floor, not 30s', () => {
  const id = mkDevice({ client_type: 'embedded' });
  assert.ok(queue.ttlForDevice({ id }) >= 15 * 60 * 1000);
});

test('a queued command for an embedded panel survives past the socket TTL', () => {
  const id = mkDevice({ client_type: 'embedded', heartbeat_expected_by: now() + 3600 });
  const realNow = Date.now;
  try {
    queue.queueCommand(id, 'reboot', {}, { ttlMs: queue.ttlForDevice({ id }) });
    Date.now = () => realNow() + 10 * 60 * 1000;   // ten minutes later — long past 30s
    const cmds = queue.popPendingCommands(id);
    assert.deepEqual(cmds.map((c) => c.type), ['reboot']);
  } finally {
    Date.now = realNow;
  }
});

function fakeIo() {
  const emitted = [];
  const ns = {
    adapter: { rooms: new Map() },
    to: (room) => ({ emit: (ev, data) => emitted.push({ room, ev, data }) }),
  };
  return { io: { of: () => ns }, emitted };
}

function hhmmUtc() {
  const d = new Date();
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

test('scheduled reboot: an embedded panel is queued, a socket player is emitted to as before', () => {
  const emb = mkDevice({ client_type: 'embedded', power_source: 'usb', reported_timezone: 'Etc/UTC', reboot_schedule: hhmmUtc(),
    heartbeat_expected_by: now() + 3600 });
  // A device-owner Android player declares system.reboot; the plain baseline does not carry it.
  const apk = mkDevice({ client_type: 'apk', android_version: '13', reported_timezone: 'Etc/UTC', reboot_schedule: hhmmUtc(),
    capabilities: JSON.stringify(['system.reboot']) });

  const { io, emitted } = fakeIo();
  evaluateSchedules(io);

  assert.deepEqual(queue.popPendingCommands(emb).map((c) => c.type), ['reboot'], 'embedded: queued for its next poll');
  assert.ok(!emitted.some((e) => e.room === emb && e.ev === 'device:command'), 'embedded: no socket emit');

  assert.ok(emitted.some((e) => e.room === apk && e.ev === 'device:command' && e.data.type === 'reboot'), 'apk: direct emit');
  assert.deepEqual(queue.popPendingCommands(apk), [], 'apk: nothing queued to fire later on reconnect');
});
