package com.remotedisplay.player.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decode must never end up smaller than the box it is displayed in - that is what made stills
 * soft (decoded below screen size, then stretched back up). Measured on a 1024x600 RK3566 panel.
 */
class ImageLoaderSampleSizeTest {

    private fun decoded(srcW: Int, srcH: Int, boxW: Int, boxH: Int): Pair<Int, Int> {
        val s = ImageLoader.calcSampleSize(srcW, srcH, boxW, boxH)
        return (srcW / s) to (srcH / s)
    }

    @Test fun `image exactly the size of the box is not subsampled`() {
        assertEquals(1, ImageLoader.calcSampleSize(1024, 600, 1024, 600))
    }

    @Test fun `HD still on a 1024x600 panel is decoded at full size, not 640x360`() {
        assertEquals(1, ImageLoader.calcSampleSize(1280, 720, 1024, 600))
    }

    @Test fun `1080p still on a 1024x600 panel keeps full resolution`() {
        // 960x540 would be below the box in both directions; 1920x1080 is the smallest step >= it.
        assertEquals(1, ImageLoader.calcSampleSize(1920, 1080, 1024, 600))
    }

    @Test fun `4K still on a 1080p box still halves to 1920x1080`() {
        assertEquals(2, ImageLoader.calcSampleSize(3840, 2160, 1920, 1080))
    }

    @Test fun `4K still on a 1024x600 panel stops at 1920x1080, not 960x540`() {
        assertEquals(2, ImageLoader.calcSampleSize(3840, 2160, 1024, 600))
    }

    @Test fun `portrait still on a portrait box keeps enough resolution`() {
        assertEquals(1, ImageLoader.calcSampleSize(1080, 1920, 600, 1024))
    }

    @Test fun `smaller-than-box image is never subsampled`() {
        assertEquals(1, ImageLoader.calcSampleSize(800, 480, 1024, 600))
    }

    @Test fun `invalid box or source means no subsampling`() {
        assertEquals(1, ImageLoader.calcSampleSize(4000, 3000, 0, 600))
        assertEquals(1, ImageLoader.calcSampleSize(0, 0, 1024, 600))
    }

    @Test fun `decode is never below the box and under 2x per axis`() {
        val boxes = listOf(1024 to 600, 600 to 1024, 1920 to 1080, 1080 to 1920, 3840 to 2160)
        val sources = listOf(800 to 480, 1024 to 600, 1280 to 720, 1920 to 1080, 2000 to 1125,
            3840 to 2160, 1080 to 1920, 6000 to 4000, 12000 to 9000)
        for ((bw, bh) in boxes) for ((sw, sh) in sources) {
            val (dw, dh) = decoded(sw, sh, bw, bh)
            val coversBox = dw >= bw && dh >= bh
            val sourceCoveredBox = sw >= bw && sh >= bh
            if (sourceCoveredBox) assertTrue("$sw x $sh on $bw x $bh -> $dw x $dh is below the box", coversBox)
            if (ImageLoader.calcSampleSize(sw, sh, bw, bh) > 1) {
                assertTrue("$sw x $sh on $bw x $bh -> $dw x $dh is 2x+ the box on both axes",
                    dw < bw * 2 || dh < bh * 2)
            }
        }
    }
}
