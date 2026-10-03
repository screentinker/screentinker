package com.remotedisplay.player.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * Plays that happened while the socket was down (#299).
 *
 * ⚠️ THE BUG THIS EXISTS FOR: playback is offline-native, reporting was not. sendPlayStart and
 * sendPlayEnd both began `if (socket?.connected() != true) return`, so a play that happened with
 * the link down was discarded where it occurred — not queued, not retried. A measured 5h49m server
 * outage lost ~1,040 plays: the screen played them all faultlessly and Reports show a hole.
 *
 * ⚠️ IT STORES COMPLETE PLAYS, NOT start/end EVENTS. The server closes a play by finding "the most
 * recent open row for this device+content", so replaying a start/end pair alongside live playback
 * could close the row the player has open RIGHT NOW instead of the historical one. A finished play
 * carrying both timestamps is inserted in one shot and cannot race anything.
 *
 * ⚠️ AND IT IS BOUNDED. A panel can sit offline for weeks; an unbounded queue would grow until the
 * device ran out of storage, turning a reporting gap into a dead screen. Past the cap the OLDEST
 * play is dropped, because the recent history is the more useful half — and `dropped` counts what
 * went, so the loss can be reported rather than being silent the way the original bug was.
 *
 * Pure and storage-free: the caller supplies the persisted text and writes back what `serialize()`
 * returns. That keeps the whole thing testable on the JVM with no device and no filesystem.
 */
class OfflinePlayQueue(private val maxEntries: Int = MAX_ENTRIES) {

    companion object {
        /** ~11 hours of 20-second items; well past a typical outage, small on disk. */
        const val MAX_ENTRIES = 2000
        /** One flush sends at most this many; the server caps its side independently. */
        const val BATCH = 200
    }

    data class Play(
        val clientEventId: String,
        val contentId: String?,
        val widgetId: String?,
        val contentName: String,
        val startedAtSec: Long,
        val endedAtSec: Long?,
        val completed: Boolean,
    )

    private val entries = ArrayDeque<Play>()

    /** Plays discarded because the queue was full — reported so the loss is never silent. */
    var dropped: Long = 0L
        private set

    val size: Int get() = entries.size

    fun add(play: Play) {
        entries.addLast(play)
        while (entries.size > maxEntries) {
            entries.removeFirst()
            dropped++
        }
    }

    /** The next flush, oldest first. Left in the queue until the server acks them. */
    fun peekBatch(limit: Int = BATCH): List<Play> = entries.take(limit)

    /**
     * Drop what the server confirmed it received.
     *
     * ⚠️ BY ID, NOT BY COUNT. "Remove the first N" assumes the queue is unchanged since the batch
     * was taken, but live plays keep arriving during a flush — and a dropped-oldest eviction can
     * shift it underneath. Removing the exact ids the server named is the only version that stays
     * correct while the queue is moving.
     */
    fun ack(ids: Collection<String>) {
        if (ids.isEmpty()) return
        val set = ids.toHashSet()
        entries.removeAll { it.clientEventId in set }
    }

    fun clear() {
        entries.clear()
    }

    fun serialize(): String {
        val arr = JSONArray()
        for (p in entries) {
            arr.put(JSONObject().apply {
                put("client_event_id", p.clientEventId)
                put("content_id", p.contentId ?: JSONObject.NULL)
                put("widget_id", p.widgetId ?: JSONObject.NULL)
                put("content_name", p.contentName)
                put("started_at", p.startedAtSec)
                put("ended_at", p.endedAtSec ?: JSONObject.NULL)
                put("completed", p.completed)
            })
        }
        return arr.toString()
    }

    /**
     * Restore from persisted text.
     *
     * ⚠️ TOTAL, NEVER THROWS. This runs on the boot path. A truncated or corrupt file — a panel
     * losing power mid-write is the normal case here, not the exotic one — must cost the backlog,
     * never the boot. Anything unreadable is skipped and the player carries on.
     */
    fun restore(text: String?) {
        entries.clear()
        if (text.isNullOrBlank()) return
        try {
            val arr = JSONArray(text)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val started = o.optLong("started_at", -1L)
                val id = o.optString("client_event_id", "")
                if (started <= 0L || id.isEmpty()) continue
                add(
                    Play(
                        clientEventId = id,
                        contentId = o.optString("content_id", "").ifEmpty { null },
                        widgetId = o.optString("widget_id", "").ifEmpty { null },
                        contentName = o.optString("content_name", "Unknown"),
                        startedAtSec = started,
                        endedAtSec = o.optLong("ended_at", 0L).takeIf { it > 0L },
                        completed = o.optBoolean("completed", false),
                    )
                )
            }
        } catch (e: Throwable) {
            entries.clear()
        }
    }

    /** The payload for one `device:play-event` / `play_offline` flush. */
    fun batchJson(batch: List<Play>): JSONArray {
        val arr = JSONArray()
        for (p in batch) {
            arr.put(JSONObject().apply {
                put("client_event_id", p.clientEventId)
                put("content_id", p.contentId ?: JSONObject.NULL)
                put("widget_id", p.widgetId ?: JSONObject.NULL)
                put("content_name", p.contentName)
                put("started_at", p.startedAtSec)
                put("ended_at", p.endedAtSec ?: JSONObject.NULL)
                put("completed", p.completed)
            })
        }
        return arr
    }
}
