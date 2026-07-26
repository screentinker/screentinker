// Off-main-thread WAL checkpointer — main-thread controller.
//
// SQLite's default auto-checkpoint runs a synchronous, fsync-heavy checkpoint inline on the
// write that trips the 1000-page threshold; on slow storage that blocks the event loop for
// ~600-750ms on a ~60s beat (the periodic p99 spike). We disable inline auto-checkpoint on
// the MAIN connection and delegate checkpointing to a worker_threads worker that opens its
// OWN connection (see wal-checkpointer-worker.js) so the fsync blocks the worker, not the loop.
//
// FAILURE MODE this file closes: with wal_autocheckpoint=0, if the worker dies NOTHING
// checkpoints and the WAL grows until the disk fills. So an unexpectedly-dead worker is
// respawned (bounded retry); if it can't be kept alive, we re-enable a conservative inline
// autocheckpoint on the main connection as a degraded-but-safe fallback (occasional inline
// stall << unbounded WAL growth).
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');

let worker = null;
let mainDb = null;
let mainDbPath = null;
let stopping = false;        // true only during our own stopWalCheckpointer() teardown
let fallbackEngaged = false; // true once we've given up on the worker and re-armed inline autocheckpoint
const respawnAt = [];        // timestamps (ms) of recent respawns, for the rate window

function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'wal-checkpointer-worker.js'), {
    workerData: {
      dbPath: mainDbPath,                                        // string only (thread-safe handoff)
      intervalMs: config.walCheckpointIntervalMs,
      highWaterBytes: config.walCheckpointHighWaterMB * 1024 * 1024,
      starvationRuns: config.walCheckpointStarvationRuns,
    },
  });
  w.on('message', (m) => { if (m && m.log) console.log('[wal-checkpoint] ' + m.log); });
  w.on('error', (e) => console.error('[wal-checkpoint] worker error:', e && e.message)); // 'exit' handles recovery
  w.on('exit', (code) => onWorkerExit(code));
  // A worker thread cannot outlive its process; unref() also ensures it never KEEPS the
  // process alive during shutdown — so there's no orphaned worker/connection either way.
  w.unref();
  return w;
}

// Called on every worker 'exit'. Distinguishes our intentional teardown (stopping=true —
// stay silent, no respawn) from an unexpected death (respawn, then fall back if exhausted).
function onWorkerExit(code) {
  worker = null;
  if (stopping || fallbackEngaged) return;   // clean stop, or we've already given up — no noise
  console.warn(`[wal-checkpoint] worker died unexpectedly (code ${code}) — attempting respawn`);
  scheduleRespawn();
}

function scheduleRespawn() {
  if (stopping || fallbackEngaged) return;
  const now = Date.now();
  while (respawnAt.length && now - respawnAt[0] > config.walCheckpointRespawnWindowMs) respawnAt.shift();
  if (respawnAt.length >= config.walCheckpointRespawnMax) {
    engageFallback();                        // too many respawns in the window -> give up
    return;
  }
  respawnAt.push(now);
  const t = setTimeout(() => {
    if (stopping || fallbackEngaged) return;
    try {
      worker = spawnWorker();
      console.warn(`[wal-checkpoint] worker respawned (${respawnAt.length}/${config.walCheckpointRespawnMax} in window)`);
    } catch (e) {
      console.error('[wal-checkpoint] respawn spawn failed: ' + (e && e.message));
      scheduleRespawn();                     // count this failure too
    }
  }, config.walCheckpointRespawnBackoffMs);
  if (t.unref) t.unref();                     // never let the backoff timer hold the process open
}

// Degraded-but-safe: re-arm a conservative inline autocheckpoint on the MAIN connection so
// the WAL can never grow unbounded, and reclaim the backlog the dead worker left behind.
function engageFallback() {
  if (fallbackEngaged) return;
  fallbackEngaged = true;
  try { mainDb.pragma(`wal_autocheckpoint = ${config.walCheckpointFallbackPages}`); } catch (_) {}
  try { mainDb.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}   // one-time reclaim of the dead-worker backlog
  console.error('[wal-checkpoint] worker unrecoverable — re-enabled inline autocheckpoint as fallback');
}

// Call ONCE at boot, after the DB is open + migrated. `db` is the main connection (used to
// flip the pragma, do the one-time handoff checkpoint, and arm the fallback if needed).
// `dbPath` is the STRING the worker uses to open its own handle — the main handle is never shared.
function startWalCheckpointer(db, dbPath) {
  if (worker) return worker;
  mainDb = db;
  mainDbPath = dbPath;
  stopping = false;
  fallbackEngaged = false;
  respawnAt.length = 0;

  // From now on the main thread NEVER inline-checkpoints (removes the loop-blocking fsync).
  try { db.pragma('wal_autocheckpoint = 0'); } catch (e) {
    if (!e.message.includes('Sqlite3UnsupportedStatement')) throw e;
  }

  // Hand the worker a clean WAL (one-time, at boot; explicit checkpoints are independent of
  // wal_autocheckpoint, so this still works at 0). Also reclaims any WAL a prior crash left.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best-effort */ }

  worker = spawnWorker();
  console.log(`[wal-checkpoint] off-thread checkpointer started (every ${config.walCheckpointIntervalMs}ms; escalate >${config.walCheckpointHighWaterMB}MB or ${config.walCheckpointStarvationRuns} growing runs; respawn max ${config.walCheckpointRespawnMax}/${config.walCheckpointRespawnWindowMs}ms)`);
  return worker;
}

// Graceful teardown: mark intentional (so onWorkerExit stays silent), ask the worker to stop
// (clears its timer + closes its connection), then force-terminate as a backstop. Safe when not started.
async function stopWalCheckpointer() {
  stopping = true;
  if (!worker) return;
  const w = worker;
  worker = null;
  try { w.postMessage({ stop: true }); } catch (_) {}
  await new Promise((r) => setTimeout(r, 150)); // let it close its handle cleanly
  try { await w.terminate(); } catch (_) {}
}

module.exports = { startWalCheckpointer, stopWalCheckpointer, _getWorker: () => worker };
