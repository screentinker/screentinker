package com.remotedisplay.player.remote

import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * 3.0 screen share — decouples the receivers (ScreenShareReceiver, one per session, owned by
 * ScreenShareController in WebSocketService, which is where the socket events arrive) from where
 * they are drawn (ScreenShareOverlay in MainActivity, the only place with a window). Same split as
 * [TalkVideoBus].
 *
 * Every call reaches the listener on the main thread, in the order it was made. The bus also
 * remembers every session on screen (start order, oldest first, each with its track once it has
 * one), the last layout and the current meeting-room code, so an Activity that is recreated
 * mid-share (rotation, a crash restart) can paint the right thing when it attaches.
 *
 * Callers: start() on the main thread (ScreenShareReceiver.begin), track()/end() on a receiver's
 * own ctl thread, layout()/code() on the main thread — so the session table is under a lock.
 */
object ScreenShareBus {
    interface Listener {
        /** A share started: a tile for it, "Connecting to …" until the first frame, and its badge. */
        fun onShareStart(start: ScreenShareProtocol.Start)
        /** Share [sessionId]'s video arrived. [egl] is the context its decoder renders in. */
        fun onShareTrack(sessionId: String, track: VideoTrack, egl: EglBase.Context)
        /**
         * Share [sessionId] is over, however it ended: let go of ITS track and drop its tile (only
         * that one — the others stay). Unknown ids are ignored.
         */
        fun onShareEnd(sessionId: String)
        /** Which share fills the screen and whose sound plays (device:screenshare-layout). */
        fun onLayout(layout: ScreenShareProtocol.Layout)
        /** The meeting-room code to show in the corner, or null to hide it. */
        fun onCode(code: ScreenShareProtocol.Code?)
    }

    private class Session(val start: ScreenShareProtocol.Start) {
        var track: VideoTrack? = null
        var egl: EglBase.Context? = null
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val lock = Any()
    private val sessions = LinkedHashMap<String, Session>()   // guarded by lock; oldest first

    @Volatile var listener: Listener? = null
        set(value) {
            field = value
            // Late attach: bring the new window up to date.
            if (value != null) main.post {
                try {
                    val snap = synchronized(lock) { sessions.values.map { Triple(it.start, it.track, it.egl) } }
                    for ((s, t, e) in snap) {
                        value.onShareStart(s)
                        if (t != null && e != null) value.onShareTrack(s.sessionId, t, e)
                    }
                    value.onLayout(layout)
                    value.onCode(code)
                } catch (_: Throwable) {}
            }
        }

    /** True while any share is on screen. */
    val active: Boolean get() = synchronized(lock) { sessions.isNotEmpty() }
    @Volatile var layout: ScreenShareProtocol.Layout = ScreenShareProtocol.Layout.NONE; private set
    @Volatile var code: ScreenShareProtocol.Code? = null; private set

    fun start(s: ScreenShareProtocol.Start) {
        synchronized(lock) { sessions[s.sessionId] = Session(s) }
        main.post { try { listener?.onShareStart(s) } catch (_: Throwable) {} }
    }

    fun track(sessionId: String, t: VideoTrack, e: EglBase.Context) {
        synchronized(lock) {
            val s = sessions[sessionId] ?: return
            s.track = t; s.egl = e
        }
        main.post { try { listener?.onShareTrack(sessionId, t, e) } catch (_: Throwable) {} }
    }

    /**
     * Share [sessionId] is over. [done] runs after the window has detached its renderer from THAT
     * session's track — the receiver waits for it before disposing its PeerConnection, because
     * disposing a track that a sink is still attached to is a native crash in libwebrtc. Each
     * receiver has its own handshake; ending one never touches another's track.
     */
    fun end(sessionId: String, done: (() -> Unit)? = null) {
        synchronized(lock) {
            sessions.remove(sessionId)
            // The last one gone: forget the layout too (web: layoutState reset with the overlay).
            if (sessions.isEmpty()) layout = ScreenShareProtocol.Layout.NONE
        }
        main.post {
            try { listener?.onShareEnd(sessionId) } catch (_: Throwable) {}
            try { done?.invoke() } catch (_: Throwable) {}
        }
    }

    fun layout(l: ScreenShareProtocol.Layout) {
        layout = l
        main.post { try { listener?.onLayout(l) } catch (_: Throwable) {} }
    }

    fun code(c: ScreenShareProtocol.Code?) {
        code = c
        main.post { try { listener?.onCode(c) } catch (_: Throwable) {} }
    }
}
