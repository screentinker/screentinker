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
    val muted: Boolean = false
) {
    val isRemote: Boolean get() = !remoteUrl.isNullOrEmpty()
}

class PlaylistController(
    private val onItemChanged: (PlaylistItem?) -> Unit,
    private val onPlaylistEmpty: () -> Unit,
    private val onRequestRefresh: (() -> Unit)? = null
) {
    private val items = mutableListOf<PlaylistItem>()
    private var currentIndex = -1
    private val handler = Handler(Looper.getMainLooper())
    private var advanceRunnable: Runnable? = null
    private var isRunning = false

    val isPlaying: Boolean get() = isRunning && currentIndex >= 0

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
                    contentId = obj.getString("content_id"),
                    filename = obj.optString("filename", "unknown"),
                    mimeType = obj.optString("mime_type", "video/mp4"),
                    filepath = obj.optString("filepath", ""),
                    durationSec = obj.optInt("duration_sec", 10),
                    fileSize = obj.optLong("file_size", 0),
                    sortOrder = obj.optInt("sort_order", 0),
                    enabled = obj.optInt("enabled", 1) == 1,
                    remoteUrl = if (obj.isNull("remote_url")) null else obj.optString("remote_url", "").ifEmpty { null },
                    muted = obj.optInt("muted", 0) == 1
                )
            )
        }

        // Check if playlist actually changed
        val oldContentIds = items.map { it.contentId }
        val newContentIds = newItems.map { it.contentId }
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
            // Current item was removed or nothing was playing - start from beginning
            currentIndex = 0
            playCurrentItem()
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
        if (items.isNotEmpty()) {
            if (currentIndex < 0) currentIndex = 0
            playCurrentItem()
        } else {
            onPlaylistEmpty()
        }
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
    }

    fun next() {
        if (items.isEmpty()) return
        currentIndex = (currentIndex + 1) % items.size
        // Request a playlist refresh between plays so new content gets picked up
        onRequestRefresh?.invoke()
        playCurrentItem()
    }

    fun onVideoComplete() {
        // Called when a video finishes naturally
        next()
    }

    private fun playCurrentItem() {
        cancelAdvance()
        val item = currentItem ?: return
        Log.i("PlaylistController", "Playing: ${item.filename} (index $currentIndex)")
        onItemChanged(item)

        // For images, auto-advance after duration. For videos, wait for completion callback.
        if (item.mimeType.startsWith("image/")) {
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
}
