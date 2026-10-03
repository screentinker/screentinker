package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A customer assigned a different playlist to a screen and the screen kept showing the old content.
 * Then they selected "no playlist" — still the old content. Restarting the app showed the new
 * content instantly, which ruled out downloads, the network and the server payload.
 *
 * Two faults met. #157's deferral holds a playlist change until the current item finishes its turn,
 * and the item on screen was a YouTube video, which never finished: nothing armed an advance for it,
 * so the pending change waited for an event that could not arrive. And "no playlist" went down the
 * same deferral path, so the one action that should always take effect immediately did not.
 *
 * Invariants pinned here:
 *   - an empty new list is applied at once, never deferred
 *   - a real rotation still defers, because #157's reason for existing has not changed
 *   - an item that ends on a timer is recognised as such, YouTube included
 */
class PendingSwapTest {

    private val LIVE = "content-on-screen"

    private fun defer(
        newIds: List<String>,
        current: String? = LIVE,
        isRunning: Boolean = true,
        wallFollower: Boolean = false,
        hasContent: Boolean = true,
    ) = PendingSwap.shouldDefer(isRunning, wallFollower, hasContent, current, newIds)

    @Test fun THE_BUG_selecting_no_playlist_must_not_be_deferred() {
        // The decisive observation from the report: "I selected No playlist ... it still showed the
        // same video." An empty list is an operator saying stop, not an item rotating out.
        assertFalse(defer(newIds = emptyList()))
    }

    @Test fun a_genuine_rotation_still_defers_157_must_not_regress() {
        // The current item is gone from the new list but other items remain: let it finish.
        assertTrue(defer(newIds = listOf("other-a", "other-b")))
    }

    @Test fun a_playlist_that_still_contains_the_live_item_never_defers() {
        assertFalse(defer(newIds = listOf(LIVE, "other-a")))
    }

    @Test fun nothing_on_screen_yet_means_apply_immediately() {
        // A first load has nothing to protect, so there is nothing to wait for.
        assertFalse(defer(newIds = listOf("other-a"), hasContent = false))
        assertFalse(defer(newIds = listOf("other-a"), current = null))
    }

    @Test fun a_stopped_controller_does_not_defer() {
        // Otherwise a swap is parked on an instance that will never advance again.
        assertFalse(defer(newIds = listOf("other-a"), isRunning = false))
    }

    @Test fun a_wall_follower_does_not_defer_it_obeys_the_leader() {
        assertFalse(defer(newIds = listOf("other-a"), wallFollower = true))
    }

    @Test fun the_deferral_deadline_is_long_enough_for_a_normal_item_and_short_enough_to_notice() {
        // The deadline is the backstop for "no advance ever arrives". It must clear a typical dwell
        // comfortably (or it would cut ordinary items short) while still resolving fast enough that
        // an operator watching the screen sees their change land.
        val deadline = PendingSwap.DEADLINE_MS
        assertTrue("deadline must exceed a common 30s dwell", deadline > 30_000L)
        assertTrue("an operator should not wait minutes", deadline <= 120_000L)
    }
}

/**
 * The other half of the same report. A YouTube item ended on nothing: no timer was armed for it and
 * a WebView embed reports no completion, so it held the screen forever and stranded whatever
 * playlist change was waiting behind it.
 */
class ItemTimingTest {

    @Test fun THE_BUG_a_youtube_item_must_end_on_a_timer() {
        // Nothing else can end it — a WebView embed fires no completion event.
        assertTrue(ItemTiming.endsOnTimer("video/youtube", isWidget = false))
    }

    @Test fun images_and_widgets_are_timed_as_they_always_were() {
        assertTrue(ItemTiming.endsOnTimer("image/jpeg", isWidget = false))
        assertTrue(ItemTiming.endsOnTimer("image/png", isWidget = false))
        assertTrue(ItemTiming.endsOnTimer("text/html", isWidget = true))
    }

    @Test fun THE_SAME_BUG_an_html_bundle_must_end_on_a_timer_too() {
        /*
         * A bundle is a WebView page exactly like a widget and a YouTube embed: nothing reports its
         * completion. Off the timer path it is not a slow rotation, it is a stopped one — the same
         * defect this class was written for, arriving through a different door.
         */
        assertTrue(ItemTiming.endsOnTimer(ItemTiming.BUNDLE_MIME, isWidget = false))
        assertEquals("application/vnd.screentinker.bundle+zip", ItemTiming.BUNDLE_MIME)
    }

    @Test fun an_unknown_type_is_still_not_timed_because_the_player_skips_it_instead() {
        /*
         * playFile's else branch advances immediately on an unrecognised mime, so it must NOT also
         * be armed here — that would be two advances for one item. This pins the division of labour
         * so a later "fix" that makes everything timed does not double-skip.
         */
        assertFalse(ItemTiming.endsOnTimer("application/pdf", isWidget = false))
    }

    @Test fun real_video_must_NOT_be_timed_or_clips_get_cut_short() {
        // These end on STATE_ENDED. Arming a timer would truncate a clip at its configured duration,
        // which is the regression to avoid while fixing the YouTube case.
        assertFalse(ItemTiming.endsOnTimer("video/mp4", isWidget = false))
        assertFalse(ItemTiming.endsOnTimer("video/webm", isWidget = false))
    }
}
