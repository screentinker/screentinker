package com.remotedisplay.player.power

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/**
 * Display power windows — when this panel's BACKLIGHT should be off. Kotlin port of
 * server/lib/power-window.js.
 *
 * CONTRACT: shared/power-window-vectors.json. This must agree with the JS evaluator on every
 * vector; if it disagrees, this is wrong. PowerWindowTest reads that exact file — no snapshot —
 * so a change that suits one side and breaks the other fails CI.
 *
 * Window semantics, identical to ScheduleEval's blocks so an operator who has learned one has
 * learned both:
 *  - time window is [start, end): start inclusive, end exclusive ("24:00" = end of day)
 *  - start > end crosses midnight, and the DAY test anchors to the day the window STARTED
 *  - windows OR together; zero windows = never off
 *
 * ⚠️ FAILS TO **ON**, WHICH IS THE OPPOSITE OF [ScheduleEval].
 *
 * That one fails OPEN so the item PLAYS — a blank screen is worse than an over-running promo. The
 * instinct is right and it inverts here: the bad outcome for a power schedule is a screen DARK
 * when nobody asked, because a dark panel is indistinguishable from dead hardware. It is the one
 * failure an operator cannot diagnose from the dashboard, cannot see from across the room, and
 * will drive to site for. So every unparseable input resolves to ON.
 */
object PowerWindow {

    data class Window(
        val days: Set<Int>,   // 0=Sun .. 6=Sat
        val start: String,    // "HH:MM"
        val end: String       // "HH:MM" or "24:00"
    )

    data class Schedule(
        val enabled: Boolean,
        val timezone: String?,   // null = this device's own zone
        val windows: List<Window>
    )

    private val HM_RE = Regex("^([01]\\d|2[0-4]):([0-5]\\d)$")

    /** "HH:MM" -> minutes, or null when it is not a time. "24:00" -> 1440. */
    private fun hm(s: String?): Int? {
        val m = HM_RE.matchEntire(s ?: return null) ?: return null
        val mins = m.groupValues[1].toInt() * 60 + m.groupValues[2].toInt()
        return if (mins > 1440) null else mins
    }

    /**
     * Does ONE window cover this local moment? False for anything malformed, so a junk window is
     * inert rather than contagious — one bad entry must not disable a good one beside it.
     */
    fun windowCovers(w: Window, dow: Int, min: Int): Boolean {
        val start = hm(w.start) ?: return false
        val end = hm(w.end) ?: return false
        if (start == end) return false          // a zero-length window is not an instruction

        if (start < end) {
            // Same-day window, day test is simply today.
            return w.days.contains(dow) && min >= start && min < end
        }

        // Overnight: two disjoint halves tested against DIFFERENT days.
        //   [start, 24:00) on the start day   -> today must be listed
        //   [00:00, end)   on the NEXT day    -> YESTERDAY must be listed
        // Anchoring to the start day is what makes "weekdays 22:00-06:00" five nights ending
        // Saturday morning, rather than a sixth window starting Saturday night.
        if (min >= start) return w.days.contains(dow)
        if (min < end) return w.days.contains((dow + 6) % 7)
        return false
    }

    /**
     * Should the backlight be off at this instant? NEVER throws.
     */
    fun isOff(schedule: Schedule?, utcNowMs: Long): Boolean {
        return try {
            if (schedule == null || !schedule.enabled) return false
            if (schedule.windows.isEmpty()) return false
            val zone = if (schedule.timezone.isNullOrBlank()) ZoneId.systemDefault() else ZoneId.of(schedule.timezone)
            val zdt = Instant.ofEpochMilli(utcNowMs).atZone(zone)
            val dow = zdt.dayOfWeek.value % 7       // java Mon=1..Sun=7 -> Sun=0..Sat=6
            val nowMin = zdt.hour * 60 + zdt.minute
            schedule.windows.any { windowCovers(it, dow, nowMin) }
        } catch (e: Throwable) {
            /*
             * Throwable, not Exception — the same trap ScheduleEval documents. A missing java.time
             * on an old API level arrives as NoClassDefFoundError, an Error, which sails straight
             * through catch(Exception). There it turned "fail open" into its opposite and nothing
             * played; HERE it would turn "fail to on" into its opposite and every panel in the
             * fleet would go dark and stay dark. Desugaring is the real fix (see build.gradle.kts);
             * this makes the guard mean what it says.
             */
            false
        }
    }

    /** The telemetry string the dashboard reads. */
    fun stateOf(schedule: Schedule?, utcNowMs: Long): String =
        if (isOff(schedule, utcNowMs)) "scheduled_off" else "on"

    /**
     * Parse the wire shape the server sends (the `power_schedule` payload field and the
     * set_power_schedule command). Returns null for absent OR unparseable — both mean "no
     * schedule", which means the screen stays lit.
     */
    fun parse(o: JSONObject?): Schedule? {
        if (o == null) return null
        return try {
            val arr: JSONArray = o.optJSONArray("windows") ?: JSONArray()
            val windows = ArrayList<Window>(arr.length())
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val daysArr = w.optJSONArray("days") ?: continue
                val days = HashSet<Int>(daysArr.length())
                for (j in 0 until daysArr.length()) days.add(daysArr.optInt(j, -1))
                windows.add(Window(days, w.optString("start", ""), w.optString("end", "")))
            }
            Schedule(
                enabled = o.optBoolean("enabled", true),
                timezone = o.optString("timezone", "").ifBlank { null },
                windows = windows
            )
        } catch (e: Throwable) {
            null
        }
    }

    /** Serialize for SharedPreferences. Kept beside parse() so the two cannot drift. */
    fun toJson(s: Schedule?): String? {
        if (s == null) return null
        return try {
            val arr = JSONArray()
            for (w in s.windows) {
                val days = JSONArray()
                for (d in w.days.sorted()) days.put(d)
                arr.put(JSONObject().put("days", days).put("start", w.start).put("end", w.end))
            }
            JSONObject()
                .put("enabled", s.enabled)
                .put("timezone", s.timezone ?: JSONObject.NULL)
                .put("windows", arr)
                .toString()
        } catch (e: Throwable) {
            null
        }
    }
}
