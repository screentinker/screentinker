// #144 — OTA update-check circuit-breaker + phantom-version guard.
//
// The /api/update/check handler offered the update whenever client !== latest (raw
// string inequality, not semver). A device that can't APPLY the update (old/broken
// OTA client like 1.7.12, signing mismatch, Fire OS) keeps reporting the same old
// version and is told update_available=true on every poll. A fast poll loop (10-30s)
// then saturates the event loop (prod loop-lag 49s).
//
// Two independent axes (kept separate on purpose):
//
//  1. RATE breaker (primary, immediate). Healthy devices poll ~every 12 min, so a key
//     checking MORE than THRESHOLD times within WINDOW (default >3 / 60s) is by
//     definition looping -> throttle update_available for that key with exponential
//     backoff. Catches the fast flood within seconds. A normally-polling device never
//     approaches this rate, so rollout/straggler updates are inherently safe — there
//     is deliberately NO "tolerate the flood for N minutes" grace; slow == safe.
//
//  2. PHANTOM guard (immediate). An unrecognized version, or a prerelease of an OLDER
//     core (a superseded old-minor beta — e.g. 1.9.1-beta4 when latest is 1.9.2-beta3),
//     gets "no offer" on the first check. A RECENT real older version (e.g. beta3 when
//     latest is beta4, or stable 1.7.12) is legitimately offerable and is NOT phantom.
//
// KEYING: keyed on device_id when the client sends one (beta4+ clients -> precise
// per-device throttling), falling back to the reported VERSION when absent (legacy
// clients send only ?version=, and the site is behind NAT so IP is useless). So every
// device is covered: new clients per-device, stuck legacy clients per-version.
//
// Constants are env-tunable for ops + tests.

const WINDOW_MS = parseInt(process.env.OTA_BREAKER_WINDOW_MS) || 60_000;   // rate window
const THRESHOLD = parseInt(process.env.OTA_BREAKER_THRESHOLD) || 3;        // checks/window before tripping (>THRESHOLD trips)
const COOLDOWNS_MS = (process.env.OTA_BREAKER_COOLDOWNS_MS
  ? process.env.OTA_BREAKER_COOLDOWNS_MS.split(',').map(s => parseInt(s, 10))
  : [30_000, 120_000, 480_000, 1_800_000]);                               // 30s -> 2m -> 8m -> cap 30m
const IDLE_RESET_MS = parseInt(process.env.OTA_BREAKER_IDLE_RESET_MS) || 60 * 60 * 1000;

const state = new Map();          // key -> { hits:number[], blockedUntil, level, lastSeen }
const loggedBad = new Set();      // log unrecognized/superseded versions once
// #146 observability — rate-backoff throughput (total + rolling lastWindow).
const { rollingCounter, bump, read } = require('./rolling-counter');
const rateBackoffCtr = rollingCounter();

// --- minimal semver-ish parse/compare (no dependency) ---
const { preCmp } = require('./version-precedence');

function parseVer(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}
function coreCmp(a, b) { for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1; return 0; }
function cmpParsed(a, b) {
  const c = coreCmp(a, b);
  if (c !== 0) return c;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;     // release outranks a prerelease of the same core
  if (b.pre === null) return -1;
  // Natural prerelease compare: digit runs numerically, so alpha8 < alpha9 < alpha10 < alpha11.
  // A plain lexical compare (what this used to do) put every build from alpha10 onward BELOW
  // alpha8, so the check answered client-newer and the fleet could not be moved forward at all.
  return preCmp(a.pre, b.pre);
}
function cmp(a, b) { const pa = parseVer(a), pb = parseVer(b); return (!pa || !pb) ? null : cmpParsed(pa, pb); }

// A '-patchN' suffix (e.g. 1.9.2-patch3) was the LEGACY release scheme — a shipped PRODUCTION patch,
// not a prerelease. Semver parses it into `pre`, but for OTA it must count as RELEASED so the
// superseded-prerelease guard below doesn't strand the old fleet: a 1.9.2-patchN device must still be
// offered a newer stable core (1.9.3). Genuine prereleases (-beta/-rc/-alpha) keep prerelease
// semantics. (Clean semver going forward emits no -patchN, so this only matters for the transition.)
function isReleased(p) { return p.pre === null || /^patch\d+$/i.test(p.pre); }

