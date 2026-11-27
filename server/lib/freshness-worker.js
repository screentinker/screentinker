'use strict';

/*
 * The worker end of lib/freshness-runner.js: open the database read-only, compute one workspace's
 * freshness report per message, post it back.
 *
 * ⚠️ ITS OWN CONNECTION, OPENED READ-ONLY (the same reasoning as lib/mesh/read-worker.js). A
 * better-sqlite3 handle cannot cross threads, and readonly makes "the report cannot write" a property
 * of the file descriptor. WAL lets this reader and the main thread's writer run side by side.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { Database, driverName } = require('../db/sqlite-driver');
const freshness = require('./freshness');

let db = null;
try {
  /*
   * ⚠️ THE SAME SQLITE AS THE MAIN THREAD, OR NOTHING. Two different SQLite builds sharing one WAL
   * file is how production's database was corrupted on 2026-11-22 (an older sqlite3 CLI beside the
   * app). The driver choice is made at runtime and could in principle land differently here (native
   * better-sqlite3 vs node:sqlite), so a mismatch refuses to open; the runner then serves no report
   * rather than risk it.
   */
  if (workerData.driverName && driverName !== workerData.driverName) {
    throw new Error(`sqlite driver mismatch (main thread ${workerData.driverName}, worker ${driverName})`);
  }
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  // A reader only waits on a lock while the WAL is being reset; never long, but never fail on it.
  try { db.pragma('busy_timeout = 2000'); } catch (_) { /* driver without pragma(): default */ }
} catch (e) {
  parentPort.postMessage({ fatal: true, reason: (e && e.message) || 'could not open the database' });
}

parentPort.on('message', (msg) => {
  if (!msg || msg.id === undefined) return;
  if (!db) return parentPort.postMessage({ id: msg.id, error: 'database not open' });
  try {
    // keep:false: this thread's copy of the module is not the cache the server reads from.
    const report = freshness.computeWorkspace(db, msg.workspaceId, { now: msg.now, useCache: false, keep: false });
    parentPort.postMessage({ id: msg.id, report });
  } catch (e) {
    // One bad workspace costs one report, never the worker and every other report in flight.
    parentPort.postMessage({ id: msg.id, error: (e && e.message) || 'report failed' });
  }
});
