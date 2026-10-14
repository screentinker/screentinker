package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #624: a YouTube item looped (loop=1&playlist=<id>) and was cut off by its duration_sec (10 s by
 * default), because the wrapper page could not tell the app when the video ended. These pin the
 * rules; the wiring (PlaylistController, MediaPlayerManager, ZoneManager) owns a Handler and a
 * WebView and cannot run on the JVM.
 */
class PlayToEndTest {

    @Test
    fun `only a flagged YouTube item in a multi-item, unsynced playlist plays to the end`() {
        assertTrue(PlayToEnd.applies("video/youtube", flag = true, synced = false, playableCount = 2))
        assertFalse("the flag is opt-in per item", PlayToEnd.applies("video/youtube", flag = false, synced = false, playableCount = 2))
        assertFalse("an uploaded video already ends on its own", PlayToEnd.applies("video/mp4", flag = true, synced = false, playableCount = 2))
        assertFalse("images keep their duration", PlayToEnd.applies("image/jpeg", flag = true, synced = false, playableCount = 2))
        assertFalse("a sync group or wall keeps the shared clock", PlayToEnd.applies("video/youtube", flag = true, synced = true, playableCount = 2))
        assertFalse("a one-item playlist keeps looping", PlayToEnd.applies("video/youtube", flag = true, synced = false, playableCount = 1))
    }

    @Test
    fun `THE BUG - the 10 s default is never what ends a play-to-end video`() {
        // Before the length arrives, the duration is only the fallback, and never shorter than the wait.
        assertEquals(PlayToEnd.LENGTH_WAIT_MS, PlayToEnd.waitMs(10_000L))
        assertEquals("a longer duration is honoured as the fallback", 120_000L, PlayToEnd.waitMs(120_000L))
        // Once the length is known, the rest of the video plus slack, whatever the duration was.
        assertEquals(212_000L - 2_000L + PlayToEnd.SLACK_MS, PlayToEnd.safetyMs(212.0, elapsedMs = 2_000L))
    }

    @Test
    fun `an unusable length leaves the fallback wait in place`() {
        assertNull("0 before metadata", PlayToEnd.safetyMs(0.0, 0L))
        assertNull(PlayToEnd.safetyMs(-1.0, 0L))
        assertNull(PlayToEnd.safetyMs(Double.NaN, 0L))
        assertNull("a live stream", PlayToEnd.safetyMs(Double.POSITIVE_INFINITY, 0L))
    }

    @Test
    fun `a length reported late still counts from the item's start, never below the slack`() {
        assertEquals(PlayToEnd.SLACK_MS, PlayToEnd.safetyMs(30.0, elapsedMs = 45_000L))
    }

    @Test
    fun `an ENDED in the first seconds is spurious`() {
        assertFalse(PlayToEnd.endedCounts(500L))
        assertTrue(PlayToEnd.endedCounts(PlayToEnd.MIN_PLAY_MS))
        assertTrue(PlayToEnd.endedCounts(60_000L))
    }

    @Test
    fun `the embed loops unless the video must be allowed to end`() {
        assertEquals("&loop=1&playlist=abc123", PlayToEnd.loopParams("abc123", playToEnd = false))
        assertEquals("", PlayToEnd.loopParams("abc123", playToEnd = true))
    }

    @Test
    fun `a looping page carries no script, so it is unchanged from before`() {
        assertEquals("", PlayToEnd.bridgeScript(null))
    }

    @Test
    fun `a play-to-end page reports length and end under its own token`() {
        val js = PlayToEnd.bridgeScript(42L)
        assertTrue(js.contains("https://www.youtube.com/iframe_api"))
        assertTrue(js.contains("new YT.Player('st-yt'"))
        assertTrue(js.contains("STYoutube.duration(42,"))
        assertTrue(js.contains("STYoutube.ended(42)"))
        assertTrue("ENDED is YT.PlayerState 0", js.contains("e.data===0"))
    }
}
