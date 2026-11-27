'use strict';

/*
 * WHERE A FRESHNESS REPORT IS COMPUTED: a worker thread, never the main thread when one is available.
 *
 * Production, 2026-11-27: the report read up to ~900k proof-of-play rows per workspace and ran on
 * the event loop that answers every player's heartbeat. Dashboard chips froze the server for 3-13 s
 * and the 09:00 digest (every workspace in a row) for 28 s; screens and dashboards reported that they
 * could not reach the server while it was frozen. lib/freshness.js now reads plays in short slices
 * (so a long read cannot stall the WAL checkpoint) and this module runs the whole computation on a
 * worker with its own read-only connection.
 *
 * ⚠️ A SLOW OR DEAD WORKER NEVER SENDS THE WORK BACK TO THE MAIN THREAD. Unlike the mesh reads, the
 * fallback for a worker that does not answer is the last report we have (or none), not an inline
 * compute: an inline compute is exactly the freeze this exists to prevent. Only a process that cannot
 * run a worker at all (no worker_threads, an in-memory database) computes inline, which is what it
 * always did.
 *
 * Concurrent requests for the same workspace share one computation, so twenty open dashboards cost
 * one report, not twenty.
 */

const path = require('node:path');
const freshness = require('./freshness');

const REPORT_TIMEOUT_MS = 60_000;
const RESPAWN_BACKOFF_MS = 30_000;

function loadWorkerThreads() {
  try { return require('node:worker_threads'); } catch (_) { return null; }
}

function createFreshnessRunner({ dbPath, db, logger = console, preferWorker = true, timeoutMs = REPORT_TIMEOUT_MS } = {}) {
  const wt = preferWorker ? loadWorkerThreads() : null;
  const canWork = !!(wt && dbPath && dbPath !== ':memory:');
  let worker = null;
  let deadUntil = 0;
  let nextId = 1;
  const pending = new Map();   // message id -> { resolve, timer }
  const shared = new Map();    // workspace id -> Promise (non-fresh requests only)

  function settleAll(reason) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ error: reason }); }
    pending.clear();
  }

  function tearDown(reason) {
    const w = worker;
    worker = null;
    if (w) { try { w.terminate(); } catch (_) { /* already gone */ } }
    settleAll(reason || 'worker stopped');
    if (reason) {
      deadUntil = Date.now() + RESPAWN_BACKOFF_MS;
      logger.warn(`[freshness] report worker stopped (${reason}); restarting it on the next request after ${RESPAWN_BACKOFF_MS / 1000}s`);
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!canWork || Date.now() < deadUntil) return null;
    try {
      const w = new wt.Worker(path.join(__dirname, 'freshness-worker.js'), {
        workerData: { dbPath, driverName: require('../db/sqlite-driver').driverName },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      w.unref();   // idle, it must never hold the process open; ref'd while a report is pending
      w.on('message', (msg) => {
        if (msg && msg.fatal) return tearDown(msg.reason);
        const p = msg && pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (!pending.size && worker) worker.unref();
        p.resolve(msg);
      });
      w.on('error', (e) => { if (worker === w) tearDown((e && e.message) || 'error'); });
      w.on('exit', (code) => { if (worker === w) tearDown(`exit ${code}`); });
      worker = w;
      return w;
    } catch (e) {
      deadUntil = Date.now() + RESPAWN_BACKOFF_MS;
      logger.warn(`[freshness] could not start a report worker (${e && e.message})`);
      return null;
    }
  }

  function viaWorker(w, workspaceId, now) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        if (!pending.size && worker) worker.unref();
        logger.warn(`[freshness] report for ${workspaceId} took over ${Math.round(timeoutMs / 1000)}s; serving the last one`);
        resolve({ error: 'timeout' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, timer });
      w.ref();
      try { w.postMessage({ id, workspaceId, now }); } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ error: (e && e.message) || 'post failed' });
      }
    });
  }

  async function compute(workspaceId, now, keep) {
    const gen = freshness.generation(workspaceId);
    const w = ensureWorker();
    let report = null;
    if (w) {
      const msg = await viaWorker(w, workspaceId, now);
      if (msg.error) {
        if (msg.error !== 'timeout') logger.warn(`[freshness] report failed for ${workspaceId}: ${msg.error}`);
        // Never recompute inline here: the last report (any age) or nothing.
        return freshness.cached(workspaceId, Infinity);
      }
      report = msg.report || null;
    } else if (canWork) {
      // The worker is in its restart backoff: same rule, no inline compute.
      return freshness.cached(workspaceId, Infinity);
    } else {
      // No worker on this platform at all: compute here, as before this module existed.
      await new Promise((r) => setImmediate(r));
      report = freshness.computeWorkspace(db, workspaceId, { now, useCache: false, keep: false });
    }
    if (keep && report && freshness.generation(workspaceId) === gen) freshness.remember(workspaceId, report);
    return report;
  }

  return {
    get mode() { return worker ? 'worker' : (canWork ? 'worker-idle' : 'inline'); },

    /**
     * The workspace's report. fresh:true always computes (the full page, opened right after a fix);
     * otherwise a report under a minute old is reused and simultaneous callers share one compute.
     * keep:false (the digest) does not cache the result: a sweep over every workspace would otherwise
     * leave a report per workspace in memory.
     */
    report(workspaceId, { fresh = false, now = Math.floor(Date.now() / 1000), keep = true } = {}) {
      if (!workspaceId) return Promise.resolve(null);
      if (!fresh) {
        const hit = freshness.cached(workspaceId);
        if (hit) return Promise.resolve(hit);
        if (shared.has(workspaceId)) return shared.get(workspaceId);
      }
      const p = compute(workspaceId, now, keep);
      if (!fresh) {
        shared.set(workspaceId, p);
        const clear = () => { if (shared.get(workspaceId) === p) shared.delete(workspaceId); };
        p.then(clear, clear);
      }
      return p;
    },

    stop() { tearDown(null); },
  };
}

let _default = null;
/** The server's runner, made on first use (so a process that never asks never starts a thread). */
function defaultRunner() {
  if (!_default) {
    const { db } = require('../db/database');
    _default = createFreshnessRunner({ db, dbPath: require('../config').dbPath });
  }
  return _default;
}

module.exports = { createFreshnessRunner, defaultRunner, REPORT_TIMEOUT_MS };
