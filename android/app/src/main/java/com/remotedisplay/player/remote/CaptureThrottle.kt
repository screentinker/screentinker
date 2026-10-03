package com.remotedisplay.player.remote

/**
 * How long the remote screen-mirror waits between captures. Pure so it can be unit-tested.
 *
 * ⚠️ REGRESSION GUARDS. MIN_GAP sits just ABOVE Android's ~333ms accessibility-screenshot rate limit:
 * lower and captures fail (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) and the view stutters. MAX_GAP
 * caps the adaptive backoff so a slow capture on a weak panel can't freeze the remote view for
 * seconds (it was 5s, which read as "the remote is dead").
 */
object CaptureThrottle {
    const val MIN_GAP_MS = 350L
    const val MAX_GAP_MS = 1200L

    /** ~3x the last capture time, clamped: cheap captures run near the floor, expensive ones back off. */
    fun nextDelayMs(lastCaptureMs: Long): Long = (lastCaptureMs * 3).coerceIn(MIN_GAP_MS, MAX_GAP_MS)
}
