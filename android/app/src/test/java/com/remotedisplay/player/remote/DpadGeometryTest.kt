package com.remotedisplay.player.remote

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Remote D-pad directional navigation. Pins that a press moves to the visually-adjacent target in the
 * pressed direction and never backward, so the highlight walks a list in order (a broken pick, or the
 * earlier reset bug, showed as the highlight oscillating on the top rows).
 */
class DpadGeometryTest {

    // A vertical list of three rows at x=500, y = 100 / 200 / 300.
    private val rows = listOf(intArrayOf(500, 100), intArrayOf(500, 200), intArrayOf(500, 300))

    @Test fun `down from the top edge picks the nearest row below`() {
        assertEquals(0, DpadGeometry.pick(500, 0, rows, DpadGeometry.DOWN))
    }

    @Test fun `down from a row picks the next row down, not itself or above`() {
        assertEquals(2, DpadGeometry.pick(500, 200, rows, DpadGeometry.DOWN))
    }

    @Test fun `up from a row picks the row above`() {
        assertEquals(1, DpadGeometry.pick(500, 300, rows, DpadGeometry.UP))
    }

    @Test fun `down from the bottom row finds nothing`() {
        assertEquals(-1, DpadGeometry.pick(500, 300, rows, DpadGeometry.DOWN))
    }

    @Test fun `left and right pick horizontally`() {
        val cols = listOf(intArrayOf(100, 400), intArrayOf(300, 400), intArrayOf(500, 400))
        assertEquals(2, DpadGeometry.pick(300, 400, cols, DpadGeometry.RIGHT))
        assertEquals(0, DpadGeometry.pick(300, 400, cols, DpadGeometry.LEFT))
    }

    @Test fun `prefers the straight-ahead target over a nearer diagonal one`() {
        // index 0 is directly below; index 1 is slightly closer along Y but offset sideways.
        val cands = listOf(intArrayOf(500, 200), intArrayOf(560, 180))
        assertEquals(0, DpadGeometry.pick(500, 100, cands, DpadGeometry.DOWN))
    }
}
