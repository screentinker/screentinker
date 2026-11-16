'use strict';
const net = require('net');
const fs = require('fs');

/*
 * A TCP port for a test server to listen on.
 *
 * ⚠️ NOT FROM THE EPHEMERAL RANGE. This used to bind :0, read the OS-assigned port back and release
 * it. But the server itself also binds :0 (its loopback API, server.js), and so does every outgoing
 * connection: under parallel suites the port handed to suite B was then taken by suite A's
 * loopback listener before B's server started. B's server failed to bind, and B's requests reached
 * A's loopback API instead. Seen on CI as a shell script served as `application/json`
 * (scripts-route-absent-file) and a socket that never registered (heartbeat-floor-e2e).
 *
 * The kernel never assigns ports below the ephemeral range on its own, so pick a random one there
 * and confirm it is bindable on all interfaces (where the server listens). Two suites drawing the
 * same port from that range in the same instant is the remaining, far smaller, chance.
 */
const handedOut = new Set();

function ephemeralLow() {
  try {
    const lo = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
    if (Number.isInteger(lo) && lo > 2048) return lo;
  } catch { /* not Linux */ }
  return 49152;   // the IANA dynamic range, which macOS and Windows use
}
const LOW = 10000;
const HIGH = Math.max(LOW + 1000, ephemeralLow());   // exclusive

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW));
    if (handedOut.has(port)) continue;
    if (await canBind(port)) { handedOut.add(port); return port; }
  }
  throw new Error(`freePort: no bindable port found in ${LOW}-${HIGH - 1}`);
}

module.exports = { freePort, _range: { LOW, HIGH } };
