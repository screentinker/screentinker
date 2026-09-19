const { db, pruneStatusLog, pruneTelemetryRetention, playsMigrationTouched } = require('../db/database');
// Scale-out: a sweep on a replica must never act on a COPIED workspace (docs/scale-out-design.md §5.5).
const { LOCAL_ROWS_SQL } = require('../lib/replica-proxy');
const config = require('../config');
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');
const statusLogWriter = require('../lib/status-log-writer');
const { chunkedDelete, currentBand, yieldTick } = require('../lib/chunked-prune'); // #146 non-blocking sweeps
const { expireStrandedPlays } = require('../lib/play-backfill');
const bootDefer = require('../lib/boot-defer');   // 2.0.1 first-boot player defer
const pluginHooks = require('../lib/plugins/hooks');

const liveness = require('../lib/liveness'); // v4 core pass: server-derived 3-state liveness

// Track connected device sockets: deviceId -> { socketId, lastHeartbeat }
const deviceConnections = new Map();

// FIX 2: version-agnostic reconnect-frequency signal (every client reconnects the same way). A
// rolling window of recent (re)register timestamps per device -> "degraded-reconnecting" when it churns.
let _io = null; // captured in startHeartbeatChecker so livenessFor() can check namespace presence
const RECONNECT_WINDOW_MS = 60000;
const reconnectTimes = new Map(); // deviceId -> [timestamps within the window]
function recordReconnect(deviceId, now = Date.now()) {
  const arr = (reconnectTimes.get(deviceId) || []).filter(t => now - t < RECONNECT_WINDOW_MS);
  arr.push(now);
  reconnectTimes.set(deviceId, arr);
}
function recentReconnects(deviceId, now = Date.now()) {
  const arr = (reconnectTimes.get(deviceId) || []).filter(t => now - t < RECONNECT_WINDOW_MS);
  if (arr.length) reconnectTimes.set(deviceId, arr); else reconnectTimes.delete(deviceId);
  return arr.length;
}
// Server-derived liveness for a device — from socket presence + heartbeat age + reconnect churn ONLY
// (all version-agnostic). A disconnected device is a clean 'offline' (normal state, not an error).
function livenessFor(deviceId) {
  const conn = deviceConnections.get(deviceId);
  const deviceNs = _io ? _io.of('/device') : null;
  const connected = !!(conn && deviceNs && deviceNs.sockets.has(conn.socketId));
  const lastHeartbeatAgeMs = conn ? (Date.now() - conn.lastHeartbeat) : Infinity;
  return liveness.deriveLiveness({ connected, lastHeartbeatAgeMs, recentReconnects: recentReconnects(deviceId) });
}

