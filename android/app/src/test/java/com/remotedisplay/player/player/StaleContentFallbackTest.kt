package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #314 — a full cache must not read as an empty one.
 *
 * ⚠️ THE BUG THIS EXISTS FOR. Readiness asked one question: is this item's cached copy carrying the
 * revision the playlist asked for? An asset cached by a build from before content revisions existed
 * has no revision sidecar, so it can never answer yes — and after an OTA a panel whose disk was full
 * of perfectly playable media sat on "Waiting for content", with the operator's own log showing every
 * file present. The strict check was right; being the ONLY check was the defect.
 *
 * The order is the whole design and is what these assertions pin: confirmed-fresh content always
 * wins, and the weaker "do we have bytes at all?" question is asked only when nothing anywhere
 * passes the strict bar. Otherwise this fix would quietly undo the thing the revision exists for —
 * a replaced asset reaching a screen that already holds the old one.
 */
class StaleContentFallbackTest {

    private fun setOf(vararg idx: Int): (Int) -> Boolean = { it in idx.toSet() }
    private val none: (Int) -> Boolean = { false }

    @Test
    fun `fresh content is preferred even when stale bytes sit earlier in the list`() {
        // Item 0 has unverifiable bytes; item 3 is confirmed fresh. The fresh one must win.
        val i = PlaylistSelection.firstPlayableOrStale(5, setOf(3), setOf(0, 1, 3))
        assertEquals("a confirmed copy must always beat an unverifiable one", 3, i)
    }

    @Test
    fun `stale bytes play only when nothing is confirmed`() {
        val i = PlaylistSelection.firstPlayableOrStale(5, none, setOf(2, 4))
        assertEquals("with nothing confirmed, show what we have rather than nothing", 2, i)
    }

    @Test
    fun `nothing at all is still nothing`() {
        assertEquals(-1, PlaylistSelection.firstPlayableOrStale(5, none, none))
        assertEquals(-1, PlaylistSelection.nextPlayableOrStale(5, 2, none, none))
    }

    @Test
    fun `advancing prefers the next confirmed item, wrapping before it settles for stale`() {
        // from=2: the next confirmed is 0 (wrapping). Item 3 has only stale bytes and must not win.
        val i = PlaylistSelection.nextPlayableOrStale(5, 2, setOf(0), setOf(3))
        assertEquals("wrapping to fresh beats stopping at stale", 0, i)
    }

    @Test
    fun `advancing falls back to stale when no confirmed item exists anywhere`() {
        val i = PlaylistSelection.nextPlayableOrStale(5, 1, none, setOf(4))
        assertEquals(4, i)
    }

    /**
     * The regression in one assertion: every item is cached but unverifiable — the OTA case. Before
     * the fallback this returned -1, which is the "Waiting for content" screen.
     */
    @Test
    fun `an entire playlist of unverifiable-but-present content still plays`() {
        val all: (Int) -> Boolean = { true }
        assertEquals(0, PlaylistSelection.firstPlayableOrStale(35, none, all))
    }
}
