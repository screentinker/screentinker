package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Continuity identity for playlist items.
 *
 * ⚠️ THE BUG THIS EXISTS FOR: widget items carry `contentId = ""`, and continuity was keyed on
 * contentId alone. So in a playlist made of widgets — which is exactly what a deck of slides is —
 * every item looked like every other item. `indexOfFirst { it.contentId == currentlyPlayingId }`
 * returned INDEX 0 regardless of what was on screen, so any edit snapped playback back to the
 * first slide, and the early `return` meant nothing re-rendered either.
 *
 * These are pure assertions about the KEY, deliberately. The controller needs a Looper and a real
 * WebView to instantiate, so the behaviour around it is not unit-testable here; what is testable —
 * and what actually broke — is whether two different items can produce the same identity.
 */
class PlaylistItemKeyTest {

    private fun item(
        contentId: String = "",
        widgetId: String? = null,
        widgetRev: Long = 0L,
        sortOrder: Int = 0,
    ) = PlaylistItem(
        assignmentId = sortOrder,
        contentId = contentId,
        filename = "f",
        mimeType = "image/png",
        filepath = "f.png",
        durationSec = 10,
        fileSize = 1L,
        sortOrder = sortOrder,
        widgetId = widgetId,
        widgetRev = widgetRev,
    )

    @Test
    fun `two different widgets are not the same item`() {
        val a = item(widgetId = "w-1")
        val b = item(widgetId = "w-2")
        assertNotEquals("a deck of slides collapsed into one item", a.itemKey, b.itemKey)
    }

    @Test
    fun `every widget in an all-widget playlist has a distinct key`() {
        // The real shape of the bug: a deck. Under the old key these were all "".
        val deck = (1..6).map { item(widgetId = "w-$it", sortOrder = it) }
        val keys = deck.map { it.itemKey }.toSet()
        assertEquals("widget items are not distinguishable from each other", 6, keys.size)
    }

    @Test
    fun `a widget keeps its identity across an edit`() {
        // The other half of the design: editing a widget bumps widgetRev but must NOT change which
        // item it is, or the playlist restarts on every text change — which is #234.
        val before = item(widgetId = "w-1", widgetRev = 4L)
        val after = item(widgetId = "w-1", widgetRev = 5L)
        assertEquals("an edit changed the item's identity", before.itemKey, after.itemKey)
        assertNotEquals("the rev must still be visible as a change", before.widgetRev, after.widgetRev)
    }

    @Test
    fun `a content item and a widget item never collide`() {
        // Shaped as "abc|" vs "|w-1" precisely so these two spaces cannot overlap.
        val content = item(contentId = "abc")
        val widget = item(widgetId = "abc")
        assertNotEquals(content.itemKey, widget.itemKey)
    }

    @Test
    fun `content items keep behaving exactly as before`() {
        assertEquals("abc|", item(contentId = "abc").itemKey)
        assertNotEquals(item(contentId = "abc").itemKey, item(contentId = "def").itemKey)
    }

    @Test
    fun `an item with neither id is still not silently equal to a real one`() {
        // Not a shape the server sends, but the key must not degrade to a value that matches
        // something meaningful if it ever appears.
        val empty = item()
        assertEquals("|", empty.itemKey)
        assertTrue(empty.itemKey != item(contentId = "x").itemKey)
        assertTrue(empty.itemKey != item(widgetId = "x").itemKey)
    }
}
