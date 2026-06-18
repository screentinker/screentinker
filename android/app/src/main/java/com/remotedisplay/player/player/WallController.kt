package com.remotedisplay.player.player

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import kotlin.math.abs

/**
 * Video-wall (`wall:sync`) controller. Native Kotlin/ExoPlayer port of the web player
 * (`server/player/index.html`) and the Tizen `WallController` — same protocol, gates, and
 * drift maths.
 *
 *  - Leader: plays normally and broadcasts `wall:sync` at 4Hz (plus an immediate align on
 *    entry and on every `wall:sync-request`).
 *  - Follower: never self-advances; switches item only when a `wall:sync` carries a new
 *    `current_index`, and for video runs a latency-compensated drift controller that hard-
 *    seeks on large drift and nudges playbackRate on small drift. Followers are muted.
 *
 * The slice view transform (sizing/translating the root view to this screen's tile) lives in
 * MainActivity and is invoked through [applyTransform]. Per-tile `rotation` is intentionally
 * not applied (web/Tizen parity — left as a TODO).
 *
 * All ExoPlayer/View touches happen on the main thread; the 4Hz timer runs on the main looper
 * and `onSync` is delivered on the main thread by WebSocketService.
 */
class WallController(
    private val media: MediaPlayerManager,
    private val playlist: PlaylistController,
    private val deviceId: () -> String,
    private val emitSync: (wallId: String, idx: Int, contentId: String?, posSec: Float) -> Unit,
    private val emitSyncRequest: (wallId: String) -> Unit,
    private val applyTransform: (WallConfig?) -> Unit
) {
    data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)
    data class WallConfig(
        val wallId: String,
        val screen: Rect,
        val player: Rect,
        val isLeader: Boolean,
        val rotation: Int
    )

    private val handler = Handler(Looper.getMainLooper())
    private var config: WallConfig? = null
    private var tick: Runnable? = null

    val isActive: Boolean get() = config != null

    /** Enter/refresh wall mode for the given config (idempotent; handles role flips). */
    fun apply(cfg: WallConfig) {
        config = cfg
        Log.i("WallController", "apply wall=${cfg.wallId} isLeader=${cfg.isLeader}")

        applyTransform(cfg)                       // size/translate the root view to our slice
        media.setWallMode(true)                   // object-fit:fill parity
        playlist.setWallFollower(!cfg.isLeader)   // followers don't self-advance
        media.setWallMute(!cfg.isLeader)          // followers muted (avoid flange)
        media.setVideoLooping(!cfg.isLeader)      // followers loop so they never freeze

        stopTimer()
        if (cfg.isLeader) {
            tick = object : Runnable {
                override fun run() { emitNow(); handler.postDelayed(this, 250) }
            }
            handler.postDelayed(tick!!, 250)
            handler.postDelayed({ emitNow() }, 100)   // immediate first align
        } else {
            emitSyncRequest(cfg.wallId)               // align now, don't wait a tick
        }
    }

    /** Leave wall mode and restore full-screen playback. */
    fun exit() {
        stopTimer()
        val had = config != null
        config = null
        if (!had) return
        Log.i("WallController", "exit wall mode")
        playlist.setWallFollower(false)
        media.setWallMute(false)
        media.setVideoLooping(false)
        media.setWallMode(false)
        applyTransform(null)
    }

    private fun emitNow() {
        val c = config ?: return
        if (!c.isLeader) return
        val item = playlist.currentItem ?: return
        val pos = if (media.isPlayingVideo()) {
            media.currentPositionMs() / 1000f
        } else {
            ((System.currentTimeMillis() - playlist.itemStartedAtMs()) / 1000f).coerceAtLeast(0f)
        }
        emitSync(c.wallId, playlist.getIndex(), item.contentId.ifEmpty { null }, pos)
    }

    /** Handle an incoming `wall:sync` (followers only). */
    fun onSync(data: JSONObject) {
        val c = config ?: return
        if (c.isLeader) return
        if (data.optString("wall_id") != c.wallId) return

        val leaderIdx = data.optInt("current_index", -1)
        if (leaderIdx >= 0 && leaderIdx != playlist.getIndex()) playlist.gotoIndex(leaderIdx)

        if (!media.isPlayingVideo()) return       // images/widgets: index match is enough

        val sentAt = data.optLong("sent_at", 0L)
        val latency = if (sentAt > 0) ((System.currentTimeMillis() - sentAt) / 1000f).coerceAtLeast(0f) else 0f
        val target = data.optDouble("position_sec", 0.0).toFloat() + latency
        val curSec = media.currentPositionMs() / 1000f
        val durMs = media.durationMs()
        val durSec = if (durMs < 0) Float.NaN else durMs / 1000f
        val drift = curSec - target
        val ad = abs(drift)
        when {
            // Large drift: hard-seek (only when the target is within a known duration so we
            // don't seek past the end). Don't seek every tick — exact seeks are expensive.
            ad > 0.3f && !durSec.isNaN() && target < durSec -> {
                media.seekExact((target * 1000).toLong())
                media.setSpeed(1.0f)
            }
            // Small drift: gentle ±3% playbackRate nudge to converge.
            ad > 0.05f -> media.setSpeed(if (drift > 0) 0.97f else 1.03f)
            else -> media.setSpeed(1.0f)
        }
    }

    /** Handle a follower's `wall:sync-request` (leader only): broadcast position now. */
    fun onSyncRequest(data: JSONObject) {
        val c = config ?: return
        if (!c.isLeader) return
        if (data.has("wall_id") && data.optString("wall_id") != c.wallId) return
        emitNow()
    }

    private fun stopTimer() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }
}
