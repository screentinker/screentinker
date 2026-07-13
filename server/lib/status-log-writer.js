// #146 — batched, coalescing writer for device_status_log.
//
// Before: every device status transition (online/offline/offline_timeout) did its
// own synchronous INSERT on the hot path (deviceSocket.logDeviceStatus + the
// heartbeat checker). Under a reconnect storm that is one row PER flap, which both
// (a) bloats the table — it reached 1.1M rows in prod — and (b) makes each write
// slower as the table grows, lagging status processing further. A textbook feedback
// loop, the connection-layer twin of the OTA loop #144 contained.
//
// After: transitions are buffered in memory and flushed on an interval. The buffer
// keeps only the LATEST (net) status per device, so a device that flaps
// online->offline->online within a flush window collapses to at most one row — and
// if it ends where it started, zero rows. devices.status (the dashboard's source of
// truth) is still updated immediately by the callers; only the AUDIT log is batched,
// so coalescing storm noise loses nothing the uptime view needs.
//
// State is in-memory and resets on restart (like the throttle / breaker buckets).

const { db } = require('../db/database');
const config = require('../config');

const pending = new Map();      // deviceId -> latest desired status (net state)
const lastWritten = new Map();  // deviceId -> last status actually inserted
let timer = null;

const insertStmt = () => db.prepare('INSERT INTO device_status_log (device_id, status, reason, detail) VALUES (?, ?, ?, ?)');
// Per-device age prune — the #146 fix for the old hardcoded 7-day window in
// deviceSocket.js (now a single source of truth: config.statusLogRetentionDays).
const pruneDeviceStmt = () =>
  db.prepare("DELETE FROM device_status_log WHERE device_id = ? AND timestamp < strftime('%s','now') - ?");

// Record a transition. Cheap and allocation-light: just remembers the latest state.
// reason/detail (optional) annotate WHY an offline transition happened (offline-cause log).
function record(deviceId, status, reason, detail) {
  if (!deviceId || !status) return;
  pending.set(deviceId, { status: status, reason: reason || null, detail: detail || null });
}

// Write all buffered transitions whose net state differs from what's on disk.
// Returns the number of rows actually inserted (for tests/observability).
function flush() {
  if (pending.size === 0) return 0;
  const batch = [];
  for (const [deviceId, val] of pending) {
    if (lastWritten.get(deviceId) !== val.status) batch.push([deviceId, val.status, val.reason, val.detail]);
  }
  pending.clear();
  if (batch.length === 0) return 0;

  try {
    const ins = insertStmt();
    const prune = pruneDeviceStmt();
    const ageSec = Math.round(config.statusLogRetentionDays * 86400);
    const writeAll = db.transaction((rows) => {
      for (const [deviceId, status, reason, detail] of rows) {
        ins.run(deviceId, status, reason || null, detail || null);
        lastWritten.set(deviceId, status);
        prune.run(deviceId, ageSec);
      }
    });
    writeAll(batch);
    // #146 Item E: bound lastWritten so it can't grow unbounded over churned device_ids.
    // It only suppresses a redundant consecutive same-status row, so evicting the oldest
    // entries is safe (worst case: one extra row later). Keep it to the newest ~5k ids.
    if (lastWritten.size > 5000) {
      const excess = lastWritten.size - 5000;
      let i = 0;
      for (const k of lastWritten.keys()) { if (i++ >= excess) break; lastWritten.delete(k); }
    }
    return batch.length;
  } catch (_) {
    // table might not exist yet (early boot) — drop silently, same as the old path
    return 0;
  }
}

function start() {
  if (timer) return timer;
  timer = setInterval(flush, config.statusLogFlushMs);
  if (timer.unref) timer.unref();  // don't keep the process alive on the flush timer
  return timer;
}

// Test-only: force a synchronous flush and clear coalescing memory.
function flushNow() { return flush(); }
function __reset() { pending.clear(); lastWritten.clear(); }

module.exports = { record, flush, flushNow, start, __reset };
