package com.remotedisplay.player.player

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Canonical per-playlist-item schedule evaluator (#74 dayparting + #75 expiry + play window) -
 * Kotlin port of server/lib/schedule-eval.js.
 *
 * CONTRACT: shared/schedule-vectors.json. This must agree with the JS evaluator
 * (server/web/Tizen) on every vector. If it disagrees with a vector, this is wrong.
 *
 * Time model: instants are UTC; blocks and play windows are LOCAL wall-clock rules
 * interpreted in the device's effective IANA timezone (DST handled by java.time).
 * They are never converted to UTC.
 *
 * Block semantics:
 *  - within a block, day AND date AND time must all pass; blocks OR together
 *  - zero blocks = always on ("no schedule = always plays")
 *  - time window is [start, end): start inclusive, end exclusive ("24:00" = end of day)
 *  - start > end crosses midnight; the day/date test anchors to the day the window STARTED
 *
 * Play window (optional): local "YYYY-MM-DDTHH:MM" on each side, inclusive at the minute.
 * An INTERVAL, not a daypart. AND'd with blocks. Omitted = no extra gate.
 *
 * FAILS OPEN: any error (bad timezone, malformed block, bad stamp) returns true so the item
 * PLAYS. A blank screen is worse than an over-running promo.
 */
object ScheduleEval {

    data class Block(
        val days: Set<Int>,        // 0=Sun .. 6=Sat
        val start: String,         // "HH:MM"
        val end: String,           // "HH:MM" or "24:00"
        val startDate: String?,    // "YYYY-MM-DD" or null = no lower bound
        val endDate: String?       // "YYYY-MM-DD" or null = no upper bound
    )

    data class Window(
        val playFrom: String?,     // "YYYY-MM-DDTHH:MM" or null
        val playUntil: String?
    )

    /**
     * A per-item data-source condition ("skip unless a field matches"). Kotlin port of
     * conditionOk/getPath in server/lib/schedule-eval.js. The item carries `_ds` = the resolved
     * value bag for this condition's slug (the server already did bag[slug]); `path` traverses into
     * it. `op` is one of eq/neq/gt/gte/lt/lte/truthy. Value is compared as string (eq/neq) or number.
     */
    data class Condition(val type: String = "ds", val path: String = "", val op: String = "eq", val value: String?)

    fun parseCondition(o: JSONObject?): Condition? {
        if (o == null) return null
        val type = o.optString("type", "").ifEmpty {
            if (o.optString("slug", "").isNotEmpty()) "ds" else if (o.has("tag") || o.optString("op") == "has" || o.optString("op") == "lacks") "tag" else "ds"
        }
        if (type == "tag") {
            val v = o.optString("value", o.optString("tag", ""))
            if (v.isEmpty()) return null
            return Condition(type = "tag", op = if (o.optString("op") == "lacks") "lacks" else "has", path = "", value = v)
        }
        val path = o.optString("path", "")
        if (path.isEmpty()) return null
        val op = o.optString("op", "eq").ifEmpty { "eq" }
        val value = if (o.isNull("value")) null else o.optString("value", "")
        return Condition(type = type.ifEmpty { "ds" }, path = path, op = op, value = value)
    }

    fun tagOk(cond: Condition?, tags: List<String>): Boolean {
        if (cond == null) return true
        val want = (cond.value ?: "").lowercase()
        val has = tags.any { it.lowercase() == want }
        return if (cond.op == "lacks") !has else has
    }

    /**
     * FAILS OPEN: a null condition, or a missing/unloaded data bag, plays the item — including for
     * `truthy` (the guard runs before every operator, matching the fixed JS). Non-numeric operands
     * on a numeric comparison also fail open.
     */
    fun conditionOk(cond: Condition?, data: JSONObject?): Boolean {
        if (cond == null) return true
        if (data == null) return true
        val lhs = getPath(data, cond.path)
        when (cond.op) {
            "truthy" -> return truthy(lhs)
            "eq" -> return jstr(lhs) == jstr(cond.value)
            "neq" -> return jstr(lhs) != jstr(cond.value)
        }
        val ln = jnum(lhs); val rn = jnum(cond.value)
        if (ln == null || rn == null) return true
        return when (cond.op) {
            "gt" -> ln > rn; "gte" -> ln >= rn; "lt" -> ln < rn; "lte" -> ln <= rn
            else -> true
        }
    }

    private fun getPath(obj: JSONObject?, path: String?): Any? {
        if (obj == null) return null
        var cur: Any? = obj
        for (part in (path ?: "").split(".")) {
            if (part.isEmpty()) continue
            val c = cur
            if (c !is JSONObject || !c.has(part) || c.isNull(part)) return null
            cur = c.opt(part)
        }
        return cur
    }

    // String(x) parity: missing/undefined -> "undefined" (as JS String(undefined)); else toString.
    private fun jstr(x: Any?): String = if (x == null) "undefined" else x.toString()

    // Number(x) parity enough for comparisons: numbers as-is, "" -> 0, non-numeric -> null (fail open).
    private fun jnum(x: Any?): Double? = when (x) {
        null -> null
        is Number -> x.toDouble()
        is Boolean -> if (x) 1.0 else 0.0
        is String -> if (x.isBlank()) 0.0 else x.toDoubleOrNull()
        else -> null
    }

    // !!x parity: JS-falsy values are undefined/null/false/0/""/NaN.
    private fun truthy(x: Any?): Boolean = when (x) {
        null -> false
        is Boolean -> x
        is Number -> x.toDouble() != 0.0 && !x.toDouble().isNaN()
        is String -> x.isNotEmpty()
        else -> true
    }

    private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
    private val STAMP_RE = Regex("""^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$""")

    fun windowOf(playFrom: String?, playUntil: String?): Window? {
        val from = playFrom?.ifBlank { null }
        val until = playUntil?.ifBlank { null }
        if (from == null && until == null) return null
        return Window(from, until)
    }

    @JvmOverloads
    fun isItemActiveNow(
        blocks: List<Block>?,
        utcNowMs: Long,
        ianaTz: String?,
        window: Window? = null
    ): Boolean {
        return try {
            val zone = if (ianaTz.isNullOrBlank()) ZoneId.systemDefault() else ZoneId.of(ianaTz)
            val zdt = Instant.ofEpochMilli(utcNowMs).atZone(zone)
            val dow = zdt.dayOfWeek.value % 7          // java Mon=1..Sun=7 -> Sun=0..Sat=6
            val nowMin = zdt.hour * 60 + zdt.minute
            val date = zdt.toLocalDate()
            if (!intervalOk(window, zdt.toLocalDateTime().withSecond(0).withNano(0))) return false
            if (blocks.isNullOrEmpty()) return true
            blocks.any { blockMatches(it, dow, nowMin, date) }
        } catch (e: Throwable) {
            // Throwable, not Exception. A missing java.time on an old API level surfaces as
            // NoClassDefFoundError — an Error — which sailed straight through a catch(Exception)
            // and turned this "fail open, a blank screen is worse than an over-running promo"
            // contract into its exact opposite: nothing played at all. Desugaring (see
            // build.gradle.kts) is the real fix; this makes the guard mean what it says.
            true // fail open
        }
    }

    private fun intervalOk(window: Window?, now: LocalDateTime): Boolean {
        if (window == null) return true
        val from = window.playFrom
        val until = window.playUntil
        if (from == null && until == null) return true
        if (from != null && !STAMP_RE.matches(from)) throw IllegalArgumentException("bad play_from")
        if (until != null && !STAMP_RE.matches(until)) throw IllegalArgumentException("bad play_until")
        if (from != null && now.isBefore(LocalDateTime.parse(from, STAMP))) return false
        if (until != null && now.isAfter(LocalDateTime.parse(until, STAMP))) return false
        return true
    }

    private fun hm(s: String): Int { val p = s.split(":"); return p[0].toInt() * 60 + p[1].toInt() } // "24:00" -> 1440

    private fun dayOk(dow: Int, days: Set<Int>): Boolean = days.contains(dow)

    private fun dateOk(date: LocalDate, startDate: String?, endDate: String?): Boolean {
        if (startDate != null && date.isBefore(LocalDate.parse(startDate))) return false
        if (endDate != null && date.isAfter(LocalDate.parse(endDate))) return false   // inclusive
        return true
    }

    private fun blockMatches(b: Block, dow: Int, nowMin: Int, date: LocalDate): Boolean {
        val s = hm(b.start); val e = hm(b.end)
        if (s <= e) {
            // same-day window [s, e), anchored to today
            if (nowMin < s || nowMin >= e) return false
            return dayOk(dow, b.days) && dateOk(date, b.startDate, b.endDate)
        }
        // overnight wrap
        if (nowMin >= s) {
            // before-midnight portion: anchor = today
            return dayOk(dow, b.days) && dateOk(date, b.startDate, b.endDate)
        }
        if (nowMin < e) {
            // after-midnight portion: anchor = the day it started = yesterday
            val y = date.minusDays(1)
            return dayOk((dow + 6) % 7, b.days) && dateOk(y, b.startDate, b.endDate)
        }
        return false
    }
}
