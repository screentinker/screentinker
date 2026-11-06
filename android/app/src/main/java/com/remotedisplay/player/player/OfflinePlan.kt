package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject

/**
 * #818 offline schedule plan - the Android consumer.
 *
 * A panel cannot safely infer a future schedule from its last non-empty playlist: a reboot or a
 * disconnect during an unscheduled gap would otherwise restore and replay content whose schedule has
 * ended. The server resolves the schedule into a bounded, already-UTC timeline and attaches it as
 * `offline_plan`; the player picks the state valid for the current instant and rolls over at each
 * boundary while disconnected.
 *
 * CONTRACT: this is the Kotlin twin of samsung-sssp3/app/offline-plan.js (STOfflinePlan), which the
 * server's offline-schedule-plan.test.js and the SSSP3 offline-plan.test.js both pin. Shape:
 *
 *   {
 *     protocol_version: 1,
 *     generated_at_utc_ms, valid_until_utc_ms,        // the plan is only usable inside [gen, valid)
 *     timezone,
 *     intervals: [ { start_utc_ms, end_utc_ms, schedule_id, playlist_id, layout_id } ],  // half-open
 *     states:    [ { schedule_id, playlist_id, layout_id, payload } ]                     // one per distinct state
 *   }
 *
 * An interval with a null `schedule_id` is a GAP: nothing is scheduled, so the device must show its
 * idle / default-content state, never the last real playlist. The server emits a matching state row
 * with `schedule_id: null` (empty assignments + the standby default_content) for exactly that.
 *
 * Time model: `now` and every boundary are UTC epoch ms. The server has ALREADY resolved local
 * wall-clock schedule edges (including DST and recurrence) into UTC instants, so the device needs no
 * timezone math here - a plain numeric comparison against System.currentTimeMillis() is the whole
 * selection. That is deliberate: it keeps the one place that must agree with the live server resolver
 * (offline-schedule-plan.js) on the server, not re-derived on every platform.
 *
 * ⚠️ ONE intentional difference from the JS reference: STOfflinePlan.select() returns `state = null`
 * for a gap and lets its web renderer paint the persisted standby image itself. Android has no such
 * renderer layer; its PlaylistController already renders default_content for an empty playlist, so
 * here a gap resolves to the `schedule_id: null` state row (when the server sent one) and is applied
 * through the ordinary playlist-update path. dependencies() already includes every state's
 * default_content, so nothing extra needs caching for this.
 */
object OfflinePlan {

    const val PROTOCOL_VERSION = 1

    data class Selection(
        val valid: Boolean,
        val interval: JSONObject?,
        val state: JSONObject?,
        val error: String? = null,
    )

    /** Parse and validate the envelope. Returns null for anything we must not trust as a plan. */
    fun read(raw: String?): JSONObject? {
        if (raw.isNullOrBlank() || raw == "null") return null
        return try {
            val plan = JSONObject(raw)
            if (plan.optInt("protocol_version", -1) != PROTOCOL_VERSION) return null
            if (plan.optJSONArray("intervals") == null || plan.optJSONArray("states") == null) return null
            if (plan.optLong("valid_until_utc_ms", 0L) == 0L || plan.optLong("generated_at_utc_ms", 0L) == 0L) return null
            plan
        } catch (_: Throwable) {
            null
        }
    }

    /** As [read] but from an already-parsed object (a live payload's `offline_plan`). */
    fun read(plan: JSONObject?): JSONObject? {
        if (plan == null) return null
        return read(plan.toString())
    }

    /**
     * The state row for a schedule id. A null id matches the gap/default row (`schedule_id: null`).
     * Returns null when the plan carries no matching row.
     */
    private fun stateFor(plan: JSONObject, scheduleId: String?): JSONObject? {
        val states = plan.optJSONArray("states") ?: return null
        for (i in 0 until states.length()) {
            val s = states.optJSONObject(i) ?: continue
            val sid = if (s.isNull("schedule_id")) null else s.optString("schedule_id", "").ifEmpty { null }
            if (sid == scheduleId && !s.isNull("payload")) return s
        }
        return null
    }

