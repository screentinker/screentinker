'use strict';
/*
 * ⚠️ brs-engine (inside brs-node and the browser build) GIVES roUrlTransfer A RANDOM IDENTITY FROM
 * 0 TO 79: `this.identity = Math.trunc(10 * Math.random() * 8)`. On a Roku, GetIdentity() is unique
 * per object, and roUrlEvent.GetSourceIdentity() is the ONLY way to tell which transfer an event
 * belongs to. SocketTask keeps two transfers on one port (the held poll and the POST), so in the
 * simulator they shared an identity about once in 80 creations, and their events were routed to
 * the wrong one: the POST's "ok" was taken as the poll's answer, then the real poll answer
 * (device:paired, device:playlist-update, a ping) was taken as the POST's and dropped. A dropped
 * ping means no pong; the next held GET then sits ahead of every POST (brs-node runs "async"
 * transfers one at a time, synchronously), and the server closes the session 65 s later
 * (PING_INTERVAL 5 s + PING_TIMEOUT 60 s). That is the CI flake of 2026-10-19/20: the app shows
 * its pairing code, goes silent for 65 s, "server closed", then "the app never received the
 * 4-item playlist" and every check after it.
 *
 * A real Roku cannot hit this. The fix is to give the simulator what the device has: one counter,
 * so no two live transfers share an identity. Patched in place, idempotently, before the app runs.
 * If a brs-node upgrade changes that line, this throws instead of silently running unpatched:
 * check whether upstream fixed it (then drop this file), or update the pattern.
 */

const fs = require('fs');
const path = require('path');

const BUGGY = 'this.identity=Math.trunc(10*Math.random()*8)';
// A per-thread counter from a random base: monotonic, so two live transfers never collide, and each
// Task thread (its own Worker, its own module instance) starts somewhere else.
const FIXED = 'this.identity=(globalThis.__stUrlTransferId=(globalThis.__stUrlTransferId||1e3*Math.floor(1e6*Math.random()))+1)';
const MARKER = 'globalThis.__stUrlTransferId=';

/** Returns the engine source with unique roUrlTransfer identities. Throws if the pattern is gone. */
function fixEngineSource(src, label = 'brs-engine') {
  if (src.includes(MARKER)) return src;
  const n = src.split(BUGGY).length - 1;
  if (n !== 1) {
    throw new Error(`${label}: expected the roUrlTransfer random-identity line once, found it ${n} times. `
      + 'brs-node/brs-engine changed: see roku/tests/lib/brs-fixes.js before trusting run-app.js again.');
  }
  return src.replace(BUGGY, FIXED);
}

/** Patch the brs.node.js that sits next to the given brs.cli.js (in place, idempotent). */
function fixBrsNode(brsCli) {
  const file = path.join(path.dirname(brsCli), 'brs.node.js');
  const src = fs.readFileSync(file, 'utf8');
  const out = fixEngineSource(src, file);
  if (out !== src) fs.writeFileSync(file, out);
}

module.exports = { fixEngineSource, fixBrsNode };
