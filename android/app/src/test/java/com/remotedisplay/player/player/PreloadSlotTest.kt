package com.remotedisplay.player.player

import com.remotedisplay.player.player.PreloadSlot.Claim
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #333, the 0:00 half: a preload that died must never be promoted by the warm swap.
 *
 * The reporter also saw the freeze "occasionally at 0:00" — the boundary promoted a parked player
 * whose prepare had failed while nobody was listening, set playWhenReady on an IDLE player, and
 * held the freeze-frame on the first frame forever. The warm swap has no prepare() of its own
 * (a healthy parked player is already prepared), so the slot has to say when the player is not.
 */
class PreloadSlotTest {

    private val A = "/cache/a.mp4"
    private val B = "/cache/b.mp4"

    @Test fun THE_BUG_a_failed_preload_is_not_promoted() {
        val s = PreloadSlot()
        s.park(A)
        s.fail()                                   // onPlayerError on the parked player
        assertEquals("the boundary must take the cold path, not promote a dead player",
            Claim.COLD, s.claim(A, playerIsIdle = true))
    }

    @Test fun THE_BUG_a_parked_player_left_in_IDLE_is_prepared_before_it_plays() {
        val s = PreloadSlot()
        s.park(A)
        assertEquals(Claim.WARM_NEEDS_PREPARE, s.claim(A, playerIsIdle = true))
    }

    @Test fun a_healthy_preload_takes_the_warm_swap() {
        val s = PreloadSlot()
        s.park(A)
        assertEquals(Claim.WARM, s.claim(A, playerIsIdle = false))
    }

    @Test fun a_different_file_is_cold_and_leaves_the_parked_clip_alone() {
        // The parked clip may be the one AFTER this — an out-of-order mount must not evict it.
        val s = PreloadSlot()
        s.park(B)
        assertEquals(Claim.COLD, s.claim(A, playerIsIdle = false))
        assertTrue(s.isParked(B))
    }

    @Test fun a_claim_consumes_the_slot_so_the_same_player_is_not_promoted_twice() {
        val s = PreloadSlot()
        s.park(A)
        assertEquals(Claim.WARM, s.claim(A, playerIsIdle = false))
        assertEquals(Claim.COLD, s.claim(A, playerIsIdle = false))
        assertFalse(s.isParked(A))
    }

    @Test fun a_failed_preload_can_be_retried() {
        // preloadVideo() short-circuits on isParked(); after a failure it must go through again.
        val s = PreloadSlot()
        s.park(A)
        assertTrue(s.isParked(A))
        s.fail()
        assertFalse(s.isParked(A))
        s.park(A)
        assertEquals(Claim.WARM, s.claim(A, playerIsIdle = false))
    }

    @Test fun clear_forgets_everything() {
        val s = PreloadSlot()
        s.park(A)
        s.clear()
        assertFalse(s.isParked(A))
        assertEquals(Claim.COLD, s.claim(A, playerIsIdle = false))
    }
}
