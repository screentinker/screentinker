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

    @Test fun THE_GAP_a_one_item_playlist_replaced_by_many_swaps_now() {
        // The single item never "finishes" into a next item (it replays itself, or a live stream
        // never ends), so deferring only held the replaced content up to DEADLINE_MS. Web/Tizen
        // parity: `outgoingNeverAdvances = oldPlaylist.length <= 1`.
        assertFalse(PendingSwap.shouldDefer(true, false, true, LIVE, listOf("other-a", "other-b"), outgoingCount = 1))
        assertFalse(PendingSwap.shouldDefer(true, false, true, LIVE, listOf("other-a"), outgoingCount = 1))
    }

    @Test fun many_items_replaced_by_one_still_defers_the_rule_reads_the_OUTGOING_list() {
        // Tizen's bug before #549 was measuring the incoming list: this must still let the live item
        // finish its turn, exactly like any multi-item rotation.
        assertTrue(PendingSwap.shouldDefer(true, false, true, LIVE, listOf("other-a"), outgoingCount = 3))
        assertTrue(PendingSwap.shouldDefer(true, false, true, LIVE, listOf("other-a"), outgoingCount = 2))
    }

    @Test fun the_one_item_exemption_does_not_change_the_other_guards() {
        // An interrupt change and a wall follower still never defer, whatever the outgoing size.
        assertFalse(PendingSwap.shouldDefer(true, false, true, LIVE, listOf("other-a"), interruptChanged = true, outgoingCount = 3))
        assertFalse(PendingSwap.shouldDefer(true, true, true, LIVE, listOf("other-a"), outgoingCount = 3))
        // And a one-item list that still contains the live item is unchanged (no deferral needed).
        assertFalse(PendingSwap.shouldDefer(true, false, true, LIVE, listOf(LIVE, "other-a"), outgoingCount = 1))
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
 * QA: an emergency alert's card appeared only after the current item finished — up to
 * PendingSwap.DEADLINE_MS later — because raising an alert replaces the playlist with the card,
 * which removes the live item, which is exactly #157's deferral case. The server now marks the card
 * `interrupt: true`; a change to the SET of those is applied at once, and nothing else changes.
 */
class InterruptTest {

    private fun item(contentId: String = "", widgetId: String? = null, interrupt: Boolean = false) = PlaylistItem(
        assignmentId = 0, contentId = contentId, filename = "f", mimeType = if (widgetId != null) "text/html" else "image/png",
        filepath = "", durationSec = 10, fileSize = 0, sortOrder = 0, widgetId = widgetId, interrupt = interrupt,
    )

    private val ordinary = listOf(item("a"), item("b"))
    private val card = item(widgetId = "w-cap", interrupt = true)

    private fun changed(old: List<PlaylistItem>, new: List<PlaylistItem>) =
        Interrupt.changed(Interrupt.keys(old), Interrupt.keys(new))

    @Test fun THE_BUG_raising_an_alert_is_not_deferred() {
        assertTrue(changed(ordinary, listOf(card)))
        // The live item "a" is gone from the new list: without the flag this deferred.
        assertTrue(PendingSwap.shouldDefer(true, false, true, "a|", listOf(card.itemKey)))
        assertFalse(PendingSwap.shouldDefer(true, false, true, "a|", listOf(card.itemKey), interruptChanged = true))
    }

    @Test fun clearing_an_alert_is_not_deferred_either() {
        // The card is on screen and the ordinary loop comes back: the all-clear must land at once too.
        assertTrue(changed(listOf(card), ordinary))
        assertFalse(PendingSwap.shouldDefer(true, false, true, card.itemKey, ordinary.map { it.itemKey }, interruptChanged = true))
    }

    @Test fun a_second_feed_taking_over_is_a_change() {
        assertTrue(changed(listOf(card), listOf(item(widgetId = "w-other", interrupt = true))))
    }

    @Test fun an_ordinary_edit_keeps_the_157_deferral() {
        val edited = listOf(item("b"), item("c"))
        assertFalse(changed(ordinary, edited))
        assertTrue(PendingSwap.shouldDefer(true, false, true, "a|", edited.map { it.itemKey }, interruptChanged = false))
    }

    @Test fun the_same_alert_republished_is_not_a_change() {
        // Every payload during an alert carries the card again; that must not restart it.
        assertFalse(changed(listOf(card), listOf(card.copy(durationSec = 60))))
    }

    @Test fun only_flagged_items_count_the_widget_type_alone_does_not() {
        // The flag is the contract, not the widget id: an unflagged widget is an ordinary item.
        assertFalse(changed(ordinary, listOf(item(widgetId = "w-cap"))))
        assertEquals(setOf("|w-cap"), Interrupt.keys(listOf(card, item("a"))))
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
