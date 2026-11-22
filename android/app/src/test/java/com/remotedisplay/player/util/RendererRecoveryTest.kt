package com.remotedisplay.player.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #883 follow-up: after a WebView renderer crash each zone re-mounts its web content, but a page that
 * kills the renderer on every load must not become a crash loop.
 */
class RendererRecoveryTest {
    private var clock = 0L
    private fun limiter() = RendererRecovery(maxPerWindow = 3, windowMs = 60_000L, now = { clock })

    @Test fun allowsUpToTheLimitThenRefuses() {
        val r = limiter()
        assertTrue(r.allow("zone-a"))
        assertTrue(r.allow("zone-a"))
        assertTrue(r.allow("zone-a"))
        assertFalse(r.allow("zone-a"))
    }

    @Test fun eachAreaHasItsOwnBudget() {
        // One renderer crash hits every zone at once; each must still recover.
        val r = limiter()
        repeat(3) { assertTrue(r.allow("zone-a")) }
        assertTrue(r.allow("zone-b"))
        assertTrue(r.allow("pip"))
    }

    @Test fun theWindowSlides() {
        val r = limiter()
        repeat(3) { clock += 1_000L; assertTrue(r.allow("zone-a")) }
        assertFalse(r.allow("zone-a"))
        clock += 58_000L          // t=61 s: the first attempt (t=1 s) is 60 s old, the second is not
        assertTrue(r.allow("zone-a"))
        assertFalse(r.allow("zone-a"))
    }

    @Test fun refusalsDoNotExtendTheBlock() {
        val r = limiter()
        repeat(3) { assertTrue(r.allow("zone-a")) }
        repeat(10) { clock += 1_000L; assertFalse(r.allow("zone-a")) }
        clock = 60_000L
        assertTrue(r.allow("zone-a"))
    }
}
