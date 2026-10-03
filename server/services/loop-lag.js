// #142 — Event-loop lag telemetry (the data subsystem; ships before the throttle).
//
// Continuously samples event-loop delay via perf_hooks.monitorEventLoopDelay()
// (a C++-backed histogram — cheap). Each window we read mean/p50/p99/max, persist
// a row to the bounded `event_loop_lag` table, and recompute a coarse load BAND
// (normal | elevated | critical) from the window p99.
//
// The band is consumed by the reconnect throttle (#142 step 3), but this module
// has standalone value: getLag() is surfaced on /api/status and band changes are
// logged, so site connectivity/lag is diagnosable independent of any throttling.
//
// Band transitions are deliberately asymmetric (see nextBand): jump UP immediately
// when an up-threshold is crossed (tighten fast), step DOWN only one level at a
// time after lagReleaseSamples consecutive calm samples below a deadband (release
// slow). This avoids band flap from transient blips.

const { monitorEventLoopDelay } = require('perf_hooks');
const { db } = require('../db/database');
const config = require('../config');
const { chunkedDelete } = require('../lib/chunked-prune');   // #146 Item E: chunked lag prune
const logCoalescer = require('../lib/log-coalescer');        // #146 Item E: coalesced band lines

const NS_PER_MS = 1e6;
// A band releases only once p99 falls below this fraction of the band's entry
// threshold — the deadband that stops small fluctuations from flapping the band.
const DEADBAND = 0.5;
const LEVEL = { normal: 0, elevated: 1, critical: 2 };

let histogram = null;
let band = 'normal';
// #240: `samples` and the tick-gap fields exist to make ONE window's numbers
// interpretable. An IntervalHistogram window that recorded a single delay reports
// mean = p50 = p99 = max (the mean is the raw value, the percentiles are the bucket
// ceiling above it) — indistinguishable, from the numbers alone, from a fixed cost
// paid on every cycle. It is the opposite: one long loop turn. `samples` is the
// histogram's record count for the window (~50 at a 20ms resolution when healthy,
// 1 when a single turn swallowed the whole second), and tick_gap_ms is the
// WALL-CLOCK gap between consecutive sampler runs — ground truth for whether the
// loop is actually late, measured independently of the histogram.
let current = {
  mean_ms: 0, p50_ms: 0, p99_ms: 0, max_ms: 0, samples: 0, sustained_p99_ms: 0,
  tick_gap_ms: 0, worst_tick_gap_ms: 0, worst_tick_at: 0,
  band: 'normal', sampled_at: 0,
};
let lastSampleAt = 0;       // wall clock of the previous sample() run
let worstTickGapMs = 0;     // largest gap seen since process start...
let worstTickAt = 0;        // ...and when (epoch seconds). Survives coarse polling.
const lagBuffer = [];   // #146 Item E: pending telemetry rows, batch-inserted on flush

/*
 * ⚠️ #307: THE BAND IS DRIVEN BY A SUSTAINED MEASURE, NOT BY ONE WINDOW'S p99.
 *
 * It used to take a single sampling window's p99, and that number is not what it sounds like. A
 * window is one second at a 20ms resolution, so the histogram holds ~49 records — and the 99th
 * percentile of 49 records IS THE MAXIMUM. Measured on production over an hour:
 * `avg(max_ms - p99_ms) = 0.000`, exactly, in every window, while `avg(p99_ms - p50_ms) = 42.9`.
 *
 * So the band was decided by the single worst 20ms bucket in each second. One hiccup per second
 * pinned it, and release required lagReleaseSamples CONSECUTIVE clean seconds, which a server doing
 * real work essentially never strings together. The result on a HEALTHY box: prod sat at `elevated`
 * for 16 days with p50 at the 20ms measurement floor, and 1444 of ~3600 windows in an hour tipped
 * over the 50ms release threshold on one outlier each. Bold's #307 is the same mechanism one band
 * up: after the I/O pressure that caused the spike had gone, the occasional spike kept it critical
 * for seven hours, and only a restart cleared it.
 *
 * The input is now the MEDIAN of the last `lagBandWindowSamples` windows' p99. A lone outlier
 * cannot move a median; sustained pressure moves it within half a window. That also makes the
 * consecutive-calm counter unnecessary — the median is already the smoothing, and DEADBAND still
 * provides the hysteresis — so the release rule no longer depends on a run of perfect seconds.
 *
 * ⚠️ ONE WINDOW CAN STILL ESCALATE IMMEDIATELY, and it must. A median that needs eight seconds to
 * notice is the wrong instrument for a loop that has genuinely stopped: the shed valve exists to
 * protect a server mid-incident. A single window at or above SPIKE_FACTOR x the critical threshold
 * goes critical on the spot, without waiting for agreement.
 */
