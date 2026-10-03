'use strict';

/*
 * 2.0.1 — hold PLAYERS off until first-boot maintenance is idle.
 *
 * ⚠️ THE FIELD REPORT THIS IS. A 73-device install on a Synology DS225+ (spinning SATA) upgraded
 * 1.9.39 -> 2.0.0. Migrations and the playlist-source backfill were fine. Then:
 *
 *   - the #307 index build on play_logs went into uninterruptible disk sleep for 5+ minutes with
 *     no log line at all (that half is fixed in db/database.js, not here);
 *   - the box came up, and all 73 players reconnected AT ONCE. HTTP was unreachable for ~20
 *     minutes even though the WebSocket layer was accepting. #142's shed was working exactly as
 *     designed and it did not matter: the content-ready storm plus the stranded-play sweep kept
 *     the loop pinned, and the stranded backlog was **494,000 rows** — not the 36,096 from the
 *     #307 investigation, which was one database's open set, never the universe.
 *
 * The workaround that worked was to stop nginx, let the app finish maintenance, and start nginx
 * again. THIS MODULE IS THAT WORKAROUND AS A PRODUCT FEATURE, so nobody has to know it.
 *
 * ⚠️ WHAT IS AND IS NOT DEFERRED. Players only. `/api/status` keeps answering 200 (compose's
 * healthcheck polls it, and a health endpoint that fails during scheduled maintenance is how you
 * turn a slow boot into a restart loop — the #146 lesson), and the dashboard namespace and every
 * browser route are untouched. An operator must be able to log in and SEE the maintenance running;
 * locking them out alongside the fleet would be a worse outage than the one being prevented.
 *
 * ⚠️ REJECT, DO NOT ACCEPT-AND-STALL. A player told 503 backs off and retries on its own schedule.
 * A player whose socket is accepted and then ignored sits there consuming a connection and gets no
 * signal to back off at all — which is the failure mode being prevented, not a milder version of it.
 *
 * ⚠️ AND IT ALWAYS LIFTS. Every exit is bounded: drained, or the safety valve below. A bug in the
 * sweep must not be able to strand a fleet permanently — an install where players never reconnect
 * is a worse outcome than the stampede this defers.
 *
 * Process-local by design. "Did this boot already do its maintenance?" is a fact about THIS
 * process, and a persisted flag would need a migration, would survive a rollback, and would have to
 * be reasoned about on every future boot. Restarting mid-drain simply re-drains what is left.
 */

/*
 * Absolute ceiling on a defer. If the drain has not reported idle by now, players are let back in
 * regardless and the reason is logged: past this point the operator's fleet being down is the
 * bigger problem, whatever the sweep thinks.
 */
const MAX_DEFER_MS = 30 * 60 * 1000;

const state = {
  deferred: false,
  reason: null,        // 'plays-index' | 'stranded-sweep'
  forced: false,       // SCREENTINKER_DEFER_PLAYERS=1 rather than an inferred defer
  since: 0,
  openPlaysAtBoot: null,
  closed: 0,
  liftedAt: 0,
  liftReason: null,    // 'drained' | 'timeout'
};

/**
 * Tri-state read of SCREENTINKER_DEFER_PLAYERS.
 * @returns {boolean|null} true = force on, false = force off, null = decide from the boot itself.
 */
function envOverride() {
  const v = process.env.SCREENTINKER_DEFER_PLAYERS;
  if (v === undefined || v === '') return null;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return null;
}

/**
 * Should this boot even look at the stranded backlog?
 *
 * Default ON only for the first process boot after a migration that touched `plays` — that is the
 * boot with a cold index and (on the installs this is for) a backlog behind it. Every subsequent
 * restart skips the count entirely and players connect immediately, which is the common case and
 * must stay free.
 *
 * @param {{migrationTouchedPlays: boolean}} opts
 */
function armed({ migrationTouchedPlays }) {
  const forced = envOverride();
  if (forced === false) return false;
  return forced === true || !!migrationTouchedPlays;
}

