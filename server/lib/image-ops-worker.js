'use strict';

/*
 * Worker-thread host for image-ops-core. One job per message, one reply per job, keyed by id.
 *
 * Deliberately thin: every decision (queueing, lifecycle, fallback) lives in ../lib/image-ops so
 * there is one place to reason about them. This end only does the work and reports what happened.
 *
 * Errors come back as a message rather than a thrown exception, so one undecodable upload does
 * not tear down the worker and take the queued jobs of unrelated callers with it.
 */

const { parentPort } = require('worker_threads');
const core = require('./image-ops-core');

const OPS = {
  metadata: (job) => core.metadata(job.src),
  writeThumbnail: (job) => core.writeThumbnail(job.src, job.dest, job.width, job.quality),
  measureAndThumbnail: (job) => core.measureAndThumbnail(job.src, job.dest, job.width, job.quality),
};

parentPort.on('message', async (job) => {
  try {
    const op = OPS[job.op];
    if (!op) throw new Error(`unknown image op: ${job.op}`);
    parentPort.postMessage({ id: job.id, ok: true, result: await op(job) });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
