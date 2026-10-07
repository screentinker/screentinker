package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The screen's HDMI input as an item (LiveInput). The input list below is the one a Fire TV Cube 3rd
 * gen reported to a third-party app, with a BrightSign on HDMI IN.
 */
class LiveInputTest {
    private val cube = listOf(
        LiveInput.Candidate("com.amazon.hedwig/.tif.HedwigTvInputService", false, false, false, null),
        LiveInput.Candidate("com.droidlogic.tvinput/.services.Hdmi1InputService/HW5", true, true, false, null),
        LiveInput.Candidate("com.droidlogic.tvinput/.services.ArcInputService/HW18", false, true, false, null),
        // The CEC device behind HDMI 1 ("Playback_2"): the same socket, not a second port.
        LiveInput.Candidate("com.droidlogic.tvinput/.services.Hdmi1InputService/HDMI110008", true, true, false,
            "com.droidlogic.tvinput/.services.Hdmi1InputService/HW5"),
    )

    @Test fun `hdmi URLs parse to a port, anything else does not`() {
        assertEquals(0, LiveInput.parsePort("hdmi://"))
        assertEquals(1, LiveInput.parsePort("hdmi://1"))
        assertEquals(2, LiveInput.parsePort(" HDMI://2 "))
        for (bad in listOf(null, "", "hdmi://0", "hdmi://1/x", "rtsp://cam", "hdmi:1")) assertNull(bad, LiveInput.parsePort(bad))
    }

    @Test fun `the first hardware HDMI input is picked, and a CEC child is not a second port`() {
        assertEquals("com.droidlogic.tvinput/.services.Hdmi1InputService/HW5", LiveInput.pick(cube, 0)?.id)
        assertEquals("com.droidlogic.tvinput/.services.Hdmi1InputService/HW5", LiveInput.pick(cube, 1)?.id)
        assertNull("the Cube has one HDMI input", LiveInput.pick(cube, 2))
        assertEquals(1, LiveInput.hardwareInputs(cube).size)
    }

    @Test fun `a box without an input has nothing to pick (a Fire TV Stick)`() {
        assertNull(LiveInput.pick(cube.filter { !it.isHdmi }, 0))
        assertTrue(LiveInput.hardwareInputs(emptyList()).isEmpty())
    }

    @Test fun `a hidden input is not offered`() {
        assertNull(LiveInput.pick(cube.map { it.copy(hidden = true) }, 0))
    }

    @Test fun `no picture after tuning fails after 15 s, a lost picture after 10 s`() {
        assertEquals(LiveInput.Verdict.PLAYING, LiveInput.verdict(true, 0L, 1_000L))
        assertEquals(LiveInput.Verdict.WAIT, LiveInput.verdict(false, 1_000L, 1_000L + LiveInput.TUNE_TIMEOUT_MS - 1))
        assertEquals(LiveInput.Verdict.FAULT, LiveInput.verdict(false, 1_000L, 1_000L + LiveInput.TUNE_TIMEOUT_MS))
        assertEquals(LiveInput.Verdict.WAIT, LiveInput.verdict(true, 1_000L, 1_000L + LiveInput.SIGNAL_LOSS_MS - 1))
        assertEquals(LiveInput.Verdict.FAULT, LiveInput.verdict(true, 1_000L, 1_000L + LiveInput.SIGNAL_LOSS_MS))
    }

    @Test fun `a live input never counts as needing the network`() {
        val item = PlaylistItem(0, "c", "HDMI 1", LiveInput.MIME, "", 0, 0, 0, remoteUrl = "hdmi://1")
        assertFalse(OfflineGate.needsNetwork(item))
        assertTrue(LiveInput.isLiveInput(item.mimeType))
    }
}
