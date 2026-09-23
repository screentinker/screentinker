package com.remotedisplay.player.power

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Drift guard: the Kotlin power-window evaluator must agree with the SHARED contract at
 * shared/power-window-vectors.json — the SAME file server/lib/power-window.js is held to. No
 * snapshot is taken: the test task points `powerWindowVectors` at the single source (see
 * app/build.gradle.kts), so any change here or there that breaks a vector fails CI on both sides.
 *
 * The vectors carry the DST cases (an hour skipped in spring, an hour lived twice in autumn) and
 * the inverted fail-safe, which is the property most likely to be "tidied" into agreement with
 * ScheduleEval by someone reading only one of the two files.
 */
class PowerWindowTest {

    private fun scheduleOf(v: com.google.gson.JsonObject): PowerWindow.Schedule {
        val windowsEl = v.get("windows")
        val windows = if (windowsEl == null || windowsEl.isJsonNull) {
            emptyList()
        } else {
            windowsEl.asJsonArray.map { w ->
                val o = w.asJsonObject
                PowerWindow.Window(
                    days = o.getAsJsonArray("days").map { it.asInt }.toSet(),
                    start = o.get("start").asString,
                    end = o.get("end").asString
                )
            }
        }
        val tzEl = v.get("timezone")
        return PowerWindow.Schedule(
            enabled = v.get("enabled").asBoolean,
            timezone = if (tzEl == null || tzEl.isJsonNull) null else tzEl.asString,
            windows = windows
        )
    }

    @Test
    fun conformsToSharedVectors() {
        val path = System.getProperty("powerWindowVectors")
            ?: error("powerWindowVectors system property not set (configured in app/build.gradle.kts)")
        val vectors = JsonParser.parseString(File(path).readText()).asJsonObject.getAsJsonArray("vectors")

        val failures = StringBuilder()
        var count = 0
        for (el in vectors) {
            val v = el.asJsonObject
            val expected = v.getAsJsonObject("expect").get("off").asBoolean
            val nowMs = Instant.parse(v.get("utc_now").asString).toEpochMilli()
            val got = PowerWindow.isOff(scheduleOf(v), nowMs)
            if (got != expected) {
                failures.append("  ").append(v.get("name").asString)
                    .append("\n    -> off=").append(got).append(", expected ").append(expected).append('\n')
            }
            count++
        }
        assertTrue("the contract should not shrink", count >= 20)
        assertEquals("Kotlin disagrees with shared/power-window-vectors.json:\n$failures", 0, failures.length)
    }

    /**
     * Named separately because the two evaluators sit beside each other and disagree ON PURPOSE.
     * If this is ever "fixed" to match ScheduleEval, a fleet goes dark at the first bad timezone
     * string and every panel looks like dead hardware.
     */
    @Test
    fun failsToOnNotToOff() {
        val alwaysOff = listOf(PowerWindow.Window(setOf(0, 1, 2, 3, 4, 5, 6), "00:00", "24:00"))
        val badZone = PowerWindow.Schedule(enabled = true, timezone = "Not/AZone", windows = alwaysOff)
        assertFalse("an unknown zone must leave the screen lit", PowerWindow.isOff(badZone, 1790110800000L))

        val badTime = PowerWindow.Schedule(
            enabled = true, timezone = "UTC",
            windows = listOf(PowerWindow.Window(setOf(0, 1, 2, 3, 4, 5, 6), "2500", "24:00"))
        )
        assertFalse("a malformed time must leave the screen lit", PowerWindow.isOff(badTime, 1790110800000L))

        assertFalse("no schedule at all is not an off schedule", PowerWindow.isOff(null, 1790110800000L))
    }

    @Test
    fun oneBadWindowDoesNotSuppressAGoodOne() {
        val s = PowerWindow.Schedule(
            enabled = true, timezone = "UTC",
            windows = listOf(
                PowerWindow.Window(setOf(2), "nonsense", "17:00"),
                PowerWindow.Window(setOf(0, 1, 2, 3, 4, 5, 6), "00:00", "24:00")
            )
        )
        assertTrue(PowerWindow.isOff(s, 1790110800000L))
    }

    /** parse/toJson are how the schedule survives a reboot; a round trip must not lose a window. */
    @Test
    fun jsonRoundTripPreservesTheSchedule() {
        val original = PowerWindow.Schedule(
            enabled = true, timezone = "America/Chicago",
            windows = listOf(PowerWindow.Window(setOf(1, 2, 3, 4, 5), "22:00", "06:00"))
        )
        val json = PowerWindow.toJson(original)!!
        val back = PowerWindow.parse(org.json.JSONObject(json))!!
        assertEquals(original.enabled, back.enabled)
        assertEquals(original.timezone, back.timezone)
        assertEquals(1, back.windows.size)
        assertEquals(setOf(1, 2, 3, 4, 5), back.windows[0].days)
        assertEquals("22:00", back.windows[0].start)
        assertEquals("06:00", back.windows[0].end)

        // And the evaluation agrees before and after, which is the property that actually matters.
        val t = Instant.parse("2026-09-22T03:00:00Z").toEpochMilli()
        assertEquals(PowerWindow.isOff(original, t), PowerWindow.isOff(back, t))
    }

    @Test
    fun parseOfGarbageIsNullNotAnOffSchedule() {
        assertEquals(null, PowerWindow.parse(null))
        // A document with no windows parses, but evaluates to ON.
        val empty = PowerWindow.parse(org.json.JSONObject("""{"enabled":true,"timezone":"UTC"}"""))
        assertFalse(PowerWindow.isOff(empty, 1790110800000L))
    }
}
