package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/** A one-item playlist whose item keeps failing (a camera that is down) waits longer each time. */
class FaultBackoffTest {
    @Test fun `repeated faults back off to 30 s and stay there`() {
        val b = FaultBackoff()
        var now = 0L
        val waits = (1..7).map { val w = b.next(now); now += w; w }
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 30_000L, 30_000L), waits)
    }

    @Test fun `a fault long after the last one starts again from the shortest wait`() {
        val b = FaultBackoff(healthyMs = 60_000L)
        b.next(0L); b.next(2_000L); b.next(6_000L)          // 2, 4, 8 s
        assertEquals(2_000L, b.next(6_000L + 8_000L + 60_001L))
    }
}
