package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/** #769 — a full-screen item's fit_mode (Fit / Fill / Stretch) was ignored on Android. */
class FullScreenFitTest {

    @Test
    fun itemFitIsUsedAndDefaultsToContain() {
        assertEquals("fill", FullScreenFit.effective("fill", wallMode = false))
        assertEquals("cover", FullScreenFit.effective("cover", wallMode = false))
        assertEquals("contain", FullScreenFit.effective("contain", wallMode = false))
        assertEquals("contain", FullScreenFit.effective(null, wallMode = false))
        assertEquals("contain", FullScreenFit.effective("", wallMode = false))
        assertEquals("contain", FullScreenFit.effective("bogus", wallMode = false))
    }

    @Test
    fun dashboardLabelsAreAccepted() {
        assertEquals("fill", FullScreenFit.normalize("Stretch"))
        assertEquals("fill", FullScreenFit.normalize(" FILL "))
        assertEquals("cover", FullScreenFit.normalize("crop"))
    }

    @Test
    fun aWallAlwaysFills() {
        assertEquals("fill", FullScreenFit.effective("cover", wallMode = true))
        assertEquals("fill", FullScreenFit.effective(null, wallMode = true))
    }

    @Test
    fun scalesFrameTheSourceLikeTheView() {
        // a 1000x500 image on a 1920x1080 stage
        assertEquals(1.92f to 2.16f, FullScreenFit.scales(1000f, 500f, 1920f, 1080f, "fill"))
        assertEquals(1.92f to 1.92f, FullScreenFit.scales(1000f, 500f, 1920f, 1080f, "contain"))
        assertEquals(2.16f to 2.16f, FullScreenFit.scales(1000f, 500f, 1920f, 1080f, "cover"))
        assertEquals(1f to 1f, FullScreenFit.scales(0f, 0f, 1920f, 1080f, "fill"))
    }
}
