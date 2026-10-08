package com.remotedisplay.player.audience

import org.json.JSONArray
import org.json.JSONObject

/*
 * Audience counting (server/lib/audience.js, docs/audience-counting.md): the pure half.
 *
 * ⚠️ THIS FILE NEVER SEES AN IMAGE. The camera half (AudienceCamera) turns each frame into a list of
 * face BOXES and drops the frame; this file turns boxes into per-minute COUNTS. A track is a local
 * integer that lives only while a face stays in view — it is not a person, is never stored, and is
 * gone the moment the face leaves. Nothing here could recognise anyone: there is no appearance, no
 * embedding, no identifier, only where a box was in the last frame.
 *
 * Counting rules (the server validates the same shape):
 *   - present: confirmed faces in a frame; per minute the max and the average (x100)
 *   - a face is CONFIRMED once seen in [confirmFrames] frames, so a one-frame false detection
 *     counts as nobody
 *   - when a confirmed face leaves (unseen for [lostAfterMs]) it is counted once, in the minute it
 *     left: one arrival; an impression if it was in view for at least minDwellMs; and its dwell in
 *     the histogram. Counted at the END because only then is the dwell known — and that keeps
 *     impressions <= arrivals in every bucket by construction.
 *   - it is attributed to the item that was on screen when it was confirmed: what they came to look at.
 *     So a bucket can hold departures for an item no longer on screen — it then has no frames and
 *     observed_ms 0, and adds arrivals without adding watched time.
 *   - observed_ms: the time within the minute this item was on screen while the camera counted, from
 *     the frame timestamps (each frame credits the gap since the previous one, capped, so a stalled
 *     camera is not time watched). The server weights the average presence by it.
 *   - segment: a new number every time counting (re)starts. A restart inside a minute sends a second
 *     partial bucket for that minute; the segment keeps it from colliding with the first.
 */

/** A face box in normalised [0,1] frame coordinates. */
data class FaceBox(val cx: Float, val cy: Float, val size: Float)

/** What was on screen. kind is content | widget | none. */
data class ScreenItem(val kind: String, val id: String?) {
    companion object { val NONE = ScreenItem("none", null) }
}

/** One minute of counts for one item. Integers only; this is the whole wire format. */
data class AudienceBucket(
    val start: Long,                // epoch seconds, a multiple of 60
    val seconds: Int,
    val item: ScreenItem,
    val segment: Int = 0,           // 0-9999: which counting run (see the file comment)
    var observedMs: Long = 0,       // ms of this minute the item was on screen while counting
    var presentMax: Int = 0,
    var presentSum: Long = 0,       // sum of per-frame counts (for the average)
    var frames: Int = 0,
    var arrivals: Int = 0,
    var impressions: Int = 0,
    val dwell: IntArray = IntArray(6),
    // The id it was queued under, kept across a restart so a resend is the SAME id (an entry queued
    // by a build before segments has the old id shape, and the server must see it unchanged).
    private val queuedId: String? = null,
) {
    /** The ack key. Unique per screen: one bucket per minute per counting run per item. */
    val id: String get() = queuedId ?: makeId(start, segment, item)

    fun presentAvgX100(): Int =
        if (frames == 0) 0 else ((presentSum * 100 + frames / 2) / frames).toInt().coerceIn(0, presentMax * 100)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("start", start)
        put("seconds", seconds)
        put("item_kind", item.kind)
        if (item.kind != "none" && item.id != null) put("item_id", item.id)
        put("present_max", presentMax.coerceIn(0, 100))
        put("present_avg_x100", presentAvgX100())
        put("arrivals", arrivals.coerceIn(0, 5000))
        put("impressions", impressions.coerceIn(0, arrivals.coerceIn(0, 5000)))
        put("dwell", JSONArray().apply { dwell.forEach { put(it.coerceIn(0, 5000)) } })
        put("segment", segment.coerceIn(0, 9999))
        put("observed_ms", observedMs.coerceIn(0L, seconds * 1000L))
    }

    companion object {
        private val ID_RE = Regex("^[A-Za-z0-9:_-]{1,80}$")

        /** m<start>-s<segment>-<kind>-<item id>, at most 80 characters: the item id is what gives. */
        fun makeId(start: Long, segment: Int, item: ScreenItem): String {
            val head = "m$start-s$segment-${item.kind}-"
            return head + (item.id ?: "x").take((80 - head.length).coerceAtLeast(1))
        }

        fun fromJson(o: JSONObject): AudienceBucket? = try {
            val kind = o.getString("item_kind")
            val d = o.getJSONArray("dwell")
            val seconds = o.getInt("seconds")
            AudienceBucket(
                start = o.getLong("start"), seconds = seconds,
                item = ScreenItem(kind, if (o.has("item_id")) o.getString("item_id") else null),
                segment = o.optInt("segment", 0).coerceIn(0, 9999),
                // Queued before observed_ms existed: the server reads absent as the whole bucket.
                observedMs = o.optLong("observed_ms", seconds * 1000L),
                presentMax = o.getInt("present_max"),
                // The average is carried as avg x100 over one pseudo-frame, which round-trips exactly.
                presentSum = o.getInt("present_avg_x100").toLong(), frames = 100,
                arrivals = o.getInt("arrivals"), impressions = o.getInt("impressions"),
                dwell = IntArray(6) { d.optInt(it, 0) },
                queuedId = o.optString("id", "").takeIf { ID_RE.matches(it) },
            )
        } catch (_: Exception) { null }
    }
}

