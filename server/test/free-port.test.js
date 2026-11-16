'use strict';

/*
 * helpers/free-port.js hands out ports BELOW the kernel's ephemeral range. The old version bound :0
 * and released the port, and under parallel suites that port was then taken by another suite's
 * server's own `listen(0)` (its loopback API): one suite's requests reached another suite's server.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const { freePort, _range } = require('./helpers/free-port');

test('ports come from below the ephemeral range, never from it', async () => {
  let lo = 49152;
  try { lo = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]); } catch { /* not Linux */ }
  assert.ok(_range.HIGH <= lo, `upper bound ${_range.HIGH} is at or below the ephemeral start ${lo}`);
  const ports = [];
  for (let i = 0; i < 25; i++) ports.push(await freePort());
  for (const p of ports) assert.ok(p >= _range.LOW && p < _range.HIGH, `${p} in range`);
  assert.equal(new Set(ports).size, ports.length, 'never the same port twice in one process');
});

test('a port it hands out can be listened on, on all interfaces', async () => {
  const port = await freePort();
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '0.0.0.0', () => srv.close(resolve));
  });
});

test('a port already in use is not handed out', async () => {
  const held = net.createServer();
  const port = await freePort();
  await new Promise((r) => held.listen(port, '0.0.0.0', r));
  try {
    for (let i = 0; i < 50; i++) assert.notEqual(await freePort(), port);
  } finally { held.close(); }
});
