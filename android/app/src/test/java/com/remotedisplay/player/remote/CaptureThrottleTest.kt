package com.remotedisplay.player.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Remote screen-mirror pacing. Pins the two properties that were regressions:
 *  - never schedule below the ~333ms accessibility-screenshot rate limit (stutter), and
 *  - never back off far enough to look frozen (the old 5s cap).
 */
class CaptureThrottleTest {

    @Test fun `cheap capture runs near the floor, never below the rate limit`() {
        assertEquals(350L, CaptureThrottle.nextDelayMs(0))
        assertEquals(350L, CaptureThrottle.nextDelayMs(100)) // 300 -> clamped up to the 350 floor
        assertTrue("must stay above the ~333ms rate limit", CaptureThrottle.nextDelayMs(50) >= 350L)
    }

    @Test fun `slow capture backs off but is capped so the view cannot freeze`() {
        assertEquals(1200L, CaptureThrottle.nextDelayMs(400))    // 1200 -> at the cap
        assertEquals(1200L, CaptureThrottle.nextDelayMs(5000))   // would be 15s; capped
        assertTrue("must never exceed the cap", CaptureThrottle.nextDelayMs(100000) <= 1200L)
    }

    @Test fun `mid-range scales about 3x`() {
        assertEquals(900L, CaptureThrottle.nextDelayMs(300)) // 300*3 = 900, within [350, 1200]
    }

    @Test fun `floor is above the rate limit and below the cap`() {
        assertTrue(CaptureThrottle.MIN_GAP_MS > 333L)
        assertTrue(CaptureThrottle.MIN_GAP_MS < CaptureThrottle.MAX_GAP_MS)
    }
}
