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
    private val emitSync: (isGroup: Boolean, syncId: String, idx: Int, contentId: String?, posSec: Float) -> Unit,
    private val emitSyncRequest: (isGroup: Boolean, syncId: String) -> Unit,
    private val applyTransform: (WallConfig?) -> Unit
) {
    // WALL: spatial tiling (transform + object-fit:fill + followers muted).
    // GROUP: #group-sync — same leader/follower timing, but full-screen content, no transform, and
    // per-item mute honored (no forced follower mute). syncId is the wall_id or the group_id.
    enum class Mode { WALL, GROUP }
    data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)
    data class WallConfig(
        val wallId: String,                    // sync id: wall_id (WALL) or group_id (GROUP)
        val screen: Rect,
        val player: Rect,
        val isLeader: Boolean,
        val rotation: Int,
        val mode: Mode = Mode.WALL
    )
    private val WallConfig.isGroup: Boolean get() = mode == Mode.GROUP

    private val handler = Handler(Looper.getMainLooper())
    private var config: WallConfig? = null
    private var tick: Runnable? = null

    val isActive: Boolean get() = config != null

    /** Enter/refresh wall mode for the given config (idempotent; handles role flips). */
    fun apply(cfg: WallConfig) {
        config = cfg
        Log.i("WallController", "apply wall=${cfg.wallId} isLeader=${cfg.isLeader}")

        // WALL-only spatial bits — a group syncs timing only, full-screen, per-item mute honored.
        applyTransform(if (cfg.isGroup) null else cfg)   // size/translate root view (wall) or clear (group)
        media.setWallMode(!cfg.isGroup)                  // object-fit:fill for wall; normal fit for group
        media.setWallMute(!cfg.isGroup && !cfg.isLeader) // followers muted only on a wall (avoid flange)
        // Common to both: followers don't self-advance + loop video so they never freeze.
        playlist.setWallFollower(!cfg.isLeader)
        media.setVideoLooping(!cfg.isLeader)

        stopTimer()
        if (cfg.isLeader) {
            tick = object : Runnable {
                override fun run() { emitNow(); handler.postDelayed(this, 250) }
            }
            handler.postDelayed(tick!!, 250)
            handler.postDelayed({ emitNow() }, 100)   // immediate first align
        } else {
            emitSyncRequest(cfg.isGroup, cfg.wallId)  // align now, don't wait a tick
        }
    }

    /**
     * Hard teardown for Activity destruction. Kills the 4Hz leader tick and drops the config so any
     * still-queued tick no-ops (emitNow bails on a null config). Unlike [exit] this touches NO views
     * or media — the Activity is going away (its MediaPlayer is about to be released), and restoring
     * wall-mode/transform on a dying Activity is both pointless and unsafe.
     *
     * MUST be called from MainActivity.onDestroy(): the Handler runs on the MAIN looper, which
     * outlives the Activity, so a leader tick left running becomes a zombie that keeps broadcasting
     * `group:sync`/`wall:sync` forever against a released player — producing split-brain (two live
     * "leaders") and garbage positions. This is the teardown that prevents that leak.
     */
    fun shutdown() {
        stopTimer()
        config = null
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
        emitSync(c.isGroup, c.wallId, playlist.getIndex(), item.contentId.ifEmpty { null }, pos)
    }

    // Sync payloads carry the id under "group_id" (group) or "wall_id" (wall).
    private fun WallConfig.idField(): String = if (isGroup) "group_id" else "wall_id"

    /** Handle an incoming sync broadcast (followers only). */
    fun onSync(data: JSONObject) {
        val c = config ?: return
        if (c.isLeader) return
        if (data.optString(c.idField()) != c.wallId) return

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

    /** Handle a follower's sync-request (leader only): broadcast position now. */
    fun onSyncRequest(data: JSONObject) {
        val c = config ?: return
        if (!c.isLeader) return
        if (data.has(c.idField()) && data.optString(c.idField()) != c.wallId) return
        emitNow()
    }

    private fun stopTimer() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }
}
