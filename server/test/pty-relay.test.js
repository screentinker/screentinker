'use strict';

/*
 * lib/pty-relay.js in isolation — the rules, with fake namespaces and a fake clock. The wiring is
 * proven end to end against a real server in pty-relay-socket.test.js; this file pins the edges
 * that are slow or awkward to reach through sockets (caps, idle timeout, which socket's disconnect
 * ends which session).
 *
 * The rule worth reading first: a session id is a bearer token for a shell. Every "dropped" below
 * is somebody holding a valid id from the wrong socket or the wrong device.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPtyRelay, MAX_FRAME_B64 } = require('../lib/pty-relay');

function harness(opts = {}) {
  const sent = [];   // { ns, to, event, payload }
  const mkNs = (name) => ({ to: (to) => ({ emit: (event, payload) => sent.push({ ns: name, to, event, payload }) }) });
  const clock = { t: 1_000_000 };
  const audits = [];
  const devices = Object.assign({
    'pi-1': { id: 'pi-1', caps: true, online: 'devsock-1' },
    'pi-2': { id: 'pi-2', caps: true, online: 'devsock-2' },
    'pi-3': { id: 'pi-3', caps: true, online: 'devsock-3' },
    'pi-nopty': { id: 'pi-nopty', caps: false, online: 'devsock-x' },
    'pi-off': { id: 'pi-off', caps: true, online: null },
    'pi-replica': { id: 'pi-replica', caps: true, online: 'devsock-r', replica: true },
  }, opts.devices || {});
  const relay = createPtyRelay({
    namespaces: () => ({ deviceNs: mkNs('device'), dashboardNs: mkNs('dashboard') }),
    authorize: (socket, id) => !(opts.forbid || []).includes(`${socket.userId}:${id}`),
    getDevice: (id) => devices[id] || null,
    canPty: (d) => d.caps,
    deviceSocketId: (id) => (devices[id] ? devices[id].online : null),
    refuseReason: (d) => (d.replica ? 'replica' : null),
    audit: (e) => audits.push(e),
    now: () => clock.t,
  });
  const sock = (id, userId = 'u1') => ({ id, userId, handshake: { address: '203.0.113.9' } });
  const last = (event) => [...sent].reverse().find((s) => s.event === event);
  return { relay, sent, clock, audits, sock, last, devices };
}

test('open sends device:pty-open to the device room and pty-opened to the opener only', () => {
  const h = harness();
  const a = h.sock('dash-a');
  const sid = h.relay.open(a, { device_id: 'pi-1', cols: 120, rows: 40 });
  assert.match(sid, /^[0-9a-f]{32}$/, 'a crypto-random session id');
  assert.deepEqual(h.last('device:pty-open'), { ns: 'device', to: 'pi-1', event: 'device:pty-open', payload: { session_id: sid, cols: 120, rows: 40 } });
  assert.deepEqual(h.last('dashboard:pty-opened'), { ns: 'dashboard', to: 'dash-a', event: 'dashboard:pty-opened', payload: { device_id: 'pi-1', session_id: sid } });
  assert.equal(h.audits[0].action, 'device_pty_open');
  assert.equal(h.audits[0].userId, 'u1');
  assert.equal(h.audits[0].deviceId, 'pi-1');
});

test('every refusal is named on dashboard:pty-error and nothing reaches the device', () => {
  const h = harness({ forbid: ['u1:pi-2'] });
  const a = h.sock('dash-a');
  const cases = [
    [{ device_id: 'pi-2' }, 'forbidden'],
    [{ device_id: 'nope' }, 'forbidden'],   // unknown device reads as forbidden, not "does not exist"
    [{ device_id: 'pi-nopty' }, 'unsupported'],
    [{ device_id: 'pi-off' }, 'offline'],
    [{ device_id: 'pi-replica' }, 'replica'],
  ];
  for (const [data, error] of cases) {
    let acked = null;
    assert.equal(h.relay.open(a, data, (x) => { acked = x; }), null);
    assert.deepEqual(h.last('dashboard:pty-error').payload, { device_id: data.device_id, error });
    assert.deepEqual(acked, { ok: false, error });
  }
  assert.equal(h.sent.filter((s) => s.ns === 'device').length, 0);
  assert.equal(h.audits.length, 0, 'a refused open is not an opened session');
});

test('caps: two sessions per device, four per user', () => {
  const h = harness();
  const a = h.sock('dash-a');
  assert.ok(h.relay.open(a, { device_id: 'pi-1' }));
  assert.ok(h.relay.open(a, { device_id: 'pi-1' }));
  assert.equal(h.relay.open(a, { device_id: 'pi-1' }), null);
  assert.equal(h.last('dashboard:pty-error').payload.error, 'too_many_sessions_device');
  assert.ok(h.relay.open(a, { device_id: 'pi-2' }));
  assert.ok(h.relay.open(a, { device_id: 'pi-2' }));
  assert.equal(h.relay.open(a, { device_id: 'pi-3' }), null);
  assert.equal(h.last('dashboard:pty-error').payload.error, 'too_many_sessions_user');
  // Another user is not held to the first user's count.
  assert.ok(h.relay.open(h.sock('dash-b', 'u2'), { device_id: 'pi-3' }));
});

test('input/resize/close are honoured only from the socket that opened the session', () => {
  const h = harness();
  const a = h.sock('dash-a');
  const other = h.sock('dash-other');   // same user, different tab: still not the owner
  const sid = h.relay.open(a, { device_id: 'pi-1' });
  const before = h.sent.length;
  assert.equal(h.relay.input(other, { session_id: sid, data: 'bHMK' }), false);
  assert.equal(h.relay.resize(other, { session_id: sid, cols: 10, rows: 10 }), false);
  assert.equal(h.relay.close(other, { session_id: sid }), false);
  assert.equal(h.sent.length, before, 'dropped silently — no error that confirms the id is live');

  assert.equal(h.relay.input(a, { session_id: sid, data: 'bHMK' }), true);
  assert.deepEqual(h.last('device:pty-input').payload, { session_id: sid, data: 'bHMK' });
  assert.equal(h.relay.resize(a, { session_id: sid, cols: 9999, rows: 0 }), true);
  assert.deepEqual(h.last('device:pty-resize').payload, { session_id: sid, cols: 500, rows: 24 }, 'clamped');
  assert.equal(h.relay.close(a, { session_id: sid }), true);
  assert.deepEqual(h.last('device:pty-close').payload, { session_id: sid });
  assert.deepEqual(h.last('dashboard:pty-exit').payload, { device_id: 'pi-1', session_id: sid, code: null, reason: 'closed_by_user' });
  assert.equal(h.audits.at(-1).action, 'device_pty_close');
});

test('device output is accepted only from the device the session is on, and goes to one socket', () => {
  const h = harness();
  const sid = h.relay.open(h.sock('dash-a'), { device_id: 'pi-1' });
  assert.equal(h.relay.fromDeviceData('pi-2', { session_id: sid, data: 'aGk=' }), false, 'another screen cannot write into it');
  assert.equal(h.relay.fromDeviceExit('pi-2', { session_id: sid, code: 0 }), false, 'nor end it');
  assert.equal(h.relay.fromDeviceData('pi-1', { session_id: sid, data: 'aGk=' }), true);
  const out = h.last('dashboard:pty-data');
  assert.equal(out.to, 'dash-a', 'addressed to the opening socket id, never a room');
  assert.deepEqual(out.payload, { device_id: 'pi-1', session_id: sid, data: 'aGk=' });
  assert.equal(h.relay.fromDeviceExit('pi-1', { session_id: sid, code: 130, reason: 'signal' }), true);
  assert.deepEqual(h.last('dashboard:pty-exit').payload, { device_id: 'pi-1', session_id: sid, code: 130, reason: 'signal' });
  assert.equal(h.relay._sessions.size, 0);
});

test('a frame over 64 KiB of base64 is dropped in either direction', () => {
  const h = harness();
  const a = h.sock('dash-a');
  const sid = h.relay.open(a, { device_id: 'pi-1' });
  const big = 'A'.repeat(MAX_FRAME_B64 + 4);
  assert.equal(h.relay.input(a, { session_id: sid, data: big }), false);
  assert.equal(h.relay.fromDeviceData('pi-1', { session_id: sid, data: big }), false);
  assert.equal(h.relay.input(a, { session_id: sid, data: 'A'.repeat(MAX_FRAME_B64) }), true, 'exactly the cap is fine');
  assert.equal(h.relay.input(a, { session_id: sid, data: { not: 'a string' } }), false);
  assert.equal(h.relay._sessions.size, 1, 'an oversized frame is dropped, the session survives');
});

test('the dashboard socket going away closes its sessions on the device', () => {
  const h = harness();
  const a = h.sock('dash-a'), b = h.sock('dash-b');
  const s1 = h.relay.open(a, { device_id: 'pi-1' });
  const s2 = h.relay.open(b, { device_id: 'pi-2' });
  h.relay.dashboardGone(a);
  assert.deepEqual(h.last('device:pty-close'), { ns: 'device', to: 'pi-1', event: 'device:pty-close', payload: { session_id: s1 } });
  assert.ok(!h.relay._sessions.has(s1));
  assert.ok(h.relay._sessions.has(s2), 'another tab\'s session is untouched');
  assert.equal(h.audits.at(-1).details.includes('reason=dashboard_disconnected'), true);
});

test('the device going away tells the dashboard device_offline — but only for ITS socket', () => {
  const h = harness();
  const a = h.sock('dash-a');
  const sid = h.relay.open(a, { device_id: 'pi-1' });
  h.relay.deviceGone('pi-1', 'devsock-OLD');   // a late disconnect from an evicted socket
  assert.ok(h.relay._sessions.has(sid), 'a stale socket cannot end a session opened on the new one');
  h.relay.deviceGone('pi-1', 'devsock-1');
  assert.deepEqual(h.last('dashboard:pty-exit').payload, { device_id: 'pi-1', session_id: sid, code: null, reason: 'device_offline' });
  assert.ok(!h.relay._sessions.has(sid));
});

test('30 minutes idle closes both sides; activity in either direction keeps it open', () => {
  const h = harness();
  const a = h.sock('dash-a');
  const sid = h.relay.open(a, { device_id: 'pi-1' });
  h.clock.t += 29 * 60 * 1000;
  h.relay.fromDeviceData('pi-1', { session_id: sid, data: 'eA==' });   // output counts as activity
  h.clock.t += 29 * 60 * 1000;
  h.relay.sweep();
  assert.ok(h.relay._sessions.has(sid), 'not idle: the device spoke 29 minutes ago');
  h.clock.t += 2 * 60 * 1000;
  h.relay.sweep();
  assert.ok(!h.relay._sessions.has(sid));
  assert.deepEqual(h.last('device:pty-close').payload, { session_id: sid });
  assert.equal(h.last('dashboard:pty-exit').payload.reason, 'idle_timeout');
});

test('system.pty is a real, separate capability and never a mesh command', () => {
  const caps = require('../lib/player-capabilities');
  assert.ok(caps.CAP_SET.has('system.pty'));
  assert.ok(caps.CAP_SET.has('system.shell'), 'the one-shot shell keeps its own name');
  assert.equal(caps.capabilityForCommand('shell'), 'system.shell', 'shell is still gated on system.shell, not pty');
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    assert.equal(list.includes('system.pty'), false, `${family} baseline must not hand out a terminal`);
  }
});
