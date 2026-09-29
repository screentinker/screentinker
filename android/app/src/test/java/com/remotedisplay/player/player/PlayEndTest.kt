package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `completed` was a hardcoded `true` at the play_end call site, so proof-of-play reported 100%
 * completion for screens that were failing every item. These pin the rule; the wiring that feeds it
 * lives in PlaylistController, which owns a Handler and a Looper and cannot run on the JVM.
 */
class PlayEndTest {

    @Test
    fun `a fault advance is not a completion`() {
        assertFalse(
            "a decoder error or a stall watchdog giving up means the item did not get its turn",
            PlayEnd.completed(faulted = true)
        )
    }

    @Test
    fun `a natural advance is a completion`() {
        assertTrue(PlayEnd.completed(faulted = false))
    }

    @Test
    fun `the flag is actually read, not ignored`() {
        // The defect was a constant. If completed() ever stops depending on its input, the value is
        // a constant again under a different name and this whole change is undone silently.
        assertTrue(
            "completed() must distinguish its inputs",
            PlayEnd.completed(faulted = false) != PlayEnd.completed(faulted = true)
        )
    }
}