const SPIKE_FACTOR = 4;

function nextBand(cur, sustained, spike = 0) {
  const level = LEVEL[cur] ?? 0;
  // A catastrophic single window — a real freeze, not an outlier bucket — escalates now.
  if (spike >= config.lagCriticalMs * SPIKE_FACTOR) return 'critical';
  // UP — on the sustained measure (may skip a level).
  if (sustained >= config.lagCriticalMs) return 'critical';
  if (sustained >= config.lagElevatedMs && level < LEVEL.elevated) return 'elevated';
  // DOWN — one step per sample, below the current band's deadband.
  if (level === LEVEL.critical && sustained <= config.lagCriticalMs * DEADBAND) return 'elevated';
  if (level === LEVEL.elevated && sustained <= config.lagElevatedMs * DEADBAND) return 'normal';
  return cur;
}

/*
 * The last N windows' p99, and their median — the band's actual input.
 *
 * Deliberately a plain array with a shift: N is 15 by default, so the "efficient" ring buffer would
 * be more code guarding fewer elements than a socket message carries.
 */
const recentP99 = [];
function pushP99(v) {
  recentP99.push(v);
  while (recentP99.length > config.lagBandWindowSamples) recentP99.shift();
}
function sustainedP99() {
  if (!recentP99.length) return 0;
  const a = [...recentP99].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// A sampling window that recorded NOTHING leaves the histogram empty, and an empty
// IntervalHistogram reports `mean` as NaN (its percentiles return a floor instead, which is
// why only the mean was ever affected). NaN survives every arithmetic step here and only
// becomes visible at the edge, where JSON.stringify turns it into `null` — so /api/status
// served `mean_ms: null` to anything reading it, and no error was raised anywhere. Zero is the
// honest value: no samples means no measured delay. Applied to every field so a future change
// to the histogram source cannot reintroduce this one field at a time.
const round2 = (x) => Math.round(x * 100) / 100;
const metric = (x) => (Number.isFinite(x) ? round2(x) : 0);

function sample() {
  // #240: measure the sampler's OWN lateness first. This interval is armed for
  // lagSampleIntervalMs, so any excess is loop delay that the histogram cannot
  // misreport — if the histogram claims seconds of lag while this stays at the
  // interval, the block did not happen where the histogram says it did.
  const nowMs = Date.now();
  const tickGap = lastSampleAt ? nowMs - lastSampleAt : config.lagSampleIntervalMs;
  lastSampleAt = nowMs;
  if (tickGap > worstTickGapMs) { worstTickGapMs = tickGap; worstTickAt = Math.floor(nowMs / 1000); }

  const p99 = histogram.percentile(99) / NS_PER_MS;
  const snap = {
    mean_ms: metric(histogram.mean / NS_PER_MS),
    p50_ms: metric(histogram.percentile(50) / NS_PER_MS),
    p99_ms: metric(p99),
    max_ms: metric(histogram.max / NS_PER_MS),
    samples: histogram.count,        // MUST be read before reset()
  };
  histogram.reset();

  const prev = band;
  pushP99(snap.p99_ms);
  const sustained = sustainedP99();
  band = nextBand(band, sustained, snap.p99_ms);
  current = {
    ...snap,
    /*
     * ⚠️ #307: PUBLISHED because without it the band is inexplicable from a snapshot. Bold read
     * `p99_ms: 92` next to `band: critical` and reasonably concluded the band was wedged; the same
     * confusion is why prod's `p99_ms: 20.35` beside `band: elevated` looked like a bug. This is
     * the number the band is actually decided on.
     */
    sustained_p99_ms: sustained,
    tick_gap_ms: tickGap,
    worst_tick_gap_ms: worstTickGapMs,
    worst_tick_at: worstTickAt,
    band,
    sampled_at: Math.floor(nowMs / 1000),
  };

  // #146 Item E: BUFFER the telemetry row (batch-inserted on the flush interval) instead
  // of a synchronous INSERT per sample — under DB contention (a bloated table slowing
  // writes) a per-sample INSERT is itself a per-tick loop cost. Bounded: drop the oldest
  // if the buffer overflows (never let telemetry grow unbounded and cook the loop).
  lagBuffer.push({ ...snap, sampled_at: current.sampled_at, band });
  if (lagBuffer.length > config.lagBufferMax) lagBuffer.splice(0, lagBuffer.length - config.lagBufferMax);

  // Observable: a band CHANGE logs immediately; a repeated "still at band X" line is
  // COALESCED (one summarized line per flush) so a sustained-critical storm can't turn
  // logging into its own loop hog. Healthy steady state stays quiet.
  if (band !== prev) {
    // #240: samples + tick gap ride along on the band line — without them a one-sample
    // window reads as a permanent per-cycle cost to whoever finds this in the logs.
    console.log(`[loop-lag] band=${band} (was ${prev}) mean=${snap.mean_ms}ms p99=${snap.p99_ms}ms max=${snap.max_ms}ms samples=${snap.samples} tick_gap=${tickGap}ms`);
  } else if (band !== 'normal') {
    // #146 P3.7: coalesce repeats and carry the PEAK p99 over the window (not a random
    // sample's) — the peak is the number that matters during an incident.
    logCoalescer.record(`loop-lag:${band}`, `[loop-lag] band=${band}`, { peak: snap.p99_ms, peakUnit: 'ms' });
  }

  // #143 global pressure valve — log ONLY the band edge (open/close), not per shed
  // message. When critical, deviceSocket sheds non-essential acks (it reads getBand()).
  if (band === 'critical' && prev !== 'critical') {
    console.warn(`[shed] global valve OPEN — loop-lag critical (p99=${snap.p99_ms}ms); shedding non-essential device messages (content-acks). reconnects + dashboard still processed.`);
  } else if (prev === 'critical' && band !== 'critical') {
    console.log(`[shed] global valve CLOSED — loop-lag recovered (band=${band}, p99=${snap.p99_ms}ms)`);
  }
}

// #146 Item E: flush buffered telemetry rows in ONE batched transaction.
const _insLag = db.prepare('INSERT INTO event_loop_lag (sampled_at, mean_ms, p50_ms, p99_ms, max_ms, band) VALUES (?, ?, ?, ?, ?, ?)');
function flushLag() {
  if (!lagBuffer.length) return;
  const rows = lagBuffer.splice(0);
  try {
    db.transaction((rs) => { for (const r of rs) _insLag.run(r.sampled_at, r.mean_ms, r.p50_ms, r.p99_ms, r.max_ms, r.band); })(rows);
  } catch (_) { /* table may not exist on a partially-migrated DB — drop the batch */ }
}

// #146 Item E: chunked prune (rides idx_event_loop_lag_sampled) so this table can never
// repeat the status_log bloat-then-freeze. Async; callers fire-and-forget.
const _delLag = db.prepare('DELETE FROM event_loop_lag WHERE rowid IN (SELECT rowid FROM event_loop_lag WHERE sampled_at < ? LIMIT ?)');
async function pruneLag() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.lagTelemetryRetentionDays * 86400);
    const { deleted } = await chunkedDelete((lim) => _delLag.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch });
    if (deleted > 0) console.log(`[loop-lag] pruned ${deleted} sample(s) older than ${config.lagTelemetryRetentionDays}d`);
  } catch (_) { /* ignore */ }
}