/**
 * Start deferring. Returns false (and defers nothing) when there is no backlog to drain, so a fresh
 * install or a healthy upgrade never holds its own players off for a sweep with no work in it.
 *
 * @param {{openPlays: number, reason?: string}} opts
 */
function begin({ openPlays, reason = 'stranded-sweep' }) {
  const forced = envOverride() === true;
  if (!forced && !(openPlays > 0)) return false;

  state.deferred = true;
  state.reason = reason;
  state.forced = forced;
  state.since = Date.now();
  state.openPlaysAtBoot = openPlays;
  state.closed = 0;
  state.liftedAt = 0;
  state.liftReason = null;

  console.warn(
    `[boot-defer] holding players off: ${reason}; ${openPlays} open play(s) to sweep` +
    `${forced ? ' (SCREENTINKER_DEFER_PLAYERS forced)' : ''}. ` +
    `/api/status stays 200; the dashboard is unaffected; players get 503 and retry.`
  );
  return true;
}

/** Record drain progress so /api/status can show it while the sweep runs. */
function progress(closed) {
  state.closed = closed;
}

/** Has the safety valve tripped? */
function expired(now = Date.now()) {
  return state.deferred && (now - state.since) >= MAX_DEFER_MS;
}

/**
 * Stop deferring. Idempotent — a second call after the valve already lifted is a no-op, so the
 * drain finishing late cannot overwrite the timeout's account of what happened.
 *
 * @param {{closed?: number, remaining?: number, reason?: string}} opts
 */
function lift({ closed = state.closed, remaining = null, reason = 'drained' } = {}) {
  if (!state.deferred) return;
  const secs = Math.round((Date.now() - state.since) / 1000);
  state.deferred = false;
  state.closed = closed;
  state.liftedAt = Date.now();
  state.liftReason = reason;

  const rem = remaining == null ? 'unknown' : String(remaining);
  let how = 'sweep idle';
  if (reason === 'timeout') {
    how = `after ${MAX_DEFER_MS / 60000}min — the sweep is STILL RUNNING and has not reported idle; letting players in anyway`;
  } else if (reason === 'error') {
    how = 'the drain FAILED — players are let in rather than held off behind a sweep that is not running';
  }
  console.warn(
    `[boot-defer] players accepted again (${how}): ${secs}s deferred, ${closed} stranded play(s) closed, ${rem} still open`
  );
}

/** The gate itself. Trips the safety valve on read so nothing has to poll for it. */
function isDeferred() {
  if (state.deferred && expired()) lift({ reason: 'timeout' });
  return state.deferred;
}

/**
 * What a rejected player is told, and what /api/status reports. Deliberately small and free of
 * internals: a panel logs this to a screen nobody can scroll.
 */
function rejection() {
  return {
    error: 'maintenance',
    status: 503,
    reason: state.reason || 'maintenance',
    retry_after_sec: 30,
  };
}

/** Maintenance block for /api/status. `null` once players are being accepted normally. */
function statusBlock() {
  if (!isDeferred()) return null;
  return {
    deferring_players: true,
    reason: state.reason,
    since_sec: Math.round((Date.now() - state.since) / 1000),
    open_plays_at_boot: state.openPlaysAtBoot,
    stranded_closed: state.closed,
    forced: state.forced,
  };
}

module.exports = {
  armed,
  begin,
  progress,
  expired,
  lift,
  isDeferred,
  rejection,
  statusBlock,
  MAX_DEFER_MS,
  // Test seam: age a live defer past the valve. The alternative is a test that waits half an hour.
  __setSinceForTest: (ms) => { state.since = ms; },
  // Test seam: a fresh process is the only other way back to the initial state.
  __reset: () => {
    Object.assign(state, {
      deferred: false, reason: null, forced: false, since: 0,
      openPlaysAtBoot: null, closed: 0, liftedAt: 0, liftReason: null,
    });
  },
};
