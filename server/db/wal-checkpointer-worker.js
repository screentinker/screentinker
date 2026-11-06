// WAL checkpointer WORKER (worker_threads). Runs OFF the main event-loop thread so the
// synchronous, fsync-heavy checkpoint never blocks the loop (the ~60s p99 spike).
//
// CRITICAL: this worker opens its OWN better-sqlite3 Database() handle against the same
// file. better-sqlite3 handles are NOT thread-safe, so the main thread's handle is never
// shared into the worker — only the dbPath STRING is passed via workerData. SQLite WAL is
// designed for multiple connections to the same file, so a second connection checkpointing
// while the main connection writes is safe.
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const { Database } = require('./sqlite-driver');

const { dbPath, intervalMs, highWaterBytes, starvationRuns, starvationFloorBytes, escalateCooldownMs } = workerData;

// Fault injection for TESTS ONLY (env-gated; inert in prod). Exits immediately on start so
// the controller's respawn / autocheckpoint-fallback path can be exercised deterministically.
if (process.env.WAL_CKPT_FAIL_START) process.exit(1);

// Fresh, worker-owned connection (NOT the main handle).
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');      // wait (on THIS worker thread) through the main writer's brief locks
db.pragma('wal_autocheckpoint = 0');   // this connection must never auto-checkpoint either

const walFile = dbPath + '-wal';
function walBytes() { try { return fs.statSync(walFile).size; } catch { return 0; } }

// Pause ALL checkpointing while a cross-process reader holds a read transaction on this
// database. The nightly backup takes its snapshot with a second-process VACUUM INTO (see
// scripts/db-tool.js); a TRUNCATE checkpoint racing that reader corrupted the high-churn
// tables' free-list inside the backup window (play_logs / device_telemetry, 2026-11-06).
// db-tool drops the sentinel for the duration of that read. The staleness guard means a
// reader that dies without clearing the sentinel cannot disable checkpointing for longer
// than PAUSE_MAX_MS, so the WAL can never grow unbounded behind a stuck pause.
const pauseFile = dbPath + '.checkpoint-paused';
const PAUSE_MAX_MS = 20 * 60 * 1000;
let pauseLogged = false;
function checkpointPaused() {
  try {
    const age = Date.now() - fs.statSync(pauseFile).mtimeMs;
    if (age >= 0 && age < PAUSE_MAX_MS) {
      if (!pauseLogged) { pauseLogged = true; post('paused for backup window (sentinel present)'); }
      return true;
    }
  } catch (_) { /* no sentinel = not paused */ }
  if (pauseLogged) { pauseLogged = false; post('resumed after backup window'); }
  return false;
}

let lastBytes = 0;
let growthRuns = 0;        // consecutive PASSIVE runs where the WAL failed to shrink
let lastTruncateAt = 0;    // #240: when we last blocked for a TRUNCATE (0 = never)
let coolingReported = false;
let timer = null;

function tick() {
  try {
    if (checkpointPaused()) return;   // a cross-process reader (nightly backup) holds the DB — don't race it
    // PASSIVE never blocks writers, but skips frames pinned by active readers/writers —
    // so on its own it can perpetually under-checkpoint. That's what the guard below bounds.
    db.pragma('wal_checkpoint(PASSIVE)', { simple: false });
    const bytes = walBytes();

    // --- STARVATION BOUND (this is where "WAL cannot grow forever" is enforced) ---
    // Escalating forces a TRUNCATE, which BLOCKS until it has checkpointed everything and
    // truncated the file to 0. #240: "fine here on the worker" was only ever half true —
    // the fsync is off the loop, but SQLite's locks are held across CONNECTIONS, so the
    // main thread's next statement waits it out in the busy handler. Hence the gates below.
    if (bytes > lastBytes) growthRuns++; else growthRuns = 0;
    const overHighWater = bytes > highWaterBytes;
    // #240: TRUNCATE blocks ACROSS connections — the main thread's next statement waits in
    // SQLite's busy handler for the whole checkpoint — so the growth signal alone must not
    // be able to spend it. Two gates, because either on its own leaves the hole open:
    //   FLOOR: a WAL in the lower half of its budget has little to reclaim; blocking for it
    //     is pure cost. (Ungated, every morning fleet power-on wave bought a loop stall.)
    //   COOLDOWN: a WAL that already sits ABOVE the floor would otherwise escalate on every
    //     burst forever. However long the pressure lasts, we stall the loop at most once
    //     per window and let PASSIVE do the rest.
    // overHighWater bypasses both — a runaway WAL is the one case worth blocking for.
    const sinceLast = Date.now() - lastTruncateAt;
    const starved = growthRuns >= starvationRuns && bytes >= starvationFloorBytes;
    const cooling = starved && lastTruncateAt > 0 && sinceLast < escalateCooldownMs;

    if (cooling && !overHighWater) {
      // Report the transition only — a starved-and-cooling state persists for the whole
      // window and this check runs every interval; one line, not a log flood.
      if (!coolingReported) {
        coolingReported = true;
        post(`starvation escalation held off (WAL ${(bytes / 1e6).toFixed(1)}MB, last TRUNCATE ${Math.round(sinceLast / 1000)}s ago) — PASSIVE continues`);
      }
      lastBytes = bytes;
      return;
    }

    if (overHighWater || starved) {
      lastTruncateAt = Date.now();
      coolingReported = false;
      const r = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
      const after = walBytes();
      // #240: TRUNCATE does NOT throw when it can't get the locks — it returns busy=1 having
      // sat on SQLite's busy timeout for its full duration. Measured at ~4.9s with a single
      // reader mid-transaction, reclaiming nothing, while every main-thread statement waited
      // behind it. Say so plainly: a silent 5-second loss is the worst thing this can do.
      const busy = Array.isArray(r) && r[0] && r[0].busy === 1;
      post(`escalated TRUNCATE (${overHighWater ? 'high-water' : 'starvation'}): WAL ${(bytes / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB${busy ? ' — BUSY: reclaimed nothing, blocked writers for the busy timeout' : ''}`);
      growthRuns = 0;
      lastBytes = after;
    } else {
      lastBytes = bytes;
    }
  } catch (e) {
    post('checkpoint error: ' + (e && e.message));
  }
}

function post(log) { try { parentPort && parentPort.postMessage({ log }); } catch (_) {} }

timer = setInterval(tick, intervalMs);

// Clean shutdown: stop the timer, close our connection, exit THIS worker thread.
parentPort && parentPort.on('message', (m) => {
  if (m && m.stop) {
    if (timer) { clearInterval(timer); timer = null; }
    try { db.close(); } catch (_) {}
    process.exit(0);
  }
});
