package com.remotedisplay.player.player

/**
 * "Native video plane": full-screen video on a SurfaceView instead of the usual TextureView.
 *
 * ⚠️ WHY THIS EXISTS. Most Android TV boxes draw their UI at 1920x1080 while the HDMI output is
 * 3840x2160 (a Chromecast with Google TV reports screen 3840x2160, render 1920x1080). A TextureView
 * is drawn through the GPU INTO that UI layer, so a 4K clip is scaled down to 1080p and the box's
 * scaler stretches it back up. A SurfaceView is its own hardware layer, composed by the display
 * controller at the output resolution: that is how YouTube and Netflix show real 4K on the same box.
 *
 * ⚠️ WHY IT IS OPT-IN. A SurfaceView is not part of the view hierarchy's drawing, so everything that
 * relies on the video being IN the UI layer stops working for that clip:
 *  - transitions into and out of the video (no frame to grab) -> hard cut;
 *  - screenshots / remote view show the video area black;
 *  - view transforms are ignored (rotated stage, video-wall slice, the TV-safe counter-turn);
 *  - the fisheye dewarp renders into its own GL surface.
 * So the setting is per display, and even when it is on a clip only goes to the hardware plane when
 * none of those transforms is in play; otherwise it quietly uses the TextureView as before.
 */
object NativeVideoPlane {
    /**
     * Whether this full-screen video mount goes to the SurfaceView.
     *
     * [stageRotationDeg] is the rotation applied to the stage (0 on a panel shown in its native
     * orientation), [counterTurnDeg] the TV-safe counter-turn of a pre-rotated clip (0 = none).
     */
    @JvmStatic
    fun eligible(
        enabled: Boolean,
        hasNativeView: Boolean,
        wallMode: Boolean,
        stageRotationDeg: Float,
        counterTurnDeg: Float,
        fisheye: Boolean,
        audioOnly: Boolean,
    ): Boolean {
        if (!enabled || !hasNativeView) return false
        if (wallMode || fisheye || audioOnly) return false
        if (norm(stageRotationDeg) != 0f || norm(counterTurnDeg) != 0f) return false
        return true
    }

    private fun norm(deg: Float): Float = ((deg % 360f) + 360f) % 360f
}
