package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Full-screen video goes to the hardware plane (SurfaceView) only when the display asked for it AND
 * nothing needs the video to be in the UI layer: a SurfaceView ignores view transforms, so a rotated
 * stage, a wall slice or a counter-turned clip would draw wrong there.
 */
class NativeVideoPlaneTest {
    private fun ok(
        enabled: Boolean = true, hasView: Boolean = true, wall: Boolean = false,
        stage: Float = 0f, turn: Float = 0f, fisheye: Boolean = false, audio: Boolean = false,
    ) = NativeVideoPlane.eligible(enabled, hasView, wall, stage, turn, fisheye, audio)

    @Test fun aPlainLandscapeClipOnAnOptedInDisplayUsesTheHardwarePlane() = assertTrue(ok())
    @Test fun offByDefault() = assertFalse(ok(enabled = false))
    @Test fun noNativeViewInflatedMeansTexture() = assertFalse(ok(hasView = false))
    @Test fun aWallSliceNeedsTheViewTransform() = assertFalse(ok(wall = true))
    @Test fun aRotatedStageNeedsTheViewTransform() {
        assertFalse(ok(stage = 90f))
        assertFalse(ok(stage = 270f))
        assertFalse(ok(stage = -90f))
    }
    @Test fun aFullTurnIsNoTurn() = assertTrue(ok(stage = 360f))
    @Test fun aCounterTurnedClipNeedsTheViewTransform() = assertFalse(ok(turn = 90f))
    @Test fun fisheyeRendersThroughItsOwnGlSurface() = assertFalse(ok(fisheye = true))
    @Test fun anAudioItemShowsItsCardNotAVideoSurface() = assertFalse(ok(audio = true))

    @Test
    fun theLayoutInflatesASurfaceViewPlayerNextToTheTextureOne() {
        val f = File("src/main/res/layout/activity_main.xml")
        assertTrue("layout not found: ${f.absolutePath}", f.exists())
        val xml = f.readText()
        val native = xml.indexOf("@+id/nativePlayerView")
        assertTrue("the native player view is inflated", native >= 0)
        val end = xml.indexOf("/>", native)
        assertTrue("it uses surface_view", xml.substring(native, end).contains("app:surface_type=\"surface_view\""))
        assertTrue("and starts hidden", xml.substring(native, end).contains("android:visibility=\"gone\""))
    }

    @Test
    fun cachedPlaylistRestoresNativeVideoBeforeStartingCachedItems() {
        val source = File("src/main/java/com/remotedisplay/player/MainActivity.kt").readText()
        val restore = source.indexOf("val cached = JSONObject(cachedJson)")
        val setting = source.indexOf("mediaPlayer.setNativeVideo(cached.optBoolean(\"native_video\", false))", restore)
        val playlistStart = source.indexOf("playlistController.updatePlaylist(assignments, cachedOrder)", restore)
        assertTrue("cached native-video setting is restored", setting > restore)
        assertTrue("setting is restored before cached items start", playlistStart < 0 || setting < playlistStart)
    }

    @Test
    fun imageAsVideoKeepsTheOutgoingImageUntilTheNewVideoFrameRenders() {
        val source = File("src/main/java/com/remotedisplay/player/player/MediaPlayerManager.kt").readText()
        val mount = source.substringAfter("fun playImageAsVideoVariantFromFile(").substringBefore("// #129: live per-item mute")
        val cover = mount.indexOf("coverSwitchGap(myGeneration)")
        val typeChange = mount.indexOf("currentType = MediaType.VIDEO")
        assertTrue("captures/retains the outgoing frame before changing media type", cover >= 0 && typeChange > cover)
        assertTrue("keeps the cover when this mount owns it", mount.contains("if (coverGeneration != myGeneration) imageView.visibility = android.view.View.GONE"))
        assertTrue("removes the cover after a real video frame renders", source.contains("override fun onRenderedFirstFrame()") && source.contains("if (player === exoPlayer) clearSwitchCover()"))
    }
}
