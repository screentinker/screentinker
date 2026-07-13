'use strict';
const net = require('net');

// Allocate a free TCP port from the OS (bind :0 on loopback, read it back, release it).
// Subprocess test suites call this in before() instead of hand-picking a fixed/random port —
// the old 39xx scheme collided under CI load (a random port in the shared range, or a new
// suite reusing one), surfacing as flaky "no such table: devices" / FK errors when two servers
// raced on the same port. An OS-assigned ephemeral port per suite can't collide.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