class AudienceAggregator(
    private val minDwellMs: Long = 1000,
    private val bucketSec: Int = 60,
    private val confirmFrames: Int = 2,
    private val lostAfterMs: Long = 1500,
    private val matchIou: Float = 0.25f,
    private val maxTracks: Int = 100,
    private val maxFrameGapMs: Long = 2000,     // a longer gap between frames is not time watched
) {
    private class Track(var box: FaceBox, val firstSeenMs: Long, var lastSeenMs: Long, var hits: Int, var item: ScreenItem)

    private val tracks = ArrayList<Track>()
    private val open = LinkedHashMap<String, AudienceBucket>()
    var item: ScreenItem = ScreenItem.NONE
    private var lastFrameMs: Long? = null

    /** The counting run new buckets belong to. Set a NEW one every time the camera (re)starts. */
    var segment: Int = 0
        set(v) { field = v.coerceIn(0, 9999); lastFrameMs = null }

    // No Math.floorMod(Long, Long): that is API 24 and minSdk is 23. Times here are never negative.
    private fun minuteOf(ms: Long): Long { val s = ms / 1000; return s - (s % bucketSec) }

    private fun key(minute: Long, it: ScreenItem) = "$minute|$segment|${it.kind}|${it.id}"

    private fun bucket(minute: Long, it: ScreenItem): AudienceBucket =
        open.getOrPut(key(minute, it)) { AudienceBucket(minute, bucketSec, it, segment) }

    /**
     * One frame's detections at [nowMs]. Returns the buckets that are now complete (their minute has
     * passed), for the caller to queue.
     */
    fun onFrame(faces: List<FaceBox>, nowMs: Long): List<AudienceBucket> {
        // Greedy best-IoU matching: few faces per frame, so O(n*m) is nothing.
        val unmatched = faces.toMutableList()
        for (t in tracks.sortedByDescending { it.hits }) {
            var best: FaceBox? = null
            var bestIou = matchIou
            for (f in unmatched) { val v = iou(t.box, f); if (v >= bestIou) { bestIou = v; best = f } }
            if (best != null) {
                unmatched.remove(best)
                t.box = best; t.lastSeenMs = nowMs; t.hits++
                // Attributed to what was on screen when the face was confirmed.
                if (t.hits == confirmFrames) t.item = item
            }
        }
        for (f in unmatched) {
            if (tracks.size >= maxTracks) break
            tracks.add(Track(f, nowMs, nowMs, 1, item))
        }
        if (confirmFrames <= 1) tracks.filter { it.hits == 1 && it.firstSeenMs == nowMs }.forEach { it.item = item }
        endLost(nowMs)

        val present = tracks.count { it.hits >= confirmFrames && it.lastSeenMs == nowMs }
        val minute = minuteOf(nowMs)
        val b = bucket(minute, item)
        creditObserved(b, minute, nowMs)
        b.frames++
        b.presentSum += present
        if (present > b.presentMax) b.presentMax = present
        return closeBefore(minuteOf(nowMs))
    }

    /**
     * The time since the previous frame was watched, with this frame's item on screen. Across a
     * minute boundary the part before it goes to the previous minute's bucket for the same item,
     * if it is still open; otherwise all of it is this frame's (a gap is at most maxFrameGapMs).
     */
    private fun creditObserved(b: AudienceBucket, minute: Long, nowMs: Long) {
        val prev = lastFrameMs
        lastFrameMs = nowMs
        if (prev == null || nowMs <= prev) return              // the first frame of a run credits nothing
        val gap = minOf(nowMs - prev, maxFrameGapMs)
        val minuteStartMs = minute * 1000
        val before = (minuteStartMs - (nowMs - gap)).coerceIn(0L, gap)
        val prevBucket = if (before > 0) open[key(minute - bucketSec, item)] else null
        if (prevBucket != null) { prevBucket.observedMs += before; b.observedMs += gap - before } else b.observedMs += gap
    }

    /** End every track that has not been seen for lostAfterMs. */
    private fun endLost(nowMs: Long) {
        val it = tracks.iterator()
        while (it.hasNext()) {
            val t = it.next()
            if (nowMs - t.lastSeenMs > lostAfterMs) { it.remove(); finish(t, nowMs) }
        }
    }

    private fun finish(t: Track, nowMs: Long) {
        if (t.hits < confirmFrames) return                 // never confirmed: a flicker, not a person
        val dwellMs = (t.lastSeenMs - t.firstSeenMs).coerceAtLeast(0)
        val b = bucket(minuteOf(nowMs), t.item)
        b.arrivals++
        if (dwellMs >= minDwellMs) b.impressions++
        b.dwell[dwellIndex(dwellMs)]++
    }

    private fun closeBefore(minute: Long): List<AudienceBucket> {
        if (open.isEmpty()) return emptyList()
        val done = open.values.filter { it.start < minute }
        if (done.isNotEmpty()) open.entries.removeAll { it.value.start < minute }   // not removeIf: API 24
        return done
    }

    /**
     * Stop counting (camera off, app stopping, config switched off): every face still in view is
     * counted as leaving now, and every bucket — including the current partial minute — is returned.
     */
    fun flushAll(nowMs: Long): List<AudienceBucket> {
        tracks.forEach { finish(it, nowMs) }
        tracks.clear()
        lastFrameMs = null
        val all = open.values.toList()
        open.clear()
        return all
    }

    /** How many faces are being followed right now (diagnostics only; not sent). */
    val activeTracks: Int get() = tracks.size

    companion object {
        /** <2s, 2-5s, 5-15s, 15-30s, 30-60s, 60s+ — server/lib/audience.js DWELL_LABELS. */
        fun dwellIndex(ms: Long): Int = when {
            ms < 2_000 -> 0
            ms < 5_000 -> 1
            ms < 15_000 -> 2
            ms < 30_000 -> 3
            ms < 60_000 -> 4
            else -> 5
        }

        fun iou(a: FaceBox, b: FaceBox): Float {
            val ax0 = a.cx - a.size / 2; val ax1 = a.cx + a.size / 2; val ay0 = a.cy - a.size / 2; val ay1 = a.cy + a.size / 2
            val bx0 = b.cx - b.size / 2; val bx1 = b.cx + b.size / 2; val by0 = b.cy - b.size / 2; val by1 = b.cy + b.size / 2
            val iw = (minOf(ax1, bx1) - maxOf(ax0, bx0)).coerceAtLeast(0f)
            val ih = (minOf(ay1, by1) - maxOf(ay0, by0)).coerceAtLeast(0f)
            val inter = iw * ih
            val union = a.size * a.size + b.size * b.size - inter
            return if (union <= 0f) 0f else inter / union
        }
    }
}

