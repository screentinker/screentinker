'use strict';

// Availability probe for the external media binaries (ffmpeg/ffprobe) that video
// thumbnail + duration extraction depends on. They are SYSTEM dependencies, not npm
// ones, so a deployment can easily lack them — and content-ingest's best-effort
// contract means every video then uploads fine but silently gets no thumbnail and
// no duration.
//
// Async on purpose: the first caller is server.js right after listen, and a hung
// binary (NFS-mounted PATH shim, broken wrapper) must degrade to a late log line,
// not block request serving on a freshly-bound port.
//
// ⚠️ A TIMEOUT IS NOT "NOT FOUND" (#466). This used to treat every probe error alike and cache
// it for the life of the process. On a NAS with spinning disks, a boot that ran a 1.5M-row
// migration pushed `ffmpeg -version` past the old 5 s limit while the event loop was at
// p99 3 s — so a present ffmpeg was logged "not found on PATH" and video thumbnails stayed
// off until the next restart, including the thumbnail backfill that runs once after boot.
// Now: ENOENT is "missing", a non-zero exit or permission error is "error" (installed but
// broken) — both definite, both cached — and a timeout is INCONCLUSIVE: never cached, so the
// next caller probes again, and startupCheck() keeps re-checking on a backoff.

const { execFile } = require('child_process');

const PROBE_TIMEOUT_MS = 15000;   // the same allowance the backfill gives an ffmpeg run
const RETRY_DELAYS_MS = [30e3, 60e3, 120e3, 300e3, 600e3];
const MAX_RETRIES = 12;           // ~1.5 h of re-checks before giving up for this process

let exec = execFile;
let cached = null;     // a CONCLUSIVE status only
let inflight = null;   // one probe pair at a time

/** 'ok' | 'missing' (ENOENT) | 'error' (ran but failed, or not executable) | 'timeout' */
function probeTool(bin) {
  return new Promise((resolve) => {
    exec(bin, ['-version'], { timeout: PROBE_TIMEOUT_MS }, (err) => {
      if (!err) return resolve('ok');
      if (err.code === 'ENOENT') return resolve('missing');
      if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return resolve('timeout');
      resolve('error');
    });
  });
}

/**
 * { ffmpeg, ffprobe }: booleans, as before; plus detail { ffmpeg, ffprobe } with the reason and
 * `conclusive` — false while either probe timed out (that status is NOT cached).
 */
function mediaToolStatus() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = Promise.all([probeTool('ffmpeg'), probeTool('ffprobe')]).then(([ffmpeg, ffprobe]) => {
      const status = {
        ffmpeg: ffmpeg === 'ok',
        ffprobe: ffprobe === 'ok',
        detail: { ffmpeg, ffprobe },
        conclusive: ffmpeg !== 'timeout' && ffprobe !== 'timeout',
      };
      if (status.conclusive) cached = status;
      inflight = null;
      return status;
    });
  }
  return inflight;
}

function toolsWith(status, reason) {
  return ['ffmpeg', 'ffprobe'].filter((t) => status.detail[t] === reason).join(', ');
}

/**
 * The boot-time check and its log line, re-checking while the answer is inconclusive.
 * onRecovered() runs when a RETRY finds both tools — server.js re-runs the thumbnail backfill,
 * which skipped every video while the tools looked unavailable.
 */
async function startupCheck({ onRecovered = null, schedule = setTimeout, log = console } = {}, attempt = 0) {
  const s = await mediaToolStatus();
  if (s.ffmpeg && s.ffprobe) {
    log.log(attempt
      ? `[MEDIA] ffmpeg/ffprobe answered on re-check ${attempt} — video thumbnails enabled`
      : '[MEDIA] ffmpeg/ffprobe found — video thumbnails enabled');
    if (attempt && onRecovered) { try { onRecovered(); } catch (e) { log.error(`[MEDIA] recovery hook failed: ${e.message}`); } }
    return s;
  }
  const missing = toolsWith(s, 'missing');
  const broken = toolsWith(s, 'error');
  if (missing) log.error(`[MEDIA] ${missing} not found on PATH — video thumbnails and durations are DISABLED until installed (e.g. apt-get install ffmpeg). Image thumbnails are unaffected.`);
  if (broken) log.error(`[MEDIA] ${broken} is on PATH but failed to run "-version" (broken install or not executable) — video thumbnails and durations are DISABLED. Image thumbnails are unaffected.`);
  if (!s.conclusive) {
    const slow = toolsWith(s, 'timeout');
    if (attempt >= MAX_RETRIES) {
      log.error(`[MEDIA] ${slow} still did not answer within ${PROBE_TIMEOUT_MS / 1000}s after ${attempt} re-checks — video thumbnails stay off until a later check succeeds or the server restarts.`);
      return s;
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    log.warn(`[MEDIA] ${slow} did not answer within ${PROBE_TIMEOUT_MS / 1000}s (slow disk or heavy boot load?) — NOT treating it as missing; re-checking in ${delay / 1000}s`);
    const t = schedule(() => {
      startupCheck({ onRecovered, schedule, log }, attempt + 1).catch((e) => log.error(`[MEDIA] tooling re-check failed: ${e.message}`));
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
  }
  return s;
}

/** Tests only. */
function _setExecForTest(fn) { exec = fn || execFile; cached = null; inflight = null; }

module.exports = { mediaToolStatus, startupCheck, PROBE_TIMEOUT_MS, _setExecForTest };
