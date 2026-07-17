package com.remotedisplay.player.player

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

data class PlaylistItem(
    val assignmentId: Int,
    val contentId: String,
    val filename: String,
    val mimeType: String,
    val filepath: String,
    val durationSec: Int,
    val fileSize: Long,
    val sortOrder: Int,
    val enabled: Boolean = true,
    val remoteUrl: String? = null,
    val muted: Boolean = false,
    val widgetId: String? = null,
    val widgetType: String? = null,
    val schedules: List<ScheduleEval.Block> = emptyList()
) {
    val isRemote: Boolean get() = !remoteUrl.isNullOrEmpty()
    // Widget assignments have a widget_id and no downloadable content file.
    val isWidget: Boolean get() = !widgetId.isNullOrEmpty()
}

class PlaylistController(
    private val onItemChanged: (PlaylistItem?) -> Unit,
    private val onPlaylistEmpty: () -> Unit,
    private val onRequestRefresh: (() -> Unit)? = null,
    private val onNothingScheduled: (() -> Unit)? = null,
    // Screen-resilience: the defined "content isn't downloaded yet" waiting state, shown ONLY when
    // nothing has ever played (fresh device). Never used while content is on screen.
    private val onWaitingForContent: (() -> Unit)? = null
) {
    private companion object {
        const val CONTENT_RECHECK_MS = 3000L
        // Backstop against a busy-loop: an auto-advance is never scheduled faster than
        // this, so a bad/zero duration on any path can't peg the main thread (see #widget
        // zero-duration self-loop — a solo fullscreen widget with duration_sec=0).
        const val MIN_ADVANCE_MS = 500L
    }

    private val items = mutableListOf<PlaylistItem>()
    private var currentIndex = -1
    private val handler = Handler(Looper.getMainLooper())
    private var advanceRunnable: Runnable? = null
    private var isRunning = false
    // #74/#75: per-item scheduling state
    @Volatile private var effectiveTimezone: String? = null
    private var retryRunnable: Runnable? = null

    // #157: when a playlist update REMOVES the item currently on screen (e.g. it just expired),
    // we don't yank it off / restart — the current item plays out and we rotate into this stashed
    // list on the next advance. pendingSuccessorId is the item that followed the removed one (old
    // order) and still exists, so rotation continues where it left off instead of jumping to the top.
    // Solo playback only (never wallFollower/group-sync, whose advance isn't driven by next()).
    private var pendingItems: List<PlaylistItem>? = null
    private var pendingSuccessorId: String? = null

    // Screen-resilience: an item is playable only when its content is actually AVAILABLE
    // (widget / remote-stream / fully-downloaded local file). Injected by MainActivity (which owns
    // the cache); the default keeps every item playable so behavior is unchanged until it's set.
    private var contentReady: (PlaylistItem) -> Boolean = { true }
    fun setContentReadyCheck(f: (PlaylistItem) -> Boolean) { contentReady = f }
    // True while a valid item is rendered on screen — so we NEVER blank it for a pending download.
    private var hasContentOnScreen = false

    // Video wall: followers don't self-advance — the leader's wall:sync drives the index.
    private var wallFollower = false
    // Wall-clock at which the current item started playing, for non-video sync position.
    private var itemStartedAt = 0L

    val isPlaying: Boolean get() = isRunning && currentIndex >= 0

    /** Video wall: true on followers (suppress auto-advance; leader drives the index). */
    fun setWallFollower(b: Boolean) { wallFollower = b }

    /** Current playlist index (-1 if nothing is playing). */
    fun getIndex(): Int = currentIndex

    /** Wall-clock ms when the current item started; used for non-video sync position. */
    fun itemStartedAtMs(): Long = itemStartedAt

    /** Jump to an absolute index (wraps); used by wall followers tracking the leader. */
    fun gotoIndex(idx: Int) {
        if (items.isEmpty()) return
        val n = items.size
        val target = ((idx % n) + n) % n
        if (target == currentIndex) return
        currentIndex = target
        playCurrentItem()
    }

    /** #74/#75: device-effective IANA timezone for per-item schedule evaluation. */
    fun setTimezone(tz: String?) { effectiveTimezone = tz }

    val currentItem: PlaylistItem?
        get() = if (currentIndex in items.indices) items[currentIndex] else null

    // #group-sync double buffer: resolve an item by index (for preloading the next clip).
    fun itemAt(index: Int): PlaylistItem? = if (index in items.indices) items[index] else null

    val currentContentId: String?
        get() = currentItem?.contentId

    fun updatePlaylist(assignmentsJson: JSONArray) {
        Log.i("PlaylistController", "Received JSONArray with ${assignmentsJson.length()} items")

        // Build new list
        val newItems = mutableListOf<PlaylistItem>()
        for (i in 0 until assignmentsJson.length()) {
            val obj = assignmentsJson.getJSONObject(i)
            newItems.add(
                PlaylistItem(
                    assignmentId = obj.optInt("id", 0),
                    // Tolerant: widget assignments have no content_id (getString threw).
                    contentId = if (obj.isNull("content_id")) "" else obj.optString("content_id", ""),
                    filename = obj.optString("filename", "unknown"),
                    mimeType = obj.optString("mime_type", "video/mp4"),
                    filepath = obj.optString("filepath", ""),
                    durationSec = obj.optInt("duration_sec", 10),
                    fileSize = obj.optLong("file_size", 0),
                    sortOrder = obj.optInt("sort_order", 0),
                    enabled = obj.optInt("enabled", 1) == 1,
                    remoteUrl = if (obj.isNull("remote_url")) null else obj.optString("remote_url", "").ifEmpty { null },
                    muted = obj.optInt("muted", 0) == 1,
                    widgetId = if (obj.isNull("widget_id")) null else obj.optString("widget_id", "").ifEmpty { null },
                    widgetType = if (obj.isNull("widget_type")) null else obj.optString("widget_type", "").ifEmpty { null },
                    schedules = parseSchedules(obj.optJSONArray("schedules"))
                )
            )
        }

        // Check if playlist actually changed (key on content OR widget id, since
        // widget items share an empty contentId).
        // #74/#75: a schedule edit changes playback even when content is identical, so
        // the change signature must include schedules (else updated blocks are dropped).
        // #129: include muted too, so a mute-only change (same content) re-renders with the
        // new flag instead of being de-duped (the real-time event handles the live toggle;
        // this makes a published mute persist across reloads).
        // Signature is STRUCTURAL only — content/widget identity, order, mute, schedules. durationSec is
        // deliberately EXCLUDED so a duration-only edit does NOT force a restart; instead it's applied
        // IN PLACE below (the #group-sync schedule tick + the solo advance timer read durationSec live),
        // so timing edits take effect without interrupting playback or resetting the index.
        fun sig(it: PlaylistItem) = it.contentId + "|" + (it.widgetId ?: "") + "|" + (if (it.muted) "m" else "") + "|" +
            it.schedules.joinToString(";") { b ->
                b.days.sorted().joinToString(",") + "@" + b.start + "-" + b.end + ":" + (b.startDate ?: "") + "~" + (b.endDate ?: "")
            }
        val oldContentIds = items.map(::sig)
        val newContentIds = newItems.map(::sig)
        val playlistChanged = oldContentIds != newContentIds

        if (!playlistChanged && items.isNotEmpty()) {
            // In-place duration refresh: patch durationSec on the existing items so a duration edit
            // takes effect immediately without a restart. For a sync group this re-anchors the shared
            // schedule (all members recompute the new period together); for solo it's picked up on the
            // next advance. No index reset, no video reload.
            var durChanged = false
            for (i in items.indices) {
                val ni = newItems.getOrNull(i) ?: continue
                if (items[i].durationSec != ni.durationSec) { items[i] = items[i].copy(durationSec = ni.durationSec); durChanged = true }
            }
            Log.i("PlaylistController", if (durChanged) "Durations updated in place (${items.size} items), not interrupting" else "Playlist unchanged (${items.size} items), not interrupting playback")
            return
        }

        Log.i("PlaylistController", "Playlist changed: ${items.size} -> ${newItems.size} items")

        // Remember what's currently playing
        val currentlyPlayingId = currentItem?.contentId

        // #157: the item on screen was REMOVED (its only change is removal — e.g. it just expired).
        // In solo playback, don't interrupt it: keep it up, stash the new list, and rotate out on the
        // next natural advance (video end / image duration). Excludes wallFollower + group-sync, whose
        // advance is driven by their tick, not next() — deferring there would strand the swap.
        if (isRunning && !wallFollower && hasContentOnScreen && currentlyPlayingId != null &&
            newItems.none { it.contentId == currentlyPlayingId }) {
            var succ: String? = null
            if (items.isNotEmpty()) {
                for (k in 1..items.size) {
                    val cid = items[(currentIndex + k) % items.size].contentId
                    if (cid != currentlyPlayingId && newItems.any { it.contentId == cid }) { succ = cid; break }
                }
            }
            pendingItems = newItems
            pendingSuccessorId = succ
            Log.i("PlaylistController", "Current item removed but still live — deferring rotation-out (successor=$succ)")
            return
        }
        // A non-deferred structural update supersedes any pending swap.
        pendingItems = null
        pendingSuccessorId = null

        items.clear()
        items.addAll(newItems)

        if (items.isEmpty()) {
            currentIndex = -1
            cancelAdvance()
            onPlaylistEmpty()
        } else if (isRunning) {
            // Try to keep playing the current item if it's still in the list
            if (currentlyPlayingId != null) {
                val newIndex = items.indexOfFirst { it.contentId == currentlyPlayingId }
                if (newIndex >= 0 && hasContentOnScreen) {
                    // Current item still exists AND is genuinely on screen - don't interrupt, just update index.
                    currentIndex = newIndex
                    Log.i("PlaylistController", "Current item still in playlist at index $newIndex, not interrupting")
                    return
                }
                // #162: if the item is still present but nothing is actually rendered (hasContentOnScreen
                // = false, e.g. content wasn't downloaded when we first tried), do NOT trust the stale
                // "playing" state — fall through to (re)pick a playable item and start below.
            }
            // Current item was removed or nothing was playing - start from the first
            // schedule-active AND downloaded item. Distinguish the two idle reasons: daypart
            // closed (nothing scheduled) => defined idle; scheduled-but-not-yet-downloaded =>
            // keep current content / waiting, never blank.
            val fp = PlaylistSelection.firstPlayableIndex(items.size) { playableNow(it) }
            if (fp >= 0) { currentIndex = fp; playCurrentItem() }
            else if (firstActiveIndex() < 0) showNothingScheduled()
            else onContentNotReady()
        } else {
            currentIndex = 0
        }
    }

    fun removeContent(contentId: String) {
        val wasCurrentId = currentItem?.contentId
        items.removeAll { it.contentId == contentId }

        if (items.isEmpty()) {
            currentIndex = -1
            cancelAdvance()
            onPlaylistEmpty()
        } else if (wasCurrentId == contentId) {
            if (currentIndex >= items.size) currentIndex = 0
            playCurrentItem()
        }
    }

    fun start() {
        isRunning = true
        if (items.isEmpty()) { onPlaylistEmpty(); return }
        // #74/#75: begin on the first schedule-active item; daypart-closed => defined idle.
        if (firstActiveIndex() < 0) { showNothingScheduled(); return }
        // Screen-resilience: only start on an item whose content is downloaded; if the scheduled
        // content isn't ready yet, keep current/wait (never blank on a loading state).
        val idx = PlaylistSelection.firstPlayableIndex(items.size) { playableNow(it) }
        if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
    }

    fun startIfNeeded() {
        if (items.isEmpty()) {
            Log.i("PlaylistController", "No items, nothing to start")
            onPlaylistEmpty()
            return
        }
        // #162: isRunning + a valid index are NOT proof the player is actually rendering. After a
        // restore, or an onContentNotReady (content still downloading when start() first ran),
        // isRunning stays true with a seeded currentIndex but NOTHING on screen — and the old guard
        // then blocked every retry, stranding the panel on "waiting for content" even after the
        // content finished downloading. Only short-circuit when an item is genuinely on screen;
        // otherwise fall through and (re)start so playback reliably begins/recovers.
        if (isRunning && currentIndex >= 0 && currentIndex < items.size && hasContentOnScreen) {
            Log.i("PlaylistController", "Already playing ${items[currentIndex].filename}, not restarting")
            return
        }
        Log.i("PlaylistController", "Starting playback")
        start()
    }

    fun stop() {
        isRunning = false
        cancelAdvance()
        cancelRetry()
        hasContentOnScreen = false
        pendingItems = null
        pendingSuccessorId = null
    }

    fun next() {
        // #157: a deferred rotation-out — the just-finished item was removed (expired) while live.
        // Swap in the stashed list now and continue at the preserved successor (or first playable).
        pendingItems?.let { p ->
            pendingItems = null
            val succ = pendingSuccessorId; pendingSuccessorId = null
            items.clear(); items.addAll(p)
            if (items.isEmpty()) { currentIndex = -1; cancelAdvance(); onPlaylistEmpty(); return }
            onRequestRefresh?.invoke()
            if (firstActiveIndex() < 0) { showNothingScheduled(); return }
            var idx = if (succ != null) items.indexOfFirst { it.contentId == succ } else -1
            if (idx < 0 || !playableNow(idx)) idx = PlaylistSelection.firstPlayableIndex(items.size) { playableNow(it) }
            if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
            return
        }
        if (items.isEmpty()) return
        // Request a playlist refresh between plays so new content gets picked up
        onRequestRefresh?.invoke()
        // #74/#75: daypart closed (nothing scheduled now) => defined idle.
        if (firstActiveIndex() < 0) { showNothingScheduled(); return }
        // Screen-resilience: advance to the next schedule-active AND downloaded item. Unready items
        // are SKIPPED (their background download continues), so a stalled/failed download of the
        // next content never blanks the screen — we keep looping the content we already have. If
        // NOTHING is downloaded yet, keep current content / show the waiting state, never blank.
        val idx = PlaylistSelection.nextPlayableIndex(items.size, currentIndex) { playableNow(it) }
        if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
    }

    fun onVideoComplete() {
        // Called when a video finishes naturally. Wall followers don't self-advance —
        // they hold (and loop) the leader's item until a wall:sync changes the index.
        if (wallFollower) return
        next()
    }

    private fun playCurrentItem() {
        cancelAdvance()
        cancelRetry()
        val item = currentItem ?: return
        itemStartedAt = System.currentTimeMillis()
        Log.i("PlaylistController", "Playing: ${item.filename} (index $currentIndex)")
        onItemChanged(item)
        hasContentOnScreen = true // a valid item is now rendered — protect it from being blanked

        // For images and widgets, auto-advance after duration. For videos, wait
        // for the completion callback. Wall followers never auto-advance — the
        // leader's wall:sync index drives every switch.
        if (!wallFollower && (item.mimeType.startsWith("image/") || item.isWidget)) {
            // slotMs() floors a zero/negative duration to 10s (the max(1, duration||10)
            // contract shared with the web/Tizen players). A raw durationSec*1000 here let a
            // solo fullscreen widget with duration_sec=0 schedule a 0ms advance -> self-loop.
            scheduleAdvance(slotMs(item))
        }
    }

    private fun scheduleAdvance(delayMs: Long) {
        cancelAdvance()
        // Backstop: never busy-loop, even if a future caller passes a tiny/zero delay.
        val safeDelayMs = maxOf(delayMs, MIN_ADVANCE_MS)
        advanceRunnable = Runnable { next() }
        handler.postDelayed(advanceRunnable!!, safeDelayMs)
    }

    private fun cancelAdvance() {
        advanceRunnable?.let { handler.removeCallbacks(it) }
        advanceRunnable = null
    }

    private fun cancelRetry() {
        retryRunnable?.let { handler.removeCallbacks(it) }
        retryRunnable = null
    }

    // #74/#75 schedule helpers ---------------------------------------------------
    private fun scheduleAllows(item: PlaylistItem): Boolean =
        item.schedules.isEmpty() ||
            ScheduleEval.isItemActiveNow(item.schedules, System.currentTimeMillis(), effectiveTimezone)

    // #group-sync schedule engine. Lay the deterministic playlist (each active item occupies a
    // CANONICAL slot, dayparted items skipped) on the server-disciplined clock and derive the target
    // (index, position). The slot formula MUST be byte-identical to the web and Tizen players
    // (max(1, duration_sec||10)*1000) or a mixed-platform group would diverge — so it deliberately
    // does NOT use this player's solo-playback duration clamp.
    // nextIndex + secToBoundary let the double buffer preload the upcoming clip a few seconds early.
    // For a single active slot, nextIndex == index (the caller skips preloading a self-loop).
    data class GroupTarget(val index: Int, val posSec: Float, val nextIndex: Int, val secToBoundary: Float)
    private fun slotMs(it: PlaylistItem): Long = (if (it.durationSec > 0) it.durationSec else 10).toLong() * 1000L
    fun groupScheduleTarget(syncedNowMs: Long): GroupTarget? {
        if (items.isEmpty()) return null
        var acc = 0L
        val slots = ArrayList<Triple<Int, Long, Long>>()   // index, startMs, durMs
        for (i in items.indices) {
            if (!scheduleAllows(items[i])) continue
            val d = slotMs(items[i]); slots.add(Triple(i, acc, d)); acc += d
        }
        if (slots.isEmpty() || acc <= 0L) return null
        val period = acc
        val phase = ((syncedNowMs % period) + period) % period
        var chosenIdx = slots.size - 1
        for (k in slots.indices) { val s = slots[k]; if (phase >= s.second && phase < s.second + s.third) { chosenIdx = k; break } }
        val chosen = slots[chosenIdx]
        val next = slots[(chosenIdx + 1) % slots.size]
        val secToBoundary = (chosen.second + chosen.third - phase) / 1000f
        return GroupTarget(chosen.first, (phase - chosen.second) / 1000f, next.first, secToBoundary)
    }

    // Playable NOW = schedule-active AND its content is downloaded/available.
    private fun playableNow(i: Int): Boolean =
        i in items.indices && scheduleAllows(items[i]) && contentReady(items[i])

    // Screen-resilience: the scheduled item(s) exist but their content isn't downloaded yet.
    // NEVER blank a screen that is already showing content — keep it and re-check soon (the
    // background download finishes, or the watchdog restores connectivity). Only show the defined
    // waiting/setup state on a fresh device that has never played anything.
    private fun onContentNotReady() {
        cancelAdvance()
        when (PlaylistSelection.whenNonePlayable(hasContentOnScreen)) {
            PlaylistSelection.NonePlayable.KEEP_CURRENT -> { /* leave current content on screen */ }
            PlaylistSelection.NonePlayable.SHOW_WAITING -> {
                hasContentOnScreen = false
                (onWaitingForContent ?: onNothingScheduled ?: onPlaylistEmpty)()
            }
        }
        scheduleContentRecheck()
    }

    // Re-evaluate playability shortly (a pending download may have finished / a daypart opened).
    // Faster than the schedule re-check because a finished download should play promptly.
    private fun scheduleContentRecheck() {
        cancelRetry()
        retryRunnable = Runnable {
            if (isRunning && items.isNotEmpty()) {
                if (firstActiveIndex() < 0) { showNothingScheduled(); return@Runnable }
                val idx = PlaylistSelection.nextPlayableIndex(items.size, currentIndex) { playableNow(it) }
                if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
            }
        }
        handler.postDelayed(retryRunnable!!, CONTENT_RECHECK_MS)
    }

    private fun firstActiveIndex(): Int {
        for (i in items.indices) if (scheduleAllows(items[i])) return i
        return -1
    }

    private fun nextActiveIndex(from: Int): Int {
        if (items.isEmpty()) return -1
        for (i in 1..items.size) {
            val idx = (from + i) % items.size
            if (scheduleAllows(items[idx])) return idx
        }
        return -1
    }

    // Every item filtered out: show the idle screen and re-check shortly, since a
    // daypart may open. (Boundary re-evaluation otherwise happens on advance.)
    private fun showNothingScheduled() {
        cancelAdvance()
        hasContentOnScreen = false // the daypart genuinely closed — a defined idle, not a blank-bug
        (onNothingScheduled ?: onPlaylistEmpty)()
        cancelRetry()
        retryRunnable = Runnable {
            if (isRunning && items.isNotEmpty()) {
                val idx = firstActiveIndex()
                if (idx >= 0) { currentIndex = idx; playCurrentItem() } else showNothingScheduled()
            }
        }
        handler.postDelayed(retryRunnable!!, 30_000L)
    }

    private fun parseSchedules(arr: JSONArray?): List<ScheduleEval.Block> {
        if (arr == null) return emptyList()
        val out = ArrayList<ScheduleEval.Block>(arr.length())
        for (j in 0 until arr.length()) {
            val s = arr.getJSONObject(j)
            val d = s.getJSONArray("days")
            val days = HashSet<Int>(d.length())
            for (k in 0 until d.length()) days.add(d.getInt(k))
            out.add(
                ScheduleEval.Block(
                    days = days,
                    start = s.getString("start"),
                    end = s.getString("end"),
                    startDate = if (s.isNull("start_date")) null else s.optString("start_date").ifEmpty { null },
                    endDate = if (s.isNull("end_date")) null else s.optString("end_date").ifEmpty { null }
                )
            )
        }
        return out
    }
}