function startHeartbeatChecker(io) {
  _io = io; // FIX 2: for livenessFor() namespace-presence checks
  // #146: startup sweep is chunked + async + fire-and-forget + NOT band-gated, so a
  // bloated device_status_log self-heals on next deploy WITHOUT freezing boot (the old
  // whole-table sort froze boot 40-48s -> healthcheck fail -> restart loop). It
  // trickles in bounded batches while the server comes up and serves.
  pruneStatusLog({ bandGate: false }).catch(() => {});

  // #146: start the batched device_status_log flush loop.
  statusLogWriter.start();

  /*
   * 2.0.1: drain the first-boot stranded-play backlog with players held off while it runs.
   * Fire-and-forget for the same reason as the startup prune above — boot must not block on it —
   * but it is STARTED here, before server.listen, so no player can arrive ahead of the defer.
   */
  drainStrandedAtBoot().catch((e) => {
    // A drain that fails must not leave the fleet locked out.
    console.error(`[boot] stranded drain failed: ${e && e.message}`);
    bootDefer.lift({ reason: 'error' });
  });

  const deviceNs = io.of('/device');

  setInterval(() => {
    const now = Date.now();
    const dashboardNs = io.of('/dashboard');

    // #146 BILLING: credit currently-connected devices' usage for this interval.
    // Fire-and-forget + never throws into the interval (billing must not perturb the
    // heartbeat). Reads the same live presence map as the offline check below.
    accrueUsage(now).catch(() => {});

    // Check database for devices that should be offline
    const onlineDevices = db.prepare(`SELECT id, last_heartbeat FROM devices WHERE status = 'online' AND ${LOCAL_ROWS_SQL('devices')}`).all();

    for (const device of onlineDevices) {
      const conn = deviceConnections.get(device.id);

      // #146: a device with a live, still-connected socket is UP, even if its last
      // heartbeat event is stuck behind a lagged event loop. Marking it offline on a
      // stale in-memory lastHeartbeat was the second false-offline cause (the screen
      // is online and playing, the CMS says offline). The socket still being in the
      // /device namespace is the authoritative liveness signal — trust it over the
      // (possibly queued) heartbeat clock. If the socket is genuinely gone, conn is
      // either absent or points at a socket no longer in the namespace, and we fall
      // through to the timeout below.
      if (conn && deviceNs.sockets.has(conn.socketId)) continue;

      const lastBeat = conn ? conn.lastHeartbeat : (device.last_heartbeat ? device.last_heartbeat * 1000 : 0);

      if (now - lastBeat > config.heartbeatTimeout) {
        // #148 Item 2: marking a device offline MUST also close any socket we still hold for
        // it, so DB-offline can never diverge from socket-state into a silent half-open the
        // client is never told about. The live-socket guard above already `continue`d for a
        // genuinely-live socket, so this only reaps a stale/half-open one (Engine.IO's
        // ping-timeout also reaps it, but this makes offline<=>closed explicit + immediate).
        if (conn) {
          const sock = deviceNs.sockets.get(conn.socketId);
          if (sock) { try { sock.disconnect(true); } catch (_) { /* already gone */ } }
        }
        // Exit-signal contract: this timeout path is the classic 'silent' case (froze, no clean
        // disconnect, no signal) — COALESCE annotates 'silent' unless a device:exit reason arrived
        // this session (e.g. a crash emit that beat the freeze). Pure annotation; detection unchanged.
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now'), offline_reason = COALESCE(offline_reason, 'silent'), offline_reason_at = COALESCE(offline_reason_at, strftime('%s','now')) WHERE id = ?")
          .run(device.id);
        deviceConnections.delete(device.id);

        const _off = db.prepare("SELECT offline_reason, offline_detail, client_type FROM devices WHERE id = ?").get(device.id) || {};
        // Notify dashboard (workspace-scoped via the device's room).
        emitToWorkspace(dashboardNs, deviceRoom(device.id), 'dashboard:device-status', {
          device_id: device.id,
          status: 'offline',
          liveness: 'offline', // FIX 2: derived — no live socket => offline (a normal state, not an error)
          offline_reason: _off.offline_reason || 'silent', // exit-signal contract: manner-of-death
          offline_detail: _off.offline_detail || null,
          client_type: _off.client_type || null,
          telemetry: null
        });
        reconnectTimes.delete(device.id); // clear churn history on a clean offline

        console.log(`Device ${device.id} marked offline (heartbeat timeout)`);
        // #146: batch through the coalescing writer (was an immediate INSERT here).
        // Offline-cause log: this liveness-timeout path is the "stopped reporting" case —
        // annotate reason/detail and record it in the unified incident feed too.
        statusLogWriter.record(device.id, 'offline_timeout', 'heartbeat_timeout', 'Stopped sending heartbeats');
        pluginHooks.emit('device.offline', { device_id: device.id, reason: 'heartbeat_timeout' });
        try {
          db.prepare("INSERT INTO device_events (device_id, type, reason, detail) VALUES (?, 'offline', 'heartbeat_timeout', 'Stopped sending heartbeats')")
            .run(device.id);
        } catch (_) { /* incident feed is best-effort; never perturb the heartbeat loop */ }
      }
    }

    // #146: all table-growth maintenance runs OFF the interval body — async, chunked,
    // band-gated, re-entrancy-guarded — so a sweep can never block the loop or stack.
    // The offline-marking above stays synchronous (it's the core heartbeat function).
    runMaintenance();

  }, config.heartbeatInterval);
}