// decide(clientVersion, latestVersion, deviceId?, now?) ->
//   { update_available, reason, retry_after_seconds?, log? }
function decide(clientVersion, latestVersion, deviceId = null, now = Date.now(), betaChannel = false, wasOnBeta = false) {
  // ---- PHANTOM / unrecognized guard (immediate, version-based, no rate state) ----
  if (!clientVersion) return { update_available: false, reason: 'no-version' };
  const pc = parseVer(clientVersion), pl = parseVer(latestVersion);
  if (!pc || !pl) return { update_available: false, reason: 'unrecognized-version', log: logOnce(clientVersion, `[ota] unrecognized client version '${clientVersion}' — no offer (latest=${latestVersion})`) };
  const full = cmpParsed(pc, pl);
  if (full === 0) return { update_available: false, reason: 'up-to-date' };
  if (full > 0) {
    // Normally a client ahead of the server is left alone — never offer a downgrade. But a display
    // running a PRE-RELEASE while not opted into betas is a display someone has just switched back
    // to the release line, and stable is legitimately "older" than the beta it is replacing. Without
    // this it is stranded on the beta build forever, and unticking the box would appear to do
    // nothing — the same silent no-op the opt-in exists to remove.
    //
    // A client ahead on a genuine RELEASE still gets client-newer: that is a rolled-back server, and
    // pushing it backwards would be wrong.
    //
    // NOTE: the server can only OFFER. Android refuses to install a lower versionCode, so a beta
    // build must be cut with a versionCode no higher than the stable it branches from — equal is
    // ideal, since equal codes install in both directions. A beta with a higher code cannot be
    // returned to stable without an uninstall, whatever this endpoint says.
    // wasOnBeta is the evidence that this display was actually being served the beta channel. A
    // display that has simply always run its own pre-release build is left alone, exactly as
    // before — #144's protection for a tester ahead of the server is untouched.
    if (!betaChannel && wasOnBeta && !isReleased(pc)) {
      return { update_available: true, reason: 'channel-return' };
    }
    return { update_available: false, reason: 'client-newer' };
  }
  // betaChannel is exempt: this guard would otherwise strand the very displays we hand test
  // builds to. A tester on 1.9.25-fix234d has an older core than a released 1.9.26, so without
  // the exemption they are told "superseded" forever and never rejoin the release line — the
  // opposite of what opting in should mean. Opting in must be reversible by shipping a release.
  if (!betaChannel && !isReleased(pc) && coreCmp(pc, pl) < 0) {                                    // GENUINE superseded old-core prerelease (e.g. 1.9.1-beta4) — a -patchN release is NOT one, so it still gets offered
    return { update_available: false, reason: 'superseded-prerelease', log: logOnce(clientVersion, `[ota] superseded prerelease '${clientVersion}' (older core than latest=${latestVersion}) — no offer`) };
  }

  // A display opted into pre-release builds keeps a prerelease of the CURRENT core. Semver puts
  // 1.9.25-fix234d below 1.9.25, so without this the only "upgrade" on offer is dropping the very
  // build we asked this display to run — which is how a test build silently reverts. Scoped to the
  // same core on purpose: an older-core prerelease is genuinely stale and still gets offered, and
  // once 1.9.26 ships a 1.9.25-anything device is behind and updates normally. So opting in cannot
  // strand a display on an abandoned branch.
  if (betaChannel && !isReleased(pc) && coreCmp(pc, pl) === 0) {
    return { update_available: false, reason: 'beta-channel' };
  }

  // ---- offerable (recent real older version) -> RATE breaker, keyed per device / per version ----
  const key = deviceId ? 'd:' + deviceId : 'v:' + clientVersion;
  let b = state.get(key);
  if (!b) { b = { hits: [], blockedUntil: 0, level: 0, lastSeen: now }; state.set(key, b); }
  if (now - b.lastSeen > IDLE_RESET_MS) { b.hits = []; b.blockedUntil = 0; b.level = 0; } // long-quiet -> fresh
  b.lastSeen = now;

  if (now < b.blockedUntil) {
    bump(rateBackoffCtr, now);
    return { update_available: false, reason: 'rate-backoff', retry_after_seconds: Math.ceil((b.blockedUntil - now) / 1000) };
  }
  if (b.blockedUntil !== 0) b.blockedUntil = 0;   // cooldown elapsed -> probe window

  b.hits = b.hits.filter(t => now - t < WINDOW_MS);
  b.hits.push(now);
  if (b.hits.length > THRESHOLD) {                 // looping faster than a healthy device ever would
    const cd = COOLDOWNS_MS[Math.min(b.level, COOLDOWNS_MS.length - 1)];
    b.blockedUntil = now + cd;
    // #146 cosmetic: cap the level counter so the log doesn't read "level 32". The
    // backoff is already capped (Math.min above); the counter just shouldn't run away
    // past the point where it stops affecting the cooldown.
    b.level = Math.min(b.level + 1, COOLDOWNS_MS.length);
    b.hits = [];                                   // require a fresh burst to re-trip after cooldown
    bump(rateBackoffCtr, now);
    return { update_available: false, reason: 'rate-backoff', retry_after_seconds: Math.ceil(cd / 1000),
             log: `[ota] breaker tripped key=${key} (>${THRESHOLD} checks/${Math.round(WINDOW_MS / 1000)}s, looping) -> backoff ${Math.round(cd / 1000)}s [level ${b.level}]` };
  }
  return { update_available: true, reason: 'offer' };
}