/** Pure queue (JVM-tested): bounded, ordered, removed by id on ack — the same contract as kiosk sessions. */
class AudienceQueue(private val cap: Int = MAX) {
    private val items = ArrayList<AudienceBucket>()
    val size: Int get() = items.size

    fun addAll(bs: Collection<AudienceBucket>) {
        for (b in bs) {
            if (items.any { it.id == b.id }) continue
            items.add(b)
        }
        while (items.size > cap) items.removeAt(0)
    }

    fun peek(n: Int = BATCH): List<AudienceBucket> = items.take(n)
    fun ack(ids: Collection<String>) { if (ids.isNotEmpty()) items.removeAll { it.id in ids } }
    fun toJson(): String = JSONArray().apply { items.forEach { put(it.toJson()) } }.toString()

    companion object {
        const val MAX = 3000          // ~2 days of one-item minutes offline
        const val BATCH = 100

        fun fromJson(raw: String?, cap: Int = MAX): AudienceQueue {
            val q = AudienceQueue(cap)
            if (raw.isNullOrBlank()) return q
            try {
                val a = JSONArray(raw)
                val list = ArrayList<AudienceBucket>()
                for (i in 0 until a.length()) a.optJSONObject(i)?.let { AudienceBucket.fromJson(it) }?.let { list.add(it) }
                q.addAll(list)
            } catch (_: Exception) { /* unreadable: start empty rather than wedge */ }
            return q
        }
    }
}
