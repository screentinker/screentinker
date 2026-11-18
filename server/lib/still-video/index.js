'use strict';

/*
 * Convert a still image into a short H.264 MP4, in a separate low-priority process.
 *
 * WHY A CHILD PROCESS (not a worker thread). A worker thread shares the server's process: its JS heap
 * can be capped, but image buffers live outside the heap, and a native crash or the kernel's OOM
 * killer would take the server with it. A child process has its own memory and is the only thing
 * that dies. It also gets its own scheduling priority (nice 19), so on a small host (prod has three
 * cores) the server, nginx and SQLite always win the CPU, and the conversion only uses idle time.
 *
 * Limits: one heap cap (--max-old-space-size), one wall-clock timeout (SIGKILL), and the image decoder's
 * own pixel limit. Callers run at most one conversion at a time (image-as-video-variants' queue).
 */

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER = path.join(__dirname, 'worker.js');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const HEAP_MB = 768;

/**
 * Resolves { width, height, bytes, qp, frames } once `out` is written; rejects on any failure,
 * including the child being killed. Never throws synchronously into the caller's event loop.
 */
function makeStillVideo({ src, out, maxWidth = 3840, maxHeight = 2160, qp = 14, seconds = 60, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, WORKER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    try { os.setPriority(child.pid, 19); } catch (_) { /* not permitted or not supported: still isolated */ }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      finish(new Error(`conversion timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => { if (stdout.length < 4096) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      let reply = null;
      try { reply = JSON.parse(stdout.trim().split('\n').pop()); } catch (_) { /* died before replying */ }
      if (reply && reply.ok) return finish(null, reply);
      if (reply && reply.error) return finish(new Error(reply.error));
      const last = stderr.trim().split('\n').pop();
      finish(new Error(signal ? `conversion process was killed (${signal})` : `conversion process exited ${code}${last ? `: ${last}` : ''}`));
    });
    child.stdin.on('error', () => { /* the child died before reading; close reports it */ });
    child.stdin.end(JSON.stringify({ src, out, maxWidth, maxHeight, qp, seconds }));
  });
}

module.exports = { makeStillVideo, HEAP_MB, DEFAULT_TIMEOUT_MS };
