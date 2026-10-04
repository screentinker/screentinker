package com.remotedisplay.player.kiosk

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/*
 * v2 usage counts (#473): one record per visitor session on an interactive page, queued on the panel
 * and sent to the server, which acks the ids it stored. A panel that is offline for a day still
 * reports that day's sessions when it comes back; a record is dropped only on the server's ack (or
 * when the queue is full, oldest first).
 */

/** One visitor session. [durationSec] is ENGAGED time: first touch to last activity, not to the reset. */
data class KioskSessionRecord(
    val id: String,
    val widgetId: String?,
    val startedAtSec: Long,
    val durationSec: Int,
    /** idle | error | interrupted (item changed, playlist stopped, app restarted mid-session) */
    val endReason: String,
    val pages: Int,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("widget_id", widgetId ?: JSONObject.NULL)
        put("started_at", startedAtSec)
        put("duration_sec", durationSec)
        put("end_reason", endReason)
        put("pages", pages)
    }

    companion object {
        fun fromJson(o: JSONObject): KioskSessionRecord? {
            val id = o.optString("id", "")
            if (id.isEmpty()) return null
            return KioskSessionRecord(
                id = id,
                widgetId = if (o.isNull("widget_id")) null else o.optString("widget_id", "").ifEmpty { null },
                startedAtSec = o.optLong("started_at", 0L),
                durationSec = o.optInt("duration_sec", 0),
                endReason = o.optString("end_reason", "interrupted"),
                pages = o.optInt("pages", 1),
            )
        }
    }
}

/** Pure queue (JVM-tested): bounded, ordered, removed by id on ack. */
class KioskSessionQueue(private val cap: Int = MAX) {
    private val items = ArrayList<KioskSessionRecord>()
    val size: Int get() = items.size

    fun add(r: KioskSessionRecord) {
        if (items.any { it.id == r.id }) return
        items.add(r)
        while (items.size > cap) items.removeAt(0)
    }

    fun peek(n: Int = BATCH): List<KioskSessionRecord> = items.take(n)

    fun ack(ids: Collection<String>) { if (ids.isNotEmpty()) items.removeAll { it.id in ids } }

    fun toJson(): String = JSONArray().apply { items.forEach { put(it.toJson()) } }.toString()

    companion object {
        const val MAX = 500
        const val BATCH = 50

        fun fromJson(raw: String?, cap: Int = MAX): KioskSessionQueue {
            val q = KioskSessionQueue(cap)
            if (raw.isNullOrBlank()) return q
            try {
                val a = JSONArray(raw)
                for (i in 0 until a.length()) a.optJSONObject(i)?.let { KioskSessionRecord.fromJson(it) }?.let { q.add(it) }
            } catch (_: Exception) { /* unreadable: start empty rather than wedge */ }
            return q
        }
    }
}

/** The queue, persisted. Shared by KioskSession (writer) and WebSocketService (sender). */
object KioskSessionLog {
    private const val PREFS = "screentinker"
    private const val KEY = "kiosk_session_queue"
    private val lock = Any()

    private fun load(ctx: Context): KioskSessionQueue =
        KioskSessionQueue.fromJson(try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) } catch (_: Throwable) { null })

    private fun save(ctx: Context, q: KioskSessionQueue) {
        try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, q.toJson()).apply() } catch (_: Throwable) {}
    }

    fun add(ctx: Context, r: KioskSessionRecord) = synchronized(lock) { val q = load(ctx); q.add(r); save(ctx, q) }

    fun peek(ctx: Context): List<KioskSessionRecord> = synchronized(lock) { load(ctx).peek() }

    fun ack(ctx: Context, ids: Collection<String>) = synchronized(lock) { val q = load(ctx); q.ack(ids); save(ctx, q) }
}