function startLoopLagMonitor() {
  if (histogram) return; // idempotent
  histogram = monitorEventLoopDelay({ resolution: config.lagResolutionMs });
  histogram.enable();
  logCoalescer.start(config.logCoalesceFlushMs);           // #146 Item E: start the coalesced-log flusher
  const t1 = setInterval(sample, config.lagSampleIntervalMs);
  const t3 = setInterval(flushLag, config.lagFlushMs);      // #146 Item E: batch-insert buffered telemetry
  pruneLag().catch(() => {});                               // sweep stale rows on boot (chunked, async)
  const t2 = setInterval(() => pruneLag().catch(() => {}), config.lagPruneIntervalMs);
  // Don't keep the process alive on these timers (matters for tests / clean exit).
  for (const t of [t1, t2, t3]) if (t.unref) t.unref();
}

function getBand() { return band; }
function getLag() { return { ...current }; }

module.exports = { startLoopLagMonitor, getBand, getLag, nextBand };
/*
 * Exported for tests: the band's INPUT, not just its transition rule. Testing nextBand alone is how
 * #307 stayed invisible — every transition case passed while sample() handed it the wrong number.
 */
module.exports._pushP99 = pushP99;
module.exports._sustainedP99 = sustainedP99;
module.exports._recentP99 = recentP99;
// Exported for tests: the NaN-from-an-empty-window case is invisible in normal operation
// (it only surfaces after JSON serialisation) so it needs to be assertable directly.
module.exports._metric = metric;
