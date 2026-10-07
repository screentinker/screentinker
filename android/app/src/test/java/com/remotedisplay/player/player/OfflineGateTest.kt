package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The offline fallback's decisions (OfflineGate). The defect: a web/widget/YouTube item that came
 * round while the network was down painted Chrome's "webpage not available" on the panel, with
 * cached media sitting unused on disk.
 */
class OfflineGateTest {

    private fun item(id: String, widget: String? = null, remote: String? = null) = PlaylistItem(
        assignmentId = 0, contentId = id, filename = id, mimeType = if (remote != null) "video/youtube" else "image/jpeg",
        filepath = "", durationSec = 10, fileSize = 0, sortOrder = 0, widgetId = widget, remoteUrl = remote)

    private val cachedImg = item("img")
    private val widget = item("", widget = "w1")
    private val yt = item("yt", remote = "https://youtu.be/abcdefgh")
    private val always: (PlaylistItem) -> Boolean = { true }
    private val never: (PlaylistItem) -> Boolean = { false }

    @Test fun `widgets and remote items need the network, cached media does not`() {
        assertTrue(OfflineGate.needsNetwork(widget))
        assertTrue(OfflineGate.needsNetwork(yt))
        assertFalse(OfflineGate.needsNetwork(cachedImg))
    }

    private val down: (PlaylistItem) -> Boolean = { OfflineGate.needsNetwork(it) }
    private val up: (PlaylistItem) -> Boolean = { false }

    @Test fun `offline, a web item is skipped when cached media can play instead`() {
        val items = listOf(widget, cachedImg, yt)
        assertTrue(OfflineGate.shouldSkip(down, items, 0, always, always))
        assertTrue(OfflineGate.shouldSkip(down, items, 2, always, always))
        assertFalse("cached media itself is never skipped", OfflineGate.shouldSkip(down, items, 1, always, always))
    }

    @Test fun `online, nothing is skipped — the full list comes back`() {
        val items = listOf(widget, cachedImg, yt)
        for (i in items.indices) assertFalse(OfflineGate.shouldSkip(up, items, i, always, always))
    }

    @Test fun `an all-web playlist is not emptied by being offline`() {
        val items = listOf(widget, yt)
        assertFalse(OfflineGate.shouldSkip(down, items, 0, always, always))
        assertFalse(OfflineGate.shouldSkip(down, items, 1, always, always))
    }

    @Test fun `cached media that is not downloaded, or not scheduled now, is no alternative`() {
        val items = listOf(widget, cachedImg)
        assertFalse("not on disk", OfflineGate.shouldSkip(down, items, 0, always) { false })
        assertFalse("dayparted off", OfflineGate.shouldSkip(down, items, 0, { it !== cachedImg }, always))
        assertFalse(OfflineGate.hasOfflineAlternative(items, never, always))
    }

    @Test fun `server down = every network item cannot load`() {
        val h = OfflineGate.WebHealth()
        assertTrue(OfflineGate.cannotLoad(widget, false, h, 1_000))
        assertTrue(OfflineGate.cannotLoad(yt, false, h, 1_000))
        assertFalse("cached media loads regardless", OfflineGate.cannotLoad(cachedImg, false, h, 1_000))
        assertFalse(OfflineGate.cannotLoad(widget, true, h, 1_000))
    }

    /**
     * Found on the emulator: internet down behind a reachable (self-hosted) server. YouTube fails,
     * the server's own widget still renders — a screen-wide "offline" skipped the widget too.
     */
    @Test fun `one item failing does not take the others with it`() {
        val h = OfflineGate.WebHealth()
        h.reportFailure(yt.itemKey, 10_000)
        assertTrue(OfflineGate.cannotLoad(yt, true, h, 20_000))
        assertFalse("the widget still loads", OfflineGate.cannotLoad(widget, true, h, 20_000))
        assertFalse("forgotten after a minute", OfflineGate.cannotLoad(yt, true, h, 10_000 + OfflineGate.FAILURE_MEMORY_MS))
        h.reportFailure(yt.itemKey, 100_000); h.reportSuccess(yt.itemKey)
        assertFalse("a success since ends it", OfflineGate.cannotLoad(yt, true, h, 101_000))
    }

    @Test fun `the cover waits for 30 s of continuous failure`() {
        assertFalse(OfflineGate.shouldCover(0L, 1_000_000))
        assertFalse(OfflineGate.shouldCover(1_000, 1_000 + OfflineGate.COVER_AFTER_MS - 1))
        assertTrue(OfflineGate.shouldCover(1_000, 1_000 + OfflineGate.COVER_AFTER_MS))
    }
}
