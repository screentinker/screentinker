package com.remotedisplay.player.player

import com.remotedisplay.player.player.PlaybackFault.Recovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * #333: a video fault must recover in follower / group-sync mode.
 *
 * ⚠️ THE REPORT: three Xiaomi Mi TV P1s in a synced group, two videos; one screen freezes about
 * six seconds before the end of a clip, every run, and only an app restart recovers it. The #297
 * watchdog DID detect the wedge — and reported it through onVideoComplete(), where the follower
 * gate ("wall followers don't self-advance") threw it away. The gate is right for a completion
 * and wrong for a fault, and this is the rule that tells them apart.
 */
class PlaybackFaultTest {

    @Test fun THE_BUG_a_fault_in_follower_mode_replays_instead_of_being_swallowed() {
        val f = PlaybackFault()
        assertEquals("a group-sync member must recover, not freeze",
            Recovery.REPLAY_CURRENT, f.recovery(follower = true, index = 0, nowMs = 0))
    }

    @Test fun a_fault_in_follower_mode_never_advances_the_index() {
        // The schedule tick owns the index; advancing would fight it (jump back next tick, and
        // log a phantom play for an item nobody showed).
        val f = PlaybackFault()
        for (t in 0..10) {
            assertNotEquals(Recovery.ADVANCE, f.recovery(follower = true, index = 1, nowMs = t * 1_000L))
        }
    }

    @Test fun solo_playback_still_skips_the_broken_item() {
        // Unchanged from #297 / Root-2: on a solo screen the only way past a broken clip is on.
        val f = PlaybackFault()
        assertEquals(Recovery.ADVANCE, f.recovery(follower = false, index = 0, nowMs = 0))
        assertEquals("solo never holds", Recovery.ADVANCE, f.recovery(follower = false, index = 0, nowMs = 10))
    }

    @Test fun a_clip_that_faults_the_instant_it_mounts_is_held_not_replayed_in_a_loop() {
        // A corrupt file errors right after prepare(); replaying it on every error would be a
        // tight loop. The second fault inside the window holds; the freeze-frame stays up.
        val f = PlaybackFault(replayCooldownMs = 5_000L)
        assertEquals(Recovery.REPLAY_CURRENT, f.recovery(true, 2, 0))
        assertEquals(Recovery.HOLD, f.recovery(true, 2, 300))
        assertEquals(Recovery.HOLD, f.recovery(true, 2, 4_999))
    }

    @Test fun the_hold_lifts_after_the_cooldown_so_a_transient_fault_is_retried() {
        val f = PlaybackFault(replayCooldownMs = 5_000L)
        f.recovery(true, 2, 0)
        assertEquals(Recovery.HOLD, f.recovery(true, 2, 1_000))
        assertEquals("a later fault on the same item retries", Recovery.REPLAY_CURRENT, f.recovery(true, 2, 5_000))
    }

    @Test fun a_new_item_gets_a_fresh_replay_regardless_of_the_cooldown() {
        // The boundary moved the group on; the next clip's first fault is its own.
        val f = PlaybackFault(replayCooldownMs = 5_000L)
        f.recovery(true, 2, 0)
        assertEquals(Recovery.REPLAY_CURRENT, f.recovery(true, 3, 100))
    }

    @Test fun a_fault_at_time_zero_is_a_real_observation() {
        // Same trap PlaybackStall fell into: the clock is injected and the first tick is often 0.
        val f = PlaybackFault(replayCooldownMs = 5_000L)
        assertEquals(Recovery.REPLAY_CURRENT, f.recovery(true, 0, 0))
        assertEquals(Recovery.HOLD, f.recovery(true, 0, 1))
    }
}
