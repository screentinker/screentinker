package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #344 — the wipe's box arithmetic.
 *
 * This is the half of the transition that has no test today and where two silent regressions have
 * now lived: #326 fitted the wipe to the wrong box, and its follow-up fitted to a GONE overlay's
 * zero size. The Android graphics path (Canvas/Matrix) cannot run on the JVM, but the box decision
 * can, so this pins the contract the compositor and MainActivity must agree on:
 *
 *   - the stage is transposed for a portrait (swap) screen, and
 *   - rotating that stage box by the applied rotation must land back on the screen box we draw onto.
 *
 * A wipe that cannot satisfy the second point is the exact fault #344 asks us to hard-cut on instead
 * of playing at the wrong aspect.
 */
class TransitionGeometryTest {

    @Test fun `stage box is the screen box in landscape and its transpose in portrait`() {
        assertEquals(1024 to 600, TransitionGeometry.stageBox(1024, 600, swap = false))
        assertEquals(600 to 1024, TransitionGeometry.stageBox(1024, 600, swap = true))
    }

    @Test fun `only 90 and 270 transpose the stage`() {
        assertFalse(TransitionGeometry.swapForRotation(0))
        assertTrue(TransitionGeometry.swapForRotation(90))
        assertFalse(TransitionGeometry.swapForRotation(180))
        assertTrue(TransitionGeometry.swapForRotation(270))
        // normalised, so 360 and negatives behave
        assertFalse(TransitionGeometry.swapForRotation(360))
        assertTrue(TransitionGeometry.swapForRotation(-90))   // == 270
    }

    @Test fun `the rotated stage box matches the screen box for every real orientation`() {
        val screenW = 1024; val screenH = 600
        // landscape: no transpose, no rotation
        assertTrue(TransitionGeometry.rotatedStageMatchesScreen(1024, 600, screenW, screenH, 0))
        // landscape-flipped: no transpose, 180
        assertTrue(TransitionGeometry.rotatedStageMatchesScreen(1024, 600, screenW, screenH, 180))
        // portrait: stage transposed to 600x1024, rotated 90 lands back on 1024x600
        assertTrue(TransitionGeometry.rotatedStageMatchesScreen(600, 1024, screenW, screenH, 90))
        // portrait-flipped: 270
        assertTrue(TransitionGeometry.rotatedStageMatchesScreen(600, 1024, screenW, screenH, 270))
    }

    @Test fun `fitting to the wrong box is rejected - the shape of both regressions`() {
        // #326: portrait screen, but the stage box was NOT transposed (device metrics). Rotating a
        // 1024x600 box by 90 gives 600x1024, which is not the 1024x600 screen -> reject, hard-cut.
        assertFalse(TransitionGeometry.rotatedStageMatchesScreen(1024, 600, 1024, 600, 90))
        // the follow-up: a zero box (the GONE overlay's measured size) never matches.
        assertFalse(TransitionGeometry.rotatedStageMatchesScreen(0, 0, 1024, 600, 0))
        assertFalse(TransitionGeometry.rotatedStageMatchesScreen(600, 1024, 0, 0, 90))
    }
}
