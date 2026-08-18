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
const fs = require('fs');
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
      starvationFloorBytes: config.walCheckpointStarvationFloorMB * 1024 * 1024,   // #240
      escalateCooldownMs: config.walCheckpointEscalateCooldownMs,                  // #240
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
function engageFallback(reason) {
  if (fallbackEngaged) return;
  fallbackEngaged = true;
  try { mainDb.pragma(`wal_autocheckpoint = ${config.walCheckpointFallbackPages}`); } catch (_) {}
  // #240: reclaim the dead worker's backlog, but pick the CHEAPEST form that does the job.
  // The old unconditional TRUNCATE ran a blocking, fsync-heavy checkpoint on the MAIN
  // thread — on slow storage a single multi-second loop stall, and one that only ever
  // happens on a degraded server that can least afford it. PASSIVE reclaims what it can
  // without blocking; the blocking form is reserved for a WAL that is genuinely over the
  // high-water mark, where leaving it is the worse of the two risks.
  const over = walBytes() > config.walCheckpointHighWaterMB * 1024 * 1024;
  try { mainDb.pragma(`wal_checkpoint(${over ? 'TRUNCATE' : 'PASSIVE'})`); } catch (_) {}
  console.error(`[wal-checkpoint] ${reason || 'worker unrecoverable'} — re-enabled inline autocheckpoint as fallback (backlog reclaim: ${over ? 'TRUNCATE' : 'PASSIVE'})`);
}

// #240: the fallback is STICKY for the life of the process — once engaged, checkpoints are
// back on the main thread until a restart. That is exactly the shape of "it degrades with
// uptime and a restart fixes it", so it must be visible on /api/status rather than inferable
// only from a log line that may have rolled.
function getCheckpointerState() {
  return { worker: !!worker, fallbackEngaged, respawns: respawnAt.length, walBytes: walBytes() };
}

function walBytes() {
  try { return mainDbPath ? fs.statSync(mainDbPath + '-wal').size : 0; } catch (_) { return 0; }
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
  db.pragma('wal_autocheckpoint = 0');
  // Hand the worker a clean WAL (one-time, at boot; explicit checkpoints are independent of
  // wal_autocheckpoint, so this still works at 0). Also reclaims any WAL a prior crash left.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best-effort */ }

  /*
   * The worker may not be constructible AT ALL on some hosts.
   *
   * The respawn path below already catches a failed spawn, but this first one did not - and a
   * throw here escapes startWalCheckpointer and takes the whole server down at boot:
   *
   *     Failed to construct 'Worker': The V8 platform used by this instance of Node does not
   *     support creating Workers
   *
   * That is what an roHtmlWidget does: it is a Node context inside a renderer, and the renderer's
   * V8 platform has no worker threads. The module already knows how to run without one -
   * engageFallback() re-arms a conservative inline autocheckpoint - so the correct behaviour is
   * to degrade into it rather than refuse to start. A checkpointer that cannot get a thread is a
   * slower server; a checkpointer that throws is no server.
   */
  try {
    worker = spawnWorker();
  } catch (e) {
    engageFallback(`worker threads unavailable on this platform (${e && e.message})`);
    return null;
  }

  // #240: this line is where an operator learns the escalation policy, so it must state ALL of
  // it. It advertised only "3 growing runs" after the size floor and the cooldown were added,
  // which is the half that no longer holds on its own — and reading it during an incident would
  // send you looking for a checkpoint that the gates had in fact suppressed.
  console.log(
    `[wal-checkpoint] off-thread checkpointer started (PASSIVE every ${config.walCheckpointIntervalMs}ms; ` +
    `blocking TRUNCATE when the WAL exceeds ${config.walCheckpointHighWaterMB}MB, ` +
    `or after ${config.walCheckpointStarvationRuns} growing runs but only at >=${config.walCheckpointStarvationFloorMB}MB ` +
    `and at most once per ${Math.round(config.walCheckpointEscalateCooldownMs / 1000)}s; ` +
    `respawn max ${config.walCheckpointRespawnMax}/${config.walCheckpointRespawnWindowMs}ms)`
  );
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

module.exports = { startWalCheckpointer, stopWalCheckpointer, getCheckpointerState, _getWorker: () => worker };