// #146: batched play-log prune (idx_play_logs_time), chunked so a 90-day backlog
// trims across many bounded DELETEs instead of one large statement.
const _delPlayLogs = db.prepare('DELETE FROM play_logs WHERE rowid IN (SELECT rowid FROM play_logs WHERE started_at < ? LIMIT ?)');
async function prunePlayLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - (90 * 86400);
  return (await chunkedDelete((lim) => _delPlayLogs.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// Offline-cause log: retention sweep for the unified incident feed, mirroring the
// device_status_log age prune (same retention window + chunked so a backlog trims across
// many bounded DELETEs, never one blocking statement). Rides idx_device_events_device_time
// only loosely (timestamp filter); bounded batches keep it off the loop regardless.
const _delDeviceEvents = db.prepare('DELETE FROM device_events WHERE rowid IN (SELECT rowid FROM device_events WHERE timestamp < ? LIMIT ?)');
async function pruneDeviceEvents() {
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.statusLogRetentionDays * 86400);
  return (await chunkedDelete((lim) => _delDeviceEvents.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// Per-device row cap: even within the retention window a chatty device (display on/off
// flapping, reconnect churn) shouldn't accumulate unbounded incident rows. Trim any
// device over the cap down to its most-recent DEVICE_EVENTS_PER_DEVICE_CAP rows. Only
// touches devices actually over the cap (cheap HAVING scan on the index), yielding between.
const DEVICE_EVENTS_PER_DEVICE_CAP = 500;
const _capDeviceEvents = db.prepare(`
  DELETE FROM device_events WHERE device_id = ? AND id NOT IN (
    SELECT id FROM device_events WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?
  )`);
async function capDeviceEvents() {
  const over = db.prepare('SELECT device_id FROM device_events GROUP BY device_id HAVING COUNT(*) > ?').all(DEVICE_EVENTS_PER_DEVICE_CAP);
  let trimmed = 0;
  for (const row of over) {
    trimmed += _capDeviceEvents.run(row.device_id, row.device_id, DEVICE_EVENTS_PER_DEVICE_CAP).changes;
    await yieldTick();
  }
  return trimmed;
}

// #146 interval maintenance — band-gated (skip while loaded; runs next tick) and
// re-entrancy-guarded (a long run never stacks with the next interval). Never throws
// into the interval. NOT for startup (see the un-gated startup prune above).
let _maintRunning = false;
/*
 * 2.0.1 — a batch past this took the DISK, not the query. On the DS225+ report each 2000-row batch
 * blocked the loop for 1-2s on spinning SATA, which is invisible in a log that only prints totals.
 * Warn so slow storage lands in the same stream as the loop-lag band and the #146 critical-band
 * download shed, where an operator correlating a stall already has their eyes.
 */
const SLOW_BATCH_MS = 2000;

/**
 * One bounded stranded-play batch, with the line that makes a long drain legible.
 *
 * `remaining` is derived from a count taken ONCE when the drain started, not re-counted per batch:
 * counting the open set is itself an index scan over hundreds of thousands of rows, and paying for
 * it every batch to print a number would be the same mistake as the sweep it is reporting on.
 *
 * @returns {{closed: number, ms: number, drained: boolean}}
 */
function strandedBatch({ label, index, of, remaining }) {
  const t0 = Date.now();
  const closed = expireStrandedPlays(db, { limit: config.strandedPlayBatch });
  const ms = Date.now() - t0;
  const drained = closed < config.strandedPlayBatch;

  if (closed > 0 || ms > SLOW_BATCH_MS) {
    const rem = remaining == null ? 'unknown' : Math.max(0, remaining - closed);
    const line = `[${label}] stranded sweep batch ${index}/${of} closed=${closed} remaining=${rem} duration=${ms}ms`;
    if (ms > SLOW_BATCH_MS) console.warn(`${line} — slow storage (batch held the loop >${SLOW_BATCH_MS}ms)`);
    else console.log(line);
  }
  return { closed, ms, drained };
}

/*
 * #307: close plays that have been open longer than their content could possibly have run.
 *
 * lib/play-backfill.closeStrandedPlays already infers an end from the NEXT play, which is a
 * measurement and always preferable — but it needs a next row, and it declines when the gap exceeds
 * the item's own length rather than crediting a dark screen with playback. So the last play before
 * a device goes quiet, and every play cut short by a power failure, was left open with nothing that
 * would ever revisit it: **36,096 open rows in the database this was investigated against, 35,982
 * of them over a day old** — and 494,000 on the 73-device Synology install that prompted 2.0.1.
 *
 * ⚠️ CHUNKED AND BOUNDED PER SWEEP, because the table has 1.44M rows and the driver is synchronous.
 * An unbounded UPDATE here would block the event loop in exactly the way #307 is about. It drains
 * over successive sweeps rather than in one.
 */
async function expireStrandedPlaysChunked() {
  const of = config.strandedPlayMaxBatchesPerSweep;
  let total = 0;
  for (let i = 0; i < of; i++) {
    const { closed, drained } = strandedBatch({ label: 'maintenance', index: i + 1, of, remaining: null });
    total += closed;
    if (drained) break;
    // Yield between batches so a long drain cannot hold the loop for its whole duration.
    await new Promise((r) => setImmediate(r));
  }
  if (total > 0) console.log(`[maintenance] closed ${total} stranded play(s) past their ceiling`);
  return total;
}

/** The open set, counted once. Rides the #307 partial index (idx_play_logs_open). */
function countOpenPlays() {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM play_logs WHERE ended_at IS NULL').get().n;
  } catch { return 0; }
}

/**
 * 2.0.1 — drain the stranded backlog at boot, with players held off while it runs.
 *
 * ⚠️ WHY A SEPARATE DRAIN AND NOT JUST THE INTERVAL SWEEP. The interval sweep is deliberately
 * bounded to a handful of batches per tick so it can never be the thing that pins a LIVE server.
 * At 494,000 rows and 4 batches of 500 per 30s tick that is a backlog measured in days, and every
 * one of those ticks competes with the fleet it is trying to stop hurting. The boot drain runs the
 * same bounded, yielding batches with no per-tick cap — which is only safe BECAUSE players are
 * deferred while it runs, and is why the two are one feature rather than two.
 *
 * ⚠️ IT RUNS BEFORE server.listen (startHeartbeatChecker is called above it in server.js), so the
 * defer is already in force by the time any player can reach the socket.
 *
 * "Idle" is a batch that closes fewer rows than it asked for: the predicate is drained, which is
 * the same drained-test lib/chunked-prune uses everywhere else. Not a magic threshold — with
 * players deferred nothing new is arriving, so it genuinely reaches the end of the set.
 */
async function drainStrandedAtBoot() {
  if (!bootDefer.armed({ migrationTouchedPlays: playsMigrationTouched })) return 0;

  const t0 = Date.now();
  const openAtBoot = countOpenPlays();
  console.log(`[boot] ${openAtBoot} open play(s) at start (counted in ${Date.now() - t0}ms)`);
  if (!bootDefer.begin({ openPlays: openAtBoot })) return 0;

  /*
   * An ESTIMATE of how many batches this will take, from the count above. It can be overshot (the
   * sweep only closes plays past their ceiling, and a batch can close fewer than it asked for
   * without being drained), which is why `i` is not clamped to it — a line reading `batch 991/988`
   * is more honest than one that pretends the estimate was a promise.
   */
  const of = Math.max(1, Math.ceil(openAtBoot / config.strandedPlayBatch));
  let closed = 0;
  let timedOut = false;
  for (let i = 1; ; i++) {
    const r = strandedBatch({ label: 'boot', index: i, of, remaining: openAtBoot - closed });
    closed += r.closed;
    bootDefer.progress(closed);
    if (r.drained) break;
    // The valve, checked between batches: a fleet held off forever is worse than a stampede.
    if (bootDefer.expired()) { timedOut = true; break; }
    await yieldTick();   // same discipline as every other sweep: never hold the loop for a drain
  }

  // Re-counted rather than subtracted, so the lift line states what IS open, not what we believe.
  bootDefer.lift({ closed, remaining: countOpenPlays(), reason: timedOut ? 'timeout' : 'drained' });
  return closed;
}

async function runMaintenance() {
  if (_maintRunning) return;
  if (config.maintenanceBandGateEnabled && currentBand() !== 'normal') return;   // #146 P1.3 kill switch
  _maintRunning = true;
  try {
    await pruneProvisioningDevices();
    await prunePlayLogs();
    await pruneStatusLog({ bandGate: true });   // per-device chunked; own re-entrancy
    await pruneTelemetryRetention({ bandGate: true });   // #240 device_telemetry age sweep (per-device chunked)
    await pruneDeviceEvents();                   // offline-cause log: incident-feed age retention (chunked)
    await capDeviceEvents();                     // offline-cause log: per-device incident row cap
    await pruneUsageDaily();                     // #146 BILLING rollup retention (chunked)
    await expireStrandedPlaysChunked();          // #307 close plays nothing else will ever close
    // Expiry sweeps on small tables — single cheap statements, bounded by table size.
    db.prepare("DELETE FROM team_invites WHERE expires_at < strftime('%s','now')").run();
    db.prepare("DELETE FROM workspace_invites WHERE expires_at < strftime('%s','now')").run();
  } catch (_) { /* maintenance must never crash the interval */ } finally { _maintRunning = false; }
}

function registerConnection(deviceId, socketId) {
  deviceConnections.set(deviceId, { socketId, lastHeartbeat: Date.now() });
}

function updateHeartbeat(deviceId) {
  const conn = deviceConnections.get(deviceId);
  if (conn) conn.lastHeartbeat = Date.now();
}

function removeConnection(deviceId) {
  deviceConnections.delete(deviceId);
}

function getConnection(deviceId) {
  return deviceConnections.get(deviceId);
}

function getAllConnections() {
  return deviceConnections;
}

// #146: LIVE connected-device count — the set with a live socket THIS INSTANT. Cheap
// in-memory read. Distinct from devices.status='online' (persisted, lags by the
// offline-timeout). Surfaced as /api/status.devices_connected.
function getConnectedCount() {
  return deviceConnections.size;
}

// #146 BILLING accumulator — credit each currently-connected device's today-row with the
// seconds elapsed since the last accrual. Retention-INDEPENDENT: it reuses the SAME live
// presence map as devices_connected (never reconstructs online time from status_log,
// which is only 3-day). Cheap + non-blocking: chunked UPSERTs, one bounded transaction
// per chunk, yielding between chunks. The per-accrual credit is CAPPED (accrualCapSeconds)
// so a stalled loop or restart gap can't inject a bogus large credit; the DAILY total is
// capped at 86400 in the UPSERT itself. Day is the UTC calendar day of the tick.
const _usageUpsert = db.prepare(`
  INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)
  ON CONFLICT(device_id, day) DO UPDATE SET online_seconds = MIN(86400, online_seconds + excluded.online_seconds)
`);
let _lastAccrue = 0;
let _accrualRunning = false;
async function accrueUsage(now = Date.now()) {
  if (_accrualRunning) return 0;                        // never stack; elapsed-based credit self-heals a skipped tick
  if (_lastAccrue === 0) { _lastAccrue = now; return 0; } // first tick establishes the baseline; credit nothing
  const credit = Math.min(Math.floor((now - _lastAccrue) / 1000), config.billing.accrualCapSeconds);
  _lastAccrue = now;
  if (credit <= 0) return 0;
  const ids = Array.from(deviceConnections.keys());
  if (!ids.length) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  _accrualRunning = true;
  try {
    const upsertMany = db.transaction((slice) => { for (const id of slice) _usageUpsert.run(id, day, credit); });
    const batch = config.billing.accrualBatch;
    for (let i = 0; i < ids.length; i += batch) {
      upsertMany(ids.slice(i, i + batch));
      if (i + batch < ids.length) await yieldTick();     // keep a huge fleet's accrual off the event loop
    }
  } finally { _accrualRunning = false; }
  return ids.length;
}

// #146 BILLING: prune the daily rollup beyond retention (chunked, so it can never
// bloat-then-freeze). `day` is a sortable 'YYYY-MM-DD' string → lexical < is a date <.
const _delUsage = db.prepare('DELETE FROM device_usage_daily WHERE rowid IN (SELECT rowid FROM device_usage_daily WHERE day < ? LIMIT ?)');
async function pruneUsageDaily() {
  const cutoff = new Date(Date.now() - config.billing.usageRetentionDays * 86400 * 1000).toISOString().slice(0, 10);
  return (await chunkedDelete((lim) => _delUsage.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// #142: sweep unclaimed provisioning devices older than 24h (imported devices keep a
// user_id and are preserved). #146: now async + CHUNKED (rides idx_devices_provisioning)
// so a provisioning-junk flood can't delete-cascade a huge batch in one synchronous
// statement. Returns rows deleted. NOTE: async now — callers must await.
const _delProvisioning = db.prepare(`
  DELETE FROM devices WHERE rowid IN (
    SELECT rowid FROM devices
    WHERE status = 'provisioning' AND user_id IS NULL AND created_at < ?
    LIMIT ?
  )
`);
async function pruneProvisioningDevices() {
  const cutoff = Math.floor(Date.now() / 1000) - (24 * 3600);
  return (await chunkedDelete((lim) => _delProvisioning.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

module.exports = {
  startHeartbeatChecker,
  registerConnection,
  updateHeartbeat,
  removeConnection,
  getConnection,
  getAllConnections,
  getConnectedCount,
  recordReconnect,      // FIX 2
  recentReconnects,     // FIX 2
  livenessFor,          // FIX 2
  pruneProvisioningDevices,
  pruneDeviceEvents,   // offline-cause log: incident-feed retention
  capDeviceEvents,     // offline-cause log: per-device incident cap
  accrueUsage,
  pruneUsageDaily,
  drainStrandedAtBoot,   // 2.0.1 first-boot stranded drain (exported for tests)
  countOpenPlays,        // 2.0.1
  __resetAccrual: () => { _lastAccrue = 0; },   // #146 test hook: reset the accrual baseline
};
