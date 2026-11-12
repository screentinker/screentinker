'use strict';

/*
 * A STREAM SHOWN ON SCREENS RUNS AS LONG AS ITS STREAM.
 *
 * A person's share ends at the server's limit (an hour by default), and every player arms a local
 * backstop from the max_seconds it is sent, so a lost stop still frees the screen. A share the server
 * makes itself (a stream output on screens) has no server limit, so it must not be sent the person's
 * hour either: each screen would drop back to its playlist every hour and be re-shared seconds later.
 * It is sent the players' own cap on that backstop (8 h) instead.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sysmax-' + crypto.randomBytes(4).toString('hex'));
const config = require('../config');
config.screenShareEnabled = true;
const WebSocket = require('ws');
const share = require('../lib/screen-share');

const emitted = [];
const rooms = new Map();
share.init({ of: () => ({ adapter: { rooms }, to: (room) => ({ emit: (ev, data) => emitted.push({ room, ev, data }) }) }) });
const server = http.createServer(); share.attach(server);
after(() => { share._reset(); server.close(); });

async function startedWith(system) {
  await new Promise((r) => (server.listening ? r() : server.listen(0, '127.0.0.1', r)));
  const device = { id: crypto.randomUUID(), name: 'Lobby' };
  rooms.set(device.id, new Set(['sock']));
  const s = share.createSession({ device, workspace: { id: 'ws-1' }, sharedBy: 'Dan', system, streamId: system ? 'so-1' : undefined });
  assert.ok(s && s.ticket, s && s.error);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/screen-share/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'auth', ticket: s.ticket }));
  let got = null;
  for (let i = 0; i < 100 && !got; i++) { await new Promise((r) => setTimeout(r, 20)); got = emitted.find((e) => e.room === device.id && e.ev === 'device:screenshare-start'); }
  ws.close();
  assert.ok(got, 'the screen was told to start');
  return got.data;
}

test("a person's share is sent the server's limit", async () => {
  const d = await startedWith(false);
  assert.equal(d.max_seconds, Math.round((config.screenShareMaxMinutes || 60) * 60));
  assert.equal(d.plain, undefined);
});

test("a stream on screens is sent the players' 8 h cap, not the person's hour", async () => {
  const d = await startedWith(true);
  assert.equal(d.max_seconds, 8 * 3600);
  assert.equal(d.max_seconds, share.SYSTEM_MAX_SECONDS);
  assert.equal(d.plain, true);
});
