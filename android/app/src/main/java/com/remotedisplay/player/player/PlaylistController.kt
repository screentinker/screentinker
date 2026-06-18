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
    private val onNothingScheduled: (() -> Unit)? = null
) {
    private val items = mutableListOf<PlaylistItem>()
    private var currentIndex = -1
    private val handler = Handler(Looper.getMainLooper())
    private var advanceRunnable: Runnable? = null
    private var isRunning = false
    // #74/#75: per-item scheduling state
    @Volatile private var effectiveTimezone: String? = null
    private var retryRunnable: Runnable? = null

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
        fun sig(it: PlaylistItem) = it.contentId + "|" + (it.widgetId ?: "") + "|" + (if (it.muted) "m" else "") + "|" +
            it.schedules.joinToString(";") { b ->
                b.days.sorted().joinToString(",") + "@" + b.start + "-" + b.end + ":" + (b.startDate ?: "") + "~" + (b.endDate ?: "")
            }
        val oldContentIds = items.map(::sig)
        val newContentIds = newItems.map(::sig)
        val playlistChanged = oldContentIds != newContentIds

        if (!playlistChanged && items.isNotEmpty()) {
            Log.i("PlaylistController", "Playlist unchanged (${items.size} items), not interrupting playback")
            return
        }

        Log.i("PlaylistController", "Playlist changed: ${items.size} -> ${newItems.size} items")

        // Remember what's currently playing
        val currentlyPlayingId = currentItem?.contentId

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
                if (newIndex >= 0) {
                    // Current item still exists - don't interrupt, just update index
                    currentIndex = newIndex
                    Log.i("PlaylistController", "Current item still in playlist at index $newIndex, not interrupting")
                    return
                }
            }
            // Current item was removed or nothing was playing - start from the first
            // schedule-active item; idle if none are active right now.
            val idx = firstActiveIndex()
            if (idx >= 0) { currentIndex = idx; playCurrentItem() } else showNothingScheduled()
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
        // #74/#75: begin on the first schedule-active item; idle if none.
        val idx = firstActiveIndex()
        if (idx < 0) { showNothingScheduled(); return }
        currentIndex = idx
        playCurrentItem()
    }

    fun startIfNeeded() {
        if (items.isEmpty()) {
            Log.i("PlaylistController", "No items, nothing to start")
            onPlaylistEmpty()
            return
        }
        if (isRunning && currentIndex >= 0 && currentIndex < items.size) {
            // Already playing something valid - don't restart
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
    }

    fun next() {
        if (items.isEmpty()) return
        // Request a playlist refresh between plays so new content gets picked up
        onRequestRefresh?.invoke()
        // #74/#75: advance to the next item the schedule allows now; idle if none.
        val idx = nextActiveIndex(currentIndex)
        if (idx < 0) { showNothingScheduled(); return }
        currentIndex = idx
        playCurrentItem()
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

        // For images and widgets, auto-advance after duration. For videos, wait
        // for the completion callback. Wall followers never auto-advance — the
        // leader's wall:sync index drives every switch.
        if (!wallFollower && (item.mimeType.startsWith("image/") || item.isWidget)) {
            scheduleAdvance(item.durationSec * 1000L)
        }
    }

    private fun scheduleAdvance(delayMs: Long) {
        cancelAdvance()
        advanceRunnable = Runnable { next() }
        handler.postDelayed(advanceRunnable!!, delayMs)
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
