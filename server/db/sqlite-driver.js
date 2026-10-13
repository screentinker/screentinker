'use strict';

/*
 * WHICH SQLite driver this process uses, decided at RUNTIME.
 *
 * There are two: the native `better-sqlite3`, and `./sqlite-compat.js` — a better-sqlite3-shaped
 * façade over Node's built-in `node:sqlite`. Both work; they differ in what they need from the host.
 *
 * WHY THIS EXISTS. The BrightSign player package used to be MANUFACTURED: the packager dropped
 * better-sqlite3 from package.json and then installed the shim into node_modules under the name
 * `better-sqlite3`, so every require resolved to it by construction. That worked, and it shipped a
 * code path CI had never executed — the same shape as the TELEMETRY_COLLECTOR TDZ crash that took
 * production down while 1676 tests were green. A build-time rewrite cannot be tested by the build it
 * rewrites.
 *
 * Deciding at runtime instead means ONE artifact, and both paths are reachable from a test:
 * ST_SQLITE_DRIVER=node runs the whole suite on the built-in driver, on an ordinary developer
 * machine, with no player involved.
 *
 * ⚠️ CONSTRUCT A DATABASE, do not merely require it. better-sqlite3's entry point is plain
 * JavaScript that loads its compiled .node binding LAZILY, so `require()` succeeds under a Node
 * whose ABI the binary was never built for. Opening an in-memory database is what actually pulls the
 * binding in — this is the same reasoning as lib/preflight-deps.js, learned from a real Node 18/20
 * mismatch that reported a broken install as healthy.
 *
 * ⚠️ FALLING BACK IS NOT ALWAYS RIGHT. On a server that is SUPPOSED to have the native module, a
 * silent downgrade would hide a broken install behind slightly different behaviour — so
 * ST_SQLITE_DRIVER=better-sqlite3 makes the failure loud instead. The default is to fall back,
 * because the alternative on a player is a server that will not boot at all.
 */

const FORCED = String(process.env.ST_SQLITE_DRIVER || '').trim();

let Database = null;
let driverName = null;
let fallbackReason = null;

function loadNative() {
  // ⚠️ Before the require: on a too-old Node the binary segfaults, which no catch below can see.
  const tooOld = require('./native-floor').nativeUnsupported();
  if (tooOld) throw new Error(tooOld);
  const D = require('better-sqlite3');
  // The ABI check. Touches no file.
  new D(':memory:').close();
  return D;
}

if (FORCED === 'node' || FORCED === 'node:sqlite') {
  Database = require('./sqlite-compat');
  driverName = 'node:sqlite';
  fallbackReason = 'forced by ST_SQLITE_DRIVER';
} else {
  try {
    Database = loadNative();
    driverName = 'better-sqlite3';
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (FORCED === 'better-sqlite3') {
      // Asked for the native driver by name: refuse to quietly become something else.
      throw new Error('ST_SQLITE_DRIVER=better-sqlite3 was requested but it is not usable: ' + msg);
    }
    /*
     * ⚠️ NODE 24 IN PRACTICE. node:sqlite is unflagged only from Node 23.4; on the 22.x line it
     * exists solely behind --experimental-sqlite. So on a 22.x host with a broken native module
     * BOTH drivers are gone, and the bare failure would be "Cannot find module 'node:sqlite'" —
     * which names the fallback rather than the actual problem, on a server that is already down.
     */
    try {
      Database = require('./sqlite-compat');
    } catch (inner) {
      throw new Error(
        'No usable SQLite driver. better-sqlite3 failed with: ' + msg +
        ' — and the built-in node:sqlite is unavailable on ' + process.version +
        ' (it is unflagged only from Node 23.4; 22.x needs --experimental-sqlite). ' +
        'Upgrade Node to 22.14 or newer (or run Node 24), or rebuild better-sqlite3 for this Node.');
    }
    driverName = 'node:sqlite';
    fallbackReason = msg;
  }
}

module.exports = { Database, driverName, fallbackReason };
