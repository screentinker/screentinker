package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wedged-decoder detector (#297).
 *
 * ⚠️ THE REPORT: "After some time, playback freezes. A complete restart of the application helps."
 * Android TV, 1.9.40. A video advances the playlist only on STATE_ENDED or on a playback error, and
 * a hardware decoder that wedges raises neither — it stays READY with playWhenReady true and simply
 * stops moving. Nothing in the app watched for that, so the playlist stopped for good.
 *
 * ⚠️ THE DANGEROUS HALF IS THE FALSE POSITIVE, not the miss. A detector that fires on a paused wall
 * follower, a group-sync member waiting for its slot, or a slow remote stream that is legitimately
 * buffering would skip content nobody asked it to skip — turning a network hiccup into a playlist
 * that races. Most of these tests are about NOT firing.
 */
class PlaybackStallTest {

    private val READY = PlaybackStall.STATE_READY
    private val BUFFERING = PlaybackStall.STATE_BUFFERING
    private val ENDED = PlaybackStall.STATE_ENDED
    private val IDLE = PlaybackStall.STATE_IDLE

    @Test fun THE_BUG_a_wedged_decoder_is_reported_after_the_threshold() {
        val s = PlaybackStall(readyStallMs = 10_000L)
        // Playing normally, position moving.
        assertFalse(s.tick(0, READY, true, 1_000))
        assertFalse(s.tick(2_000, READY, true, 3_000))
        // Now it wedges: same position, clock advances.
        assertFalse(s.tick(4_000, READY, true, 3_000))   // first observation at this position
        assertFalse(s.tick(9_000, READY, true, 3_000))   // 5s stuck — not yet
        assertTrue("a decoder stuck past the threshold must be reported",
            s.tick(15_000, READY, true, 3_000))
    }

    @Test fun it_reports_only_ONCE_so_the_playlist_does_not_double_advance() {
        val s = PlaybackStall(readyStallMs = 1_000L)
        s.tick(0, READY, true, 500)
        assertTrue(s.tick(5_000, READY, true, 500))
        assertFalse("a second report on the same item would advance twice",
            s.tick(6_000, READY, true, 500))
    }

    @Test fun normal_playback_never_reports() {
        val s = PlaybackStall(readyStallMs = 1_000L)
        var pos = 0L
        for (t in 0..60) {
            pos += 1_000
            assertFalse("moving playback must never look stalled", s.tick(t * 1_000L, READY, true, pos))
        }
    }

    @Test fun a_looping_single_video_is_not_stalled_when_it_wraps() {
        // repeatMode ONE resets the position to ~0; that is a change, not a stall.
        val s = PlaybackStall(readyStallMs = 1_000L)
        assertFalse(s.tick(0, READY, true, 9_000))
        assertFalse(s.tick(2_000, READY, true, 0))
        assertFalse(s.tick(4_000, READY, true, 500))
    }

    @Test fun A_PAUSED_ITEM_IS_NOT_A_STALL_however_long_it_sits() {
        /*
         * A wall follower holding on a frame, or a group-sync member waiting for its slot, stays at
         * one position deliberately. Reporting that would advance a playlist that is doing exactly
         * what it was told.
         */
        val s = PlaybackStall(readyStallMs = 1_000L)
        for (t in 0..20) {
            assertFalse(s.tick(t * 5_000L, READY, false, 4_000))
        }
    }

    @Test fun a_slow_stream_gets_a_longer_rope_while_buffering() {
        val s = PlaybackStall(readyStallMs = 10_000L, bufferingStallMs = 30_000L)
        s.tick(0, BUFFERING, true, 2_000)
        assertFalse("15s of buffering is a bad link, not a wedged decoder",
            s.tick(15_000, BUFFERING, true, 2_000))
        assertTrue("but buffering forever is still a failure",
            s.tick(40_000, BUFFERING, true, 2_000))
    }

    @Test fun ended_and_idle_are_somebody_else_s_business() {
        // STATE_ENDED already advances; STATE_IDLE is what an error leaves behind and is handled by
        // onPlayerError. Reporting either here would double up on an existing self-heal.
        val s = PlaybackStall(readyStallMs = 1_000L)
        for (t in 0..10) {
            assertFalse(s.tick(t * 2_000L, ENDED, true, 5_000))
            assertFalse(s.tick(t * 2_000L, IDLE, true, 5_000))
        }
    }

    @Test fun the_timer_restarts_when_playback_recovers_on_its_own() {
        val s = PlaybackStall(readyStallMs = 10_000L)
        s.tick(0, READY, true, 1_000)
        s.tick(5_000, READY, true, 1_000)          // stuck 5s
        assertFalse(s.tick(6_000, READY, true, 1_500))  // moved again
        assertFalse("the clock must restart after recovery", s.tick(12_000, READY, true, 1_500))
        assertTrue(s.tick(20_000, READY, true, 1_500))
    }

    @Test fun a_pause_clears_the_stall_timer() {
        val s = PlaybackStall(readyStallMs = 5_000L)
        s.tick(0, READY, true, 1_000)
        s.tick(3_000, READY, false, 1_000)         // paused mid-stall
        assertFalse("resuming must not inherit the paused time", s.tick(4_000, READY, true, 1_000))
        assertTrue(s.tick(10_000, READY, true, 1_000))
    }
}
