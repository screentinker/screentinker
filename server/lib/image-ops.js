'use strict';

/*
 * Image operations, off the main thread.
 *
 * WHY THIS EXISTS: image-ops-core is pure JavaScript, so unlike the native sharp it replaced —
 * which handed work to a libvips threadpool — its CPU cost lands on whatever thread calls it. A
 * 12MP photo measures at ~1.0s of solid, uninterruptible main-thread work. That is not a slow
 * upload, it is a stalled event loop: no heartbeats, no socket traffic, nothing. lib/thumbnail-
 * backfill.js walks an entire content library at boot, so in-process it reproduces #240 exactly
 * (blocked loop -> missed heartbeats -> panels marked offline -> reconnect churn), arriving from
 * our own maintenance. The same reasoning already moved this file's video branch from
 * execFileSync to execFile; this is that fix for the image branch.
 *
 * The work is therefore hosted on a worker thread and this module is the only entry point.
 *
 * ONE JOB AT A TIME, deliberately. Decoding holds a full RGBA bitmap — a 12MP photo is ~48MB — so
 * letting jobs overlap multiplies peak memory by the queue depth, which is exactly the wrong
 * failure on the small targets this whole change is meant to reach. Serialized, the ceiling is one
 * image regardless of how many uploads land at once. It also costs nothing in throughput: the work
 * is CPU-bound, and a single busy worker already saturates the core it runs on.
 *
 * The worker is unref'd while idle so it never holds the process open — scripts/backfill-rotation-
 * dims.js is a CLI that must exit, and `node --test` would otherwise hang forever — and ref'd only
 * while a job is in flight, so an in-progress thumbnail cannot be cut short by the process exiting.
 */

const path = require('path');

const WORKER_PATH = path.join(__dirname, 'image-ops-worker.js');
const IDLE_SHUTDOWN_MS = 60_000;   // release the decoder heap (jimp + the WASM codecs) when quiet

let worker = null;
let idleTimer = null;
let inFlight = null;               // { id, resolve, reject } — at most one, by design
let inlineOnly = false;            // set if a worker cannot be created at all; see runInline
let nextId = 1;
const queue = [];

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleShutdown() {
  clearIdleTimer();
  if (!worker || inFlight || queue.length) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker && !inFlight && !queue.length) { const w = worker; worker = null; w.terminate(); }
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

// Reject everything outstanding. Called when the worker dies underneath us — a crash means OOM or
// a bug, not a bad image (image-ops-worker catches decode failures and replies normally), so there
// is nothing to usefully retry and callers already treat a rejection as "no metadata".
function failAll(reason) {
  const dead = [inFlight, ...queue].filter(Boolean);
  inFlight = null;
  queue.length = 0;
  for (const job of dead) job.reject(new Error(reason));
}

function ensureWorker() {
  if (worker) return worker;
  const { Worker } = require('worker_threads');
  worker = new Worker(WORKER_PATH);
  worker.unref();
  worker.on('message', (msg) => {
    const job = inFlight;
    if (!job || job.id !== msg.id) return;   // a reply from a terminated generation; ignore
    inFlight = null;
    if (msg.ok) job.resolve(msg.result); else job.reject(new Error(msg.error));
    pump();
  });
  worker.on('error', (err) => { worker = null; failAll(`image worker failed: ${err.message}`); });
  worker.on('exit', (code) => {
    worker = null;
    if (inFlight || queue.length) failAll(`image worker exited (code ${code})`);
  });
  return worker;
}

function pump() {
  if (inFlight) return;
  if (!queue.length) { worker?.unref(); scheduleIdleShutdown(); return; }
  clearIdleTimer();
  inFlight = queue.shift();
  const w = ensureWorker();
  w.ref();   // a job is running: hold the process open until it finishes
  w.postMessage(inFlight.job);
}

// Last resort: if worker_threads cannot give us a thread at all, do the work in-process rather
// than refuse to thumbnail. Stalls the loop — that is the bug this module exists to avoid — so it
// is announced rather than silent.
async function runInline(job) {
  const core = require('./image-ops-core');
  if (job.op === 'metadata') return core.metadata(job.src);
  if (job.op === 'cutout') return core.cutout(job.src, job.dest, job.opts);
  if (job.op === 'measureAndThumbnail') return core.measureAndThumbnail(job.src, job.dest, job.width, job.quality);
  return core.writeThumbnail(job.src, job.dest, job.width, job.quality);
}

function submit(job) {
  if (inlineOnly) return runInline(job);
  job.id = nextId++;
  return new Promise((resolve, reject) => {
    try {
      ensureWorker();
    } catch (err) {
      inlineOnly = true;
      console.warn(`[image-ops] no worker thread (${err.message}) — decoding in-process, which blocks the event loop`);
      return resolve(runInline(job));
    }
    queue.push({ id: job.id, job, resolve, reject });
    pump();
  });
}

/* Display dimensions, shaped like the sharp metadata callers destructure. See image-ops-core. */
function metadata(src) {
  return submit({ op: 'metadata', src });
}

/* Write a JPEG thumbnail `width` px wide, aspect preserved. Rotation is implicit in the decode. */
function writeThumbnail(src, dest, width, quality = 70) {
  return submit({ op: 'writeThumbnail', src, dest, width, quality });
}

/*
 * Both of the above from ONE decode -> { width, height, orientation, thumbnailWritten,
 * thumbnailError }. Prefer this wherever both are wanted: a decode here is the full ~1s of a 12MP
 * photo, not sharp's cheap header parse, so the pair costs double. See image-ops-core.
 */
function measureAndThumbnail(src, dest, width, quality = 70) {
  return submit({ op: 'measureAndThumbnail', src, dest, width, quality });
}

/* Drop the worker now rather than waiting out the idle timer. For shutdown paths and tests. */
async function shutdown() {
  clearIdleTimer();
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

/*
 * Key a flat backdrop out of `src` and write the trimmed result to `destPath` as a PNG with alpha.
 * See image-ops-core.cutout for why this belongs off the main thread.
 */
function cutout(src, dest, opts) {
  return submit({ op: 'cutout', src, dest, opts: opts || {} });
}

module.exports = { metadata, writeThumbnail, measureAndThumbnail, cutout, shutdown };