function logOnce(version, msg) { if (loggedBad.has(version)) return undefined; loggedBad.add(version); return msg; }

// #144: actively EVICT idle buckets so the keyed state can't grow unbounded over time
// (churned device_ids, varied versions). reset-on-access alone never deletes; this does.
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, b] of state) if (now - b.lastSeen > IDLE_RESET_MS) { state.delete(k); n++; }
  if (n > 0) console.log(`[ota] breaker swept ${n} idle bucket(s) (idle > ${Math.round(IDLE_RESET_MS / 60000)}m); ${state.size} remain`);
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), IDLE_RESET_MS);
  if (sweepTimer.unref) sweepTimer.unref();   // don't keep the process alive on this timer
  return sweepTimer;
}

function reset() { state.clear(); loggedBad.clear(); Object.assign(rateBackoffCtr, rollingCounter()); }

// Forgive ONE device's rate state, called when that device proves its identity on the /device
// socket (a valid device_token, timing-safe compared).
//
// /api/update/check is deliberately unauthenticated — every client version, including old ones
// that never learned to send a token, has to be able to ask. That means `?device_id=` is
// caller-supplied, so anyone who learns a device's UUID can burn its bucket with a handful of
// requests and leave the REAL device in rate-backoff, silently un-updatable, for up to 30
// minutes at a time.
//
// Adding auth to the check would strand old clients, and keying on IP is wrong here (the fleet
// SNATs — see the note at the top of this file). So instead the poisoning is made
// self-healing: the genuine device reconnects on its own schedule, proves who it is, and gets
// its bucket cleared. An attacker can still cause noise, but the denial now lasts until the
// device's next authenticated reconnect rather than as long as the attacker keeps poking.
//
// This cannot be used to evade the breaker's real job: a device stuck in an OTA loop is
// re-registering legitimately, and clearing its rate state on each genuine reconnect is exactly
// what a healthy device looks like — the loop protection is the DOWNLOAD guard, not this.
function forgiveDevice(deviceId) {
  if (!deviceId) return false;
  return state.delete('d:' + deviceId);
}
function _size() { return state.size; }
// #146 observability — how many update checks the breaker is rate-backing-off (total +
// last completed window). A device=none 1.8.x flood shows here as rateBackoffLastWindow.
function stats(now = Date.now()) {
  const rb = read(rateBackoffCtr, now);
  return { rateBackoffTotal: rb.total, rateBackoffLastWindow: rb.lastWindow };
}
module.exports = { decide, reset, forgiveDevice, sweep, startSweep, cmp, parseVer, _size, stats, WINDOW_MS, THRESHOLD };