    /**
     * Pick the interval covering [now] and resolve its state. Mirrors STOfflinePlan.select():
     *  - `valid = false` when there is no usable plan or `now` is outside [generated, valid_until);
     *    the caller must then fall back to its ordinary cached playlist.
     *  - `valid = true, interval = null` when the plan is current but no interval covers now
     *    (treated as idle).
     *  - `valid = true, interval, state` for the interval covering now. `state` may be null for a gap
     *    whose default row is absent - still valid, still "show idle", never the last playlist.
     */
    fun select(plan: JSONObject?, now: Long): Selection {
        val p = read(plan) ?: return Selection(false, null, null)
        if (now < p.optLong("generated_at_utc_ms", 0L) || now >= p.optLong("valid_until_utc_ms", 0L)) {
            return Selection(false, null, null)
        }
        val intervals = p.optJSONArray("intervals") ?: return Selection(true, null, null, "No intervals in plan.")
        for (i in 0 until intervals.length()) {
            val interval = intervals.optJSONObject(i) ?: continue
            if (now < interval.optLong("start_utc_ms", 0L) || now >= interval.optLong("end_utc_ms", 0L)) continue
            val scheduleId = if (interval.isNull("schedule_id")) null else interval.optString("schedule_id", "").ifEmpty { null }
            val state = stateFor(p, scheduleId)
            val error = if (scheduleId != null && state == null) "Scheduled state is absent from the cached plan." else null
            return Selection(true, interval, state, error)
        }
        return Selection(true, null, null, "No interval covers the current time.")
    }

    /** Convenience: the payload to render for [now], or null when the plan can't drive the screen. */
    fun statePayloadFor(plan: JSONObject?, now: Long): JSONObject? {
        val sel = select(plan, now)
        if (!sel.valid) return null
        return sel.state?.optJSONObject("payload")
    }

    /**
     * The next boundary strictly after [now] within the plan's validity, used to schedule the exact
     * rollover tick. Null when the plan is unusable or nothing remains before it expires.
     */
    fun nextTransitionAfter(plan: JSONObject?, now: Long): Long? {
        val p = read(plan) ?: return null
        val validUntil = p.optLong("valid_until_utc_ms", 0L)
        if (now >= validUntil) return null
        val intervals = p.optJSONArray("intervals") ?: return null
        var best = Long.MAX_VALUE
        for (i in 0 until intervals.length()) {
            val interval = intervals.optJSONObject(i) ?: continue
            for (edge in longArrayOf(interval.optLong("start_utc_ms", 0L), interval.optLong("end_utc_ms", 0L))) {
                if (edge in (now + 1) until best) best = edge
            }
        }
        if (validUntil in (now + 1) until best) best = validUntil
        return if (best == Long.MAX_VALUE) null else best
    }

    /**
     * Every renderable media item referenced by ANY state in the plan (all assignments plus each
     * state's top-level default_content), de-duplicated. The caller pre-caches these so a future
     * interval can render without the server, and only commits the plan once they are on disk.
     * Identity mirrors the JS reference: (widget_id|content_id)|(widget_rev|content_rev)|filepath.
     */
    fun dependencies(plan: JSONObject?): List<JSONObject> {
        val p = read(plan) ?: return emptyList()
        val states = p.optJSONArray("states") ?: return emptyList()
        val out = ArrayList<JSONObject>()
        val seen = HashSet<String>()
        for (i in 0 until states.length()) {
            val state = states.optJSONObject(i) ?: continue
            val payload = state.optJSONObject("payload") ?: continue
            val items = JSONArray()
            payload.optJSONArray("assignments")?.let { a -> for (j in 0 until a.length()) a.optJSONObject(j)?.let { items.put(it) } }
            if (!payload.isNull("default_content")) payload.optJSONObject("default_content")?.let { items.put(it) }
            for (j in 0 until items.length()) {
                val item = items.optJSONObject(j) ?: continue
                val id = item.optString("widget_id", "").ifEmpty { item.optString("content_id", "") }
                val rev = item.optString("widget_rev", "").ifEmpty { item.optString("content_rev", "") }
                val key = "$id|$rev|${item.optString("filepath", "")}"
                if (seen.add(key)) out.add(item)
            }
        }
        return out
    }
}
