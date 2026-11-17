package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #314 regression guard: the eviction reopen (3 s) that follows a device:throttled disconnect must
 * not reconnect before the server's retry_after_ms has elapsed.
 */
class ThrottleHoldTest {

    @Test fun `no hold means the requested delay is used`() {
        assertEquals(3000L, ThrottleHold.reopenDelayMs(3000L, 0L, 10_000L))
        assertEquals(0L, ThrottleHold.remainingMs(0L, 10_000L))
    }

    @Test fun `an active hold stretches the eviction reopen to the hold deadline`() {
        // throttled at t=10s for 5 min; eviction reopen asks for 3s
        val until = 10_000L + 300_000L
        assertEquals(300_000L, ThrottleHold.reopenDelayMs(3000L, until, 10_000L))
        assertEquals(240_000L, ThrottleHold.remainingMs(until, 70_000L))
    }

    @Test fun `an expired hold does not delay anything`() {
        assertEquals(3000L, ThrottleHold.reopenDelayMs(3000L, 5_000L, 10_000L))
        assertEquals(0L, ThrottleHold.remainingMs(5_000L, 10_000L))
    }

    @Test fun `a short hold shorter than the requested delay keeps the requested delay`() {
        assertEquals(3000L, ThrottleHold.reopenDelayMs(3000L, 11_000L, 10_000L))
    }
}
