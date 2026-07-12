package com.remotedisplay.player.player

import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.math.abs

/**
 * #group-sync — clock/schedule group synchronization. Native Kotlin port of the web player's
 * groupScheduleTick (server/player/index.html) and the Tizen GroupSyncController.
 *
 * Unlike a video wall there is NO leader and NO server relay of positions. Every same-playlist
 * member lays the deterministic playlist schedule (PlaylistController.groupScheduleTarget) on a
 * server-DISCIPLINED clock ([syncedNow]) and derives the identical (index, position) locally. That
 * makes group sync:
 *   - offline-native: it needs no server at play-time (the clock offset is cached), and
 *   - split-brain-proof: there is no leader role to double-elect (the class of bug that the leaked
 *     WallController tick produced).
 *
 * The 4Hz tick runs on the main looper. It reuses PlaylistController.wallFollower (loop + no local
 * auto-advance) so the schedule alone drives index transitions, and for video applies the same
 * seek/nudge drift maths the wall uses — but toward the SCHEDULE target, not a leader broadcast.
 */
class GroupScheduleController(
    private val playlist: PlaylistController,
    private val media: MediaPlayerManager,
    private val syncedNow: () -> Long,
    private val report: (String) -> Unit,
    // #group-sync double buffer: called ~PRELOAD_LEAD_SEC before a boundary with the NEXT item's index
    // so the host can resolve its file and warm the second player. No-op host is fine (falls back to a
    // cold prepare = the old brief hold).
    private val onPreloadNext: (Int) -> Unit = {}
) {
    private val handler = Handler(Looper.getMainLooper())
    private var tick: Runnable? = null
    private var groupId: String? = null
    private var dbgLast = 0L
    private var preloadedForIndex = -1
    private val PRELOAD_LEAD_SEC = 6f
    // Seek cooldown: a hard-seek flushes the video decoder, so seeking EVERY tick (when a clip lags
    // under load on a weak panel) prevents it from ever rendering a frame → the whole thing spirals
    // to black. After a seek, hold off ~1.2s and just NUDGE instead, letting the decoder catch up.
    private var lastSeekAt = 0L
    private val SEEK_COOLDOWN_MS = 1200L
    // Set whenever the schedule moves us to a new item (or on first entry). The FIRST video correction
    // after a load is an unconditional hard-seek to the exact schedule position — "load and hold" —
    // instead of the gentle ±3% nudge, which would take ~10s to eat the ~0.3s load offset (the "5s to
    // sync" symptom). After that one snap, steady-state drift rides the gentle nudge as before.
    private var alignPending = true
    private var lastAlignedIndex = -1

    val isActive: Boolean get() = groupId != null

    /** Enter/refresh group sync for [gid]. Idempotent. */
    fun apply(gid: String) {
        val first = groupId == null
        groupId = gid
        // Group member: loop + no local auto-advance (the schedule tick owns the index); full-screen;
        // per-item mute honored (displays are spread out, so no forced follower mute like a wall).
        playlist.setWallFollower(true)
        media.setVideoLooping(true)
        media.setWallMode(false)
        media.setWallMute(false)
        alignPending = true; lastAlignedIndex = -1   // snap the first item into sync on entry
        stopTimer()
        tick = object : Runnable {
            override fun run() { doTick(); handler.postDelayed(this, 250) }
        }
        handler.post(tick!!)   // align immediately, then 4Hz
        report("group-sync ${if (first) "entered" else "refresh"} group=${gid.take(8)}")
        Log.i("GroupSchedule", "apply group=$gid")
    }

    /** Leave group sync and restore normal (self-advancing) playback. */
    fun exit() {
        if (groupId == null && tick == null) return
        stopTimer()
        groupId = null
        playlist.setWallFollower(false)
        media.setVideoLooping(false)
        report("group-sync exited")
        Log.i("GroupSchedule", "exit")
    }

    /** Server-nudged immediate re-align (dashboard "Resync now"). */
    fun resync() { if (groupId != null) { report("manual resync"); doTick() } }

    /**
     * Hard teardown for Activity destruction — kills the tick so it can't outlive the Activity on the
     * main looper (the same leak the WallController.shutdown() fix addresses). Called from onDestroy.
     */
    fun shutdown() { stopTimer(); groupId = null }

    private fun stopTimer() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }

    private fun doTick() {
        if (groupId == null) return
        val sn = syncedNow()
        val t = playlist.groupScheduleTarget(sn) ?: return
        var action = "hold"
        // Double buffer: warm the next clip ~PRELOAD_LEAD_SEC before the boundary (once per boundary).
        if (t.nextIndex != t.index && t.secToBoundary in 0f..PRELOAD_LEAD_SEC && preloadedForIndex != t.nextIndex) {
            onPreloadNext(t.nextIndex); preloadedForIndex = t.nextIndex
        }
        if (t.index != playlist.getIndex()) {
            playlist.gotoIndex(t.index)
            preloadedForIndex = -1               // re-arm preload for the next boundary
            action = "jump>${t.index}"
        } else if (media.isPlayingVideo()) {
            val durMs = media.durationMs()
            if (durMs > 0) {
                val dur = durMs / 1000f
                val target = t.posSec % dur                       // loop-safe when the slot > clip length
                val drift = media.currentPositionMs() / 1000f - target
                val ad = abs(drift)
                // A fresh item (index changed since our last align) snaps ONCE to the exact position —
                // load-and-hold — so it doesn't spend ~10s nudging away a ~0.3s load offset.
                if (playlist.getIndex() != lastAlignedIndex) alignPending = true
                val nowMs = System.currentTimeMillis()
                when {
                    alignPending -> {
                        if (ad > 0.05f) { media.seekExact((target * 1000).toLong()); lastSeekAt = nowMs }
                        media.setSpeed(1.0f); alignPending = false; lastAlignedIndex = playlist.getIndex()
                        action = "align ${fmt(drift)}"
                    }
                    // Large drift: hard-seek, but only if we're past the cooldown — otherwise NUDGE so we
                    // don't flush the decoder every tick (the black-screen spiral under load).
                    ad > 0.3f && nowMs - lastSeekAt > SEEK_COOLDOWN_MS -> {
                        media.seekExact((target * 1000).toLong()); media.setSpeed(1.0f); lastSeekAt = nowMs
                        action = "seek ${fmt(drift)}"
                    }
                    ad > 0.05f -> { media.setSpeed(if (drift > 0) 0.97f else 1.03f); action = "nudge ${fmt(drift)}" }
                    else -> media.setSpeed(1.0f)
                }
            }
        }
        // Log discrete corrections (jump/align/seek) the instant they happen so the transition is
        // visible; only the routine steady-state line (hold/nudge) is throttled to ~1Hz. Otherwise the
        // one-tick "align" on load gets sampled over by a later "hold"/"nudge" and reads misleadingly.
        val now = System.currentTimeMillis()
        val discrete = action.startsWith("jump") || action.startsWith("align") || action.startsWith("seek")
        if (discrete || now - dbgLast > 1000) {
            dbgLast = now
            val line = "idx=${playlist.getIndex()} tgt=${t.index} pos=${fmt(t.posSec)} $action"
            Log.i("GroupSchedule", line)
            report(line)
        }
    }

    private fun fmt(f: Float): String = String.format("%.2f", f)
}
