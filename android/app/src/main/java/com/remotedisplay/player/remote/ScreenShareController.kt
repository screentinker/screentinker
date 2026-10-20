package com.remotedisplay.player.remote

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * 3.0 screen share — the socket events, in one place, so WebSocketService only forwards them:
 *
 *   device:screenshare-start  {session_id, shared_by, guest, audio, max_seconds, ice_servers}
 *   device:screenshare-stop   {session_id, reason}
 *   device:screenshare-code   {code, url, qr} | {code: null}
 *   device:screenshare-layout {spotlight, audio, count}
 *
 * Several presenters at once (remote.screen_share_tiles): up to [ScreenShareProtocol.MAX_TILES]
 * receivers, one per session, in start order ([ScreenShareSessions]); a start beyond that stops the
 * OLDEST ("replaced" — the server never sends one, this is the backstop). A stop with a session id
 * ends only that share; without one, every share. Exactly one receiver plays its sound: the layout's
 * `audio` when it is one of ours, else the newest (ScreenShareProtocol.audioId), re-decided on every
 * start, end and layout. Which ones are VISIBLE is the overlay's business (ScreenShareBus.layout).
 *
 * While any share is up the playlist is ducked (muted, video frozen) exactly as for Talk, and
 * restored when the LAST one has ended — however it ends. All state is touched on the main thread only.
 */
class ScreenShareController(
    private val appContext: Context,
    /** serverUrl, deviceId, deviceToken — or null when the device is not provisioned. */
    private val credentials: () -> Triple<String, String, String>?,
    private val onDuck: (Boolean) -> Unit,
) {
    private val tag = "ScreenShare"
    private val main = Handler(Looper.getMainLooper())
    private val sessions = ScreenShareSessions<ScreenShareReceiver>()

    val isActive: Boolean get() = !sessions.isEmpty

    fun onStart(data: JSONObject?) = main.post {
        val start = ScreenShareProtocol.parseStart(data) ?: run { Log.w(tag, "start: bad payload"); return@post }
        val (url, id, token) = credentials() ?: run { Log.w(tag, "start: device not provisioned"); return@post }
        if (start.sessionId in sessions) return@post   // already on screen (web: start() returns)
        lateinit var r: ScreenShareReceiver
        r = ScreenShareReceiver(appContext, url, id, token, start) ended@{ reason ->
            Log.i(tag, "ended ${r.sessionId}: $reason")
            if (!sessions.ended(r.sessionId, r)) return@ended   // replaced: already forgotten
            if (sessions.isEmpty) {
                try { onDuck(false) } catch (_: Throwable) {}
                ScreenShareBus.code(ScreenShareBus.code)   // repaint the corner code full size
            } else applyAudio()
        }
        // The oldest make room first; their tiles go when their teardown reaches the window.
        for (old in sessions.add(start.sessionId, r)) old.stop("replaced")
        try { onDuck(true) } catch (_: Throwable) {}
        r.begin()
        applyAudio()
    }

    fun onStop(data: JSONObject?) = main.post {
        val stopId = data?.opt("session_id") as? String
        val reason = (data?.opt("reason") as? String)?.takeIf { it.isNotEmpty() } ?: "stopped"
        // A late stop for a share no longer here matches nothing (ScreenShareProtocol.stopApplies).
        for (r in sessions.stopTargets(stopId)) r.stop(reason)
    }

    fun onCode(data: JSONObject?) = main.post { ScreenShareBus.code(ScreenShareProtocol.parseCode(data)) }

    /** Remembered (a later start is laid out by it too) until the last share has ended. */
    fun onLayout(data: JSONObject?) = main.post {
        val l = ScreenShareProtocol.parseLayout(data)
        sessions.layout = l
        ScreenShareBus.layout(l)
        applyAudio()
    }

    /** Only one presenter is ever heard: every other receiver's remote audio track is disabled. */
    private fun applyAudio() {
        val sound = sessions.audioId()
        for ((sid, r) in sessions.entries()) r.setAudioEnabled(sid == sound)
    }

    /** Socket gone / service destroyed: the relay ends the sessions anyway; do not leave them on screen. */
    fun shutdown(reason: String) = main.post { for (r in sessions.stopTargets(null)) r.stop(reason) }
}
