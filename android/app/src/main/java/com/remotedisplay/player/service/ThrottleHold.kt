package com.remotedisplay.player.service

/**
 * #314 pure throttle-hold arithmetic, so every reopen path (eviction reopen, silence backstop)
 * honours a server device:throttled the same way. `holdUntilMs` is an elapsedRealtime deadline
 * (0 = no hold).
 */
object ThrottleHold {
    /** Remaining hold in ms at [nowMs]; 0 once it has expired (or none was set). */
    fun remainingMs(holdUntilMs: Long, nowMs: Long): Long =
        if (holdUntilMs <= 0L) 0L else (holdUntilMs - nowMs).coerceAtLeast(0L)

    /** A reopen asked for after [requestedMs] must also wait out the hold. */
    fun reopenDelayMs(requestedMs: Long, holdUntilMs: Long, nowMs: Long): Long =
        maxOf(requestedMs, remainingMs(holdUntilMs, nowMs))
}
