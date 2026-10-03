package com.remotedisplay.player.remote

import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * #talk video — decouples the incoming webcam track (received in AudioTalker, inside TalkService)
 * from where it is rendered (a SurfaceViewRenderer in MainActivity, the only place with a window).
 *
 * AudioTalker publishes the remote video track plus the EglBase context its decoder factory uses
 * (the renderer must share it); MainActivity holds the listener and renders/clears. A null track
 * means "the call ended — tear the surface down".
 */
object TalkVideoBus {
    @Volatile var listener: ((VideoTrack?, EglBase.Context?) -> Unit)? = null

    fun publish(track: VideoTrack?, egl: EglBase.Context?) {
        try { listener?.invoke(track, egl) } catch (_: Throwable) {}
    }
}
